import Carbon
import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  private let desktopHostController = DesktopHostController()

  override func applicationDidFinishLaunching(_ notification: Notification) {
    super.applicationDidFinishLaunching(notification)
    desktopHostController.start()
  }

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  override func applicationShouldHandleReopen(
    _ sender: NSApplication,
    hasVisibleWindows flag: Bool
  ) -> Bool {
    desktopHostController.showMainWindow()
    return true
  }

  override func applicationWillTerminate(_ notification: Notification) {
    desktopHostController.stop()
    super.applicationWillTerminate(notification)
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    true
  }

  func attachDesktopBridge(channel: FlutterMethodChannel, window: NSWindow) {
    desktopHostController.attach(channel: channel, window: window)
  }
}

/// Owns Asael's small native desktop surface. Product behavior remains in Flutter;
/// this controller only keeps the app available and forwards explicit navigation.
private final class DesktopHostController: NSObject {
  private enum Route: String {
    case today = "/today"
    case command = "/talk"
    case quickEntry = "/talk?entry=quick"
    case capture = "/capture"
    case inbox = "/inbox"
  }

  private static let hotKeySignature: OSType = 0x41534145 // "ASAE"
  private static let quickEntryHotKeyID: UInt32 = 1
  private static let regularWindowMinimumSize = NSSize(width: 1_024, height: 700)
  private static let quickEntryWindowMinimumSize = NSSize(width: 680, height: 320)
  private static let quickEntryWindowSize = NSSize(width: 760, height: 400)

  private weak var window: NSWindow?
  private var channel: FlutterMethodChannel?
  private var statusItem: NSStatusItem?
  private var hotKey: EventHotKeyRef?
  private var hotKeyEventHandler: EventHandlerRef?
  private var pendingRoute: Route?
  private var isDartReady = false
  private var hasStarted = false
  private var isQuickEntryPresented = false
  private var regularWindowFrame: NSRect?

  func start() {
    guard !hasStarted else { return }
    hasStarted = true
    configureStatusItem()
    registerQuickEntryHotKey()
  }

  func stop() {
    channel?.setMethodCallHandler(nil)
    channel = nil
    isDartReady = false

    if let hotKey {
      UnregisterEventHotKey(hotKey)
      self.hotKey = nil
    }
    if let hotKeyEventHandler {
      RemoveEventHandler(hotKeyEventHandler)
      self.hotKeyEventHandler = nil
    }
    if let statusItem {
      NSStatusBar.system.removeStatusItem(statusItem)
      self.statusItem = nil
    }
  }

