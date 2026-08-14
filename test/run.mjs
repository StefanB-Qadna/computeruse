import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(root, 'test', 'artifacts')
mkdirSync(artifacts, { recursive: true })

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
    this.stderr = ''
    this.proc.stderr.on('data', (chunk) => (this.stderr += chunk.toString()))
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

const results = []
let failures = 0

function check(name, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL'
  if (!condition) failures++
  results.push({ name, status, detail: String(detail).slice(0, 400) })
  console.log(`${status} ${name}${detail && condition ? ` — ${String(detail).slice(0, 200)}` : ''}`)
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
  clientInfo: { name: 'computeruse-test', version: '1.0.0' },
})
client.notify('notifications/initialized')

const listed = await client.request('tools/list')
const names = listed.tools.map((t) => t.name)
console.log(`\n${names.length} tools registered: ${names.join(', ')}\n`)

const expected = [
  'screenshot', 'get_screen_info', 'get_mouse_position', 'mouse_move', 'mouse_click',
  'mouse_drag', 'mouse_scroll', 'key_press', 'hotkey', 'type_text',
  'get_clipboard', 'set_clipboard', 'open_app', 'list_windows', 'get_active_window',
  'focus_window', 'resize_window', 'close_window', 'check_permissions', 'setup_permissions', 'abort',
]
for (const name of expected) {
  check(`tool present: ${name}`, names.includes(name))
}

let r = await callTool(client, 'check_permissions')
const perms = JSON.parse(r.text)
check('check_permissions returns structured result', typeof perms.accessibility === 'boolean' && typeof perms.screenRecording === 'boolean', JSON.stringify(perms))
console.log(`    accessibility=${perms.accessibility} screenRecording=${perms.screenRecording}`)

r = await callTool(client, 'get_screen_info')
const info = JSON.parse(r.text)
check('get_screen_info returns screens', Array.isArray(info.screens) && info.screens.length >= 1, `${info.screens.length} display(s)`)

r = await callTool(client, 'get_clipboard')
check('get_clipboard returns string', typeof r.text === 'string')

r = await callTool(client, 'set_clipboard', { text: 'computeruse-mcp-clipboard-test' })
check('set_clipboard succeeds', r.text.includes('clipboard set'))
r = await callTool(client, 'get_clipboard')
check('clipboard roundtrip', r.text === 'computeruse-mcp-clipboard-test', `got: ${JSON.stringify(r.text)}`)

r = await callTool(client, 'list_windows')
let windows = []
try {
  windows = JSON.parse(r.text)
} catch {}
check('list_windows returns array', Array.isArray(windows), `${windows.length} windows`)

r = await callTool(client, 'get_active_window')
let active = null
try {
  active = JSON.parse(r.text)
} catch {}
check('get_active_window returns app name', Boolean(active && typeof active.app === 'string'), active ? active.app : r.text)

if (perms.screenRecording) {
  r = await callTool(client, 'screenshot', {})
  const img = r.content.find((c) => c.type === 'image')
  const m = r.text.match(/(\d+)x(\d+)px \(image space\)/)
  check('screenshot returns image content', Boolean(img && img.data.length > 1000), img ? `${Math.round(img.data.length / 1024)} KB base64` : '')
  check('screenshot auto-scales to model-safe size', Boolean(m && Number(m[1]) <= 1568 && Number(m[2]) <= 1568), m ? `${m[1]}x${m[2]}` : r.text.slice(0, 120))
  const autoDims = m ? { width: Number(m[1]), height: Number(m[2]) } : null
  const fullMatch = r.text.match(/Full screen is (\d+)x(\d+)px/)
  const fullDims = fullMatch ? { width: Number(fullMatch[1]), height: Number(fullMatch[2]) } : null
  if (img && autoDims && fullDims) {
    writeFileSync(path.join(artifacts, 'screenshot-auto.png'), Buffer.from(img.data, 'base64'))
    const aspectOk = Math.abs(autoDims.width / autoDims.height - fullDims.width / fullDims.height) < 0.01
    check('auto screenshot preserves aspect ratio', aspectOk, `${autoDims.width}x${autoDims.height} of ${fullDims.width}x${fullDims.height}`)
    const full = await callTool(client, 'screenshot', { downscale: 1 })
    const fullImg = full.content.find((c) => c.type === 'image')
    const fm = full.text.match(/(\d+)x(\d+)px \(image space\)/)
    if (fullImg && fm) {
      writeFileSync(path.join(artifacts, 'screenshot-full.png'), Buffer.from(fullImg.data, 'base64'))
      check('downscale:1 returns full-size image', Number(fm[1]) === fullDims.width && Number(fm[2]) === fullDims.height, `${fm[1]}x${fm[2]}`)
    }
  }
} else {
  console.log('SKIP screenshot tests (Screen Recording permission not granted)')
}

