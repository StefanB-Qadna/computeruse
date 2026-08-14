import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const helperPath = path.join(root, 'bin', 'macos-input')

export function helperAvailable() {
  return existsSync(helperPath)
}

export function run(command: string, args: string[] = []) {
  const result = execFileSync(helperPath, [command, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = result.trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

export function runSafe(command: string, args: string[] = []): { ok: true; data: any } | { ok: false; error: string } {
  try {
    return { ok: true, data: run(command, args) }
  } catch (err) {
    const e = err as { stderr?: unknown; stdout?: unknown; message?: string }
    const stderr = e.stderr ? String(e.stderr).trim() : String(e.message)
    let message = stderr
    if (e.stdout && String(e.stdout).includes('"error"')) {
      try {
        const parsed = JSON.parse(String(e.stdout).trim().split('\n').pop() ?? '')
        message = parsed.error ?? message
      } catch {}
    }
    return { ok: false, error: message }
  }
}

export function screencaptureFallback(targetPath: string) {
  execFileSync('screencapture', ['-x', targetPath], { stdio: 'pipe' })
}
