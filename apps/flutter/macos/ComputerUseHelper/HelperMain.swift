import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import CryptoKit
import Darwin
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

/// The only coordinate bridge accepted for image-based clicks.
///
/// ScreenCaptureKit returns image pixels while Accessibility and CGEvent use
/// macOS global logical coordinates. The captured display's logical bounds and
/// the *actual* CGImage dimensions define one reversible affine mapping. A
/// click must carry the same snapshot revision and a point inside that exact
/// image; raw global coordinates are never accepted as screenshot coordinates.
struct ScreenshotCoordinateMapping: Equatable {
  static let screenshotSpace = "screenshot_pixel"
  static let targetSpace = "macos_global_logical_top_left"

  let snapshotRevision: String
  let displayID: CGDirectDisplayID
  let displayLogicalBounds: CGRect
  let imageWidth: Int
  let imageHeight: Int
  let logicalPointsPerPixelX: Double
  let logicalPointsPerPixelY: Double

  init?(
    snapshotRevision: String,
    displayID: CGDirectDisplayID,
    displayLogicalBounds: CGRect,
    imageWidth: Int,
    imageHeight: Int
  ) {
    guard snapshotRevision.count == 64,
          snapshotRevision.range(
            of: #"^[a-f0-9]{64}$"#,
            options: .regularExpression
          ) != nil,
          displayID > 0,
          displayLogicalBounds.origin.x.isFinite,
          displayLogicalBounds.origin.y.isFinite,
          displayLogicalBounds.width.isFinite,
          displayLogicalBounds.height.isFinite,
          displayLogicalBounds.width > 0,
          displayLogicalBounds.height > 0,
          imageWidth > 0,
          imageHeight > 0,
          imageWidth <= 32_768,
          imageHeight <= 32_768
    else { return nil }

    let scaleX = displayLogicalBounds.width / Double(imageWidth)
    let scaleY = displayLogicalBounds.height / Double(imageHeight)
    guard scaleX.isFinite, scaleY.isFinite, scaleX > 0, scaleY > 0,
          scaleX <= 64, scaleY <= 64
    else { return nil }

    self.snapshotRevision = snapshotRevision
    self.displayID = displayID
    self.displayLogicalBounds = displayLogicalBounds
    self.imageWidth = imageWidth
    self.imageHeight = imageHeight
    self.logicalPointsPerPixelX = scaleX
    self.logicalPointsPerPixelY = scaleY
  }

  func globalLogicalPoint(
    screenshotX: Double,
    screenshotY: Double,
    revision: String
  ) -> CGPoint? {
    guard revision == snapshotRevision,
          screenshotX.isFinite,
          screenshotY.isFinite,
          screenshotX >= 0,
          screenshotY >= 0,
          screenshotX < Double(imageWidth),
          screenshotY < Double(imageHeight)
    else { return nil }
    let x = displayLogicalBounds.minX + screenshotX * logicalPointsPerPixelX
    let y = displayLogicalBounds.minY + screenshotY * logicalPointsPerPixelY
    guard x.isFinite, y.isFinite else { return nil }
    return CGPoint(x: x, y: y)
  }
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
          isPublicBrowserHost(host),
          let url = components.url,
          url.scheme?.lowercased() == scheme,
          url.host != nil
    else { return nil }
    return url
  }

  private static func isPublicBrowserHost(_ rawHost: String) -> Bool {
    var host = rawHost.lowercased().trimmingCharacters(
      in: CharacterSet(charactersIn: ".")
    )
    if host.hasPrefix("[") && host.hasSuffix("]") {
      host = String(host.dropFirst().dropLast())
    }
    guard !host.isEmpty,
          host != "localhost",
          !host.hasSuffix(".localhost")
    else { return false }

    // Chrome accepts legacy integer, octal, and hexadecimal IPv4 spellings.
    // Foundation does not consistently canonicalize those forms, so reject
    // numeric-looking hostnames rather than letting the browser reinterpret one.
    let components = host.split(separator: ".", omittingEmptySubsequences: false)
    if components.count <= 4 && components.allSatisfy(isLegacyIPv4Component) {
      guard components.count == 4,
            components.allSatisfy({ component in
              (component == "0" || !component.hasPrefix("0")) &&
                component.allSatisfy({ $0.isNumber })
            }),
            let bytes = addressBytes(host, family: AF_INET, count: 4)
      else { return false }
      return isGloballyRoutableIPv4(bytes)
    }
    if let bytes = addressBytes(host, family: AF_INET6, count: 16) {
      return isGloballyRoutableIPv6(bytes)
    }
    return true
  }

  private static func isLegacyIPv4Component(_ component: Substring) -> Bool {
    guard !component.isEmpty else { return false }
    let lowercased = component.lowercased()
    if lowercased.hasPrefix("0x") {
      let hexadecimal = lowercased.dropFirst(2)
      return !hexadecimal.isEmpty && hexadecimal.allSatisfy({ $0.isHexDigit })
    }
    return component.allSatisfy({ $0.isNumber })
  }

  private static func addressBytes(
    _ host: String,
    family: Int32,
    count: Int
  ) -> [UInt8]? {
    var bytes = [UInt8](repeating: 0, count: count)
    let parsed = bytes.withUnsafeMutableBytes { buffer in
      inet_pton(family, host, buffer.baseAddress)
    }
    return parsed == 1 ? bytes : nil
  }

  private static func isGloballyRoutableIPv4(_ bytes: [UInt8]) -> Bool {
    guard bytes.count == 4 else { return false }
    let first = Int(bytes[0])
    let second = Int(bytes[1])
    let third = Int(bytes[2])
    if first == 0 || first == 10 || first == 127 || first >= 224 ||
        (first == 100 && second >= 64 && second <= 127) ||
        (first == 169 && second == 254) ||
        (first == 172 && second >= 16 && second <= 31) ||
        (first == 192 && second == 0 && third == 0) ||
        (first == 192 && second == 0 && third == 2) ||
        (first == 192 && second == 88 && third == 99) ||
        (first == 192 && second == 168) ||
        (first == 198 && (second == 18 || second == 19)) ||
        (first == 198 && second == 51 && third == 100) ||
        (first == 203 && second == 0 && third == 113) {
      return false
    }
    return true
  }

  private static func isGloballyRoutableIPv6(_ bytes: [UInt8]) -> Bool {
    guard bytes.count == 16, bytes[0] & 0xe0 == 0x20 else { return false }
    if bytes[0] == 0x20 && bytes[1] == 0x01 {
      if bytes[2] & 0xfe == 0 { return false } // 2001:0000::/23
      if bytes[2] == 0x0d && bytes[3] == 0xb8 { return false }
    }
    if bytes[0] == 0x20 && bytes[1] == 0x02 { return false } // deprecated 6to4
    if bytes[0] == 0x3f && bytes[1] == 0xff && bytes[2] & 0xf0 == 0 {
      return false // 3fff::/20 documentation
    }
    return true
  }

  static func effectVerdict(browserObservationConfirmed: Bool) -> String {
    browserObservationConfirmed ? "confirmed" : "unverifiable"
  }

  static func matchesExpectedApplication(
    expectedPID: pid_t,
    expectedBundleIdentifier: String,
    observedPID: pid_t?,
    observedBundleIdentifier: String?
  ) -> Bool {
    observedPID == expectedPID
      && observedBundleIdentifier == expectedBundleIdentifier
  }
}

