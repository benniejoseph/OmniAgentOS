import Foundation
import Darwin
#if !NATIVE_UPDATE_POLICY_TESTS
import XCTest
@testable import omniagent
#endif

private enum NativeUpdateCases {
  static let revision = String(repeating: "a", count: 40)
  static let snapshot = String(repeating: "b", count: 64)
  static let owner = String(repeating: "c", count: 64)
  static let nonce = String(repeating: "d", count: 64)
  static var expected: [String: Any] { ["sourceRevision": revision, "sourceSnapshotSha256": snapshot, "version": "1.40.0", "build": 116, "ownerSha256": owner] }
  static func data(_ value: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: value) }
  static func request(_ action: String = "status", patch: [String: Any] = [:]) -> NativeUpdateRequest? {
    var value: [String: Any] = ["protocol": 1, "action": action, "nonce": nonce, "expected": expected]
    value.merge(patch) { _, new in new }; return NativeUpdateRequest(data(value))
  }
  static var provenance: NativeUpdateProvenance {
    var value = expected; value.removeValue(forKey: "ownerSha256"); value["protocol"] = 1
    return NativeUpdateProvenance(data(value), version: "1.40.0", build: "116")!
  }
  static func flutter(_ action: String = "status", status: String = "ready") -> [String: Any] {
    ["protocol": 1, "action": action, "nonce": nonce, "sourceSnapshotSha256": snapshot,
      "version": "1.40.0", "build": 116, "ownerSha256": owner, "status": status,
      "flutterReady": true, "authenticatedWorkspaceReady": true, "improvementRendered": true,
      "busyReasons": [String](), "quiescenceExpiresAt": NSNull(), "startupQuarantined": false, "startupDecision": "none"]
  }
  static func check(_ value: @autoclosure () -> Bool, _ detail: String) {
    assertions += 1
    precondition(value(), detail)
  }
  static var assertions = 0
  static func contracts() {
    check(request() != nil, "Valid request rejected")
    check(request("execute") == nil, "Arbitrary action accepted")
    check(request(patch: ["path": "/tmp/unsafe"]) == nil, "Arbitrary path accepted")
    check(request(patch: ["nonce": "bad"]) == nil, "Unbound nonce accepted")
    check(request(patch: ["protocol": true]) == nil, "Boolean protocol accepted")
    var bad = expected; bad["build"] = true
    check(request(patch: ["expected": bad]) == nil, "Boolean build accepted")
    var manifest = provenance.value; manifest["version"] = "9.0.0"
    check(NativeUpdateProvenance(data(manifest), version: "1.40.0", build: "116") == nil, "Resource/bundle version mismatch accepted")
    check(!provenance.matches(request(patch: ["expected": { var v = expected; v["sourceRevision"] = String(repeating: "e", count: 40); return v }()])!), "Wrong source accepted")
  }
  static func receipts() {
    let bridge = NativeUpdateBridge(provenance: provenance) { _, done in done([:]) }
    let ready = bridge.reply(request()!, flutter: flutter(), extra: [])
    check(ready["status"] as? String == "ready", "Authenticated rendered frame failed")
    check((ready["binding"] as? [String: Any])?["sourceRevision"] as? String == revision, "Source was not measured from signed resource")
    for field in ["nonce", "sourceSnapshotSha256", "ownerSha256"] {
      var value = flutter(); value[field] = String(repeating: "e", count: 64)
      check(bridge.reply(request()!, flutter: value, extra: [])["status"] as? String == "held", "Mismatched \(field) passed")
    }
    for field in ["authenticatedWorkspaceReady", "improvementRendered"] {
      var value = flutter(); value[field] = false
      check(bridge.reply(request()!, flutter: value, extra: [])["status"] as? String == "held", "Early Flutter transport readiness passed")
    }
    var malformed = flutter(); malformed["authenticatedWorkspaceReady"] = 1
    check(bridge.reply(request()!, flutter: malformed, extra: [])["status"] as? String == "held", "Number masqueraded as authenticated boolean")
    malformed = flutter(); malformed["ownerSha256"] = "private unexpected content"
    let hidden = bridge.reply(request()!, flutter: malformed, extra: [])
    check((hidden["binding"] as? [String: Any])?["ownerSha256"] is NSNull, "Unbounded owner output escaped")
    var invalid = flutter(); invalid["busyReasons"] = ["untrusted free text"]
    check(bridge.reply(request()!, flutter: invalid, extra: [])["status"] as? String == "held", "Untrusted diagnostic escaped")
    var lease = flutter("quiesce", status: "quiesced")
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    lease["quiescenceExpiresAt"] = formatter.string(from: Date().addingTimeInterval(25))
    check(bridge.reply(request("quiesce")!, flutter: lease, extra: [])["status"] as? String == "quiesced", "Bounded lease rejected")
    lease["busyReasons"] = ["voice_active"]
    check(bridge.reply(request("quiesce")!, flutter: lease, extra: [])["status"] as? String == "held", "Active voice allowed quit")
    lease["busyReasons"] = [String](); lease["quiescenceExpiresAt"] = formatter.string(from: Date().addingTimeInterval(60))
    check(bridge.reply(request("quiesce")!, flutter: lease, extra: [])["status"] as? String == "held", "Unbounded lease accepted")
    lease["quiescenceExpiresAt"] = formatter.string(from: Date().addingTimeInterval(-1))
    check(bridge.reply(request("quiesce")!, flutter: lease, extra: [])["status"] as? String == "held", "Expired lease accepted")
    NativeUpdateInterlock.until = Date().addingTimeInterval(-1)
    check(!NativeUpdateInterlock.active, "Expired handoff kept the app locked")
  }
  static func quarantine() {
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var ticket: [String: Any] = ["protocol":1,"nonce":nonce,"expected":expected,"publisherPid":Int(getpid()),
      "expiresAt":formatter.string(from:Date().addingTimeInterval(80))]
    let valid = NativeUpdateStartupTicket(data(ticket),provenance:provenance)!
    check(valid.accepts(request()!,peerPid:getpid()),"Exact publisher/ticket binding rejected")
    check(!valid.accepts(request()!,peerPid:getpid()+1),"Different publisher accepted")
    ticket["expiresAt"] = formatter.string(from:Date().addingTimeInterval(120))
    check(NativeUpdateStartupTicket(data(ticket),provenance:provenance) == nil,"Unbounded startup ticket accepted")
    let startup = NativeUpdateStartupQuarantine(valid); NativeUpdateStartupQuarantine.current = startup
    defer { NativeUpdateStartupQuarantine.current = nil }
    check(NativeUpdateInterlock.active,"Startup did not block native admission")
    let bridge = NativeUpdateBridge(provenance:provenance) {_,done in done([:])}
    var value = flutter("quiesce",status:"quiesced")
    value["ownerSha256"] = NSNull(); value["authenticatedWorkspaceReady"] = false; value["improvementRendered"] = false
    value["startupQuarantined"] = true; value["startupDecision"] = "pending"
    value["busyReasons"] = ["session_unavailable","owner_mismatch","route_not_rendered","workspace_not_ready"]
    value["quiescenceExpiresAt"] = formatter.string(from:Date().addingTimeInterval(20))
    let rollback = bridge.reply(request("quiesce")!,flutter:value,extra:[])
    check(rollback["status"] as? String == "quiesced","Untouched quarantined startup could not roll back")
    check(rollback["authenticatedWorkspaceReady"] as? Bool == false,"Rollback fabricated authenticated readiness")
    check((rollback["busyReasons"] as? [String])?.isEmpty == true,"Missing readiness was confused with admitted work")
    var absent: [String: Any]?
    NativeUpdateBridge.inspectReadiness(request("quiesce")!, nativeBusyReasons: { [] }, inspect: nil) { absent = $0 }
    let noEngine = bridge.reply(request("quiesce")!, flutter: absent, extra: [])
    check(noEngine["status"] as? String == "quiesced", "Unstarted quarantined engine could not safely revert")
    for field in ["flutterReady", "authenticatedWorkspaceReady", "improvementRendered"] {
      check(noEngine[field] as? Bool == false,"Native-only rollback invented \(field)")
    }
    check((noEngine["binding"] as? [String: Any])?["ownerSha256"] is NSNull,"Native-only rollback invented owner")
    check(startup.rollbackWithoutFlutter(request("status")!, nativeBusyReasons: []) == nil,"No-engine fallback invented startup success")
    check(startup.rollbackWithoutFlutter(request("quiesce", patch:["nonce":String(repeating:"e",count:64)])!, nativeBusyReasons: []) == nil,"Foreign nonce reverted startup")
    check(startup.rollbackWithoutFlutter(request("quiesce")!, nativeBusyReasons: ["desktop_busy"]) == nil,"Native busy work admitted rollback")
    var timedOut: [String: Any]?, late: (([String: Any]) -> Void)?, completions = 0
    NativeUpdateBridge.inspectReadiness(request("quiesce")!, nativeBusyReasons: { [] }, inspect: { late = $0 }) {
      timedOut = $0; completions += 1
    }
    let deadline = Date().addingTimeInterval(3)
    while timedOut == nil && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    check(timedOut?["status"] as? String == "quiesced", "Timed-out intact quarantine was not recoverable")
    late?(flutter()); check(completions == 1,"Late engine callback repeated the decision")
    value["busyReasons"] = ["voice_active"]
    check(bridge.reply(request("quiesce")!,flutter:value,extra:[])["status"] as? String == "held","Admitted work incorrectly passed quarantine")
    check(!startup.commit(String(repeating:"e",count:64)),"Unbound commit accepted")
    var committed = flutter("commit"); committed["startupDecision"] = "committed"
    for key in ["flutterReady", "version", "build", "action"] {
      var changed = committed
      changed[key] = key == "flutterReady" ? false : key == "build" ? 117 : "invalid"
      check(!startup.commit(request("commit")!,flutter:changed) && startup.active,"Malformed \(key) released quarantine")
    }
    check(startup.commit(request("commit")!,flutter:committed) && startup.decision == "committed" && !startup.active,"Exact commit did not release quarantine")
    check(startup.rollbackWithoutFlutter(request("quiesce")!, nativeBusyReasons: []) == nil,"Committed startup allowed native-only rollback")
    ticket["expiresAt"] = formatter.string(from:Date().addingTimeInterval(-1))
    check(NativeUpdateStartupTicket(data(ticket), provenance:provenance) == nil,"Stale startup ticket accepted")
    ticket["expiresAt"] = formatter.string(from:Date().addingTimeInterval(0.03))
    let expiring = NativeUpdateStartupQuarantine(NativeUpdateStartupTicket(data(ticket), provenance:provenance)!)
    RunLoop.current.run(until:Date().addingTimeInterval(0.05))
    check(expiring.decision == "expired" && expiring.rollbackWithoutFlutter(request("quiesce")!,nativeBusyReasons:[]) == nil,"Expired quarantine admitted rollback")
  }
  #if NATIVE_UPDATE_POLICY_TESTS
  static func exchange(_ path: String, _ request: NativeUpdateRequest) throws -> [String: Any]? {
    let completion = DispatchSemaphore(value: 0)
    let box = TransportBox()
    DispatchQueue.global().async {
      let fd = socket(AF_UNIX, SOCK_STREAM, 0); defer { close(fd); completion.signal() }
      var timeout = timeval(tv_sec: 4, tv_usec: 0)
      setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
      var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
      address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
      withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8) + [0]) }
      let connected = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
      }
      guard connected == 0 else { return }
      var packet = data(request.json); packet.append(10)
      packet.withUnsafeBytes { raw in _ = send(fd, raw.baseAddress!, raw.count, 0) }
      var output = Data(), buffer = [UInt8](repeating: 0, count: 4096)
      while output.count < 8192 {
        let count = recv(fd, &buffer, buffer.count, 0); if count <= 0 { break }
        output.append(contentsOf: buffer.prefix(count)); if output.last == 10 { break }
      }
      box.set(output)
    }
    let deadline = Date().addingTimeInterval(6)
    while completion.wait(timeout: .now()) != .success {
      precondition(Date() < deadline, "Socket exchange did not finish")
      RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }
    guard !box.get().isEmpty else { return nil }
    return try JSONSerialization.jsonObject(with: box.get()) as? [String: Any]
  }
  static func transport() throws {
    let directory = URL(fileURLWithPath: "/tmp/asael-update-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory); NativeUpdateStartupQuarantine.current = nil; NativeUpdateInterlock.until = nil }
    try NativeUpdateBridge.inspectDirectoryForTesting(directory)
    let link = directory.appendingPathComponent("link")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: directory)
    do { try NativeUpdateBridge.inspectDirectoryForTesting(link); preconditionFailure("Symlink directory accepted") } catch { assertions += 1 }
    let path = directory.appendingPathComponent("bridge.sock").path
    var quitCalls = 0
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let bridge = NativeUpdateBridge(provenance: provenance, canQuit: { true }, quit: { quitCalls += 1 }) { request, done in
      if NativeUpdateStartupQuarantine.current?.active == true {
        NativeUpdateBridge.inspectReadiness(request, nativeBusyReasons: { [] }, inspect: nil, completion: done)
      } else {
        var value = flutter(request.action)
        if request.action == "quiesce" {
          let expiry = Date().addingTimeInterval(25)
          NativeUpdateInterlock.nonce = request.nonce; NativeUpdateInterlock.until = expiry
          value["status"] = "quiesced"; value["quiescenceExpiresAt"] = formatter.string(from:expiry)
        }
        done(value)
      }
    }
    try bridge.startForTesting(path); defer { bridge.stop() }
    var attributes = stat(); check(lstat(path, &attributes) == 0 && attributes.st_mode & 0o777 == 0o600, "Socket not private")
    let value = try exchange(path, request()!)!
    check(value["status"] as? String == "ready", "Real owner-local socket did not return bound readiness")
    check(value["nonce"] as? String == nonce && value["pid"] as? Int == Int(getpid()), "Real socket receipt lost process/challenge binding")
    let premature = try exchange(path, request("quit")!)
    check(premature == nil && quitCalls == 0, "Quit without a measured lease was accepted")
    let lease = try exchange(path, request("quiesce")!)
    check(lease?["status"] as? String == "quiesced", "Real socket quiescence failed")
    let foreign = try exchange(path, request("quit",patch:["nonce":String(repeating:"e",count:64)])!)
    check(foreign == nil && quitCalls == 0,"Foreign challenge quit the app")
    let quit = try exchange(path, request("quit")!)
    RunLoop.current.run(until:Date().addingTimeInterval(0.02))
    check(quit?["action"] as? String == "quit" && quit?["status"] as? String == "quiesced" && quitCalls == 1,"Exact lease did not acknowledge graceful quit")
    NativeUpdateInterlock.until = Date().addingTimeInterval(-1)
    let stale = try exchange(path, request("quit")!)
    check(stale == nil && quitCalls == 1,"Expired lease quit the app")
    var ticket: [String: Any] = ["protocol":1,"nonce":nonce,"expected":expected,"publisherPid":Int(getpid()),
      "expiresAt":formatter.string(from:Date().addingTimeInterval(80))]
    NativeUpdateStartupQuarantine.current = NativeUpdateStartupQuarantine(NativeUpdateStartupTicket(data(ticket),provenance:provenance)!)
    let noEngine = try exchange(path,request("quiesce")!)
    check(noEngine?["status"] as? String == "quiesced" && noEngine?["flutterReady"] as? Bool == false,"Real socket could not attest safe no-engine rollback")
    check((noEngine?["binding"] as? [String:Any])?["ownerSha256"] is NSNull,"No-engine socket fabricated owner")
    ticket["publisherPid"] = Int(getpid()) + 1
    NativeUpdateStartupQuarantine.current = NativeUpdateStartupQuarantine(NativeUpdateStartupTicket(data(ticket),provenance:provenance)!)
    let wrongPublisher = try exchange(path,request("quiesce")!)
    check(wrongPublisher == nil,"Socket accepted a different kernel publisher PID")
    bridge.stop(); check(!FileManager.default.fileExists(atPath: path), "Owned socket was not cleaned up")
  }
  #endif
}
#if NATIVE_UPDATE_POLICY_TESTS
private final class TransportBox {
  private let lock = NSLock(); private var data = Data()
  func set(_ data: Data) { lock.lock(); defer { lock.unlock() }; self.data = data }
  func get() -> Data { lock.lock(); defer { lock.unlock() }; return data }
}
@main struct NativeUpdateBridgeTestMain {
  static func main() throws { NativeUpdateCases.contracts(); NativeUpdateCases.receipts(); NativeUpdateCases.quarantine(); try NativeUpdateCases.transport(); print("NativeUpdateBridge: contract, receipt and real private-socket cases passed") }
}
#else
final class NativeUpdateBridgeTests: XCTestCase {
  func testClosedRequestAndBundleContracts() { NativeUpdateCases.contracts() }
  func testFrameOwnerBindingAndBoundedQuiescence() { NativeUpdateCases.receipts() }
  func testBoundedStartupTicketAndRollback() { NativeUpdateCases.quarantine() }
}
#endif
