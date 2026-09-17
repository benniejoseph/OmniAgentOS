import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import CryptoKit
import Foundation
import ScreenCaptureKit
import Security

private enum HelperFailure: Error {
  case rejected(String)
}

private enum ParentVerifier {
  private static let parentIdentifier = "app.omniagent.omniagent"
  private static let helperIdentifier = "app.omniagent.omniagent.computer-use-helper"

  static func verify() -> Bool {
    guard Bundle.main.bundleIdentifier == helperIdentifier,
          getppid() > 1,
          let helperCode = copySelfCode(),
          let parentCode = copyParentCode(),
          codeIsValid(helperCode),
          codeIsValid(parentCode),
          signingIdentifier(parentCode) == parentIdentifier,
          signingIdentifier(helperCode) == helperIdentifier,
          parentExecutableIsContainer(parentCode)
    else { return false }

    let helperTeam = signingValue(kSecCodeInfoTeamIdentifier, from: helperCode) as? String
    let parentTeam = signingValue(kSecCodeInfoTeamIdentifier, from: parentCode) as? String
    if helperTeam != nil || parentTeam != nil {
      guard helperTeam == parentTeam else { return false }
    }

    let helperCertificates = certificateDigests(helperCode)
    let parentCertificates = certificateDigests(parentCode)
    // Developer ID, Apple Development, and Asael's owner-only private release
    // all sign the host and helper with the same leaf certificate. Ad-hoc debug
    // builds have no certificate and are accepted only after the identifier,
    // validity, process-parent, and bundle-containment checks above pass.
    return helperCertificates.isEmpty && parentCertificates.isEmpty
      || helperCertificates == parentCertificates
  }

  private static func copySelfCode() -> SecCode? {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess else { return nil }
    return code
  }

  private static func copyParentCode() -> SecCode? {
    var code: SecCode?
    let attributes = [kSecGuestAttributePid: NSNumber(value: getppid())] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess else {
      return nil
    }
    return code
  }

  private static func codeIsValid(_ code: SecCode) -> Bool {
    SecCodeCheckValidity(code, [], nil) == errSecSuccess
  }

  private static func signingIdentifier(_ code: SecCode) -> String? {
    signingValue(kSecCodeInfoIdentifier, from: code) as? String
  }

  private static func signingValue(_ key: CFString, from code: SecCode) -> Any? {
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess,
          let staticCode
    else { return nil }
    var information: CFDictionary?
    let flags = SecCSFlags(rawValue: kSecCSSigningInformation)
    guard SecCodeCopySigningInformation(staticCode, flags, &information) == errSecSuccess,
          let values = information as? [CFString: Any]
    else { return nil }
    return values[key]
  }

  private static func certificateDigests(_ code: SecCode) -> [Data] {
    guard let certificates = signingValue(kSecCodeInfoCertificates, from: code)
      as? [SecCertificate]
    else { return [] }
    return certificates.map { certificate in
      let data = SecCertificateCopyData(certificate) as Data
      return Data(CryptoKit.SHA256.hash(data: data))
    }
  }

  private static func parentExecutableIsContainer(_ parentCode: SecCode) -> Bool {
    guard let executable = signingValue(kSecCodeInfoMainExecutable, from: parentCode) as? URL
    else { return false }
    let helperBundle = Bundle.main.bundleURL.standardizedFileURL.resolvingSymlinksInPath()
    let parentBundle = helperBundle
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .standardizedFileURL
      .resolvingSymlinksInPath()
    let parentExecutable = executable.standardizedFileURL.resolvingSymlinksInPath()
    return parentBundle.pathExtension == "app"
      && parentExecutable.path.hasPrefix(parentBundle.path + "/Contents/MacOS/")
  }
}

private final class ComputerUseExecutor {
  private static let allowedActions: Set<String> = [
    "status", "request_permissions", "observe", "list_apps", "activate_app",
    "press", "click", "type", "key", "scroll",
  ]
  private static let restrictedAutomationBundleIdentifiers: Set<String> = [
    "com.apple.Terminal",
    "com.apple.systempreferences",
    "com.apple.SystemSettings",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "com.github.wez.wezterm",
  ]
  private static let maximumInputBytes = 64 * 1_024
  private static let maximumTextUnits = 4_000
  private static let maximumSnapshotNodes = 260
  private static let maximumSnapshotDepth = 8
  private static let maximumSnapshotBytes = 96 * 1_024
  private static let maximumScreenshotBytes = 1_500_000

