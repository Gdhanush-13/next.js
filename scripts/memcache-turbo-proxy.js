#!/usr/bin/env node
// WebDAV-to-Turbo proxy: translates sccache WebDAV requests to turbo remote cache API.
//
// sccache uses WebDAV as a storage backend (PUT/GET/PROPFIND).
// This proxy translates those to turbo's REST API (PUT/GET/HEAD on /v8/artifacts/{key}).
//
// All operations are logged to $RUNNER_TEMP/sccache-turbo-proxy.log for debugging.
// The last 50 operations are printed on shutdown.

const http = require('http')
const fs = require('fs')

// Use the same env vars as turbo CLI and ijjk/rust-cache.
// On self-hosted runners, TURBO_API points to the self-hosted cache server
// (set in bashrc). On GH-hosted runners, it defaults to vercel.com.
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

let stats = { gets: 0, puts: 0, hits: 0, misses: 0, errors: 0, putBytes: 0 }
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' })

function log(msg) {
  logStream.write(`${new Date().toISOString()} ${msg}\n`)
}

// Convert a WebDAV URL path into a turbo cache key.
// Turbo cache requires hex-only keys (^[a-fA-F0-9]+$), so we SHA256 hash
// the path to produce a valid key.
function extractKey(urlPath) {
  const raw = urlPath.replace(/^\/+/, '')
  return require('crypto').createHash('sha256').update(raw).digest('hex')
}

// Turbo cache API path prefix. turbo CLI uses /v8/artifacts/, but the
// OpenAPI spec shows /artifacts/. Health check probes both and picks
// whichever accepts PUT.
let apiPrefix = '/v8/artifacts'

// Headers matching what turbo CLI sends (Vercel CDN may require these for routing).
function turboHeaders(body) {
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
}

async function turboFetch(method, key, body) {
  const slug = TURBO_TEAM ? `?slug=${TURBO_TEAM}` : ''
  const url = `${TURBO_API}${apiPrefix}/${encodeURIComponent(key)}${slug}`
  const res = await fetch(url, {
    method,
    headers: turboHeaders(body),
    body: body || undefined,
  })
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, body: buf }
}

// Verify turbo API connectivity with read AND write access.
// Tries the configured API_PREFIX, and if PUT fails with 405, tries
// alternate prefixes (/v8/artifacts, /artifacts) since the API spec
// is ambiguous about the prefix.
async function healthCheck() {
  // Turbo cache keys must be hex-only (^[a-fA-F0-9]+$)
  const testKey = require('crypto')
    .createHash('sha256')
    .update(`sccache-health-check-${Date.now()}`)
    .digest('hex')
  const slug = TURBO_TEAM ? `?slug=${TURBO_TEAM}` : ''

  console.error(`Health check:`)
  console.error(`  TURBO_API: ${TURBO_API}`)
  console.error(`  TURBO_TEAM: ${TURBO_TEAM}`)
  console.error(
    `  TURBO_TOKEN: ${TURBO_TOKEN ? TURBO_TOKEN.slice(0, 8) + '...' : '(not set)'}`
  )

  // Try different API path prefixes — turbo CLI uses /v8/artifacts,
  // OpenAPI spec shows /artifacts, some servers may differ.
  const prefixes = ['/v8/artifacts', '/artifacts']

  for (const prefix of prefixes) {
    const url = `${TURBO_API}${prefix}/${testKey}${slug}`
    console.error(`\n  Trying prefix "${prefix}":`)
    console.error(`  URL: ${url}`)

    try {
      // 1. READ test
      const headRes = await fetch(url, {
        method: 'HEAD',
        headers: turboHeaders(),
      })
      console.error(`  READ:  HEAD -> ${headRes.status} ${headRes.statusText}`)

      if (headRes.status === 403) {
        console.error('  SKIP: 403 on read — wrong token or server')
        continue
      }
      if (headRes.status !== 404 && headRes.status !== 200) {
        console.error(`  SKIP: unexpected ${headRes.status}`)
        continue
      }

      // 2. WRITE test
      const testBody = Buffer.from('sccache-write-test')
      const putRes = await fetch(url, {
        method: 'PUT',
        headers: turboHeaders(testBody),
        body: testBody,
      })
      console.error(`  WRITE: PUT -> ${putRes.status} ${putRes.statusText}`)

      if (putRes.status === 405) {
        console.error('  SKIP: 405 Method Not Allowed — trying next prefix')
        continue
      }
      if (!putRes.ok) {
        const body = await putRes.text()
        console.error(`  Body: ${body.slice(0, 200)}`)
        console.error('  SKIP: write failed')
        continue
      }

      // 3. Verify round-trip
      const getRes = await fetch(url, {
        method: 'GET',
        headers: turboHeaders(),
      })
      console.error(`  VERIFY: GET -> ${getRes.status} ${getRes.statusText}`)

      if (getRes.ok) {
        const data = Buffer.from(await getRes.arrayBuffer())
        if (data.equals(testBody)) {
          console.error(`  OK: read/write verified with prefix "${prefix}"`)
        } else {
          console.error(
            `  WARN: data mismatch (wrote ${testBody.length}B, read ${data.length}B)`
          )
        }
      }

      // Success — update the global prefix if different
      if (prefix !== apiPrefix) {
        console.error(`  Switching apiPrefix from "${apiPrefix}" to "${prefix}"`)
        apiPrefix = prefix
      }

      log(`Health check OK: read+write verified for ${testKey}`)
      return prefix
    } catch (e) {
      console.error(`  ERROR: ${e.message}`)
      continue
    }
  }

  console.error('\nFAIL: no working turbo cache prefix found')
  return null
}

