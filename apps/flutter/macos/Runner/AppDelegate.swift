import Carbon
import Cocoa
import FlutterMacOS
import Security
import UserNotifications

@main
class AppDelegate: FlutterAppDelegate, UNUserNotificationCenterDelegate {
  private let desktopHostController = DesktopHostController()

  override func applicationDidFinishLaunching(_ notification: Notification) {
    // FlutterAppDelegate inherits this optional AppKit delegate callback but
    // does not implement a super selector on macOS 27. Calling super raises an
    // Objective-C forwarding exception and prevents the desktop host from
    // registering its status item and global shortcut.
    UNUserNotificationCenter.current().delegate = self
    desktopHostController.registerNotificationCategories()
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
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    true
  }

  override func application(_ application: NSApplication, open urls: [URL]) {
    desktopHostController.handleOpenURLs(urls)
  }

  func attachDesktopBridge(channel: FlutterMethodChannel, window: NSWindow) {
    desktopHostController.attach(channel: channel, window: window)
  }

  override func application(
    _ application: NSApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    desktopHostController.reportApnsToken(token)
  }

  override func application(
    _ application: NSApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    let code = (error as NSError).code
    desktopHostController.reportApnsFailure("registration_\(code)")
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound, .badge])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    desktopHostController.handleNotificationResponse(response)
    completionHandler()
  }
}

/// Owns Asael's small native desktop surface. Product behavior remains in Flutter;
/// this controller only keeps the app available and forwards explicit navigation.
private final class DesktopHostController: NSObject {
  private struct SharedCaptureManifest: Decodable {
    struct FileEntry: Decodable {
      let name: String
      let size: Int
    }

    let schemaVersion: Int
    let requestId: String
    let files: [FileEntry]
  }

  private struct ValidatedSharedCapture {
    let requestId: String
    let directory: URL
    let files: [URL]
  }

  private enum NotificationAction: String {
    case open
    case complete
    case snooze15
    case dismiss
  }

  private static let notificationCategory = "ASAEL_ACTIONABLE_V1"
  private static let completeNotificationAction = "ASAEL_COMPLETE_V1"
  private static let snoozeNotificationAction = "ASAEL_SNOOZE_15_V1"
  private static let dismissNotificationAction = "ASAEL_DISMISS_V1"
  private enum Route: String {
    case today = "/today"
    case command = "/talk"
    case quickEntry = "/quick-entry"
    case capture = "/capture"
    case inbox = "/inbox"
  }

  private static let hotKeySignature: OSType = 0x41534145 // "ASAE"
  private static let quickEntryHotKeyID: UInt32 = 1
  private static let regularWindowMinimumSize = NSSize(width: 1_024, height: 700)
  private static let quickEntryWindowMinimumSize = NSSize(width: 680, height: 320)
  private static let quickEntryWindowSize = NSSize(width: 760, height: 400)
  private static let appGroupIdentifier = "group.app.omniagent.omniagent"
  private static let sharedCaptureInbox = "ShareInbox"
  private static let sharedCaptureManifest = "manifest.json"
  private static let sharedCaptureMaxFiles = 25
  private static let sharedCaptureMaxFileBytes = 5 * 1_024 * 1_024
  private static let sharedCaptureRequestPattern = try! NSRegularExpression(
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
  )

  private weak var window: NSWindow?
  private var channel: FlutterMethodChannel?
  private var statusItem: NSStatusItem?
  private weak var statusQuickEntryMenuItem: NSMenuItem?
  private weak var applicationQuickEntryMenuItem: NSMenuItem?
  private var hotKey: EventHotKeyRef?
  private var hotKeyEventHandler: EventHandlerRef?
  private var pendingRoute: Route?
  private var isDartReady = false
  private var hasStarted = false
  private var isQuickEntryPresented = false
  private var regularWindowFrame: NSRect?
  private var deliveredSharedCaptureIds = Set<String>()
  private var sharedCaptureDeliveryInFlight = false

