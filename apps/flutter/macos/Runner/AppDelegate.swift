import Carbon
import Cocoa
import FlutterMacOS
import Security
import UserNotifications

@main
class AppDelegate: FlutterAppDelegate, UNUserNotificationCenterDelegate {
  private let desktopHostController = DesktopHostController()
  private let localComputerController = LocalComputerController()
  private let credentialBrokerController = CredentialBrokerController()

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
    let action: String
    let result: FlutterResult
    let timeout: DispatchWorkItem
  }

  private struct QueuedRequest {
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
      guard let values, values.count == 1,
            let key = values["key"] as? String, Self.allowedKeys.contains(key)
      else { result(Self.flutterFailure("invalid_secure_store_arguments")); return }
      envelope["key"] = key
    case "write":
      guard let values, values.count == 2,
            let key = values["key"] as? String, Self.allowedKeys.contains(key),
            let value = values["value"] as? String,
            value.lengthOfBytes(using: .utf8) <= 64 * 1_024
      else { result(Self.flutterFailure("invalid_secure_store_arguments")); return }
      envelope["key"] = key
      envelope["value"] = value
    default:
      result(FlutterMethodNotImplemented); return
    }
    enqueue(envelope, timeout: 8, result: result)
  }

  private func enqueue(
    _ envelope: [String: Any], timeout seconds: TimeInterval,
    result: @escaping FlutterResult
  ) {
    guard queued.count + pending.count < 32,
          JSONSerialization.isValidJSONObject(envelope),
          let data = try? JSONSerialization.data(withJSONObject: envelope),
          data.count <= Self.maximumRequestBytes
    else { result(Self.flutterFailure("secure_store_unavailable")); return }
    queued.append(QueuedRequest(envelope: envelope, timeout: seconds, result: result))
    dispatchNext()
  }

  private func dispatchNext() {
    guard pending.isEmpty, !queued.isEmpty else { return }
    let requestToDispatch = queued.removeFirst()
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
      if outcome == "succeeded" {
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

  private static let allowedActions: Set<String> = [
    "observe", "list_apps", "activate_app", "open_url", "press", "click", "type", "key", "scroll",
  ]
  private static let helperBundleName = "AsaelComputerUseHelper.app"
  private static let helperExecutableName = "AsaelComputerUseHelper"
  private static let helperBundleIdentifier = "app.omniagent.omniagent.computer-use-helper"
  private static let maximumResponseBytes = 4 * 1_024 * 1_024
  private static let maximumRequestBytes = 96 * 1_024

  private var channels: [ObjectIdentifier: FlutterMethodChannel] = [:]
  private var process: Process?
  private var inputPipe: Pipe?
  private var outputPipe: Pipe?
  private var errorPipe: Pipe?
  private var outputBuffer = Data()
  private var pending: [String: PendingRequest] = [:]
  private var completed: [String: CompletedRequest] = [:]
  private var completionOrder: [String] = []
  private var completionExpiryWorkItem: DispatchWorkItem?
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
    let shouldClose = !enabled && process == nil
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
      if shouldClose { self.terminateHelper(expected: true, pendingOutcome: "canceled") }
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
          values.count == 4,
          let id = values["id"] as? String,
          Self.isCommandId(id),
          let action = values["action"] as? String,
          Self.allowedActions.contains(action),
          let input = values["input"] as? [String: Any],
          let expiresAt = values["expiresAt"] as? String,
          let expiration = Self.parseDate(expiresAt),
          expiration > Date(),
          expiration.timeIntervalSinceNow <= 300,
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
      "expiresAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(lifetime)),
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
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else { return }
      DispatchQueue.main.async { self?.ingest(data) }
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
      terminateHelper(expected: false, pendingOutcome: "failed")
      return
    }
    while let newline = outputBuffer.firstIndex(of: 0x0a) {
      let line = Data(outputBuffer[..<newline])
      outputBuffer.removeSubrange(...newline)
      guard !line.isEmpty,
            line.count <= Self.maximumResponseBytes,
            let response = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            let id = response["id"] as? String,
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
    outputBuffer.removeAll(keepingCapacity: false)
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
    ]
  }

  private var supported: Bool {
    if #available(macOS 14.0, *) { return true }
    return false
  }

  private var helperInstalled: Bool {
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
    guard let helperBundleURL,
          let bundle = Bundle(url: helperBundleURL),
          let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
          version.count <= 40
    else { return "unavailable" }
    return version
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
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
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
  private static let quickEntryShortcutDefaultsKey = "AsaelQuickEntryShortcutV1"
  private static let desktopChannelName = "app.omniagent.omniagent/desktop"
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
  private static let workspaceRoutePattern = try! NSRegularExpression(
    pattern: "^/(talk|today|capture|inbox|knowledge|projects|meetings|results|automation)(/[A-Za-z0-9._~%:-]{1,500})?$"
  )

  private weak var window: NSWindow?
  private var channel: FlutterMethodChannel?
  private var statusItem: NSStatusItem?
  private weak var statusQuickEntryMenuItem: NSMenuItem?
  private weak var applicationQuickEntryMenuItem: NSMenuItem?
  private var hotKey: EventHotKeyRef?
  private var hotKeyEventHandler: EventHandlerRef?
  private var quickEntryShortcut = QuickEntryShortcut.commandShiftSpace
  private var shortcutRegistered = false
  private var pendingRoute: Route?
  private var isDartReady = false
  private var isNotificationHandlerReady = false
  private var notificationDeliveryInFlight = false
  private let notificationBridgeEvents = NativeNotificationBridgeEventStore()
  private var hasStarted = false
  private var isQuickEntryPresented = false
  private var regularWindowFrame: NSRect?
  private var deliveredSharedCaptureIds = Set<String>()
  private var sharedCaptureDeliveryInFlight = false
  private var workspaceWindows: [UUID: AsaelWorkspaceWindowController] = [:]

  func start() {
    guard !hasStarted else { return }
    hasStarted = true
    quickEntryShortcut = savedQuickEntryShortcut()
    configureApplicationMenu()
    configureStatusItem()
    let registered = registerQuickEntryHotKey()
    updateQuickEntryMenus(registrationSucceeded: registered)
  }

  func stop() {
    channel?.setMethodCallHandler(nil)
    channel = nil
    isDartReady = false
    isNotificationHandlerReady = false
    notificationDeliveryInFlight = false
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
    for controller in Array(workspaceWindows.values) {
      controller.close()
    }
    workspaceWindows.removeAll()
  }

  func attach(channel: FlutterMethodChannel, window: NSWindow) {
    self.channel?.setMethodCallHandler(nil)
    self.channel = channel
    self.window = window
    isDartReady = false
    isNotificationHandlerReady = false

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
          self.openWorkspaceWindow(route)
          result(nil)
        }
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
          self.openWorkspaceWindow(route)
          result(nil)
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

  private func openWorkspaceWindow(_ route: String) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard workspaceWindows.count < 8 else {
      NSSound.beep()
      return
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

  func handleNotificationResponse(
    _ response: UNNotificationResponse,
    completionHandler: @escaping () -> Void
  ) {
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

    let item = menuItem(title: "Quick Entry", key: " ", action: #selector(openQuickEntry))
    menu.insertItem(item, at: min(1, menu.items.count))
    applicationQuickEntryMenuItem = item

    let newWindow = menuItem(
      title: "New Conversation Window",
      key: "n",
      action: #selector(openConversationWindow)
    )
    menu.insertItem(newWindow, at: min(2, menu.items.count))
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
      item.keyEquivalent = quickEntryShortcut == .disabled ? "" : " "
      item.keyEquivalentModifierMask = quickEntryShortcut.menuModifiers
      if quickEntryShortcut == .disabled {
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
    flutterViewController.engine.shutDownEngine()
    onClose(id)
  }
}