const server = http.createServer(async (req, res) => {
  const key = extractKey(req.url)
  const method = req.method.toUpperCase()

  try {
    if (method === 'GET') {
      stats.gets++
      const r = await turboFetch('GET', key)
      if (r.status === 200) {
        stats.hits++
        log(`GET ${key} -> HIT (${r.body.length} bytes)`)
        res.writeHead(200, { 'Content-Length': r.body.length })
        res.end(r.body)
      } else {
        stats.misses++
        log(`GET ${key} -> MISS (turbo ${r.status})`)
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
        const r = await turboFetch('PUT', key, body)
        log(`PUT ${key} -> turbo ${r.status} (${body.length} bytes)`)
        res.writeHead(r.status < 300 ? 201 : r.status)
        res.end()
      })
      return
    } else if (method === 'PROPFIND' || method === 'HEAD') {
      stats.gets++
      const r = await turboFetch('HEAD', key)
      if (r.status === 200) {
        stats.hits++
        log(`PROPFIND ${key} -> HIT`)
        const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${req.url}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
        res.writeHead(207, {
          'Content-Type': 'application/xml',
          'Content-Length': Buffer.byteLength(xml),
        })
        res.end(xml)
      } else {
        stats.misses++
        log(`PROPFIND ${key} -> MISS (turbo ${r.status})`)
        res.writeHead(404)
        res.end()
      }
    } else if (method === 'MKCOL') {
      log(`MKCOL ${key} -> 201`)
      res.writeHead(201)
      res.end()
    } else {
      log(`${method} ${key} -> 405`)
      res.writeHead(405)
      res.end()
    }
  } catch (e) {
    stats.errors++
    log(`ERROR ${method} ${key}: ${e.message}`)
    console.error(`Error handling ${method} ${req.url}: ${e.message}`)
    res.writeHead(502)
    res.end()
  }
})

async function main() {
  // --test mode: verify turbo API connectivity and exit
  if (process.argv.includes('--test')) {
    const prefix = await healthCheck()
    process.exit(prefix ? 0 : 1)
  }

  // Normal mode: run health check to discover working prefix
  const prefix = await healthCheck()
  if (!prefix) {
    console.error('WARNING: health check failed, starting proxy anyway')
  }

  // Normal mode: start listening immediately
  server.listen(PORT, '127.0.0.1', () => {
    console.log(
      `sccache-turbo-proxy (WebDAV) listening on http://127.0.0.1:${PORT}`
    )
    console.log(`  TURBO_API: ${TURBO_API}`)
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
