#!/usr/bin/env node
// WebDAV-to-Turbo proxy: translates sccache WebDAV requests to turbo remote cache API.
//
// sccache uses WebDAV as a storage backend (PUT/GET/PROPFIND).
// This proxy translates those to turbo's REST API (PUT/GET/HEAD on /v8/artifacts/{key}).
//
// All operations are logged to /tmp/sccache-turbo-proxy.log for debugging.
// The last 50 operations are printed on shutdown.

const http = require('http')
const https = require('https')
const fs = require('fs')
const { URL } = require('url')

// SCCACHE_TURBO_* env vars allow overriding the turbo API target for sccache
// separately from TURBO_API (which may point at a self-hosted proxy with
// different auth). Falls back to TURBO_* vars, then to vercel.com defaults.
const TURBO_API =
  process.env.SCCACHE_TURBO_API || process.env.TURBO_API || 'https://vercel.com'
const TURBO_TOKEN = process.env.SCCACHE_TURBO_TOKEN || process.env.TURBO_TOKEN
const TURBO_TEAM =
  process.env.SCCACHE_TURBO_TEAM || process.env.TURBO_TEAM || 'vercel'
const PORT = parseInt(process.env.SCCACHE_TURBO_PROXY_PORT || '18080', 10)
const os = require('os')
const tmpDir = process.env.RUNNER_TEMP || os.tmpdir()
const LOG_FILE = require('path').join(tmpDir, 'sccache-turbo-proxy.log')

if (!TURBO_TOKEN) {
  console.error('TURBO_TOKEN is required')
  process.exit(1)
}

const apiUrl = new URL(TURBO_API)
const remoteModule = apiUrl.protocol === 'https:' ? https : http

let stats = { gets: 0, puts: 0, hits: 0, misses: 0, errors: 0, putBytes: 0 }
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' })

function log(msg) {
  logStream.write(`${new Date().toISOString()} ${msg}\n`)
}

function extractKey(urlPath) {
  return urlPath.replace(/^\/+/, '').replace(/\//g, '-')
}

function turboFetch(method, key, body) {
  return new Promise((resolve, reject) => {
    // Turbo cache API: /v8/artifacts/{key} with Bearer auth.
    // Include teamId and slug for self-hosted turbo cache server compatibility.
    const qs = new URLSearchParams()
    if (TURBO_TEAM) {
      qs.set('teamId', TURBO_TEAM)
      qs.set('slug', TURBO_TEAM)
    }
    const qstr = qs.toString() ? `?${qs.toString()}` : ''
    const turboPath = `/v8/artifacts/${encodeURIComponent(key)}${qstr}`
    const parsed = new URL(turboPath, TURBO_API)
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        Authorization: `Bearer ${TURBO_TOKEN}`,
        'Content-Type': 'application/octet-stream',
      },
    }
    if (body) opts.headers['Content-Length'] = body.length

    const req = remoteModule.request(opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks) })
      )
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// Verify turbo API connectivity before starting the server.
// A GET on a non-existent key should return 404 (not 403).
async function healthCheck() {
  const testKey = `sccache-health-check-${Date.now()}`
  try {
    const r = await turboFetch('GET', testKey)
    if (r.status === 404) {
      log(`Health check OK: GET ${testKey} -> 404 (expected)`)
      return true
    } else if (r.status === 200) {
      log(
        `Health check OK: GET ${testKey} -> 200 (unexpected hit but API works)`
      )
      return true
    } else {
      console.error(
        `Turbo API health check failed: GET ${testKey} -> ${r.status} (expected 404)`
      )
      console.error(`  TURBO_API: ${TURBO_API}`)
      console.error(`  TURBO_TEAM: ${TURBO_TEAM}`)
      console.error(
        `  TURBO_TOKEN: ${TURBO_TOKEN ? TURBO_TOKEN.slice(0, 8) + '...' : '(not set)'}`
      )
      console.error(`  Full URL: ${TURBO_API}/v8/artifacts/${testKey}`)
      console.error(`  Response: ${r.body.toString().slice(0, 200)}`)
      return false
    }
  } catch (e) {
    console.error(`Turbo API health check error: ${e.message}`)
    return false
  }
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
    const ok = await healthCheck()
    process.exit(ok ? 0 : 1)
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
