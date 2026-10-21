import Carbon
import Cocoa
import FlutterMacOS
import Security
import UserNotifications

@main
class AppDelegate: FlutterAppDelegate, UNUserNotificationCenterDelegate {
  private let desktopHostController = DesktopHostController()
  private let localComputerController = LocalComputerController()
  private lazy var credentialBrokerController = CredentialBrokerController { [weak self] epoch in
    self?.sessionProtectionController.acceptsCredentialEpoch(epoch) == true
  }
  private let recoveryStorageBrokerController = RecoveryStorageBrokerController()
  private let powerStateBridgeController = PowerStateBridgeController()
  private let sessionProtectionController = DesktopSessionProtectionController()
  func attachSessionProtection(to messenger: FlutterBinaryMessenger) -> FlutterMethodChannel {
    sessionProtectionController.attach(to: messenger)
  }
  func detachSessionProtection(_ channel: FlutterMethodChannel) { sessionProtectionController.detach(channel) }
  func protectAllSessionEngines() { sessionProtectionController.protectForSystemEvent() }

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
    powerStateBridgeController.stop()
    credentialBrokerController.stopForApplicationTermination()
    localComputerController.stopForApplicationTermination()
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
    if let controller = window.contentViewController as? FlutterViewController {
      _ = attachRecoveryStorageBridge(to: controller.engine.binaryMessenger)
    }
  }

  func attachRecoveryStorageBridge(to messenger: FlutterBinaryMessenger) -> FlutterMethodChannel {
    recoveryStorageBrokerController.attach(to: messenger)
  }

  func detachRecoveryStorageBridge(_ channel: FlutterMethodChannel) {
    recoveryStorageBrokerController.detach(channel)
  }

  func attachPowerStateBridge(to messenger: FlutterBinaryMessenger) -> FlutterEventChannel {
    powerStateBridgeController.attach(to: messenger)
  }

  func detachPowerStateBridge(_ channel: FlutterEventChannel) {
    powerStateBridgeController.detach(channel)
  }

  func attachLocalComputerBridge(channel: FlutterMethodChannel) {
    localComputerController.attach(channel: channel)
  }

  func detachLocalComputerBridge(channel: FlutterMethodChannel) {
    localComputerController.detach(channel: channel)
  }

  func attachCredentialBrokerBridge(channel: FlutterMethodChannel) {
    credentialBrokerController.attach(channel: channel)
  }

  func detachCredentialBrokerBridge(channel: FlutterMethodChannel) {
    credentialBrokerController.detach(channel: channel)
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

  override func application(
    _ application: NSApplication,
    didReceiveRemoteNotification userInfo: [String: Any]
  ) {
    desktopHostController.handleNotificationReceived(
      userInfo,
      lifecycle: application.isActive ? "foreground" : "background"
    )
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    desktopHostController.handleNotificationReceived(
      notification.request.content.userInfo,
      lifecycle: "foreground"
    )
    completionHandler([.banner, .sound, .badge])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    desktopHostController.handleNotificationResponse(
      response,
      completionHandler: completionHandler
    )
  }
}

/// A bounded bridge to the frozen, separately signed v2 Keychain owner.
///
/// Synchronous Security.framework calls occur only in the child. If securityd
/// wedges, the host fails every pending call and terminates (then SIGKILLs)
/// the broker. No environment credential or error detail crosses the pipes.
///
/// v2 owns a clean Keychain namespace and deliberately has no v1 migration
/// operation. A missing v2 marker means that the user must sign in again; the
/// broker keeps any incomplete v2 writes unreadable until that sign-in commits
/// its marker. The host validates this state instead of inferring readiness
/// from item counts or retaining a cross-identity cutover receipt.
enum CredentialBrokerV2ResponsePolicy {
  static func normalizeSucceeded(
    action: String,
    response: [String: Any]
  ) -> [String: Any]? {
    switch action {
    case "probe":
      guard response.count == 5,
            response["brokerVersion"] as? String == "2.0.0+2",
            let state = response["state"] as? String,
            let freshSignInRequired = exactBoolean(response["freshSignInRequired"]),
            exactBoolean(response["migrationRequired"]) == false,
            let targetItemCount = exactInteger(response["targetItemCount"]),
            (0...12).contains(targetItemCount),
            (state == "ready" && !freshSignInRequired)
              || (state == "fresh_sign_in_required" && freshSignInRequired)
      else { return nil }
      return response
    case "read":
      guard response.count == 1 else { return nil }
      if response["value"] is NSNull { return response }
      guard let value = response["value"] as? String,
            value.lengthOfBytes(using: .utf8) <= 64 * 1_024
      else { return nil }
      return response
    case "write", "delete":
      return response.isEmpty ? response : nil
    default:
      return nil
    }
  }

  private static func exactBoolean(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) == CFBooleanGetTypeID()
    else { return nil }
    return number.boolValue
  }

  private static func exactInteger(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue == Double(number.intValue)
    else { return nil }
    return number.intValue
  }
}

private final class CredentialBrokerController: NSObject {
  private struct PendingRequest {
    let sessionEpoch: Int?
    let action: String
    let result: FlutterResult
    let timeout: DispatchWorkItem
  }

  private struct QueuedRequest {
    let sessionEpoch: Int?
    let envelope: [String: Any]
    let timeout: TimeInterval
    let result: FlutterResult
  }

  private static let helperBundleName = "AsaelCredentialBroker.app"
  private static let helperExecutableName = "AsaelCredentialBroker"
  private static let helperBundleIdentifier = "app.omniagent.omniagent.credential-broker"
  private static let maximumRequestBytes = 512 * 1_024
  private static let maximumResponseBytes = 512 * 1_024
  private static let allowedKeys: Set<String> = [
    "asael.session_token", "asael.refresh_token", "asael.access_expires_at",
    "asael.device_id", "asael.biometric_enabled", "asael.capture_outbox_secret_v1",
    "asael.offline_projection_secret_v1", "asael.offline_projection_owner_v1",
    "asael.push_registration_id_v1", "asael.push_preview_policy_v1",
    "asael.pending_push_acknowledgement_v1", "omniagent.session_token",
  ]

  private var channels: [ObjectIdentifier: FlutterMethodChannel] = [:]
  private var process: Process?
  private var inputPipe: Pipe?
  private var outputPipe: Pipe?
  private var errorPipe: Pipe?
  private var outputBuffer = Data()
  private var pending: [String: PendingRequest] = [:]
  private var queued: [QueuedRequest] = []
  private var activeAction: String?
  private var expectedTermination = false
  private let acceptsSessionEpoch: (Int) -> Bool
  init(acceptsSessionEpoch: @escaping (Int) -> Bool) {
    self.acceptsSessionEpoch = acceptsSessionEpoch
    super.init()
  }
  func attach(channel: FlutterMethodChannel) {
    dispatchPrecondition(condition: .onQueue(.main))
    channels[ObjectIdentifier(channel)] = channel
    channel.setMethodCallHandler { [weak self] call, result in
      DispatchQueue.main.async {
        guard let self else {
          result(Self.flutterFailure("secure_store_unavailable"))
          return
        }
        self.handle(call: call, result: result)
      }
    }
  }

  func detach(channel: FlutterMethodChannel) {
    dispatchPrecondition(condition: .onQueue(.main))
    channel.setMethodCallHandler(nil)
    channels.removeValue(forKey: ObjectIdentifier(channel))
  }

  func stopForApplicationTermination() {
    dispatchPrecondition(condition: .onQueue(.main))
    terminate(expected: true, code: "secure_store_unavailable")
    for channel in channels.values { channel.setMethodCallHandler(nil) }
    channels.removeAll()
  }

  private func handle(call: FlutterMethodCall, result: @escaping FlutterResult) {
    let values = call.arguments as? [String: Any]
    var envelope: [String: Any] = [
      "id": UUID().uuidString.lowercased(),
      "action": call.method,
    ]
    var sessionEpoch: Int?
    if ["read", "write", "delete"].contains(call.method) {
      guard let number = values?["sessionEpoch"] as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID(), number.intValue >= 0,
            number.doubleValue == Double(number.intValue),
            acceptsSessionEpoch(number.intValue) else {
        result(Self.flutterFailure("secure_store_session_changed")); return
      }
      sessionEpoch = number.intValue
    }
    switch call.method {
    case "probe":
      guard call.arguments == nil else {
        result(Self.flutterFailure("invalid_secure_store_arguments")); return
      }
    case "migrate":
      guard call.arguments == nil else {
        result(Self.flutterFailure("invalid_secure_store_arguments")); return
      }
      // A rotated identity cannot safely open or migrate the old broker's
      // Keychain rows. Keep v1 intact and require a fresh authenticated session.
      result(Self.flutterFailure("secure_store_fresh_sign_in_required")); return
    case "read", "delete":
      guard let values, values.count == 2,
            let key = values["key"] as? String, Self.allowedKeys.contains(key)
      else { result(Self.flutterFailure("invalid_secure_store_arguments")); return }
      envelope["key"] = key
    case "write":
      guard let values, values.count == 3,
            let key = values["key"] as? String, Self.allowedKeys.contains(key),
            let value = values["value"] as? String,
            value.lengthOfBytes(using: .utf8) <= 64 * 1_024
      else { result(Self.flutterFailure("invalid_secure_store_arguments")); return }
      envelope["key"] = key
      envelope["value"] = value
    default:
      result(FlutterMethodNotImplemented); return
    }
    enqueue(envelope, sessionEpoch: sessionEpoch, timeout: 8, result: result)
  }

  private func enqueue(
    _ envelope: [String: Any], sessionEpoch: Int?, timeout seconds: TimeInterval,
    result: @escaping FlutterResult
  ) {
    guard queued.count + pending.count < 32,
          JSONSerialization.isValidJSONObject(envelope),
          let data = try? JSONSerialization.data(withJSONObject: envelope),
          data.count <= Self.maximumRequestBytes
    else { result(Self.flutterFailure("secure_store_unavailable")); return }
    queued.append(QueuedRequest(sessionEpoch: sessionEpoch, envelope: envelope, timeout: seconds, result: result))
    dispatchNext()
  }

  private func dispatchNext() {
    guard pending.isEmpty, !queued.isEmpty else { return }
    let requestToDispatch = queued.removeFirst()
    if let epoch = requestToDispatch.sessionEpoch, !acceptsSessionEpoch(epoch) {
      requestToDispatch.result(Self.flutterFailure("secure_store_session_changed"))
      dispatchNext()
      return
    }
    guard let id = requestToDispatch.envelope["id"] as? String,
          let action = requestToDispatch.envelope["action"] as? String,
          var data = try? JSONSerialization.data(withJSONObject: requestToDispatch.envelope),
          ensureBroker(), let inputPipe
    else {
      requestToDispatch.result(Self.flutterFailure("secure_store_unavailable"))
      failQueued(code: "secure_store_unavailable")
      return
    }

    let deadline = DispatchWorkItem { [weak self] in
      guard let self, let request = self.pending.removeValue(forKey: id) else { return }
      request.result(Self.flutterFailure("secure_store_timeout"))
      self.terminate(expected: false, code: "secure_store_timeout")
    }
    pending[id] = PendingRequest(
      sessionEpoch: requestToDispatch.sessionEpoch,
      action: action,
      result: requestToDispatch.result,
      timeout: deadline
    )
    activeAction = action
    DispatchQueue.main.asyncAfter(
      deadline: .now() + requestToDispatch.timeout,
      execute: deadline
    )
    data.append(0x0a)
    do {
      try inputPipe.fileHandleForWriting.write(contentsOf: data)
    } catch {
      deadline.cancel()
      pending.removeValue(forKey: id)
      requestToDispatch.result(Self.flutterFailure("secure_store_unavailable"))
      terminate(expected: false, code: "secure_store_unavailable")
    }
  }

  private func ensureBroker() -> Bool {
    if let process, process.isRunning { return true }
    guard let bundleURL = helperBundleURL,
          let bundle = Bundle(url: bundleURL),
          bundle.bundleIdentifier == Self.helperBundleIdentifier,
          let executableURL = helperExecutableURL,
          FileManager.default.isExecutableFile(atPath: executableURL.path)
    else { return false }

    let launched = Process()
    let input = Pipe(), output = Pipe(), errors = Pipe()
    launched.executableURL = executableURL
    launched.arguments = []
    // Intentionally omit HOME, shell state, API keys, and session credentials.
    launched.environment = ["LANG": "en_US.UTF-8", "PATH": "/usr/bin:/bin"]
    launched.standardInput = input
    launched.standardOutput = output
    launched.standardError = errors
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      DispatchQueue.main.async { self?.ingest(data) }
    }
    errors.fileHandleForReading.readabilityHandler = { handle in
      _ = handle.availableData
    }
    launched.terminationHandler = { [weak self, weak launched] _ in
      DispatchQueue.main.async {
        guard let self, let launched, self.process === launched else { return }
        let expected = self.expectedTermination
        self.clearProcessReferences()
        if !expected {
          self.failPending(code: "secure_store_unavailable")
          self.failQueued(code: "secure_store_unavailable")
        }
      }
    }
    do {
      try launched.run()
      process = launched
      inputPipe = input; outputPipe = output; errorPipe = errors
      outputBuffer.removeAll(keepingCapacity: true)
      expectedTermination = false
      return true
    } catch {
      output.fileHandleForReading.readabilityHandler = nil
      errors.fileHandleForReading.readabilityHandler = nil
      return false
    }
  }

  private func ingest(_ data: Data) {
    outputBuffer.append(data)
    guard outputBuffer.count <= Self.maximumResponseBytes * 2 else {
      terminate(expected: false, code: "secure_store_unavailable"); return
    }
    while let newline = outputBuffer.firstIndex(of: 0x0a) {
      let line = Data(outputBuffer[..<newline])
      outputBuffer.removeSubrange(...newline)
      guard !line.isEmpty, line.count <= Self.maximumResponseBytes,
            let response = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            let id = response["id"] as? String,
            let outcome = response["outcome"] as? String,
            let request = pending.removeValue(forKey: id)
      else { terminate(expected: false, code: "secure_store_unavailable"); return }
      request.timeout.cancel()
      activeAction = nil
      if let epoch = request.sessionEpoch, !acceptsSessionEpoch(epoch) {
        request.result(Self.flutterFailure("secure_store_session_changed"))
      } else if outcome == "succeeded" {
        var value = response
        value.removeValue(forKey: "id"); value.removeValue(forKey: "outcome")
        if let normalized = CredentialBrokerV2ResponsePolicy.normalizeSucceeded(
          action: request.action,
          response: value
        ) {
          request.result(normalized)
        } else {
          request.result(Self.flutterFailure("secure_store_unavailable"))
        }
      } else if outcome == "failed", let code = response["code"] as? String {
        request.result(Self.flutterFailure(Self.allowedErrorCode(code)))
      } else {
        request.result(Self.flutterFailure("secure_store_unavailable"))
      }
      dispatchNext()
    }
  }

  private func terminate(expected: Bool, code: String) {
    expectedTermination = expected
    activeAction = nil
    failPending(code: code)
    failQueued(code: code)
    outputPipe?.fileHandleForReading.readabilityHandler = nil
    errorPipe?.fileHandleForReading.readabilityHandler = nil
    try? inputPipe?.fileHandleForWriting.close()
    let terminating = process
    if let terminating, terminating.isRunning {
      terminating.terminate()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self, weak terminating] in
        guard let self, let terminating, self.process === terminating,
              terminating.isRunning else { return }
        kill(terminating.processIdentifier, SIGKILL)
      }
    } else { clearProcessReferences() }
  }

  private func failPending(code: String) {
    let requests = pending
    pending.removeAll()
    for request in requests.values {
      request.timeout.cancel()
      request.result(Self.flutterFailure(code))
    }
  }

  private func failQueued(code: String) {
    let requests = queued
    queued.removeAll(keepingCapacity: false)
    for request in requests {
      request.result(Self.flutterFailure(code))
    }
  }

  private func clearProcessReferences() {
    outputPipe?.fileHandleForReading.readabilityHandler = nil
    errorPipe?.fileHandleForReading.readabilityHandler = nil
    process = nil; inputPipe = nil; outputPipe = nil; errorPipe = nil
    activeAction = nil
    outputBuffer.removeAll(keepingCapacity: false)
  }

  private var helperBundleURL: URL? {
    Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers", isDirectory: true)
      .appendingPathComponent(Self.helperBundleName, isDirectory: true)
  }

  private var helperExecutableURL: URL? {
    helperBundleURL?.appendingPathComponent("Contents/MacOS", isDirectory: true)
      .appendingPathComponent(Self.helperExecutableName)
  }

  private static func allowedErrorCode(_ code: String) -> String {
    let allowed: Set<String> = [
      "invalid_request", "secure_store_unavailable", "secure_store_interaction_required",
      "secure_store_unreadable", "secure_store_target_unknown_keys",
      "secure_store_initialization_verification_failed",
      "secure_store_fresh_sign_in_required",
    ]
    return allowed.contains(code) ? code : "secure_store_unavailable"
  }

  private static func flutterFailure(_ code: String) -> FlutterError {
    FlutterError(
      code: code,
      message: "The protected credential operation could not be completed.",
      details: nil
    )
  }
}

