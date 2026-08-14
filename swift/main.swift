import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

func fail(_ msg: String) -> Never {
    let obj: [String: Any] = ["error": msg]
    let data = try! JSONSerialization.data(withJSONObject: obj)
    print(String(data: data, encoding: .utf8)!)
    exit(1)
}

func out(_ obj: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: obj)
    print(String(data: data, encoding: .utf8)!)
}

func requirePostEventAccess() {
    if !CGPreflightPostEventAccess() {
        fail("Accessibility permission missing. Grant it to your terminal app in System Settings > Privacy & Security > Accessibility, then restart the terminal.")
    }
}

func pointArg(_ s: String, _ name: String) -> CGFloat {
    guard let v = Double(s) else { fail("invalid \(name): \(s)") }
    return CGFloat(v)
}

func displays() -> [(CGRect, CGDirectDisplayID)] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return ids.map { (CGDisplayBounds($0), $0) }
}

func mouseLocation() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
}

func post(_ ev: CGEvent) {
    ev.post(tap: .cghidEventTap)
}

func settle() {
    usleep(25_000)
}

func moveTo(_ p: CGPoint) {
    guard let ev = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) else { fail("failed to create move event") }
    post(ev)
    settle()
}

func doInfo() {
    var screens: [[String: Any]] = []
    for (bounds, id) in displays() {
        let pw = CGDisplayPixelsWide(id)
        let ph = CGDisplayPixelsHigh(id)
        let scale = bounds.width > 0 ? CGFloat(pw) / bounds.width : 1
        screens.append([
            "x": Int(round(bounds.minX)),
            "y": Int(round(bounds.minY)),
            "width": Int(round(bounds.width)),
            "height": Int(round(bounds.height)),
            "scale": round(scale * 100) / 100,
            "pixelWidth": Int(pw),
            "pixelHeight": Int(ph),
        ])
    }
    let m = mouseLocation()
    out([
        "screens": screens,
        "mouse": ["x": round(m.x * 10) / 10, "y": round(m.y * 10) / 10],
        "accessibility": CGPreflightPostEventAccess(),
        "screenRecording": CGPreflightScreenCaptureAccess(),
    ])
}

func doShot(_ path: String) async {
    if !CGPreflightScreenCaptureAccess() {
        fail("Screen Recording permission missing. Grant it to your terminal app in System Settings > Privacy & Security > Screen Recording, then restart the terminal.")
    }
    let all = displays()
    guard !all.isEmpty else { fail("no displays found") }
    var rects: [CGRect] = []
    var images: [CGImage] = []
    do {
        let content = try await SCShareableContent.current
        for (bounds, id) in all {
            guard let display = content.displays.first(where: { $0.displayID == id }) else { fail("display not found in shareable content") }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.width = Int(CGDisplayPixelsWide(id))
            config.height = Int(CGDisplayPixelsHigh(id))
            config.showsCursor = true
            guard let img = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) else {
                fail("screen capture failed. Grant Screen Recording permission to your terminal app, then restart the terminal.")
            }
            rects.append(bounds)
            images.append(img)
        }
    } catch {
        fail("screen capture failed: \(error.localizedDescription)")
    }
    let unionRect = rects.dropFirst().reduce(rects[0]) { $0.union($1) }
    let w = Int(ceil(unionRect.width))
    let h = Int(ceil(unionRect.height))
    guard let ctx = CGContext(
        data: nil,
        width: w,
        height: h,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else { fail("bitmap context creation failed") }
    for (r, img) in zip(rects, images) {
        let x = r.minX - unionRect.minX
        let yTop = r.minY - unionRect.minY
        let y = CGFloat(h) - yTop - r.height
        ctx.draw(img, in: CGRect(x: x, y: y, width: r.width, height: r.height))
    }
    guard let outImg = ctx.makeImage() else { fail("image render failed") }
    let rep = NSBitmapImageRep(cgImage: outImg)
    guard let png = rep.representation(using: .png, properties: [:]) else { fail("png encode failed") }
    do {
        try png.write(to: URL(fileURLWithPath: path))
    } catch {
        fail("failed to write screenshot: \(error.localizedDescription)")
    }
    out(["path": path, "width": w, "height": h])
}

