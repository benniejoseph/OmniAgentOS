import Foundation
#if !RECOVERY_STORAGE_POLICY_TESTS
import XCTest
@testable import omniagent
#endif

private enum RecoveryPolicyTestError: Error { case failed(String) }
private func checkRecovery(_ condition: @autoclosure () -> Bool, _ detail: String) throws {
  if !condition() { throw RecoveryPolicyTestError.failed(detail) }
}

private final class RecoveryRaceResults {
  private let lock = NSLock()
  private var values: [String] = []
  func append(_ value: String) { lock.lock(); defer { lock.unlock() }; values.append(value) }
  func snapshot() -> [String] { lock.lock(); defer { lock.unlock() }; return values }
}

private enum RecoveryStoragePolicyCases {
  static let secret = "abcdefghijklmnopqrstuvwx"
  static let key = String(repeating: "a", count: 64)
  static func arguments(key: String = RecoveryStoragePolicyCases.key, namespace: String = "responsibility",
      content: String? = nil, expected: String? = nil) -> [String: Any] {
    var value: [String: Any] = ["schemaVersion": 1, "namespace": namespace, "secretId": secret, "recordKey": key]
    if let content {
      value["ciphertext"] = content
      value["expectedSha256"] = expected.map { $0 as Any } ?? NSNull()
    }
    return value
  }
  static func root() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("recovery-policy-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }
  static func expect(_ failure: RecoveryStorageFailure, _ operation: () throws -> Void) throws {
    do { try operation() }
    catch let actual as RecoveryStorageFailure {
      try checkRecovery(actual == failure, "Wrong failure: \(actual)"); return
    }
    throw RecoveryPolicyTestError.failed("Expected \(failure)")
  }
  static func strictPaths() throws {
    let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
    let store = RecoveryStorageTransactionStore(applicationSupport: { root })
    for replacement in [["recordKey": "../foreign"], ["namespace": "capture"],
                        ["secretId": "../../foreign"], ["path": "/tmp/foreign"]] {
      var request = arguments(content: "opaque")
      for (key, value) in replacement { request[key] = value }
      try expect(.invalid) { _ = try store.execute(method: "compareAndSwap", arguments: request) }
    }
    var boolean = arguments(); boolean["schemaVersion"] = true
    try expect(.invalid) { _ = try store.execute(method: "read", arguments: boolean) }
  }
  static func concurrentWriters() throws {
    let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
    let group = DispatchGroup(), results = RecoveryRaceResults()
    for content in ["first-encrypted-intent", "second-encrypted-intent"] {
      group.enter()
      DispatchQueue.global().async {
        defer { group.leave() }
        let store = RecoveryStorageTransactionStore(applicationSupport: { root })
        do {
          _ = try store.execute(method: "compareAndSwap", arguments: arguments(content: content))
          results.append(content)
        } catch let failure as RecoveryStorageFailure { results.append(failure.rawValue) }
        catch { results.append("unexpected") }
      }
    }
    try checkRecovery(group.wait(timeout: .now() + 5) == .success, "Concurrent writers did not finish")
    let values = results.snapshot()
    try checkRecovery(values.filter { $0 == RecoveryStorageFailure.conflict.rawValue }.count == 1, "Exactly one stale writer must fail")
    let read = try RecoveryStorageTransactionStore(applicationSupport: { root }).execute(method: "read", arguments: arguments())
    try checkRecovery(values.contains(read["ciphertext"] as? String ?? "missing"), "Winner was not retained")
  }
  static func capacityAndStaleIntent() throws {
    let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
    let store = RecoveryStorageTransactionStore(applicationSupport: { root })
    for index in 0..<63 {
      _ = try store.execute(method: "compareAndSwap", arguments: arguments(key: String(format: "%064x", index), content: "encrypted-\(index)"))
    }
    let group = DispatchGroup(), results = RecoveryRaceResults()
    for index in [63, 64] {
      group.enter()
      DispatchQueue.global().async {
        defer { group.leave() }
        do {
          _ = try RecoveryStorageTransactionStore(applicationSupport: { root }).execute(method: "compareAndSwap",
            arguments: arguments(key: String(format: "%064x", index), content: "candidate-\(index)"))
          results.append("committed")
        } catch let failure as RecoveryStorageFailure { results.append(failure.rawValue) }
        catch { results.append("unexpected") }
      }
    }
    try checkRecovery(group.wait(timeout: .now() + 5) == .success, "Capacity contenders did not finish")
    try checkRecovery(results.snapshot().sorted() == ["committed", "recovery_capacity"], "Concurrent roots exceeded inventory capacity")
    try expect(.capacity) { _ = try store.execute(method: "compareAndSwap", arguments: arguments(content: "overflow")) }
    let existingKey = String(format: "%064x", 0)
    let old = try store.execute(method: "read", arguments: arguments(key: existingKey))
    _ = try store.execute(method: "compareAndSwap", arguments: arguments(key: existingKey, content: "updated", expected: old["sha256"] as? String))
    try expect(.conflict) { _ = try store.execute(method: "compareAndSwap", arguments: arguments(key: existingKey, content: "stale", expected: old["sha256"] as? String)) }
  }
  static func failuresAroundRename() throws {
    let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
    let store = RecoveryStorageTransactionStore(applicationSupport: { root })
    let saved = try store.execute(method: "compareAndSwap", arguments: arguments(content: "original"))
    let expected = saved["sha256"] as? String
    let before = RecoveryStorageTransactionStore(applicationSupport: { root }, commitPhase: { phase in
      if phase == .beforeRename { throw RecoveryPolicyTestError.failed("injected") }
    })
    try expect(.unknown) { _ = try before.execute(method: "compareAndSwap", arguments: arguments(content: "replacement", expected: expected)) }
    var read = try store.execute(method: "read", arguments: arguments())
    try checkRecovery(read["ciphertext"] as? String == "original", "Pre-rename failure replaced durable intent")
    let after = RecoveryStorageTransactionStore(applicationSupport: { root }, commitPhase: { phase in
      if phase == .afterRename { throw RecoveryPolicyTestError.failed("response lost") }
    })
    try expect(.unknown) { _ = try after.execute(method: "compareAndSwap", arguments: arguments(content: "replacement", expected: expected)) }
    read = try store.execute(method: "read", arguments: arguments())
    try checkRecovery(read["ciphertext"] as? String == "replacement", "Post-rename unknown lost exact intent")
    try expect(.conflict) { _ = try store.execute(method: "compareAndSwap", arguments: arguments(content: "third", expected: expected)) }
  }
  static func existingCiphertextAndAbandonedStage() throws {
    let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("asael-builder-recovery-v1/\(secret)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let existing = "{\"version\":1,\"algorithm\":\"aes-256-gcm\",\"ciphertext\":\"é\"}"
    try Data(existing.utf8).write(to: directory.appendingPathComponent("\(key).builder"))
    let stage = directory.appendingPathComponent(".stage-\(UUID().uuidString.lowercased()).tmp")
    try Data("abandoned-encrypted-write".utf8).write(to: stage)
    let unexpected = directory.appendingPathComponent(".stage-\(UUID().uuidString.lowercased()).tmp")
    try FileManager.default.createDirectory(at: unexpected, withIntermediateDirectories: true)
    let retained = unexpected.appendingPathComponent("retained.builder")
    try Data("retain-unexpected-directory".utf8).write(to: retained)
    let store = RecoveryStorageTransactionStore(applicationSupport: { root })
    let read = try store.execute(method: "read", arguments: arguments(namespace: "builder"))
    try checkRecovery(read["ciphertext"] as? String == existing, "Existing ciphertext changed during broker upgrade")
    try checkRecovery(read["sha256"] as? String == RecoveryStorageTransactionStore.digest(Data(existing.utf8)), "Digest is not raw UTF8")
    _ = try store.execute(method: "compareAndSwap", arguments: arguments(namespace: "builder", content: "next", expected: read["sha256"] as? String))
    try checkRecovery(!FileManager.default.fileExists(atPath: stage.path), "Abandoned stage was not reclaimed under lock")
    try checkRecovery(FileManager.default.fileExists(atPath: retained.path), "Stage-like directory was recursively removed")
  }
  static func meetingsLegacyPath() throws {
    let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("asael-meeting-drafts-v1/\(secret)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent("\(key).meeting")
    try Data("existing-meeting-ciphertext".utf8).write(to: file)
    let store = RecoveryStorageTransactionStore(applicationSupport: { root })
    let read = try store.execute(method: "read", arguments: arguments(namespace: "meetings"))
    try checkRecovery(read["ciphertext"] as? String == "existing-meeting-ciphertext", "Meetings legacy path was changed")
    _ = try store.execute(method: "compareAndSwap", arguments: arguments(namespace: "meetings", content: "meeting-update", expected: read["sha256"] as? String))
    let updated = try String(contentsOf: file, encoding: .utf8)
    try checkRecovery(updated == "meeting-update", "Meetings update escaped the existing record")
  }
  static func captureArguments(id: String = RecoveryStoragePolicyCases.secret, content: String? = nil,
    expected: String? = nil, bytes: Int? = nil, mode: String? = nil) -> [String: Any] {
    var result: [String: Any] = ["schemaVersion": 1, "namespace": "capture", "secretId": secret, "entryId": id]
    if let content { result["ciphertext"] = content }
    if let expected { result["expectedSha256"] = expected }
    if let bytes { result["expectedBytes"] = bytes }
    if let mode { result["mode"] = mode }
    return result
  }
  static func captureContent(_ id: String, version: Int = 3) throws -> String {
    try (version == 1 ? [""] : ["metadata", "payload"]).map { record in
      var value: [String: Any] = ["schemaVersion": version, "id": id, "algorithm": "aes-256-gcm",
        "nonce": "opaque", "cipherText": "opaque-encrypted-bytes", "mac": "opaque"]
      if version != 1 { value["record"] = record }
      return String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
    }.joined(separator: "\n")
  }
  static func captureConcurrentCapacity() throws {
    let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("asael-capture-outbox-v1/\(secret)")
    let quarantine = directory.appendingPathComponent(".stage-\(UUID().uuidString.lowercased()).tmp")
    try FileManager.default.createDirectory(at: quarantine, withIntermediateDirectories: true)
    let legacy = quarantine.appendingPathComponent("\(secret).capture")
    try Data(captureContent(secret, version: 1).utf8).write(to: legacy)
    let store = RecoveryStorageTransactionStore(applicationSupport: { root })
    for index in 0..<23 {
      let id = String(format: "%024x", index)
      _ = try store.execute(method: "appendCapture", arguments: captureArguments(id: id, content: captureContent(id)))
    }
    let group = DispatchGroup(), results = RecoveryRaceResults()
    for index in [23, 24] {
      group.enter()
      DispatchQueue.global().async {
        defer { group.leave() }
        do {
          let id = String(format: "%024x", index)
          _ = try RecoveryStorageTransactionStore(applicationSupport: { root }).execute(method: "appendCapture",
            arguments: captureArguments(id: id, content: captureContent(id)))
          results.append("appended")
        } catch let failure as RecoveryStorageFailure { results.append(failure.rawValue) }
        catch { results.append("unexpected") }
      }
    }
    try checkRecovery(group.wait(timeout: .now() + 5) == .success, "Capture contenders did not finish")
    try checkRecovery(results.snapshot().sorted() == ["appended", "recovery_capacity"], "Capture capacity admitted both windows")
    try checkRecovery(FileManager.default.fileExists(atPath: legacy.path), "A stage-like directory lost quarantined ciphertext")
  }
  static func captureByteCapacity() throws {
    let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("asael-capture-outbox-v1/\(secret)/legacy-cleanup-old")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let legacy = directory.appendingPathComponent("\(key).capture")
    _ = FileManager.default.createFile(atPath: legacy.path, contents: Data())
    let handle = try FileHandle(forWritingTo: legacy)
    try handle.truncate(atOffset: UInt64(CaptureStorageRequest.maximumBytes))
    try handle.close()
    let store = RecoveryStorageTransactionStore(applicationSupport: { root })
    try expect(.capacity) {
      _ = try store.execute(method: "appendCapture", arguments: captureArguments(content: captureContent(secret)))
    }
    let bytes = try legacy.resourceValues(forKeys: [.fileSizeKey]).fileSize
    try checkRecovery(bytes == CaptureStorageRequest.maximumBytes, "Quota rejection changed old ciphertext")
  }
  static func captureExactDeletionAndUnknown() throws {
    let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
    let store = RecoveryStorageTransactionStore(applicationSupport: { root })
    let content = try captureContent(secret)
    let hash = RecoveryStorageTransactionStore.digest(Data(content.utf8))
    var invalid = captureArguments(content: content); invalid["path"] = "/tmp/foreign"
    try expect(.invalid) { _ = try store.execute(method: "appendCapture", arguments: invalid) }
    invalid = captureArguments(); invalid["entryId"] = "\(secret)\n"
    try expect(.invalid) { _ = try store.execute(method: "readCapture", arguments: invalid) }
    invalid = captureArguments(expected: hash, bytes: content.utf8.count, mode: "schema3"); invalid["expectedBytes"] = true
    try expect(.invalid) { _ = try store.execute(method: "deleteCapture", arguments: invalid) }
    _ = try store.execute(method: "appendCapture", arguments: captureArguments(content: content))
    try expect(.conflict) { _ = try store.execute(method: "appendCapture", arguments: captureArguments(content: content)) }
    for request in [captureArguments(expected: hash, bytes: content.utf8.count, mode: "legacy"),
                    captureArguments(expected: hash, bytes: content.utf8.count + 1, mode: "schema3")] {
      try expect(.conflict) { _ = try store.execute(method: "deleteCapture", arguments: request) }
    }
    let read = try store.execute(method: "readCapture", arguments: captureArguments())
    try checkRecovery(read["ciphertext"] as? String == content, "Rejected legacy deletion changed schema 3")
    let after = RecoveryStorageTransactionStore(applicationSupport: { root }, commitPhase: { phase in
      if phase == .afterDelete { throw RecoveryPolicyTestError.failed("lost deletion acknowledgement") }
    })
    try expect(.unknown) {
      _ = try after.execute(method: "deleteCapture", arguments: captureArguments(expected: hash, bytes: content.utf8.count, mode: "schema3"))
    }
    let absent = try store.execute(method: "readCapture", arguments: captureArguments())
    try checkRecovery(absent["ciphertext"] is NSNull, "Unconfirmed deletion was falsely retained")
    let old = try captureContent(secret, version: 2)
    let file = root.appendingPathComponent("asael-capture-outbox-v1/\(secret)/\(secret).capture")
    try Data(old.utf8).write(to: file)
    let removed = try store.execute(method: "deleteCapture", arguments: captureArguments(
      expected: RecoveryStorageTransactionStore.digest(Data(old.utf8)), bytes: old.utf8.count, mode: "legacy"))
    try checkRecovery(removed["deleted"] as? Bool == true, "Exact schema-2 legacy deletion failed")
  }
  static func capturePublicationBoundaries() throws {
    for phase in [RecoveryStorageCommitPhase.beforeRename, .afterRename] {
      let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
      let content = try captureContent(secret)
      let failing = RecoveryStorageTransactionStore(applicationSupport: { root }, commitPhase: { reached in
        if reached == phase { throw RecoveryPolicyTestError.failed("publication response lost") }
      })
      try expect(.unknown) { _ = try failing.execute(method: "appendCapture", arguments: captureArguments(content: content)) }
      let store = RecoveryStorageTransactionStore(applicationSupport: { root })
      let read = try store.execute(method: "readCapture", arguments: captureArguments())
      if phase == .beforeRename { try checkRecovery(read["ciphertext"] is NSNull, "Pre-publication failure admitted capture") }
      else { try checkRecovery(read["ciphertext"] as? String == content, "Published exact capture was lost") }
    }
  }
  static func run() throws {
    try strictPaths()
    try concurrentWriters()
    try capacityAndStaleIntent()
    try failuresAroundRename()
    try existingCiphertextAndAbandonedStage()
    try meetingsLegacyPath()
    try captureConcurrentCapacity()
    try captureByteCapacity()
    try captureExactDeletionAndUnknown()
    try capturePublicationBoundaries()
  }
}

#if RECOVERY_STORAGE_POLICY_TESTS
@main
private enum RecoveryStoragePolicyMain {
  static func main() throws {
    if CommandLine.arguments.count == 3 {
      let root = URL(fileURLWithPath: CommandLine.arguments[2])
      if CommandLine.arguments[1].hasPrefix("--capture-") {
        let action = CommandLine.arguments[1]
        let phase: RecoveryStorageCommitPhase = action == "--capture-before" ? .beforeRename :
          action == "--capture-after" ? .afterRename : .afterDelete
        let store = RecoveryStorageTransactionStore(applicationSupport: { root }, commitPhase: { reached in
          if reached == phase { _exit(81) }
        })
        let content = try RecoveryStoragePolicyCases.captureContent(RecoveryStoragePolicyCases.secret)
        if phase == .afterDelete {
          _ = try store.execute(method: "deleteCapture", arguments: RecoveryStoragePolicyCases.captureArguments(
            expected: RecoveryStorageTransactionStore.digest(Data(content.utf8)), bytes: content.utf8.count, mode: "schema3"))
        } else {
          _ = try store.execute(method: "appendCapture", arguments: RecoveryStoragePolicyCases.captureArguments(content: content))
        }
        throw RecoveryPolicyTestError.failed("Capture crash injection did not exit")
      }
      let phase: RecoveryStorageCommitPhase = CommandLine.arguments[1] == "--before" ? .beforeRename : .afterRename
      let store = RecoveryStorageTransactionStore(applicationSupport: { root }, commitPhase: { reached in
        if reached == phase { _exit(81) }
      })
      let read = try store.execute(method: "read", arguments: RecoveryStoragePolicyCases.arguments())
      _ = try store.execute(method: "compareAndSwap", arguments: RecoveryStoragePolicyCases.arguments(content: "after-crash", expected: read["sha256"] as? String))
      throw RecoveryPolicyTestError.failed("Crash injection did not exit")
    }
    try RecoveryStoragePolicyCases.run()
    for phase in ["--before", "--after"] {
      let root = try RecoveryStoragePolicyCases.root()
      defer { try? FileManager.default.removeItem(at: root) }
      let store = RecoveryStorageTransactionStore(applicationSupport: { root })
      _ = try store.execute(method: "compareAndSwap", arguments: RecoveryStoragePolicyCases.arguments(content: "before-crash"))
      let process = Process()
      process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
      process.arguments = [phase, root.path]
      try process.run(); process.waitUntilExit()
      try checkRecovery(process.terminationStatus == 81, "Child did not reach crash boundary")
      let read = try store.execute(method: "read", arguments: RecoveryStoragePolicyCases.arguments())
      try checkRecovery(read["ciphertext"] as? String == (phase == "--before" ? "before-crash" : "after-crash"), "Crash lost committed intent")
      _ = try store.execute(method: "compareAndSwap", arguments: RecoveryStoragePolicyCases.arguments(content: "reopened", expected: read["sha256"] as? String))
    }
    for phase in ["--capture-before", "--capture-after", "--capture-delete"] {
      let root = try RecoveryStoragePolicyCases.root()
      defer { try? FileManager.default.removeItem(at: root) }
      let store = RecoveryStorageTransactionStore(applicationSupport: { root })
      let content = try RecoveryStoragePolicyCases.captureContent(RecoveryStoragePolicyCases.secret)
      if phase == "--capture-delete" {
        _ = try store.execute(method: "appendCapture", arguments: RecoveryStoragePolicyCases.captureArguments(content: content))
      }
      let process = Process()
      process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
      process.arguments = [phase, root.path]
      try process.run(); process.waitUntilExit()
      try checkRecovery(process.terminationStatus == 81, "Capture subprocess did not reach its transaction boundary")
      let read = try store.execute(method: "readCapture", arguments: RecoveryStoragePolicyCases.captureArguments())
      if phase == "--capture-after" {
        try checkRecovery(read["ciphertext"] as? String == content, "Committed Capture bytes changed after process exit")
      } else { try checkRecovery(read["ciphertext"] is NSNull, "Capture crash disposition was not preserved") }
      let next = String(repeating: "b", count: 24)
      _ = try store.execute(method: "appendCapture", arguments: RecoveryStoragePolicyCases.captureArguments(
        id: next, content: RecoveryStoragePolicyCases.captureContent(next)))
    }
    print("Recovery storage policy cases passed")
  }
}
#else
final class RecoveryStorageBrokerTests: XCTestCase {
  func testStrictProtocolAndPaths() throws { try RecoveryStoragePolicyCases.strictPaths() }
  func testIndependentConcurrentWriters() throws { try RecoveryStoragePolicyCases.concurrentWriters() }
  func testCapacityAndStaleIntent() throws { try RecoveryStoragePolicyCases.capacityAndStaleIntent() }
  func testFailuresAroundAtomicRename() throws { try RecoveryStoragePolicyCases.failuresAroundRename() }
  func testExistingCiphertextAndAbandonedStage() throws { try RecoveryStoragePolicyCases.existingCiphertextAndAbandonedStage() }
  func testMeetingsLegacyPath() throws { try RecoveryStoragePolicyCases.meetingsLegacyPath() }
  func testCaptureConcurrentCapacity() throws { try RecoveryStoragePolicyCases.captureConcurrentCapacity() }
  func testCaptureByteCapacity() throws { try RecoveryStoragePolicyCases.captureByteCapacity() }
  func testCaptureExactDeletionAndUnknown() throws { try RecoveryStoragePolicyCases.captureExactDeletionAndUnknown() }
  func testCapturePublicationBoundaries() throws { try RecoveryStoragePolicyCases.capturePublicationBoundaries() }
}
#endif