private enum BoundedJSONObjectLineDecodeResult {
  case incomplete
  case objects([[String: Any]])
  case invalid
}

/// Reassembles and parses helper JSON away from AppKit's main queue.
///
/// Computer-use observations can legitimately include a compressed screenshot,
/// so decoding the bounded response on the UI queue causes visible stalls even
/// though capture itself runs in the isolated helper.
private final class BoundedJSONObjectLineDecoder {
  init(maximumLineBytes: Int, maximumBufferBytes: Int) {
    self.maximumLineBytes = maximumLineBytes
    self.maximumBufferBytes = maximumBufferBytes
  }

  private let maximumLineBytes: Int
  private let maximumBufferBytes: Int
  private var buffer = Data()

  func append(_ data: Data) -> BoundedJSONObjectLineDecodeResult {
    buffer.append(data)
    guard buffer.count <= maximumBufferBytes else { return .invalid }

    var objects: [[String: Any]] = []
    while let newline = buffer.firstIndex(of: 0x0a) {
      let line = Data(buffer[..<newline])
      buffer.removeSubrange(...newline)
      guard !line.isEmpty,
            line.count <= maximumLineBytes,
            let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any]
      else { return .invalid }
      objects.append(object)
    }
    return objects.isEmpty ? .incomplete : .objects(objects)
  }
}

/// A credential-free broker for Asael's separately signed local Computer Use helper.
///
/// The Flutter client holds the authenticated server session. The helper receives
/// only an already-governed, expiring action over child-process pipes and therefore
/// cannot inherit bearer credentials, call Asael APIs, open files, or make network
/// requests. A menu-bar indicator remains visible for the entire enabled session.
private final class LocalComputerController: NSObject {
  private struct PendingRequest {
    let callbacks: [([String: Any]) -> Void]
    let timeout: DispatchWorkItem
  }

  private struct CompletedRequest {
    let output: [String: Any]
    let expiresAt: Date
  }

  private struct CommandWorkspaceGrant: Codable {
    let id: String
    var name: String
    var bookmarkData: Data
    var lastKnownPath: String
  }

  private struct ResolvedCommandWorkspace {
    let id: String
    let name: String
    let root: URL
    let accessURL: URL
  }

  private static let allowedActions: Set<String> = [
    "observe", "list_apps", "activate_app", "open_url", "press", "click", "type", "key", "scroll",
    "run_command",
  ]
  // An action that runs on This Mac task authority alone carries
  // `authority: "task"`; the helper checks its real on-screen target and
  // refuses one that task authority does not cover.
  private static let taskAuthorityActions: Set<String> = ["press", "click", "key", "type"]
  private static let commandInputKeys: Set<String> = [
    "workspaceId", "executable", "arguments", "relativeDirectory", "timeoutSeconds",
  ]
  // BEGIN GENERATED command program policy
  // From src/lib/local-computer/command-program-policy.json; regenerate with
  // npm run generate:command-program-policy.
  private static let commandPrograms: Set<String> = [
    "awk", "basename", "bun", "cargo", "cat", "cmake", "cmp", "cp", "cut", "dart", "date", "deno",
    "df", "diff", "dirname", "du", "echo", "false", "file", "find", "flutter", "git", "go", "grep",
    "gunzip", "gzip", "head", "jq", "ls", "make", "md5", "mkdir", "mv", "node", "npm", "pip3",
    "pnpm", "pod", "printf", "pwd", "python3", "realpath", "rg", "rm", "rmdir", "rustc", "sed",
    "shasum", "sort", "stat", "sw_vers", "swift", "swiftc", "tail", "tar", "touch", "tr", "tree",
    "true", "uname", "uniq", "unzip", "wc", "which", "xcodebuild", "yarn", "zip",
  ]
  // END GENERATED command program policy
  private static let helperBundleName = "AsaelComputerUseHelper.app"
  private static let helperExecutableName = "AsaelComputerUseHelper"
  private static let helperBundleIdentifier = "app.omniagent.omniagent.computer-use-helper"
  private static let commandHelperBundleName = "AsaelCommandRunnerHelper.app"
  private static let commandHelperExecutableName = "AsaelCommandRunnerHelper"
  private static let commandHelperBundleIdentifier =
    "app.omniagent.omniagent.command-runner-helper"
  private static let commandWorkspaceDefaultsKey = "AsaelCommandWorkspaceGrantsV1"
  private static let maximumCommandWorkspaceCount = 32
  private static let maximumCommandResponseBytes = 256 * 1_024
  /// How long the command helper has to exit once asked to stop. It ends the
  /// command's process group within about a quarter of a second.
  private static let commandHelperStopGrace: TimeInterval = 1.0
  private static let maximumResponseBytes = 4 * 1_024 * 1_024
  private static let maximumRequestBytes = 96 * 1_024
  private static let internetDateFormatter = ISO8601DateFormatter()
  private static let fractionalInternetDateFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  private var channels: [ObjectIdentifier: FlutterMethodChannel] = [:]
  private var process: Process?
  private var inputPipe: Pipe?
  private var outputPipe: Pipe?
  private var errorPipe: Pipe?
  private let outputDecodeQueue = DispatchQueue(
    label: "app.omniagent.omniagent.computer-use-response",
    qos: .userInitiated
  )
  private var outputDecoder: BoundedJSONObjectLineDecoder?
  private var pending: [String: PendingRequest] = [:]
  private var completed: [String: CompletedRequest] = [:]
  private var completionOrder: [String] = []
  private var completionExpiryWorkItem: DispatchWorkItem?
  private lazy var commandWorkspaceGrants = Self.loadCommandWorkspaceGrants()
  private var cachedPublicCommandWorkspaces: [[String: Any]]?
  // Embedded helpers cannot change without replacing and relaunching the app.
  // Cache their bundle metadata instead of reopening both bundles on every
  // two-second native status refresh.
  private lazy var cachedHelperInstalled = computeHelperInstalled()
  private lazy var cachedHelperVersion = computeHelperVersion()
  private lazy var cachedCommandHelperInstalled = computeCommandHelperInstalled()
  private lazy var cachedCommandHelperVersion = computeCommandHelperVersion()
  private var commandProcess: Process?
  private var commandInputPipe: Pipe?
  private var commandOutputPipe: Pipe?
  private var commandErrorPipe: Pipe?
  private var commandOutputBuffer = Data()
  private var commandTimeoutWorkItem: DispatchWorkItem?
  private var commandCompletion: (([String: Any]) -> Void)?
  private var commandExecutionId: String?
  private var commandWorkspaceAccessURL: URL?
  private var commandWorkspaceAccessStarted = false
  private var commandWorkspaceId: String?
  private var statusItem: NSStatusItem?
  private weak var statusMenuItem: NSMenuItem?
  private var expectedTermination = false
  private var enabled = false
  private var active = false
  private var accessibility = "unknown"
  private var screenRecording = "unknown"

