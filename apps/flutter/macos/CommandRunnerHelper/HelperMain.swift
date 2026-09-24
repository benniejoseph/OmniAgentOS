import CryptoKit
import Darwin
import Foundation
import Security

private enum CommandRunnerFailure: Error {
  case rejected(String)
}

private struct CommandRequest {
  let workspaceId: String
  let workspaceName: String
  let workspaceRoot: URL
  let workingDirectory: URL
  let executableName: String
  let executableURL: URL
  let arguments: [String]
  let relativeDirectory: String
  let timeoutSeconds: Int
}

private final class ActiveChildRegistry: @unchecked Sendable {
  static let shared = ActiveChildRegistry()

  private let lock = NSLock()
  private var process: Process?

  func set(_ process: Process) {
    lock.lock()
    self.process = process
    lock.unlock()
  }

  func clear(_ expected: Process) {
    lock.lock()
    if process === expected { process = nil }
    lock.unlock()
  }

  func terminate() {
    lock.lock()
    let target = process
    lock.unlock()
    guard let target, target.isRunning else { return }
    terminateProcessGroup(target, grace: 0.25)
  }
}

private final class BoundedStreamCollector: @unchecked Sendable {
  struct Snapshot {
    let text: String
    let byteCount: Int
    let sha256: String
    let truncated: Bool
    let exceededHardLimit: Bool
  }

  private static let retainedByteLimit = 32 * 1_024
  private static let observedByteLimit = 4 * 1_024 * 1_024

  private let lock = NSLock()
  private var retained = Data()
  private var byteCount = 0
  private var hasher = SHA256()
  private var exceededHardLimit = false

  func append(_ data: Data) {
    guard !data.isEmpty else { return }
    lock.lock()
    defer { lock.unlock() }
    guard byteCount < Self.observedByteLimit else {
      exceededHardLimit = true
      return
    }
    let accepted = Data(data.prefix(Self.observedByteLimit - byteCount))
    byteCount += accepted.count
    hasher.update(data: accepted)
    if retained.count < Self.retainedByteLimit {
      retained.append(accepted.prefix(Self.retainedByteLimit - retained.count))
    }
    if accepted.count < data.count { exceededHardLimit = true }
  }

  var hardLimitExceeded: Bool {
    lock.lock()
    defer { lock.unlock() }
    return exceededHardLimit
  }

  func snapshot() -> Snapshot {
    lock.lock()
    defer { lock.unlock() }
    let sanitized = sanitizedOutput(retained, maximumUTF8Bytes: Self.retainedByteLimit)
    return Snapshot(
      text: sanitized.text,
      byteCount: byteCount,
      sha256: hasher.finalize().map { String(format: "%02x", $0) }.joined(),
      truncated: byteCount > retained.count || sanitized.truncated,
      exceededHardLimit: exceededHardLimit
    )
  }
}

private final class DrainCompletion: @unchecked Sendable {
  private let lock = NSLock()
  private let group: DispatchGroup
  private var finished = false

  init(group: DispatchGroup) {
    self.group = group
    group.enter()
  }

  func finish() {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    finished = true
    lock.unlock()
    group.leave()
  }
}

private enum ParentVerifier {
  private static let parentIdentifier = "app.omniagent.omniagent"
  private static let helperIdentifier = "app.omniagent.omniagent.command-runner-helper"

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
      Data(SHA256.hash(data: SecCertificateCopyData(certificate) as Data))
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

private final class CommandRunner {
  private static let allowedInputKeys: Set<String> = [
    "workspaceId", "workspaceName", "workspaceRoot", "workingDirectory",
    "executable", "arguments", "relativeDirectory", "timeoutSeconds",
  ]
  private static let forbiddenExecutables: Set<String> = [
    "ash", "bash", "csh", "dash", "env", "exec", "fish", "ksh", "launchctl",
    "login", "nohup", "open", "osascript", "script", "security", "sh", "sudo",
    "tcsh", "time", "xargs", "zsh",
  ]
  private static let executableSearchDirectories = [
    "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin",
  ]
  private static let maximumArgumentCount = 64
  private static let maximumArgumentBytes = 8 * 1_024
  private static let maximumCombinedArgumentBytes = 48 * 1_024

  func execute(_ envelope: [String: Any]) -> [String: Any] {
    guard let id = envelope["id"] as? String else {
      return response(id: "invalid", outcome: "failed", errorCode: "invalid_command")
    }
    do {
      let (request, expiration) = try validate(envelope, id: id)
      let result = try run(request, expiration: expiration)
      return response(id: id, outcome: "succeeded", result: result)
    } catch CommandRunnerFailure.rejected(let code) {
      return response(id: id, outcome: "failed", errorCode: code)
    } catch {
      return response(id: id, outcome: "failed", errorCode: "command_runner_error")
    }
  }