  func start() {
    guard !hasStarted else { return }
    hasStarted = true
    configureApplicationMenu()
    configureStatusItem()
    if !registerQuickEntryHotKey() {
      for item in [statusQuickEntryMenuItem, applicationQuickEntryMenuItem].compactMap({ $0 }) {
        item.title = "Quick Entry — shortcut unavailable"
        item.toolTip = "Another application owns Command-Shift-Space. Quick Entry remains available from this menu."
      }
    }
  }

  func stop() {
    channel?.setMethodCallHandler(nil)
    channel = nil
    isDartReady = false
    deliveredSharedCaptureIds.removeAll()
    sharedCaptureDeliveryInFlight = false

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
    statusQuickEntryMenuItem = nil
    if let applicationQuickEntryMenuItem,
       let menu = applicationQuickEntryMenuItem.menu {
      menu.removeItem(applicationQuickEntryMenuItem)
    }
    applicationQuickEntryMenuItem = nil
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
          self.deliverNextSharedCapture()
        }
        result(nil)
      case "showMainPresentation":
        DispatchQueue.main.async {
          self.showMainWindow()
        }
        result(nil)
      case "showQuickEntryPresentation":
        DispatchQueue.main.async {
          self.showQuickEntryWindow()
        }
        result(nil)
      case "requestRemoteNotifications":
        DispatchQueue.main.async {
          self.requestRemoteNotifications()
        }
        result(nil)
      case "completeSharedCapture":
        guard let requestId = self.sharedCaptureRequestId(call.arguments),
              self.deliveredSharedCaptureIds.contains(requestId)
        else {
          result(FlutterError(code: "invalid_shared_capture", message: "The shared capture receipt is invalid.", details: nil))
          return
        }
        self.completeSharedCapture(requestId)
        result(nil)
      case "retrySharedCapture":
        guard let requestId = self.sharedCaptureRequestId(call.arguments),
              self.deliveredSharedCaptureIds.contains(requestId)
        else {
          result(FlutterError(code: "invalid_shared_capture", message: "The shared capture retry is invalid.", details: nil))
          return
        }
        self.deliveredSharedCaptureIds.remove(requestId)
        self.scheduleSharedCaptureRetry()
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  func handleOpenURLs(_ urls: [URL]) {
    guard urls.contains(where: { url in
      url.scheme?.lowercased() == "asael" && url.host?.lowercased() == "capture-shared"
    }) else { return }
    DispatchQueue.main.async { [weak self] in
      self?.showMainWindow()
      self?.deliverNextSharedCapture()
    }
  }

  private func sharedCaptureRequestId(_ arguments: Any?) -> String? {
    guard let values = arguments as? [String: Any],
          values.count == 1,
          let requestId = values["requestId"] as? String,
          Self.isSharedCaptureRequestId(requestId)
    else { return nil }
    return requestId
  }

  private static func isSharedCaptureRequestId(_ value: String) -> Bool {
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    return sharedCaptureRequestPattern.firstMatch(in: value, range: range) != nil
  }

  private func sharedCaptureInboxURL(create: Bool = false) -> URL? {
    guard let container = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: Self.appGroupIdentifier
    ) else { return nil }
    let inbox = container.appendingPathComponent(Self.sharedCaptureInbox, isDirectory: true)
    if create {
      try? FileManager.default.createDirectory(
        at: inbox,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
    }
    return inbox
  }

  private func deliverNextSharedCapture() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard isDartReady,
          !sharedCaptureDeliveryInFlight,
          let channel,
          let inbox = sharedCaptureInboxURL(create: true),
          let candidates = try? FileManager.default.contentsOfDirectory(
            at: inbox,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
          )
    else { return }

    let capture = candidates
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
      .compactMap(validatedSharedCapture)
      .first { !deliveredSharedCaptureIds.contains($0.requestId) }
    guard let capture else { return }