enum SnapshotPixelHitDisposition: Equatable {
  case exactSnapshotElement
  case refuse
}

enum SnapshotPixelHitPolicy {
  static func disposition(
    hitFound: Bool,
    hitBelongsToSnapshot: Bool,
    identityMatches: Bool
  ) -> SnapshotPixelHitDisposition {
    hitFound && hitBelongsToSnapshot && identityMatches
      ? .exactSnapshotElement
      : .refuse
  }
}

/// One Accessibility element on the path from what a task-authorized action
/// would really touch up to the observed window. Only the role, subrole, and
/// visible labels are read, and none of them leave the helper.
struct TaskAuthorityElement: Equatable {
  let role: String
  let subrole: String?
  let labels: [String]
}

enum TaskAuthorityKeyDisposition: Equatable {
  case allow
  // Space presses the focused control, so that control is checked like a click.
  case checkFocusedTarget
  case refuse
}

/// Decides whether a press, click, key, or type that runs on This Mac task
/// authority alone may touch its real on-screen target. The user approved the
/// task, not this control, so the helper refuses anything inside a dialog, a
/// control it cannot name, and any target whose visible words send, buy,
/// delete, grant, sign in, or confirm. The server then offers the refused
/// action for the user's review.
///
/// The lexicon is English-only. A control named in another language is still
/// refused inside a dialog, when it has no name, or when its role is unknown,
/// but its words are not read.
enum TaskAuthorityTargetPolicy {
  static let actions: Set<String> = ["press", "click", "key", "type"]
  // Mirrors the server's limit, which counts UTF-16 code units.
  static let maximumTypedUnits = 500

  static let textEntryRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]

  private static let actionableRoles: Set<String> = [
    "AXButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXMenuButton",
    "AXPopUpButton", "AXCheckBox", "AXRadioButton", "AXDisclosureTriangle",
    "AXIncrementor", "AXSlider", "AXColorWell",
  ]
  private static let passiveRoles: Set<String> = [
    "AXStaticText", "AXImage", "AXGroup", "AXRow", "AXCell", "AXColumn",
    "AXList", "AXTable", "AXOutline", "AXGrid", "AXBrowser", "AXScrollArea",
    "AXSplitGroup", "AXTabGroup", "AXToolbar", "AXLayoutArea", "AXLayoutItem",
    "AXHeading", "AXScrollBar", "AXValueIndicator", "AXProgressIndicator",
    "AXBusyIndicator", "AXLevelIndicator",
  ]
  private static let dialogRoles: Set<String> = ["AXSheet", "AXPopover"]
  private static let dialogSubroles: Set<String> = [
    "AXDialog", "AXSystemDialog", "AXFloatingWindow", "AXSystemFloatingWindow",
    "AXApplicationDialog", "AXApplicationAlertDialog", "AXApplicationAlert",
  ]
  // A navigation key changes the value of these controls instead of moving.
  private static let valueControlRoles: Set<String> = [
    "AXSlider", "AXIncrementor", "AXRadioButton", "AXPopUpButton",
    "AXMenuButton", "AXDateField", "AXTimeField", "AXColorWell",
    "AXLevelIndicator",
  ]
  private static let lexiconWords: Set<String> = [
    // Communicating on the user's behalf.
    "send", "resend", "unsend", "submit", "post", "repost", "publish", "share",
    "reply", "respond", "comment", "tweet", "retweet", "invite", "call", "dial",
    "notify", "announce", "broadcast", "schedule",
    // Spending, trading, or committing money.
    "buy", "purchase", "order", "pay", "payment", "checkout", "donate", "tip",
    "sponsor", "gift", "transfer", "withdraw", "deposit", "bid", "sell",
    "trade", "swap", "stake", "invest", "borrow", "lend", "book", "reserve",
    "rent", "upgrade", "renew", "redeem", "claim", "trial", "subscribe",
    "unsubscribe",
    // Destroying, discarding, or replacing.
    "delete", "remove", "erase", "trash", "discard", "destroy", "wipe",
    "empty", "clear", "reset", "revoke", "uninstall", "deactivate",
    "disconnect", "unlink", "unpair", "forget", "purge", "drop", "kill",
    "terminate", "abort", "cancel", "close", "archive", "overwrite",
    "replace", "format", "restore", "revert", "rollback",
    // Acting publicly on someone or something.
    "follow", "unfollow", "like", "unlike", "vote", "upvote", "downvote",
    "rate", "rsvp", "star", "unstar", "fork", "report", "block", "unblock",
    "flag", "spam", "leave", "unmute", "join",
    // Signing in, granting, or consenting.
    "sign", "signin", "signup", "signout", "login", "logout", "register",
    "enroll", "accept", "agree", "allow", "approve", "authorize", "authorise",
    "grant", "permit", "consent", "trust", "reject", "decline", "deny",
    "confirm", "verify", "connect", "pair", "enable", "disable", "unlock",
    "activate",
    // Changing the system, files, or deployed work.
    "install", "update", "apply", "save", "merge", "deploy", "commit", "push",
    "release", "promote", "run", "execute", "trigger", "rerun", "retry",
    "upload", "download", "export", "import", "attach", "print", "eject",
    "quit", "exit", "shutdown", "restart", "reboot", "record",
    // Confirming whatever is pending.
    "ok", "okay", "yes", "proceed", "continue", "finish", "complete", "done",
  ]
  // Phrases whose words are harmless alone.
  private static let lexiconPhrases: [String] = [
    "check out", "check in", "log in", "log on", "log out", "log off",
    "hang up", "turn on", "turn off", "i understand", "add friend", "add card",
    "add funds", "top up", "go live", "shut down", "opt in", "opt out",
    "create account", "open account", "link account", "switch account",
    "choose file", "select file", "start meeting", "end meeting",
  ]

  /// Whether a command envelope runs on task authority alone, or nil when the
  /// marker is malformed or sits on an action the helper cannot check.
  static func envelopeAuthority(_ envelope: [String: Any]) -> Bool? {
    guard let marker = envelope["authority"] else {
      return envelope.count == 4 ? false : nil
    }
    guard envelope.count == 5,
          marker as? String == "task",
          let action = envelope["action"] as? String,
          actions.contains(action)
    else { return nil }
    return true
  }

  /// A press or click lands on `path[0]`, and `path` climbs through every
  /// ancestor to the observed window, which comes last.
  static func allowsPointer(path: [TaskAuthorityElement]) -> Bool {
    guard let hit = path.first, path.last?.role == "AXWindow",
          !path.contains(where: isDialog)
    else { return false }
    // Page and window titles name the place, not the control.
    let contentEnd = path.firstIndex {
      $0.role == "AXWebArea" || $0.role == "AXWindow"
    } ?? path.endIndex
    let content = path[..<contentEnd]
    guard !content.isEmpty,
          !content.contains(where: {
            isSecure(role: $0.role, subrole: $0.subrole)
              || $0.labels.contains(where: lexiconHit)
          })
    else { return false }
    if let controlIndex = content.firstIndex(where: {
      textEntryRoles.contains($0.role) || actionableRoles.contains($0.role)
    }) {
      let control = content[controlIndex]
      if textEntryRoles.contains(control.role) { return true }
      guard control.subrole != "AXCloseButton" else { return false }
      return content[...controlIndex].contains {
        $0.labels.contains(where: hasWord)
      }
    }
    return passiveRoles.contains(hit.role) && hit.labels.contains(where: hasWord)
  }

  static func allowsTyping(role: String, subrole: String?, text: String) -> Bool {
    textEntryRoles.contains(role)
      && !isSecure(role: role, subrole: subrole)
      && !text.isEmpty
      && text.utf16.count <= maximumTypedUnits
      && !text.unicodeScalars.contains {
        $0.value < 0x20 || (0x7f...0x9f).contains($0.value)
          || $0.value == 0x2028 || $0.value == 0x2029
      }
  }

  static func keyDisposition(
    name: String,
    modifiers: [String],
    focusedRole: String
  ) -> TaskAuthorityKeyDisposition {
    if !modifiers.isEmpty {
      return (modifiers == ["shift"] && name == "tab")
          || (modifiers == ["command"] && name == "home")
        ? .allow
        : .refuse
    }
    switch name {
    case "tab", "escape":
      return .allow
    case "left", "right", "up", "down", "home", "end", "page_up", "page_down":
      return valueControlRoles.contains(focusedRole) ? .refuse : .allow
    case "space":
      return focusedRole == "AXWebArea" || focusedRole == "AXScrollArea"
          || textEntryRoles.contains(focusedRole)
        ? .allow
        : .checkFocusedTarget
    default:
      // Return and Delete commit or destroy whatever has focus.
      return .refuse
    }
  }

  static func lexiconHit(_ label: String) -> Bool {
    var normalized = String.UnicodeScalarView()
    for scalar in label.lowercased().unicodeScalars {
      normalized.append(CharacterSet.alphanumerics.contains(scalar) ? scalar : " ")
    }
    let tokens = String(normalized).split(separator: " ").map(String.init)
    if tokens.contains(where: { stems($0).contains(where: lexiconWords.contains) }) {
      return true
    }
    let joined = " " + tokens.joined(separator: " ") + " "
    return lexiconPhrases.contains { joined.contains(" \($0) ") }
  }

  /// The token plus the bases of its plural, past, and progressive forms, so a
  /// state label such as "Following" or "Subscribed" is read as its verb.
  private static func stems(_ token: String) -> [String] {
    var candidates = [token]
    func addBase(_ base: String) {
      candidates.append(base)
      candidates.append(base + "e")
      if let last = base.last, base.count >= 3,
         base.dropLast().last == last, !"aeiou".contains(last) {
        candidates.append(String(base.dropLast()))
      }
    }
    if token.count > 4, token.hasSuffix("ies") || token.hasSuffix("ied") {
      candidates.append(String(token.dropLast(3)) + "y")
    }
    if token.count > 3, token.hasSuffix("es") {
      candidates.append(String(token.dropLast(2)))
    }
    if token.count > 2, token.hasSuffix("s") {
      candidates.append(String(token.dropLast()))
    }
    if token.count > 3, token.hasSuffix("ed") {
      addBase(String(token.dropLast(2)))
    }
    if token.count > 4, token.hasSuffix("ing") {
      addBase(String(token.dropLast(3)))
    }
    return candidates
  }

  private static func isDialog(_ element: TaskAuthorityElement) -> Bool {
    dialogRoles.contains(element.role)
      || element.subrole.map(dialogSubroles.contains) ?? false
  }

  private static func isSecure(role: String, subrole: String?) -> Bool {
    role.localizedCaseInsensitiveContains("secure")
      || (subrole?.localizedCaseInsensitiveContains("secure") ?? false)
  }

  private static func hasWord(_ label: String) -> Bool {
    label.unicodeScalars.contains(where: CharacterSet.alphanumerics.contains)
  }
}

