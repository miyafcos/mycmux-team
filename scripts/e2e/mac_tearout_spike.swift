// App-local synthetic events only. Never posts a CGEvent or moves the pointer.
import AppKit
import WebKit

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let receiver = NSWindow(contentRect: NSRect(x: 120, y: 180, width: 480, height: 320),
                        styleMask: [.borderless], backing: .buffered, defer: false)
let moving = NSWindow(contentRect: NSRect(x: 700, y: 180, width: 320, height: 240),
                      styleMask: [.borderless], backing: .buffered, defer: false)
receiver.isReleasedWhenClosed = false
moving.isReleasedWhenClosed = false
let web = WKWebView(frame: moving.contentView!.bounds)
moving.contentView!.addSubview(web)
web.loadHTMLString("<script>window.framesSeen=0;function frame(){framesSeen++;requestAnimationFrame(frame)}requestAnimationFrame(frame)</script>", baseURL: nil)
moving.orderFront(nil)
var reports: [[String: Any]] = []
func report(_ kind: String, _ fields: [String: Any]) {
    var row = fields
    row["event"] = kind
    reports.append(row)
    print(String(data: try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), encoding: .utf8)!)
    fflush(stdout)
}
func later(_ seconds: Double, _ action: @escaping () -> Void) {
    Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in action() }
}
func eval(_ event: String, _ finish: @escaping () -> Void) {
    web.evaluateJavaScript("({frames:framesSeen,visibility:document.visibilityState})") { value, error in
        report(event, ["value": value ?? NSNull(), "error": error.map { String(describing: $0) } ?? ""])
        finish()
    }
}
later(2.0) {
    eval("before_hide") {
      moving.orderOut(nil)
      later(1.0) {
       eval("hidden_raf") {
        receiver.orderFront(nil)
        moving.orderFront(nil)
        later(0.6) {
            eval("visible_raf") {
                let point = NSPoint(x: 180, y: 240)
                let before = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: moving.windowNumber)
                moving.alphaValue = 0.5
                let after = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: moving.windowNumber)
                report("alpha_hit", ["alpha": moving.alphaValue, "receiver": receiver.windowNumber, "before": before, "after": after])
                let start = moving.frame.origin
                // These are queued only to this application. No physical mouse is held.
                let down = NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: 20, y: 220),
                    modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: receiver.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
                let up = NSEvent.mouseEvent(with: .leftMouseUp, location: NSPoint(x: 100, y: 200),
                    modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime + 0.02,
                    windowNumber: receiver.windowNumber, context: nil, eventNumber: 2, clickCount: 1, pressure: 0)!
                application.postEvent(up, atStart: false)
                let clock = Date()
                moving.performDrag(with: down)
                report("perform_drag", ["elapsed_ms": Date().timeIntervalSince(clock) * 1000,
                    "moved": moving.frame.origin != start, "physical_button_held": NSEvent.pressedMouseButtons & 1 != 0,
                    "frame_x": moving.frame.origin.x, "frame_y": moving.frame.origin.y])
                // Native AppKit frame movement remains nonmodal and cancellable.
                let monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                    if event.keyCode == 53 {
                        moving.setFrameOrigin(start)
                        report("esc_restore", ["restored": moving.frame.origin == start])
                        return nil
                    }
                    return event
                }
                moving.setFrameOrigin(NSPoint(x: start.x + 80, y: start.y + 20))
                report("native_frame_move", ["moved": moving.frame.origin != start, "alpha": moving.alphaValue])
                let esc = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: moving.windowNumber,
                    context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!
                application.postEvent(esc, atStart: false)
                later(0.2) {
                    if let monitor = monitor { NSEvent.removeMonitor(monitor) }
                    moving.alphaValue = 1
                    moving.orderOut(nil)
                    receiver.orderOut(nil)
                    report("complete", ["restored": moving.frame.origin == start, "focus": application.isActive])
                    exit(0)
                }
            }
        }
       }
      }
    }
}
later(15) { report("timeout", [:]); exit(1) }
application.run()
