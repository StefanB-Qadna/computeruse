import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { getClipboard, setClipboard } from './clipboard.js'
import { getInfo, getMousePosition, hotkey, keyPress, mouseClick, mouseDrag, mouseMove, mouseScroll, typeText } from './input.js'
import { checkPermissions, setupPermissions } from './permissions.js'
import { getMapping, screenshot, toImage, toScreen } from './screen.js'
import { closeWindow, focusWindow, getActiveWindow, listWindows, openApp, resizeWindow } from './windows.js'

const COORD_NOTE =
  'Coordinates are in the pixel space of the most recent screenshot. The tools convert them to screen coordinates automatically, so you do not need to scale anything.'

export interface ToolDef {
  name: string
  description: string
  schema: z.ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>
}

export const tools: ToolDef[] = [
  {
    name: 'screenshot',
    description:
      'Capture the macOS screen (all displays) as a PNG image. By default the image is scaled so its long edge is at most 1568px, matching the resolution the model sees. All coordinate-based tools use this image\'s pixel space.',
    schema: {
      downscale: z
        .union([z.number().min(0.1).max(1), z.literal('auto')])
        .optional()
        .describe('Scale factor (0.1-1) or "auto" (default) which fits the long edge to the model\'s 1568px limit'),
    },
    handler: async (args) => {
      const result = screenshot({ downscale: args.downscale as number | 'auto' | undefined })
      const m = getMapping()
      return {
        content: [
          {
            type: 'text',
            text:
              `Screenshot captured: ${result.width}x${result.height}px (image space). ` +
              `Full screen is ${m.screenWidth}x${m.screenHeight}px. ${COORD_NOTE} Saved to ${result.path}`,
          },
          { type: 'image', data: result.data, mimeType: 'image/png' },
        ],
      }
    },
  },
  {
    name: 'get_screen_info',
    description: `Get display layout and permission status. Bounds are in the pixel space of the most recent screenshot. ${COORD_NOTE}`,
    schema: {},
    handler: async () => {
      const info = getInfo()
      const m = getMapping()
      const scaleX = m.screenWidth > 0 ? m.imageWidth / m.screenWidth : 1
      const scaleY = m.screenHeight > 0 ? m.imageHeight / m.screenHeight : 1
      const screens = info.screens.map((s) => ({
        x: Math.round(s.x * scaleX),
        y: Math.round(s.y * scaleY),
        width: Math.round(s.width * scaleX),
        height: Math.round(s.height * scaleY),
        scale: s.scale,
        pixelWidth: s.pixelWidth,
        pixelHeight: s.pixelHeight,
      }))
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                screens,
                imageWidth: m.imageWidth,
                imageHeight: m.imageHeight,
                screenWidth: m.screenWidth,
                screenHeight: m.screenHeight,
                accessibility: info.accessibility,
                screenRecording: info.screenRecording,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  },
  {
    name: 'get_mouse_position',
    description: `Get the current mouse cursor position in the pixel space of the most recent screenshot, plus the raw screen coordinates. ${COORD_NOTE}`,
    schema: {},
    handler: async () => {
      const pos = getMousePosition()
      const image = toImage(pos.x, pos.y)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ x: image.x, y: image.y, screenX: pos.x, screenY: pos.y }),
          },
        ],
      }
    },
  },
  {
    name: 'mouse_move',
    description: `Move the mouse cursor to (x, y). ${COORD_NOTE}`,
    schema: {
      x: z.number().describe('Horizontal coordinate in image space'),
      y: z.number().describe('Vertical coordinate in image space'),
    },
    handler: async (args) => {
      const p = toScreen(args.x as number, args.y as number)
      const result = mouseMove(p.x, p.y)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  },
  {
    name: 'mouse_click',
    description: `Click at (x, y), or at the current cursor position if coordinates are omitted. Supports left, right, and center buttons, and double clicks. ${COORD_NOTE}`,
    schema: {
      button: z.enum(['left', 'right', 'center']).default('left'),
      x: z.number().optional(),
      y: z.number().optional(),
      double: z.boolean().default(false),
    },
    handler: async (args) => {
      const x = args.x as number | undefined
      const y = args.y as number | undefined
      const p = x !== undefined && y !== undefined ? toScreen(x, y) : { x: undefined, y: undefined }
      const result = mouseClick({
        button: args.button as 'left' | 'right' | 'center',
        x: p.x,
        y: p.y,
        double: args.double as boolean,
      })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  },
  {
    name: 'mouse_drag',
    description: `Press the left button at (x1, y1), drag to (x2, y2), and release. ${COORD_NOTE}`,
    schema: {
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
      duration_ms: z.number().int().positive().default(300).describe('Duration of the drag in milliseconds'),
    },
    handler: async (args) => {
      const from = toScreen(args.x1 as number, args.y1 as number)
      const to = toScreen(args.x2 as number, args.y2 as number)
      const result = mouseDrag(from.x, from.y, to.x, to.y, args.duration_ms as number)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  },
  {
    name: 'mouse_scroll',
    description: `Scroll by (dx, dy) pixels. Negative dy scrolls down. Optionally move the cursor to (x, y) first. ${COORD_NOTE}`,
    schema: {
      dx: z.number().default(0).describe('Horizontal scroll amount in pixels'),
      dy: z.number().default(0).describe('Vertical scroll amount in pixels'),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    handler: async (args) => {
      const x = args.x as number | undefined
      const y = args.y as number | undefined
      const p = x !== undefined && y !== undefined ? toScreen(x, y) : { x: undefined, y: undefined }
      const result = mouseScroll(args.dx as number, args.dy as number, p.x, p.y)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  },
  {
    name: 'key_press',
    description: 'Press a key, optionally with modifiers. Key names: letters, digits, return, tab, space, escape, delete, forwarddelete, arrow keys (left/right/up/down), home, end, pageup, pagedown, f1-f12. Modifiers: cmd, shift, alt, ctrl, fn.',
    schema: {
      key: z.string().describe('Key name, e.g. "return", "a", "space", "f5"'),
      modifiers: z.array(z.enum(['cmd', 'shift', 'alt', 'ctrl', 'fn'])).default([]),
    },
    handler: async (args) => {
      const result = keyPress(args.key as string, args.modifiers as string[])
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  },
  {
    name: 'hotkey',
    description: 'Press a key combination like "cmd+shift+4" or "ctrl+tab". The key part accepts letters, digits, "=", "-", "return", "escape", and arrow names.',
    schema: {
      combo: z.string().describe('Plus-separated combination, key last, e.g. "cmd+shift+p"'),
    },
    handler: async (args) => {
      const result = hotkey(args.combo as string)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  },
  {
    name: 'type_text',
    description: 'Type text at the current cursor location via clipboard paste. Handles any Unicode text. The previous clipboard content is restored afterwards.',
    schema: {
      text: z.string().describe('Text to type'),
    },
    handler: async (args) => {
      const result = typeText(args.text as string)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  },
  {
    name: 'get_clipboard',
    description: 'Read the current clipboard text content.',
    schema: {},
    handler: async () => {
      const text = getClipboard()
      return { content: [{ type: 'text', text }] }
    },
  },
  {
    name: 'set_clipboard',
    description: 'Set the clipboard text content.',
    schema: {
      text: z.string(),
    },
    handler: async (args) => {
      setClipboard(args.text as string)
      return { content: [{ type: 'text', text: 'clipboard set' }] }
    },
  },
  {
    name: 'open_app',
    description: 'Launch a macOS application by name or bundle id, e.g. "Safari" or "com.apple.TextEdit".',
    schema: {
      name: z.string(),
    },
    handler: async (args) => {
      const result = openApp(args.name as string)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  },
  {
    name: 'list_windows',
    description: `List all visible windows across applications with app name, title, index, position, and size. Positions and sizes are in the pixel space of the most recent screenshot. ${COORD_NOTE}`,
    schema: {},
    handler: async () => {
      const windows = listWindows()
      const m = getMapping()
      const scaleX = m.screenWidth > 0 ? m.imageWidth / m.screenWidth : 1
      const scaleY = m.screenHeight > 0 ? m.imageHeight / m.screenHeight : 1
      const imageSpace = windows.map((w) => ({
        app: w.app,
        title: w.title,
        index: w.index,
        x: Math.round(w.x * scaleX),
        y: Math.round(w.y * scaleY),
        width: Math.round(w.width * scaleX),
        height: Math.round(w.height * scaleY),
      }))
      return { content: [{ type: 'text', text: JSON.stringify(imageSpace, null, 2) }] }
    },
  },
  {
    name: 'get_active_window',
    description: `Get the frontmost application and its windows. Positions and sizes are in the pixel space of the most recent screenshot. ${COORD_NOTE}`,
    schema: {},
    handler: async () => {
      const active = getActiveWindow()
      const m = getMapping()
      const scaleX = m.screenWidth > 0 ? m.imageWidth / m.screenWidth : 1
      const scaleY = m.screenHeight > 0 ? m.imageHeight / m.screenHeight : 1
      const windows = active.windows.map((w) => ({
        app: w.app,
        title: w.title,
        index: w.index,
        x: Math.round(w.x * scaleX),
        y: Math.round(w.y * scaleY),
        width: Math.round(w.width * scaleX),
        height: Math.round(w.height * scaleY),
      }))
      return { content: [{ type: 'text', text: JSON.stringify({ app: active.app, windows }, null, 2) }] }
    },
  },
  {
    name: 'focus_window',
    description: 'Bring a window to the front by app name and window index (from list_windows).',
    schema: {
      app: z.string(),
      index: z.number().int().positive(),
    },
    handler: async (args) => {
      const result = focusWindow(args.app as string, args.index as number)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  },
  {
    name: 'resize_window',
    description: `Move and resize a window by app name and window index (from list_windows). Position and size are in the pixel space of the most recent screenshot. ${COORD_NOTE}`,
    schema: {
      app: z.string(),
      index: z.number().int().positive(),
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    },
    handler: async (args) => {
      const tl = toScreen(args.x as number, args.y as number)
      const m = getMapping()
      const scaleX = m.screenWidth > 0 ? m.imageWidth / m.screenWidth : 1
      const scaleY = m.screenHeight > 0 ? m.imageHeight / m.screenHeight : 1
      const width = Math.round((args.width as number) / scaleX)
      const height = Math.round((args.height as number) / scaleY)
      const result = resizeWindow(args.app as string, args.index as number, tl.x, tl.y, width, height)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  },
  {
    name: 'close_window',
    description: 'Close a window by app name and window index (from list_windows).',
    schema: {
      app: z.string(),
      index: z.number().int().positive(),
    },
    handler: async (args) => {
      const result = closeWindow(args.app as string, args.index as number)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  },
  {
    name: 'check_permissions',
    description: 'Check whether Accessibility (mouse/keyboard control) and Screen Recording (screenshots) permissions are granted.',
    schema: {},
    handler: async () => {
      const result = checkPermissions()
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  },
  {
    name: 'setup_permissions',
    description: 'Open macOS System Settings at the Accessibility and Screen Recording panes so the user can grant permissions.',
    schema: {},
    handler: async () => {
      const result = setupPermissions()
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  },
  {
    name: 'abort',
    description: 'Stop current activity. Input actions are short-lived, so in-flight actions complete within milliseconds; use this to signal the agent should stop, and Ctrl+C in the terminal stops the server entirely.',
    schema: {},
    handler: async () => {
      return { content: [{ type: 'text', text: 'Abort requested. No long-running actions were in flight. Press Ctrl+C in the terminal to stop the server.' }] }
    },
  },
]
