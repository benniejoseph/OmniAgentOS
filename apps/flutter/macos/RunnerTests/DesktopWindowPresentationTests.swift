import AppKit
#if !WINDOW_PRESENTATION_TESTS
import XCTest
@testable import omniagent
#endif

private enum WindowPresentationError: Error { case failed(String) }
private func checkWindow(_ value: @autoclosure () -> Bool, _ detail: String) throws {
  if !value() { throw WindowPresentationError.failed(detail) }
}

private enum WindowPresentationCases {
  static func window() -> NSWindow {
    _ = NSApplication.shared
    let window = NSWindow(contentRect: NSRect(x: 100, y: 140, width: 1_160, height: 750),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.contentView = NSView(frame: window.contentLayoutRect)
    configureAsaelWindowChrome(window, role: .main)
    return window
  }

  static func normal(_ window: NSWindow, frame: NSRect) throws {
    try checkWindow(window.frame == frame, "The original workspace frame was lost: expected \(frame), observed \(window.frame)")
    try checkWindow(window.styleMask.contains([.titled, .closable, .miniaturizable, .resizable]), "Native window controls or resizing are unavailable")
    try checkWindow(!window.styleMask.contains(.fullSizeContentView), "Workspace content remains underneath the title bar")
    try checkWindow(window.isOpaque && window.hasShadow && !window.isMovableByWindowBackground, "Voice window appearance leaked into the workspace")
    try checkWindow(window.level == .normal && !window.collectionBehavior.contains(.fullScreenAuxiliary), "Workspace remains a floating voice panel")
    try checkWindow(window.minSize == DesktopWindowPresentation.regularMinimumSize, "Workspace minimum size was not restored")
    try checkWindow((window.contentView?.layer?.cornerRadius ?? 0) == 0 && window.contentView?.layer?.masksToBounds != true, "Workspace is still clipped by the voice mask")
    for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
      try checkWindow(window.standardWindowButton(type)?.isHidden == false, "A native title bar control remains hidden")
      try checkWindow(window.standardWindowButton(type)?.isEnabled == true, "A native title bar control remains disabled")
    }
  }

  static func voiceEndAndRepeat() throws {
    let window = window(), presentation = DesktopWindowPresentation()
    defer { window.close() }
    let original = window.frame
    for appearance in ["companion", "perch", "companion"] {
      presentation.prepareVoice(window, size: NSSize(width: 400, height: 280), appearance: appearance)
      window.setFrame(NSRect(x: 400, y: 100, width: 400, height: 280), display: false)
      try checkWindow(!window.styleMask.contains(.resizable), "Voice fixture was not compacted")
      try checkWindow(window.standardWindowButton(.miniaturizeButton)?.isHidden == true, "Voice fixture did not hide native controls")
      presentation.restoreMain(window)
      try normal(window, frame: original)
      presentation.restoreMain(window)
      try normal(window, frame: original)
    }
  }

  static func appearanceAndQuickEntryHandoffs() throws {
    for voiceFirst in [true, false] {
      let window = window(), presentation = DesktopWindowPresentation()
      defer { window.close() }
      let original = window.frame
      if !voiceFirst {
        presentation.prepareQuickEntry(window, minimumSize: NSSize(width: 600, height: 400))
        window.setFrame(NSRect(x: 200, y: 200, width: 650, height: 450), display: false)
      }
      for size in [NSSize(width: 360, height: 108), NSSize(width: 560, height: 680), NSSize(width: 300, height: 256)] {
        presentation.prepareVoice(window, size: size, appearance: "perch")
        window.setFrame(NSRect(origin: NSPoint(x: 300, y: 100), size: size), display: false)
      }
      if voiceFirst {
        presentation.prepareQuickEntry(window, minimumSize: NSSize(width: 600, height: 400))
        window.setFrame(NSRect(x: 200, y: 200, width: 650, height: 450), display: false)
        try checkWindow(window.standardWindowButton(.miniaturizeButton)?.isHidden == false, "Quick Entry inherited the hidden voice controls")
      }
      presentation.restoreMain(window)
      try normal(window, frame: original)
    }
  }

  static func interruptedAnimation() throws {
    let window = window(), presentation = DesktopWindowPresentation()
    defer { window.close() }
    let original = window.frame
    presentation.prepareVoice(window, size: NSSize(width: 400, height: 280), appearance: "companion")
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.1
      window.animator().setFrame(NSRect(x: 400, y: 100, width: 400, height: 280), display: false)
    }
    presentation.restoreMain(window)
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    try normal(window, frame: original)
  }

  static func recoveryWithoutSavedFrame() throws {
    let window = window(), presentation = DesktopWindowPresentation()
    defer { window.close() }
    window.styleMask.remove(.resizable)
    window.styleMask.insert(.fullSizeContentView)
    window.standardWindowButton(.miniaturizeButton)?.isHidden = true
    window.setFrame(NSRect(x: 100, y: 100, width: 360, height: 280), display: false)
    presentation.restoreMain(window)
    try normal(window, frame: NSRect(x: 100, y: 100, width: 1_024, height: 700))
  }
}

#if WINDOW_PRESENTATION_TESTS
@main
private enum WindowPresentationRunner {
  static func main() throws {
    try WindowPresentationCases.voiceEndAndRepeat()
    try WindowPresentationCases.appearanceAndQuickEntryHandoffs()
    try WindowPresentationCases.interruptedAnimation()
    try WindowPresentationCases.recoveryWithoutSavedFrame()
    print("Desktop window presentation cases passed (4)")
  }
}
#else
final class DesktopWindowPresentationTests: XCTestCase {
  private func onMain(_ operation: () throws -> Void) rethrows {
    if Thread.isMainThread { try operation() }
    else { try DispatchQueue.main.sync(execute: operation) }
  }
  func testVoiceEndAndRepeatedRestoration() throws { try onMain { try WindowPresentationCases.voiceEndAndRepeat() } }
  func testAppearanceAndQuickEntryHandoffs() throws { try onMain { try WindowPresentationCases.appearanceAndQuickEntryHandoffs() } }
  func testInterruptedAnimation() throws { try onMain { try WindowPresentationCases.interruptedAnimation() } }
  func testRecoveryWithoutSavedFrame() throws { try onMain { try WindowPresentationCases.recoveryWithoutSavedFrame() } }
}
#endif
