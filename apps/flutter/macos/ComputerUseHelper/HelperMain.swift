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

func sanitizedLocalComputerText(_ value: String, limit: Int) -> String {
  value.unicodeScalars.prefix(limit).map { scalar in
    scalar.value < 0x20 || scalar.value == 0x7f ? " " : String(scalar)
  }.joined()
}

enum FocusSafeSnapshotDisposition: Equatable {
  case alreadyFocused
  case restoreFromTrustedHost
  case stale
}

enum FocusSafeSnapshotPolicy {
  // Approval may put the verified Asael parent in front. No other foreground
  // process is allowed to trigger automatic focus restoration.
  static func disposition(
    expectedPID: pid_t,
    expectedBundleIdentifier: String?,
    currentPID: pid_t?,
    currentBundleIdentifier: String?,
    focusedWindowMatches: Bool,
    trustedHostPID: pid_t,
    trustedHostBundleIdentifier: String
  ) -> FocusSafeSnapshotDisposition {
    if currentPID == expectedPID {
      guard currentBundleIdentifier == expectedBundleIdentifier else { return .stale }
      if focusedWindowMatches {
        return .alreadyFocused
      }
      return (expectedPID == trustedHostPID
          && expectedBundleIdentifier == trustedHostBundleIdentifier)
        ? .restoreFromTrustedHost
        : .stale
    }
    return (currentPID == trustedHostPID
        && currentBundleIdentifier == trustedHostBundleIdentifier)
      ? .restoreFromTrustedHost
      : .stale
  }
}

struct SnapshotElementIdentity: Equatable {
  let role: String
  let subrole: String?
  let label: String?
  let value: String?
  let frame: CGRect?
}

enum SafeBrowserNavigationPolicy {
  private static let browserBundleIdentifiers = [
    "chrome": "com.google.Chrome",
  ]

  static func bundleIdentifier(for browser: String) -> String? {
    browserBundleIdentifiers[browser]
  }

  static func validatedURL(_ rawValue: String) -> URL? {
    guard rawValue.utf8.count >= 8,
          rawValue.utf8.count <= 4_096,
          rawValue == rawValue.trimmingCharacters(in: .whitespacesAndNewlines),
          !rawValue.contains("\\"),
          !rawValue.unicodeScalars.contains(where: {
            $0.value <= 0x20 || $0.value == 0x7f
          }),
          let components = URLComponents(string: rawValue),
          let scheme = components.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          components.user == nil,
          components.password == nil,
          let host = components.host,
          !host.isEmpty,
          host.utf8.count <= 253,
          let url = components.url,
          url.scheme?.lowercased() == scheme,
          url.host != nil
    else { return nil }
    return url
  }

  static func effectVerdict(browserFrontmost: Bool) -> String {
    browserFrontmost ? "confirmed" : "unverifiable"
  }
}

private enum ParentVerifier {
  static let parentIdentifier = "app.omniagent.omniagent"
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
  private struct CompletedRequest {
    let output: [String: Any]
    let expiresAt: Date
  }