  private let snapshotNonce = UUID().uuidString.lowercased()
  private var snapshotCounter = 0
  private var snapshotRevision = ""
  private var snapshotFrontmostPID: pid_t?
  private var snapshotFocusedWindow: AXUIElement?
  private var snapshotDisplayBounds: [CGRect] = []
  private var elements: [String: AXUIElement] = [:]
  private var completed: [String: [String: Any]] = [:]
  private var completionOrder: [String] = []

  func execute(_ envelope: [String: Any]) async -> [String: Any] {
    guard let id = envelope["id"] as? String else {
      return response(id: "invalid", outcome: "failed", errorCode: "invalid_command")
    }
    if let prior = completed[id] { return prior }

    let output: [String: Any]
    do {
      let (action, input) = try validate(envelope, id: id)
      let result = try await perform(action: action, input: input)
      output = response(id: id, outcome: "succeeded", result: result)
    } catch HelperFailure.rejected(let code) {
      output = response(id: id, outcome: "failed", errorCode: code)
    } catch {
      output = response(id: id, outcome: "failed", errorCode: "helper_error")
    }
    remember(id: id, output: output)
    return output
  }

  private func validate(
    _ envelope: [String: Any],
    id: String
  ) throws -> (String, [String: Any]) {
    guard envelope.count == 4,
          isCommandId(id),
          let action = envelope["action"] as? String,
          Self.allowedActions.contains(action),
          let input = envelope["input"] as? [String: Any],
          let expiresAt = envelope["expiresAt"] as? String,
          let expiration = parseDate(expiresAt),
          expiration > Date(),
          expiration.timeIntervalSinceNow <= 600,
          JSONSerialization.isValidJSONObject(input),
          let bytes = try? JSONSerialization.data(withJSONObject: input),
          bytes.count <= Self.maximumInputBytes
    else { throw HelperFailure.rejected("invalid_command") }
    return (action, input)
  }

  private func perform(action: String, input: [String: Any]) async throws -> [String: Any] {
    switch action {
    case "status":
      return result(
        summary: "Local Mac permission status checked.",
        data: permissionData()
      )
    case "request_permissions":
      guard input.isEmpty else { throw HelperFailure.rejected("invalid_input") }
      requestAccessibilityPermission()
      _ = CGRequestScreenCaptureAccess()
      return result(
        summary: "macOS permission requests were presented.",
        data: permissionData()
      )
    case "list_apps":
      guard input.isEmpty else { throw HelperFailure.rejected("invalid_input") }
      return result(summary: "Listed visible applications.", data: ["applications": runningApps()])
    case "activate_app":
      return try activateApp(input)
    case "observe":
      return try await observe(input)
    case "press":
      return try press(input)
    case "click":
      return try click(input)
    case "type":
      return try typeText(input)
    case "key":
      return try key(input)
    case "scroll":
      return try scroll(input)
    default:
      throw HelperFailure.rejected("unsupported_action")
    }
  }

  private func permissionData() -> [String: Any] {
    [
      "accessibility": AXIsProcessTrusted() ? "granted" : "denied",
      "screenRecording": CGPreflightScreenCaptureAccess() ? "granted" : "denied",
    ]
  }

  private func requestAccessibilityPermission() {
    let options = [
      kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
    ] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
  }

  private func runningApps() -> [[String: Any]] {
    NSWorkspace.shared.runningApplications
      .filter { app in
        app.activationPolicy == .regular
          && app.processIdentifier != ProcessInfo.processInfo.processIdentifier
          && app.bundleIdentifier != Bundle.main.bundleIdentifier
      }
      .prefix(80)
      .map { app in
        [
          "name": bounded(app.localizedName ?? "Application", limit: 160),
          "bundleId": bounded(app.bundleIdentifier ?? "unknown", limit: 300),
          "pid": Int(app.processIdentifier),
          "active": app.isActive,
        ]
      }
  }

  private func activateApp(_ input: [String: Any]) throws -> [String: Any] {
    guard input.count == 1,
          let bundleId = input["bundleId"] as? String,
          isSafeIdentifier(bundleId),
          !Self.restrictedAutomationBundleIdentifiers.contains(bundleId),
          let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first,
          app.activationPolicy == .regular
    else { throw HelperFailure.rejected("application_not_allowed") }
    guard app.activate(options: [.activateAllWindows]) else {
      throw HelperFailure.rejected("activation_failed")
    }
    return result(
      summary: "Activated \(bounded(app.localizedName ?? "application", limit: 100)).",
      data: ["bundleId": bundleId]
    )
  }

