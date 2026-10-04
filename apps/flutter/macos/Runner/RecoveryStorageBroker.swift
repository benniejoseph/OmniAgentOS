import CryptoKit
import CoreFoundation
import Darwin
import Foundation

enum RecoveryStorageFailure: String, Error {
  case invalid = "recovery_invalid"
  case conflict = "recovery_conflict"
  case capacity = "recovery_capacity"
  case unavailable = "recovery_unavailable"
  case unknown = "recovery_unknown"
  case retained = "recovery_retained"
}

enum RecoveryStorageCommitPhase: Equatable { case beforeRename, afterRename, afterDelete }

struct CaptureStorageRequest {
  let method: String
  let secretId: String
  let entryId: String
  let ciphertext: String?
  let expectedHash: String?
  let expectedBytes: Int?
  let mode: String?
  static let maximumBytes = 64 * 1024 * 1024
  var identity: [String: Any] {
    ["schemaVersion": 1, "namespace": "capture", "secretId": secretId, "entryId": entryId]
  }
  init(method: String, arguments: Any?) throws {
    let base: Set<String> = ["schemaVersion", "namespace", "secretId", "entryId"]
    let fields = method == "appendCapture" ? base.union(["ciphertext"]) :
      method == "deleteCapture" ? base.union(["expectedSha256", "expectedBytes", "mode"]) : base
    guard ["readCapture", "appendCapture", "deleteCapture"].contains(method),
          let value = arguments as? [String: Any], Set(value.keys) == fields,
          let version = value["schemaVersion"] as? NSNumber,
          CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
          value["namespace"] as? String == "capture",
          let secretId = value["secretId"] as? String,
          let entryId = value["entryId"] as? String,
          [secretId, entryId].allSatisfy({ RecoveryStorageRequest.matches($0, "^[A-Za-z0-9_-]{24}$") })
    else { throw RecoveryStorageFailure.invalid }
    self.method = method; self.secretId = secretId; self.entryId = entryId
    if method == "appendCapture" {
      guard let content = value["ciphertext"] as? String, !content.isEmpty,
            content.utf8.count <= Self.maximumBytes,
            Self.matchesMode(content, id: entryId, mode: "schema3")
      else { throw RecoveryStorageFailure.invalid }
      ciphertext = content
    } else { ciphertext = nil }
    if method == "deleteCapture" {
      guard let hash = value["expectedSha256"] as? String,
            RecoveryStorageRequest.matches(hash, "^[a-f0-9]{64}$"),
            let bytes = value["expectedBytes"] as? NSNumber,
            CFGetTypeID(bytes) != CFBooleanGetTypeID(), bytes.doubleValue == Double(bytes.intValue),
            bytes.intValue > 0, bytes.intValue <= Self.maximumBytes,
            let mode = value["mode"] as? String, ["legacy", "schema3"].contains(mode)
      else { throw RecoveryStorageFailure.invalid }
      expectedHash = hash; expectedBytes = bytes.intValue; self.mode = mode
    } else { expectedHash = nil; expectedBytes = nil; mode = nil }
  }

  static func matchesMode(_ content: String, id: String, mode: String) -> Bool {
    let parts = content.components(separatedBy: "\n")
    guard parts.count == 1 || parts.count == 2 else { return false }
    var version: Int?
    for (index, part) in parts.enumerated() {
      guard let value = (try? JSONSerialization.jsonObject(with: Data(part.utf8))) as? [String: Any],
            let schema = value["schemaVersion"] as? NSNumber,
            CFGetTypeID(schema) != CFBooleanGetTypeID(), schema.doubleValue == Double(schema.intValue),
            value["id"] as? String == id, value["algorithm"] as? String == "aes-256-gcm"
      else { return false }
      if version == nil { version = schema.intValue }
      guard version == schema.intValue,
            mode == "schema3" ? version == 3 : (version == 1 || version == 2)
      else { return false }
      if version == 1 {
        guard parts.count == 1, value["record"] == nil else { return false }
      } else {
        guard parts.count == 2, value["record"] as? String == (index == 0 ? "metadata" : "payload") else { return false }
      }
    }
    return true
  }
}

