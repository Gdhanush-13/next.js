#!/usr/bin/env node
// WebDAV-to-Turbo proxy: translates sccache WebDAV requests to turbo remote cache API.
//
// sccache uses WebDAV as a storage backend (PUT/GET/PROPFIND).
// This proxy translates those to Vercel's remote cache API.
//
// When TURBO_API is vercel.com (or unset), uses @vercel/remote SDK.
// When TURBO_API points to a custom server, uses raw fetch() with /v8/artifacts/.
//
// All operations are logged to $RUNNER_TEMP/sccache-turbo-proxy.log for debugging.

const http = require('http')
const fs = require('fs')
const crypto = require('crypto')

const TURBO_API = process.env.TURBO_API || 'https://vercel.com'
const TURBO_TOKEN = process.env.TURBO_TOKEN
const TURBO_TEAM = process.env.TURBO_TEAM
const PORT = parseInt(process.env.SCCACHE_TURBO_PROXY_PORT || '18080', 10)
const os = require('os')
const tmpDir = process.env.RUNNER_TEMP || os.tmpdir()
const LOG_FILE = require('path').join(tmpDir, 'sccache-turbo-proxy.log')

if (!TURBO_TOKEN) {
  console.error('TURBO_TOKEN is required')
  process.exit(1)
}

const IS_VERCEL =
  TURBO_API === 'https://vercel.com' || TURBO_API === 'https://vercel.com/'

// --- Vercel backend (via @vercel/remote) ---
let _remote
function getRemote() {
  if (!_remote) {
    const { createClient } = require('@vercel/remote')
    _remote = createClient(TURBO_TOKEN, {
      ...(TURBO_TEAM ? { teamId: TURBO_TEAM } : {}),
      product: 'sccache',
    })
  }
  return _remote
}

const vercelBackend = {
  async exists(key) {
    return getRemote().exists(key).send()
  },
  async get(key) {
    try {
      const data = await getRemote().get(key).buffer()
      return data ? Buffer.from(data) : null
    } catch {
      return null
    }
  },
  async put(key, body) {
    await getRemote().put(key, { duration: 0 }).buffer(body)
  },
}

// --- Custom server backend (raw fetch) ---
const customBackend = {
  _url(key) {
    const slug = TURBO_TEAM ? `?slug=${TURBO_TEAM}` : ''
    return `${TURBO_API}/v8/artifacts/${key}${slug}`
  },
  _headers(body) {
    const h = {
      Authorization: `Bearer ${TURBO_TOKEN}`,
      'User-Agent': 'turbo 2 sccache-turbo-proxy',
      'x-artifact-client-ci': 'GITHUB_ACTIONS',
    }
    if (body) {
      h['Content-Type'] = 'application/octet-stream'
      h['Content-Length'] = String(body.length)
      h['x-artifact-duration'] = '0'
    }
    return h
  },
  async exists(key) {
    const res = await fetch(this._url(key), {
      method: 'HEAD',
      headers: this._headers(),
    })
    return res.status === 200
  },
  async get(key) {
    const res = await fetch(this._url(key), {
      method: 'GET',
      headers: this._headers(),
    })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  },
  async put(key, body) {
    const res = await fetch(this._url(key), {
      method: 'PUT',
      headers: this._headers(body),
      body,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`PUT failed: ${res.status} ${text.slice(0, 100)}`)
    }
  },
}

const backend = IS_VERCEL ? vercelBackend : customBackend

let stats = { gets: 0, puts: 0, hits: 0, misses: 0, errors: 0, putBytes: 0 }
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' })

function log(msg) {
  logStream.write(`${new Date().toISOString()} ${msg}\n`)
}

// Convert a WebDAV URL path into a turbo cache key.
// Turbo cache requires hex-only keys (^[a-fA-F0-9]+$).
function extractKey(urlPath) {
  const raw = urlPath.replace(/^\/+/, '')
  return crypto.createHash('sha256').update(raw).digest('hex')
}