  func attach(channel: FlutterMethodChannel) {
    dispatchPrecondition(condition: .onQueue(.main))
    channels[ObjectIdentifier(channel)] = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else {
        result(FlutterError(
          code: "local_computer_unavailable",
          message: "The local Computer Use broker is unavailable.",
          details: nil
        ))
        return
      }
      DispatchQueue.main.async {
        self.handle(call: call, result: result)
      }
    }
  }

  func detach(channel: FlutterMethodChannel) {
    dispatchPrecondition(condition: .onQueue(.main))
    channel.setMethodCallHandler(nil)
    channels.removeValue(forKey: ObjectIdentifier(channel))
  }

  func stopForApplicationTermination() {
    dispatchPrecondition(condition: .onQueue(.main))
    stop(reason: "application_terminated", notifyFlutter: false)
    for channel in channels.values { channel.setMethodCallHandler(nil) }
    channels.removeAll()
  }

  private func handle(call: FlutterMethodCall, result: @escaping FlutterResult) {
    dispatchPrecondition(condition: .onQueue(.main))
    switch call.method {
    case "getStatus":
      guard call.arguments == nil else {
        result(invalidArguments())
        return
      }
      refreshStatus { status in result(status) }
    case "requestPermissions":
      guard call.arguments == nil, !active else {
        result(invalidArguments())
        return
      }
      requestPermissions { status in result(status) }
    case "setEnabled":
      guard let values = call.arguments as? [String: Any],
            values.count == 1,
            let requested = values["enabled"] as? Bool
      else {
        result(invalidArguments())
        return
      }
      setEnabled(requested) { status in result(status) }
    case "executeLocalComputerCommand":
      execute(call.arguments, result: result)
    case "addCommandWorkspace":
      guard call.arguments == nil else {
        result(invalidArguments())
        return
      }
      addCommandWorkspace { response in result(response) }
    case "removeCommandWorkspace":
      guard let values = call.arguments as? [String: Any],
            values.count == 1,
            let workspaceId = values["workspaceId"] as? String,
            Self.isWorkspaceId(workspaceId)
      else {
        result(invalidArguments())
        return
      }
      removeCommandWorkspace(workspaceId)
      result(status())
    case "stop":
      guard call.arguments == nil else {
        result(invalidArguments())
        return
      }
      stop(reason: "user_stopped", notifyFlutter: false)
      result(status())
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func addCommandWorkspace(completion: @escaping ([String: Any]) -> Void) {
    let panel = NSOpenPanel()
    panel.title = "Allow Asael to work in a folder"
    panel.message = "Choose one folder Asael may use for explicitly approved commands."
    panel.prompt = "Allow Folder"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false
    panel.resolvesAliases = true
    panel.begin { [weak self] response in
      guard let self else { return }
      guard response == .OK, let selected = panel.url else {
        completion(self.status())
        return
      }
      guard let root = Self.canonicalDirectory(selected),
            let bookmark = try? root.bookmarkData(
              options: [.withSecurityScope],
              includingResourceValuesForKeys: nil,
              relativeTo: nil
            ),
            !bookmark.isEmpty,
            bookmark.count <= 256 * 1_024
      else {
        completion(self.status())
        return
      }

      let name = Self.commandWorkspaceName(for: root)
      if let index = self.commandWorkspaceGrants.firstIndex(where: {
        Self.canonicalPath($0.lastKnownPath) == root.path
      }) {
        self.commandWorkspaceGrants[index].name = name
        self.commandWorkspaceGrants[index].bookmarkData = bookmark
        self.commandWorkspaceGrants[index].lastKnownPath = root.path
      } else if self.commandWorkspaceGrants.count < Self.maximumCommandWorkspaceCount,
                let workspaceId = Self.makeWorkspaceId(),
                !self.commandWorkspaceGrants.contains(where: { $0.id == workspaceId }) {
        self.commandWorkspaceGrants.append(CommandWorkspaceGrant(
          id: workspaceId,
          name: name,
          bookmarkData: bookmark,
          lastKnownPath: root.path
        ))
      }
      self.persistCommandWorkspaceGrants()
      completion(self.status())
    }
  }

  private func removeCommandWorkspace(_ workspaceId: String) {
    if commandWorkspaceId == workspaceId {
      terminateCommandHelper(outcome: "canceled", code: "workspace_access_revoked")
    }
    commandWorkspaceGrants.removeAll { $0.id == workspaceId }
    persistCommandWorkspaceGrants()
  }

  private func setEnabled(
    _ requested: Bool,
    completion: @escaping ([String: Any]) -> Void
  ) {
    if !requested {
      stop(reason: "disabled", notifyFlutter: false)
      completion(status())
      return
    }
    guard helperInstalled, supported, ensureHelper() else {
      enabled = false
      completion(status())
      return
    }
    enabled = true
    configureStatusItem()
    refreshStatus(completion: completion)
  }

  private func refreshStatus(completion: @escaping ([String: Any]) -> Void) {
    guard helperInstalled, supported, !active else {
      completion(status())
      return
    }
    // The Flutter coordinator refreshes its projection while Computer Use is
    // disabled. Do not launch and tear down the signed helper on every poll;
    // permission discovery resumes when the user enables or explicitly asks
    // for permissions.
    guard enabled || process != nil else {
      completion(status())
      return
    }
    guard ensureHelper() else {
      completion(status())
      return
    }
    let id = Self.makeCommandId()
    send(
      envelope(id: id, action: "status", input: [:], lifetime: 20),
      expiresIn: 20
    ) { [weak self] response in
      guard let self else { return }
      self.updatePermissions(from: response)
      completion(self.status())
    }
  }

  private func requestPermissions(completion: @escaping ([String: Any]) -> Void) {
    guard helperInstalled, supported else {
      completion(status())
      return
    }
    let shouldClose = !enabled && process == nil
    guard ensureHelper() else {
      completion(status())
      return
    }
    let id = Self.makeCommandId()
    send(
      envelope(id: id, action: "request_permissions", input: [:], lifetime: 120),
      expiresIn: 120
    ) { [weak self] response in
      guard let self else { return }
      self.updatePermissions(from: response)
      if shouldClose { self.terminateHelper(expected: true, pendingOutcome: "canceled") }
      completion(self.status())
    }
  }

  private func execute(_ arguments: Any?, result: @escaping FlutterResult) {
    guard enabled, !active, let values = arguments as? [String: Any],
          values.count == 4 || (
            values.count == 5 && values["authority"] as? String == "task"
          ),
          let id = values["id"] as? String,
          Self.isCommandId(id),
          let action = values["action"] as? String,
          Self.allowedActions.contains(action),
          values["authority"] == nil || Self.taskAuthorityActions.contains(action),
          let input = values["input"] as? [String: Any],
          let expiresAt = values["expiresAt"] as? String,
          let expiration = Self.parseDate(expiresAt),
          expiration > Date(),
          expiration.timeIntervalSinceNow <= (action == "run_command" ? 345 : 300),
          JSONSerialization.isValidJSONObject(input),
          let inputData = try? JSONSerialization.data(withJSONObject: input),
          inputData.count <= 64 * 1_024
    else {
      result(commandFailure("invalid_or_disabled_command"))
      return
    }

    purgeExpiredCompletions()
    if let prior = completed[id] {
      result(prior.output)
      return
    }
    if action == "run_command" {
      executeCommand(
        id: id,
        input: input,
        expiration: expiration,
        result: result
      )
      return
    }
    guard ensureHelper() else {
      result(commandFailure("helper_unavailable"))
      return
    }

    active = true
    updateStatusItem()
    send(values, expiresIn: max(0.25, expiration.timeIntervalSinceNow)) { [weak self] response in
      guard let self else { return }
      self.active = false
      self.updateStatusItem()
      self.updatePermissions(from: response)
      var channelResponse = response
      channelResponse.removeValue(forKey: "id")
      self.remember(id: id, output: channelResponse, expiresAt: expiration)
      result(channelResponse)
    }
  }

  private func executeCommand(
    id: String,
    input: [String: Any],
    expiration: Date,
    result: @escaping FlutterResult
  ) {
    guard commandHelperInstalled,
          Set(input.keys) == Self.commandInputKeys,
          let workspaceId = input["workspaceId"] as? String,
          Self.isWorkspaceId(workspaceId),
          let executable = input["executable"] as? String,
          Self.isCommandExecutable(executable),
          Self.commandPrograms.contains(executable),
          let arguments = input["arguments"] as? [String],
          arguments.count <= 64,
          arguments.allSatisfy(Self.isSafeCommandArgument),
          arguments.reduce(0, { $0 + $1.utf8.count }) <= 48 * 1_024,
          let relativeDirectory = input["relativeDirectory"] as? String,
          Self.isSafeRelativeDirectory(relativeDirectory),
          let timeoutSeconds = input["timeoutSeconds"] as? Int,
          (1...300).contains(timeoutSeconds),
          let workspace = resolveCommandWorkspace(workspaceId),
          let workingDirectory = Self.resolveCommandWorkingDirectory(
            root: workspace.root,
            relativeDirectory: relativeDirectory
          )
    else {
      result(commandFailure("invalid_command_input"))
      return
    }

    let didStartAccess = workspace.accessURL.startAccessingSecurityScopedResource()
    let helperInput: [String: Any] = [
      "workspaceId": workspace.id,
      "workspaceName": workspace.name,
      "workspaceRoot": workspace.root.path,
      "workingDirectory": workingDirectory.path,
      "executable": executable,
      "arguments": arguments,
      "relativeDirectory": relativeDirectory,
      "timeoutSeconds": timeoutSeconds,
    ]
    let helperEnvelope: [String: Any] = [
      "id": id,
      "action": "run_command",
      "input": helperInput,
      "expiresAt": Self.internetDateFormatter.string(from: expiration),
    ]

    active = true
    updateStatusItem()
    let launched = launchCommandHelper(
      envelope: helperEnvelope,
      expiresIn: min(
        expiration.timeIntervalSinceNow,
        TimeInterval(timeoutSeconds) + 2
      ),
      workspace: workspace,
      didStartAccess: didStartAccess
    ) { [weak self] response in
      guard let self else { return }
      self.active = false
      self.updateStatusItem()
      var channelResponse = response
      channelResponse.removeValue(forKey: "id")
      self.remember(id: id, output: channelResponse, expiresAt: expiration)
      result(channelResponse)
    }
    if !launched {
      active = false
      updateStatusItem()
      if didStartAccess { workspace.accessURL.stopAccessingSecurityScopedResource() }
      result(commandFailure("command_helper_unavailable"))
    }
  }

  private func launchCommandHelper(
    envelope: [String: Any],
    expiresIn: TimeInterval,
    workspace: ResolvedCommandWorkspace,
    didStartAccess: Bool,
    completion: @escaping ([String: Any]) -> Void
  ) -> Bool {
    guard commandProcess == nil,
          let id = envelope["id"] as? String,
          let executableURL = commandHelperExecutableURL,
          FileManager.default.isExecutableFile(atPath: executableURL.path),
          JSONSerialization.isValidJSONObject(envelope),
          var requestData = try? JSONSerialization.data(withJSONObject: envelope),
          requestData.count <= Self.maximumRequestBytes
    else { return false }

    let launched = Process()
    let input = Pipe()
    let output = Pipe()
    let errors = Pipe()
    launched.executableURL = executableURL
    launched.arguments = []
    launched.environment = [
      "LANG": "en_US.UTF-8",
      "LC_ALL": "en_US.UTF-8",
      "PATH": "/usr/bin:/bin",
    ]
    launched.standardInput = input
    launched.standardOutput = output
    launched.standardError = errors
    output.fileHandleForReading.readabilityHandler = { [weak self, weak launched] handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      DispatchQueue.main.async {
        guard let self, let launched, self.commandProcess === launched else { return }
        self.ingestCommandHelper(data)
      }
    }
    errors.fileHandleForReading.readabilityHandler = { handle in
      _ = handle.availableData
    }
    launched.terminationHandler = { [weak self, weak launched] _ in
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        guard let self, let launched, self.commandProcess === launched else { return }
        self.terminateCommandHelper(outcome: "failed", code: "command_helper_unavailable")
      }
    }

    do {
      try launched.run()
    } catch {
      output.fileHandleForReading.readabilityHandler = nil
      errors.fileHandleForReading.readabilityHandler = nil
      return false
    }
    commandProcess = launched
    commandInputPipe = input
    commandOutputPipe = output
    commandErrorPipe = errors
    commandOutputBuffer.removeAll(keepingCapacity: true)
    commandCompletion = completion
    commandExecutionId = id
    commandWorkspaceAccessURL = workspace.accessURL
    commandWorkspaceAccessStarted = didStartAccess
    commandWorkspaceId = workspace.id

    let timeout = DispatchWorkItem { [weak self, weak launched] in
      guard let self, let launched, self.commandProcess === launched else { return }
      self.terminateCommandHelper(outcome: "failed", code: "command_helper_timeout")
    }
    commandTimeoutWorkItem = timeout
    DispatchQueue.main.asyncAfter(
      deadline: .now() + min(max(expiresIn, 0.25), 302),
      execute: timeout
    )

    requestData.append(0x0a)
    do {
      try input.fileHandleForWriting.write(contentsOf: requestData)
      try input.fileHandleForWriting.close()
      return true
    } catch {
      terminateCommandHelper(outcome: "failed", code: "command_helper_unavailable")
      return true
    }
  }

  private func ingestCommandHelper(_ data: Data) {
    commandOutputBuffer.append(data)
    guard commandOutputBuffer.count <= Self.maximumCommandResponseBytes,
          let newline = commandOutputBuffer.firstIndex(of: 0x0a)
    else {
      if commandOutputBuffer.count > Self.maximumCommandResponseBytes {
        terminateCommandHelper(outcome: "failed", code: "command_helper_invalid_response")
      }
      return
    }
    let line = Data(commandOutputBuffer[..<newline])
    let trailing = commandOutputBuffer[commandOutputBuffer.index(after: newline)...]
    guard !line.isEmpty,
          trailing.isEmpty,
          let response = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
          response["id"] as? String == commandExecutionId,
          let outcome = response["outcome"] as? String,
          ["succeeded", "failed", "canceled"].contains(outcome)
    else {
      terminateCommandHelper(outcome: "failed", code: "command_helper_invalid_response")
      return
    }
    finishCommandHelper(response)
  }

  private func finishCommandHelper(_ response: [String: Any]) {
    commandTimeoutWorkItem?.cancel()
    commandTimeoutWorkItem = nil
    let completion = commandCompletion
    commandCompletion = nil
    commandProcess?.terminationHandler = nil
    commandOutputPipe?.fileHandleForReading.readabilityHandler = nil
    commandErrorPipe?.fileHandleForReading.readabilityHandler = nil
    try? commandInputPipe?.fileHandleForWriting.close()
    if commandWorkspaceAccessStarted {
      commandWorkspaceAccessURL?.stopAccessingSecurityScopedResource()
    }
    commandProcess = nil
    commandInputPipe = nil
    commandOutputPipe = nil
    commandErrorPipe = nil
    commandOutputBuffer.removeAll(keepingCapacity: false)
    commandExecutionId = nil
    commandWorkspaceAccessURL = nil
    commandWorkspaceAccessStarted = false
    commandWorkspaceId = nil
    completion?(response)
  }

  private func terminateCommandHelper(outcome: String, code: String) {
    guard commandProcess != nil || commandCompletion != nil else { return }
    let terminating = commandProcess
    let id = commandExecutionId ?? "invalid"
    if let terminating, terminating.isRunning {
      terminating.terminate()
      let deadline = DispatchTime.now() + Self.commandHelperStopGrace
      DispatchQueue.main.asyncAfter(deadline: deadline) { [weak terminating] in
        guard let terminating, terminating.isRunning else { return }
        let helper = terminating.processIdentifier
        Self.killChildProcessGroups(of: helper)
        kill(helper, SIGKILL)
      }
    }
    finishCommandHelper(Self.ipcResponse(id: id, outcome: outcome, code: code))
  }

  /// Kills the process group that each child of `parent` leads. A helper that
  /// has not exited in time may not have ended its command's group, which
  /// killing the helper alone would leave running.
  private static func killChildProcessGroups(of parent: pid_t) {
    guard parent > 1 else { return }
    var children = [pid_t](repeating: 0, count: 16)
    let bytes = proc_listpids(
      UInt32(PROC_PPID_ONLY),
      UInt32(parent),
      &children,
      Int32(children.count * MemoryLayout<pid_t>.stride)
    )
    guard bytes > 0 else { return }
    for child in children.prefix(Int(bytes) / MemoryLayout<pid_t>.stride) where child > 1 {
      _ = kill(-child, SIGKILL)
      _ = kill(child, SIGKILL)
    }
  }

  private func envelope(
    id: String,
    action: String,
    input: [String: Any],
    lifetime: TimeInterval
  ) -> [String: Any] {
    [
      "id": id,
      "action": action,
      "input": input,
      "expiresAt": Self.internetDateFormatter.string(
        from: Date().addingTimeInterval(lifetime)
      ),
    ]
  }

  private func send(
    _ envelope: [String: Any],
    expiresIn: TimeInterval,
    completion: @escaping ([String: Any]) -> Void
  ) {
    guard let id = envelope["id"] as? String else {
      completion(Self.ipcFailure(id: "invalid", code: "invalid_command"))
      return
    }
    if let existing = pending[id] {
      pending[id] = PendingRequest(
        callbacks: existing.callbacks + [completion],
        timeout: existing.timeout
      )
      return
    }
    guard JSONSerialization.isValidJSONObject(envelope),
          var data = try? JSONSerialization.data(withJSONObject: envelope),
          data.count <= Self.maximumRequestBytes,
          let inputPipe
    else {
      completion(Self.ipcFailure(id: id, code: "invalid_command"))
      return
    }

    let timeout = DispatchWorkItem { [weak self] in
      guard let self, let request = self.pending.removeValue(forKey: id) else { return }
      let failure = Self.ipcFailure(id: id, code: "helper_timeout")
      request.callbacks.forEach { $0(failure) }
      // Never leave an uncertain local effect running after its governed lease.
      self.terminateHelper(expected: false, pendingOutcome: "canceled")
    }
    pending[id] = PendingRequest(callbacks: [completion], timeout: timeout)
    DispatchQueue.main.asyncAfter(deadline: .now() + min(max(expiresIn, 0.25), 300), execute: timeout)
    data.append(0x0a)
    do {
      try inputPipe.fileHandleForWriting.write(contentsOf: data)
    } catch {
      timeout.cancel()
      pending.removeValue(forKey: id)
      completion(Self.ipcFailure(id: id, code: "helper_unavailable"))
      terminateHelper(expected: false, pendingOutcome: "failed")
    }
  }

  private func ensureHelper() -> Bool {
    if let process, process.isRunning { return true }
    guard let executableURL = helperExecutableURL,
          FileManager.default.isExecutableFile(atPath: executableURL.path)
    else { return false }

    let launched = Process()
    let input = Pipe()
    let output = Pipe()
    let errors = Pipe()
    launched.executableURL = executableURL
    launched.arguments = []
    // Do not inherit API keys, user shell configuration, HOME, or Asael's
    // credential environment. The helper needs no network and receives only IPC.
    launched.environment = [
      "LANG": "en_US.UTF-8",
      "PATH": "/usr/bin:/bin",
    ]
    launched.standardInput = input
    launched.standardOutput = output
    launched.standardError = errors
    let decoder = BoundedJSONObjectLineDecoder(
      maximumLineBytes: Self.maximumResponseBytes,
      maximumBufferBytes: Self.maximumResponseBytes * 2
    )
    output.fileHandleForReading.readabilityHandler = { [weak self, weak decoder] handle in
      let data = handle.availableData
      guard !data.isEmpty, let self, let decoder else { return }
      self.outputDecodeQueue.async { [weak self, weak decoder] in
        guard let self, let decoder else { return }
        let decoded = decoder.append(data)
        DispatchQueue.main.async { [weak self, weak decoder] in
          guard let self, let decoder else { return }
          self.ingest(decoded, from: decoder)
        }
      }
    }
    errors.fileHandleForReading.readabilityHandler = { handle in
      // Drain but never surface potentially sensitive operating-system details.
      _ = handle.availableData
    }
    launched.terminationHandler = { [weak self, weak launched] _ in
      DispatchQueue.main.async {
        guard let self, let launched, self.process === launched else { return }
        self.handleHelperTermination()
      }
    }

    do {
      try launched.run()
      process = launched
      inputPipe = input
      outputPipe = output
      errorPipe = errors
      outputDecoder = decoder
      expectedTermination = false
      return true
    } catch {
      output.fileHandleForReading.readabilityHandler = nil
      errors.fileHandleForReading.readabilityHandler = nil
      return false
    }
  }

  private func ingest(
    _ decoded: BoundedJSONObjectLineDecodeResult,
    from decoder: BoundedJSONObjectLineDecoder
  ) {
    guard outputDecoder === decoder else { return }
    let responses: [[String: Any]]
    switch decoded {
    case .incomplete:
      return
    case .invalid:
      terminateHelper(expected: false, pendingOutcome: "failed")
      return
    case .objects(let objects):
      responses = objects
    }

    for response in responses {
      guard let id = response["id"] as? String,
            let outcome = response["outcome"] as? String,
            ["succeeded", "failed", "canceled"].contains(outcome),
            let request = pending.removeValue(forKey: id)
      else {
        terminateHelper(expected: false, pendingOutcome: "failed")
        return
      }
      request.timeout.cancel()
      request.callbacks.forEach { $0(response) }
    }
  }

  private func handleHelperTermination() {
    let wasExpected = expectedTermination
    expectedTermination = false
    clearProcessReferences()
    clearCompletedRequests()
    if !wasExpected {
      active = false
      enabled = false
      removeStatusItem()
    }
    failPending(outcome: "failed", code: "helper_unavailable")
    if !wasExpected {
      notifyStopped(reason: "helper_unavailable")
    }
  }

  private func terminateHelper(expected: Bool, pendingOutcome: String) {
    expectedTermination = expected
    let terminating = process
    failPending(
      outcome: pendingOutcome,
      code: pendingOutcome == "canceled" ? "stopped" : "helper_unavailable"
    )
    outputPipe?.fileHandleForReading.readabilityHandler = nil
    errorPipe?.fileHandleForReading.readabilityHandler = nil
    try? inputPipe?.fileHandleForWriting.close()
    if let terminating, terminating.isRunning {
      terminating.terminate()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self, weak terminating] in
        guard let self, let terminating, self.process === terminating,
              terminating.isRunning
        else { return }
        kill(terminating.processIdentifier, SIGKILL)
      }
    } else {
      clearProcessReferences()
    }
  }

  private func clearProcessReferences() {
    outputPipe?.fileHandleForReading.readabilityHandler = nil
    errorPipe?.fileHandleForReading.readabilityHandler = nil
    process = nil
    inputPipe = nil
    outputPipe = nil
    errorPipe = nil
    outputDecoder = nil
  }

  private func failPending(outcome: String, code: String) {
    let requests = pending
    pending.removeAll()
    for (id, request) in requests {
      request.timeout.cancel()
      let failure = Self.ipcResponse(id: id, outcome: outcome, code: code)
      request.callbacks.forEach { $0(failure) }
    }
  }

  private func stop(reason: String, notifyFlutter: Bool) {
    enabled = false
    active = false
    terminateCommandHelper(outcome: "canceled", code: "stopped")
    terminateHelper(expected: true, pendingOutcome: "canceled")
    clearCompletedRequests()
    removeStatusItem()
    if notifyFlutter { notifyStopped(reason: reason) }
  }

  private func notifyStopped(reason: String) {
    for channel in channels.values {
      channel.invokeMethod("localComputerStopped", arguments: ["reason": reason])
    }
  }

  private func configureStatusItem() {
    guard statusItem == nil else {
      updateStatusItem()
      return
    }
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    let state = NSMenuItem(title: "Local Computer Use is ready", action: nil, keyEquivalent: "")
    state.isEnabled = false
    statusMenuItem = state
    menu.addItem(state)
    menu.addItem(.separator())
    let stop = NSMenuItem(
      title: "Stop Asael Computer Use",
      action: #selector(stopFromMenu),
      keyEquivalent: "."
    )
    stop.keyEquivalentModifierMask = [.command]
    stop.target = self
    menu.addItem(stop)
    item.menu = menu
    statusItem = item
    updateStatusItem()
  }

  private func updateStatusItem() {
    guard let statusItem else { return }
    statusItem.button?.title = active ? "● Asael is controlling" : "◉ Asael ready"
    statusItem.button?.toolTip = active
      ? "Asael is currently operating this Mac. Click to stop immediately."
      : "Local Computer Use is enabled. Click to review or stop."
    statusMenuItem?.title = active
      ? "Asael is controlling this Mac"
      : "Local Computer Use is ready"
  }

  private func removeStatusItem() {
    if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
    statusItem = nil
    statusMenuItem = nil
  }

  @objc private func stopFromMenu() {
    stop(reason: "kill_switch", notifyFlutter: true)
  }

  private func updatePermissions(from response: [String: Any]) {
    guard response["outcome"] as? String == "succeeded",
          let result = response["result"] as? [String: Any],
          let data = result["data"] as? [String: Any]
    else { return }
    if let value = data["accessibility"] as? String,
       ["granted", "denied", "unknown"].contains(value) {
      accessibility = value
    }
    if let value = data["screenRecording"] as? String,
       ["granted", "denied", "unknown"].contains(value) {
      screenRecording = value
    }
  }

  private func status() -> [String: Any] {
    [
      "supported": supported,
      "helperInstalled": helperInstalled,
      "enabled": enabled,
      "active": active,
      "accessibility": accessibility,
      "screenRecording": screenRecording,
      "helperVersion": helperVersion,
      "commandHelperInstalled": commandHelperInstalled,
      "commandHelperVersion": commandHelperVersion,
      "commandWorkspaces": commandHelperInstalled ? publicCommandWorkspaces : [],
    ]
  }

  private var supported: Bool {
    if #available(macOS 14.0, *) { return true }
    return false
  }

  private var helperInstalled: Bool {
    cachedHelperInstalled
  }

  private func computeHelperInstalled() -> Bool {
    guard let helperBundleURL,
          let bundle = Bundle(url: helperBundleURL),
          bundle.bundleIdentifier == Self.helperBundleIdentifier,
          let executable = helperExecutableURL
    else { return false }
    return FileManager.default.isExecutableFile(atPath: executable.path)
  }

  private var helperBundleURL: URL? {
    Bundle.main.bundleURL
      .appendingPathComponent("Contents", isDirectory: true)
      .appendingPathComponent("Helpers", isDirectory: true)
      .appendingPathComponent(Self.helperBundleName, isDirectory: true)
  }

  private var helperExecutableURL: URL? {
    helperBundleURL?
      .appendingPathComponent("Contents/MacOS", isDirectory: true)
      .appendingPathComponent(Self.helperExecutableName, isDirectory: false)
  }

  private var helperVersion: String {
    cachedHelperVersion
  }

  private func computeHelperVersion() -> String {
    guard let helperBundleURL,
          let bundle = Bundle(url: helperBundleURL),
          let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
          version.count <= 40
    else { return "unavailable" }
    return version
  }

  private var commandHelperInstalled: Bool {
    cachedCommandHelperInstalled
  }

  private func computeCommandHelperInstalled() -> Bool {
    guard let commandHelperBundleURL,
          let bundle = Bundle(url: commandHelperBundleURL),
          bundle.bundleIdentifier == Self.commandHelperBundleIdentifier,
          let version = bundle.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
          ) as? String,
          version.range(
            of: #"^[0-9]+\.[0-9]+\.[0-9]+$"#,
            options: .regularExpression
          ) != nil,
          let executable = commandHelperExecutableURL
    else { return false }
    return FileManager.default.isExecutableFile(atPath: executable.path)
  }

  private var commandHelperBundleURL: URL? {
    Bundle.main.bundleURL
      .appendingPathComponent("Contents", isDirectory: true)
      .appendingPathComponent("Helpers", isDirectory: true)
      .appendingPathComponent(Self.commandHelperBundleName, isDirectory: true)
  }

  private var commandHelperExecutableURL: URL? {
    commandHelperBundleURL?
      .appendingPathComponent("Contents/MacOS", isDirectory: true)
      .appendingPathComponent(Self.commandHelperExecutableName, isDirectory: false)
  }

  private var commandHelperVersion: String {
    cachedCommandHelperVersion
  }

  private func computeCommandHelperVersion() -> String {
    guard let commandHelperBundleURL,
          let bundle = Bundle(url: commandHelperBundleURL),
          let version = bundle.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
          ) as? String,
          version.count <= 40
    else { return "unavailable" }
    return version
  }

  private var publicCommandWorkspaces: [[String: Any]] {
    if let cachedPublicCommandWorkspaces { return cachedPublicCommandWorkspaces }
    let grants = commandWorkspaceGrants
      .filter { Self.isWorkspaceId($0.id) && Self.isWorkspaceName($0.name) }
      .sorted {
        if $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedSame {
          return $0.id < $1.id
        }
        return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
      }
    var seenPaths = Set<String>()
    let projection = grants.compactMap { grant -> [String: Any]? in
      guard let path = Self.canonicalPath(grant.lastKnownPath),
            seenPaths.insert(path).inserted
      else { return nil }
      return [
        "id": grant.id,
        "name": grant.name,
        "path": path,
      ]
    }
    cachedPublicCommandWorkspaces = projection
    return projection
  }

  private func resolveCommandWorkspace(_ workspaceId: String) -> ResolvedCommandWorkspace? {
    guard let index = commandWorkspaceGrants.firstIndex(where: { $0.id == workspaceId })
    else { return nil }
    var isStale = false
    guard let bookmarked = try? URL(
      resolvingBookmarkData: commandWorkspaceGrants[index].bookmarkData,
      options: [.withSecurityScope, .withoutUI],
      relativeTo: nil,
      bookmarkDataIsStale: &isStale
    ) else { return nil }
    let didStartAccess = bookmarked.startAccessingSecurityScopedResource()
    defer {
      if didStartAccess { bookmarked.stopAccessingSecurityScopedResource() }
    }
    guard let root = Self.canonicalDirectory(bookmarked) else { return nil }

    var changed = isStale
    if isStale,
       let refreshed = try? root.bookmarkData(
         options: [.withSecurityScope],
         includingResourceValuesForKeys: nil,
         relativeTo: nil
       ) {
      commandWorkspaceGrants[index].bookmarkData = refreshed
    }
    if commandWorkspaceGrants[index].lastKnownPath != root.path {
      commandWorkspaceGrants[index].lastKnownPath = root.path
      changed = true
    }
    if changed { persistCommandWorkspaceGrants() }
    return ResolvedCommandWorkspace(
      id: commandWorkspaceGrants[index].id,
      name: commandWorkspaceGrants[index].name,
      root: root,
      accessURL: bookmarked
    )
  }

  private func persistCommandWorkspaceGrants() {
    cachedPublicCommandWorkspaces = nil
    let sanitized = Array(commandWorkspaceGrants.prefix(Self.maximumCommandWorkspaceCount))
    guard let encoded = try? JSONEncoder().encode(sanitized),
          encoded.count <= 2 * 1_024 * 1_024
    else { return }
    UserDefaults.standard.set(encoded, forKey: Self.commandWorkspaceDefaultsKey)
  }

  private static func loadCommandWorkspaceGrants() -> [CommandWorkspaceGrant] {
    guard let data = UserDefaults.standard.data(forKey: commandWorkspaceDefaultsKey),
          data.count <= 2 * 1_024 * 1_024,
          let decoded = try? JSONDecoder().decode([CommandWorkspaceGrant].self, from: data)
    else { return [] }
    var seen = Set<String>()
    return decoded.compactMap { grant in
      guard seen.count < maximumCommandWorkspaceCount,
            isWorkspaceId(grant.id),
            seen.insert(grant.id).inserted,
            isWorkspaceName(grant.name),
            !grant.bookmarkData.isEmpty,
            grant.bookmarkData.count <= 256 * 1_024,
            grant.lastKnownPath.hasPrefix("/"),
            grant.lastKnownPath.utf8.count <= 4_096,
            !grant.lastKnownPath.unicodeScalars.contains(where: {
              $0.value < 0x20 || $0.value == 0x7f
            })
      else { return nil }
      return grant
    }
  }

  private static func canonicalDirectory(_ url: URL) -> URL? {
    let canonical = url.standardizedFileURL.resolvingSymlinksInPath()
    guard canonical.isFileURL, canonical.path.hasPrefix("/"),
          canonical.path.utf8.count <= 4_096,
          !canonical.path.unicodeScalars.contains(where: {
            $0.value < 0x20 || $0.value == 0x7f
          })
    else { return nil }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: canonical.path, isDirectory: &isDirectory),
          isDirectory.boolValue
    else { return nil }
    return canonical
  }

  private static func canonicalPath(_ path: String) -> String? {
    guard path.hasPrefix("/"), path.utf8.count <= 4_096,
          !path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
    else { return nil }
    return URL(fileURLWithPath: path, isDirectory: true)
      .standardizedFileURL
      .resolvingSymlinksInPath()
      .path
  }

  private static func resolveCommandWorkingDirectory(
    root: URL,
    relativeDirectory: String
  ) -> URL? {
    let candidate = relativeDirectory.isEmpty
      ? root
      : root.appendingPathComponent(relativeDirectory, isDirectory: true)
    guard let canonical = canonicalDirectory(candidate),
          root.path == "/"
            || canonical.path == root.path
            || canonical.path.hasPrefix(root.path + "/")
    else { return nil }
    return canonical
  }

  private static func commandWorkspaceName(for root: URL) -> String {
    let proposed = root.lastPathComponent.isEmpty ? "Root" : root.lastPathComponent
    let safeScalars = proposed.unicodeScalars.filter {
      $0.value >= 0x20 && $0.value != 0x7f
    }
    var scalarText = ""
    for scalar in safeScalars { scalarText.unicodeScalars.append(scalar) }
    let sanitized = scalarText.trimmingCharacters(in: .whitespacesAndNewlines)
    let name = sanitized.isEmpty ? "Workspace" : sanitized
    return String(name.prefix(120))
  }

  private static func makeWorkspaceId() -> String? {
    var bytes = [UInt8](repeating: 0, count: 16)
    let status = bytes.withUnsafeMutableBytes { buffer in
      SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
    }
    guard status == errSecSuccess else { return nil }
    return "local_workspace_" + bytes.map { String(format: "%02x", $0) }.joined()
  }

  private static func isWorkspaceId(_ value: String) -> Bool {
    value.range(
      of: #"^local_workspace_[a-f0-9]{32}$"#,
      options: .regularExpression
    ) != nil
  }

  private static func isWorkspaceName(_ value: String) -> Bool {
    (1...120).contains(value.count)
      && !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
  }

  private static func isCommandExecutable(_ value: String) -> Bool {
    value.utf8.count <= 64
      && value.range(
        of: #"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$"#,
        options: .regularExpression
      ) != nil
  }

  private static func isSafeCommandArgument(_ value: String) -> Bool {
    value.utf8.count <= 8 * 1_024
      && !value.unicodeScalars.contains(where: {
        $0.value == 0 || ($0.value < 0x20 && $0.value != 0x09) || $0.value == 0x7f
      })
  }

  private static func isSafeRelativeDirectory(_ value: String) -> Bool {
    guard !value.isEmpty,
          value.utf8.count <= 1_024,
          !value.hasPrefix("/"),
          !value.hasPrefix("~"),
          !value.contains("\\"),
          !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
    else { return false }
    if value == "." { return true }
    return value.split(separator: "/", omittingEmptySubsequences: false).allSatisfy {
      !$0.isEmpty && $0 != "." && $0 != ".."
    }
  }

  private func remember(id: String, output: [String: Any], expiresAt: Date) {
    purgeExpiredCompletions(scheduleNext: false)
    guard expiresAt > Date() else {
      scheduleCompletionExpiry()
      return
    }
    completed[id] = CompletedRequest(output: output, expiresAt: expiresAt)
    completionOrder.removeAll { $0 == id }
    completionOrder.append(id)
    while completionOrder.count > 128 {
      completed.removeValue(forKey: completionOrder.removeFirst())
    }
    scheduleCompletionExpiry()
  }

  private func purgeExpiredCompletions(
    at now: Date = Date(),
    scheduleNext: Bool = true
  ) {
    completed = completed.filter { $0.value.expiresAt > now }
    completionOrder.removeAll { completed[$0] == nil }
    if scheduleNext { scheduleCompletionExpiry() }
  }

  private func scheduleCompletionExpiry() {
    completionExpiryWorkItem?.cancel()
    completionExpiryWorkItem = nil
    guard let nextExpiry = completed.values.map(\.expiresAt).min() else { return }
    let work = DispatchWorkItem { [weak self] in
      self?.purgeExpiredCompletions()
    }
    completionExpiryWorkItem = work
    DispatchQueue.main.asyncAfter(
      deadline: .now() + max(0, nextExpiry.timeIntervalSinceNow),
      execute: work
    )
  }

  private func clearCompletedRequests() {
    completionExpiryWorkItem?.cancel()
    completionExpiryWorkItem = nil
    completed.removeAll(keepingCapacity: false)
    completionOrder.removeAll(keepingCapacity: false)
  }

  private func invalidArguments() -> FlutterError {
    FlutterError(
      code: "invalid_local_computer_arguments",
      message: "The local Computer Use request is invalid.",
      details: nil
    )
  }

  private func commandFailure(_ code: String) -> [String: Any] {
    ["outcome": "failed", "errorCode": code]
  }

  private static func ipcFailure(id: String, code: String) -> [String: Any] {
    ipcResponse(id: id, outcome: "failed", code: code)
  }

  private static func ipcResponse(id: String, outcome: String, code: String) -> [String: Any] {
    ["id": id, "outcome": outcome, "errorCode": code]
  }

  private static func isCommandId(_ value: String) -> Bool {
    value.range(
      of: #"^local_computer_command_[a-f0-9]{48}$"#,
      options: .regularExpression
    ) != nil
  }

  private static func makeCommandId() -> String {
    let first = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    let second = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    return "local_computer_command_\(first)\(second.prefix(16))"
  }

  private static func parseDate(_ value: String) -> Date? {
    fractionalInternetDateFormatter.date(from: value)
      ?? internetDateFormatter.date(from: value)
  }
}