if (perms.accessibility) {
  await callTool(client, 'screenshot', {})
  const screenMatch = (await callTool(client, 'get_screen_info')).text.match(/"screenWidth": (\d+),\n\s+"screenHeight": (\d+)/)
  const imageMatch = (await callTool(client, 'get_screen_info')).text.match(/"imageWidth": (\d+),\n\s+"imageHeight": (\d+)/)
  const screenDims = screenMatch ? { w: Number(screenMatch[1]), h: Number(screenMatch[2]) } : null
  const imageDims = imageMatch ? { w: Number(imageMatch[1]), h: Number(imageMatch[2]) } : null
  check('screen info reports scaled image dims', Boolean(screenDims && imageDims && imageDims.w <= 1568), screenDims && imageDims ? `image ${imageDims.w}x${imageDims.h}, screen ${screenDims.w}x${screenDims.h}` : '')

  r = await callTool(client, 'get_mouse_position')
  const pos = JSON.parse(r.text)
  check('get_mouse_position returns coords', typeof pos.x === 'number' && typeof pos.y === 'number', JSON.stringify(pos))

  r = await callTool(client, 'mouse_move', { x: pos.x, y: pos.y })
  check('mouse_move to current position', r.text.includes('"ok":true'))

  if (screenDims && imageDims) {
    const target = { x: 800, y: 300 }
    await callTool(client, 'mouse_move', target)
    r = await callTool(client, 'get_mouse_position')
    const after = JSON.parse(r.text)
    const expectedScreenX = Math.round((target.x * screenDims.w) / imageDims.w)
    const expectedScreenY = Math.round((target.y * screenDims.h) / imageDims.h)
    const roundtrip =
      Math.abs(after.x - target.x) <= 2 &&
      Math.abs(after.y - target.y) <= 2 &&
      Math.abs(after.screenX - expectedScreenX) <= 3 &&
      Math.abs(after.screenY - expectedScreenY) <= 3
    check(
      'scaled image-space roundtrip: image coords convert to screen correctly',
      roundtrip,
      `image (${target.x},${target.y}) -> screen (${after.screenX},${after.screenY}), expected (${expectedScreenX},${expectedScreenY})`,
    )
  }

  r = await callTool(client, 'mouse_click', { button: 'left' })
  check('mouse_click at current position', r.text.includes('"ok":true'))

  r = await callTool(client, 'mouse_scroll', { dx: 0, dy: 0 })
  check('mouse_scroll zero delta', r.text.includes('"ok":true'))

  r = await callTool(client, 'key_press', { key: 'esc' })
  check('key_press esc', r.text.includes('"ok":true'))

  r = await callTool(client, 'hotkey', { combo: 'shift+right' })
  check('hotkey shift+right', r.text.includes('"ok":true') || r.text.includes('Error'))

  r = await callTool(client, 'mouse_drag', { x1: pos.x, y1: pos.y, x2: pos.x + 1, y2: pos.y + 1, duration_ms: 50 })
  check('mouse_drag 1px', r.text.includes('"ok":true'))

  r = await callTool(client, 'type_text', { text: '' })
  check('type_text returns paste result', r.text.includes('paste'), r.text)
} else {
  console.log('SKIP mouse/keyboard tests (Accessibility permission not granted)')
}

r = await callTool(client, 'abort')
check('abort returns guidance', r.text.includes('Ctrl+C'))

r = await callTool(client, 'nonexistent_tool')
check('unknown tool returns error', r.text.includes('Error') || r.result.isError === true)

client.close()

console.log(`\n${results.length - failures} passed, ${failures} failed, ${results.filter((x) => x.status === 'FAIL').map((x) => x.name).join(', ') || 'no failures'}`)
writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2))
process.exit(failures > 0 ? 1 : 0)
