import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class McpClient {
  constructor() {
    this.proc = spawn('node', [path.join(root, 'dist', 'index.js')], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString()
      let idx
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`))
          else resolve(msg.result)
        }
      }
    })
  }

  request(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  close() {
    this.proc.kill()
  }
}

async function callTool(client, name, args = {}) {
  const result = await client.request('tools/call', { name, arguments: args })
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
  return { result, text, content: result.content ?? [] }
}

const client = new McpClient()
await client.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'computeruse-e2e', version: '1.0.0' },
})
client.notify('notifications/initialized')

const checks = []
const step = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('\n--- E2E: control TextEdit with image-space coordinates ---\n')

step('open_app TextEdit', (await callTool(client, 'open_app', { name: 'TextEdit' })).text.includes('ok'))
await sleep(1500)

let r = await callTool(client, 'screenshot', {})
const firstShot = r.content.find((c) => c.type === 'image')
step('initial screenshot (establishes image space)', Boolean(firstShot), r.text.slice(0, 80))

r = await callTool(client, 'list_windows')
const windows = JSON.parse(r.text)
const te = windows.filter((w) => w.app === 'TextEdit')
step('TextEdit window visible in image space', te.length >= 1, te.length ? JSON.stringify(te[0]) : 'none found')
if (!te.length) {
  console.log('no TextEdit window; aborting')
  client.close()
  process.exit(1)
}
const teWin = te[0]

r = await callTool(client, 'focus_window', { app: 'TextEdit', index: teWin.index })
step('focus TextEdit window', r.text.includes('ok'))
await sleep(500)

r = await callTool(client, 'hotkey', { combo: 'cmd+n' })
step('cmd+n new document', r.text.includes('ok'))
await sleep(1200)

r = await callTool(client, 'type_text', { text: 'HELLO computeruse e2e 123' })
step('type_text pastes into document', r.text.includes('paste'))
await sleep(800)

execFileSync(path.join(root, 'bin', 'macos-input'), ['type', 'typed-via-keycodes'], { stdio: 'pipe' })
await sleep(800)

r = await callTool(client, 'screenshot', {})
const shot = r.content.find((c) => c.type === 'image')
writeFileSync(path.join(artifacts, 'e2e-image-space.png'), Buffer.from(shot.data, 'base64'))
step('screenshot after typing saved', Boolean(shot), path.join(artifacts, 'e2e-image-space.png'))

r = await callTool(client, 'list_windows')
const windowsAfter = JSON.parse(r.text)
const teAfter = windowsAfter.filter((w) => w.app === 'TextEdit')
writeFileSync(path.join(artifacts, 'e2e-window-bounds.json'), JSON.stringify(teAfter, null, 2))
step('TextEdit bounds re-read in image space', teAfter.length >= 1, teAfter.length ? JSON.stringify(teAfter[0]) : 'none')

if (teAfter.length) {
  const titleX = Math.round(teAfter[0].x + teAfter[0].width / 2)
  const titleY = Math.round(teAfter[0].y + 18)
  r = await callTool(client, 'mouse_click', { button: 'left', x: titleX, y: titleY })
  step(`click TextEdit title bar at image (${titleX},${titleY})`, r.text.includes('"ok":true'), r.text)
  await sleep(600)
  r = await callTool(client, 'get_active_window')
  const active = JSON.parse(r.text)
  step('TextEdit is frontmost after title bar click', active.app === 'TextEdit', active.app)

  r = await callTool(client, 'resize_window', {
    app: 'TextEdit',
    index: teAfter[0].index,
    x: 150,
    y: 120,
    width: 500,
    height: 250,
  })
  step('resize_window in image space', r.text.includes('ok'), r.text)
  await sleep(600)
  r = await callTool(client, 'list_windows')
  const resized = JSON.parse(r.text).filter((w) => w.app === 'TextEdit')
  if (resized.length) {
    const w = resized[0]
    const close = Math.abs(w.x - 150) <= 12 && Math.abs(w.y - 120) <= 12 && Math.abs(w.width - 500) <= 12 && Math.abs(w.height - 250) <= 12
    step('resized window matches image-space request', close, JSON.stringify(w))
  }
}

console.log('\n--- cleanup: quit TextEdit ---\n')
const teWindows = JSON.parse((await callTool(client, 'list_windows')).text).filter((w) => w.app === 'TextEdit')
for (const w of teWindows.reverse()) {
  try {
    await callTool(client, 'close_window', { app: 'TextEdit', index: w.index })
  } catch {}
}
await sleep(500)
try {
  execFileSync('osascript', ['-e', 'tell application "TextEdit" to quit saving no'], { stdio: 'pipe', timeout: 5000 })
} catch {}
console.log('TextEdit quit')

client.close()
const failed = checks.filter((c) => !c.ok).length
console.log(`\n${checks.length - failed} passed, ${failed} failed`)
writeFileSync(path.join(artifacts, 'e2e-results.json'), JSON.stringify(checks, null, 2))
process.exit(failed ? 1 : 0)