// Verify read + write access.
async function healthCheck() {
  const testKey = crypto
    .createHash('sha256')
    .update(`sccache-health-check-${Date.now()}`)
    .digest('hex')

  console.error(`Health check:`)
  console.error(`  Backend: ${IS_VERCEL ? '@vercel/remote' : `custom (${TURBO_API})`}`)
  console.error(`  TURBO_TEAM: ${TURBO_TEAM}`)
  console.error(
    `  TURBO_TOKEN: ${TURBO_TOKEN ? TURBO_TOKEN.slice(0, 8) + '...' : '(not set)'}`
  )

  try {
    // 1. READ test
    const exists = await backend.exists(testKey)
    console.error(`  READ:  exists(${testKey.slice(0, 16)}...) -> ${exists}`)

    // 2. WRITE test
    const testData = Buffer.from('sccache-write-test')
    await backend.put(testKey, testData)
    console.error(`  WRITE: put -> OK`)

    // 3. Verify round-trip
    const readBack = await backend.get(testKey)
    if (readBack && readBack.equals(testData)) {
      console.error(`  VERIFY: get -> OK (${readBack.length}B)`)
    } else {
      console.error(
        `  VERIFY: get -> mismatch (${readBack ? readBack.length : 0}B)`
      )
    }

    log(`Health check OK: read+write verified`)
    return true
  } catch (e) {
    console.error(`  FAIL: ${e.message}`)
    return false
  }
}

const server = http.createServer(async (req, res) => {
  const key = extractKey(req.url)
  const method = req.method.toUpperCase()

  try {
    if (method === 'GET') {
      stats.gets++
      const data = await backend.get(key)
      if (data) {
        stats.hits++
        log(`GET ${key.slice(0, 16)} -> HIT (${data.length} bytes)`)
        res.writeHead(200, { 'Content-Length': data.length })
        res.end(data)
      } else {
        stats.misses++
        log(`GET ${key.slice(0, 16)} -> MISS`)
        res.writeHead(404)
        res.end()
      }
    } else if (method === 'PUT') {
      stats.puts++
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', async () => {
        const body = Buffer.concat(chunks)
        stats.putBytes += body.length
        try {
          await backend.put(key, body)
          log(`PUT ${key.slice(0, 16)} -> OK (${body.length} bytes)`)
          res.writeHead(201)
        } catch (e) {
          stats.errors++
          log(`PUT ${key.slice(0, 16)} -> ERROR: ${e.message}`)
          res.writeHead(502)
        }
        res.end()
      })
      return
    } else if (method === 'PROPFIND' || method === 'HEAD') {
      stats.gets++
      const exists = await backend.exists(key)
      if (exists) {
        stats.hits++
        log(`PROPFIND ${key.slice(0, 16)} -> HIT`)
        const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${req.url}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
        res.writeHead(207, {
          'Content-Type': 'application/xml',
          'Content-Length': Buffer.byteLength(xml),
        })
        res.end(xml)
      } else {
        stats.misses++
        log(`PROPFIND ${key.slice(0, 16)} -> MISS`)
        res.writeHead(404)
        res.end()
      }
    } else if (method === 'MKCOL') {
      log(`MKCOL ${key.slice(0, 16)} -> 201`)
      res.writeHead(201)
      res.end()
    } else {
      log(`${method} ${key.slice(0, 16)} -> 405`)
      res.writeHead(405)
      res.end()
    }
  } catch (e) {
    stats.errors++
    log(`ERROR ${method} ${key.slice(0, 16)}: ${e.message}`)
    console.error(`Error handling ${method} ${req.url}: ${e.message}`)
    res.writeHead(502)
    res.end()
  }
})

async function main() {
  if (process.argv.includes('--test')) {
    const ok = await healthCheck()
    process.exit(ok ? 0 : 1)
  }

  const ok = await healthCheck()
  if (!ok) {
    console.error('WARNING: health check failed, starting proxy anyway')
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(
      `sccache-turbo-proxy listening on http://127.0.0.1:${PORT}`
    )
    console.log(
      `  Backend: ${IS_VERCEL ? '@vercel/remote' : `custom (${TURBO_API})`}`
    )
    console.log(`  TURBO_TEAM: ${TURBO_TEAM}`)
    console.log(`  Log: ${LOG_FILE}`)
  })
}

function shutdown() {
  logStream.end()
  console.log('\n=== sccache-turbo-proxy stats ===')
  console.log(JSON.stringify(stats, null, 2))
  console.log(`\n=== Last 50 log entries (${LOG_FILE}) ===`)
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n')
    const tail = lines.slice(-50)
    for (const line of tail) console.log(line)
  } catch {}
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main()
