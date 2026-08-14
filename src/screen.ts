import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getInfo } from './input.js'
import { helperAvailable, runSafe, screencaptureFallback } from './helper.js'

const MAX_LONG_EDGE = Number(process.env.COMPUTERUSE_MAX_IMAGE_EDGE ?? 1568)

export interface ScreenshotResult {
  path: string
  width: number
  height: number
  data: string
}

export interface CoordinateMapping {
  imageWidth: number
  imageHeight: number
  screenWidth: number
  screenHeight: number
}

let mapping: CoordinateMapping = {
  imageWidth: 0,
  imageHeight: 0,
  screenWidth: 0,
  screenHeight: 0,
}

export function getMapping(): CoordinateMapping {
  if (mapping.screenWidth > 0) return mapping
  const info = getInfo()
  const screens = info.screens
  const minX = Math.min(...screens.map((s) => s.x))
  const minY = Math.min(...screens.map((s) => s.y))
  const maxX = Math.max(...screens.map((s) => s.x + s.width))
  const maxY = Math.max(...screens.map((s) => s.y + s.height))
  mapping = {
    imageWidth: maxX - minX,
    imageHeight: maxY - minY,
    screenWidth: maxX - minX,
    screenHeight: maxY - minY,
  }
  return mapping
}

export function toScreen(x: number, y: number): { x: number; y: number } {
  const m = getMapping()
  if (m.screenWidth === 0 || m.imageWidth === 0) return { x, y }
  return {
    x: Math.round((x * m.screenWidth) / m.imageWidth),
    y: Math.round((y * m.screenHeight) / m.imageHeight),
  }
}

export function toImage(x: number, y: number): { x: number; y: number } {
  const m = getMapping()
  if (m.screenWidth === 0 || m.imageWidth === 0) return { x, y }
  return {
    x: Math.round((x * m.imageWidth) / m.screenWidth),
    y: Math.round((y * m.imageHeight) / m.screenHeight),
  }
}

export function screenshot(options: { downscale?: number | 'auto'; targetPath?: string } = {}): ScreenshotResult {
  const requested = options.downscale ?? 'auto'
  const dir = options.targetPath ? path.dirname(options.targetPath) : os.tmpdir()
  mkdirSync(dir, { recursive: true })
  const base = options.targetPath ?? path.join(dir, `computeruse-${Date.now()}.png`)
  const capturePath = `${base}.full.png`

  if (helperAvailable()) {
    const result = runSafe('shot', [capturePath])
    if (result.ok) {
      const full = { width: result.data.width as number, height: result.data.height as number }
      const dims = resizeTo(base, capturePath, full, requested)
      return buildResult(base, dims, full)
    }
    if (!result.error.includes('Screen Recording')) {
      throw new Error(result.error)
    }
  }

  screencaptureFallback(capturePath)
  const full = pngSize(capturePath)
  const dims = resizeTo(base, capturePath, full, requested)
  return buildResult(base, dims, full)
}

function resizeTo(
  base: string,
  capturePath: string,
  full: { width: number; height: number },
  requested: number | 'auto',
): { width: number; height: number } {
  let scale = 1
  if (typeof requested === 'number') {
    if (requested <= 0 || requested > 1) throw new Error('downscale must be in (0, 1]')
    scale = requested
  } else if (requested === 'auto') {
    scale = Math.min(1, MAX_LONG_EDGE / Math.max(full.width, full.height))
  }
  if (scale < 1) {
    const target = Math.max(1, Math.round(Math.max(full.width, full.height) * scale))
    execFileSync('sips', ['-Z', String(target), capturePath, '--out', base], { stdio: 'pipe' })
    unlinkSync(capturePath)
    return pngSize(base)
  }
  if (base !== capturePath) {
    execFileSync('mv', [capturePath, base], { stdio: 'pipe' })
  }
  return full
}

function buildResult(
  base: string,
  dims: { width: number; height: number },
  full: { width: number; height: number },
): ScreenshotResult {
  mapping = {
    imageWidth: dims.width,
    imageHeight: dims.height,
    screenWidth: full.width,
    screenHeight: full.height,
  }
  const bytes = readFileSync(base)
  return { path: base, width: dims.width, height: dims.height, data: bytes.toString('base64') }
}

function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}
