// Resident mouse driver for padctl.
//
// padctl streams commands on stdin rather than spawning a process per frame,
// which is what makes the motion smooth instead of stuttering at ~60Hz.
//
//   m <dx> <dy>     move pointer by a delta
//   s <dx> <dy>     scroll by a delta
//   c <left|right>  click at the current position
//   d <left|right>  press and hold, so movement becomes a drag
//   u <left|right>  release a held button
//
// Build: swiftc -O -o mousehelper mousehelper.swift

import CoreGraphics
import Foundation

func currentPointer() -> CGPoint {
    // A null-source event carries the current cursor location.
    return CGEvent(source: nil)?.location ?? .zero
}

func clamp(_ p: CGPoint) -> CGPoint {
    // Keep the pointer on-screen. Union every display so multi-monitor works.
    var bounds = CGRect.null
    for screen in NSScreenFrames() {
        bounds = bounds.union(screen)
    }
    if bounds.isNull { return p }
    return CGPoint(
        x: min(max(p.x, bounds.minX), bounds.maxX - 1),
        y: min(max(p.y, bounds.minY), bounds.maxY - 1)
    )
}

// CoreGraphics-only display enumeration, so this stays free of AppKit.
func NSScreenFrames() -> [CGRect] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    guard count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return ids.map { CGDisplayBounds($0) }
}

// Whichever button `d` pressed, until `u` releases it.
var held: CGMouseButton? = nil

func move(dx: Double, dy: Double) {
    let target = clamp(CGPoint(x: currentPointer().x + dx, y: currentPointer().y + dy))
    // While a button is down the movement must be a *Dragged* event. Posting
    // plain .mouseMoved instead leaves Finder, tab bars and most drag targets
    // convinced nothing is being dragged, even though the button really is down.
    let type: CGEventType =
        held == .right ? .rightMouseDragged : (held == .left ? .leftMouseDragged : .mouseMoved)
    CGEvent(
        mouseEventSource: nil,
        mouseType: type,
        mouseCursorPosition: target,
        mouseButton: held ?? .left
    )?.post(tap: .cghidEventTap)
}

// Pixel units give smooth continuous scrolling rather than notched line jumps.
func scroll(dx: Double, dy: Double) {
    CGEvent(
        scrollWheelEvent2Source: nil,
        units: .pixel,
        wheelCount: 2,
        wheel1: Int32(dy),
        wheel2: Int32(dx),
        wheel3: 0
    )?.post(tap: .cghidEventTap)
}

func click(_ button: String) {
    let at = currentPointer()
    let (down, up, btn): (CGEventType, CGEventType, CGMouseButton) =
        button == "right"
        ? (.rightMouseDown, .rightMouseUp, .right)
        : (.leftMouseDown, .leftMouseUp, .left)

    for type in [down, up] {
        CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: at, mouseButton: btn)?
            .post(tap: .cghidEventTap)
    }
}

func setButton(_ button: String, down: Bool) {
    let at = currentPointer()
    let btn: CGMouseButton = button == "right" ? .right : .left
    let type: CGEventType =
        btn == .right
        ? (down ? .rightMouseDown : .rightMouseUp)
        : (down ? .leftMouseDown : .leftMouseUp)

    held = down ? btn : nil
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: at, mouseButton: btn)?
        .post(tap: .cghidEventTap)
}

while let line = readLine(strippingNewline: true) {
    let parts = line.split(separator: " ")
    guard let verb = parts.first else { continue }

    switch verb {
    case "m" where parts.count == 3:
        if let dx = Double(parts[1]), let dy = Double(parts[2]) { move(dx: dx, dy: dy) }
    case "s" where parts.count == 3:
        if let dx = Double(parts[1]), let dy = Double(parts[2]) { scroll(dx: dx, dy: dy) }
    case "c" where parts.count == 2:
        click(String(parts[1]))
    case "d" where parts.count == 2:
        setButton(String(parts[1]), down: true)
    case "u" where parts.count == 2:
        setButton(String(parts[1]), down: false)
    default:
        continue
    }
}