    deliveredSharedCaptureIds.insert(capture.requestId)
    sharedCaptureDeliveryInFlight = true
    request(.capture)
    channel.invokeMethod(
      "sharedCapture",
      arguments: [
        "requestId": capture.requestId,
        "files": capture.files.map(\.path),
      ]
    ) { [weak self] response in
      DispatchQueue.main.async {
        guard let self else { return }
        self.sharedCaptureDeliveryInFlight = false
        if response is FlutterError {
          self.deliveredSharedCaptureIds.remove(capture.requestId)
          self.scheduleSharedCaptureRetry()
        } else {
          self.deliverNextSharedCapture()
        }
      }
    }
  }

  private func validatedSharedCapture(_ candidate: URL) -> ValidatedSharedCapture? {
    let requestId = candidate.lastPathComponent.lowercased()
    guard Self.isSharedCaptureRequestId(requestId),
          candidate.lastPathComponent == requestId,
          let inbox = sharedCaptureInboxURL(),
          Self.isDirectChild(candidate, of: inbox),
          let attributes = try? FileManager.default.attributesOfItem(atPath: candidate.path),
          attributes[.type] as? FileAttributeType == .typeDirectory,
          let manifestData = try? Data(
            contentsOf: candidate.appendingPathComponent(Self.sharedCaptureManifest),
            options: [.mappedIfSafe]
          ),
          manifestData.count <= 32 * 1_024,
          let manifest = try? JSONDecoder().decode(SharedCaptureManifest.self, from: manifestData),
          manifest.schemaVersion == 1,
          manifest.requestId == requestId,
          !manifest.files.isEmpty,
          manifest.files.count <= Self.sharedCaptureMaxFiles
    else { return nil }

    var names = Set<String>()
    var files: [URL] = []
    for entry in manifest.files {
      guard Self.isSafeSharedCaptureFilename(entry.name),
            names.insert(entry.name).inserted,
            entry.size > 0,
            entry.size <= Self.sharedCaptureMaxFileBytes
      else { return nil }
      let file = candidate.appendingPathComponent(entry.name, isDirectory: false)
      guard Self.isDirectChild(file, of: candidate),
            let fileAttributes = try? FileManager.default.attributesOfItem(atPath: file.path),
            fileAttributes[.type] as? FileAttributeType == .typeRegular,
            (fileAttributes[.size] as? NSNumber)?.intValue == entry.size
      else { return nil }
      files.append(file)
    }
    return ValidatedSharedCapture(
      requestId: requestId,
      directory: candidate,
      files: files
    )
  }

  private static func isDirectChild(_ candidate: URL, of parent: URL) -> Bool {
    let resolvedParent = parent.standardizedFileURL.resolvingSymlinksInPath()
    let resolvedCandidate = candidate.standardizedFileURL.resolvingSymlinksInPath()
    return resolvedCandidate.deletingLastPathComponent() == resolvedParent
  }

  private static func isSafeSharedCaptureFilename(_ name: String) -> Bool {
    guard !name.isEmpty,
          name != ".",
          name != "..",
          name.count <= 180,
          name.lengthOfBytes(using: .utf8) <= 240,
          (name as NSString).lastPathComponent == name,
          !name.unicodeScalars.contains(where: { scalar in
            scalar.value < 0x20 ||
              (scalar.value >= 0x7f && scalar.value <= 0x9f) ||
              (scalar.value >= 0x202a && scalar.value <= 0x202e) ||
              (scalar.value >= 0x2066 && scalar.value <= 0x2069)
          })
    else { return false }
    return true
  }

  private func completeSharedCapture(_ requestId: String) {
    dispatchPrecondition(condition: .onQueue(.main))
    defer {
      deliveredSharedCaptureIds.remove(requestId)
      deliverNextSharedCapture()
    }
    guard let inbox = sharedCaptureInboxURL(),
          let capture = validatedSharedCapture(
            inbox.appendingPathComponent(requestId, isDirectory: true)
          ),
          capture.requestId == requestId
    else { return }
    try? FileManager.default.removeItem(at: capture.directory)
  }

  private func scheduleSharedCaptureRetry() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
      self?.deliverNextSharedCapture()
    }
  }

  func registerNotificationCategories() {
    let complete = UNNotificationAction(
      identifier: Self.completeNotificationAction,
      title: "Complete",
      options: [.authenticationRequired]
    )
    let snooze = UNNotificationAction(
      identifier: Self.snoozeNotificationAction,
      title: "Snooze 15 min",
      options: []
    )
    let dismiss = UNNotificationAction(
      identifier: Self.dismissNotificationAction,
      title: "Dismiss",
      options: [.destructive]
    )
    let category = UNNotificationCategory(
      identifier: Self.notificationCategory,
      actions: [complete, snooze, dismiss],
      intentIdentifiers: [],
      hiddenPreviewsBodyPlaceholder: "Asael has an update.",
      options: [.customDismissAction]
    )
    UNUserNotificationCenter.current().setNotificationCategories([category])
  }

  func handleNotificationResponse(_ response: UNNotificationResponse) {
    let action: NotificationAction
    switch response.actionIdentifier {
    case UNNotificationDefaultActionIdentifier:
      action = .open
    case Self.completeNotificationAction:
      action = .complete
    case Self.snoozeNotificationAction:
      action = .snooze15
    case Self.dismissNotificationAction, UNNotificationDismissActionIdentifier:
      action = .dismiss
    default:
      return
    }
    let data = Self.channelValue(response.notification.request.content.userInfo)
    guard let data = data as? [String: Any] else { return }
    DispatchQueue.main.async { [weak self] in
      self?.channel?.invokeMethod(
        "notificationAction",
        arguments: ["action": action.rawValue, "data": data]
      )
    }
  }

  func reportApnsToken(_ token: String) {
    let environment = apsEnvironment() ?? "production"
    DispatchQueue.main.async { [weak self] in
      self?.channel?.invokeMethod(
        "apnsRegistration",
        arguments: ["token": token, "environment": environment]
      )
    }
  }

  func reportApnsFailure(_ code: String) {
    DispatchQueue.main.async { [weak self] in
      self?.channel?.invokeMethod(
        "apnsRegistration",
        arguments: ["errorCode": code]
      )
    }
  }

  private func requestRemoteNotifications() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard apsEnvironment() != nil else {
      reportApnsFailure("missing_entitlement")
      return
    }
    NSApp.registerForRemoteNotifications()
  }

  private func apsEnvironment() -> String? {
    guard let task = SecTaskCreateFromSelf(nil),
          let value = SecTaskCopyValueForEntitlement(
            task,
            "com.apple.developer.aps-environment" as CFString,
            nil
          ) as? String,
          value == "development" || value == "production"
    else {
      return nil
    }
    return value == "development" ? "sandbox" : "production"
  }

  private static func channelValue(_ value: Any) -> Any? {
    switch value {
    case let value as String:
      return value
    case let value as NSNumber:
      return value
    case let value as [Any]:
      return value.compactMap(channelValue)
    case let value as [AnyHashable: Any]:
      var result: [String: Any] = [:]
      for (key, nested) in value {
        guard let key = key as? String, let safe = channelValue(nested) else {
          continue
        }
        result[key] = safe
      }
      return result
    default:
      return nil
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
    if route != .quickEntry {
      showMainWindow()
    } else if let window = window ?? NSApp.windows.first(where: { $0 is MainFlutterWindow }) {
      self.window = window
      focus(window)
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
    if route != .quickEntry {
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
    quickEntry.keyEquivalentModifierMask = [.command, .shift]
    menu.addItem(quickEntry)
    statusQuickEntryMenuItem = quickEntry

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

  private func configureApplicationMenu() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard let menu = NSApp.mainMenu?.items.first?.submenu else { return }

    let item = menuItem(title: "Quick Entry", key: " ", action: #selector(openQuickEntry))
    item.keyEquivalentModifierMask = [.command, .shift]
    menu.insertItem(item, at: min(1, menu.items.count))
    applicationQuickEntryMenuItem = item
  }

  private func menuItem(title: String, key: String, action: Selector) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.keyEquivalentModifierMask = [.command]
    item.target = self
    return item
  }

  private func registerQuickEntryHotKey() -> Bool {
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

    guard handlerStatus == noErr else { return false }

    let identifier = EventHotKeyID(
      signature: Self.hotKeySignature,
      id: Self.quickEntryHotKeyID
    )
    let modifiers = UInt32(cmdKey | shiftKey)
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
    return registrationStatus == noErr
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