  private static let allowedActions: Set<String> = [
    "status", "request_permissions", "observe", "list_apps", "activate_app",
    "open_url", "press", "click", "type", "key", "scroll",
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
  private static let maximumScreenshotBytes = 1_300_000

  private let trustedHostPID = getppid()
  private let snapshotNonce = UUID().uuidString.lowercased()
  private var snapshotCounter = 0
  private var snapshotRevision = ""
  private var snapshotTargetApplication: NSRunningApplication?
  private var snapshotFrontmostPID: pid_t?
  private var snapshotFrontmostBundleIdentifier: String?
  private var snapshotFocusedWindow: AXUIElement?
  private var snapshotFocusedElement: AXUIElement?
  private var snapshotFocusedElementIdentity: SnapshotElementIdentity?
  private var snapshotWindowIdentity: SnapshotElementIdentity?
  private var snapshotDisplayBounds: [CGRect] = []
  // Accessibility references and identities live only for this helper process.
  // They are never included in a command completion or persisted by the host.
  private var elements: [String: AXUIElement] = [:]
  private var elementIdentities: [String: SnapshotElementIdentity] = [:]
  private let completedLock = NSLock()
  private var completed: [String: CompletedRequest] = [:]
  private var completionOrder: [String] = []
  private var completionExpiryWorkItem: DispatchWorkItem?

  func execute(_ envelope: [String: Any]) async -> [String: Any] {
    guard let id = envelope["id"] as? String else {
      return response(id: "invalid", outcome: "failed", errorCode: "invalid_command")
    }

    let validated: (action: String, input: [String: Any], expiration: Date)
    do {
      validated = try validate(envelope, id: id)
    } catch HelperFailure.rejected(let code) {
      return response(id: id, outcome: "failed", errorCode: code)
    } catch {
      return response(id: id, outcome: "failed", errorCode: "helper_error")
    }
    if let prior = cachedOutput(id: id) { return prior }

    let output: [String: Any]
    do {
      let result = try await perform(
        action: validated.action,
        input: validated.input
      )
      output = response(id: id, outcome: "succeeded", result: result)
    } catch HelperFailure.rejected(let code) {
      output = response(id: id, outcome: "failed", errorCode: code)
    } catch {
      output = response(id: id, outcome: "failed", errorCode: "helper_error")
    }
    remember(id: id, output: output, expiresAt: validated.expiration)
    return output
  }

  private func validate(
    _ envelope: [String: Any],
    id: String
  ) throws -> (action: String, input: [String: Any], expiration: Date) {
    guard envelope.count == 4,
          isCommandId(id),
          let action = envelope["action"] as? String,
          Self.allowedActions.contains(action),
          let input = envelope["input"] as? [String: Any],
          let expiresAt = envelope["expiresAt"] as? String,
          let expiration = parseDate(expiresAt),
          expiration > Date(),
          expiration.timeIntervalSinceNow <= 300,
          JSONSerialization.isValidJSONObject(input),
          let bytes = try? JSONSerialization.data(withJSONObject: input),
          bytes.count <= Self.maximumInputBytes
    else { throw HelperFailure.rejected("invalid_command") }
    return (action, input, expiration)
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
    case "open_url":
      return try await openURL(input)
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

  private func openURL(_ input: [String: Any]) async throws -> [String: Any] {
    guard input.keys.allSatisfy({
            $0 == "browser" || $0 == "url" || $0 == "loadWaitSeconds"
          }),
          input.count == 2 || input.count == 3,
          let browser = input["browser"] as? String,
          let bundleIdentifier = SafeBrowserNavigationPolicy.bundleIdentifier(
            for: browser
          ),
          !Self.restrictedAutomationBundleIdentifiers.contains(bundleIdentifier),
          let rawURL = input["url"] as? String,
          let url = SafeBrowserNavigationPolicy.validatedURL(rawURL),
          let loadWaitSeconds = boundedLoadWaitSeconds(
            input["loadWaitSeconds"]
          ),
          let applicationURL = NSWorkspace.shared.urlForApplication(
            withBundleIdentifier: bundleIdentifier
          )
    else { throw HelperFailure.rejected("browser_navigation_refused") }

    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.createsNewApplicationInstance = false
    configuration.promptsUserIfNeeded = false
    let application = try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<NSRunningApplication, Error>) in
      NSWorkspace.shared.open(
        [url],
        withApplicationAt: applicationURL,
        configuration: configuration
      ) { openedApplication, error in
        guard error == nil,
              let openedApplication,
              openedApplication.bundleIdentifier == bundleIdentifier,
              openedApplication.activationPolicy == .regular
        else {
          continuation.resume(
            throwing: HelperFailure.rejected("browser_open_failed")
          )
          return
        }
        continuation.resume(returning: openedApplication)
      }
    }

    if loadWaitSeconds > 0 {
      try? await Task.sleep(
        nanoseconds: UInt64(loadWaitSeconds) * 1_000_000_000
      )
    }

    let postActionResult = try await observe(["includeScreenshot": false])
    guard let observation = postActionResult["observation"] as? [String: Any]
    else { throw HelperFailure.rejected("post_action_observation_failed") }
    let frontmost = NSWorkspace.shared.frontmostApplication
    let browserIsFrontmost = frontmost?.processIdentifier
        == application.processIdentifier
      && frontmost?.bundleIdentifier == bundleIdentifier
    let effectVerdict = SafeBrowserNavigationPolicy.effectVerdict(
      browserFrontmost: browserIsFrontmost
    )
    let effect: [String: Any] = [
      "kind": "browser_url_delivery",
      "browser": browser,
      "browserBundleId": bundleIdentifier,
      "navigationRequestAccepted": true,
      "browserFrontmostAfterWait": browserIsFrontmost,
      "pageLoadConfirmed": false,
      "verdict": effectVerdict,
    ]
    let summary = browserIsFrontmost
      ? "Chrome accepted the web address and was frontmost after the bounded wait. Inspect the fresh observation to determine the page state."
      : "Chrome accepted the web address, but it was not confirmed as frontmost after the bounded wait. Inspect the fresh observation before continuing."
    return result(
      summary: summary,
      data: ["effectVerdict": effectVerdict, "effect": effect],
      observation: observation
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
    elementIdentities.removeAll(keepingCapacity: true)
    let app = NSWorkspace.shared.frontmostApplication
    if let bundleId = app?.bundleIdentifier,
       Self.restrictedAutomationBundleIdentifiers.contains(bundleId) {
      throw HelperFailure.rejected("restricted_application_refused")
    }
    snapshotTargetApplication = app
    snapshotFrontmostPID = app?.processIdentifier
    snapshotFrontmostBundleIdentifier = app?.bundleIdentifier
    let applicationElement = app.map {
      AXUIElementCreateApplication($0.processIdentifier)
    }
    snapshotFocusedWindow = applicationElement.flatMap {
      axElementAttribute($0, kAXFocusedWindowAttribute as String)
    }
    snapshotFocusedElement = applicationElement.flatMap {
      axElementAttribute($0, kAXFocusedUIElementAttribute as String)
    }
    snapshotFocusedElementIdentity = snapshotFocusedElement.flatMap(elementIdentity)
    snapshotWindowIdentity = snapshotFocusedWindow.flatMap(elementIdentity)
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
    let identity = elementIdentity(element)
    if let identity { elementIdentities[identifier] = identity }
    let role = identity?.role ?? "AXElement"
    let subrole = identity?.subrole
    let secure = isSecure(role: role, subrole: subrole)
    let title = identity?.label
    let value = secure ? "[secure]" : identity?.value
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
          let element = elements[elementId],
          let identity = elementIdentities[elementId]
    else { throw HelperFailure.rejected("stale_or_invalid_element") }
    try verifyObservedTarget(
      revision: revision,
      expectedElement: element,
      expectedIdentity: identity
    )
    let status = AXUIElementPerformAction(element, kAXPressAction as CFString)
    guard status == .success else { throw HelperFailure.rejected("press_failed") }
    return result(summary: "Pressed the approved accessibility element.")
  }

  private func click(_ input: [String: Any]) throws -> [String: Any] {
    guard AXIsProcessTrusted() else { throw HelperFailure.rejected("accessibility_denied") }
    guard let revision = input["snapshotRevision"] as? String else {
      throw HelperFailure.rejected("invalid_input")
    }
    let point: CGPoint
    let expectedElement: AXUIElement
    let expectedIdentity: SnapshotElementIdentity
    if let elementId = input["elementId"] as? String,
       input.keys.allSatisfy({ $0 == "elementId" || $0 == "snapshotRevision" }),
       elementId.hasPrefix("e:\(revision.prefix(12)):"),
       let element = elements[elementId],
       let identity = elementIdentities[elementId],
       let targetFrame = frame(element) {
      point = CGPoint(x: targetFrame.midX, y: targetFrame.midY)
      expectedElement = element
      expectedIdentity = identity
    } else if let x = number(input["x"]),
              let y = number(input["y"]),
              input.keys.allSatisfy({ $0 == "x" || $0 == "y" || $0 == "snapshotRevision" }),
              pointIsOnActiveDisplay(CGPoint(x: x, y: y)),
              let observedTarget = observedTarget(at: CGPoint(x: x, y: y)) {
      point = CGPoint(x: x, y: y)
      expectedElement = observedTarget.element
      expectedIdentity = observedTarget.identity
    } else {
      throw HelperFailure.rejected("invalid_input")
    }
    try verifyObservedTarget(
      revision: revision,
      expectedElement: expectedElement,
      expectedIdentity: expectedIdentity
    )
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
    let focusTarget = try observedFocusTarget(requireFocusedElement: true)
    try verifyObservedTarget(
      revision: revision,
      expectedElement: focusTarget.element,
      expectedIdentity: focusTarget.identity
    )
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
    let focusTarget = try observedFocusTarget(requireFocusedElement: true)
    try verifyObservedTarget(
      revision: revision,
      expectedElement: focusTarget.element,
      expectedIdentity: focusTarget.identity
    )
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
    let focusTarget = try observedFocusTarget()
    try verifyObservedTarget(
      revision: revision,
      expectedElement: focusTarget.element,
      expectedIdentity: focusTarget.identity
    )
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

  private func cachedOutput(id: String) -> [String: Any]? {
    completedLock.lock()
    defer { completedLock.unlock() }
    purgeExpiredCompletionsLocked(at: Date())
    return completed[id]?.output
  }

  private func remember(id: String, output: [String: Any], expiresAt: Date) {
    completedLock.lock()
    defer { completedLock.unlock() }
    purgeExpiredCompletionsLocked(at: Date())
    guard expiresAt > Date() else {
      scheduleCompletionExpiryLocked()
      return
    }
    completed[id] = CompletedRequest(output: output, expiresAt: expiresAt)
    completionOrder.removeAll { $0 == id }
    completionOrder.append(id)
    while completionOrder.count > 128 {
      completed.removeValue(forKey: completionOrder.removeFirst())
    }
    scheduleCompletionExpiryLocked()
  }

  private func purgeExpiredCompletions() {
    completedLock.lock()
    defer { completedLock.unlock() }
    purgeExpiredCompletionsLocked(at: Date())
    scheduleCompletionExpiryLocked()
  }

  private func purgeExpiredCompletionsLocked(at now: Date) {
    completed = completed.filter { $0.value.expiresAt > now }
    completionOrder.removeAll { completed[$0] == nil }
  }

  private func scheduleCompletionExpiryLocked() {
    completionExpiryWorkItem?.cancel()
    completionExpiryWorkItem = nil
    guard let nextExpiry = completed.values.map(\.expiresAt).min() else { return }
    let work = DispatchWorkItem { [weak self] in
      self?.purgeExpiredCompletions()
    }
    completionExpiryWorkItem = work
    DispatchQueue.global(qos: .utility).asyncAfter(
      deadline: .now() + max(0, nextExpiry.timeIntervalSinceNow),
      execute: work
    )
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

  private func elementIdentity(_ element: AXUIElement) -> SnapshotElementIdentity? {
    guard let role = stringAttribute(element, kAXRoleAttribute as String) else { return nil }
    let subrole = stringAttribute(element, kAXSubroleAttribute as String)
    let secure = isSecure(role: role, subrole: subrole)
    let label = stringAttribute(element, kAXTitleAttribute as String)
      ?? stringAttribute(element, kAXDescriptionAttribute as String)
      ?? stringAttribute(element, kAXHelpAttribute as String)
    return SnapshotElementIdentity(
      role: bounded(role, limit: 80),
      subrole: subrole.map { bounded($0, limit: 80) },
      label: label.map { bounded($0, limit: 240) },
      value: secure ? "[secure]" : safeValue(element),
      frame: frame(element)
    )
  }

  private func observedFocusTarget(
    requireFocusedElement: Bool = false
  ) throws -> (element: AXUIElement, identity: SnapshotElementIdentity) {
    if let snapshotFocusedElement, let snapshotFocusedElementIdentity {
      return (snapshotFocusedElement, snapshotFocusedElementIdentity)
    }
    guard !requireFocusedElement,
          let snapshotFocusedWindow,
          let snapshotWindowIdentity
    else { throw HelperFailure.rejected("stale_observation") }
    return (snapshotFocusedWindow, snapshotWindowIdentity)
  }

  private func observedTarget(
    at point: CGPoint
  ) -> (element: AXUIElement, identity: SnapshotElementIdentity)? {
    var selected: (
      element: AXUIElement,
      identity: SnapshotElementIdentity,
      area: CGFloat,
      order: Int
    )?
    for (identifier, element) in elements {
      guard let identity = elementIdentities[identifier],
            let candidateFrame = identity.frame,
            candidateFrame.contains(point)
      else { continue }
      let candidateArea = max(1, candidateFrame.width * candidateFrame.height)
      let candidateOrder = Int(identifier.split(separator: ":").last ?? "0") ?? 0
      if let current = selected {
        if candidateArea < current.area
          || (candidateArea == current.area && candidateOrder > current.order) {
          selected = (element, identity, candidateArea, candidateOrder)
        }
      } else {
        selected = (element, identity, candidateArea, candidateOrder)
      }
    }
    guard let selected else { return nil }
    return (selected.element, selected.identity)
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
    sanitizedLocalComputerText(value, limit: limit)
  }

  private func number(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber else { return nil }
    let result = number.doubleValue
    return result.isFinite ? result : nil
  }

  private func boundedLoadWaitSeconds(_ value: Any?) -> Int? {
    guard let value else { return 3 }
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID()
    else { return nil }
    let candidate = number.doubleValue
    guard candidate.isFinite,
          candidate.rounded(.towardZero) == candidate,
          candidate >= 0,
          candidate <= 15
    else { return nil }
    return Int(candidate)
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

  private func verifyObservedTarget(
    revision: String,
    expectedElement: AXUIElement,
    expectedIdentity: SnapshotElementIdentity
  ) throws {
    guard revision.count == 64,
          revision == snapshotRevision,
          revision.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
          let targetApplication = snapshotTargetApplication,
          let expectedPID = snapshotFrontmostPID,
          targetApplication.processIdentifier == expectedPID,
          !targetApplication.isTerminated,
          targetApplication.bundleIdentifier == snapshotFrontmostBundleIdentifier,
          activeDisplayBounds() == snapshotDisplayBounds,
          !Self.restrictedAutomationBundleIdentifiers.contains(
            snapshotFrontmostBundleIdentifier ?? ""
          )
    else { throw HelperFailure.rejected("stale_observation") }

    let frontmost = NSWorkspace.shared.frontmostApplication
    let focusedWindowMatches = currentFocusedWindow(pid: expectedPID).map { currentWindow in
      snapshotFocusedWindow.map { CFEqual($0, currentWindow) } ?? true
    } ?? (snapshotFocusedWindow == nil)
    let disposition = FocusSafeSnapshotPolicy.disposition(
      expectedPID: expectedPID,
      expectedBundleIdentifier: snapshotFrontmostBundleIdentifier,
      currentPID: frontmost?.processIdentifier,
      currentBundleIdentifier: frontmost?.bundleIdentifier,
      focusedWindowMatches: focusedWindowMatches,
      trustedHostPID: trustedHostPID,
      trustedHostBundleIdentifier: ParentVerifier.parentIdentifier
    )
    switch disposition {
    case .alreadyFocused:
      break
    case .restoreFromTrustedHost:
      try restoreObservedTarget(targetApplication)
    case .stale:
      throw HelperFailure.rejected("stale_observation")
    }

    guard revision == snapshotRevision,
          let currentFrontmost = NSWorkspace.shared.frontmostApplication,
          currentFrontmost.processIdentifier == expectedPID,
          currentFrontmost.bundleIdentifier == snapshotFrontmostBundleIdentifier,
          activeDisplayBounds() == snapshotDisplayBounds,
          observedWindowIsCurrent(pid: expectedPID)
    else { throw HelperFailure.rejected("stale_observation") }

    let application = AXUIElementCreateApplication(expectedPID)
    let refreshedIdentity: SnapshotElementIdentity?
    if let snapshotFocusedElement,
       CFEqual(snapshotFocusedElement, expectedElement) {
      guard let currentFocusedElement = axElementAttribute(
        application,
        kAXFocusedUIElementAttribute as String
      ), CFEqual(currentFocusedElement, expectedElement) else {
        throw HelperFailure.rejected("stale_observation")
      }
      refreshedIdentity = elementIdentity(currentFocusedElement)
    } else {
      let root = currentFocusedWindow(pid: expectedPID) ?? application
      var visited = 0
      refreshedIdentity = findRefreshedIdentity(
        for: expectedElement,
        in: root,
        depth: 0,
        visited: &visited
      )
    }
    guard refreshedIdentity == expectedIdentity else {
      throw HelperFailure.rejected("stale_observation")
    }
  }

  private func restoreObservedTarget(_ application: NSRunningApplication) throws {
    guard application.activationPolicy == .regular,
          !application.isTerminated,
          application.processIdentifier == snapshotFrontmostPID,
          application.bundleIdentifier == snapshotFrontmostBundleIdentifier
    else { throw HelperFailure.rejected("stale_observation") }

    _ = application.activate(options: [.activateAllWindows])
    let accessibilityApplication = AXUIElementCreateApplication(application.processIdentifier)
    if let snapshotFocusedWindow {
      _ = AXUIElementPerformAction(snapshotFocusedWindow, kAXRaiseAction as CFString)
      _ = AXUIElementSetAttributeValue(
        accessibilityApplication,
        kAXFocusedWindowAttribute as CFString,
        snapshotFocusedWindow
      )
    }

    let deadline = Date().addingTimeInterval(0.75)
    repeat {
      if NSWorkspace.shared.frontmostApplication?.processIdentifier
          == application.processIdentifier,
         observedWindowIsCurrent(pid: application.processIdentifier) {
        return
      }
      Thread.sleep(forTimeInterval: 0.025)
    } while Date() < deadline
    throw HelperFailure.rejected("stale_observation")
  }

  private func currentFocusedWindow(pid: pid_t) -> AXUIElement? {
    axElementAttribute(
      AXUIElementCreateApplication(pid),
      kAXFocusedWindowAttribute as String
    )
  }

  private func observedWindowIsCurrent(pid: pid_t) -> Bool {
    guard let snapshotFocusedWindow else { return true }
    guard let currentWindow = currentFocusedWindow(pid: pid) else { return false }
    return CFEqual(snapshotFocusedWindow, currentWindow)
  }

  private func findRefreshedIdentity(
    for target: AXUIElement,
    in element: AXUIElement,
    depth: Int,
    visited: inout Int
  ) -> SnapshotElementIdentity? {
    guard depth <= Self.maximumSnapshotDepth,
          visited < Self.maximumSnapshotNodes
    else { return nil }
    visited += 1
    if CFEqual(target, element) { return elementIdentity(element) }
    guard let children = copyAttribute(element, kAXChildrenAttribute as String) as? [AXUIElement]
    else { return nil }
    for child in children.prefix(80) {
      if let identity = findRefreshedIdentity(
        for: target,
        in: child,
        depth: depth + 1,
        visited: &visited
      ) {
        return identity
      }
      if visited >= Self.maximumSnapshotNodes { break }
    }
    return nil
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

#if !ASAEL_COMPUTER_USE_HELPER_TESTING
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
#endif
