#!/usr/bin/env node
// WebDAV-to-Turbo proxy: translates sccache WebDAV requests to turbo remote cache API.
//
// sccache uses WebDAV as a storage backend (PUT/GET/PROPFIND).
// This proxy translates those to turbo's REST API (PUT/GET/HEAD on /v8/artifacts/{key}).
//
// Usage:
//   node scripts/memcache-turbo-proxy.js
//
// Env vars:
//   TURBO_API    - turbo API base URL (default: https://vercel.com)
//   TURBO_TOKEN  - bearer token for authentication (required)
//   TURBO_TEAM   - team ID for cache namespace (default: vercel)
//   SCCACHE_TURBO_PROXY_PORT - listen port (default: 18080)

const http = require('http')
const https = require('https')
const { URL } = require('url')

const TURBO_API = process.env.TURBO_API || 'https://vercel.com'
const TURBO_TOKEN = process.env.TURBO_TOKEN
const TURBO_TEAM = process.env.TURBO_TEAM || 'vercel'
const PORT = parseInt(process.env.SCCACHE_TURBO_PROXY_PORT || '18080', 10)

if (!TURBO_TOKEN) {
  console.error('TURBO_TOKEN is required')
  process.exit(1)
}

const apiUrl = new URL(TURBO_API)
const remoteModule = apiUrl.protocol === 'https:' ? https : http

let stats = { gets: 0, puts: 0, hits: 0, misses: 0, errors: 0 }

// Extract the cache key from the request path.
// sccache WebDAV paths look like: /key_prefix/ab/cdef1234... (split across directories)
// We flatten everything after the leading slash into a single key.
function extractKey(urlPath) {
  return urlPath.replace(/^\/+/, '').replace(/\//g, '-')
}

function turboFetch(method, key, body) {
  return new Promise((resolve, reject) => {
    const turboPath = `/v8/artifacts/${encodeURIComponent(key)}?teamId=${encodeURIComponent(TURBO_TEAM)}`
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

const server = http.createServer(async (req, res) => {
  const key = extractKey(req.url)
  const method = req.method.toUpperCase()

  try {
    if (method === 'GET') {
      // Retrieve cached artifact
      stats.gets++
      const r = await turboFetch('GET', key)
      if (r.status === 200) {
        stats.hits++
        res.writeHead(200, { 'Content-Length': r.body.length })
        res.end(r.body)
      } else {
        stats.misses++
        res.writeHead(404)
        res.end()
      }
    } else if (method === 'PUT') {
      // Store artifact
      stats.puts++
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', async () => {
        const body = Buffer.concat(chunks)
        const r = await turboFetch('PUT', key, body)
        res.writeHead(r.status < 300 ? 201 : r.status)
        res.end()
      })
      return // don't end yet, waiting for body
    } else if (method === 'PROPFIND' || method === 'HEAD') {
      // Check existence — sccache uses PROPFIND, we translate to HEAD
      stats.gets++
      const r = await turboFetch('HEAD', key)
      if (r.status === 200) {
        stats.hits++
        // Return a minimal WebDAV multistatus response
        const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${req.url}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
        res.writeHead(207, {
          'Content-Type': 'application/xml',
          'Content-Length': Buffer.byteLength(xml),
        })
        res.end(xml)
      } else {
        stats.misses++
        res.writeHead(404)
        res.end()
      }
    } else if (method === 'MKCOL') {
      // sccache may try to create directories — just say OK
      res.writeHead(201)
      res.end()
    } else {
      res.writeHead(405)
      res.end()
    }
  } catch (e) {
    stats.errors++
    console.error(`Error handling ${method} ${req.url}: ${e.message}`)
    res.writeHead(502)
    res.end()
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `sccache-turbo-proxy (WebDAV) listening on http://127.0.0.1:${PORT}`
  )
  console.log(`  TURBO_API: ${TURBO_API}`)
  console.log(`  TURBO_TEAM: ${TURBO_TEAM}`)
})

process.on('SIGINT', () => {
  console.log('\nsccache-turbo-proxy stats:', JSON.stringify(stats))
  process.exit(0)
})
process.on('SIGTERM', () => {
  console.log('\nsccache-turbo-proxy stats:', JSON.stringify(stats))
  process.exit(0)
})