/// A content-minimal, crash-safe handoff for notification lifecycle events.
///
/// APNs may launch the process and deliver a response before Flutter has created
/// its channel or restored the authenticated session. The host therefore keeps
/// only the causal Asael envelope plus an action/lifecycle marker, never the APS
/// alert title/body. Flutter removes an event only after it has durably queued
/// the corresponding governed API receipt.
final class NativeNotificationBridgeEventStore {
  static let defaultsKey = "AsaelPendingNotificationBridgeEventsV1"
  static let maximumEvents = 32

  init(
    defaults: UserDefaults = .standard,
    synchronize: (() -> Bool)? = nil
  ) {
    self.defaults = defaults
    self.synchronize = synchronize ?? { defaults.synchronize() }
  }

  private let defaults: UserDefaults
  private let synchronize: () -> Bool

  func enqueue(method: String, arguments: [String: Any]) -> Bool {
    guard Self.allowedMethods.contains(method),
          PropertyListSerialization.propertyList(arguments, isValidFor: .binary),
          let encoded = try? JSONSerialization.data(withJSONObject: arguments),
          encoded.count <= 24 * 1_024,
          let dedupeKey = Self.dedupeKey(method: method, arguments: arguments)
    else { return false }

    let originalRecords = load()
    var records = originalRecords
    if records.contains(where: { $0["dedupeKey"] as? String == dedupeKey }) {
      return true
    }
    if records.count >= Self.maximumEvents {
      guard method == "notificationAction",
            let receivedIndex = records.firstIndex(where: {
              $0["method"] as? String == "notificationReceived"
            })
      else { return false }
      // A direct user action is stronger evidence than a receipt-only event.
      // If the bounded cold-launch store is full, retain that action by
      // evicting only the oldest passive delivery observation.
      records.remove(at: receivedIndex)
    }
    let id = UUID().uuidString.lowercased()
    records.append([
      "schemaVersion": 1,
      "id": id,
      "dedupeKey": dedupeKey,
      "method": method,
      "arguments": arguments,
    ])
    defaults.set(records, forKey: Self.defaultsKey)
    guard synchronize(),
          load().contains(where: { $0["id"] as? String == id })
    else {
      if originalRecords.isEmpty {
        defaults.removeObject(forKey: Self.defaultsKey)
      } else {
        defaults.set(originalRecords, forKey: Self.defaultsKey)
      }
      _ = synchronize()
      return false
    }
    return true
  }

  func first() -> [String: Any]? {
    load().first
  }

  func remove(id: String) {
    let retained = load().filter { $0["id"] as? String != id }
    if retained.isEmpty {
      defaults.removeObject(forKey: Self.defaultsKey)
    } else {
      defaults.set(retained, forKey: Self.defaultsKey)
    }
    _ = synchronize()
  }

  var count: Int { load().count }

  private func load() -> [[String: Any]] {
    guard let values = defaults.array(forKey: Self.defaultsKey) else { return [] }
    return values.compactMap { value in
      guard let record = value as? [String: Any],
            record.count == 5,
            record["schemaVersion"] as? Int == 1,
            let id = record["id"] as? String,
            UUID(uuidString: id) != nil,
            let dedupeKey = record["dedupeKey"] as? String,
            !dedupeKey.isEmpty,
            dedupeKey.utf8.count <= 640,
            let method = record["method"] as? String,
            Self.allowedMethods.contains(method),
            let arguments = record["arguments"] as? [String: Any],
            PropertyListSerialization.propertyList(arguments, isValidFor: .binary)
      else { return nil }
      return record
    }
  }