  private func observe(_ input: [String: Any]) async throws -> [String: Any] {
    guard input.keys.allSatisfy({ $0 == "includeScreenshot" }),
          input["includeScreenshot"] == nil || input["includeScreenshot"] is Bool
    else { throw HelperFailure.rejected("invalid_input") }
    guard AXIsProcessTrusted() else { throw HelperFailure.rejected("accessibility_denied") }

    snapshotCounter += 1
    snapshotRevision = revisionToken(counter: snapshotCounter)
    elements.removeAll(keepingCapacity: true)
    let app = NSWorkspace.shared.frontmostApplication
    if let bundleId = app?.bundleIdentifier,
       Self.restrictedAutomationBundleIdentifiers.contains(bundleId) {
      throw HelperFailure.rejected("restricted_application_refused")
    }
    snapshotFrontmostPID = app?.processIdentifier
    snapshotFocusedWindow = app.flatMap { application in
      axElementAttribute(
        AXUIElementCreateApplication(application.processIdentifier),
        kAXFocusedWindowAttribute as String
      )
    }
    snapshotDisplayBounds = activeDisplayBounds()
    let frontmost = app.map(frontmostApplication)
    let accessibility = app.map { accessibilitySnapshot(pid: $0.processIdentifier) }
      ?? "No frontmost application is available."

    var observation: [String: Any] = [
      "snapshotRevision": snapshotRevision,
      "accessibilitySnapshot": accessibility,
    ]
    if let frontmost { observation["frontmostApplication"] = frontmost }

    if input["includeScreenshot"] as? Bool != false {
      guard CGPreflightScreenCaptureAccess() else {
        throw HelperFailure.rejected("screen_recording_denied")
      }
      let screenshot = try await captureScreenshot()
      observation["screenshot"] = screenshot
    }
    return result(summary: "Observed the active Mac workspace.", observation: observation)
  }

  private func frontmostApplication(_ app: NSRunningApplication) -> [String: Any] {
    [
      "name": bounded(app.localizedName ?? "Application", limit: 160),
      "bundleId": bounded(app.bundleIdentifier ?? "unknown", limit: 240),
      "pid": Int(app.processIdentifier),
    ]
  }

  private func accessibilitySnapshot(pid: pid_t) -> String {
    let application = AXUIElementCreateApplication(pid)
    let root = axElementAttribute(application, kAXFocusedWindowAttribute as String)
      ?? application
    var lines: [String] = []
    var bytes = 0
    walk(element: root, depth: 0, lines: &lines, bytes: &bytes)
    if lines.isEmpty { return "The active application exposes no readable accessibility elements." }
    if elements.count >= Self.maximumSnapshotNodes || bytes >= Self.maximumSnapshotBytes {
      lines.append("… snapshot bounded by Asael …")
    }
    return lines.joined(separator: "\n")
  }

  private func walk(
    element: AXUIElement,
    depth: Int,
    lines: inout [String],
    bytes: inout Int
  ) {
    guard depth <= Self.maximumSnapshotDepth,
          elements.count < Self.maximumSnapshotNodes,
          bytes < Self.maximumSnapshotBytes
    else { return }

    let identifier = "e:\(snapshotRevision.prefix(12)):\(elements.count + 1)"
    elements[identifier] = element
    let role = stringAttribute(element, kAXRoleAttribute as String) ?? "AXElement"
    let subrole = stringAttribute(element, kAXSubroleAttribute as String)
    let secure = isSecure(role: role, subrole: subrole)
    let title = stringAttribute(element, kAXTitleAttribute as String)
      ?? stringAttribute(element, kAXDescriptionAttribute as String)
      ?? stringAttribute(element, kAXHelpAttribute as String)
    let value = secure ? "[secure]" : safeValue(element)
    var attributes = ["id=\(identifier)", "role=\(bounded(role, limit: 80))"]
    if let subrole { attributes.append("subrole=\(bounded(subrole, limit: 80))") }
    if let title, !title.isEmpty { attributes.append("label=\(quoted(title))") }
    if let value, !value.isEmpty { attributes.append("value=\(quoted(value))") }
    if let frame = frame(element) {
      attributes.append(
        "frame=\(Int(frame.origin.x)),\(Int(frame.origin.y)),\(Int(frame.width)),\(Int(frame.height))"
      )
    }
    let line = String(repeating: "  ", count: depth) + attributes.joined(separator: " ")
    bytes += line.utf8.count + 1
    lines.append(line)

    guard let children = copyAttribute(element, kAXChildrenAttribute as String) as? [AXUIElement]
    else { return }
    for child in children.prefix(80) {
      walk(element: child, depth: depth + 1, lines: &lines, bytes: &bytes)
      if elements.count >= Self.maximumSnapshotNodes || bytes >= Self.maximumSnapshotBytes { break }
    }
  }

