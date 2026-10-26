import Foundation
import CoreFoundation
import Darwin

/// Content-free, owner-local update protocol. This is a readiness transport,
/// never an installer, shell, credential broker, or generic navigation channel.
struct NativeUpdateRequest {
  let action: String
  let nonce: String
  let expected: [String: Any]
  static let reasons: Set<String> = [
    "build_mismatch", "owner_mismatch", "session_unavailable", "workspace_locked",
    "workspace_not_ready", "route_not_rendered", "unsaved_draft", "inspection_incomplete",
    "desktop_enabled", "desktop_busy", "capture_busy", "auxiliary_window", "voice_active",
    "conversation_busy", "host_unavailable", "request_in_progress",
  ]
  static let readinessKeys: Set<String> = [
    "protocol", "action", "nonce", "sourceSnapshotSha256", "version", "build", "ownerSha256",
    "status", "flutterReady", "authenticatedWorkspaceReady", "improvementRendered", "busyReasons", "quiescenceExpiresAt",
    "startupQuarantined", "startupDecision",
  ]
  static func matches(_ value: Any?, _ pattern: String) -> Bool {
    guard let text = value as? String else { return false }
    return text.range(of: pattern, options: .regularExpression) != nil
  }
  static func boolean(_ value: Any?) -> Bool? {
    guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
    return value.boolValue
  }
  static func integer(_ value: Any?) -> Int? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
      value.doubleValue.rounded() == value.doubleValue else { return nil }
    return value.intValue
  }
  init?(_ data: Data) {
    guard data.count <= 4096,
      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(value.keys) == ["protocol", "action", "nonce", "expected"],
      Self.integer(value["protocol"]) == 1,
      let action = value["action"] as? String, ["status", "quiesce", "commit", "quit"].contains(action),
      Self.matches(value["nonce"], "^[a-f0-9]{64}$"),
      let expected = value["expected"] as? [String: Any],
      Set(expected.keys) == ["sourceRevision", "sourceSnapshotSha256", "version", "build", "ownerSha256"],
      Self.matches(expected["sourceRevision"], "^[a-f0-9]{40}$"),
      Self.matches(expected["sourceSnapshotSha256"], "^[a-f0-9]{64}$"),
      Self.matches(expected["ownerSha256"], "^[a-f0-9]{64}$"),
      Self.matches(expected["version"], "^[0-9]+\\.[0-9]+\\.[0-9]+$"),
      let build = Self.integer(expected["build"]), build > 0, build <= 2_147_483_647
    else { return nil }
    self.action = action; nonce = value["nonce"] as! String; self.expected = expected
  }
  var json: [String: Any] { ["protocol": 1, "action": action, "nonce": nonce, "expected": expected] }
}

struct NativeUpdateProvenance {
  let value: [String: Any]
  init?(_ data: Data, version: String, build: String) {
    guard data.count <= 4096,
      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(value.keys) == ["protocol", "sourceRevision", "sourceSnapshotSha256", "version", "build"],
      NativeUpdateRequest.integer(value["protocol"]) == 1,
      NativeUpdateRequest.matches(value["sourceRevision"], "^[a-f0-9]{40}$"),
      NativeUpdateRequest.matches(value["sourceSnapshotSha256"], "^[a-f0-9]{64}$"),
      value["version"] as? String == version,
      NativeUpdateRequest.integer(value["build"]) == Int(build)
    else { return nil }
    self.value = value
  }
  static func installed() -> Self? {
    guard let url = Bundle.main.url(forResource: "asael-native-release", withExtension: "json"),
      let data = try? Data(contentsOf: url),
      let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
      let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
    else { return nil }
    return Self(data, version: version, build: build)
  }
  func matches(_ request: NativeUpdateRequest) -> Bool {
    ["sourceRevision", "sourceSnapshotSha256", "version", "build"].allSatisfy {
      String(describing: value[$0]!) == String(describing: request.expected[$0]!)
    }
  }
}