func doMove(_ x: CGFloat, _ y: CGFloat) {
    requirePostEventAccess()
    moveTo(CGPoint(x: x, y: y))
    out(["ok": true, "x": x, "y": y])
}

func clickTypes(_ button: String) -> (CGEventType, CGEventType, CGMouseButton) {
    switch button {
    case "right": return (.rightMouseDown, .rightMouseUp, .right)
    case "center", "middle": return (.otherMouseDown, .otherMouseUp, .center)
    default: return (.leftMouseDown, .leftMouseUp, .left)
    }
}

func doClick(_ button: String, _ x: CGFloat?, _ y: CGFloat?, _ double: Bool) {
    requirePostEventAccess()
    let target = (x != nil && y != nil) ? CGPoint(x: x!, y: y!) : mouseLocation()
    moveTo(target)
    let (down, up, btn) = clickTypes(button)
    guard let evDown = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: target, mouseButton: btn),
          let evUp = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: target, mouseButton: btn) else { fail("failed to create click events") }
    evDown.setIntegerValueField(.mouseEventClickState, value: double ? 2 : 1)
    evUp.setIntegerValueField(.mouseEventClickState, value: double ? 2 : 1)
    post(evDown)
    usleep(30_000)
    post(evUp)
    settle()
    out(["ok": true, "button": button, "x": round(target.x), "y": round(target.y), "double": double])
}

func doDrag(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat, _ durationMs: Int) {
    requirePostEventAccess()
    let start = CGPoint(x: x1, y: y1)
    let end = CGPoint(x: x2, y: y2)
    moveTo(start)
    guard let evDown = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left) else { fail("failed to create drag event") }
    post(evDown)
    let steps = 15
    let stepDelay = useconds_t(max(1, durationMs) * 1000 / steps)
    for i in 1...steps {
        let t = CGFloat(i) / CGFloat(steps)
        let p = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
        guard let ev = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left) else { continue }
        post(ev)
        usleep(stepDelay)
    }
    guard let evUp = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left) else { fail("failed to create release event") }
    post(evUp)
    settle()
    out(["ok": true])
}

func doScroll(_ dx: Int32, _ dy: Int32, _ x: CGFloat?, _ y: CGFloat?) {
    requirePostEventAccess()
    if let px = x, let py = y {
        moveTo(CGPoint(x: px, y: py))
    }
    guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { fail("failed to create scroll event") }
    post(ev)
    settle()
    out(["ok": true, "dx": dx, "dy": dy])
}

let keycodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49,
    "escape": 53, "esc": 53, "delete": 51, "backspace": 51,
    "forwarddelete": 117, "left": 123, "right": 124, "up": 126, "down": 125,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
    "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31,
    "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9,
    "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22,
    "7": 26, "8": 28, "9": 25,
    "-": 27, "_": 27, "=": 24, "+": 24, "plus": 24, "minus": 27,
    "[": 33, "{": 33, "]": 30, "}": 30,
    "\\": 42, "|": 42, ";": 41, ":": 41, "'": 39, "\"": 39,
    ",": 43, "<": 43, ".": 47, ">": 47, "/": 44, "?": 44,
    "`": 50, "~": 50, "!": 18, "@": 19, "#": 20, "$": 21, "%": 23,
    "^": 22, "&": 26, "*": 28, "(": 25, ")": 29,
]

let shiftKeys: Set<String> = ["~", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "{", "}", "|", ":", "\"", "<", ">", "?"]

func parseFlags(_ parts: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for p in parts {
        switch p.lowercased() {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn", "function": flags.insert(.maskSecondaryFn)
        default: break
        }
    }
    return flags
}

