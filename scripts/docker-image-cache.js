#!/usr/bin/env node
//
// Build or restore the next-swc-builder Docker image using turbo remote cache.
//
// Computes a cache key from the Dockerfile + rust-toolchain.toml contents,
// then checks the turbo cache API directly (no turbo task dependency).
// Images are compressed with zstd before upload (~2.8GB → ~500MB).
//
// Usage:
//   node scripts/docker-image-cache.js           # restore from cache or build + upload
//   node scripts/docker-image-cache.js --force   # always rebuild and re-upload

const { execSync } = require('child_process')
const { createHash } = require('crypto')
const path = require('path')
const fs = require('fs')
const os = require('os')

const { parseArgs } = require('node:util')
const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    force: { type: 'boolean', default: false },
  },
})

const REPO_ROOT = path.resolve(__dirname, '..')
const IMAGE_NAME = 'next-swc-builder:latest'

// Files that determine the docker image content — if any change, rebuild.
const CACHE_INPUTS = [
  path.join(REPO_ROOT, 'scripts/native-builder.Dockerfile'),
  path.join(REPO_ROOT, 'rust-toolchain.toml'),
]

// Turbo cache config — same env vars as turbo CLI
const TURBO_API = process.env.TURBO_API || 'https://vercel.com'
const TURBO_TOKEN = process.env.TURBO_TOKEN
const TURBO_TEAM = process.env.TURBO_TEAM

function computeCacheKey() {
  // Turbo cache keys must be hex-only (^[a-fA-F0-9]+$).
  // We hash a version prefix + file contents to produce a valid key.
  const hash = createHash('sha256')
  hash.update('docker-image-v2\0')
  for (const file of CACHE_INPUTS) {
    hash.update(file + '\0')
    hash.update(fs.readFileSync(file))
  }
  return hash.digest('hex')
}

const IS_VERCEL =
  TURBO_API === 'https://vercel.com' || TURBO_API === 'https://vercel.com/'

function turboUrl(key) {
  if (IS_VERCEL) {
    // @vercel/remote uses /api/v8/artifacts (note the /api/ prefix)
    const qs = TURBO_TEAM ? `?teamId=${TURBO_TEAM}` : ''
    return `https://vercel.com/api/v8/artifacts/${key}${qs}`
  }
  const slug = TURBO_TEAM ? `?slug=${TURBO_TEAM}` : ''
  return `${TURBO_API}/v8/artifacts/${key}${slug}`
}

function turboHeaders() {
  return {
    Authorization: `Bearer ${TURBO_TOKEN}`,
    'User-Agent': 'turbo 2 docker-image-cache',
    'x-artifact-client-ci': 'GITHUB_ACTIONS',
  }
}

function imageExists() {
  try {
    execSync(`docker image inspect ${IMAGE_NAME}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function buildImage() {
  console.log(`Building Docker image: ${IMAGE_NAME}`)
  const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'next-swc-docker-'))
  fs.copyFileSync(
    path.join(REPO_ROOT, 'rust-toolchain.toml'),
    path.join(ctx, 'rust-toolchain.toml')
  )
  try {
    execSync(
      `docker build -t ${IMAGE_NAME} -f ${path.join(REPO_ROOT, 'scripts/native-builder.Dockerfile')} ${ctx}`,
      { stdio: 'inherit' }
    )
  } finally {
    fs.rmSync(ctx, { recursive: true, force: true })
  }
}

function tmpFile(name) {
  return path.join(process.env.RUNNER_TEMP || os.tmpdir(), name)
}

/** Run a shell pipeline via bash -c (avoids execSync shell:true TS issue) */
function sh(cmd) {
  execSync(cmd, { stdio: 'inherit', shell: '/bin/bash' })
}

async function main() {
  const key = computeCacheKey()
  console.log(`Docker image cache key: ${key}`)

  if (!TURBO_TOKEN) {
    console.log('No TURBO_TOKEN — building without cache')
    if (!imageExists()) buildImage()
    return
  }

  // Try to restore from cache (unless --force)
  if (!flags.force) {
    console.log(`Checking turbo cache: HEAD ${turboUrl(key)}`)
    const headRes = await fetch(turboUrl(key), {
      method: 'HEAD',
      headers: turboHeaders(),
    })

    if (headRes.ok) {
      console.log('Cache HIT — downloading docker image...')
      const zstdFile = tmpFile('docker-image-cache.tar.zst')

      // Download with curl (handles large files, no Node buffer limits)
      const hdrs = turboHeaders()
      const curlHdrs = Object.entries(hdrs)
        .map(([k, v]) => `-H "${k}: ${v}"`)
        .join(' ')
      execSync(
        `curl -fsSL -o ${zstdFile} ${curlHdrs} "${turboUrl(key)}"`,
        { stdio: 'inherit' }
      )

      const size = fs.statSync(zstdFile).size
      console.log(
        `Downloaded ${(size / 1024 / 1024).toFixed(0)} MB compressed`
      )

      sh(`zstd -d -c ${zstdFile} | docker load`)
      fs.unlinkSync(zstdFile)
      console.log('Docker image restored from turbo cache')
      return
    } else {
      console.log(`Cache MISS (${headRes.status})`)
    }
  }

  // Build the image
  if (!imageExists() || flags.force) {
    buildImage()
  }

  // Compress and upload: docker save | zstd > file, then upload with curl
  console.log('Compressing docker image with zstd...')
  const zstdFile = tmpFile('docker-image-cache.tar.zst')
  sh(`docker save ${IMAGE_NAME} | zstd -3 -T0 -o ${zstdFile}`)

  const size = fs.statSync(zstdFile).size
  console.log(
    `Compressed: ${(size / 1024 / 1024).toFixed(0)} MB — uploading...`
  )

  // Upload with curl (handles large files, streams from disk).
  try {
    const hdrs = {
      ...turboHeaders(),
      'Content-Type': 'application/octet-stream',
      'x-artifact-duration': '0',
    }
    const curlHdrs = Object.entries(hdrs)
      .map(([k, v]) => `-H "${k}: ${v}"`)
      .join(' ')
    execSync(
      `curl -fsS -X PUT ${curlHdrs} --data-binary @${zstdFile} "${turboUrl(key)}"`,
      { stdio: 'inherit' }
    )
    console.log('Docker image uploaded to turbo cache')
  } catch {
    console.log('WARNING: Failed to upload docker image to turbo cache')
  }

  fs.unlinkSync(zstdFile)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
