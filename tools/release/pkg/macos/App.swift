// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// "Bitcoin Arena.app" (the owner's playtest 2026-10-25: "make this more pretty, not just a select. It should look like a real app with the
// options" - and "clicking Close seems to restart the app, it never closes/quits, Command+Q doesn't do anything"): one window, a native
// AppKit app. While the installer runs: what it does, with a progress bar and the setup page's link. With a node installed: its state as a
// coloured dot and a line, and big buttons - Dashboard, Owner page, Stop or Start node, Doctor (its report in the window). An app that
// carries a newer release than the node runs updates the node first. Closing the window quits the app; Cmd+Q quits it (asking first while
// the installer still runs). Every step is the helper bitcoin-arena-app beside it (Contents/Resources), as the applet's were.
import AppKit

final class Helper {
  static let path = (Bundle.main.resourcePath ?? ".") + "/bitcoin-arena-app"
  /// Runs the helper with one command off the main thread; answers its output (trimmed) and whether it exited 0.
  static func run(_ args: [String], done: @escaping (String, Bool) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async {
      let p = Process()
      p.executableURL = URL(fileURLWithPath: path)
      p.arguments = args
      var env = ProcessInfo.processInfo.environment
      env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
      p.environment = env
      let out = Pipe(); p.standardOutput = out; p.standardError = out
      var text = "", ok = false
      do {
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        text = String(data: data, encoding: .utf8) ?? ""
        ok = p.terminationStatus == 0
      } catch { text = error.localizedDescription }
      let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
      DispatchQueue.main.async { done(t, ok) }
    }
  }
  /// The same, each line of its output handed to `line` on the main thread as it comes (the update's progress lines, kanban #706).
  static func stream(_ args: [String], line: @escaping (String) -> Void, done: @escaping (String, Bool) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async {
      let p = Process()
      p.executableURL = URL(fileURLWithPath: path)
      p.arguments = args
      var env = ProcessInfo.processInfo.environment
      env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
      p.environment = env
      let out = Pipe(); p.standardOutput = out; p.standardError = out
      var text = "", ok = false, buf = Data()
      do {
        try p.run()
        let h = out.fileHandleForReading
        while true {
          let d = h.availableData
          if d.isEmpty { break }
          buf.append(d)
          while let i = buf.firstIndex(of: 10) {
            let l = String(data: buf.subdata(in: buf.startIndex..<i), encoding: .utf8) ?? ""
            buf = buf.subdata(in: buf.index(after: i)..<buf.endIndex)
            text += l + "\n"
            DispatchQueue.main.async { line(l) }
          }
        }
        text += String(data: buf, encoding: .utf8) ?? ""
        p.waitUntilExit()
        ok = p.terminationStatus == 0
      } catch { text = error.localizedDescription }
      let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
      DispatchQueue.main.async { done(t, ok) }
    }
  }
  /// A progress line read: "[#####-----]  45 %  Unpacking 2026.1.9.9" is (45, "Unpacking 2026.1.9.9"); any other line nil.
  static func progress(_ l: String) -> (Double, String)? {
    guard l.hasPrefix("["), let close = l.firstIndex(of: "]"), let mark = l.range(of: " %", options: [], range: close..<l.endIndex),
      let pct = Double(l[l.index(after: close)..<mark.lowerBound].trimmingCharacters(in: .whitespaces)) else { return nil }
    return (pct, l[mark.upperBound...].trimmingCharacters(in: .whitespaces))
  }
}

final class Controller: NSObject, NSApplicationDelegate, NSWindowDelegate {
  var window: NSWindow!
  let dot = NSView()
  let heading = NSTextField(labelWithString: "Starting Bitcoin Arena…")
  let detail = NSTextField(wrappingLabelWithString: "")
  let progress = NSProgressIndicator()
  let buttons = NSStackView()
  let report = NSTextView()
  var reportScroll: NSScrollView!
  var installing = false, link = "", timer: Timer?, waited = 0