func postKey(_ name: String, _ flags: CGEventFlags) {
    let lower = name.lowercased()
    guard let code = keycodes[lower] else { fail("unknown key: \(name)") }
    let effective = shiftKeys.contains(name) ? flags.union(.maskShift) : flags
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { fail("failed to create key events") }
    down.flags = effective
    up.flags = effective
    post(down)
    usleep(15_000)
    post(up)
    settle()
}

func doKey(_ name: String, _ flags: CGEventFlags) {
    requirePostEventAccess()
    postKey(name, flags)
    out(["ok": true, "key": name])
}

func doHotkey(_ combo: String) {
    requirePostEventAccess()
    let parts = combo.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
    guard parts.count >= 2 else { fail("hotkey must be like cmd+shift+4") }
    let key = parts.last!
    postKey(key, parseFlags(Array(parts.dropLast())))
    out(["ok": true, "hotkey": combo])
}

func doType(_ text: String) {
    requirePostEventAccess()
    for ch in text {
        if let code = keycodes[String(ch).lowercased()], ch.isASCII {
            let needsShift = ch.isUppercase || shiftKeys.contains(String(ch))
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { continue }
            let flags: CGEventFlags = needsShift ? .maskShift : []
            down.flags = flags
            up.flags = flags
            post(down)
            usleep(5_000)
            post(up)
            usleep(10_000)
        } else if ch == "\n" || ch == "\r" {
            postKey("return", [])
        } else if ch == "\t" {
            postKey("tab", [])
        } else if ch == " " {
            postKey("space", [])
        } else {
            fail("unsupported character for keycode typing: \(ch)")
        }
    }
    out(["ok": true, "length": text.count])
}

func run() async {
    let args = CommandLine.arguments
    guard args.count >= 2 else { fail("usage: macos-input <command> [args]") }
    let cmd = args[1]

    switch cmd {
    case "info":
        doInfo()
    case "shot":
        guard args.count >= 3 else { fail("usage: shot <path>") }
        await doShot(args[2])
    case "pos":
        requirePostEventAccess()
        let m = mouseLocation()
        out(["x": round(m.x * 10) / 10, "y": round(m.y * 10) / 10])
    case "move":
        guard args.count >= 4 else { fail("usage: move <x> <y>") }
        doMove(pointArg(args[2], "x"), pointArg(args[3], "y"))
    case "click":
        guard args.count >= 3 else { fail("usage: click <left|right|center> [x y] [double]") }
        var x: CGFloat? = nil
        var y: CGFloat? = nil
        var double = false
        if args.count >= 5 {
            x = pointArg(args[3], "x")
            y = pointArg(args[4], "y")
        }
        if args.contains("double") { double = true }
        doClick(args[2].lowercased(), x, y, double)
    case "drag":
        guard args.count >= 6 else { fail("usage: drag <x1> <y1> <x2> <y2> [duration_ms]") }
        let duration = args.count >= 7 ? Int(args[6]) ?? 300 : 300
        doDrag(pointArg(args[2], "x1"), pointArg(args[3], "y1"), pointArg(args[4], "x2"), pointArg(args[5], "y2"), duration)
    case "scroll":
        guard args.count >= 4 else { fail("usage: scroll <dx> <dy> [x y]") }
        var x: CGFloat? = nil
        var y: CGFloat? = nil
        if args.count >= 6 {
            x = pointArg(args[4], "x")
            y = pointArg(args[5], "y")
        }
        doScroll(Int32(args[2]) ?? 0, Int32(args[3]) ?? 0, x, y)
    case "key":
        guard args.count >= 3 else { fail("usage: key <name> [cmd+shift...]") }
        doKey(args[2], args.count >= 4 ? parseFlags(args[3].split(separator: "+").map { String($0) }) : [])
    case "hotkey":
        guard args.count >= 3 else { fail("usage: hotkey <combo>") }
        doHotkey(args[2...].joined(separator: " "))
    case "type":
        guard args.count >= 3 else { fail("usage: type <text>") }
        doType(args[2...].joined(separator: " "))
    default:
        fail("unknown command: \(cmd)")
    }
}

let sema = DispatchSemaphore(value: 0)
Task {
    await run()
    sema.signal()
}
sema.wait()
