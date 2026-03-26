#!/usr/bin/env node
// @ts-check
//
// Build or restore the next-swc-builder Docker image using turbo remote cache.
//
// Computes a cache key from the Dockerfile + rust-toolchain.toml contents,
// then checks the turbo cache API directly (no turbo task dependency).
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
  const hash = createHash('sha256')
  for (const file of CACHE_INPUTS) {
    hash.update(file + '\0')
    hash.update(fs.readFileSync(file))
  }
  return `docker-image-v1-${hash.digest('hex').slice(0, 32)}`
}

function turboUrl(key) {
  const slug = TURBO_TEAM ? `?slug=${TURBO_TEAM}` : ''
  return `${TURBO_API}/v8/artifacts/${encodeURIComponent(key)}${slug}`
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
      headers: { Authorization: `Bearer ${TURBO_TOKEN}` },
    })

    if (headRes.ok) {
      console.log('Cache HIT — downloading docker image...')
      const getRes = await fetch(turboUrl(key), {
        method: 'GET',
        headers: { Authorization: `Bearer ${TURBO_TOKEN}` },
      })

      if (getRes.ok && getRes.body) {
        // Pipe the response body directly into docker load
        const tmpTar = path.join(
          process.env.RUNNER_TEMP || os.tmpdir(),
          'docker-image-cache.tar'
        )
        const buf = Buffer.from(await getRes.arrayBuffer())
        fs.writeFileSync(tmpTar, buf)
        console.log(`Downloaded ${(buf.length / 1024 / 1024).toFixed(0)} MB`)

        execSync(`docker load -i ${tmpTar}`, { stdio: 'inherit' })
        fs.unlinkSync(tmpTar)
        console.log('Docker image restored from turbo cache')
        return
      }
      console.log(`Cache download failed: ${getRes.status}`)
    } else {
      console.log(`Cache MISS (${headRes.status})`)
    }
  }

  // Build the image
  if (!imageExists() || flags.force) {
    buildImage()
  }

  // Upload to cache
  console.log('Uploading docker image to turbo cache...')
  const tmpTar = path.join(
    process.env.RUNNER_TEMP || os.tmpdir(),
    'docker-image-cache.tar'
  )
  execSync(`docker save ${IMAGE_NAME} -o ${tmpTar}`, { stdio: 'inherit' })
  const body = fs.readFileSync(tmpTar)
  console.log(`Uploading ${(body.length / 1024 / 1024).toFixed(0)} MB...`)

  const putRes = await fetch(turboUrl(key), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${TURBO_TOKEN}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
    },
    body,
  })

  fs.unlinkSync(tmpTar)

  if (putRes.ok) {
    console.log('Docker image uploaded to turbo cache')
  } else {
    console.log(
      `WARNING: Failed to upload docker image: ${putRes.status} ${await putRes.text()}`
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