/// Applications the agent never observes or drives on This Mac, by category:
/// shells and terminals, system and security settings, automation tools,
/// credential managers, and any app filed under finance. Bundle identifiers
/// are compared without regard to case, as LaunchServices compares them.
enum RestrictedApplicationPolicy {
  static let shells: Set<String> = [
    "co.zeit.hyper", "com.apple.terminal", "com.github.wez.wezterm", "com.googlecode.iterm2",
    "com.mitchellh.ghostty", "dev.warp.warp-stable", "net.kovidgoyal.kitty", "org.alacritty",
    "org.tabby",
  ]
  static let systemAndSecurity: Set<String> = [
    "com.apple.activitymonitor", "com.apple.console", "com.apple.coreservices.uiagent",
    "com.apple.directoryutility", "com.apple.diskutility", "com.apple.installer",
    "com.apple.keychainaccess", "com.apple.localauthentication.uiagent",
    "com.apple.migrateassistant", "com.apple.passwords", "com.apple.securityagent",
    "com.apple.systempreferences", "com.apple.systemsettings", "com.apple.usernotificationcenter",
  ]
  static let automation: Set<String> = [
    "com.apple.automator", "com.apple.scripteditor2", "com.apple.shortcuts",
  ]
  static let credentialApplications: Set<String> = [
    "com.hicknhacksoftware.macpass", "com.outercorner.secrets",
  ]
  /// Makers of credential managers and authenticators. Every app a listed
  /// maker ships is refused, so a new edition is refused as well.
  static let credentialVendors: Set<String> = [
    "com.1password", "com.agilebits", "com.authy", "com.bitwarden", "com.dashlane",
    "com.keepersecurity", "com.lastpass", "com.markmcguill", "com.nordsec", "in.sinew",
    "me.proton.pass", "org.keepassxc",
  ]
  static let financeCategory = "public.app-category.finance"
  /// The App Store genre of finance apps. An iPhone or iPad app on the Mac
  /// records it in its store metadata instead of declaring a category.
  static let financeStoreGenre = 6015
  /// Browsers whose pages are read, so that a settings, saved-password,
  /// extension, or developer-tools page is refused like an application.
  static let browsers: Set<String> = [
    "com.apple.safari", "com.apple.safaritechnologypreview", "com.brave.browser",
    "com.google.chrome", "com.google.chrome.beta", "com.google.chrome.canary",
    "com.google.chrome.dev", "com.microsoft.edgemac", "com.operasoftware.opera",
    "com.vivaldi.vivaldi", "company.thebrowser.browser", "org.chromium.chromium",
    "org.mozilla.firefox",
  ]
  private static let webPageSchemes: Set<String> = ["blob", "data", "file", "http", "https"]
  private static let newTabPages: Set<String> = [
    "about:blank", "about:home", "about:newtab", "brave://newtab", "chrome://new-tab-page",
    "chrome://newtab", "edge://newtab", "favorites:", "opera://startpage", "topsites:",
    "vivaldi://startpage",
  ]

  static func refuses(_ application: NSRunningApplication) -> Bool {
    let bundleURL = application.bundleURL
    return refuses(
      bundleIdentifier: application.bundleIdentifier,
      declaredCategory: bundleURL.flatMap(declaredCategory(ofBundleAt:)),
      storeGenre: bundleURL.flatMap(storeGenre(ofBundleAt:))
    )
  }

  static func refuses(
    bundleIdentifier: String?,
    declaredCategory: String?,
    storeGenre: Int?
  ) -> Bool {
    if declaredCategory?.lowercased() == financeCategory || storeGenre == financeStoreGenre {
      return true
    }
    guard let identifier = bundleIdentifier?.lowercased() else { return false }
    return shells.contains(identifier)
      || systemAndSecurity.contains(identifier)
      || automation.contains(identifier)
      || credentialApplications.contains(identifier)
      || credentialVendors.contains { identifier == $0 || identifier.hasPrefix($0 + ".") }
  }