struct NativeUpdateStartupTicket {
  let request: NativeUpdateRequest
  let publisherPid: Int32
  let expiresAt: Date
  init?(_ data: Data, provenance: NativeUpdateProvenance, now: Date = Date()) {
    guard data.count <= 4096, let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(value.keys) == ["protocol", "nonce", "expected", "publisherPid", "expiresAt"],
      let pid = NativeUpdateRequest.integer(value["publisherPid"]), pid > 0 && pid <= Int(Int32.max),
      let expiryText = value["expiresAt"] as? String, let expiry = NativeUpdateBridge.parseDate(expiryText),
      expiry > now, expiry.timeIntervalSince(now) <= 90,
      let bytes = try? JSONSerialization.data(withJSONObject: ["protocol": value["protocol"] ?? NSNull(),
        "action": "status", "nonce": value["nonce"] ?? NSNull(), "expected": value["expected"] ?? NSNull()]),
      let request = NativeUpdateRequest(bytes), provenance.matches(request) else { return nil }
    self.request = request; publisherPid = Int32(pid); expiresAt = expiry
  }
  func accepts(_ request: NativeUpdateRequest, peerPid: Int32) -> Bool {
    publisherPid == peerPid && self.request.nonce == request.nonce &&
      NSDictionary(dictionary: self.request.expected).isEqual(to: request.expected)
  }
}