  private static let allowedMethods: Set<String> = [
    "notificationReceived", "notificationAction",
  ]

  private static func dedupeKey(
    method: String,
    arguments: [String: Any]
  ) -> String? {
    guard let data = arguments["data"] as? [String: Any],
          let deliveryId = envelopeValue("deliveryId", data: data),
          !deliveryId.isEmpty,
          deliveryId.utf8.count <= 240
    else { return nil }
    let action = arguments["action"] as? String ?? "received"
    return "\(method):\(deliveryId):\(action)"
  }

  private static func envelopeValue(_ name: String, data: [String: Any]) -> String? {
    if let envelope = data["asael"] as? [String: Any] {
      return envelope[name] as? String
    }
    if let encoded = data["asael"] as? String,
       let bytes = encoded.data(using: .utf8), bytes.count <= 16 * 1_024,
       let envelope = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] {
      return envelope[name] as? String
    }
    return data[name] as? String
  }
}

/// Owns Asael's small native desktop surface. Product behavior remains in Flutter;
/// this controller only keeps the app available and forwards explicit navigation.
private final class DesktopHostController: NSObject {
  private var watchAlertScope: String?
  private var watchAlertsInFlight = Set<String>()
  private let watchIntents = DesktopWatchIntentStore()
  private var watchIntentHandlerReady = false
  private var watchIntentInFlight = false
  private var watchIntentGeneration = 0
  private enum QuickEntryShortcut: String {
    case commandShiftSpace = "command_shift_space"
    case optionSpace = "option_space"
    case controlSpace = "control_space"
    case disabled

    var carbonModifiers: UInt32 {
      switch self {
      case .commandShiftSpace: UInt32(cmdKey | shiftKey)
      case .optionSpace: UInt32(optionKey)
      case .controlSpace: UInt32(controlKey)
      case .disabled: 0
      }
    }

    var menuModifiers: NSEvent.ModifierFlags {
      switch self {
      case .commandShiftSpace: [.command, .shift]
      case .optionSpace: [.option]
      case .controlSpace: [.control]
      case .disabled: []
      }
    }

