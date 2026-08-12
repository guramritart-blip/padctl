// Permission helper for padctl.
//
//   permissions check     report both, exit 0 only if both are granted
//   permissions request   make macOS show the real prompts, then open the panes
//
// Build: swiftc -O -o permissions permissions.swift
//
// WHO GETS THE GRANT. TCC attributes a request to the *responsible* process,
// not to whichever executable happened to call the API. padctl proves this
// already: the daemon shells out to `osascript` for every hotkey and that
// inherits the daemon's Accessibility grant rather than needing its own. So
// this helper must be spawned BY THE DAEMON, whose binary is bin/node — the
// exact path the LaunchAgent runs and the one the grant has to land on.
//
// Run it from install.sh instead and the responsible process is the user's
// terminal, so macOS would prompt for Warp or Terminal.app, grant that, and
// leave the daemon just as broken while looking like it worked. That is the
// whole reason the installer only waits for the daemon's verdict and never
// asks for anything itself.

import ApplicationServices
import Foundation
import IOKit.hid

// `prompt: true` is what raises the "would like to control this computer"
// dialog with its Open System Settings button. macOS shows it at most once per
// binary per decision — once the user has denied, later calls return false in
// silence. Nothing here can force it back, which is why `request` always opens
// the pane as well rather than trusting the dialog to appear.
func accessibilityGranted(prompt: Bool) -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
}

func inputMonitoringGranted() -> Bool {
    return IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted
}

// AppKit would drag a GUI framework into a daemon's child process for one URL
// open, so shell out the way the rest of padctl does.
func openPane(_ anchor: String) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    task.arguments = ["x-apple.systempreferences:com.apple.preference.security?\(anchor)"]
    try? task.run()
}

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "check"

switch mode {
case "request":
    // Ask for both before opening anything. If the dialogs do appear, the user
    // gets them without System Settings stealing focus first.
    let ax = accessibilityGranted(prompt: true)
    let hid = inputMonitoringGranted() ? true : IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)

    print("accessibility=\(ax ? "granted" : "denied")")
    print("input_monitoring=\(hid ? "granted" : "denied")")

    // The dialog only ever offers to open the pane; it cannot flip the switch,
    // and a second denial shows nothing at all. Opening it directly is the part
    // that always works.
    if !ax { openPane("Privacy_Accessibility") }
    if !hid { openPane("Privacy_ListenEvent") }
    exit(ax && hid ? 0 : 1)

case "check":
    let ax = accessibilityGranted(prompt: false)
    let hid = inputMonitoringGranted()
    print("accessibility=\(ax ? "granted" : "denied")")
    print("input_monitoring=\(hid ? "granted" : "denied")")
    exit(ax && hid ? 0 : 1)

default:
    FileHandle.standardError.write("usage: permissions [check|request]\n".data(using: .utf8)!)
    exit(2)
}
