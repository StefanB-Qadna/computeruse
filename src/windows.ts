import { execFileSync } from 'node:child_process'

export interface WindowInfo {
  app: string
  title: string
  index: number
  x: number
  y: number
  width: number
  height: number
}

function runAppleScript(script: string): string {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function openApp(name: string) {
  execFileSync('open', ['-a', name], { stdio: 'pipe' })
  return { ok: true, app: name }
}

export function listWindows(): WindowInfo[] {
  const script = `
tell application "System Events"
  set out to ""
  repeat with p in (every application process whose background only is false)
    set pname to name of p
    try
      set idx to 0
      repeat with w in (every window of p)
        set idx to idx + 1
        set {px, py} to position of w
        set {sx, sy} to size of w
        set out to out & pname & tab & (name of w) & tab & idx & tab & px & tab & py & tab & sx & tab & sy & linefeed
      end repeat
    end try
  end repeat
  return out
end tell
`
  const output = runAppleScript(script).trim()
  if (!output) return []
  return output.split('\n').flatMap((line) => {
    const parts = line.split('\t')
    if (parts.length < 7) return []
    const [app, title, index, x, y, width, height] = parts
    return [{
      app,
      title,
      index: Number(index),
      x: Math.round(Number(x)),
      y: Math.round(Number(y)),
      width: Math.round(Number(width)),
      height: Math.round(Number(height)),
    }]
  })
}

export function getActiveWindow(): { app: string; windows: WindowInfo[] } | { app: string; windows: [] } {
  const script = `tell application "System Events" to get name of first application process whose frontmost is true`
  const app = runAppleScript(script).trim()
  const windows = listWindows().filter((w) => w.app === app)
  return { app, windows }
}

export function focusWindow(app: string, index: number) {
  const appEsc = escapeAppleScript(app)
  const script = `
tell application "System Events"
  tell process "${appEsc}"
    set frontmost to true
    try
      perform action "AXRaise" of window ${index}
    end try
  end tell
end tell
`
  runAppleScript(script)
  return { ok: true, app, index }
}

export function resizeWindow(app: string, index: number, x: number, y: number, width: number, height: number) {
  const appEsc = escapeAppleScript(app)
  const script = `
tell application "System Events"
  tell process "${appEsc}"
    set position of window ${index} to {${x}, ${y}}
    set size of window ${index} to {${width}, ${height}}
  end tell
end tell
`
  runAppleScript(script)
  return { ok: true, app, index, x, y, width, height }
}

export function closeWindow(app: string, index: number) {
  const appEsc = escapeAppleScript(app)
  const script = `
tell application "System Events"
  tell process "${appEsc}"
    click button 1 of window ${index}
  end tell
end tell
`
  runAppleScript(script)
  return { ok: true, app, index }
}
