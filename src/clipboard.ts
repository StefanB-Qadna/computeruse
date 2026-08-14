import { execFileSync } from 'node:child_process'

export function getClipboard(): string {
  return execFileSync('pbpaste', ['-Prefer', 'txt'], { encoding: 'utf8' })
}

export function setClipboard(text: string) {
  const proc = execFileSync('pbcopy', { encoding: 'utf8', input: text })
  return proc
}