  private func validate(
    _ envelope: [String: Any],
    id: String
  ) throws -> (CommandRequest, Date) {
    guard envelope.count == 4,
          isCommandId(id),
          envelope["action"] as? String == "run_command",
          let input = envelope["input"] as? [String: Any],
          Set(input.keys) == Self.allowedInputKeys,
          let expiresAt = envelope["expiresAt"] as? String,
          let expiration = parseDate(expiresAt),
          expiration > Date(),
          expiration.timeIntervalSinceNow <= 300,
          let workspaceId = input["workspaceId"] as? String,
          isWorkspaceId(workspaceId),
          let workspaceName = input["workspaceName"] as? String,
          isSafeText(workspaceName, minimum: 1, maximum: 120),
          let rawRoot = input["workspaceRoot"] as? String,
          let rawDirectory = input["workingDirectory"] as? String,
          let executable = input["executable"] as? String,
          isExecutableName(executable),
          !Self.forbiddenExecutables.contains(executable.lowercased()),
          let arguments = input["arguments"] as? [String],
          arguments.count <= Self.maximumArgumentCount,
          arguments.allSatisfy({ isSafeArgument($0) }),
          arguments.reduce(0, { $0 + $1.utf8.count }) <= Self.maximumCombinedArgumentBytes,
          let relativeDirectory = input["relativeDirectory"] as? String,
          isSafeRelativeDirectory(relativeDirectory),
          let timeoutSeconds = input["timeoutSeconds"] as? Int,
          (1...30).contains(timeoutSeconds),
          let root = canonicalDirectory(rawRoot),
          let workingDirectory = canonicalDirectory(rawDirectory),
          contains(root: root, candidate: workingDirectory),
          resolveWorkingDirectory(root: root, relativeDirectory: relativeDirectory) == workingDirectory,
          let executableURL = resolveExecutable(executable)
    else { throw CommandRunnerFailure.rejected("invalid_command_input") }

    return (
      CommandRequest(
        workspaceId: workspaceId,
        workspaceName: workspaceName,
        workspaceRoot: root,
        workingDirectory: workingDirectory,
        executableName: executable,
        executableURL: executableURL,
        arguments: arguments,
        relativeDirectory: relativeDirectory,
        timeoutSeconds: timeoutSeconds
      ),
      expiration
    )
  }

