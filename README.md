# computeruse

MCP server that gives AI agents (Claude Code, Codex CLI, Cursor, any MCP client) vision and control of your macOS computer: screenshots, mouse, keyboard, clipboard, and window management. Modeled on Codex Computer Use.

## Requirements

- macOS 14+
- Xcode Command Line Tools (`xcode-select --install`)
- Node.js 20+

## Install

```sh
npm install
npm run build
```

## Grant permissions

Control and capture need two macOS permissions granted to **your terminal app** (iTerm2, Terminal.app, etc.), not to this project:

1. **Accessibility** — mouse and keyboard control
2. **Screen Recording** — screenshots

Open them with:

```sh
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
```

Enable your terminal app under both, then **restart the terminal**. Agents can verify with the `check_permissions` tool (or `setup_permissions` to reopen the panes).

## Connect agents

### Claude Code

Project scope (repo already has `.mcp.json`):

```sh
claude mcp add computeruse -- node /absolute/path/to/computeruse/dist/index.js
```

Or rely on the checked-in `.mcp.json` for project-scoped use. Then verify:

```sh
claude mcp list
```

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.computeruse]
command = "node"
args = ["/absolute/path/to/computeruse/dist/index.js"]
```

### Other clients (Cursor, Claude Desktop, etc.)

Point them at `node /absolute/path/to/computeruse/dist/index.js` (stdio transport).

## Tools

| Tool | Description |
| --- | --- |
| `screenshot` | Capture all displays as PNG; image coordinates map 1:1 to mouse coordinates |
| `get_screen_info` | Display layout, mouse position, permission status |
| `get_mouse_position` | Current cursor position |
| `mouse_move`, `mouse_click`, `mouse_drag`, `mouse_scroll` | Mouse control (left/right/center, double click) |
| `key_press`, `hotkey` | Keys like `return`, `f5`, combos like `cmd+shift+4` |
| `type_text` | Unicode-safe typing via clipboard paste |
| `get_clipboard`, `set_clipboard` | Clipboard access |
| `open_app`, `list_windows`, `get_active_window`, `focus_window`, `resize_window`, `close_window` | App and window management |
| `check_permissions`, `setup_permissions` | Permission status and setup |
| `abort` | Stop current activity |

## Coordinates

Models receive screenshots resized by the API, so pixel coordinates the model estimates would not match the real screen. `computeruse` handles this for you:

- `screenshot` scales the image so its long edge is at most 1568px (the model's standard vision limit, overridable with `COMPUTERUSE_MAX_IMAGE_EDGE`). The model sees exactly the pixels it computes coordinates on.
- Every coordinate-based tool (`mouse_move`, `mouse_click`, `mouse_drag`, `mouse_scroll`, `get_mouse_position`, `get_screen_info`, `list_windows`, `get_active_window`, `resize_window`) works in the pixel space of the most recent screenshot and converts to real screen coordinates internally.
- If no screenshot has been taken yet, coordinates map 1:1 to the screen.

## Safety

- Claude Code and Codex CLI prompt for approval on every tool call. Do not allowlist these tools globally.
- Input events flow through a native CoreGraphics helper; stopping the agent or the MCP server stops input immediately.
- `type_text` temporarily uses the clipboard and restores it afterwards.
- Screen contents are sent to the model. Close sensitive apps before asking agents to work on the screen.

## Development

```sh
npm run build        # tsc + compile the Swift input helper
npm run typecheck
node test/run.mjs    # end-to-end MCP test suite (needs permissions for input/screenshot tests)
```

The Swift helper (`swift/main.swift`, compiled to `bin/macos-input`) uses CoreGraphics `CGEvent` for input and ScreenCaptureKit for capture, compositing all displays into one image at 1 point = 1 pixel so agent coordinates always match screenshot pixels.

## Architecture

```
MCP client (Claude Code, Codex, ...)
        | stdio JSON-RPC
src/index.ts            MCP server, tool registry
src/tools.ts            tool schemas + handlers
src/screen.ts           screenshot via helper (ScreenCaptureKit), sips downscale
src/input.ts            mouse/keyboard via helper, paste-based typing
src/clipboard.ts        pbcopy / pbpaste
src/windows.ts          osascript System Events
src/permissions.ts      AX / Screen Recording checks
bin/macos-input         compiled Swift CGEvent + ScreenCaptureKit helper
```