    var displayName: String {
      switch self {
      case .commandShiftSpace: "Command-Shift-Space"
      case .optionSpace: "Option-Space"
      case .controlSpace: "Control-Space"
      case .disabled: "disabled"
      }
    }
  }

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
    let allNames: Set<String>
  }

  private enum NotificationAction: String {
    case open
    case complete
    case snooze15
    case dismiss
  }

  /// Content-free events emitted only by the primary desktop host. Focus and
  /// activation changes are intentionally not part of this contract.
  private enum SystemLifecycleEvent: String {
    case systemWillSleep
    case systemDidWake
    case sessionLocked
    case sessionUnlocked
  }

  /// A presentation-only reflection of the Flutter voice surface. These states
  /// never carry a prompt, approval, execution target, or Computer Use grant.
  private enum AmbientVoiceState: String {
    case asleep
    case starting
    case listening
    case processing
    case review
    case running
    case speaking
    case approval
    case offline
    case error

    var title: String {
      switch self {
      case .asleep: "Ready"
      case .starting: "Connecting"
      case .listening: "Listening"
      case .processing: "Finishing transcript"
      case .review: "Review before sending"
      case .running: "Working"
      case .speaking: "Speaking"
      case .approval: "Approval needed"
      case .offline: "Offline"
      case .error: "Needs attention"
      }
    }

    var symbolName: String {
      switch self {
      case .asleep: "sparkles"
      case .starting: "network"
      case .listening: "mic.fill"
      case .processing: "text.bubble"
      case .review: "text.bubble.fill"
      case .running: "sparkles"
      case .speaking: "waveform.circle.fill"
      case .approval: "exclamationmark.shield.fill"
      case .offline: "wifi.slash"
      case .error: "exclamationmark.triangle.fill"
      }
    }
  }

  private enum AmbientVoiceRequestSource: String {
    case menu
    case shortcut
    case vocalShortcut = "vocal_shortcut"
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
  private static let quickEntryShortcutDefaultsKey = "AsaelQuickEntryShortcutV1"
  private static let ambientVoiceAvailabilityDefaultsKey = "AsaelAmbientVoiceAvailableV1"
  private static let ambientVoiceConsentDefaultsPrefix = "AsaelAmbientVoiceConsentV2."
  private static let ambientVoiceConsentTerms = "openai:continuous_conversation:audio_not_stored_by_asael:conversation_history:v2"
  private static let desktopChannelName = "app.omniagent.omniagent/desktop"
  private static let quickEntryWindowMinimumSize = NSSize(width: 680, height: 320)
  private static let quickEntryWindowSize = NSSize(width: 760, height: 400)
  private static let ambientVoiceWindowSize = NSSize(width: 400, height: 280)
  private static let appGroupIdentifier = "group.app.omniagent.omniagent"
  private static let sharedCaptureInbox = "ShareInbox"
  private static let sharedCaptureManifest = "manifest.json"
  private static let sharedCaptureMaxFiles = 25
  private static let sharedCaptureMaxFileBytes = 5 * 1_024 * 1_024
  private static let sharedCaptureIOQueue = DispatchQueue(
    label: "app.omniagent.omniagent.shared-capture-io",
    qos: .utility
  )
  private static let sharedCaptureRequestPattern = try! NSRegularExpression(
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
  )
  private static let workspaceRoutePattern = try! NSRegularExpression(
    pattern: "^/(?:(talk|today|capture|inbox|knowledge|projects|meetings|results|automation|activity)(/[A-Za-z0-9._~%:-]{1,500})?|results/approval(?::|%3[Aa])[A-Za-z0-9._~%:-]{1,480}\\?kind=(tool|workflow|slo_policy)|projects/[A-Za-z0-9._~%:-]{1,240}\\?workItemId=[A-Za-z0-9._~%:-]{1,240}|projects/[A-Za-z0-9._~%:-]{1,240}\\?view=build(?:&artifact=[A-Za-z0-9._~%:-]{1,240})?(?:&workItemId=[A-Za-z0-9._~%:-]{1,240})?|watches(?:/watch_[a-f0-9]{48})?|responsibilities(?:/responsibility(?::|%3[Aa])[a-f0-9]{64})?|knowledge\\?memory=[A-Za-z0-9._~%:-]{1,240})$"
  )

  private weak var window: NSWindow?
  private var channel: FlutterMethodChannel?
  private var statusItem: NSStatusItem?
  private weak var statusQuickEntryMenuItem: NSMenuItem?
  private weak var statusAmbientVoiceMenuItem: NSMenuItem?
  private weak var statusAmbientVoiceStateMenuItem: NSMenuItem?
  private weak var applicationQuickEntryMenuItem: NSMenuItem?
  private weak var applicationAmbientVoiceMenuItem: NSMenuItem?
  private var hotKey: EventHotKeyRef?
  private var hotKeyEventHandler: EventHandlerRef?
  private var quickEntryShortcut = QuickEntryShortcut.commandShiftSpace
  private var shortcutRegistered = false
  private var pendingRoute: Route?
  private var pendingAmbientVoiceSource: AmbientVoiceRequestSource?
  private var ambientVoiceAvailable = false
  private var ambientVoiceState = AmbientVoiceState.asleep
  private var isDartReady = false
  private var isNotificationHandlerReady = false
  private var notificationDeliveryInFlight = false
  private let notificationBridgeEvents = NativeNotificationBridgeEventStore()
  private var workspaceLifecycleObservers: [NSObjectProtocol] = []
  private var distributedLifecycleObservers: [NSObjectProtocol] = []
  private var pendingSystemLifecycleEvents: [SystemLifecycleEvent] = []
  private var systemLifecycleDeliveryInFlight = false
  private var systemLifecycleDeliveryGeneration = 0
  private var systemIsSleeping = false
  private var lastSessionProtectionEvent: SystemLifecycleEvent?
  private var hasStarted = false
  private var isAmbientVoicePresented = false
  private let windowPresentation = DesktopWindowPresentation()
  private var deliveredSharedCaptureIds = Set<String>()
  private var sharedCaptureRemovalIds = Set<String>()
  private var deferredSharedCaptureIds = Set<String>()
  private var heldSharedCaptureIds = Set<String>()
  private var sharedCaptureHandlerReady = false
  private var sharedCaptureDeliveryInFlight = false
  private var sharedCaptureScanInFlight = false
  private var sharedCaptureScanRequested = false
  private var sharedCaptureScanGeneration = 0
  private var workspaceWindows: [UUID: AsaelWorkspaceWindowController] = [:]

  func start() {
    guard !hasStarted else { return }
    hasStarted = true
    quickEntryShortcut = savedQuickEntryShortcut()
    ambientVoiceAvailable = savedAmbientVoiceAvailability()
    observeSystemLifecycle()
    configureApplicationMenu()
    configureStatusItem()
    let registered = registerQuickEntryHotKey()
    updateQuickEntryMenus(registrationSucceeded: registered)
  }

  func stop() {
    channel?.setMethodCallHandler(nil)
    channel = nil
    isDartReady = false
    watchIntentHandlerReady = false
    sharedCaptureHandlerReady = false
    watchIntentInFlight = false
    watchIntentGeneration += 1
    watchAlertScope = nil
    pendingAmbientVoiceSource = nil
    ambientVoiceState = .asleep
    isNotificationHandlerReady = false
    notificationDeliveryInFlight = false
    removeSystemLifecycleObservers()
    pendingSystemLifecycleEvents.removeAll()
    systemLifecycleDeliveryGeneration += 1
    systemLifecycleDeliveryInFlight = false
    systemIsSleeping = false
    lastSessionProtectionEvent = nil
    deliveredSharedCaptureIds.removeAll()
    deferredSharedCaptureIds.removeAll()
    heldSharedCaptureIds.removeAll()
    sharedCaptureRemovalIds.removeAll()
    sharedCaptureDeliveryInFlight = false
    sharedCaptureScanGeneration += 1
    sharedCaptureScanInFlight = false
    sharedCaptureScanRequested = false

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
    statusAmbientVoiceMenuItem = nil
    statusAmbientVoiceStateMenuItem = nil
    if let applicationQuickEntryMenuItem,
       let menu = applicationQuickEntryMenuItem.menu {
      menu.removeItem(applicationQuickEntryMenuItem)
    }
    applicationQuickEntryMenuItem = nil
    if let applicationAmbientVoiceMenuItem,
       let menu = applicationAmbientVoiceMenuItem.menu {
      menu.removeItem(applicationAmbientVoiceMenuItem)
    }
    applicationAmbientVoiceMenuItem = nil
    for controller in Array(workspaceWindows.values) {
      controller.close()
    }
    workspaceWindows.removeAll()
  }

  func attach(channel: FlutterMethodChannel, window: NSWindow) {
    self.channel?.setMethodCallHandler(nil)
    self.channel = channel
    self.window = window
    watchIntentHandlerReady = false
    sharedCaptureHandlerReady = false
    watchIntentInFlight = false
    watchIntentGeneration += 1
    watchAlertScope = nil
    restoreMainWindowPresentation(window)
    isDartReady = false
    isNotificationHandlerReady = false
    systemLifecycleDeliveryGeneration += 1
    systemLifecycleDeliveryInFlight = false
    ambientVoiceState = .asleep
    if hasStarted {
      updateAmbientVoicePresentation()
    }

    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else {
        result(FlutterError(code: "host_unavailable", message: "Desktop host is unavailable.", details: nil))
        return
      }

      if self.handleAmbientVoiceMethod(
        call,
        allowsStateUpdates: true,
        result: result
      ) {
        return
      }

      switch call.method {
      case "flutterReady":
        DispatchQueue.main.async {
          self.isDartReady = true
          self.deliverNextWatchIntent()
          self.flushPendingRoute()
          self.flushPendingAmbientVoiceRequest()
          self.deliverNextSharedCapture()
          self.deliverNextSystemLifecycleEvent()
        }
        result(nil)
      case "notificationHandlerReady":
        guard call.arguments == nil else {
          result(FlutterError(code: "invalid_notification_handler", message: "The notification handler handshake is invalid.", details: nil))
          return
        }
        DispatchQueue.main.async {
          self.isNotificationHandlerReady = true
          self.deliverNextNotificationEvent()
        }
        result(nil)
      case "notificationHandlerPaused":
        guard call.arguments == nil else {
          result(FlutterError(code: "invalid_notification_handler", message: "The notification handler handshake is invalid.", details: nil))
          return
        }
        self.isNotificationHandlerReady = false
        result(nil)
      case "showMainPresentation":
        DispatchQueue.main.async {
          self.showMainWindow(notifyFlutter: false)
          result(nil)
        }
      case "showQuickEntryPresentation":
        DispatchQueue.main.async {
          self.showQuickEntryWindow()
          result(nil)
        }
      case "showAmbientVoicePresentation":
        let options = call.arguments as? [String: Any]
        let appearance = options?["appearance"] as? String ?? "companion"
        let width = (options?["width"] as? NSNumber)?.doubleValue ?? Double(Self.ambientVoiceWindowSize.width)
        let height = (options?["height"] as? NSNumber)?.doubleValue ?? Double(Self.ambientVoiceWindowSize.height)
        let reduceMotion = options?["reduceMotion"] as? Bool ?? false
        guard ["companion", "perch"].contains(appearance),
              width.isFinite, height.isFinite,
              (300...800).contains(width), (108...760).contains(height) else {
          result(FlutterError(code: "invalid_voice_presentation", message: "The voice window appearance is unavailable.", details: nil))
          return
        }
        DispatchQueue.main.async {
          self.showAmbientVoiceWindow(
            appearance: appearance,
            size: NSSize(width: width, height: height),
            reduceMotion: reduceMotion
          )
          result(nil)
        }
      case "watchNotificationHandlerReady", "watchNotificationHandlerPaused":
        guard call.arguments == nil else {
          result(FlutterError(code: "invalid_watch_alert", message: nil, details: nil)); return
        }
        self.watchIntentHandlerReady = call.method == "watchNotificationHandlerReady"
        self.deliverNextWatchIntent()
        result(nil)
      case "watchAlertSession", "setWatchAlertsEnabled", "presentWatchAlert":
        self.handleWatchAlertMethod(call, result: result)
      case "requestRemoteNotifications":
        DispatchQueue.main.async {
          self.requestRemoteNotifications()
        }
        result(nil)
      case "getQuickEntryShortcut":
        result(self.quickEntryShortcutState())
      case "setQuickEntryShortcut":
        guard let shortcut = self.quickEntryShortcut(call.arguments) else {
          result(FlutterError(code: "invalid_shortcut", message: "The Quick Entry shortcut is invalid.", details: nil))
          return
        }
        DispatchQueue.main.async {
          self.setQuickEntryShortcut(shortcut)
          result(self.quickEntryShortcutState())
        }
      case "openWorkspaceWindow":
        guard let route = self.workspaceRoute(call.arguments) else {
          result(FlutterError(code: "invalid_workspace_route", message: "The workspace route is invalid.", details: nil))
          return
        }
        DispatchQueue.main.async {
          result(self.openWorkspaceWindow(route))
        }
      case "sharedCaptureHandlerReady", "sharedCaptureHandlerPaused":
        guard call.arguments == nil else { result(FlutterError(code: "invalid_shared_capture", message: nil, details: nil)); return }
        self.sharedCaptureHandlerReady = call.method == "sharedCaptureHandlerReady"
        if self.sharedCaptureHandlerReady { self.resumeSharedCaptures(includeHeld: true) }
        result(nil)
      case "resumeSharedCaptures":
        guard let values = call.arguments as? [String: Any], values.count == 1,
              let includeHeld = values["includeHeld"] as? Bool else {
          result(FlutterError(code: "invalid_shared_capture", message: nil, details: nil)); return
        }
        self.resumeSharedCaptures(includeHeld: includeHeld)
        result(nil)
      case "deferSharedCapture":
        guard let values = call.arguments as? [String: Any], values.count == 2,
              let requestId = values["requestId"] as? String, Self.isSharedCaptureRequestId(requestId),
              let autoResume = values["autoResume"] as? Bool,
              self.deliveredSharedCaptureIds.contains(requestId) else {
          result(FlutterError(code: "invalid_shared_capture", message: nil, details: nil)); return
        }
        self.deferredSharedCaptureIds.insert(requestId)
        if !autoResume { self.heldSharedCaptureIds.insert(requestId) }
        result(nil)
      case "bindSharedCaptureOwner":
        guard let values = call.arguments as? [String: Any], values.count == 2,
              let requestId = values["requestId"] as? String,
              let owner = values["ownerScope"] as? String,
              Self.isSharedCaptureRequestId(requestId), DesktopWatchIntentStore.validScope(owner),
              self.deliveredSharedCaptureIds.contains(requestId) else {
          result(FlutterError(code: "invalid_shared_capture", message: nil, details: nil)); return
        }
        Self.sharedCaptureIOQueue.async {
          do {
            guard let inbox = Self.sharedCaptureInboxURL(),
                  let capture = Self.validatedSharedCapture(inbox.appendingPathComponent(requestId, isDirectory: true), inbox: inbox)
            else { throw CocoaError(.fileReadCorruptFile) }
            let accepted = try SharedCaptureHandoff.bindOwner(owner, requestId: requestId, inbox: inbox) {
              try DesktopSharedCaptureReceipts.bindOwner(owner, directory: capture.directory, allowed: capture.allNames)
            }
            DispatchQueue.main.async { result(accepted) }
          } catch {
            DispatchQueue.main.async { result(FlutterError(code: "shared_capture_receipt_failed", message: "The shared files remain retained.", details: nil)) }
          }
        }
      case "ackSharedCaptureFile", "discardSharedCaptureFile":
        guard let values = call.arguments as? [String: Any], values.count == 3,
              let requestId = values["requestId"] as? String,
              let name = values["name"] as? String,
              let owner = values["ownerScope"] as? String, DesktopWatchIntentStore.validScope(owner),
              Self.isSharedCaptureRequestId(requestId), Self.isSafeSharedCaptureFilename(name),
              self.deliveredSharedCaptureIds.contains(requestId) else {
          result(FlutterError(code: "invalid_shared_capture", message: nil, details: nil)); return
        }
        self.ackSharedCaptureFile(requestId, name: name, owner: owner, result: result)
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

  func attachAuxiliary(channel: FlutterMethodChannel, window: NSWindow) {
    channel.setMethodCallHandler { [weak self, weak window] call, result in
      guard let self, let window else {
        result(FlutterError(code: "window_unavailable", message: "The workspace window is unavailable.", details: nil))
        return
      }
      if self.handleAmbientVoiceMethod(
        call,
        allowsStateUpdates: false,
        result: result
      ) {
        return
      }
      switch call.method {
      case "flutterReady":
        result(nil)
      case "showMainPresentation":
        DispatchQueue.main.async {
          self.focus(window)
          result(nil)
        }
      case "getQuickEntryShortcut":
        result(self.quickEntryShortcutState())
      case "setQuickEntryShortcut":
        guard let shortcut = self.quickEntryShortcut(call.arguments) else {
          result(FlutterError(code: "invalid_shortcut", message: "The Quick Entry shortcut is invalid.", details: nil))
          return
        }
        DispatchQueue.main.async {
          self.setQuickEntryShortcut(shortcut)
          result(self.quickEntryShortcutState())
        }
      case "openWorkspaceWindow":
        guard let route = self.workspaceRoute(call.arguments) else {
          result(FlutterError(code: "invalid_workspace_route", message: "The workspace route is invalid.", details: nil))
          return
        }
        DispatchQueue.main.async {
          result(self.openWorkspaceWindow(route))
        }
      case "requestRemoteNotifications":
        DispatchQueue.main.async {
          self.requestRemoteNotifications()
          result(nil)
        }
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  private func handleAmbientVoiceMethod(
    _ call: FlutterMethodCall,
    allowsStateUpdates: Bool,
    result: @escaping FlutterResult
  ) -> Bool {
    switch call.method {
    case "getAmbientVoiceConsent", "acceptAmbientVoiceConsent":
      guard let values = call.arguments as? [String: Any],
            values.count == 2,
            let ownerDigest = values["ownerDigest"] as? String,
            ownerDigest.count == 43,
            ownerDigest.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
            let terms = values["terms"] as? String,
            terms == Self.ambientVoiceConsentTerms
      else {
        result(FlutterError(
          code: "invalid_ambient_voice_consent",
          message: "The voice agreement request is invalid.",
          details: nil
        ))
        return true
      }
      DispatchQueue.main.async {
        let key = Self.ambientVoiceConsentDefaultsPrefix + ownerDigest
        if call.method == "acceptAmbientVoiceConsent" {
          // Only the explicit agreement action writes these exact terms. This
          // preference grants no microphone, credential, or command authority.
          UserDefaults.standard.set(terms, forKey: key)
        }
        result(UserDefaults.standard.string(forKey: key) == terms)
      }
      return true

    case "getAmbientVoiceAvailability":
      guard call.arguments == nil else {
        result(FlutterError(
          code: "invalid_ambient_voice_availability",
          message: "The ambient voice availability request is invalid.",
          details: nil
        ))
        return true
      }
      DispatchQueue.main.async {
        result(self.ambientVoiceAvailabilityPayload())
      }
      return true

    case "setAmbientVoiceAvailability":
      guard let values = call.arguments as? [String: Any],
            values.count == 1,
            let available = values["available"] as? Bool
      else {
        result(FlutterError(
          code: "invalid_ambient_voice_availability",
          message: "The ambient voice availability update is invalid.",
          details: nil
        ))
        return true
      }
      DispatchQueue.main.async {
        self.setAmbientVoiceAvailability(available)
        result(self.ambientVoiceAvailabilityPayload())
      }
      return true

    case "updateAmbientVoiceState":
      guard allowsStateUpdates else {
        result(FlutterError(
          code: "ambient_voice_primary_window_required",
          message: "Only the primary Ambient Voice window can publish voice state.",
          details: nil
        ))
        return true
      }
      guard let values = call.arguments as? [String: Any],
            values.count == 1,
            let rawState = values["state"] as? String,
            let state = AmbientVoiceState(rawValue: rawState)
      else {
        result(FlutterError(
          code: "invalid_ambient_voice_state",
          message: "The ambient voice presentation state is invalid.",
          details: nil
        ))
        return true
      }
      DispatchQueue.main.async {
        guard self.ambientVoiceAvailable || state == .asleep else {
          result(FlutterError(
            code: "ambient_voice_unavailable",
            message: "Ambient Voice is turned off.",
            details: nil
          ))
          return
        }
        self.ambientVoiceState = state
        self.updateAmbientVoicePresentation()
        result(self.ambientVoiceAvailabilityPayload())
      }
      return true

    default:
      return false
    }
  }

  /// Ambient Command stays off until its owner turns it on in Settings.
  private func savedAmbientVoiceAvailability() -> Bool {
    UserDefaults.standard.bool(forKey: Self.ambientVoiceAvailabilityDefaultsKey)
  }

  private func setAmbientVoiceAvailability(_ available: Bool) {
    dispatchPrecondition(condition: .onQueue(.main))
    ambientVoiceAvailable = available
    UserDefaults.standard.set(
      available,
      forKey: Self.ambientVoiceAvailabilityDefaultsKey
    )
    if !available {
      ambientVoiceState = .asleep
      pendingAmbientVoiceSource = nil
    }
    updateQuickEntryMenus(registrationSucceeded: shortcutRegistered)
  }

  private func ambientVoiceAvailabilityPayload() -> [String: Any] {
    [
      "available": ambientVoiceAvailable,
      "state": ambientVoiceState.rawValue,
    ]
  }

  private func quickEntryShortcut(_ arguments: Any?) -> QuickEntryShortcut? {
    guard let values = arguments as? [String: Any],
          values.count == 1,
          let rawValue = values["shortcut"] as? String
    else { return nil }
    return QuickEntryShortcut(rawValue: rawValue)
  }

  private func workspaceRoute(_ arguments: Any?) -> String? {
    guard let values = arguments as? [String: Any],
          values.count == 1,
          let route = values["route"] as? String,
          route.utf8.count <= 600
    else { return nil }
    let range = NSRange(route.startIndex..<route.endIndex, in: route)
    return Self.workspaceRoutePattern.firstMatch(in: route, range: range) == nil ? nil : route
  }

  private func savedQuickEntryShortcut() -> QuickEntryShortcut {
    guard let rawValue = UserDefaults.standard.string(
      forKey: Self.quickEntryShortcutDefaultsKey
    ) else { return .commandShiftSpace }
    return QuickEntryShortcut(rawValue: rawValue) ?? .commandShiftSpace
  }

  private func setQuickEntryShortcut(_ shortcut: QuickEntryShortcut) {
    dispatchPrecondition(condition: .onQueue(.main))
    quickEntryShortcut = shortcut
    UserDefaults.standard.set(shortcut.rawValue, forKey: Self.quickEntryShortcutDefaultsKey)
    let registered = registerQuickEntryHotKey()
    updateQuickEntryMenus(registrationSucceeded: registered)
  }

  private func quickEntryShortcutState() -> [String: Any] {
    [
      "shortcut": quickEntryShortcut.rawValue,
      "registered": shortcutRegistered,
    ]
  }

  @discardableResult
  private func openWorkspaceWindow(_ route: String) -> Bool {
    dispatchPrecondition(condition: .onQueue(.main))
    guard workspaceWindows.count < 8 else {
      NSSound.beep()
      return false
    }
    let id = UUID()
    let controller = AsaelWorkspaceWindowController(
      id: id,
      route: route,
      desktopHost: self
    ) { [weak self] closedId in
      self?.workspaceWindows.removeValue(forKey: closedId)
    }
    workspaceWindows[id] = controller
    controller.showWindow(nil)
    if let window = controller.window {
      focus(window)
      return window.isVisible
    }
    workspaceWindows.removeValue(forKey: id)
    return false
  }

  func handleOpenURLs(_ urls: [URL]) {
    let documents = urls.filter { $0.isFileURL && $0.pathExtension == SharedCaptureHandoff.documentExtension }
    // Bound one OS delivery and serialize import with scanning/acknowledgments.
    // The document contains a scoped capability, never a path in a URL scheme.
    if !documents.isEmpty {
      Self.sharedCaptureIOQueue.async { [weak self] in
        var failure: Error?
        if documents.count > SharedCaptureHandoff.maximumPendingRequests {
          failure = SharedCaptureHandoff.Failure.capacity
        } else {
          for document in documents {
            do {
              guard let inbox = Self.sharedCaptureInboxURL(create: true) else { throw SharedCaptureHandoff.Failure.unavailable }
              _ = try SharedCaptureHandoff.receive(document, inbox: inbox)
            } catch { failure = error }
          }
        }
        DispatchQueue.main.async {
          guard let self else { return }
          self.showMainWindow()
          self.deliverNextSharedCapture()
          if let failure {
            let alert = NSAlert()
            alert.messageText = "The share needs attention"
            alert.informativeText = (failure as? SharedCaptureHandoff.Failure)?.localizedDescription
              ?? SharedCaptureHandoff.Failure.invalid.localizedDescription
            alert.addButton(withTitle: "OK")
            if let window = self.window { alert.beginSheetModal(for: window) }
            else { alert.runModal() }
          }
        }
      }
    }
    let handlesSharedCapture = urls.contains { url in
      url.scheme?.lowercased() == "asael" && url.host?.lowercased() == "capture-shared"
    }
    let opensAmbientVoice = urls.contains { url in
      url.scheme?.lowercased() == "asael" && url.host?.lowercased() == "ambient-voice"
    }
    guard handlesSharedCapture || opensAmbientVoice else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      if handlesSharedCapture {
        self.showMainWindow()
        self.deliverNextSharedCapture()
      }
      if opensAmbientVoice {
        self.requestAmbientVoice(source: .vocalShortcut)
      }
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

  private static func sharedCaptureInboxURL(create: Bool = false) -> URL? {
    let container: URL
    if SharedCaptureHandoff.hasAuthorizedLegacyGroup {
      // Real Apple-signed builds retain the existing inbox and owner journals.
      // A declared group entitlement alone does not authorize private builds.
      guard let group = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: Self.appGroupIdentifier
      ) else { return nil }
      container = group
    } else {
      guard let support = try? FileManager.default.url(for: .applicationSupportDirectory,
        in: .userDomainMask, appropriateFor: nil, create: create) else { return nil }
      container = support.appendingPathComponent("Asael", isDirectory: true)
    }
    let inbox = container.appendingPathComponent(Self.sharedCaptureInbox, isDirectory: true)
    if create {
      do { try SharedCaptureHandoff.makeDirectory(inbox) } catch { return nil }
    }
    return inbox
  }

  private func resumeSharedCaptures(includeHeld: Bool) {
    let resumable = includeHeld ? deferredSharedCaptureIds : deferredSharedCaptureIds.subtracting(heldSharedCaptureIds)
    deliveredSharedCaptureIds.subtract(resumable)
    deferredSharedCaptureIds.subtract(resumable)
    heldSharedCaptureIds.subtract(resumable)
    deliverNextSharedCapture()
  }

  private func deliverNextSharedCapture() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard isDartReady, sharedCaptureHandlerReady, !sharedCaptureDeliveryInFlight, let channel else { return }
    guard !sharedCaptureScanInFlight else {
      sharedCaptureScanRequested = true
      return
    }

    sharedCaptureScanInFlight = true
    sharedCaptureScanRequested = false
    sharedCaptureScanGeneration += 1
    let generation = sharedCaptureScanGeneration
    let excluded = deliveredSharedCaptureIds.union(sharedCaptureRemovalIds)
    Self.sharedCaptureIOQueue.async { [weak self, weak channel] in
      let capture = Self.nextSharedCapture(excluding: excluded)
      DispatchQueue.main.async {
        guard let self,
              let channel,
              generation == self.sharedCaptureScanGeneration
        else { return }
        self.sharedCaptureScanInFlight = false
        let rescanRequested = self.sharedCaptureScanRequested
        self.sharedCaptureScanRequested = false
        guard self.isDartReady, self.channel === channel else { return }
        guard let capture else {
          if rescanRequested { self.deliverNextSharedCapture() }
          return
        }
        guard !self.deliveredSharedCaptureIds.contains(capture.requestId),
              !self.sharedCaptureRemovalIds.contains(capture.requestId)
        else {
          self.deliverNextSharedCapture()
          return
        }

        self.deliveredSharedCaptureIds.insert(capture.requestId)
        self.sharedCaptureDeliveryInFlight = true
        self.request(.capture)
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
            if response is FlutterError || (response as AnyObject?) === FlutterMethodNotImplemented {
              // Retain the file until an explicit retry/readiness or capacity
              // transition. A locked engine must not busy-loop.
              self.deferredSharedCaptureIds.insert(capture.requestId)
              self.heldSharedCaptureIds.insert(capture.requestId)
              self.deliverNextSharedCapture()
            } else {
              if !self.deferredSharedCaptureIds.contains(capture.requestId) {
                self.deliveredSharedCaptureIds.remove(capture.requestId)
              }
              self.deliverNextSharedCapture()
            }
          }
        }
      }
    }
  }

  private static func nextSharedCapture(
    excluding requestIds: Set<String>
  ) -> ValidatedSharedCapture? {
    guard let inbox = sharedCaptureInboxURL(create: true),
          let candidates = try? FileManager.default.contentsOfDirectory(
            at: inbox,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
          )
    else { return nil }
    for candidate in candidates.sorted(by: {
      $0.lastPathComponent < $1.lastPathComponent
    }) {
      let requestId = candidate.lastPathComponent.lowercased()
      if requestIds.contains(requestId) { continue }
      if (try? SharedCaptureHandoff.removeFinishedIfNeeded(candidate, inbox: inbox)) == true { continue }
      if let capture = validatedSharedCapture(candidate, inbox: inbox) {
        if capture.files.isEmpty {
          // Every file has a persisted acknowledgement. Cleanup does not
          // re-enter Flutter or turn a retained-capacity hold into a busy loop.
          try? SharedCaptureHandoff.finish(capture.directory, inbox: inbox)
          continue
        }
        return capture
      }
    }
    return nil
  }

  private static func validatedSharedCapture(
    _ candidate: URL,
    inbox: URL
  ) -> ValidatedSharedCapture? {
    let requestId = candidate.lastPathComponent.lowercased()
    guard Self.isSharedCaptureRequestId(requestId),
          candidate.lastPathComponent == requestId,
          Self.isDirectChild(candidate, of: inbox),
          let attributes = try? FileManager.default.attributesOfItem(atPath: candidate.path),
          attributes[.type] as? FileAttributeType == .typeDirectory,
          let manifestData = try? SharedCaptureHandoff.read(
            candidate.appendingPathComponent(Self.sharedCaptureManifest), maximum: 32 * 1_024
          ),
          manifestData.count <= 32 * 1_024,
          let manifest = try? JSONDecoder().decode(SharedCaptureManifest.self, from: manifestData),
          manifest.schemaVersion == 1,
          manifest.requestId == requestId,
          !manifest.files.isEmpty,
          manifest.files.count <= Self.sharedCaptureMaxFiles
    else { return nil }

    do { try SharedCaptureHandoff.ensureReady(candidate, inbox: inbox) } catch { return nil }
    let allNames = Set(manifest.files.map(\.name))
    guard allNames.count == manifest.files.count,
          let completed = try? DesktopSharedCaptureReceipts.read(directory: candidate, allowed: allNames)
    else { return nil }
    var names = Set<String>()
    var files: [URL] = []
    for entry in manifest.files {
      guard Self.isSafeSharedCaptureFilename(entry.name),
            names.insert(entry.name).inserted,
            entry.size > 0,
            entry.size <= Self.sharedCaptureMaxFileBytes
      else { return nil }
      if completed.contains(entry.name) { continue }
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
      files: files,
      allNames: allNames
    )
  }

  private static func isDirectChild(_ candidate: URL, of parent: URL) -> Bool {
    let resolvedParent = parent.standardizedFileURL.resolvingSymlinksInPath()
    let resolvedCandidate = candidate.standardizedFileURL.resolvingSymlinksInPath()
    return resolvedCandidate.deletingLastPathComponent() == resolvedParent
  }

  private static func isSafeSharedCaptureFilename(_ name: String) -> Bool {
    guard !name.isEmpty,
          name != Self.sharedCaptureManifest, name != DesktopSharedCaptureReceipts.filename,
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

  private func ackSharedCaptureFile(_ requestId: String, name: String, owner: String, result: @escaping FlutterResult) {
    Self.sharedCaptureIOQueue.async { [weak self] in
      do {
        guard let inbox = Self.sharedCaptureInboxURL(),
              let capture = Self.validatedSharedCapture(inbox.appendingPathComponent(requestId, isDirectory: true), inbox: inbox),
              capture.allNames.contains(name) else { throw CocoaError(.fileReadCorruptFile) }
        try SharedCaptureHandoff.withInboxLock(inbox) {
          try DesktopSharedCaptureReceipts.acknowledge(name, owner: owner, directory: capture.directory, allowed: capture.allNames)
          // The journal survives failed cleanup and account changes.
          try? FileManager.default.removeItem(at: capture.directory.appendingPathComponent(name))
        }
        DispatchQueue.main.async { result(nil); self?.deliverNextSharedCapture() }
      } catch {
        DispatchQueue.main.async { result(FlutterError(code: "shared_capture_receipt_failed", message: "The shared file remains retained.", details: nil)) }
      }
    }
  }

  private func completeSharedCapture(_ requestId: String) {
    dispatchPrecondition(condition: .onQueue(.main))
    deliveredSharedCaptureIds.remove(requestId)
    sharedCaptureRemovalIds.insert(requestId)
    Self.sharedCaptureIOQueue.async { [weak self] in
      if let inbox = Self.sharedCaptureInboxURL(),
         let capture = Self.validatedSharedCapture(
           inbox.appendingPathComponent(requestId, isDirectory: true),
           inbox: inbox
         ),
         capture.requestId == requestId, capture.files.isEmpty {
        try? SharedCaptureHandoff.finish(capture.directory, inbox: inbox)
      }
      DispatchQueue.main.async {
        guard let self else { return }
        self.sharedCaptureRemovalIds.remove(requestId)
        self.deliverNextSharedCapture()
      }
    }
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

  func handleNotificationResponse(
    _ response: UNNotificationResponse,
    completionHandler: @escaping () -> Void
  ) {
    let local = response.notification.request.content.userInfo
    if let scope = local["asaelWatchScope"] as? String,
       let watchId = local["asaelWatchId"] as? String {
      DispatchQueue.main.async { [weak self] in
        if let self, response.actionIdentifier == UNNotificationDefaultActionIdentifier {
          if self.watchIntents.enqueue(scope: scope, watchId: watchId) {
            self.showMainWindow()
            self.deliverNextWatchIntent()
          } else {
            NSLog("Asael could not retain a watch notification destination.")
          }
        }
        completionHandler()
      }
      return
    }
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
      completionHandler()
      return
    }
    guard let data = Self.notificationEnvelope(
      response.notification.request.content.userInfo
    ) else {
      completionHandler()
      return
    }
    let observedAt = ISO8601DateFormatter().string(from: Date())
    DispatchQueue.main.async { [weak self] in
      guard let self else {
        completionHandler()
        return
      }
      let lifecycle = self.channel == nil || !self.isDartReady
        ? "terminated"
        : (NSApp.isActive ? "foreground" : "background")
      self.persistNotificationAction(
        arguments: [
          "action": action.rawValue,
          "data": data,
          "appLifecycle": lifecycle,
          "observedAt": observedAt,
        ],
        attemptsRemaining: 3,
        completionHandler: completionHandler
      )
    }
  }

  func handleNotificationReceived(
    _ userInfo: [AnyHashable: Any],
    lifecycle: String
  ) {
    guard let data = Self.notificationEnvelope(userInfo),
          lifecycle == "foreground" || lifecycle == "background"
    else { return }
    let observedAt = ISO8601DateFormatter().string(from: Date())
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let effectiveLifecycle = self.channel == nil || !self.isDartReady
        ? "terminated"
        : lifecycle
      self.persistNotificationReceived(
        arguments: [
          "data": data,
          "appLifecycle": effectiveLifecycle,
          "observedAt": observedAt,
        ],
        attemptsRemaining: 2
      )
    }
  }

  private func persistNotificationAction(
    arguments: [String: Any],
    attemptsRemaining: Int,
    completionHandler: @escaping () -> Void
  ) {
    dispatchPrecondition(condition: .onQueue(.main))
    if notificationBridgeEvents.enqueue(
      method: "notificationAction",
      arguments: arguments
    ) {
      deliverNextNotificationEvent()
      // enqueue synchronizes and reads back the row. Complete the OS response
      // only after that durable handoff so a cold-launched process cannot be
      // suspended before Flutter has a chance to start.
      completionHandler()
      return
    }
    deliverNextNotificationEvent()
    guard attemptsRemaining > 1 else {
      // UNUserNotificationCenter requires eventual completion even when local
      // persistence is unavailable. Emit no envelope data in diagnostics.
      NSLog("Asael could not durably retain a notification action after bounded retries.")
      completionHandler()
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
      guard let self else {
        completionHandler()
        return
      }
      self.persistNotificationAction(
        arguments: arguments,
        attemptsRemaining: attemptsRemaining - 1,
        completionHandler: completionHandler
      )
    }
  }

  private func persistNotificationReceived(
    arguments: [String: Any],
    attemptsRemaining: Int
  ) {
    dispatchPrecondition(condition: .onQueue(.main))
    if notificationBridgeEvents.enqueue(
      method: "notificationReceived",
      arguments: arguments
    ) {
      deliverNextNotificationEvent()
      return
    }
    deliverNextNotificationEvent()
    guard attemptsRemaining > 1 else {
      NSLog("Asael could not durably retain a notification delivery observation.")
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
      self?.persistNotificationReceived(
        arguments: arguments,
        attemptsRemaining: attemptsRemaining - 1
      )
    }
  }

  private func deliverNextNotificationEvent() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard isDartReady,
          isNotificationHandlerReady,
          !notificationDeliveryInFlight,
          let channel,
          let event = notificationBridgeEvents.first(),
          let id = event["id"] as? String,
          let method = event["method"] as? String,
          let arguments = event["arguments"] as? [String: Any]
    else { return }
    notificationDeliveryInFlight = true
    channel.invokeMethod(method, arguments: arguments) { [weak self] response in
      DispatchQueue.main.async {
        guard let self else { return }
        self.notificationDeliveryInFlight = false
        if response is FlutterError {
          // Dart rejected only the durable queue handoff (for example, a
          // temporarily unavailable Keychain). Retain the native event and
          // retry without invalidating an otherwise live method handler.
          DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.deliverNextNotificationEvent()
          }
          return
        }
        if (response as AnyObject?) === FlutterMethodNotImplemented {
          self.isNotificationHandlerReady = false
          return
        }
        self.notificationBridgeEvents.remove(id: id)
        self.deliverNextNotificationEvent()
      }
    }
  }

  private func observeSystemLifecycle() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard workspaceLifecycleObservers.isEmpty,
          distributedLifecycleObservers.isEmpty
    else { return }

    let workspaceCenter = NSWorkspace.shared.notificationCenter
    workspaceLifecycleObservers = [
      workspaceCenter.addObserver(
        forName: NSWorkspace.willSleepNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.receiveSystemLifecycleEvent(.systemWillSleep)
      },
      workspaceCenter.addObserver(
        forName: NSWorkspace.didWakeNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.receiveSystemLifecycleEvent(.systemDidWake)
      },
      workspaceCenter.addObserver(
        forName: NSWorkspace.sessionDidResignActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.receiveSystemLifecycleEvent(.sessionLocked)
      },
      workspaceCenter.addObserver(
        forName: NSWorkspace.sessionDidBecomeActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.receiveSystemLifecycleEvent(.sessionUnlocked)
      },
    ]

    let distributedCenter = DistributedNotificationCenter.default()
    distributedLifecycleObservers = [
      distributedCenter.addObserver(
        forName: Notification.Name("com.apple.screenIsLocked"),
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.receiveSystemLifecycleEvent(.sessionLocked)
      },
      distributedCenter.addObserver(
        forName: Notification.Name("com.apple.screenIsUnlocked"),
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.receiveSystemLifecycleEvent(.sessionUnlocked)
      },
    ]
  }

  private func removeSystemLifecycleObservers() {
    dispatchPrecondition(condition: .onQueue(.main))
    let workspaceCenter = NSWorkspace.shared.notificationCenter
    for observer in workspaceLifecycleObservers {
      workspaceCenter.removeObserver(observer)
    }
    workspaceLifecycleObservers.removeAll()

    let distributedCenter = DistributedNotificationCenter.default()
    for observer in distributedLifecycleObservers {
      distributedCenter.removeObserver(observer)
    }
    distributedLifecycleObservers.removeAll()
  }

  private func receiveSystemLifecycleEvent(_ event: SystemLifecycleEvent) {
    dispatchPrecondition(condition: .onQueue(.main))
    switch event {
    case .systemWillSleep:
      guard !systemIsSleeping else { return }
      systemIsSleeping = true
    case .systemDidWake:
      guard systemIsSleeping else { return }
      systemIsSleeping = false
    case .sessionLocked:
      guard lastSessionProtectionEvent != .sessionLocked else { return }
      lastSessionProtectionEvent = .sessionLocked
    case .sessionUnlocked:
      guard lastSessionProtectionEvent != .sessionUnlocked else { return }
      lastSessionProtectionEvent = .sessionUnlocked
    }

    if event == .systemWillSleep || event == .sessionLocked {
      (NSApp.delegate as? AppDelegate)?.protectAllSessionEngines()
    }

    if pendingSystemLifecycleEvents.last != event {
      if pendingSystemLifecycleEvents.count >= 16 {
        pendingSystemLifecycleEvents.removeFirst()
      }
      pendingSystemLifecycleEvents.append(event)
    }
    deliverNextSystemLifecycleEvent()
  }

  private func deliverNextSystemLifecycleEvent() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard isDartReady,
          !systemLifecycleDeliveryInFlight,
          let channel,
          let event = pendingSystemLifecycleEvents.first
    else { return }

    let generation = systemLifecycleDeliveryGeneration
    systemLifecycleDeliveryInFlight = true
    channel.invokeMethod(event.rawValue, arguments: nil) { [weak self] response in
      DispatchQueue.main.async {
        guard let self,
              generation == self.systemLifecycleDeliveryGeneration
        else { return }
        self.systemLifecycleDeliveryInFlight = false
        if response is FlutterError {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.deliverNextSystemLifecycleEvent()
          }
          return
        }
        if (response as AnyObject?) === FlutterMethodNotImplemented {
          self.isDartReady = false
          return
        }
        if self.pendingSystemLifecycleEvents.first == event {
          self.pendingSystemLifecycleEvents.removeFirst()
        }
        self.deliverNextSystemLifecycleEvent()
      }
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

  private func deliverNextWatchIntent() {
    guard isDartReady, watchIntentHandlerReady, !watchIntentInFlight,
          let channel, let scope = watchAlertScope,
          let item = watchIntents.first(scope: scope),
          let id = item["id"] as? String, let watchId = item["watchId"] as? String else { return }
    watchIntentInFlight = true
    let generation = watchIntentGeneration
    channel.invokeMethod("watchNotificationOpened", arguments: ["scope": scope, "watchId": watchId]) { [weak self] response in
      DispatchQueue.main.async {
        guard let self, self.watchIntentGeneration == generation, self.channel === channel else { return }
        self.watchIntentInFlight = false
        guard self.watchAlertScope == scope else { self.deliverNextWatchIntent(); return }
        if response is FlutterError || (response as AnyObject?) === FlutterMethodNotImplemented {
          // Retain until a fresh owner/handler readiness handshake; no busy retry.
          self.watchIntentHandlerReady = false
          return
        }
        guard self.watchIntents.remove(id: id) else {
          self.watchIntentHandlerReady = false
          return
        }
        self.deliverNextWatchIntent()
      }
    }
  }

  private func handleWatchAlertMethod(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    guard let values = call.arguments as? [String: Any],
          let scope = values["scope"] as? String,
          scope.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
      result(FlutterError(code: "invalid_watch_alert", message: "The watch alert owner is invalid.", details: nil)); return
    }
    if call.method == "watchAlertSession" {
      guard values.count == 2, let active = values["active"] as? Bool else {
        result(FlutterError(code: "invalid_watch_alert", message: "The watch alert session is invalid.", details: nil)); return
      }
      if active { watchAlertScope = scope } else if watchAlertScope == scope { watchAlertScope = nil }
      deliverNextWatchIntent()
      watchAlertState(scope: scope, result: result); return
    }
    guard watchAlertScope == scope else {
      result(FlutterError(code: "watch_owner_changed", message: "Unlock the current watch owner to continue.", details: nil)); return
    }
    if call.method == "setWatchAlertsEnabled" {
      guard values.count == 2, let enabled = values["enabled"] as? Bool else {
        result(FlutterError(code: "invalid_watch_alert", message: "The watch alert setting is invalid.", details: nil)); return
      }
      if !enabled {
        UserDefaults.standard.set(false, forKey: "AsaelWatchAlertsEnabledV1:" + scope)
        watchAlertState(scope: scope, result: result); return
      }
      UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
        DispatchQueue.main.async {
          guard let self, self.watchAlertScope == scope else {
            result(FlutterError(code: "watch_owner_changed", message: "The watch owner changed.", details: nil)); return
          }
          UserDefaults.standard.set(granted, forKey: "AsaelWatchAlertsEnabledV1:" + scope)
          self.watchAlertState(scope: scope, result: result)
        }
      }
      return
    }
    guard values.count == 3,
          let notificationId = values["notificationId"] as? String,
          notificationId.range(of: "^notification_[a-f0-9]{48}$", options: .regularExpression) != nil,
          let watchId = values["watchId"] as? String,
          watchId.range(of: "^watch_[a-f0-9]{48}$", options: .regularExpression) != nil,
          UserDefaults.standard.bool(forKey: "AsaelWatchAlertsEnabledV1:" + scope) else {
      result(FlutterError(code: "watch_alert_disabled", message: "Enable app-open watch alerts first.", details: nil)); return
    }
    let identifier = "asael-watch:" + scope + ":" + notificationId
    let seenKey = "AsaelWatchAlertsSeenV1:" + scope
    let seen = UserDefaults.standard.stringArray(forKey: seenKey) ?? []
    if seen.contains(notificationId) || watchAlertsInFlight.contains(identifier) { result(["state": "already_requested"]); return }
    watchAlertsInFlight.insert(identifier)
    UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
      DispatchQueue.main.async {
        guard let self else { result(FlutterError(code: "watch_alert_unavailable", message: "Watch alerts are unavailable.", details: nil)); return }
        guard self.watchAlertScope == scope,
              UserDefaults.standard.bool(forKey: "AsaelWatchAlertsEnabledV1:" + scope),
              settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
          self.watchAlertsInFlight.remove(identifier)
          result(FlutterError(code: "watch_alert_disabled", message: "Watch alerts are disabled or the owner changed.", details: nil)); return
        }
        let content = UNMutableNotificationContent()
        content.title = "Asael"
        content.body = "Booking availability was found. Open Asael for details."
        content.sound = .default
        content.userInfo = ["asaelWatchScope": scope, "asaelWatchId": watchId]
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { [weak self] error in
          DispatchQueue.main.async {
            guard let self else { result(FlutterError(code: "watch_alert_unavailable", message: "Watch alerts are unavailable.", details: nil)); return }
            self.watchAlertsInFlight.remove(identifier)
            if error != nil { result(FlutterError(code: "watch_alert_unavailable", message: "macOS did not accept the watch alert.", details: nil)); return }
            var saved = UserDefaults.standard.stringArray(forKey: seenKey) ?? []
            if !saved.contains(notificationId) { saved.append(notificationId) }
            UserDefaults.standard.set(Array(saved.suffix(500)), forKey: seenKey)
            result(["state": "requested"])
          }
        }
      }
    }
  }

  private func watchAlertState(scope: String, result: @escaping FlutterResult) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let permission: String
      switch settings.authorizationStatus {
      case .authorized: permission = "authorized"
      case .provisional: permission = "provisional"
      case .denied: permission = "denied"
      default: permission = "not_determined"
      }
      DispatchQueue.main.async {
        result(["enabled": UserDefaults.standard.bool(forKey: "AsaelWatchAlertsEnabledV1:" + scope), "permission": permission])
      }
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

  private static func notificationEnvelope(
    _ userInfo: [AnyHashable: Any]
  ) -> [String: Any]? {
    if let envelope = userInfo["asael"], let safe = channelValue(envelope) {
      let data = ["asael": safe]
      guard JSONSerialization.isValidJSONObject(data),
            let encoded = try? JSONSerialization.data(withJSONObject: data),
            encoded.count <= 16 * 1_024
      else { return nil }
      return data
    }
    let keys = [
      "schemaVersion", "deliveryId", "notificationId", "causeKind",
      "causeId", "parentId", "deepLink",
    ]
    var data: [String: Any] = [:]
    for key in keys {
      if let value = userInfo[key], let safe = channelValue(value) {
        data[key] = safe
      }
    }
    guard data["deliveryId"] != nil,
          JSONSerialization.isValidJSONObject(data),
          let encoded = try? JSONSerialization.data(withJSONObject: data),
          encoded.count <= 16 * 1_024
    else { return nil }
    return data
  }

  func showMainWindow(notifyFlutter: Bool = true) {
    dispatchPrecondition(condition: .onQueue(.main))

    guard let window = window ?? NSApp.windows.first(where: { $0 is MainFlutterWindow }) else {
      NSApp.activate(ignoringOtherApps: true)
      return
    }

    self.window = window
    restoreMainWindowPresentation(window)
    focus(window)
    // Dock/menu recovery can restore the host before Flutter changes routes.
    // Cancel the outgoing surface's presentation ownership as well.
    if notifyFlutter && isDartReady {
      channel?.invokeMethod("mainPresentationRestored", arguments: nil)
    }
  }

  private func showQuickEntryWindow() {
    dispatchPrecondition(condition: .onQueue(.main))

    guard let window = window ?? NSApp.windows.first(where: { $0 is MainFlutterWindow }) else {
      NSApp.activate(ignoringOtherApps: true)
      return
    }

    self.window = window
    isAmbientVoicePresented = false
    windowPresentation.prepareQuickEntry(window, minimumSize: Self.quickEntryWindowMinimumSize)
    (window.contentViewController as? FlutterViewController)?.backgroundColor = .windowBackgroundColor

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

  private func showAmbientVoiceWindow(appearance: String, size: NSSize, reduceMotion: Bool) {
    dispatchPrecondition(condition: .onQueue(.main))

    guard let window = window ?? NSApp.windows.first(where: { $0 is MainFlutterWindow }) else {
      NSApp.activate(ignoringOtherApps: true)
      return
    }

    self.window = window
    let wasPresented = isAmbientVoicePresented
    let previousFrame = window.frame
    isAmbientVoicePresented = true
    windowPresentation.prepareVoice(window, size: size, appearance: appearance)
    (window.contentViewController as? FlutterViewController)?.backgroundColor = .clear

    let visibleFrame = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame
    if let visibleFrame {
      // Preserve the lower-right anchor after a drag, caption expansion or
      // appearance change. Only initial presentation chooses a screen corner.
      let desiredX = wasPresented ? previousFrame.maxX - size.width : visibleFrame.maxX - size.width - 28
      let desiredY = wasPresented ? previousFrame.minY : visibleFrame.minY + 28
      let x = max(visibleFrame.minX, min(desiredX, visibleFrame.maxX - size.width))
      let y = max(visibleFrame.minY, min(desiredY, visibleFrame.maxY - size.height))
      let frame = NSRect(origin: NSPoint(x: x, y: y), size: size)
      if wasPresented && window.isVisible && !reduceMotion && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
        NSAnimationContext.runAnimationGroup { context in
          context.duration = 0.24
          window.animator().setFrame(frame, display: true)
        }
      } else {
        window.setFrame(frame, display: true)
      }
    } else {
      window.setContentSize(size)
      if !wasPresented { window.center() }
    }
    // A live status or settings change must not steal focus from the user's work.
    if !wasPresented { focus(window) }
  }

  private func restoreMainWindowPresentation(_ window: NSWindow) {
    isAmbientVoicePresented = false
    windowPresentation.restoreMain(window)
    (window.contentViewController as? FlutterViewController)?.backgroundColor = .windowBackgroundColor
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
    pendingAmbientVoiceSource = nil
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

  private func requestAmbientVoice(source: AmbientVoiceRequestSource) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard ambientVoiceAvailable else {
      request(.quickEntry)
      return
    }

    pendingRoute = nil
    if let window = window ?? NSApp.windows.first(where: { $0 is MainFlutterWindow }) {
      self.window = window
      focus(window)
    } else {
      NSApp.activate(ignoringOtherApps: true)
    }

    guard isDartReady, let channel else {
      // Attention requests contain no command payload. Keep only the newest
      // source so startup cannot replay stale voice activations.
      pendingAmbientVoiceSource = source
      return
    }
    channel.invokeMethod(
      "openAmbientVoice",
      arguments: ["source": source.rawValue]
    )
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

  private func flushPendingAmbientVoiceRequest() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard isDartReady,
          ambientVoiceAvailable,
          let source = pendingAmbientVoiceSource,
          let channel
    else { return }
    pendingAmbientVoiceSource = nil
    channel.invokeMethod(
      "openAmbientVoice",
      arguments: ["source": source.rawValue]
    )
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
    let ambientState = NSMenuItem(title: "Voice: Ready", action: nil, keyEquivalent: "")
    ambientState.isEnabled = false
    menu.addItem(ambientState)
    statusAmbientVoiceStateMenuItem = ambientState

    let ambientVoice = menuItem(
      title: "Talk to Asael",
      key: "",
      action: #selector(openAmbientVoice)
    )
    menu.addItem(ambientVoice)
    statusAmbientVoiceMenuItem = ambientVoice
    menu.addItem(.separator())

    menu.addItem(menuItem(title: "Today", key: "1", action: #selector(openToday)))
    menu.addItem(menuItem(title: "Command", key: "2", action: #selector(openCommand)))

    let quickEntry = menuItem(title: "Quick Entry", key: " ", action: #selector(openQuickEntry))
    menu.addItem(quickEntry)
    statusQuickEntryMenuItem = quickEntry

    menu.addItem(menuItem(title: "Quick Capture", key: "3", action: #selector(openQuickCapture)))
    menu.addItem(menuItem(title: "Inbox", key: "4", action: #selector(openInbox)))
    menu.addItem(menuItem(title: "New Conversation Window", key: "n", action: #selector(openConversationWindow)))
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

    let ambientVoice = menuItem(
      title: "Talk to Asael",
      key: "",
      action: #selector(openAmbientVoice)
    )
    menu.insertItem(ambientVoice, at: min(1, menu.items.count))
    applicationAmbientVoiceMenuItem = ambientVoice

    let item = menuItem(title: "Quick Entry", key: " ", action: #selector(openQuickEntry))
    menu.insertItem(item, at: min(2, menu.items.count))
    applicationQuickEntryMenuItem = item

    let newWindow = menuItem(
      title: "New Conversation Window",
      key: "n",
      action: #selector(openConversationWindow)
    )
    menu.insertItem(newWindow, at: min(3, menu.items.count))
  }

  private func updateAmbientVoicePresentation() {
    dispatchPrecondition(condition: .onQueue(.main))

    let stateTitle = ambientVoiceAvailable
      ? "Voice: \(ambientVoiceState.title)"
      : "Voice: Off"
    statusAmbientVoiceStateMenuItem?.title = stateTitle

    let actionTitle: String
    if !ambientVoiceAvailable {
      actionTitle = "Ambient Voice is off"
    } else if ambientVoiceState == .asleep {
      actionTitle = "Talk to Asael"
    } else {
      actionTitle = "Return to Ambient Voice"
    }
    for item in [statusAmbientVoiceMenuItem, applicationAmbientVoiceMenuItem].compactMap({ $0 }) {
      item.title = actionTitle
      item.isEnabled = ambientVoiceAvailable
      item.keyEquivalent = ambientVoiceAvailable && quickEntryShortcut != .disabled ? " " : ""
      item.keyEquivalentModifierMask = quickEntryShortcut.menuModifiers
      if !ambientVoiceAvailable {
        item.toolTip = "Turn on Ambient Voice in Asael settings to use this action."
      } else if quickEntryShortcut != .disabled && !shortcutRegistered {
        item.toolTip = "The global shortcut is unavailable. Ambient Voice remains available here."
      } else {
        item.toolTip = "Open Asael's voice surface. This does not grant Computer Use authority."
      }
    }

    guard let button = statusItem?.button else { return }
    let symbol = ambientVoiceAvailable ? ambientVoiceState.symbolName : "sparkles"
    let description = ambientVoiceAvailable
      ? "Asael Voice: \(ambientVoiceState.title)"
      : "Asael — Ambient Voice is off"
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: description)
      ?? NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Asael")
    image?.isTemplate = true
    button.image = image
    button.toolTip = description
    button.setAccessibilityLabel(description)
    button.title = image == nil ? "A" : ""
  }

  private func menuItem(title: String, key: String, action: Selector) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.keyEquivalentModifierMask = [.command]
    item.target = self
    return item
  }

  private func registerQuickEntryHotKey() -> Bool {
    dispatchPrecondition(condition: .onQueue(.main))

    unregisterQuickEntryHotKey()
    guard quickEntryShortcut != .disabled else {
      shortcutRegistered = false
      return true
    }

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
          controller.requestAmbientVoice(source: .shortcut)
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
    let registrationStatus = RegisterEventHotKey(
      UInt32(kVK_Space),
      quickEntryShortcut.carbonModifiers,
      identifier,
      GetApplicationEventTarget(),
      0,
      &hotKey
    )

    if registrationStatus != noErr, let hotKeyEventHandler {
      RemoveEventHandler(hotKeyEventHandler)
      self.hotKeyEventHandler = nil
    }
    shortcutRegistered = registrationStatus == noErr
    return shortcutRegistered
  }

  private func unregisterQuickEntryHotKey() {
    if let hotKey {
      UnregisterEventHotKey(hotKey)
      self.hotKey = nil
    }
    if let hotKeyEventHandler {
      RemoveEventHandler(hotKeyEventHandler)
      self.hotKeyEventHandler = nil
    }
    shortcutRegistered = false
  }

  private func updateQuickEntryMenus(registrationSucceeded: Bool) {
    for item in [statusQuickEntryMenuItem, applicationQuickEntryMenuItem].compactMap({ $0 }) {
      let shortcutTargetsQuickEntry = !ambientVoiceAvailable
      item.keyEquivalent = shortcutTargetsQuickEntry && quickEntryShortcut != .disabled ? " " : ""
      item.keyEquivalentModifierMask = quickEntryShortcut.menuModifiers
      if !shortcutTargetsQuickEntry {
        item.title = "Quick Entry"
        item.toolTip = "Open Quick Entry. The global shortcut opens Ambient Voice."
      } else if quickEntryShortcut == .disabled {
        item.title = "Quick Entry"
        item.toolTip = "The global shortcut is disabled. Quick Entry remains available here."
      } else if registrationSucceeded {
        item.title = "Quick Entry"
        item.toolTip = "Open Quick Entry with \(quickEntryShortcut.displayName)."
      } else {
        item.title = "Quick Entry — shortcut unavailable"
        item.toolTip = "Another application owns \(quickEntryShortcut.displayName). Quick Entry remains available here."
      }
    }
    updateAmbientVoicePresentation()
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

  @objc private func openAmbientVoice() {
    requestAmbientVoice(source: .menu)
  }

  @objc private func openQuickCapture() {
    request(.capture)
  }

  @objc private func openInbox() {
    request(.inbox)
  }

  @objc private func openConversationWindow() {
    openWorkspaceWindow(Route.command.rawValue)
  }

  @objc private func quitApplication() {
    NSApp.terminate(nil)
  }
}

private final class AsaelWorkspaceWindowController: NSWindowController, NSWindowDelegate {
  private let id: UUID
  private let flutterViewController: FlutterViewController
  private let channel: FlutterMethodChannel
  private let localComputerChannel: FlutterMethodChannel
  private let secureStorageChannel: FlutterMethodChannel
  private var recoveryStorageChannel: FlutterMethodChannel?
  private var sessionProtectionChannel: FlutterMethodChannel?
  private var powerStateChannel: FlutterEventChannel?
  private let onClose: (UUID) -> Void
  private var closed = false

  init(
    id: UUID,
    route: String,
    desktopHost: DesktopHostController,
    onClose: @escaping (UUID) -> Void
  ) {
    self.id = id
    self.onClose = onClose

    let project = FlutterDartProject()
    project.dartEntrypointArguments = [
      "--asael-route=\(route)",
      "--asael-window=\(id.uuidString.lowercased())",
    ]
    let flutterViewController = FlutterViewController(project: project)
    self.flutterViewController = flutterViewController
    RegisterGeneratedPlugins(registry: flutterViewController)

    channel = FlutterMethodChannel(
      name: "app.omniagent.omniagent/desktop",
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    localComputerChannel = FlutterMethodChannel(
      name: "app.omniagent.omniagent/local-computer",
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    secureStorageChannel = FlutterMethodChannel(
      name: "app.omniagent.omniagent/secure-storage",
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1_240, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Asael Workspace"
    window.minSize = NSSize(width: 860, height: 620)
    window.contentViewController = flutterViewController
    configureAsaelWindowChrome(window, role: .workspace)

    super.init(window: window)
    window.delegate = self
    window.center()
    desktopHost.attachAuxiliary(channel: channel, window: window)
    (NSApp.delegate as? AppDelegate)?.attachLocalComputerBridge(channel: localComputerChannel)
    (NSApp.delegate as? AppDelegate)?.attachCredentialBrokerBridge(channel: secureStorageChannel)
    sessionProtectionChannel = (NSApp.delegate as? AppDelegate)?.attachSessionProtection(to: flutterViewController.engine.binaryMessenger)
    recoveryStorageChannel = (NSApp.delegate as? AppDelegate)?.attachRecoveryStorageBridge(
      to: flutterViewController.engine.binaryMessenger
    )
    powerStateChannel = (NSApp.delegate as? AppDelegate)?.attachPowerStateBridge(
      to: flutterViewController.engine.binaryMessenger
    )
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func windowWillClose(_ notification: Notification) {
    guard !closed else { return }
    closed = true
    channel.setMethodCallHandler(nil)
    (NSApp.delegate as? AppDelegate)?.detachLocalComputerBridge(channel: localComputerChannel)
    (NSApp.delegate as? AppDelegate)?.detachCredentialBrokerBridge(channel: secureStorageChannel)
    if let sessionProtectionChannel {
      (NSApp.delegate as? AppDelegate)?.detachSessionProtection(sessionProtectionChannel)
      self.sessionProtectionChannel = nil
    }
    if let recoveryStorageChannel {
      (NSApp.delegate as? AppDelegate)?.detachRecoveryStorageBridge(recoveryStorageChannel)
    }
    if let powerStateChannel {
      (NSApp.delegate as? AppDelegate)?.detachPowerStateBridge(powerStateChannel)
      self.powerStateChannel = nil
    }
    flutterViewController.engine.shutDownEngine()
    onClose(id)
  }
}
