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

function extractKey(urlPath) {
  return urlPath.replace(/^\/+/, '').replace(/\//g, '-')
}

// Use global fetch() (Node 18+) to match the HTTP behavior of node-fetch/reqwest
// that turbo CLI and ijjk/rust-cache use. This sends proper User-Agent, Accept,
// and other standard HTTP headers that raw http.request omits.
async function turboFetch(method, key, body) {
  const slug = TURBO_TEAM ? `?slug=${TURBO_TEAM}` : ''
  const url = `${TURBO_API}/v8/artifacts/${encodeURIComponent(key)}${slug}`
  const headers = {
    Authorization: `Bearer ${TURBO_TOKEN}`,
  }
  if (body) {
    headers['Content-Type'] = 'application/octet-stream'
    headers['Content-Length'] = String(body.length)
  }
  const res = await fetch(url, { method, headers, body: body || undefined })
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, body: buf }
}

// Verify turbo API connectivity with read AND write access.
async function healthCheck() {
  const testKey = `sccache-health-check-${Date.now()}`
  const slug = TURBO_TEAM ? `?slug=${TURBO_TEAM}` : ''
  const url = `${TURBO_API}/v8/artifacts/${testKey}${slug}`
  const authHeaders = { Authorization: `Bearer ${TURBO_TOKEN}` }

  console.error(`Health check: ${url}`)
  console.error(`  TURBO_API: ${TURBO_API}`)
  console.error(`  TURBO_TEAM: ${TURBO_TEAM}`)
  console.error(
    `  TURBO_TOKEN: ${TURBO_TOKEN ? TURBO_TOKEN.slice(0, 8) + '...' : '(not set)'}`
  )

  try {
    // 1. READ test: HEAD on a non-existent key should return 404 (not 403)
    const headRes = await fetch(url, { method: 'HEAD', headers: authHeaders })
    console.error(`  READ test:  HEAD -> ${headRes.status} ${headRes.statusText}`)
    for (const [k, v] of headRes.headers) {
      console.error(`    ${k}: ${v}`)
    }

    if (headRes.status === 403) {
      const body = await headRes.text()
      console.error(`  Body: ${body.slice(0, 200)}`)
      console.error('  FAIL: 403 on read — token has no cache access')
      return false
    }
    if (headRes.status !== 404 && headRes.status !== 200) {
      const body = await headRes.text()
      console.error(`  Body: ${body.slice(0, 200)}`)
      console.error(`  FAIL: unexpected status ${headRes.status} (expected 404)`)
      return false
    }

    // 2. WRITE test: PUT a small test value
    const testBody = Buffer.from('sccache-write-test')
    const putRes = await fetch(url, {
      method: 'PUT',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(testBody.length),
      },
      body: testBody,
    })
    console.error(`  WRITE test: PUT -> ${putRes.status} ${putRes.statusText}`)
    for (const [k, v] of putRes.headers) {
      console.error(`    ${k}: ${v}`)
    }

    if (!putRes.ok) {
      const body = await putRes.text()
      console.error(`  Body: ${body.slice(0, 200)}`)
      console.error('  FAIL: cannot write to turbo cache — check token permissions')
      return false
    }

    // 3. Verify: GET the value back
    const getRes = await fetch(url, { method: 'GET', headers: authHeaders })
    console.error(`  VERIFY:     GET -> ${getRes.status} ${getRes.statusText}`)

    if (getRes.ok) {
      const data = Buffer.from(await getRes.arrayBuffer())
      if (data.equals(testBody)) {
        console.error('  OK: read/write verified')
      } else {
        console.error(
          `  WARN: data mismatch (wrote ${testBody.length}B, read ${data.length}B)`
        )
      }
    }

    log(`Health check OK: read+write verified for ${testKey}`)
    return true
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