struct RecoveryStorageRequest {
  let namespace: String
  let secretId: String
  let recordKey: String
  let expected: String?
  let ciphertext: String?
  let writing: Bool
  var maximumRecords: Int { namespace == "markets" ? 12 : ["memory", "accounts"].contains(namespace) ? 16 : namespace == "specialist" ? 32 : namespace == "responsibility" ? 64 : 128 }
  var maximumBytes: Int { Self.maximumBytes(for: namespace) }
  private static func maximumBytes(for namespace: String) -> Int {
    namespace == "markets" ? 262_144 : ["accounts", "specialist"].contains(namespace) ? 1_048_576 : namespace == "memory" ? 8_388_608 : namespace == "builder" ? 8_000_000 : 4_000_000
  }
  var directoryName: String { namespace == "meetings" ? "asael-meeting-drafts-v1" : namespace == "memory" ? "asael-memory-submissions-v1" : "asael-\(namespace)-recovery-v1" }
  var fileExtension: String { namespace == "meetings" ? "meeting" : namespace }
  var identity: [String: Any] {
    ["schemaVersion": 1, "namespace": namespace, "secretId": secretId, "recordKey": recordKey]
  }

  init(method: String, arguments: Any?) throws {
    guard method == "read" || method == "compareAndSwap",
          let arguments = arguments as? [String: Any],
          let version = arguments["schemaVersion"] as? NSNumber,
          CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
          let namespace = arguments["namespace"] as? String,
          ["responsibility", "builder", "meetings", "markets", "accounts", "specialist", "memory"].contains(namespace),
          let secretId = arguments["secretId"] as? String,
          Self.matches(secretId, "^[A-Za-z0-9_-]{24}$"),
          let recordKey = arguments["recordKey"] as? String,
          Self.matches(recordKey, "^[a-f0-9]{64}$")
    else { throw RecoveryStorageFailure.invalid }
    writing = method == "compareAndSwap"
    let fields: Set<String> = writing
      ? ["schemaVersion", "namespace", "secretId", "recordKey", "expectedSha256", "ciphertext"]
      : ["schemaVersion", "namespace", "secretId", "recordKey"]
    guard Set(arguments.keys) == fields else { throw RecoveryStorageFailure.invalid }
    self.namespace = namespace
    self.secretId = secretId
    self.recordKey = recordKey
    if writing {
      if arguments["expectedSha256"] is NSNull { expected = nil }
      else if let value = arguments["expectedSha256"] as? String,
              Self.matches(value, "^[a-f0-9]{64}$") { expected = value }
      else { throw RecoveryStorageFailure.invalid }
      guard let content = arguments["ciphertext"] as? String, !content.isEmpty,
            content.utf8.count <= Self.maximumBytes(for: namespace)
      else { throw RecoveryStorageFailure.invalid }
      ciphertext = content
    } else {
      expected = nil
      ciphertext = nil
    }
  }

  static func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) == value.startIndex..<value.endIndex
  }
}

/// One complete synchronous transaction per queue job, shared by all engines
/// and store instances. There are no leases for a Dart isolate to abandon.
final class RecoveryStorageTransactionStore {
  private static let queue = DispatchQueue(label: "app.omniagent.omniagent.recovery-transactions", qos: .utility)
  private let applicationSupport: () throws -> URL
  private let commitPhase: ((RecoveryStorageCommitPhase) throws -> Void)?

