import { runSafe } from './helper.js'
import { getClipboard, setClipboard } from './clipboard.js'

export interface ScreenInfo {
  screens: Array<{ x: number; y: number; width: number; height: number; scale: number; pixelWidth: number; pixelHeight: number }>
  mouse: { x: number; y: number }
  accessibility: boolean
  screenRecording: boolean
}

export function getInfo(): ScreenInfo {
  const result = runSafe('info')
  if (!result.ok) throw new Error(result.error)
  return result.data as ScreenInfo
}

export function getMousePosition(): { x: number; y: number } {
  const result = runSafe('pos')
  if (!result.ok) throw new Error(result.error)
  return result.data as { x: number; y: number }
}

export function mouseMove(x: number, y: number) {
  const result = runSafe('move', [String(x), String(y)])
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export function mouseClick(options: { button?: 'left' | 'right' | 'center'; x?: number; y?: number; double?: boolean } = {}) {
  const args: string[] = [options.button ?? 'left']
  if (options.x !== undefined && options.y !== undefined) {
    args.push(String(options.x), String(options.y))
  }
  if (options.double) args.push('double')
  const result = runSafe('click', args)
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export function mouseDrag(x1: number, y1: number, x2: number, y2: number, durationMs = 300) {
  const result = runSafe('drag', [String(x1), String(y1), String(x2), String(y2), String(durationMs)])
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export function mouseScroll(dx: number, dy: number, x?: number, y?: number) {
  const args: string[] = [String(dx), String(dy)]
  if (x !== undefined && y !== undefined) args.push(String(x), String(y))
  const result = runSafe('scroll', args)
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export function keyPress(key: string, modifiers: string[] = []) {
  const args: string[] = modifiers.length ? [key, modifiers.join('+')] : [key]
  const result = runSafe('key', args)
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export function hotkey(combo: string) {
  const result = runSafe('hotkey', [combo])
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export function typeText(text: string) {
  const previous = getClipboard()
  setClipboard(text)
  const paste = runSafe('hotkey', ['cmd+v'])
  setTimeout(() => {
    try {
      setClipboard(previous)
    } catch {}
  }, 300)
  if (!paste.ok) throw new Error(paste.error)
  return { ok: true, method: 'paste' }
}
