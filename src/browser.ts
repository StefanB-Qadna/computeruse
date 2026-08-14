import { WebSocketServer, WebSocket } from 'ws'

const DEFAULT_PORT = 17647
const PORT = Number(process.env.COMPUTERUSE_BROWSER_PORT ?? DEFAULT_PORT)
const EXPECTED_AUTH = process.env.COMPUTERUSE_BROWSER_TOKEN ?? ''

let wss: WebSocketServer | null = null
let extension: WebSocket | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

let lastSnapshot: Array<{ index: number; selector: string; text: string; tag: string }> = []

export function browserPort(): number {
  return PORT
}

export function startBrowserBridge(): void {
  if (wss) return
  wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })
  wss.on('error', (err) => {
    console.error(`browser bridge failed to listen on 127.0.0.1:${PORT}: ${err.message}`)
  })
  wss.on('connection', (socket) => {
    let authed = false
    const rejectUnauthed = () => {
      if (!authed) socket.close()
    }
    const authTimer = setTimeout(rejectUnauthed, 3000)
    socket.on('message', (data) => {
      let msg: { auth?: string; id?: number; result?: unknown; error?: string }
      try {
        msg = JSON.parse(String(data))
      } catch {
        return
      }
      if (!authed) {
        if (typeof msg.auth !== 'string') {
          socket.close()
          return
        }
        if (EXPECTED_AUTH && msg.auth !== EXPECTED_AUTH) {
          socket.close()
          return
        }
        authed = true
        clearTimeout(authTimer)
        extension?.close()
        extension = socket
        return
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!
        pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error))
        else p.resolve(msg.result)
      }
    })
    socket.on('close', () => {
      clearTimeout(authTimer)
      if (extension === socket) extension = null
    })
    socket.on('error', () => {})
  })
}

export function extensionConnected(): boolean {
  return extension !== null && extension.readyState === WebSocket.OPEN
}

export async function waitForExtension(maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (extensionConnected()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return extensionConnected()
}

export function browserCall(method: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const attempt = (waitedMs: number) => {
      if (!extensionConnected()) {
        if (waitedMs >= 40000) {
          reject(
            new Error(
              `Browser extension is not connected. Load the extension from the extension/ directory via chrome://extensions (Developer mode > Load unpacked), then reopen the browser. The bridge listens on ws://127.0.0.1:${PORT}.`,
            ),
          )
          return
        }
        setTimeout(() => attempt(waitedMs + 1000), 1000)
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`browser ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      extension!.send(JSON.stringify({ id, method, params }))
    }
    attempt(0)
  })
}

export async function browserSnapshot(params: Record<string, unknown> = {}) {
  const result = (await browserCall('snapshot', params)) as {
    elements: Array<{ index: number; selector: string; text: string; tag: string }>
  } | null
  if (!result || !Array.isArray(result.elements)) {
    throw new Error(`browser snapshot returned no data: ${JSON.stringify(result)}`)
  }
  lastSnapshot = (result.elements ?? []).map((e) => ({ index: e.index, selector: e.selector, text: e.text, tag: e.tag }))
  return result
}

export function browserClickByIndex(index: number, params: Record<string, unknown> = {}) {
  const entry = lastSnapshot.find((e) => e.index === index)
  if (!entry) {
    throw new Error(`Unknown element index ${index}. Take a fresh browser_snapshot first; indexes come from the most recent snapshot.`)
  }
  return browserCall('click', { ...params, selector: entry.selector })
}

export function browserClickBySelector(selector: string, params: Record<string, unknown> = {}) {
  return browserCall('click', { ...params, selector })
}

export function browserType(selector: string, text: string, params: Record<string, unknown> = {}) {
  return browserCall('type', { ...params, selector, text })
}

export function browserKey(key: string, modifiers: string[], selector?: string, params: Record<string, unknown> = {}) {
  return browserCall('key', { ...params, key, modifiers, selector })
}

export function browserScroll(dx: number, dy: number, selector?: string, params: Record<string, unknown> = {}) {
  return browserCall('scroll', { ...params, dx, dy, selector })
}

export function browserGetText(params: Record<string, unknown> = {}) {
  return browserCall('text', params)
}

export function browserGetHtml(selector: string, params: Record<string, unknown> = {}) {
  return browserCall('html', { ...params, selector })
}

export function browserGo(url: string, params: Record<string, unknown> = {}) {
  return browserCall('go', { ...params, url })
}

export function browserBack(params: Record<string, unknown> = {}) {
  return browserCall('back', params)
}

export function browserForward(params: Record<string, unknown> = {}) {
  return browserCall('forward', params)
}

export function browserReload(params: Record<string, unknown> = {}) {
  return browserCall('reload', params)
}

export function browserNewTab(url?: string) {
  return browserCall('newTab', { url })
}

export function browserCloseTab(tabId: number) {
  return browserCall('closeTab', { tabId })
}

export function browserListTabs() {
  return browserCall('tabs', {})
}

export function browserCaptureScreenshot(params: Record<string, unknown> = {}) {
  return browserCall('screenshot', params)
}
