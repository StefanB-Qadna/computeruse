import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const required = process.argv.includes('--required')
const binDir = path.join(root, 'bin')
const out = path.join(binDir, 'macos-input')
const src = path.join(root, 'swift', 'main.swift')

try {
  mkdirSync(binDir, { recursive: true })
  execFileSync('swiftc', ['-O', '-swift-version', '5', '-o', out, src], { stdio: 'pipe' })
  console.log(`built ${out}`)
} catch (err) {
  const msg = `warning: could not build the macOS input helper with swiftc (${err.message?.split('\n')[0] ?? err}). Mouse, keyboard, and native screenshots will be unavailable. Install Xcode Command Line Tools with: xcode-select --install`
  if (required) {
    console.error(msg)
    process.exit(1)
  }
  console.warn(msg)
}