  func applicationDidFinishLaunching(_ n: Notification) {
    buildMenu()
    buildWindow()
    NSApp.activate(ignoringOtherApps: true)
    // ARENA_APP_SNAPSHOT=<png> [ARENA_APP_SNAPSHOT_AFTER=<s>]: the window saved as an image and the app quit (tests, screenshots)
    if let shot = ProcessInfo.processInfo.environment["ARENA_APP_SNAPSHOT"] {
      let after = Double(ProcessInfo.processInfo.environment["ARENA_APP_SNAPSHOT_AFTER"] ?? "") ?? 8
      DispatchQueue.main.asyncAfter(deadline: .now() + after) {
        if let v = self.window.contentView, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
          v.cacheDisplay(in: v.bounds, to: rep)
          try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: shot))
        }
        self.installing = false; NSApp.terminate(nil)
      }
    }
    phase("Starting Bitcoin Arena…", "Preparing your node. The first start copies it out of the app, which takes up to a minute.", busy: true)
    Helper.run(["prepare"]) { out, ok in
      if !ok { return self.failed(out) }
      if out == "installed" { return self.updateThenStatus() }
      if out.hasPrefix("running ") { self.link = String(out.dropFirst(8)); return self.installer(opened: true) }
      self.launchInstaller()
    }
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
  func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows: Bool) -> Bool { window.makeKeyAndOrderFront(nil); return true }
  func applicationShouldTerminate(_ s: NSApplication) -> NSApplication.TerminateReply {
    if !installing { return .terminateNow }
    let a = NSAlert()
    a.messageText = "The installer still runs"
    a.informativeText = "Stop it, or let it finish in the background?"
    a.addButton(withTitle: "Keep it running"); a.addButton(withTitle: "Stop it"); a.addButton(withTitle: "Cancel")
    switch a.runModal() {
    case .alertFirstButtonReturn: return .terminateNow
    case .alertSecondButtonReturn: Helper.run(["stop"]) { _, _ in NSApp.reply(toApplicationShouldTerminate: true) }; return .terminateLater
    default: return .terminateCancel
    }
  }

  // MARK: the window
  func buildMenu() {
    let main = NSMenu(), appItem = NSMenuItem(); main.addItem(appItem)
    let m = NSMenu()
    m.addItem(withTitle: "Quit Bitcoin Arena", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = m
    let editItem = NSMenuItem(); main.addItem(editItem)
    let e = NSMenu(title: "Edit"); e.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    e.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"); editItem.submenu = e
    let winItem = NSMenuItem(); main.addItem(winItem)
    let w = NSMenu(title: "Window"); w.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"); winItem.submenu = w
    NSApp.mainMenu = main
  }
  func buildWindow() {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 420), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    window.title = "Bitcoin Arena"; window.delegate = self; window.isReleasedWhenClosed = false
    let icon = NSImageView(image: NSApp.applicationIconImage); icon.imageScaling = .scaleProportionallyUpOrDown
    icon.widthAnchor.constraint(equalToConstant: 56).isActive = true; icon.heightAnchor.constraint(equalToConstant: 56).isActive = true
    let name = NSTextField(labelWithString: "Bitcoin Arena"); name.font = .systemFont(ofSize: 20, weight: .bold)
    let version = NSTextField(labelWithString: "Node \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")")
    version.textColor = .secondaryLabelColor
    let names = NSStackView(views: [name, version]); names.orientation = .vertical; names.alignment = .leading; names.spacing = 2
    let top = NSStackView(views: [icon, names]); top.spacing = 14
    dot.wantsLayer = true; dot.layer?.cornerRadius = 6; dot.layer?.backgroundColor = NSColor.systemGray.cgColor
    dot.widthAnchor.constraint(equalToConstant: 12).isActive = true; dot.heightAnchor.constraint(equalToConstant: 12).isActive = true
    heading.font = .systemFont(ofSize: 16, weight: .semibold)
    let state = NSStackView(views: [dot, heading]); state.spacing = 8
    detail.textColor = .secondaryLabelColor; detail.preferredMaxLayoutWidth = 500
    progress.style = .bar; progress.isIndeterminate = true; progress.controlSize = .regular
    buttons.orientation = .vertical; buttons.alignment = .leading; buttons.spacing = 10
    reportScroll = NSTextView.scrollableTextView(); report.isEditable = false
    if let tv = reportScroll.documentView as? NSTextView { tv.isEditable = false; tv.font = .monospacedSystemFont(ofSize: 11, weight: .regular) }
    reportScroll.heightAnchor.constraint(equalToConstant: 140).isActive = true; reportScroll.isHidden = true
    let col = NSStackView(views: [top, state, detail, progress, buttons, reportScroll])
    col.orientation = .vertical; col.alignment = .leading; col.spacing = 14
    col.edgeInsets = NSEdgeInsets(top: 22, left: 24, bottom: 22, right: 24)
    for v in [detail, progress, reportScroll!] as [NSView] { v.translatesAutoresizingMaskIntoConstraints = false; v.widthAnchor.constraint(equalTo: col.widthAnchor, constant: -48).isActive = true }
    col.wantsLayer = true; col.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor   // also what a snapshot shows
    window.contentView = col
    window.center(); window.makeKeyAndOrderFront(nil)
  }
  func big(_ title: String, _ symbol: String, _ action: Selector, primary: Bool = false) -> NSButton {
    let b = NSButton(title: title, target: self, action: action)
    b.bezelStyle = .rounded; b.controlSize = .large; b.font = .systemFont(ofSize: 14, weight: .medium)
    if let img = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) { b.image = img; b.imagePosition = .imageLeading }
    if primary { b.keyEquivalent = "\r" }
    b.widthAnchor.constraint(equalToConstant: 200).isActive = true
    return b
  }
  func setButtons(_ rows: [[NSButton]]) {
    buttons.arrangedSubviews.forEach { $0.removeFromSuperview() }
    for r in rows { let h = NSStackView(views: r); h.spacing = 10; buttons.addArrangedSubview(h) }
    fit()
  }
  /// The window as tall as what it shows (a status, a progress, Doctor's report), never shorter than its start.
  func fit() {
    guard let v = window.contentView else { return }
    v.layoutSubtreeIfNeeded()
    let h = max(260, v.fittingSize.height)
    var f = window.frame; let ch = window.contentRect(forFrameRect: f).height
    f.origin.y += ch - h; f.size.height += h - ch
    window.setFrame(f, display: true, animate: false)
  }
  func phase(_ h: String, _ d: String, busy: Bool, color: NSColor = .systemOrange) {
    heading.stringValue = h; detail.stringValue = d
    dot.layer?.backgroundColor = color.cgColor
    progress.isIndeterminate = true
    progress.isHidden = !busy; if busy { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
    fit()
  }
  /// The bar at `pct` of 100, with what it does under the heading (an update's real progress, kanban #706).
  func step(_ pct: Double, _ text: String) {
    if progress.isIndeterminate { progress.stopAnimation(nil); progress.isIndeterminate = false; progress.minValue = 0; progress.maxValue = 100 }
    progress.isHidden = false; progress.doubleValue = pct
    detail.stringValue = "\(Int(pct)) %  \(text)"
  }
  func failed(_ why: String) {
    installing = false
    phase("Something went wrong", why.isEmpty ? "The helper did not answer." : why, busy: false, color: .systemRed)
    setButtons([[big("Close", "xmark.circle", #selector(quit))]])
  }

  // MARK: the installer
  func launchInstaller() {
    phase("Starting the installer…", "Its setup page opens in your browser in a few seconds.", busy: true)
    Helper.run(["launch"]) { out, ok in
      if !ok { return self.failed(out) }
      self.waited = 0; self.installing = true
      self.timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in self.waitLink() }
    }
  }
  func waitLink() {
    waited += 1
    Helper.run(["wait-link"]) { out, ok in
      if !ok { self.timer?.invalidate(); return self.failed(out) }
      if out != "waiting" { self.timer?.invalidate(); self.link = out; return self.installer(opened: false) }
      if self.waited > 60 { self.timer?.invalidate(); Helper.run(["stop"]) { _, _ in }; self.failed("The installer did not start within a minute. Open Bitcoin Arena again; if it happens again, run Doctor.") }
      else { self.detail.stringValue = "Its setup page opens in your browser in a few seconds. (\(self.waited) s)" }
    }
  }
  func installer(opened: Bool) {
    installing = true
    if !link.isEmpty, let u = URL(string: link) { NSWorkspace.shared.open(u) }
    phase("The installer runs", "Its setup page is open in your browser. Keep this app open until the page says Done; it then shows your node here.", busy: true)
    setButtons([[big("Open setup page", "safari", #selector(openSetup), primary: true), big("Stop installer", "stop.circle", #selector(stopInstaller))]])
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
      Helper.run(["state"]) { out, _ in
        if out == "done" { self.timer?.invalidate(); self.installing = false; self.status() }
        else if out.hasPrefix("ended") { self.timer?.invalidate(); self.failed("The installer ended: " + String(out.dropFirst(6))) }
      }
    }
  }
  @objc func openSetup() { Helper.run(["link"]) { out, _ in if let u = URL(string: out.isEmpty ? self.link : out) { NSWorkspace.shared.open(u) } } }
  @objc func stopInstaller() {
    Helper.run(["stop"]) { _, _ in self.installing = false; self.timer?.invalidate(); self.phase("The installer was stopped", "Open Bitcoin Arena again to start it.", busy: false, color: .systemGray)
      self.setButtons([[self.big("Close", "xmark.circle", #selector(self.quit))]]) }
  }

  // MARK: the installed node
  func updateThenStatus() {
    Helper.run(["newer"]) { out, _ in
      let parts = out.split(separator: " ").map(String.init)
      if parts.count < 2 { return self.status() }
      // THE UPDATE'S OWN PROGRESS (kanban #706, the owner's screenshot: "Updating your node..." over a bar that meant nothing): each
      // progress line the update prints moves the bar and says the step; its last other line is the result
      self.phase("Updating your node to \(parts[parts.count - 1])…", "From \(parts[0]) to \(parts[parts.count - 1]).", busy: true)
      Helper.stream(["update"], line: { l in
        if let p = Helper.progress(l) { self.step(p.0, p.1) }
      }) { out, _ in
        let u = out.split(separator: "\n").map(String.init).last(where: { !$0.hasPrefix("[") }) ?? ""
        if !u.hasPrefix("Updated") && !u.hasPrefix("Up to date") { self.status(note: "Your node was not updated: " + (u.isEmpty ? "the update said nothing." : u)) } else { self.status() }
        // the owner page signed in once after the update (2026-10-26: "The updater MUST fix my credentials in the browser so it works")
        if u.hasPrefix("Updated") { Helper.run(["signin"]) { _, _ in } }
      }
    }
  }
  func status(note: String? = nil) {
    phase("Checking your node…", note ?? "", busy: true, color: .systemGray)
    Helper.run(["node"]) { line, _ in
      let running = line.hasPrefix("running")
      // "running; not running: X, Y" read as "Not running: X, Y"; a plain "running" as a sentence
      var d = running ? "Your node runs and serves the network." : "Your node does not run."
      if let r = line.range(of: "not running: ") { d = "Not running: " + line[r.upperBound...] }
      else if line.hasPrefix("stopped: ") { d = "Stopped: " + line.dropFirst(9) }
      if let n = note { d = n + "\n" + d }
      self.phase(running ? "Server running" : "Server stopped", d, busy: false, color: running ? .systemGreen : .systemRed)
      self.setButtons([[self.big("Open Dashboard", "chart.bar.xaxis", #selector(self.dashboard), primary: true), self.big("Owner page", "person.crop.circle", #selector(self.owner))],
        [running ? self.big("Stop node", "stop.circle", #selector(self.stopNode)) : self.big("Start node", "play.circle", #selector(self.startNode)), self.big("Doctor", "stethoscope", #selector(self.doctor))]])
      self.timer?.invalidate()
      self.timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { _ in self.status() }
    }
  }
  @objc func dashboard() { Helper.run(["dashboard"]) { _, _ in } }
  @objc func owner() { Helper.run(["owner"]) { _, _ in } }
  @objc func stopNode() {
    let a = NSAlert(); a.messageText = "Stop your node?"; a.informativeText = "It stops serving rounds until you start it again."
    a.addButton(withTitle: "Stop node"); a.addButton(withTitle: "Cancel")
    guard a.runModal() == .alertFirstButtonReturn else { return }
    phase("Stopping your node…", "", busy: true); Helper.run(["node-stop"]) { _, _ in self.status() }
  }
  @objc func startNode() { phase("Starting your node…", "", busy: true); Helper.run(["node-start"]) { _, _ in self.status() } }
  @objc func doctor() {
    reportScroll.isHidden = false
    (reportScroll.documentView as? NSTextView)?.string = "Checking every service…"
    fit()
    Helper.run(["doctor"]) { out, _ in (self.reportScroll.documentView as? NSTextView)?.string = out }
  }
  @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let controller = Controller()
app.delegate = controller
app.setActivationPolicy(.regular)
app.run()