  init(applicationSupport: @escaping () throws -> URL = {
    guard let bundle = Bundle.main.bundleIdentifier else { throw RecoveryStorageFailure.unavailable }
    return try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true).appendingPathComponent(bundle, isDirectory: true)
  }, commitPhase: ((RecoveryStorageCommitPhase) throws -> Void)? = nil) {
    self.applicationSupport = applicationSupport
    self.commitPhase = commitPhase
  }

  static func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  func execute(method: String, arguments: Any?) throws -> [String: Any] {
    if ["readCapture", "appendCapture", "deleteCapture"].contains(method) {
      let request = try CaptureStorageRequest(method: method, arguments: arguments)
      return try Self.queue.sync {
        do { return try transactCapture(request) }
        catch let failure as RecoveryStorageFailure { throw failure }
        catch { throw request.method == "readCapture" ? RecoveryStorageFailure.unavailable : RecoveryStorageFailure.unknown }
      }
    }
    let request = try RecoveryStorageRequest(method: method, arguments: arguments)
    return try Self.queue.sync {
      do { return try transact(request) }
      catch let failure as RecoveryStorageFailure { throw failure }
      catch { throw request.writing ? RecoveryStorageFailure.unknown : RecoveryStorageFailure.unavailable }
    }
  }

  private func directory(_ url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    var metadata = stat()
    guard lstat(url.path, &metadata) == 0,
          metadata.st_mode & S_IFMT == S_IFDIR else { throw RecoveryStorageFailure.unavailable }
  }

  private func transact(_ request: RecoveryStorageRequest) throws -> [String: Any] {
    let support = try applicationSupport()
    try directory(support)
    let namespace = support.appendingPathComponent(request.directoryName, isDirectory: true)
    try directory(namespace)
    let root = namespace.appendingPathComponent(request.secretId, isDirectory: true)
    try directory(root)
    let lock = open(root.appendingPathComponent(".transaction.lock").path,
      O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard lock >= 0 else { throw RecoveryStorageFailure.unavailable }
    defer { _ = close(lock) }
    var lockMetadata = stat()
    guard fstat(lock, &lockMetadata) == 0, lockMetadata.st_mode & S_IFMT == S_IFREG,
          flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw RecoveryStorageFailure.unavailable }
    defer { _ = flock(lock, LOCK_UN) }
    let destination = root.appendingPathComponent("\(request.recordKey).\(request.fileExtension)")
    let current = try read(destination, maximum: request.maximumBytes)
    let currentDigest = current.map(Self.digest)
    if !request.writing {
      var response = request.identity
      response["status"] = "read"
      if let current {
        guard let content = String(data: current, encoding: .utf8) else { throw RecoveryStorageFailure.unavailable }
        response["ciphertext"] = content
        response["sha256"] = currentDigest
      } else {
        response["ciphertext"] = NSNull()
        response["sha256"] = NSNull()
      }
      return response
    }
    guard currentDigest == request.expected else { throw RecoveryStorageFailure.conflict }
    let files = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
    if current == nil {
      let count = files.lazy.filter { $0.lastPathComponent.hasSuffix(".\(request.fileExtension)") }.prefix(request.maximumRecords).count
      guard count < request.maximumRecords else { throw RecoveryStorageFailure.capacity }
    }
    // Only this broker's abandoned encrypted staging files may be removed,
    // and only while no live transaction can hold the root kernel lock.
    for file in files where RecoveryStorageRequest.matches(file.lastPathComponent, "^\\.stage-[a-f0-9-]{36}\\.tmp$") {
      try removeAbandonedStage(file)
    }
    guard let ciphertext = request.ciphertext else { throw RecoveryStorageFailure.invalid }
    let bytes = Data(ciphertext.utf8)
    let temporary = root.appendingPathComponent(".stage-\(UUID().uuidString.lowercased()).tmp")
    let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw RecoveryStorageFailure.unknown }
    var renamed = false
    defer {
      _ = close(fd)
      if !renamed { _ = unlink(temporary.path) }
    }
    do {
      try bytes.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { throw RecoveryStorageFailure.unknown }
        var offset = 0
        while offset < bytes.count {
          let amount = Darwin.write(fd, base.advanced(by: offset), bytes.count - offset)
          if amount < 0 && errno == EINTR { continue }
          guard amount > 0 else { throw RecoveryStorageFailure.unknown }
          offset += amount
        }
      }
      guard fsync(fd) == 0 else { throw RecoveryStorageFailure.unknown }
      try commitPhase?(.beforeRename)
      guard rename(temporary.path, destination.path) == 0 else { throw RecoveryStorageFailure.unknown }
      renamed = true
      let rootFD = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard rootFD >= 0 else { throw RecoveryStorageFailure.unknown }
      defer { _ = close(rootFD) }
      guard fsync(rootFD) == 0 else { throw RecoveryStorageFailure.unknown }
      try commitPhase?(.afterRename)
    } catch { throw RecoveryStorageFailure.unknown }
    var response = request.identity
    response["status"] = "committed"
    response["sha256"] = Self.digest(bytes)
    return response
  }

  private func read(_ url: URL, maximum: Int) throws -> Data? {
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    if fd < 0 && errno == ENOENT { return nil }
    guard fd >= 0 else { throw RecoveryStorageFailure.unavailable }
    defer { _ = close(fd) }
    var metadata = stat()
    guard fstat(fd, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG,
          metadata.st_size > 0, metadata.st_size <= Int64(maximum) else { throw RecoveryStorageFailure.unavailable }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
      let amount = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
      if amount < 0 && errno == EINTR { continue }
      guard amount >= 0 else { throw RecoveryStorageFailure.unavailable }
      if amount == 0 { return result }
      guard result.count + amount <= maximum else { throw RecoveryStorageFailure.unavailable }
      result.append(contentsOf: buffer.prefix(amount))
    }
  }

  private func transactCapture(_ request: CaptureStorageRequest) throws -> [String: Any] {
    let support = try applicationSupport()
    try directory(support)
    let namespace = support.appendingPathComponent("asael-capture-outbox-v1", isDirectory: true)
    try directory(namespace)
    let root = namespace.appendingPathComponent(request.secretId, isDirectory: true)
    try directory(root)
    let lock = open(root.appendingPathComponent(".transaction.lock").path,
      O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard lock >= 0 else { throw RecoveryStorageFailure.unavailable }
    defer { _ = close(lock) }
    var lockMetadata = stat()
    guard fstat(lock, &lockMetadata) == 0, lockMetadata.st_mode & S_IFMT == S_IFREG,
          flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw RecoveryStorageFailure.unavailable }
    defer { _ = flock(lock, LOCK_UN) }
    let keys: [URLResourceKey] = [.isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey]
    var enumerationFailed = false
    guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys,
      errorHandler: { _, _ in enumerationFailed = true; return false }) else { throw RecoveryStorageFailure.unavailable }
    var files: [(URL, Int)] = [], inspected = 0
    for case let file as URL in enumerator {
      inspected += 1
      guard inspected <= 4096 else { throw RecoveryStorageFailure.unavailable }
      let values = try file.resourceValues(forKeys: Set(keys))
      guard values.isSymbolicLink != true else { throw RecoveryStorageFailure.unavailable }
      if file.lastPathComponent.hasSuffix(".capture") {
        guard values.isRegularFile == true, let bytes = values.fileSize, bytes >= 0 else { throw RecoveryStorageFailure.unavailable }
        files.append((file, bytes))
      }
    }
    guard !enumerationFailed else { throw RecoveryStorageFailure.unavailable }
    let matches = files.filter { $0.0.lastPathComponent == "\(request.entryId).capture" }
    guard matches.count <= 1 else { throw RecoveryStorageFailure.conflict }
    let current = try matches.first.flatMap { try read($0.0, maximum: CaptureStorageRequest.maximumBytes) }
    var response = request.identity
    if request.method == "readCapture" {
      response["status"] = "read"
      if let current {
        guard let content = String(data: current, encoding: .utf8) else { throw RecoveryStorageFailure.unavailable }
        response["ciphertext"] = content; response["sha256"] = Self.digest(current)
      } else { response["ciphertext"] = NSNull(); response["sha256"] = NSNull() }
      return response
    }
    if request.method == "deleteCapture" {
      response["status"] = "deleted"
      guard let current, let file = matches.first?.0 else { response["deleted"] = false; return response }
      guard current.count == request.expectedBytes, Self.digest(current) == request.expectedHash,
            let content = String(data: current, encoding: .utf8),
            CaptureStorageRequest.matchesMode(content, id: request.entryId, mode: request.mode ?? "")
      else { throw RecoveryStorageFailure.conflict }
      // A failed unlink leaves this exact locked entry intact. Once unlink
      // succeeds, fsync or response loss has an unknown outcome to the client.
      guard unlink(file.path) == 0 else { throw RecoveryStorageFailure.retained }
      do {
        try syncDirectory(file.deletingLastPathComponent())
        try commitPhase?(.afterDelete)
      } catch { throw RecoveryStorageFailure.unknown }
      response["deleted"] = true
      return response
    }
    guard current == nil, matches.isEmpty else { throw RecoveryStorageFailure.conflict }
    guard let ciphertext = request.ciphertext else { throw RecoveryStorageFailure.invalid }
    let bytes = Data(ciphertext.utf8)
    var total = 0
    for (_, size) in files {
      guard size <= CaptureStorageRequest.maximumBytes - total else { throw RecoveryStorageFailure.capacity }
      total += size
    }
    guard files.count < 25, bytes.count <= CaptureStorageRequest.maximumBytes - total else { throw RecoveryStorageFailure.capacity }
    // Reclaim only broker-owned staging files under this root lock. No
    // .capture file, including legacy quarantine, is pruned for capacity.
    for file in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
      where RecoveryStorageRequest.matches(file.lastPathComponent, "^\\.stage-[a-f0-9-]{36}\\.tmp$") {
      try removeAbandonedStage(file)
    }
    let temporary = root.appendingPathComponent(".stage-\(UUID().uuidString.lowercased()).tmp")
    let destination = root.appendingPathComponent("\(request.entryId).capture")
    let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw RecoveryStorageFailure.unknown }
    defer { _ = close(fd); _ = unlink(temporary.path) }
    do {
      try bytes.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { throw RecoveryStorageFailure.unknown }
        var offset = 0
        while offset < bytes.count {
          let count = Darwin.write(fd, base.advanced(by: offset), bytes.count - offset)
          if count < 0 && errno == EINTR { continue }
          guard count > 0 else { throw RecoveryStorageFailure.unknown }
          offset += count
        }
      }
      guard fsync(fd) == 0 else { throw RecoveryStorageFailure.unknown }
      try commitPhase?(.beforeRename)
      // link is atomic and refuses replacement, including an unexpected file
      // created outside the cooperating broker between scan and publication.
      guard link(temporary.path, destination.path) == 0 else { throw RecoveryStorageFailure.unknown }
      guard unlink(temporary.path) == 0 else { throw RecoveryStorageFailure.unknown }
      try syncDirectory(root)
      try commitPhase?(.afterRename)
    } catch { throw RecoveryStorageFailure.unknown }
    response["status"] = "appended"; response["sha256"] = Self.digest(bytes)
    return response
  }

  private func syncDirectory(_ url: URL) throws {
    let fd = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw RecoveryStorageFailure.unknown }
    defer { _ = close(fd) }
    guard fsync(fd) == 0 else { throw RecoveryStorageFailure.unknown }
  }

  private func removeAbandonedStage(_ url: URL) throws {
    var metadata = stat()
    guard lstat(url.path, &metadata) == 0 else { throw RecoveryStorageFailure.unavailable }
    // A name never authorizes recursive deletion or following a link. Leave
    // unexpected directories intact, including any quarantined entries inside.
    guard metadata.st_mode & S_IFMT == S_IFREG else { return }
    guard unlink(url.path) == 0 else { throw RecoveryStorageFailure.unavailable }
  }
}

