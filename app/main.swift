// L1R1.app — a window around the daemon.
//
// The daemon already serves a configurator on loopback, so this doesn't
// reimplement any UI. It runs the daemon as a child, waits for the port to
// answer, and shows that page in a real window with no browser chrome.
//
// Deliberately not a rewrite: the same padctl.js runs whether you installed
// from a terminal or double-clicked this.

import AppKit
import WebKit

let PORT = 7757
let LABEL = "com.g.padctl"

// ---------------------------------------------------------------- daemon

final class Daemon {
    private var process: Process?

    /// Everything the daemon needs lives in Resources/runtime, including its own
    /// frozen copy of node. Nothing on the user's PATH is assumed.
    private var runtime: URL {
        Bundle.main.resourceURL!.appendingPathComponent("runtime")
    }

    /// Someone may already have padctl running from a terminal install. Two
    /// copies would fight over the controller, since node-hid opens it
    /// exclusively, so the existing one wins and we just show its UI.
    func alreadyRunning(completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(PORT)/api/state")!)
        request.timeoutInterval = 1.0
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { completion(ok) }
        }.resume()
    }

    func start() {
        let node = runtime.appendingPathComponent("bin/node")
        let script = runtime.appendingPathComponent("padctl.js")
        guard FileManager.default.fileExists(atPath: node.path) else {
            NSLog("L1R1: no bundled node at \(node.path)")
            return
        }

        let p = Process()
        p.executableURL = node
        p.arguments = [script.path]
        p.currentDirectoryURL = runtime
        // launchd hands a minimal PATH and so do we, plus ~/.local/bin so herdr
        // is reachable when it's installed.
        var env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        p.environment = env

        do {
            try p.run()
            process = p
        } catch {
            NSLog("L1R1: could not start the daemon: \(error)")
        }
    }

    func stop() {
        process?.terminate()
        process = nil
    }
}

// ---------------------------------------------------------------- window

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var web: WKWebView!
    private let daemon = Daemon()
    private var attempts = 0
    private var startedDaemon = false

    func applicationDidFinishLaunching(_ note: Notification) {
        buildWindow()

        daemon.alreadyRunning { [weak self] running in
            guard let self else { return }
            if !running {
                self.daemon.start()
                self.startedDaemon = true
            }
            self.waitForServer()
        }
    }

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground") // let the page's black show through
        if #available(macOS 12.0, *) { web.underPageBackgroundColor = .black }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1040, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "L1R1"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = .black
        window.appearance = NSAppearance(named: .darkAqua)
        window.minSize = NSSize(width: 720, height: 560)
        window.setFrameAutosaveName("L1R1Main")
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The daemon takes a moment to bind the port. Poll rather than sleep a
    /// fixed amount, so a fast machine doesn't stare at a blank window.
    private func waitForServer() {
        attempts += 1
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(PORT)/api/state")!)
        request.timeoutInterval = 1.0

        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            guard let self else { return }
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                if ok {
                    self.web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(PORT)/")!))
                } else if self.attempts < 25 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.waitForServer() }
                } else {
                    self.showFailure()
                }
            }
        }.resume()
    }

    private func showFailure() {
        let html = """
        <html><body style="margin:0;background:#000;color:#f4f4f4;
        font:15px -apple-system;display:flex;align-items:center;justify-content:center;height:100vh">
        <div style="max-width:30rem;padding:2rem">
        <h1 style="font-size:1.4rem;letter-spacing:-0.02em">The daemon didn't come up.</h1>
        <p style="color:#8a8a8a;line-height:1.6">Nothing is answering on port \(PORT). If you also
        installed L1R1 from a terminal, that copy may be holding the controller. Quit it and
        reopen this app.</p></div></body></html>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    // External links open in the real browser; the window is for the config UI.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.host != "127.0.0.1", url.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ note: Notification) {
        // Only stop what we started. A terminal install's daemon is not ours to kill.
        if startedDaemon { daemon.stop() }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
