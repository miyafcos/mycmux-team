// App-local event identity trial. --synthetic never posts global input.
import AppKit

let synthetic = CommandLine.arguments.contains("--synthetic")
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let source = NSWindow(contentRect: NSRect(x: 100, y: 180, width: 480, height: 320),
                      styleMask: [.borderless], backing: .buffered, defer: false)
let moving = NSWindow(contentRect: NSRect(x: 650, y: 180, width: 320, height: 240),
                      styleMask: [.borderless], backing: .buffered, defer: false)
source.isReleasedWhenClosed = false
moving.isReleasedWhenClosed = false
var captured: NSEvent?
var completed = false
func record(_ event: String, _ fields: [String: Any]) {
    var row = fields
    row["event"] = event
    row["synthetic"] = synthetic
    print(String(data: try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), encoding: .utf8)!)
    fflush(stdout)
}
let monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { event in
    captured = event.type == .leftMouseDown ? event : nil
    return event
}
final class TrialView: NSView {
    override func mouseDown(with event: NSEvent) {
        let received = event
        let identity = captured === received
        // The original object remains alive across the asynchronous lift.
        Timer.scheduledTimer(withTimeInterval: 0.05, repeats: false) { _ in
            let before = moving.frame.origin
            let began = ProcessInfo.processInfo.systemUptime
            moving.performDrag(with: received)
            record("original_down_handoff", [
                "same_event_object": identity,
                "same_event_number": captured?.eventNumber == received.eventNumber,
                "event_type": received.type.rawValue,
                "source_window_matches": received.windowNumber == source.windowNumber,
                "physical_button_held": NSEvent.pressedMouseButtons & 1 != 0,
                "call_ms": (ProcessInfo.processInfo.systemUptime - began) * 1000,
                "event_age_ms": (began - received.timestamp) * 1000,
                "frame_changed_during_call": before != moving.frame.origin
            ])
            completed = true
            if synthetic {
                source.orderOut(nil); moving.orderOut(nil)
                if let monitor = monitor { NSEvent.removeMonitor(monitor) }
                exit(identity ? 0 : 2)
            }
        }
    }
}
let view = TrialView(frame: source.contentView!.bounds)
source.contentView = view
let label = NSTextField(labelWithString: "M1: hold the mouse here and drag. Original event goes to WindowServer.")
label.frame = NSRect(x: 15, y: 140, width: 450, height: 60)
label.isSelectable = false
view.addSubview(label)
source.orderFront(nil); moving.orderFront(nil)
if synthetic {
    Timer.scheduledTimer(withTimeInterval: 0.2, repeats: false) { _ in
        let down = NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: 20, y: 250),
            modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: source.windowNumber, context: nil, eventNumber: 17, clickCount: 1, pressure: 1)!
        app.postEvent(down, atStart: false)
    }
}
Timer.scheduledTimer(withTimeInterval: synthetic ? 8 : 120, repeats: false) { _ in
    record("complete", ["handoff_called": completed])
    source.orderOut(nil); moving.orderOut(nil)
    if let monitor = monitor { NSEvent.removeMonitor(monitor) }
    exit(completed ? 0 : 1)
}
app.run()