#if canImport(FlutterMacOS)
import FlutterMacOS

final class RecoveryStorageBrokerController {
  private let store = RecoveryStorageTransactionStore()
  private let queue = DispatchQueue(label: "app.omniagent.omniagent.recovery-bridge", qos: .utility)
  private var channels: [ObjectIdentifier: FlutterMethodChannel] = [:]

  func attach(to messenger: FlutterBinaryMessenger) -> FlutterMethodChannel {
    dispatchPrecondition(condition: .onQueue(.main))
    let channel = FlutterMethodChannel(name: "app.omniagent.omniagent/recovery-storage", binaryMessenger: messenger)
    let identity = ObjectIdentifier(channel)
    channels[identity] = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { result(FlutterError(code: "recovery_unavailable", message: nil, details: nil)); return }
      self.queue.async {
        let response: Any
        do { response = try self.store.execute(method: call.method, arguments: call.arguments) }
        catch let failure as RecoveryStorageFailure {
          response = FlutterError(code: failure.rawValue, message: "Protected recovery transaction failed.", details: nil)
        } catch { response = FlutterError(code: "recovery_unknown", message: nil, details: nil) }
        DispatchQueue.main.async {
          if self.channels[identity] != nil { result(response) }
        }
      }
    }
    return channel
  }

  func detach(_ channel: FlutterMethodChannel) {
    dispatchPrecondition(condition: .onQueue(.main))
    channel.setMethodCallHandler(nil)
    channels.removeValue(forKey: ObjectIdentifier(channel))
    // Already admitted jobs finish on the same queue; detach never releases
    // a transaction lock early, including while its engine is shutting down.
  }
}
#endif