  static func declaredCategory(ofBundleAt url: URL) -> String? {
    Bundle(url: url)?.object(forInfoDictionaryKey: "LSApplicationCategoryType") as? String
  }

  /// An iPhone or iPad app on the Mac sits in a Wrapper folder beside its
  /// store metadata, and the running app may report either bundle.
  static func storeGenre(ofBundleAt bundleURL: URL) -> Int? {
    let url = bundleURL.resolvingSymlinksInPath()
    let wrapper = url.deletingLastPathComponent().lastPathComponent == "Wrapper"
      ? url.deletingLastPathComponent()
      : url.appendingPathComponent("Wrapper", isDirectory: true)
    guard let data = try? Data(
            contentsOf: wrapper.appendingPathComponent("iTunesMetadata.plist")
          ),
          let metadata = try? PropertyListSerialization.propertyList(
            from: data,
            format: nil
          ) as? [String: Any]
    else { return nil }
    return (metadata["genreId"] as? NSNumber)?.intValue
  }

  static func readsPages(ofBundleIdentifier bundleIdentifier: String?) -> Bool {
    bundleIdentifier.map { browsers.contains($0.lowercased()) } ?? false
  }

  /// Web pages, local files, and a blank or new tab are the only browser
  /// pages the agent may see or act in.
  static func refusesPage(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased() else { return true }
    if webPageSchemes.contains(scheme) { return false }
    var page = url.absoluteString.lowercased()
    while page.hasSuffix("/") { page.removeLast() }
    return !newTabPages.contains(page)
  }

  /// The agent may look at Asael's own window but never act in it, where an
  /// action could answer the agent's own approval request.
  static func isTrustedHost(
    pid: pid_t,
    bundleIdentifier: String?,
    trustedHostPID: pid_t,
    trustedHostBundleIdentifier: String
  ) -> Bool {
    pid == trustedHostPID
      || bundleIdentifier?.lowercased() == trustedHostBundleIdentifier.lowercased()
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

  private struct CapturedScreenshot {
    let payload: [String: Any]
    let coordinateMapping: ScreenshotCoordinateMapping
  }

  private static let allowedActions: Set<String> = [
    "status", "request_permissions", "observe", "list_apps", "activate_app",
    "open_url", "press", "click", "type", "key", "scroll",
  ]
  // An action that runs on This Mac task authority alone carries
  // `authority: "task"`. The helper then checks its real on-screen target and
  // refuses one that task authority does not cover, before any event is posted.
  private static let taskAuthorityRefused = "task_authority_refused"
  // A task-authorized target is read up to its window within this bound, or
  // the action is refused. Chromium nests page content deeply.
  private static let maximumTaskAuthorityPathLength = 64
  private static let taskAuthorityPathBudgetSeconds = 1.5
  private static let maximumTaskAuthorityLabelLength = 1_000
  // A browser page is found within these bounds or the page is not checked.
  private static let maximumBrowserPageSearchNodes = 300
  private static let browserPageSearchBudgetSeconds = 0.4
  private static let browserPageLeafRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXImage", "AXLink", "AXMenu", "AXMenuBar", "AXMenuButton",
    "AXPopUpButton", "AXRadioButton", "AXSlider", "AXStaticText", "AXTextArea", "AXTextField",
    "AXToolbar",
  ]
  private static let maximumInputBytes = 64 * 1_024
  private static let maximumTextUnits = 4_000
  private static let maximumSnapshotNodes = 260
  private static let maximumSnapshotDepth = 8
  private static let maximumSnapshotBytes = 96 * 1_024
  private static let maximumScreenshotBytes = 1_300_000
  // Chromium can leave Accessibility IPCs waiting for the system default
  // timeout. A screenshot click must finish its live verification while the
  // command lease is still valid, or fail closed without posting an event.
  private static let liveAccessibilityTimeoutSeconds: Float = 0.25
  private static let maximumHitTargetAncestorDepth = 16
  private static let postActionAccessibilityBudgetSeconds = 1.25

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
  private var snapshotScreenshotMapping: ScreenshotCoordinateMapping?
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