  private func press(_ input: [String: Any]) throws -> [String: Any] {
    guard input.keys.allSatisfy({ $0 == "elementId" || $0 == "snapshotRevision" }),
          let elementId = input["elementId"] as? String,
          let revision = input["snapshotRevision"] as? String,
          elementId.hasPrefix("e:\(revision.prefix(12)):"),
          let element = elements[elementId]
    else { throw HelperFailure.rejected("stale_or_invalid_element") }
    try verifyObservedTarget(revision: revision)
    let status = AXUIElementPerformAction(element, kAXPressAction as CFString)
    guard status == .success else { throw HelperFailure.rejected("press_failed") }
    return result(summary: "Pressed the approved accessibility element.")
  }

  private func click(_ input: [String: Any]) throws -> [String: Any] {
    guard AXIsProcessTrusted() else { throw HelperFailure.rejected("accessibility_denied") }
    guard let revision = input["snapshotRevision"] as? String else {
      throw HelperFailure.rejected("invalid_input")
    }
    try verifyObservedTarget(revision: revision)
    let point: CGPoint
    if let elementId = input["elementId"] as? String,
       input.keys.allSatisfy({ $0 == "elementId" || $0 == "snapshotRevision" }),
       elementId.hasPrefix("e:\(revision.prefix(12)):"),
       let element = elements[elementId],
       let targetFrame = frame(element) {
      point = CGPoint(x: targetFrame.midX, y: targetFrame.midY)
    } else if let x = number(input["x"]),
              let y = number(input["y"]),
              input.keys.allSatisfy({ $0 == "x" || $0 == "y" || $0 == "snapshotRevision" }),
              pointIsOnActiveDisplay(CGPoint(x: x, y: y)) {
      point = CGPoint(x: x, y: y)
    } else {
      throw HelperFailure.rejected("invalid_input")
    }
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                             mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                           mouseCursorPosition: point, mouseButton: .left)
    else { throw HelperFailure.rejected("event_creation_failed") }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return result(summary: "Clicked the approved on-screen location.")
  }

  private func typeText(_ input: [String: Any]) throws -> [String: Any] {
    guard input.count == 2,
          let revision = input["snapshotRevision"] as? String,
          let text = input["text"] as? String,
          !text.isEmpty,
          text.utf16.count <= Self.maximumTextUnits
    else { throw HelperFailure.rejected("invalid_input") }
    try verifyObservedTarget(revision: revision)
    try verifyKeyboardTarget()
    let units = Array(text.utf16)
    var offset = 0
    while offset < units.count {
      let chunk = Array(units[offset..<min(offset + 20, units.count)])
      guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
            let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
      else { throw HelperFailure.rejected("event_creation_failed") }
      down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
      up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
      offset += chunk.count
    }
    return result(summary: "Typed \(units.count) characters into the approved application.")
  }

  private func key(_ input: [String: Any]) throws -> [String: Any] {
    guard input.keys.allSatisfy({
            $0 == "key" || $0 == "modifiers" || $0 == "snapshotRevision"
          }),
          let revision = input["snapshotRevision"] as? String,
          let name = input["key"] as? String,
          let code = keyCode(name),
          let modifierNames = input["modifiers"] as? [String],
          modifierNames.count <= 4
    else { throw HelperFailure.rejected("invalid_input") }
    try verifyObservedTarget(revision: revision)
    try verifyKeyboardTarget()
    var flags: CGEventFlags = []
    for modifier in modifierNames {
      switch modifier {
      case "command": flags.insert(.maskCommand)
      case "shift": flags.insert(.maskShift)
      case "option": flags.insert(.maskAlternate)
      case "control": flags.insert(.maskControl)
      default: throw HelperFailure.rejected("invalid_input")
      }
    }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    else { throw HelperFailure.rejected("event_creation_failed") }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return result(summary: "Sent the approved keyboard shortcut.")
  }

  private func scroll(_ input: [String: Any]) throws -> [String: Any] {
    guard input.keys.allSatisfy({
            $0 == "deltaX" || $0 == "deltaY" || $0 == "snapshotRevision"
          }),
          let revision = input["snapshotRevision"] as? String,
          let dx = number(input["deltaX"]),
          let dy = number(input["deltaY"]),
          abs(dx) <= 2_000,
          abs(dy) <= 2_000,
          dx != 0 || dy != 0,
          let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 2,
            wheel1: Int32(dy.rounded()),
            wheel2: Int32(dx.rounded()),
            wheel3: 0
          )
    else { throw HelperFailure.rejected("invalid_input") }
    try verifyObservedTarget(revision: revision)
    event.post(tap: .cghidEventTap)
    return result(summary: "Scrolled the active application.")
  }

  private func verifyKeyboardTarget() throws {
    guard AXIsProcessTrusted() else { throw HelperFailure.rejected("accessibility_denied") }
    guard !IsSecureEventInputEnabled() else { throw HelperFailure.rejected("secure_input_refused") }
    if let bundleId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
       Self.restrictedAutomationBundleIdentifiers.contains(bundleId) {
      throw HelperFailure.rejected("restricted_application_refused")
    }
    let system = AXUIElementCreateSystemWide()
    guard let focused = axElementAttribute(system, kAXFocusedUIElementAttribute as String)
    else { return }
    let role = stringAttribute(focused, kAXRoleAttribute as String) ?? ""
    let subrole = stringAttribute(focused, kAXSubroleAttribute as String)
    if isSecure(role: role, subrole: subrole) {
      throw HelperFailure.rejected("secure_input_refused")
    }
  }

  private func captureScreenshot() async throws -> [String: Any] {
    let content = try await SCShareableContent.excludingDesktopWindows(
      false,
      onScreenWindowsOnly: true
    )
    let focusedCenter = snapshotFocusedWindow.flatMap(frame)?.center
    guard let display = focusedCenter.flatMap({ center in
      content.displays.first { $0.frame.contains(center) }
    }) ?? content.displays.first else {
      throw HelperFailure.rejected("display_unavailable")
    }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let configuration = SCStreamConfiguration()
    let scale = min(1, 1_440 / max(1, CGFloat(display.width)))
    configuration.width = max(1, Int(CGFloat(display.width) * scale))
    configuration.height = max(1, Int(CGFloat(display.height) * scale))
    configuration.showsCursor = true
    configuration.captureResolution = .best
    let image = try await SCScreenshotManager.captureImage(
      contentFilter: filter,
      configuration: configuration
    )
    let representation = NSBitmapImageRep(cgImage: image)
    let compressionLevels: [CGFloat] = [0.66, 0.52, 0.4, 0.3]
    let data = compressionLevels.lazy.compactMap { compression in
      representation.representation(
        using: .jpeg,
        properties: [.compressionFactor: compression]
      )
    }.first { $0.count <= Self.maximumScreenshotBytes }
    guard let data else {
      throw HelperFailure.rejected("screenshot_too_large")
    }
    return [
      "mimeType": "image/jpeg",
      "dataBase64": data.base64EncodedString(),
    ]
  }

  private func result(
    summary: String,
    data: [String: Any]? = nil,
    observation: [String: Any]? = nil
  ) -> [String: Any] {
    var value: [String: Any] = ["summary": bounded(summary, limit: 500)]
    if let data { value["data"] = data }
    if let observation { value["observation"] = observation }
    return value
  }

  private func response(
    id: String,
    outcome: String,
    result: [String: Any]? = nil,
    errorCode: String? = nil
  ) -> [String: Any] {
    var value: [String: Any] = ["id": id, "outcome": outcome]
    if let result { value["result"] = result }
    if let errorCode { value["errorCode"] = errorCode }
    return value
  }

  private func remember(id: String, output: [String: Any]) {
    completed[id] = output
    completionOrder.append(id)
    while completionOrder.count > 128 {
      completed.removeValue(forKey: completionOrder.removeFirst())
    }
  }

  private func copyAttribute(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
    else { return nil }
    return value
  }

  private func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    copyAttribute(element, attribute) as? String
  }

  private func axElementAttribute(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    guard let value = copyAttribute(element, attribute),
          CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    return (value as! AXUIElement)
  }

  private func safeValue(_ element: AXUIElement) -> String? {
    if let value = copyAttribute(element, kAXValueAttribute as String) as? String {
      return bounded(value, limit: 240)
    }
    if let value = copyAttribute(element, kAXValueAttribute as String) as? NSNumber {
      return value.stringValue
    }
    return nil
  }

  private func frame(_ element: AXUIElement) -> CGRect? {
    guard let rawPosition = copyAttribute(element, kAXPositionAttribute as String),
          CFGetTypeID(rawPosition) == AXValueGetTypeID(),
          let rawSize = copyAttribute(element, kAXSizeAttribute as String),
          CFGetTypeID(rawSize) == AXValueGetTypeID()
    else { return nil }
    let positionValue = rawPosition as! AXValue
    let sizeValue = rawSize as! AXValue
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue, .cgPoint, &position),
          AXValueGetValue(sizeValue, .cgSize, &size),
          position.x.isFinite, position.y.isFinite,
          size.width.isFinite, size.height.isFinite
    else { return nil }
    return CGRect(origin: position, size: size)
  }

  private func isSecure(role: String, subrole: String?) -> Bool {
    role.localizedCaseInsensitiveContains("secure")
      || (subrole?.localizedCaseInsensitiveContains("secure") ?? false)
  }

  private func quoted(_ value: String) -> String {
    let clean = bounded(value, limit: 240)
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\n", with: " ")
      .replacingOccurrences(of: "\r", with: " ")
      .replacingOccurrences(of: "\"", with: "\\\"")
    return "\"\(clean)\""
  }

  private func bounded(_ value: String, limit: Int) -> String {
    let scalars = value.unicodeScalars.prefix(limit)
    return String(String.UnicodeScalarView(scalars))
  }

  private func number(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber else { return nil }
    let result = number.doubleValue
    return result.isFinite ? result : nil
  }

  private func isCommandId(_ value: String) -> Bool {
    value.range(
      of: #"^local_computer_command_[a-f0-9]{48}$"#,
      options: .regularExpression
    ) != nil
  }

  private func revisionToken(counter: Int) -> String {
    CryptoKit.SHA256.hash(data: Data("\(snapshotNonce):\(counter)".utf8))
      .map { String(format: "%02x", $0) }
      .joined()
  }

  private func verifyObservedTarget(revision: String) throws {
    guard revision.count == 64,
          revision == snapshotRevision,
          revision.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
          let expectedPID = snapshotFrontmostPID,
          let frontmost = NSWorkspace.shared.frontmostApplication,
          frontmost.processIdentifier == expectedPID,
          activeDisplayBounds() == snapshotDisplayBounds,
          !Self.restrictedAutomationBundleIdentifiers.contains(frontmost.bundleIdentifier ?? "")
    else { throw HelperFailure.rejected("stale_observation") }
    if let snapshotFocusedWindow {
      let application = AXUIElementCreateApplication(expectedPID)
      guard let currentWindow = axElementAttribute(
        application,
        kAXFocusedWindowAttribute as String
      ), CFEqual(snapshotFocusedWindow, currentWindow) else {
        throw HelperFailure.rejected("stale_observation")
      }
    }
  }

  private func parseDate(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }

  private func isSafeIdentifier(_ value: String) -> Bool {
    value.count <= 300
      && value.range(of: #"^[A-Za-z0-9][A-Za-z0-9.-]+$"#, options: .regularExpression) != nil
  }

  private func pointIsOnActiveDisplay(_ point: CGPoint) -> Bool {
    activeDisplayBounds().contains { $0.contains(point) }
  }

  private func activeDisplayBounds() -> [CGRect] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &displays, &count) == .success else { return [] }
    return displays.prefix(Int(count)).map(CGDisplayBounds)
  }

  private func keyCode(_ name: String) -> CGKeyCode? {
    let codes: [String: CGKeyCode] = [
      "return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
      "left": 123, "right": 124, "down": 125, "up": 126,
      "home": 115, "end": 119, "page_up": 116, "page_down": 121,
    ]
    return codes[name]
  }
}

private extension CGRect {
  var center: CGPoint { CGPoint(x: midX, y: midY) }
}

@main
private enum AsaelComputerUseHelper {
  static func main() async {
    guard ParentVerifier.verify() else {
      FileHandle.standardError.write(Data("parent_verification_failed\n".utf8))
      exit(78)
    }

    let executor = ComputerUseExecutor()
    while let line = readLine(strippingNewline: true) {
      guard line.utf8.count <= 96 * 1_024,
            let data = line.data(using: .utf8),
            let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else {
        emit(["id": "invalid", "outcome": "failed", "errorCode": "invalid_command"])
        continue
      }
      emit(await executor.execute(envelope))
    }
  }

  private static func emit(_ response: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(response),
          let data = try? JSONSerialization.data(withJSONObject: response),
          data.count <= 4 * 1_024 * 1_024
    else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
  }
}