  private func run(_ request: CommandRequest, expiration: Date) throws -> [String: Any] {
    let fileManager = FileManager.default
    let isolatedHome = fileManager.temporaryDirectory
      .appendingPathComponent("asael-command-\(UUID().uuidString.lowercased())", isDirectory: true)
    let isolatedTmp = isolatedHome.appendingPathComponent("tmp", isDirectory: true)
    do {
      try fileManager.createDirectory(
        at: isolatedTmp,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
    } catch {
      throw CommandRunnerFailure.rejected("isolated_home_unavailable")
    }
    defer { try? fileManager.removeItem(at: isolatedHome) }

    let stdout = BoundedStreamCollector()
    let stderr = BoundedStreamCollector()
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    let drainGroup = DispatchGroup()
    let stdoutDrain = startDrain(stdoutPipe.fileHandleForReading, into: stdout, group: drainGroup)
    let stderrDrain = startDrain(stderrPipe.fileHandleForReading, into: stderr, group: drainGroup)

    let process = Process()
    process.executableURL = request.executableURL
    process.arguments = request.arguments
    process.currentDirectoryURL = request.workingDirectory
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    process.environment = [
      "CI": "1",
      "GIT_ASKPASS": "/usr/bin/false",
      "GIT_TERMINAL_PROMPT": "0",
      "HOME": isolatedHome.path,
      "LANG": "en_US.UTF-8",
      "LC_ALL": "en_US.UTF-8",
      "NO_COLOR": "1",
      "PATH": Self.executableSearchDirectories.joined(separator: ":"),
      "SSH_ASKPASS": "/usr/bin/false",
      "TERM": "dumb",
      "TMPDIR": isolatedTmp.path,
    ]

    let startedAt = Date()
    ActiveChildRegistry.shared.set(process)
    do {
      try process.run()
    } catch {
      ActiveChildRegistry.shared.clear(process)
      closeDrain(stdoutPipe.fileHandleForReading, completion: stdoutDrain)
      closeDrain(stderrPipe.fileHandleForReading, completion: stderrDrain)
      throw CommandRunnerFailure.rejected("command_launch_failed")
    }
    _ = setpgid(process.processIdentifier, process.processIdentifier)
    defer { ActiveChildRegistry.shared.clear(process) }

    let requestedDeadline = startedAt.addingTimeInterval(TimeInterval(request.timeoutSeconds))
    let deadline = min(requestedDeadline, expiration.addingTimeInterval(-0.1))
    var failureCode: String?
    while process.isRunning {
      if stdout.hardLimitExceeded || stderr.hardLimitExceeded {
        failureCode = "command_output_limit_exceeded"
        terminateProcessGroup(process, grace: 0.25)
        break
      }
      if Date() >= deadline {
        failureCode = "command_timeout"
        terminateProcessGroup(process, grace: 0.25)
        break
      }
      Thread.sleep(forTimeInterval: 0.025)
    }
    process.waitUntilExit()
    _ = drainGroup.wait(timeout: .now() + 1.0)
    closeDrain(stdoutPipe.fileHandleForReading, completion: stdoutDrain)
    closeDrain(stderrPipe.fileHandleForReading, completion: stderrDrain)

    if let failureCode { throw CommandRunnerFailure.rejected(failureCode) }
    let stdoutResult = stdout.snapshot()
    let stderrResult = stderr.snapshot()
    if stdoutResult.exceededHardLimit || stderrResult.exceededHardLimit {
      throw CommandRunnerFailure.rejected("command_output_limit_exceeded")
    }

    let durationMs = max(0, Int(Date().timeIntervalSince(startedAt) * 1_000))
    let exitCode = Int(process.terminationStatus)
    let terminalOutput: [String: Any] = [
      "stdout": stdoutResult.text,
      "stderr": stderrResult.text,
      "exitCode": exitCode,
      "durationMs": durationMs,
      "stdoutBytes": stdoutResult.byteCount,
      "stderrBytes": stderrResult.byteCount,
      "stdoutSha256": stdoutResult.sha256,
      "stderrSha256": stderrResult.sha256,
      "stdoutTruncated": stdoutResult.truncated,
      "stderrTruncated": stderrResult.truncated,
    ]
    let data: [String: Any] = [
      "workspaceId": request.workspaceId,
      "workspaceName": request.workspaceName,
      "executable": request.executableName,
      "argumentCount": request.arguments.count,
      "relativeDirectory": request.relativeDirectory,
      "timeoutSeconds": request.timeoutSeconds,
      "exitCode": exitCode,
      "durationMs": durationMs,
      "stdoutBytes": stdoutResult.byteCount,
      "stderrBytes": stderrResult.byteCount,
      "stdoutSha256": stdoutResult.sha256,
      "stderrSha256": stderrResult.sha256,
      "stdoutTruncated": stdoutResult.truncated,
      "stderrTruncated": stderrResult.truncated,
      "effectVerdict": "confirmed",
    ]
    return [
      "summary": exitCode == 0
        ? "The approved command completed successfully."
        : "The approved command completed with exit code \(exitCode).",
      "data": data,
      "terminalOutput": terminalOutput,
    ]
  }

  private func startDrain(
    _ handle: FileHandle,
    into collector: BoundedStreamCollector,
    group: DispatchGroup
  ) -> DrainCompletion {
    let completion = DrainCompletion(group: group)
    handle.readabilityHandler = { readable in
      let data = readable.availableData
      if data.isEmpty {
        readable.readabilityHandler = nil
        completion.finish()
      } else {
        collector.append(data)
      }
    }
    return completion
  }

  private func closeDrain(_ handle: FileHandle, completion: DrainCompletion) {
    handle.readabilityHandler = nil
    completion.finish()
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

  private func resolveExecutable(_ name: String) -> URL? {
    for directory in Self.executableSearchDirectories {
      let candidate = URL(fileURLWithPath: directory, isDirectory: true)
        .appendingPathComponent(name, isDirectory: false)
      if FileManager.default.isExecutableFile(atPath: candidate.path) {
        let resolved = candidate.standardizedFileURL.resolvingSymlinksInPath()
        guard !Self.forbiddenExecutables.contains(resolved.lastPathComponent.lowercased())
        else { return nil }
        return resolved
      }
    }
    return nil
  }

  private func canonicalDirectory(_ path: String) -> URL? {
    guard !path.isEmpty, path.utf8.count <= 4_096, path.hasPrefix("/"),
          !path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
    else { return nil }
    let url = URL(fileURLWithPath: path, isDirectory: true)
      .standardizedFileURL
      .resolvingSymlinksInPath()
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
          isDirectory.boolValue
    else { return nil }
    return url
  }

  private func contains(root: URL, candidate: URL) -> Bool {
    if root.path == "/" { return candidate.path.hasPrefix("/") }
    return candidate.path == root.path || candidate.path.hasPrefix(root.path + "/")
  }

  private func resolveWorkingDirectory(root: URL, relativeDirectory: String) -> URL? {
    let candidate = relativeDirectory.isEmpty
      ? root
      : root.appendingPathComponent(relativeDirectory, isDirectory: true)
    return canonicalDirectory(candidate.path)
  }

  private func isWorkspaceId(_ value: String) -> Bool {
    value.range(of: #"^local_workspace_[a-f0-9]{32}$"#, options: .regularExpression) != nil
  }

  private func isCommandId(_ value: String) -> Bool {
    value.range(
      of: #"^local_computer_command_[a-f0-9]{48}$"#,
      options: .regularExpression
    ) != nil
  }

  private func isExecutableName(_ value: String) -> Bool {
    value.utf8.count <= 64
      && value.range(of: #"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$"#, options: .regularExpression) != nil
  }

  private func isSafeArgument(_ value: String) -> Bool {
    value.utf8.count <= Self.maximumArgumentBytes
      && !value.unicodeScalars.contains(where: {
        $0.value == 0 || ($0.value < 0x20 && $0.value != 0x09) || $0.value == 0x7f
      })
  }

  private func isSafeRelativeDirectory(_ value: String) -> Bool {
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

  private func isSafeText(_ value: String, minimum: Int, maximum: Int) -> Bool {
    value.count >= minimum && value.count <= maximum
      && !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
  }

  private func parseDate(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }
}

private func sanitizedOutput(
  _ data: Data,
  maximumUTF8Bytes: Int
) -> (text: String, truncated: Bool) {
  let decoded = String(decoding: data, as: UTF8.self)
  var result = String()
  var resultBytes = 0
  var truncated = false
  var previousWasCarriageReturn = false

  func append(_ value: String) -> Bool {
    let additionalBytes = value.utf8.count
    guard resultBytes <= maximumUTF8Bytes - additionalBytes else { return false }
    result.append(value)
    resultBytes += additionalBytes
    return true
  }

  for scalar in decoded.unicodeScalars {
    let value: String
    switch scalar.value {
    case 0x0a:
      value = previousWasCarriageReturn ? "" : "\n"
      previousWasCarriageReturn = false
    case 0x0d:
      value = "\n"
      previousWasCarriageReturn = true
    case 0x09:
      value = "\t"
      previousWasCarriageReturn = false
    case 0x20...0x7e:
      value = String(scalar)
      previousWasCarriageReturn = false
    case 0xa0...0x10ffff:
      switch scalar.properties.generalCategory {
      case .control, .format, .lineSeparator, .paragraphSeparator, .surrogate,
           .privateUse, .unassigned:
        value = " "
      default:
        value = String(scalar)
      }
      previousWasCarriageReturn = false
    default:
      value = " "
      previousWasCarriageReturn = false
    }
    guard value.isEmpty || append(value) else {
      truncated = true
      break
    }
  }
  return (result, truncated)
}

private func terminateProcessGroup(_ process: Process, grace: TimeInterval) {
  guard process.isRunning else { return }
  let pid = process.processIdentifier
  if pid > 1 {
    _ = kill(-pid, SIGTERM)
    _ = kill(pid, SIGTERM)
  }
  let deadline = Date().addingTimeInterval(max(0, grace))
  while process.isRunning && Date() < deadline {
    Thread.sleep(forTimeInterval: 0.025)
  }
  if process.isRunning, pid > 1 {
    _ = kill(-pid, SIGKILL)
    _ = kill(pid, SIGKILL)
  }
}

#if !ASAEL_COMMAND_RUNNER_HELPER_TESTING
@main
private enum AsaelCommandRunnerHelper {
  static func main() {
    guard ParentVerifier.verify() else {
      FileHandle.standardError.write(Data("parent_verification_failed\n".utf8))
      exit(78)
    }

    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    terminateSource.setEventHandler {
      ActiveChildRegistry.shared.terminate()
      _exit(143)
    }
    terminateSource.resume()
    let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
    interruptSource.setEventHandler {
      ActiveChildRegistry.shared.terminate()
      _exit(130)
    }
    interruptSource.resume()

    guard let line = readLine(strippingNewline: true),
          line.utf8.count <= 96 * 1_024,
          let data = line.data(using: .utf8),
          let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      emit(["id": "invalid", "outcome": "failed", "errorCode": "invalid_command"])
      return
    }
    emit(CommandRunner().execute(envelope))
  }

  private static func emit(_ response: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(response),
          let data = try? JSONSerialization.data(withJSONObject: response),
          data.count <= 512 * 1_024
    else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
  }
}
#endif