    let validated: (
      action: String,
      input: [String: Any],
      expiration: Date,
      taskAuthority: Bool
    )
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
        input: validated.input,
        taskAuthority: validated.taskAuthority
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
  ) throws -> (
    action: String,
    input: [String: Any],
    expiration: Date,
    taskAuthority: Bool
  ) {
    guard let taskAuthority = TaskAuthorityTargetPolicy.envelopeAuthority(envelope),
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
    return (action, input, expiration, taskAuthority)
  }

  private func perform(
    action: String,
    input: [String: Any],
    taskAuthority: Bool
  ) async throws -> [String: Any] {
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
      return try await activateApp(input)
    case "open_url":
      return try await openURL(input)
    case "observe":
      return try await observe(input)
    case "press":
      return try await press(input, taskAuthority: taskAuthority)
    case "click":
      return try await click(input, taskAuthority: taskAuthority)
    case "type":
      return try await typeText(input, taskAuthority: taskAuthority)
    case "key":
      return try await key(input, taskAuthority: taskAuthority)
    case "scroll":
      return try await scroll(input)
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

  private func activateApp(_ input: [String: Any]) async throws -> [String: Any] {
    guard input.count == 1,
          let bundleId = input["bundleId"] as? String,
          isSafeIdentifier(bundleId),
          let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first,
          app.activationPolicy == .regular,
          !refusesTarget(app)
    else { throw HelperFailure.rejected("application_not_allowed") }
    guard app.activate(options: [.activateAllWindows]) else {
      throw HelperFailure.rejected("activation_failed")
    }
    return await postActionResult(
      summary: "Activated \(bounded(app.localizedName ?? "application", limit: 100)).",
      data: ["bundleId": bundleId],
      expectedApplication: app,
      expectedBundleIdentifier: bundleId
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
          !RestrictedApplicationPolicy.refuses(
            bundleIdentifier: bundleIdentifier,
            declaredCategory: nil,
            storeGenre: nil
          ),
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

    // The URL open is already an external effect once LaunchServices returns.
    // A failed or focus-shifted readback must therefore become unverifiable,
    // never turn the action into a replayable failure and never disclose the
    // Accessibility tree of whichever unrelated app became frontmost.
    let postActionResult = try? await observe(
      ["includeScreenshot": true],
      expectedApplication: application,
      expectedBundleIdentifier: bundleIdentifier
    )
    let observation = postActionResult?["observation"] as? [String: Any]
    let frontmost = NSWorkspace.shared.frontmostApplication
    let browserIsFrontmost = SafeBrowserNavigationPolicy.matchesExpectedApplication(
      expectedPID: application.processIdentifier,
      expectedBundleIdentifier: bundleIdentifier,
      observedPID: frontmost?.processIdentifier,
      observedBundleIdentifier: frontmost?.bundleIdentifier
    )
    let browserObservationConfirmed = observation != nil
    let effectVerdict = SafeBrowserNavigationPolicy.effectVerdict(
      browserObservationConfirmed: browserObservationConfirmed
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
    let summary = browserObservationConfirmed
      ? "Chrome accepted the web address and the exact browser was observed after the bounded wait. Inspect the fresh observation to determine the page state."
      : "Chrome accepted the web address, but an exact browser observation could not be confirmed after the bounded wait. Observe the Mac again before continuing."
    return result(
      summary: summary,
      data: ["effectVerdict": effectVerdict, "effect": effect],
      observation: observation
    )
  }

  private func observe(
    _ input: [String: Any],
    expectedApplication: NSRunningApplication? = nil,
    expectedBundleIdentifier: String? = nil,
    accessibilityDeadline: Date? = nil
  ) async throws -> [String: Any] {
    guard input.keys.allSatisfy({ $0 == "includeScreenshot" }),
          input["includeScreenshot"] == nil || input["includeScreenshot"] is Bool
    else { throw HelperFailure.rejected("invalid_input") }
    guard AXIsProcessTrusted() else { throw HelperFailure.rejected("accessibility_denied") }

    snapshotCounter += 1
    snapshotRevision = revisionToken(counter: snapshotCounter)
    elements.removeAll(keepingCapacity: true)
    elementIdentities.removeAll(keepingCapacity: true)
    let app = NSWorkspace.shared.frontmostApplication
    if let expectedApplication {
      guard let expectedBundleIdentifier,
            SafeBrowserNavigationPolicy.matchesExpectedApplication(
              expectedPID: expectedApplication.processIdentifier,
              expectedBundleIdentifier: expectedBundleIdentifier,
              observedPID: app?.processIdentifier,
              observedBundleIdentifier: app?.bundleIdentifier
            )
      else { throw HelperFailure.rejected("post_action_target_changed") }
    } else if expectedBundleIdentifier != nil {
      throw HelperFailure.rejected("invalid_input")
    }
    if let app, RestrictedApplicationPolicy.refuses(app) {
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
    if let app, let snapshotFocusedWindow,
       showsRestrictedPage(app, window: snapshotFocusedWindow) {
      snapshotTargetApplication = nil
      throw HelperFailure.rejected("restricted_page_refused")
    }
    snapshotFocusedElementIdentity = snapshotFocusedElement.flatMap(elementIdentity)
    snapshotWindowIdentity = snapshotFocusedWindow.flatMap(elementIdentity)
    snapshotDisplayBounds = activeDisplayBounds()
    snapshotScreenshotMapping = nil
    let frontmost = app.map(frontmostApplication)
    let accessibility = app.map {
      accessibilitySnapshot(
        pid: $0.processIdentifier,
        deadline: accessibilityDeadline
      )
    }
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
      snapshotScreenshotMapping = screenshot.coordinateMapping
      observation["screenshot"] = screenshot.payload
    }
    if expectedApplication != nil {
      guard captureTargetIsCurrent() else {
        throw HelperFailure.rejected("post_action_target_changed")
      }
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

  private func accessibilitySnapshot(pid: pid_t, deadline: Date? = nil) -> String {
    let application = AXUIElementCreateApplication(pid)
    let root = axElementAttribute(application, kAXFocusedWindowAttribute as String)
      ?? application
    var lines: [String] = []
    var bytes = 0
    walk(
      element: root,
      depth: 0,
      lines: &lines,
      bytes: &bytes,
      deadline: deadline
    )
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
    bytes: inout Int,
    deadline: Date?
  ) {
    guard depth <= Self.maximumSnapshotDepth,
          elements.count < Self.maximumSnapshotNodes,
          bytes < Self.maximumSnapshotBytes,
          deadline.map({ Date() < $0 }) ?? true
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
      walk(
        element: child,
        depth: depth + 1,
        lines: &lines,
        bytes: &bytes,
        deadline: deadline
      )
      if elements.count >= Self.maximumSnapshotNodes
          || bytes >= Self.maximumSnapshotBytes
          || !(deadline.map({ Date() < $0 }) ?? true) {
        break
      }
    }
  }

  private func press(
    _ input: [String: Any],
    taskAuthority: Bool
  ) async throws -> [String: Any] {
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
    if taskAuthority {
      try withBoundedAccessibilityMessaging {
        try requireTaskAuthorityPointerTarget(element)
      }
    }
    let status = AXUIElementPerformAction(element, kAXPressAction as CFString)
    guard status == .success else { throw HelperFailure.rejected("press_failed") }
    return await postActionResult(
      summary: "Pressed the accessibility element.",
      expectedApplication: snapshotTargetApplication,
      expectedBundleIdentifier: snapshotFrontmostBundleIdentifier
    )
  }

  private func click(
    _ input: [String: Any],
    taskAuthority: Bool
  ) async throws -> [String: Any] {
    guard AXIsProcessTrusted() else { throw HelperFailure.rejected("accessibility_denied") }
    guard let revision = input["snapshotRevision"] as? String else {
      throw HelperFailure.rejected("invalid_input")
    }
    let point: CGPoint
    let expectedElement: AXUIElement
    let expectedIdentity: SnapshotElementIdentity
    let requiresSnapshotElementVerification: Bool
    if let elementId = input["elementId"] as? String,
       input.keys.allSatisfy({ $0 == "elementId" || $0 == "snapshotRevision" }),
       elementId.hasPrefix("e:\(revision.prefix(12)):"),
       let element = elements[elementId],
       let identity = elementIdentities[elementId],
       let targetFrame = frame(element) {
      point = CGPoint(x: targetFrame.midX, y: targetFrame.midY)
      expectedElement = element
      expectedIdentity = identity
      requiresSnapshotElementVerification = true
    } else if input["x"] != nil || input["y"] != nil || input["coordinateSpace"] != nil {
      guard input.keys.allSatisfy({
              $0 == "x" || $0 == "y" || $0 == "coordinateSpace"
                || $0 == "snapshotRevision"
            }),
            input.count == 4,
            input["coordinateSpace"] as? String
              == ScreenshotCoordinateMapping.screenshotSpace,
            let x = coordinateNumber(input["x"]),
            let y = coordinateNumber(input["y"]),
            let mapping = snapshotScreenshotMapping,
            mapping.snapshotRevision == revision,
            displayMappingIsCurrent(mapping),
            let globalPoint = mapping.globalLogicalPoint(
              screenshotX: x,
              screenshotY: y,
              revision: revision
            ),
            pointIsOnActiveDisplay(globalPoint),
            let snapshotFocusedWindow,
            let snapshotWindowIdentity
      else { throw HelperFailure.rejected("screenshot_coordinate_refused") }
      // Approval UI may have brought Asael forward. Restore and validate the
      // exact captured window before asking macOS which element is currently
      // topmost at the screenshot point. Frame-area guessing cannot establish
      // z-order and can authorize a covered element that will not receive the
      // actual click.
      let observedTarget = try withBoundedAccessibilityMessaging {
        try verifyObservedTarget(
          revision: revision,
          expectedElement: snapshotFocusedWindow,
          expectedIdentity: snapshotWindowIdentity
        )
        guard revision == snapshotRevision,
              let target = currentObservedHitTarget(at: globalPoint)
        else { throw HelperFailure.rejected("screenshot_coordinate_refused") }
        if taskAuthority { try requireTaskAuthorityPointerTarget(target.element) }
        return target
      }
      point = globalPoint
      expectedElement = observedTarget.element
      expectedIdentity = observedTarget.identity
      requiresSnapshotElementVerification = false
    } else {
      throw HelperFailure.rejected("invalid_input")
    }
    guard !isSecure(role: expectedIdentity.role, subrole: expectedIdentity.subrole)
    else { throw HelperFailure.rejected("secure_input_refused") }
    if requiresSnapshotElementVerification {
      try verifyObservedTarget(
        revision: revision,
        expectedElement: expectedElement,
        expectedIdentity: expectedIdentity
      )
      if taskAuthority {
        // The click lands on whatever is topmost at the element's center now,
        // so task authority must cover that element, not only the observed one.
        try withBoundedAccessibilityMessaging {
          guard let target = currentObservedHitTarget(at: point) else {
            throw HelperFailure.rejected(Self.taskAuthorityRefused)
          }
          try requireTaskAuthorityPointerTarget(target.element)
        }
      }
    }
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                             mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                           mouseCursorPosition: point, mouseButton: .left)
    else { throw HelperFailure.rejected("event_creation_failed") }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return await postActionResult(
      summary: "Clicked the on-screen location.",
      expectedApplication: snapshotTargetApplication,
      expectedBundleIdentifier: snapshotFrontmostBundleIdentifier
    )
  }

  private func typeText(
    _ input: [String: Any],
    taskAuthority: Bool
  ) async throws -> [String: Any] {
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
    // Task authority types only into an editable text field, never into a
    // control that might treat the keystrokes as commands.
    if taskAuthority {
      guard TaskAuthorityTargetPolicy.allowsTyping(
        role: focusTarget.identity.role,
        subrole: focusTarget.identity.subrole,
        text: text
      ) else { throw HelperFailure.rejected(Self.taskAuthorityRefused) }
    }
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
    return await postActionResult(
      summary: "Typed \(units.count) characters into the active application.",
      expectedApplication: snapshotTargetApplication,
      expectedBundleIdentifier: snapshotFrontmostBundleIdentifier
    )
  }

  private func key(
    _ input: [String: Any],
    taskAuthority: Bool
  ) async throws -> [String: Any] {
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
    if taskAuthority {
      switch TaskAuthorityTargetPolicy.keyDisposition(
        name: name,
        modifiers: modifierNames,
        focusedRole: focusTarget.identity.role
      ) {
      case .allow:
        break
      case .checkFocusedTarget:
        try withBoundedAccessibilityMessaging {
          try requireTaskAuthorityPointerTarget(focusTarget.element)
        }
      case .refuse:
        throw HelperFailure.rejected(Self.taskAuthorityRefused)
      }
    }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    else { throw HelperFailure.rejected("event_creation_failed") }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return await postActionResult(
      summary: "Sent the keyboard shortcut.",
      expectedApplication: snapshotTargetApplication,
      expectedBundleIdentifier: snapshotFrontmostBundleIdentifier
    )
  }

  private func scroll(_ input: [String: Any]) async throws -> [String: Any] {
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
    return await postActionResult(
      summary: "Scrolled the active application.",
      expectedApplication: snapshotTargetApplication,
      expectedBundleIdentifier: snapshotFrontmostBundleIdentifier
    )
  }

  private func verifyKeyboardTarget() throws {
    guard AXIsProcessTrusted() else { throw HelperFailure.rejected("accessibility_denied") }
    guard !IsSecureEventInputEnabled() else { throw HelperFailure.rejected("secure_input_refused") }
    if let app = NSWorkspace.shared.frontmostApplication, refusesTarget(app) {
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

  /// Returns fresh model evidence for an effect that has already completed.
  /// Observation is deliberately best-effort: a readback failure must not turn
  /// a performed input event into a retryable failure that could replay it.
  private func postActionResult(
    summary: String,
    data: [String: Any]? = nil,
    expectedApplication: NSRunningApplication?,
    expectedBundleIdentifier: String?
  ) async -> [String: Any] {
    try? await Task.sleep(nanoseconds: 300_000_000)
    guard let expectedApplication,
          let expectedBundleIdentifier
    else { return result(summary: summary, data: data) }
    let readback = try? await withBoundedAccessibilityMessaging {
      try await observe(
        ["includeScreenshot": true],
        expectedApplication: expectedApplication,
        expectedBundleIdentifier: expectedBundleIdentifier,
        accessibilityDeadline: Date().addingTimeInterval(
          Self.postActionAccessibilityBudgetSeconds
        )
      )
    }
    guard let readback,
          let observation = readback["observation"] as? [String: Any]
    else {
      return result(summary: summary, data: data)
    }
    return result(summary: summary, data: data, observation: observation)
  }

  private func captureScreenshot() async throws -> CapturedScreenshot {
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
    let logicalBounds = display.frame
    guard approximatelyEqual(logicalBounds, CGDisplayBounds(display.displayID)) else {
      throw HelperFailure.rejected("coordinate_mapping_unavailable")
    }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let configuration = SCStreamConfiguration()
    let scale = min(1, 1_440 / max(1, CGFloat(display.width)))
    configuration.width = max(1, Int(CGFloat(display.width) * scale))
    configuration.height = max(1, Int(CGFloat(display.height) * scale))
    configuration.showsCursor = true
    // Fill the entire output surface so the independently derived x/y scales
    // remain an exact affine inverse with no aspect-ratio padding.
    configuration.preservesAspectRatio = false
    configuration.captureResolution = .best
    let image = try await SCScreenshotManager.captureImage(
      contentFilter: filter,
      configuration: configuration
    )
    let capturedAt = Date()
    guard captureTargetIsCurrent(),
          let mapping = ScreenshotCoordinateMapping(
            snapshotRevision: snapshotRevision,
            displayID: display.displayID,
            displayLogicalBounds: logicalBounds,
            imageWidth: image.width,
            imageHeight: image.height
          ),
          displayMappingIsCurrent(mapping)
    else { throw HelperFailure.rejected("stale_observation") }
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
    let degradation = image.width < display.width || image.height < display.height
      ? "downscaled_jpeg"
      : "jpeg_compressed"
    var coordinateContract: [String: Any] = [
      "schemaVersion": 1,
      "snapshotRevision": snapshotRevision,
      "capturedAt": iso8601(capturedAt),
      "screenshotOrigin": "top_left",
      "targetSpace": ScreenshotCoordinateMapping.targetSpace,
      "display": [
        "id": Int(display.displayID),
        "logicalBounds": rectangle(logicalBounds),
      ],
      "logicalPointsPerPixel": [
        "x": mapping.logicalPointsPerPixelX,
        "y": mapping.logicalPointsPerPixelY,
      ],
      "quality": [
        "degradation": degradation,
        "occlusion": "not_assessed",
      ],
    ]
    if let target = screenshotTarget() {
      coordinateContract["target"] = target
    }
    return CapturedScreenshot(payload: [
      "mimeType": "image/jpeg",
      "dataBase64": data.base64EncodedString(),
      "widthPixels": image.width,
      "heightPixels": image.height,
      "coordinateSpace": ScreenshotCoordinateMapping.screenshotSpace,
      "coordinateContract": coordinateContract,
    ], coordinateMapping: mapping)
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

  /// Accessibility is a synchronous cross-process protocol. Use a short,
  /// process-wide timeout only around freshness checks whose safe failure mode
  /// is refusal (or omission of best-effort readback), then restore the macOS
  /// default immediately. Commands are consumed serially by this helper.
  private func withBoundedAccessibilityMessaging<T>(
    _ operation: () throws -> T
  ) throws -> T {
    let systemWide = AXUIElementCreateSystemWide()
    guard AXUIElementSetMessagingTimeout(
      systemWide,
      Self.liveAccessibilityTimeoutSeconds
    ) == .success
    else { throw HelperFailure.rejected("accessibility_unavailable") }
    defer { _ = AXUIElementSetMessagingTimeout(systemWide, 0) }
    return try operation()
  }

  private func withBoundedAccessibilityMessaging<T>(
    _ operation: () async throws -> T
  ) async throws -> T {
    let systemWide = AXUIElementCreateSystemWide()
    guard AXUIElementSetMessagingTimeout(
      systemWide,
      Self.liveAccessibilityTimeoutSeconds
    ) == .success
    else { throw HelperFailure.rejected("accessibility_unavailable") }
    defer { _ = AXUIElementSetMessagingTimeout(systemWide, 0) }
    return try await operation()
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

  private func currentObservedHitTarget(
    at point: CGPoint
  ) -> (element: AXUIElement, identity: SnapshotElementIdentity)? {
    guard captureTargetIsCurrent(),
          let expectedPID = snapshotFrontmostPID,
          let focusedWindow = currentFocusedWindow(pid: expectedPID),
          let snapshotFocusedWindow,
          CFEqual(focusedWindow, snapshotFocusedWindow),
          let focusedWindowFrame = frame(focusedWindow),
          focusedWindowFrame.contains(point)
    else { return nil }
    let application = AXUIElementCreateApplication(expectedPID)
    var hitElement: AXUIElement?
    let status = AXUIElementCopyElementAtPosition(
      application,
      Float(point.x),
      Float(point.y),
      &hitElement
    )
    guard status == .success, let hitElement else { return nil }
    var hitPID: pid_t = 0
    guard AXUIElementGetPid(hitElement, &hitPID) == .success,
          hitPID == expectedPID,
          let metadata = screenshotHitTargetMetadata(hitElement),
          let currentIdentity = metadata.identity,
          !isSecure(role: currentIdentity.role, subrole: currentIdentity.subrole),
          let hitFrame = currentIdentity.frame,
          hitFrame.width > 0,
          hitFrame.height > 0,
          hitFrame.contains(point),
          elementBelongsToFocusedSnapshotWindow(
            hitElement,
            directWindowCandidates: metadata.directWindowCandidates
          )
    else { return nil }
    return (hitElement, currentIdentity)
  }

  /// Fetches only the security-relevant hit-target attributes in one IPC.
  /// Reading title, help and value independently is unnecessary for a pixel
  /// click and allowed an unresponsive Chromium renderer to multiply the AX
  /// messaging timeout until the native command lease expired.
  private func screenshotHitTargetMetadata(
    _ element: AXUIElement
  ) -> (
    identity: SnapshotElementIdentity?,
    directWindowCandidates: [AXUIElement]
  )? {
    let attributes: [CFString] = [
      kAXRoleAttribute as CFString,
      kAXSubroleAttribute as CFString,
      kAXPositionAttribute as CFString,
      kAXSizeAttribute as CFString,
      kAXWindowAttribute as CFString,
      kAXTopLevelUIElementAttribute as CFString,
    ]
    var copiedValues: CFArray?
    let status = AXUIElementCopyMultipleAttributeValues(
      element,
      attributes as CFArray,
      [],
      &copiedValues
    )
    guard status == .success,
          let values = copiedValues as? [Any],
          values.count == attributes.count,
          let role = values[0] as? String,
          let targetFrame = frame(
            positionValue: values[2],
            sizeValue: values[3]
          )
    else { return nil }
    let subrole = values[1] as? String
    let directWindowCandidates = [values[4], values[5]].compactMap(axElementValue)
    return (
      SnapshotElementIdentity(
        role: bounded(role, limit: 80),
        subrole: subrole.map { bounded($0, limit: 80) },
        label: nil,
        value: nil,
        frame: targetFrame
      ),
      directWindowCandidates
    )
  }

  /// Confirms a live Accessibility element belongs to the exact focused window
  /// captured by the screenshot. Dynamic browser descendants do not have to be
  /// present in the bounded text snapshot, but they must still resolve through
  /// the current application's Accessibility hierarchy to that same window.
  private func elementBelongsToFocusedSnapshotWindow(
    _ element: AXUIElement,
    directWindowCandidates: [AXUIElement] = []
  ) -> Bool {
    guard let expectedPID = snapshotFrontmostPID,
          let snapshotFocusedWindow,
          let currentWindow = currentFocusedWindow(pid: expectedPID),
          CFEqual(currentWindow, snapshotFocusedWindow)
    else { return false }
    if CFEqual(element, currentWindow) { return true }
    if !directWindowCandidates.isEmpty {
      return directWindowCandidates.contains { CFEqual($0, currentWindow) }
    }
    if let elementWindow = axElementAttribute(element, kAXWindowAttribute as String) {
      return CFEqual(elementWindow, currentWindow)
    }

    var cursor = element
    var visited = 0
    while visited < Self.maximumHitTargetAncestorDepth {
      guard let parent = axElementAttribute(cursor, kAXParentAttribute as String)
      else { return false }
      if CFEqual(parent, currentWindow) { return true }
      if CFEqual(parent, cursor) { return false }
      cursor = parent
      visited += 1
    }
    return false
  }

  /// Refuses a press, click, or Space whose real target task authority does
  /// not cover. Callers bound Accessibility messaging around this check.
  private func requireTaskAuthorityPointerTarget(_ element: AXUIElement) throws {
    guard let path = taskAuthorityPath(from: element),
          TaskAuthorityTargetPolicy.allowsPointer(path: path)
    else { throw HelperFailure.rejected(Self.taskAuthorityRefused) }
  }

  /// Reads the target and every ancestor up to the observed window, which is
  /// included last. A path that leaves that window, loops, or does not reach
  /// it within the bound returns nil.
  private func taskAuthorityPath(from element: AXUIElement) -> [TaskAuthorityElement]? {
    guard let snapshotFocusedWindow else { return nil }
    let deadline = Date().addingTimeInterval(Self.taskAuthorityPathBudgetSeconds)
    var path: [TaskAuthorityElement] = []
    var cursor = element
    while path.count < Self.maximumTaskAuthorityPathLength, Date() < deadline {
      guard let step = taskAuthorityPathStep(cursor) else { return nil }
      path.append(step.element)
      if CFEqual(cursor, snapshotFocusedWindow) { return path }
      guard let parent = step.parent, !CFEqual(parent, cursor) else { return nil }
      cursor = parent
    }
    return nil
  }

  /// One Accessibility message per element, plus the text of a static text
  /// element, which is how a web page names many buttons and links.
  private func taskAuthorityPathStep(
    _ element: AXUIElement
  ) -> (element: TaskAuthorityElement, parent: AXUIElement?)? {
    let attributes: [CFString] = [
      kAXRoleAttribute as CFString,
      kAXSubroleAttribute as CFString,
      kAXTitleAttribute as CFString,
      kAXDescriptionAttribute as CFString,
      kAXHelpAttribute as CFString,
      kAXParentAttribute as CFString,
    ]
    var copiedValues: CFArray?
    let status = AXUIElementCopyMultipleAttributeValues(
      element,
      attributes as CFArray,
      [],
      &copiedValues
    )
    guard status == .success,
          let values = copiedValues as? [Any],
          values.count == attributes.count,
          let role = values[0] as? String
    else { return nil }
    var labels = values[2...4].compactMap { $0 as? String }
    if role == "AXStaticText",
       let text = stringAttribute(element, kAXValueAttribute as String) {
      labels.append(text)
    }
    return (
      TaskAuthorityElement(
        role: bounded(role, limit: 80),
        subrole: (values[1] as? String).map { bounded($0, limit: 80) },
        labels: labels.map {
          bounded($0, limit: Self.maximumTaskAuthorityLabelLength)
        }
      ),
      axElementValue(values[5])
    )
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

  private func frame(positionValue: Any, sizeValue: Any) -> CGRect? {
    let rawPosition = positionValue as CFTypeRef
    let rawSize = sizeValue as CFTypeRef
    guard CFGetTypeID(rawPosition) == AXValueGetTypeID(),
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

  private func axElementValue(_ value: Any) -> AXUIElement? {
    let reference = value as CFTypeRef
    guard CFGetTypeID(reference) == AXUIElementGetTypeID() else { return nil }
    return (reference as! AXUIElement)
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

  private func coordinateNumber(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID()
    else { return nil }
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
          activeDisplayBounds() == snapshotDisplayBounds
    else { throw HelperFailure.rejected("stale_observation") }
    guard !refusesTarget(targetApplication) else {
      throw HelperFailure.rejected("restricted_application_refused")
    }

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
    if let window = currentFocusedWindow(pid: expectedPID),
       showsRestrictedPage(targetApplication, window: window) {
      throw HelperFailure.rejected("restricted_page_refused")
    }

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

  /// Refuses a restricted application and Asael itself as an action target.
  private func refusesTarget(_ application: NSRunningApplication) -> Bool {
    RestrictedApplicationPolicy.refuses(application)
      || RestrictedApplicationPolicy.isTrustedHost(
        pid: application.processIdentifier,
        bundleIdentifier: application.bundleIdentifier,
        trustedHostPID: trustedHostPID,
        trustedHostBundleIdentifier: ParentVerifier.parentIdentifier
      )
  }

  private func showsRestrictedPage(
    _ application: NSRunningApplication,
    window: AXUIElement
  ) -> Bool {
    RestrictedApplicationPolicy.readsPages(ofBundleIdentifier: application.bundleIdentifier)
      && browserPageURLs(in: window).contains(where: RestrictedApplicationPolicy.refusesPage)
  }

  /// Reads the address of each page in a browser window, breadth first and
  /// within a small bound, fetching an element's role, children, and address
  /// in one message. Pages inside a page are not searched. The window keeps
  /// the caller's timeout; each element below it gets a short one of its own.
  private func browserPageURLs(in window: AXUIElement) -> [URL] {
    let attributes = [
      kAXRoleAttribute as CFString,
      kAXChildrenAttribute as CFString,
      "AXURL" as CFString,
    ] as CFArray
    let deadline = Date().addingTimeInterval(Self.browserPageSearchBudgetSeconds)
    var queue = [window]
    var next = 0
    var urls: [URL] = []
    while next < queue.count, next < Self.maximumBrowserPageSearchNodes, Date() < deadline {
      let element = queue[next]
      if next > 0 {
        _ = AXUIElementSetMessagingTimeout(element, Self.liveAccessibilityTimeoutSeconds)
      }
      next += 1
      var copiedValues: CFArray?
      guard AXUIElementCopyMultipleAttributeValues(element, attributes, [], &copiedValues)
              == .success,
            let values = copiedValues as? [Any],
            values.count == 3,
            let role = values[0] as? String
      else { continue }
      if role == "AXWebArea" {
        if let url = values[2] as? URL {
          urls.append(url)
        } else if let address = values[2] as? String, let url = URL(string: address) {
          urls.append(url)
        }
        continue
      }
      guard !Self.browserPageLeafRoles.contains(role),
            let children = values[1] as? [AXUIElement]
      else { continue }
      queue.append(contentsOf: children.prefix(80))
    }
    return urls
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

  private func iso8601(_ value: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: value)
  }

  private func rectangle(_ value: CGRect) -> [String: Any] {
    [
      "x": Double(value.origin.x),
      "y": Double(value.origin.y),
      "width": Double(value.width),
      "height": Double(value.height),
    ]
  }

  private func screenshotTarget() -> [String: Any]? {
    guard let pid = snapshotFrontmostPID else { return nil }
    var target: [String: Any] = ["pid": Int(pid)]
    if let bundleIdentifier = snapshotFrontmostBundleIdentifier,
       !bundleIdentifier.isEmpty {
      target["bundleId"] = bounded(bundleIdentifier, limit: 240)
    }
    if let identity = snapshotWindowIdentity {
      var window: [String: Any] = [
        "identitySha256": snapshotIdentitySha256(identity),
      ]
      if let bounds = identity.frame {
        window["logicalBounds"] = rectangle(bounds)
      }
      target["window"] = window
    }
    return target
  }

  private func snapshotIdentitySha256(_ identity: SnapshotElementIdentity) -> String {
    let frameValue = identity.frame.map { bounds in
      [bounds.origin.x, bounds.origin.y, bounds.width, bounds.height]
        .map { String(Double($0).bitPattern, radix: 16) }
        .joined(separator: ",")
    } ?? ""
    return CryptoKit.SHA256.hash(data: Data([
      identity.role,
      identity.subrole ?? "",
      identity.label ?? "",
      identity.value ?? "",
      frameValue,
    ].joined(separator: "\u{0000}").utf8))
      .map { String(format: "%02x", $0) }
      .joined()
  }

  private func captureTargetIsCurrent() -> Bool {
    guard activeDisplayBounds() == snapshotDisplayBounds else { return false }
    let frontmost = NSWorkspace.shared.frontmostApplication
    guard let expectedPID = snapshotFrontmostPID else { return frontmost == nil }
    return frontmost?.processIdentifier == expectedPID
      && frontmost?.bundleIdentifier == snapshotFrontmostBundleIdentifier
      && observedWindowIsCurrent(pid: expectedPID)
  }

  private func approximatelyEqual(_ left: CGRect, _ right: CGRect) -> Bool {
    let tolerance: CGFloat = 0.01
    return abs(left.origin.x - right.origin.x) <= tolerance
      && abs(left.origin.y - right.origin.y) <= tolerance
      && abs(left.width - right.width) <= tolerance
      && abs(left.height - right.height) <= tolerance
  }

  private func isSafeIdentifier(_ value: String) -> Bool {
    value.count <= 300
      && value.range(of: #"^[A-Za-z0-9][A-Za-z0-9.-]+$"#, options: .regularExpression) != nil
  }

  private func pointIsOnActiveDisplay(_ point: CGPoint) -> Bool {
    activeDisplayBounds().contains { $0.contains(point) }
  }

  private func displayMappingIsCurrent(_ mapping: ScreenshotCoordinateMapping) -> Bool {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
      return false
    }
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &displays, &count) == .success,
          displays.prefix(Int(count)).contains(mapping.displayID)
    else { return false }
    return approximatelyEqual(
      CGDisplayBounds(mapping.displayID),
      mapping.displayLogicalBounds
    )
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