/// Only the fixed validated local ticket can quarantine a newly launched app.
/// The UI is released after a bounded timeout; expiry is never a successful commit.
final class NativeUpdateStartupQuarantine {
  static var current: NativeUpdateStartupQuarantine?
  let ticket: NativeUpdateStartupTicket
  private let deadline: TimeInterval
  private var recordedDecision = "pending"
  var decision: String {
    if recordedDecision == "pending" && ProcessInfo.processInfo.systemUptime >= deadline { recordedDecision = "expired" }
    return recordedDecision
  }
  var active: Bool { decision == "pending" }
  init(_ ticket: NativeUpdateStartupTicket) {
    self.ticket = ticket; deadline = ProcessInfo.processInfo.systemUptime + min(90, max(0, ticket.expiresAt.timeIntervalSinceNow))
  }
  func commit(_ nonce: String) -> Bool {
    guard active, ticket.request.nonce == nonce else { return false }
    recordedDecision = "committed"; return true
  }
  func commit(_ request: NativeUpdateRequest, flutter: [String: Any]) -> Bool {
    guard request.action == "commit", Set(flutter.keys) == NativeUpdateRequest.readinessKeys,
      NativeUpdateRequest.integer(flutter["protocol"]) == 1,
      flutter["action"] as? String == "commit", flutter["nonce"] as? String == request.nonce,
      flutter["sourceSnapshotSha256"] as? String == ticket.request.expected["sourceSnapshotSha256"] as? String,
      flutter["version"] as? String == ticket.request.expected["version"] as? String,
      NativeUpdateRequest.integer(flutter["build"]) == NativeUpdateRequest.integer(ticket.request.expected["build"]),
      flutter["ownerSha256"] as? String == ticket.request.expected["ownerSha256"] as? String,
      flutter["status"] as? String == "ready", flutter["quiescenceExpiresAt"] is NSNull,
      ["flutterReady", "authenticatedWorkspaceReady", "improvementRendered"].allSatisfy({ NativeUpdateRequest.boolean(flutter[$0]) == true }),
      NativeUpdateRequest.boolean(flutter["startupQuarantined"]) == false, flutter["startupDecision"] as? String == "committed",
      (flutter["busyReasons"] as? [String])?.isEmpty == true,
      NSDictionary(dictionary: ticket.request.expected).isEqual(to: request.expected) else { return false }
    return commit(request.nonce)
  }
  /// Safe-to-revert evidence only. The fixed ticket admitted no editing or
  /// business work before the engine started; no Flutter readiness is invented.
  func rollbackWithoutFlutter(_ request: NativeUpdateRequest, nativeBusyReasons: [String]) -> [String: Any]? {
    guard active, request.action == "quiesce", nativeBusyReasons.isEmpty,
      ticket.request.nonce == request.nonce,
      NSDictionary(dictionary: ticket.request.expected).isEqual(to: request.expected) else { return nil }
    let expiry = min(ticket.expiresAt, Date().addingTimeInterval(30))
    guard expiry > Date() else { return nil }
    return ["protocol": 1, "action": request.action, "nonce": request.nonce,
      "sourceSnapshotSha256": ticket.request.expected["sourceSnapshotSha256"]!,
      "version": ticket.request.expected["version"]!, "build": ticket.request.expected["build"]!,
      "ownerSha256": NSNull(), "status": "quiesced", "flutterReady": false,
      "authenticatedWorkspaceReady": false, "improvementRendered": false,
      "busyReasons": [String](), "quiescenceExpiresAt": ISO8601DateFormatter.fractional.string(from: expiry),
      "startupQuarantined": true, "startupDecision": "pending"]
  }
  var dartArgument: String { "--asael-update-quarantine=\(ticket.request.nonce):\(Int64(ticket.expiresAt.timeIntervalSince1970 * 1000))" }
  static func prepare(arguments: [String]) {
    guard current == nil, arguments.contains("--asael-update-canary"), let provenance = NativeUpdateProvenance.installed() else { return }
    let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Asael/native-publisher", isDirectory: true)
    var directoryStat = stat()
    guard lstat(directory.path, &directoryStat) == 0, directoryStat.st_uid == geteuid(),
      directoryStat.st_mode & S_IFMT == S_IFDIR, directoryStat.st_mode & 0o777 == 0o700 else { return }
    let fd = open(directory.appendingPathComponent("startup-ticket.json").path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { return }; defer { close(fd) }
    var metadata = stat()
    guard fstat(fd, &metadata) == 0, metadata.st_uid == geteuid(), metadata.st_mode & S_IFMT == S_IFREG,
      metadata.st_mode & 0o777 == 0o600, metadata.st_size > 0, metadata.st_size <= 4096 else { return }
    var bytes = [UInt8](repeating: 0, count: 4097), count = 0
    count = read(fd, &bytes, bytes.count)
    guard count == metadata.st_size, let ticket = NativeUpdateStartupTicket(Data(bytes.prefix(count)), provenance: provenance) else { return }
    current = NativeUpdateStartupQuarantine(ticket)
  }
}

final class NativeUpdateBridge {
  typealias Handler = (NativeUpdateRequest, @escaping ([String: Any]) -> Void) -> Void
  private let provenance: NativeUpdateProvenance
  private let handler: Handler
  private let canQuit: () -> Bool
  private let quit: () -> Void
  private var quitLease: (request: NativeUpdateRequest, peerPid: Int32, expiresAt: Date, reply: [String: Any])?
  private let queue = DispatchQueue(label: "app.asael.native-update-socket", qos: .utility)
  private var source: DispatchSourceRead?
  private var descriptor: Int32 = -1
  private var socketPath: String?
  private var socketInode: ino_t?

  init(provenance: NativeUpdateProvenance, canQuit: @escaping () -> Bool = { false },
    quit: @escaping () -> Void = {}, handler: @escaping Handler) {
    self.provenance = provenance; self.handler = handler; self.canQuit = canQuit; self.quit = quit
  }
  deinit { stop() }

