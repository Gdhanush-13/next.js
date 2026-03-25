#!/usr/bin/env node
// Write a fingerprint stamp file for Rust inputs.
//
// Turbo tasks that depend on rust-fingerprint only need to list the stamp
// file as an input instead of repeating all the Rust source globs.
//
// TURBO_HASH is set by turbo when running a task — it's the hash of all
// the task's inputs. We just write it to a file so downstream tasks can
// use it as a single input.
//
// No-op when not running under turbo (avoids side effects in local dev).

const fs = require('fs')
const path = require('path')

if (!process.env.TURBO_HASH) {
  console.log('rust-fingerprint: skipping (not running under turbo)')
  process.exit(0)
}

const stamp = path.resolve(__dirname, '..', 'target', '.rust-fingerprint')
fs.mkdirSync(path.dirname(stamp), { recursive: true })
fs.writeFileSync(stamp, process.env.TURBO_HASH + '\n')
console.log(`rust-fingerprint: ${process.env.TURBO_HASH}`)
