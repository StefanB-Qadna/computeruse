import { createServer } from 'node:http'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = path.join(root, 'test', 'fixtures')
const BRIDGE_PORT = 17648
const BRIDGE_AUTH = `test-token-${Date.now()}`
const extensionDir = path.join(os.tmpdir(), `computeruse-ext-${Date.now()}`)
cpSync(path.join(root, 'extension'), extensionDir, { recursive: true })
writeFileSync(path.join(extensionDir, 'port.js'), `var BRIDGE_PORT = ${BRIDGE_PORT};\nvar BRIDGE_AUTH = '${BRIDGE_AUTH}';\n`)
const HTTP_PORT = 8899

const CANDIDATE_BROWSERS = [
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]
const CHROME = process.env.COMPUTERUSE_TEST_BROWSER ?? CANDIDATE_BROWSERS.find((p) => existsSync(p))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForText(client, tabId, needle, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await callTool(client, 'browser_get_text', { tabId })
    if (r.text.includes(needle)) return true
    await sleep(400)
  }
  return false
}

async function waitForUrl(client, tabId, needle, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await callTool(client, 'browser_snapshot', { tabId })
      if (r.text.includes(needle)) return true
    } catch {}
    await sleep(400)
  }
  return false
}

class McpClient {
  constructor() {
    this.proc = spawn('node', [path.join(root, 'dist', 'index.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, COMPUTERUSE_BROWSER_PORT: String(BRIDGE_PORT), COMPUTERUSE_BROWSER_TOKEN: BRIDGE_AUTH },
    })
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

async function callTool(client, name, args = {}) {
  const result = await client.request('tools/call', { name, arguments: args })
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
  return { result, text, content: result.content ?? [] }
}

const checks = []
let failures = 0
const step = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  execFileSync('pkill', ['-f', '/tmp/computeruse-cft-test'], { stdio: 'ignore' })
} catch {}
try {
  const pid = execFileSync('lsof', ['-ti', `:${BRIDGE_PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim()
  if (pid) execFileSync('kill', [pid])
} catch {}
await sleep(500)

const profileDir = `/tmp/computeruse-cft-test-${Date.now()}`

const server = createServer((req, res) => {
  const url = req.url.split('?')[0]
  const file = url === '/' || url === '' ? '/browser-test.html' : url
  try {
    const body = readFileSync(path.join(fixtures, file))
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r))

console.log('\n--- Browser bridge E2E with real Chrome ---\n')

const client = new McpClient()
await client.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'computeruse-browser-e2e', version: '1.0.0' },
})
client.notify('notifications/initialized')

const chrome = spawn(CHROME, [
  `--user-data-dir=${profileDir}`,
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=DialMediaRouteProvider',
  `http://127.0.0.1:${HTTP_PORT}/browser-test.html`,
], { stdio: 'ignore', detached: false })

let chromeExited = false
chrome.on('exit', (code) => {
  chromeExited = true
  if (!connected) console.log(`chrome exited early with code ${code}`)
})

let connected = false
for (let i = 0; i < 40; i++) {
  await sleep(750)
  const r = await callTool(client, 'browser_connect_status')
  if (r.text.includes('"connected":true')) {
    connected = true
    break
  }
  if (i % 8 === 7 || chromeExited) {
    let lsof = ''
    try {
      lsof = execFileSync('lsof', ['-i', `:${BRIDGE_PORT}`], { encoding: 'utf8' }).split('\n').slice(1).map((l) => l.trim().split(/\s+/).slice(0, 2).join(' ')).join(' | ')
    } catch {}
    console.log(`  probe ${i}: chromeExited=${chromeExited} port(${BRIDGE_PORT})=${lsof || 'nothing'}`)
  }
}
step('extension connects to bridge', connected, connected ? '' : client.stderr.slice(0, 200))

if (!connected) {
  console.log('bridge never connected; aborting')
  chrome.kill()
  client.close()
  server.close()
  process.exit(1)
}

let r = await callTool(client, 'browser_list_tabs')
const tabs = JSON.parse(r.text).tabs
step('browser_list_tabs returns tabs', Array.isArray(tabs) && tabs.length >= 1, `${tabs.length} tab(s)`)
const tabId = tabs[0].id

r = await callTool(client, 'browser_snapshot', { tabId })
let snap = JSON.parse(r.text)
step('snapshot returns page state', snap.url.includes('browser-test.html') && Array.isArray(snap.elements), `${snap.elements.length} elements`)
step('snapshot has button element', snap.elements.some((e) => e.text === 'Click me'), '')

const btnIndex = snap.elements.find((e) => e.text === 'Click me').index
r = await callTool(client, 'browser_click', { index: btnIndex, tabId })
step('browser_click by index', r.text.includes('clicked'), r.text)

step('click incremented counter to 1', await waitForText(client, tabId, 'Count: 1'), '')

const btnSel = snap.elements.find((e) => e.text === 'Click me').selector
r = await callTool(client, 'browser_click', { selector: btnSel, tabId })
step('browser_click by selector', r.text.includes('clicked'), btnSel)
step('selector click incremented counter to 2', await waitForText(client, tabId, 'Count: 2'), '')

r = await callTool(client, 'browser_type', { selector: '#name', text: 'hello agent', tabId })
step('browser_type into input', r.text.includes('"value":"hello agent"'), r.text)
step('input event propagated (mirror span updated)', await waitForText(client, tabId, 'hello agent'), '')

r = await callTool(client, 'browser_type', { selector: '#query', text: 'vinyl records', tabId })
step('type into form field', r.text.includes('typed'), '')
r = await callTool(client, 'browser_key', { key: 'Enter', selector: '#query', tabId })
step('browser_key Enter on form input', r.text.includes('pressed'), r.text)
await sleep(300)
r = await callTool(client, 'browser_get_text', { tabId })
step('form submit fired via Enter', r.text.includes('Submitted: vinyl records'), '')

r = await callTool(client, 'browser_scroll', { dx: 0, dy: 1200, tabId })
step('browser_scroll page', r.text.includes('scrolled'), r.text)
await sleep(300)
r = await callTool(client, 'browser_get_text', { tabId })
step('page scrolled to bottom marker', r.text.includes('You scrolled to the bottom'), '')

r = await callTool(client, 'browser_go', { url: `http://127.0.0.1:${HTTP_PORT}/second.html`, tabId })
step('browser_go navigates', r.text.includes('ok'), r.text)
await sleep(800)
r = await callTool(client, 'browser_snapshot', { tabId })
step('second page loaded', r.text.includes('second-heading') || r.text.includes('Second Page'), '')

r = await callTool(client, 'browser_back', { tabId })
const backSnap = await callTool(client, 'browser_snapshot', { tabId })
const backOk = await waitForUrl(client, tabId, 'browser-test.html')
step('browser_back returns to first page', backOk, backSnap.text.slice(0, 160))

r = await callTool(client, 'browser_forward', { tabId })
step('browser_forward returns to second page', await waitForUrl(client, tabId, 'second.html'), '')

r = await callTool(client, 'browser_reload', { tabId })
step('browser_reload keeps page loaded', await waitForUrl(client, tabId, 'second.html'), '')

r = await callTool(client, 'browser_new_tab', { url: `http://127.0.0.1:${HTTP_PORT}/browser-test.html` })
const newTab = JSON.parse(r.text)
step('browser_new_tab opens tab', Boolean(newTab.id), `tabId=${newTab.id} windowId=${newTab.windowId}`)
await sleep(800)
r = await callTool(client, 'browser_list_tabs')
const tabsAfter = JSON.parse(r.text).tabs
step('new tab appears in list', tabsAfter.some((t) => t.id === newTab.id), `${tabsAfter.length} tabs`)

r = await callTool(client, 'browser_snapshot', { tabId: newTab.id })
step('snapshot works on non-active tab by tabId', r.text.includes('ComputerUse Browser Test'), '')

r = await callTool(client, 'browser_click', { selector: '#btn', tabId: newTab.id })
step('click works on non-active tab by tabId', r.text.includes('clicked'), '')

r = await callTool(client, 'browser_close_tab', { tabId: newTab.id })
step('browser_close_tab closes tab', r.text.includes('ok'), '')
await sleep(500)
r = await callTool(client, 'browser_list_tabs')
const tabsFinal = JSON.parse(r.text).tabs
step('closed tab gone from list', !tabsFinal.some((t) => t.id === newTab.id), JSON.stringify(tabsFinal))

r = await callTool(client, 'browser_screenshot', { tabId })
const img = r.content.find((c) => c.type === 'image')
step('browser_screenshot returns image', Boolean(img && img.data.length > 1000), img ? `${Math.round(img.data.length / 1024)} KB` : r.text.slice(0, 150))

r = await callTool(client, 'browser_get_html', { selector: '#second-heading', tabId })
step('browser_get_html returns element html', r.text.includes('second-heading'), r.text.slice(0, 80))

chrome.kill()
client.close()
server.close()
try {
  execFileSync('rm', ['-rf', profileDir], { stdio: 'ignore' })
  rmSync(extensionDir, { recursive: true, force: true })
} catch {}

console.log(`\n${checks.length - failures} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