  /// Main-thread Flutter calls are bounded below the socket timeout. Only an
  /// intact startup quarantine permits rollback when the engine cannot answer.
  static func inspectReadiness(_ request: NativeUpdateRequest,
    nativeBusyReasons: @escaping () -> [String],
    inspect: ((@escaping ([String: Any]) -> Void) -> Void)?,
    completion: @escaping ([String: Any]) -> Void) {
    precondition(Thread.isMainThread)
    func fallback() -> [String: Any] {
      NativeUpdateStartupQuarantine.current?.rollbackWithoutFlutter(request, nativeBusyReasons: nativeBusyReasons()) ?? [:]
    }
    guard let inspect else { completion(fallback()); return }
    var completed = false
    func finish(_ value: [String: Any]) {
      guard !completed else { return }; completed = true; completion(value)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { finish(fallback()) }
    inspect { value in finish(value) }
  }

  func start() throws {
    let support = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/Asael", isDirectory: true)
    let directory = support.appendingPathComponent("native-publisher", isDirectory: true)
    try Self.privateDirectory(support, strict: false)
    try Self.privateDirectory(directory, strict: true)
    try listen(path: directory.appendingPathComponent("bridge.sock").path)
  }

  #if NATIVE_UPDATE_POLICY_TESTS
  func startForTesting(_ path: String) throws { try listen(path: path) }
  static func inspectDirectoryForTesting(_ url: URL) throws { try privateDirectory(url, strict: true) }
  #endif

  private static func privateDirectory(_ url: URL, strict: Bool) throws {
    if !FileManager.default.fileExists(atPath: url.path) {
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700])
    }
    var metadata = stat()
    guard lstat(url.path, &metadata) == 0, metadata.st_uid == geteuid(),
      metadata.st_mode & S_IFMT == S_IFDIR,
      strict ? metadata.st_mode & 0o777 == 0o700 : metadata.st_mode & 0o022 == 0
    else { throw NSError(domain: "AsaelUpdate", code: 1) }
  }

