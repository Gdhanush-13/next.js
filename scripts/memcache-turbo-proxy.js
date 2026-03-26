#!/usr/bin/env node
// WebDAV-to-Turbo proxy: translates sccache WebDAV requests to turbo remote cache API.
//
// sccache uses WebDAV as a storage backend (PUT/GET/PROPFIND).
// This proxy translates those to Vercel's remote cache via scripts/turbo-cache.js.
//
// All operations are logged to $RUNNER_TEMP/sccache-turbo-proxy.log for debugging.

const http = require('http')
const fs = require('fs')
const crypto = require('crypto')
const cache = require('./turbo-cache')

const PORT = parseInt(process.env.SCCACHE_TURBO_PROXY_PORT || '18080', 10)
const os = require('os')
const tmpDir = process.env.RUNNER_TEMP || os.tmpdir()
const LOG_FILE = require('path').join(tmpDir, 'sccache-turbo-proxy.log')

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

const server = http.createServer(async (req, res) => {
  const rawPath = req.url
  const key = extractKey(rawPath)
  const method = req.method.toUpperCase()
  const shortKey = key.slice(0, 16)

  try {
    if (method === 'GET') {
      stats.gets++
      const data = await cache.get(key)
      if (data) {
        stats.hits++
        log(`GET ${rawPath} -> HIT (${data.length} bytes)`)
        res.writeHead(200, { 'Content-Length': data.length })
        res.end(data)
      } else {
        stats.misses++
        log(`GET ${rawPath} -> MISS`)
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
          await cache.put(key, body)
          log(`PUT ${rawPath} -> OK (${body.length} bytes)`)
          res.writeHead(201)
        } catch (e) {
          stats.errors++
          const msg = `PUT ${rawPath} -> ERROR (${body.length} bytes): ${e.message}`
          log(msg)
          console.error(msg)
          res.writeHead(502)
        }
        res.end()
      })
      return
    } else if (method === 'PROPFIND' || method === 'HEAD') {
      // sccache's WebDAV write flow: PROPFIND dir → MKCOL dir → PUT file.
      // For directories (short path segments), return 404 so sccache does
      // MKCOL (which we accept). For actual cache files (long hash paths),
      // return 207 to skip the exists check — GET will return 404 on miss.
      //
      // Directory paths look like: /sccache-v1/ or /sccache-v1/a/ or /sccache-v1/a/b/
      // File paths look like:      /sccache-v1/a/b/c/<long-hash>
      const segments = rawPath.replace(/^\/+|\/+$/g, '').split('/')
      const lastSegment = segments[segments.length - 1] || ''
      const isFile = lastSegment.length > 10 // hash segments are 40+ chars

      if (isFile) {
        // File path — always say exists, let GET determine hit/miss
        log(`PROPFIND ${rawPath} -> 207 (file)`)
        const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${rawPath}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
        res.writeHead(207, {
          'Content-Type': 'application/xml',
          'Content-Length': Buffer.byteLength(xml),
        })
        res.end(xml)
      } else {
        // Directory path — return 404 so sccache sends MKCOL
        log(`PROPFIND ${rawPath} -> 404 (dir)`)
        res.writeHead(404)
        res.end()
      }
    } else if (method === 'MKCOL') {
      log(`MKCOL ${rawPath} -> 201`)
      res.writeHead(201)
      res.end()
    } else {
      res.writeHead(405)
      res.end()
    }
  } catch (e) {
    stats.errors++
    log(`ERROR ${method} ${shortKey}: ${e.message}`)
    res.writeHead(502)
    res.end()
  }
})

async function main() {
  if (process.argv.includes('--test')) {
    const ok = await cache.healthCheck()
    process.exit(ok ? 0 : 1)
  }

  const ok = await cache.healthCheck()
  if (!ok) {
    console.error('WARNING: health check failed, starting proxy anyway')
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`sccache-turbo-proxy listening on http://127.0.0.1:${PORT}`)
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
