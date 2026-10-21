import Foundation

#if DESKTOP_RELIABILITY_TESTS
private func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() { throw NSError(domain: message, code: 1) }
}
private func rejects(_ operation: () throws -> Void) throws {
  do { try operation() } catch { return }
  throw NSError(domain: "Expected rejection", code: 1)
}

@main
struct DesktopReliabilityPolicyTests {
  static func main() throws {
    let owner = String(repeating: "a", count: 64)
    let watch = "watch_" + String(repeating: "b", count: 48)
    let state = DesktopSessionProtectionState()
    func change(_ action: String, extra: [String: Any] = [:]) throws -> [String: Any] {
      var value: [String: Any] = ["action": action, "epoch": state.epoch, "expectedScope": state.scope as Any? ?? NSNull()]
      extra.forEach { value[$0] = $1 }
      return try state.change(value)
    }
    _ = try change("bind", extra: ["scope": owner, "biometricEnabled": true])
    let stale: [String: Any] = ["action": "unlock", "epoch": state.epoch, "expectedScope": owner]
    try require(state.protectForSystemEvent(), "System lock must protect every engine")
    try require(state.payload["locked"] as? Bool == true, "A new engine snapshot inherits the lock")
    try rejects { _ = try state.change(stale) }
    let epoch = state.epoch
    _ = try change("lock")
    try require(state.epoch == epoch, "Duplicate lock must be idempotent")
    let pendingUnlock: [String: Any] = ["action": "unlock", "epoch": state.epoch, "expectedScope": owner]
    try require(state.protectForSystemEvent(), "A later system lock fences an in-progress unlock even when already locked")
    try rejects { _ = try state.change(pendingUnlock) }
    _ = try change("unlock")
    let oldSession = state.sessionEpoch
    _ = try change("end")
    try require(state.sessionEpoch > oldSession && state.locked && state.ended, "End fences old operations")
    try rejects { _ = try change("bind", extra: ["scope": owner, "biometricEnabled": true]) }
    try rejects { _ = try change("unlock") }
    _ = try change("replace")
    _ = try change("bind", extra: ["scope": owner, "biometricEnabled": true])
    try require(state.sessionEpoch > oldSession + 1, "Same-owner login has a new incarnation")
    try rejects { _ = try change("bind", extra: ["scope": String(repeating: "c", count: 64), "biometricEnabled": true]) }
    print("PASS session lock/new-engine snapshot, stale unlock, ended bootstrap, same-owner incarnation, owner substitution")

    let name = "asael-reliability-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    var now = Date(timeIntervalSince1970: 1_700_000_000)
    let intents = DesktopWatchIntentStore(defaults: defaults, now: { now })
    try require(intents.enqueue(scope: owner, watchId: watch), "Retain cold-launch click")
    try require(intents.enqueue(scope: owner, watchId: watch), "Duplicate click accepted once")
    try require(intents.first(scope: String(repeating: "c", count: 64)) == nil, "Wrong owner cannot consume click")
    let restored = DesktopWatchIntentStore(defaults: defaults, now: { now })
    let id = restored.first(scope: owner)!["id"] as! String
    try require((defaults.array(forKey: DesktopWatchIntentStore.key) ?? []).count == 1, "One queued destination")
    restored.remove(id: id)
    try require(restored.first(scope: owner) == nil, "Only acknowledged click removed")
    try require(intents.enqueue(scope: owner, watchId: watch), "Queue second click")
    now.addTimeInterval(86_400)
    try require(restored.first(scope: owner) == nil, "Expired clicks are not replayed")
    let failed = DesktopWatchIntentStore(defaults: defaults, now: { now }, synchronize: { false })
    try require(!failed.enqueue(scope: owner, watchId: watch), "Persistence failure is not acknowledged")
    try require(intents.enqueue(scope: owner, watchId: watch), "Queue for failed acknowledgement")
    let unacked = intents.first(scope: owner)!["id"] as! String
    try require(!failed.remove(id: unacked), "Failed ack must stop delivery retry")
    try require(intents.first(scope: owner) != nil, "Failed ack keeps the pending click")
    print("PASS watch click persistence/reload, owner isolation, dedupe, ack, expiry, persistence failure")

    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let names: Set<String> = ["one.txt", "two.txt"]
    for name in names { try Data(name.utf8).write(to: directory.appendingPathComponent(name)) }
    try require(try DesktopSharedCaptureReceipts.bindOwner(owner, directory: directory, allowed: names), "First intake binds owner")
    try DesktopSharedCaptureReceipts.acknowledge("one.txt", owner: owner, directory: directory, allowed: names)
    try require(try DesktopSharedCaptureReceipts.read(directory: directory, allowed: names) == ["one.txt"], "Partial receipt survives reload")
    try require(FileManager.default.fileExists(atPath: directory.appendingPathComponent("two.txt").path), "Deferred file is retained")
    try DesktopSharedCaptureReceipts.acknowledge("one.txt", owner: owner, directory: directory, allowed: names)
    try rejects { try DesktopSharedCaptureReceipts.acknowledge("outside.txt", owner: owner, directory: directory, allowed: names) }
    let otherOwner = String(repeating: "c", count: 64)
    try require(try !DesktopSharedCaptureReceipts.bindOwner(otherOwner, directory: directory, allowed: names), "Partial request cannot rebind after restart")
    try rejects { try DesktopSharedCaptureReceipts.acknowledge("two.txt", owner: otherOwner, directory: directory, allowed: names) }
    let journal = directory.appendingPathComponent(DesktopSharedCaptureReceipts.filename)
    try FileManager.default.removeItem(at: journal)
    try FileManager.default.createSymbolicLink(at: journal, withDestinationURL: directory.appendingPathComponent("two.txt"))
    try rejects { _ = try DesktopSharedCaptureReceipts.read(directory: directory, allowed: names) }
    try FileManager.default.removeItem(at: journal)
    try Data(repeating: 0x41, count: 16_385).write(to: journal)
    try rejects { _ = try DesktopSharedCaptureReceipts.read(directory: directory, allowed: names) }
    print("PASS Share per-file receipt/reload/idempotency, retained deferred file, invalid name, symlink and size rejection")
  }
}
#endif