  private func listen(path: String) throws {
    var address = sockaddr_un()
    let bytes = Array(path.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
      throw NSError(domain: "AsaelUpdate", code: 2)
    }
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    var old = stat()
    if lstat(path, &old) == 0 {
      guard old.st_uid == geteuid(), old.st_mode & S_IFMT == S_IFSOCK else {
        throw NSError(domain: "AsaelUpdate", code: 3)
      }
      let probe = socket(AF_UNIX, SOCK_STREAM, 0)
      guard probe >= 0 else { throw NSError(domain: "AsaelUpdate", code: 4) }
      let connected = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
      }
      let failure = errno
      close(probe)
      guard connected != 0 && failure == ECONNREFUSED else { throw NSError(domain: "AsaelUpdate", code: 5) }
      guard unlink(path) == 0 else { throw NSError(domain: "AsaelUpdate", code: 6) }
    }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw NSError(domain: "AsaelUpdate", code: 7) }
    let bound = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard bound == 0, chmod(path, 0o600) == 0, Darwin.listen(fd, 4) == 0 else {
      close(fd); throw NSError(domain: "AsaelUpdate", code: 8)
    }
    var metadata = stat()
    guard lstat(path, &metadata) == 0 else { close(fd); throw NSError(domain: "AsaelUpdate", code: 9) }
    descriptor = fd; socketPath = path; socketInode = metadata.st_ino
    let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
    source.setEventHandler { [weak self] in self?.acceptOne() }
    self.source = source; source.resume()
  }

  func stop() {
    source?.cancel(); source = nil
    if descriptor >= 0 { close(descriptor); descriptor = -1 }
    if let path = socketPath, let inode = socketInode {
      var metadata = stat()
      if lstat(path, &metadata) == 0 && metadata.st_ino == inode && metadata.st_uid == geteuid() {
        _ = unlink(path)
      }
    }
    socketPath = nil; socketInode = nil
  }

  private func acceptOne() {
    let client = accept(descriptor, nil, nil)
    guard client >= 0 else { return }
    defer { close(client) }
    var uid: uid_t = 0, gid: gid_t = 0
    guard getpeereid(client, &uid, &gid) == 0, uid == geteuid() else { return }
    var timeout = timeval(tv_sec: 3, tv_usec: 0), noSignal: Int32 = 1
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    var data = Data(), bytes = [UInt8](repeating: 0, count: 1024)
    while data.count <= 4096 {
      let count = recv(client, &bytes, bytes.count, 0)
      guard count > 0 else { return }
      data.append(contentsOf: bytes.prefix(count))
      if data.contains(10) { break }
    }
    guard data.last == 10, data.dropLast().contains(10) == false,
      let request = NativeUpdateRequest(data.dropLast()) else { return }
    var peerPid: Int32 = 0, peerSize = socklen_t(MemoryLayout<Int32>.size)
    let peerPidKnown = getsockopt(client, SOL_LOCAL, LOCAL_PEERPID, &peerPid, &peerSize) == 0
    let accepted = DispatchQueue.main.sync {
      if request.action == "quit" { return peerPidKnown && self.quitReply(request, peerPid: peerPid) != nil }
      if NativeUpdateStartupQuarantine.current?.active == true || request.action == "commit" {
        guard peerPidKnown, let startup = NativeUpdateStartupQuarantine.current, startup.active else { return false }
        return startup.ticket.accepts(request, peerPid: peerPid)
      }
      return true
    }
    guard accepted else { return }
    let semaphore = DispatchSemaphore(value: 0)
    let result = NativeUpdateReplyBox()
    DispatchQueue.main.async { [weak self] in
      guard let self else { semaphore.signal(); return }
      if request.action == "quit" {
        if let reply = self.quitReply(request, peerPid: peerPid) { result.set(reply) }
        semaphore.signal(); return
      }
      if !self.provenance.matches(request) {
        result.set(self.reply(request, flutter: nil, extra: ["build_mismatch"]))
        semaphore.signal(); return
      }
      self.handler(request) { flutter in
        let reply = self.reply(request, flutter: flutter, extra: [])
        if request.action == "quiesce", peerPidKnown, reply["status"] as? String == "quiesced",
          let expiryText = reply["quiescenceExpiresAt"] as? String, let expiry = Self.parseDate(expiryText) {
          self.quitLease = (request, peerPid, expiry, reply)
        }
        result.set(reply); semaphore.signal()
      }
    }
    guard semaphore.wait(timeout: .now() + 4) == .success,
      let reply = result.get(), var encoded = try? JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys]),
      encoded.count <= 4096 else { return }
    encoded.append(10)
    let sentAll = encoded.withUnsafeBytes { raw -> Bool in
      guard let base = raw.baseAddress else { return false }
      var offset = 0
      while offset < raw.count {
        let sent = send(client, base.advanced(by: offset), raw.count - offset, 0)
        if sent <= 0 { return false }; offset += sent
      }
      return true
    }
    if sentAll && request.action == "quit" {
      DispatchQueue.main.async { [weak self] in
        guard let self, self.quitReply(request, peerPid: peerPid) != nil else { return }
        self.quit()
      }
    }
  }

  private func quitReply(_ request: NativeUpdateRequest, peerPid: Int32) -> [String: Any]? {
    guard let lease = quitLease, lease.expiresAt.timeIntervalSinceNow > 5,
      lease.peerPid == peerPid, lease.request.nonce == request.nonce,
      NSDictionary(dictionary: lease.request.expected).isEqual(to: request.expected),
      NativeUpdateInterlock.active, canQuit() else { return nil }
    var reply = lease.reply; reply["action"] = "quit"; return reply
  }

  func reply(_ request: NativeUpdateRequest, flutter: [String: Any]?, extra: [String]) -> [String: Any] {
    var reasons = Set(extra)
    let shapeValid = flutter.map { Set($0.keys) == NativeUpdateRequest.readinessKeys } == true && NativeUpdateRequest.integer(flutter?["protocol"]) == 1
    let bindingMatches = shapeValid && flutter?["nonce"] as? String == request.nonce &&
      flutter?["action"] as? String == request.action &&
      flutter?["sourceSnapshotSha256"] as? String == provenance.value["sourceSnapshotSha256"] as? String &&
      flutter?["version"] as? String == provenance.value["version"] as? String &&
      NativeUpdateRequest.integer(flutter?["build"]) == NativeUpdateRequest.integer(provenance.value["build"])
    let declared = flutter?["busyReasons"] as? [String]
    if !bindingMatches || declared == nil || !(declared ?? []).allSatisfy(NativeUpdateRequest.reasons.contains) { reasons.insert("host_unavailable") }
    reasons.formUnion(declared?.filter(NativeUpdateRequest.reasons.contains) ?? [])
    let owner = bindingMatches && NativeUpdateRequest.matches(flutter?["ownerSha256"], "^[a-f0-9]{64}$")
      ? flutter?["ownerSha256"] as? String : nil
    let authenticated = bindingMatches && NativeUpdateRequest.boolean(flutter?["authenticatedWorkspaceReady"]) == true && owner == request.expected["ownerSha256"] as? String
    let rendered = bindingMatches && NativeUpdateRequest.boolean(flutter?["improvementRendered"]) == true
    let expiry = flutter?["quiescenceExpiresAt"] as? String
    let expiryDate = expiry.flatMap { NativeUpdateBridge.parseDate($0) }
    let validLease = expiryDate.map { $0 > Date() && $0.timeIntervalSinceNow <= 31 } == true
    let fatalReasons: Set<String> = ["host_unavailable", "build_mismatch", "owner_mismatch",
      "session_unavailable", "workspace_locked", "workspace_not_ready", "route_not_rendered", "inspection_incomplete"]
    let startup = NativeUpdateStartupQuarantine.current
    let quarantined = startup?.active == true
    let startupProved = quarantined && startup?.ticket.request.nonce == request.nonce && bindingMatches &&
      NativeUpdateRequest.boolean(flutter?["startupQuarantined"]) == true && flutter?["startupDecision"] as? String == "pending"
    if quarantined && !startupProved { reasons.insert("host_unavailable") }
    let workRisks = reasons.subtracting(["owner_mismatch", "session_unavailable", "workspace_locked", "workspace_not_ready", "route_not_rendered"])
    let quarantineLease = startupProved && request.action == "quiesce" && workRisks.isEmpty && validLease &&
      expiryDate! <= startup!.ticket.expiresAt && flutter?["status"] as? String == "quiesced"
    let status: String = quarantineLease || (authenticated && rendered && reasons.isEmpty && validLease && flutter?["status"] as? String == "quiesced")
      ? "quiesced" : authenticated && rendered && reasons.isDisjoint(with: fatalReasons) && ["status", "commit"].contains(request.action) && flutter?["status"] as? String == "ready" ? "ready" : "held"
    var binding = provenance.value; binding.removeValue(forKey: "protocol"); binding["ownerSha256"] = owner ?? NSNull()
    return ["protocol": 1, "action": request.action, "nonce": request.nonce, "binding": binding,
      "pid": Int(getpid()), "status": status,
      "startupQuarantined": quarantined, "startupDecision": startup?.decision ?? "none",
      "quarantineExpiresAt": quarantined ? ISO8601DateFormatter.fractional.string(from: startup!.ticket.expiresAt) : NSNull(),
      "flutterReady": bindingMatches && NativeUpdateRequest.boolean(flutter?["flutterReady"]) == true,
      "authenticatedWorkspaceReady": authenticated, "improvementRendered": rendered,
      "busyReasons": (quarantineLease ? workRisks : reasons).sorted(), "quiescenceExpiresAt": status == "quiesced" ? expiry! : NSNull()]
  }
  static func parseDate(_ value: String) -> Date? {
    let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return parser.date(from: value)
  }
}

private final class NativeUpdateReplyBox {
  private let lock = NSLock()
  private var value: [String: Any]?
  func set(_ value: [String: Any]) { lock.lock(); defer { lock.unlock() }; self.value = value }
  func get() -> [String: Any]? { lock.lock(); defer { lock.unlock() }; return value }
}

/// Main-queue-only admission gate, automatically expiring after an interrupted handoff.
enum NativeUpdateInterlock {
  static var until: Date? {
    didSet { deadline = until.map { ProcessInfo.processInfo.systemUptime + min(31, max(0, $0.timeIntervalSinceNow)) } }
  }
  private static var deadline: TimeInterval?
  static var nonce: String?
  static var active: Bool { (deadline.map { $0 > ProcessInfo.processInfo.systemUptime } ?? false) || NativeUpdateStartupQuarantine.current?.active == true }
}

private extension ISO8601DateFormatter {
  static var fractional: ISO8601DateFormatter { let value = ISO8601DateFormatter(); value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return value }
}