  func attach(channel: FlutterMethodChannel, window: NSWindow) {
    self.channel?.setMethodCallHandler(nil)
    self.channel = channel
    self.window = window
    isDartReady = false

    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else {
        result(FlutterError(code: "host_unavailable", message: "Desktop host is unavailable.", details: nil))
        return
      }

      switch call.method {
      case "flutterReady":
        DispatchQueue.main.async {
          self.isDartReady = true
          self.flushPendingRoute()
        }
        result(nil)
      case "showMainPresentation":
        DispatchQueue.main.async {
          self.showMainWindow()
        }
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  func showMainWindow() {
    dispatchPrecondition(condition: .onQueue(.main))

    guard let window = window ?? NSApp.windows.first(where: { $0 is MainFlutterWindow }) else {
      NSApp.activate(ignoringOtherApps: true)
      return
    }

    self.window = window
    restoreMainWindowPresentation(window)
    focus(window)
  }

  private func showQuickEntryWindow() {
    dispatchPrecondition(condition: .onQueue(.main))

    guard let window = window ?? NSApp.windows.first(where: { $0 is MainFlutterWindow }) else {
      NSApp.activate(ignoringOtherApps: true)
      return
    }

    self.window = window
    if !isQuickEntryPresented {
      regularWindowFrame = window.frame
    }
    isQuickEntryPresented = true
    window.minSize = Self.quickEntryWindowMinimumSize
    window.level = .floating
    window.collectionBehavior.insert(.fullScreenAuxiliary)

    let visibleFrame = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame
    if let visibleFrame {
      let x = visibleFrame.midX - Self.quickEntryWindowSize.width / 2
      let y = visibleFrame.maxY - Self.quickEntryWindowSize.height - 72
      window.setFrame(
        NSRect(origin: NSPoint(x: x, y: y), size: Self.quickEntryWindowSize),
        display: true,
        animate: window.isVisible
      )
    } else {
      window.setContentSize(Self.quickEntryWindowSize)
      window.center()
    }
    focus(window)
  }

  private func restoreMainWindowPresentation(_ window: NSWindow) {
    guard isQuickEntryPresented else { return }
    isQuickEntryPresented = false
    window.level = .normal
    window.collectionBehavior.remove(.fullScreenAuxiliary)
    window.minSize = Self.regularWindowMinimumSize
    if let regularWindowFrame {
      window.setFrame(regularWindowFrame, display: true, animate: window.isVisible)
      self.regularWindowFrame = nil
    }
  }

  private func focus(_ window: NSWindow) {
    if window.isMiniaturized {
      window.deminiaturize(nil)
    }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func request(_ route: Route) {
    dispatchPrecondition(condition: .onQueue(.main))
    if route == .quickEntry {
      showQuickEntryWindow()
    } else {
      showMainWindow()
    }

    guard isDartReady, let channel else {
      // Last-write-wins: after startup only the user's newest destination should
      // open, so stale menu or hot-key actions are never replayed.
      pendingRoute = route
      return
    }

    channel.invokeMethod("openRoute", arguments: ["route": route.rawValue])
  }

  private func flushPendingRoute() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard isDartReady, let route = pendingRoute, let channel else { return }
    pendingRoute = nil
    if route == .quickEntry {
      showQuickEntryWindow()
    } else {
      showMainWindow()
    }
    channel.invokeMethod("openRoute", arguments: ["route": route.rawValue])
  }

  private func configureStatusItem() {
    dispatchPrecondition(condition: .onQueue(.main))

    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    item.autosaveName = "AsaelStatusItem"
    item.behavior = .terminationOnRemoval

    if let button = item.button {
      let image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Asael")
      image?.isTemplate = true
      button.image = image
      button.toolTip = "Asael"
      if image == nil {
        button.title = "A"
      }
    }

    let menu = NSMenu(title: "Asael")
    menu.addItem(menuItem(title: "Today", key: "1", action: #selector(openToday)))
    menu.addItem(menuItem(title: "Command", key: "2", action: #selector(openCommand)))

    let quickEntry = menuItem(title: "Quick Entry", key: " ", action: #selector(openQuickEntry))
    quickEntry.keyEquivalentModifierMask = [.control, .option]
    menu.addItem(quickEntry)

    menu.addItem(menuItem(title: "Quick Capture", key: "3", action: #selector(openQuickCapture)))
    menu.addItem(menuItem(title: "Inbox", key: "4", action: #selector(openInbox)))
    menu.addItem(.separator())

    let quit = NSMenuItem(title: "Quit Asael", action: #selector(quitApplication), keyEquivalent: "q")
    quit.keyEquivalentModifierMask = [.command]
    quit.target = self
    menu.addItem(quit)

    item.menu = menu
    statusItem = item
  }

  private func menuItem(title: String, key: String, action: Selector) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.keyEquivalentModifierMask = [.command]
    item.target = self
    return item
  }

  private func registerQuickEntryHotKey() {
    dispatchPrecondition(condition: .onQueue(.main))

    var eventType = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard),
      eventKind: UInt32(kEventHotKeyPressed)
    )

    let userData = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
    let handlerStatus = InstallEventHandler(
      GetApplicationEventTarget(),
      { _, event, userData -> OSStatus in
        guard let event, let userData else { return OSStatus(eventNotHandledErr) }

        var identifier = EventHotKeyID()
        let status = GetEventParameter(
          event,
          EventParamName(kEventParamDirectObject),
          EventParamType(typeEventHotKeyID),
          nil,
          MemoryLayout<EventHotKeyID>.size,
          nil,
          &identifier
        )
        guard status == noErr,
              identifier.signature == DesktopHostController.hotKeySignature,
              identifier.id == DesktopHostController.quickEntryHotKeyID
        else {
          return OSStatus(eventNotHandledErr)
        }

        let controller = Unmanaged<DesktopHostController>
          .fromOpaque(userData)
          .takeUnretainedValue()
        DispatchQueue.main.async {
          controller.request(.quickEntry)
        }
        return noErr
      },
      1,
      &eventType,
      userData,
      &hotKeyEventHandler
    )

    guard handlerStatus == noErr else { return }

    let identifier = EventHotKeyID(
      signature: Self.hotKeySignature,
      id: Self.quickEntryHotKeyID
    )
    let modifiers = UInt32(controlKey | optionKey)
    let registrationStatus = RegisterEventHotKey(
      UInt32(kVK_Space),
      modifiers,
      identifier,
      GetApplicationEventTarget(),
      0,
      &hotKey
    )

    if registrationStatus != noErr, let hotKeyEventHandler {
      RemoveEventHandler(hotKeyEventHandler)
      self.hotKeyEventHandler = nil
    }
  }

  @objc private func openToday() {
    request(.today)
  }

  @objc private func openCommand() {
    request(.command)
  }

  @objc private func openQuickEntry() {
    request(.quickEntry)
  }

  @objc private func openQuickCapture() {
    request(.capture)
  }

  @objc private func openInbox() {
    request(.inbox)
  }

  @objc private func quitApplication() {
    NSApp.terminate(nil)
  }
}
