import CryptoKit
import Darwin
import Foundation
import Security

/// Native transport only. The host's owner-bound Dart intake performs encryption
/// and acknowledges each file; importing a request is not an encrypted queue receipt.
enum SharedCaptureHandoff {
  static let documentExtension = "asaelcapture"
  static let maximumFiles = 25
  static let maximumFileBytes = 5 * 1_024 * 1_024
  static let maximumPendingFiles = 100
  static let maximumPendingBytes = 250 * 1_024 * 1_024
  static let maximumPendingRequests = 20
  static let maximumReceipts = 10_000
  static let lifetime: TimeInterval = 24 * 60 * 60
  static let marker = ".asael-import.json"
  static let acknowledgment = ".asael-transport.json"
  static let supportedExtensions = Set([
    "txt", "text", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson",
    "html", "htm", "xml", "yaml", "yml", "log", "rtf", "tex", "sql", "js",
    "jsx", "ts", "tsx", "css", "scss", "sass", "less", "py", "rb", "go",
    "rs", "java", "kt", "swift", "sh", "zsh", "toml", "ini", "cfg", "conf",
    "srt", "vtt", "eml", "ics", "vcf", "ipynb", "png", "jpg", "jpeg",
    "webp", "mp3", "m4a", "wav", "ogg", "mp4", "webm", "xlsx", "xlsm",
    "pptx", "ppsx", "odt", "ods", "odp", "epub", "pdf", "docx",
  ])

  enum Failure: String, Error, LocalizedError {
    case invalid, expired, capacity, temporaryCapacity, ledgerFull, busy, unavailable, unconfirmed
    var errorDescription: String? {
      switch self {
      case .invalid: return "The complete selection could not be safely read. Share supported files of 5 MB or less."
      case .expired: return "This temporary share has expired. Select the files and share them again."
      case .capacity: return "Capture's temporary inbox is full. Open Asael, finish or discard pending captures, then retry."
      case .temporaryCapacity: return "Too many temporary shares are waiting. Retry an existing share or use Capture’s file picker. Unconfirmed shares expire after 24 hours and are cleared on the next Share attempt."
      case .ledgerFull: return "Capture’s share history has reached its storage limit. Existing captures are safe. Use Capture’s file picker and contact support before sharing more files."
      case .busy: return "Another share is being prepared. Wait for it to finish, then retry."
      case .unavailable: return "Asael could not open this share. Open the installed Asael app and try again."
      case .unconfirmed: return "Asael has not confirmed this share. Open Capture to check, or retry. Unconfirmed shares expire after 24 hours and are cleared on the next Share attempt."
      }
    }
  }

  struct Entry: Codable, Equatable {
    let name: String
    let size: Int
    let sha256: String
  }
  struct Manifest: Codable {
    let schemaVersion: Int
    let requestId: String
    let createdAt: String
    let files: [Entry]
  }
  struct Document: Codable {
    let schemaVersion: Int
    let requestId: String
    let fingerprint: String
    let directoryBookmark: Data
  }
  struct Receipt: Codable {
    let schemaVersion: Int
    let requestId: String
    let fingerprint: String
    var outcome: String
    var owner: String?
  }
  struct Acknowledgment: Codable {
    let schemaVersion: Int
    let requestId: String
    let fingerprint: String
    let outcome: String
  }
  struct Prepared {
    let requestId: String
    let directory: URL
    let document: URL
    let fingerprint: String
  }

  final class Lock {
    private let descriptor: Int32
    init(_ root: URL) throws {
      try makeDirectory(root)
      descriptor = Darwin.open(root.appendingPathComponent(".transport-lock").path,
        O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
      guard descriptor >= 0 else { throw Failure.unavailable }
      guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
        Darwin.close(descriptor)
        throw Failure.busy
      }
    }
    deinit { flock(descriptor, LOCK_UN); Darwin.close(descriptor) }
  }

  static func validId(_ id: String) -> Bool {
    guard let uuid = UUID(uuidString: id), uuid.uuidString.lowercased() == id else { return false }
    let pieces = id.split(separator: "-")
    return pieces[2].first == "4" && "89ab".contains(pieces[3].first!)
  }

  static func safeName(_ name: String) -> Bool {
    !name.isEmpty && !name.hasPrefix(".") && name != "manifest.json" &&
      name.count <= 180 && name.utf8.count <= 240 &&
      (name as NSString).lastPathComponent == name &&
      !name.unicodeScalars.contains { scalar in
        scalar.value < 0x20 || (0x7f...0x9f).contains(scalar.value) ||
          (0x202a...0x202e).contains(scalar.value) || (0x2066...0x2069).contains(scalar.value)
      } && supportedExtensions.contains((name as NSString).pathExtension.lowercased())
  }

  static func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  static func makeDirectory(_ url: URL) throws {
    var missing: [URL] = [], ancestor = url
    while !FileManager.default.fileExists(atPath: ancestor.path) {
      missing.append(ancestor)
      let parent = ancestor.deletingLastPathComponent()
      guard parent != ancestor else { throw Failure.unavailable }
      ancestor = parent
    }
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let fd = try directoryDescriptor(url)
    defer { Darwin.close(fd) }
    guard fchmod(fd, 0o700) == 0 else { throw Failure.unavailable }
    for created in missing {
      let parent = try directoryDescriptor(created.deletingLastPathComponent())
      let status = fsync(parent)
      Darwin.close(parent)
      guard status == 0 else { throw Failure.unavailable }
    }
  }

  private static func directoryDescriptor(_ url: URL) throws -> Int32 {
    guard url.isFileURL else { throw Failure.invalid }
    let fd = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    guard fd >= 0 else { throw Failure.invalid }
    return fd
  }

  static func read(_ url: URL, maximum: Int) throws -> Data {
    let fd = Darwin.open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { throw Failure.invalid }
    defer { Darwin.close(fd) }
    return try read(descriptor: fd, maximum: maximum)
  }

  private static func read(_ name: String, in directory: Int32, maximum: Int) throws -> Data {
    let fd = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { throw Failure.invalid }
    defer { Darwin.close(fd) }
    return try read(descriptor: fd, maximum: maximum)
  }

  private static func read(descriptor: Int32, maximum: Int) throws -> Data {
    var before = stat()
    guard fstat(descriptor, &before) == 0, (before.st_mode & S_IFMT) == S_IFREG,
          before.st_size > 0, before.st_size <= maximum else { throw Failure.invalid }
    var data = Data(count: Int(before.st_size))
    let count = data.withUnsafeMutableBytes { bytes -> Int in
      var offset = 0
      while offset < bytes.count {
        let readCount = Darwin.read(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
        if readCount < 0 && errno == EINTR { continue }
        if readCount <= 0 { return -1 }
        offset += readCount
      }
      return offset
    }
    var after = stat(), extra: UInt8 = 0
    guard count == data.count, Darwin.read(descriptor, &extra, 1) == 0,
          fstat(descriptor, &after) == 0, before.st_size == after.st_size,
          before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
          before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
          before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
          before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else { throw Failure.invalid }
    return data
  }

  static func publish(_ data: Data, to url: URL) throws {
    let directory = try directoryDescriptor(url.deletingLastPathComponent())
    defer { Darwin.close(directory) }
    try publish(data, name: url.lastPathComponent, in: directory)
  }

  private static func publish(_ data: Data, name: String, in directory: Int32) throws {
    let temporary = ".write-\(UUID().uuidString)"
    let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw Failure.unavailable }
    defer { Darwin.close(fd); unlinkat(directory, temporary, 0) }
    let success = data.withUnsafeBytes { bytes -> Bool in
      var offset = 0
      while offset < bytes.count {
        let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { return false }
        offset += count
      }
      return true
    }
    guard success, fsync(fd) == 0, renameat(directory, temporary, directory, name) == 0,
          fsync(directory) == 0 else { throw Failure.unavailable }
  }

  static func stagingRoot() throws -> URL {
    try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true).appendingPathComponent("AsaelShareTransport", isDirectory: true)
  }

  static func prepareStaging(root: URL, count: Int, now: Date = Date()) throws -> (Lock, URL) {
    guard (1...maximumFiles).contains(count) else { throw Failure.invalid }
    let lease = try Lock(root)
    // The lock is held through provider loading, so no other live preparation is
    // mistaken for abandoned work. Only extension-owned temporary data expires.
    for item in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) {
      let name = item.lastPathComponent
      // A prior entry can remove its sibling handoff document in this snapshot.
      guard FileManager.default.fileExists(atPath: item.path) else { continue }
      if name.hasPrefix(".staging-"), validId(String(name.dropFirst(9))) {
        try FileManager.default.removeItem(at: item)
        continue
      }
      if validId(name),
         let original = try? read(item.appendingPathComponent("manifest.json"), maximum: 32 * 1_024) {
        let prepared = Prepared(requestId: name, directory: item,
          document: root.appendingPathComponent(name + "." + documentExtension), fingerprint: digest(original))
        if let outcome = try? readAcknowledgment(prepared), ["accepted", "finished"].contains(outcome) {
          removeTemporary(prepared)
          continue
        }
      }
      guard validId(name) || item.pathExtension == documentExtension else { continue }
      if let modified = try item.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
         now.timeIntervalSince(modified) > lifetime {
        try FileManager.default.removeItem(at: item)
      }
    }
    do { try checkCapacity(root, addingFiles: count, addingBytes: count * maximumFileBytes) }
    catch Failure.capacity { throw Failure.temporaryCapacity }
    let directory = root.appendingPathComponent(".staging-\(UUID().uuidString.lowercased())", isDirectory: true)
    try makeDirectory(directory)
    return (lease, directory)
  }

  static func commitStaging(_ staging: URL, entries: [Entry], now: Date = Date()) throws -> Prepared {
    let id = String(staging.lastPathComponent.dropFirst(".staging-".count))
    let manifest = Manifest(schemaVersion: 2, requestId: id,
      createdAt: ISO8601DateFormatter().string(from: now), files: entries.sorted { $0.name < $1.name })
    try validate(manifest, id: id, now: now)
    let data = try JSONEncoder().encode(manifest)
    try publish(data, to: staging.appendingPathComponent("manifest.json"))
    let directory = staging.deletingLastPathComponent().appendingPathComponent(id, isDirectory: true)
    try FileManager.default.moveItem(at: staging, to: directory)
    let bookmark = try directory.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
    let document = directory.deletingLastPathComponent().appendingPathComponent(id + "." + documentExtension)
    let descriptor = Document(schemaVersion: 1, requestId: id, fingerprint: digest(data), directoryBookmark: bookmark)
    try publish(try JSONEncoder().encode(descriptor), to: document)
    return Prepared(requestId: id, directory: directory, document: document, fingerprint: descriptor.fingerprint)
  }

  private static func validate(_ manifest: Manifest, id: String, now: Date?) throws {
    guard manifest.schemaVersion == 2, validId(id), manifest.requestId == id,
          (1...maximumFiles).contains(manifest.files.count),
          Set(manifest.files.map(\.name)).count == manifest.files.count,
          let created = ISO8601DateFormatter().date(from: manifest.createdAt),
          manifest.files.allSatisfy({ safeName($0.name) && (1...maximumFileBytes).contains($0.size) &&
            $0.sha256.count == 64 && $0.sha256.allSatisfy { "0123456789abcdef".contains($0) } }) else { throw Failure.invalid }
    if let now, created.timeIntervalSince(now) > 300 || now.timeIntervalSince(created) > lifetime {
      throw Failure.expired
    }
  }

  private static func checkCapacity(_ inbox: URL, addingFiles: Int, addingBytes: Int) throws {
    var requests = 0, files = 0, bytes = 0
    for candidate in try FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil) {
      let name = candidate.lastPathComponent
      guard validId(name) || name.hasPrefix(".staging-") || name.hasPrefix(".import-") else { continue }
      requests += 1
      let fd = try directoryDescriptor(candidate)
      defer { Darwin.close(fd) }
      for file in try FileManager.default.contentsOfDirectory(at: candidate, includingPropertiesForKeys: nil) {
        var info = stat()
        guard fstatat(fd, file.lastPathComponent, &info, AT_SYMLINK_NOFOLLOW) == 0,
              (info.st_mode & S_IFMT) == S_IFREG else { throw Failure.invalid }
        bytes += Int(info.st_size)
        if safeName(file.lastPathComponent) { files += 1 }
      }
    }
    guard requests < maximumPendingRequests, files + addingFiles <= maximumPendingFiles,
          bytes + addingBytes <= maximumPendingBytes else { throw Failure.capacity }
  }

  private static func receiptURL(_ id: String, inbox: URL) -> URL {
    inbox.appendingPathComponent(".transport-receipts", isDirectory: true).appendingPathComponent(id + ".json")
  }
  private static func receipt(_ id: String, inbox: URL) throws -> Receipt? {
    let url = receiptURL(id, inbox: inbox)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let value = try JSONDecoder().decode(Receipt.self, from: read(url, maximum: 4_096))
    guard value.schemaVersion == 1, value.requestId == id,
          ["accepted", "finished"].contains(value.outcome) else { throw Failure.invalid }
    return value
  }
  private static func saveReceipt(_ value: Receipt, inbox: URL) throws {
    let url = receiptURL(value.requestId, inbox: inbox)
    try makeDirectory(url.deletingLastPathComponent())
    if !FileManager.default.fileExists(atPath: url.path),
       try FileManager.default.contentsOfDirectory(atPath: url.deletingLastPathComponent().path).count >= maximumReceipts {
      throw Failure.ledgerFull
    }
    try publish(try JSONEncoder().encode(value), to: url)
  }

  /// Called while the host's serial intake queue is held. A prepared batch is not
  /// exposed to Dart until its external, non-expiring dedupe receipt is durable.
  static func ensureReady(_ directory: URL, inbox: URL) throws {
    let markerURL = directory.appendingPathComponent(marker)
    guard FileManager.default.fileExists(atPath: markerURL.path) else { return } // Legacy Apple group batch.
    let lease = try Lock(inbox)
    defer { withExtendedLifetime(lease) {} }
    let original = try read(markerURL, maximum: 32 * 1_024)
    let manifest = try JSONDecoder().decode(Manifest.self, from: original)
    try validate(manifest, id: directory.lastPathComponent, now: nil)
    let fingerprint = digest(original)
    if let existing = try receipt(manifest.requestId, inbox: inbox) {
      guard existing.fingerprint == fingerprint else { throw Failure.invalid }
      return
    }
    // Crash recovery between atomic batch publication and receipt publication.
    let fd = try directoryDescriptor(directory)
    defer { Darwin.close(fd) }
    for file in manifest.files {
      let data = try read(file.name, in: fd, maximum: maximumFileBytes)
      guard data.count == file.size, digest(data) == file.sha256 else { throw Failure.invalid }
    }
    try saveReceipt(Receipt(schemaVersion: 1, requestId: manifest.requestId,
      fingerprint: fingerprint, outcome: "accepted", owner: nil), inbox: inbox)
  }

  static func withInboxLock<T>(_ inbox: URL, operation: () throws -> T) throws -> T {
    let lease = try Lock(inbox)
    defer { withExtendedLifetime(lease) {} }
    return try operation()
  }

  static func bindOwner(_ owner: String, requestId: String, inbox: URL,
                        binding: () throws -> Bool) throws -> Bool {
    try withInboxLock(inbox) {
      var value = try receipt(requestId, inbox: inbox)
      guard value?.owner == nil || value?.owner == owner else { return false }
      guard try binding() else { return false }
      if value != nil {
        value!.owner = owner
        try saveReceipt(value!, inbox: inbox)
      }
      return true
    }
  }

  static func recordOwner(_ owner: String, requestId: String, inbox: URL) throws {
    guard try bindOwner(owner, requestId: requestId, inbox: inbox, binding: { true }) else { throw Failure.invalid }
  }

  /// The per-file journal remains authoritative. Copy its immutable owner into
  /// the tombstone before deleting the batch, including after a host restart.
  static func finish(_ directory: URL, inbox: URL) throws {
    let lease = try Lock(inbox)
    defer { withExtendedLifetime(lease) {} }
    if var value = try receipt(directory.lastPathComponent, inbox: inbox) {
      let journal = try read(directory.appendingPathComponent(".asael-completed-files.json"), maximum: 16_384)
      guard let object = try JSONSerialization.jsonObject(with: journal) as? [String: Any],
            let owner = object["owner"] as? String,
            let completed = object["completed"] as? [String],
            let manifest = try? JSONDecoder().decode(Manifest.self,
              from: read(directory.appendingPathComponent(marker), maximum: 32 * 1_024)),
            Set(completed) == Set(manifest.files.map(\.name)), value.owner == nil || value.owner == owner else { throw Failure.invalid }
      value.owner = owner
      value.outcome = "finished"
      try saveReceipt(value, inbox: inbox)
    }
    try FileManager.default.removeItem(at: directory)
  }

  /// A crash during recursive deletion can leave an unreadable partial batch.
  /// Only a durable finished tombstone authorizes removing those remnants.
  static func removeFinishedIfNeeded(_ directory: URL, inbox: URL) throws -> Bool {
    guard validId(directory.lastPathComponent),
          directory.deletingLastPathComponent().standardizedFileURL == inbox.standardizedFileURL else { throw Failure.invalid }
    return try withInboxLock(inbox) {
      guard try receipt(directory.lastPathComponent, inbox: inbox)?.outcome == "finished" else { return false }
      if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
      return true
    }
  }

  static func receive(_ documentURL: URL, inbox: URL) throws -> String {
    guard documentURL.isFileURL, documentURL.pathExtension == documentExtension else { throw Failure.invalid }
    let didAccessDocument = documentURL.startAccessingSecurityScopedResource()
    defer { if didAccessDocument { documentURL.stopAccessingSecurityScopedResource() } }
    let document = try JSONDecoder().decode(Document.self, from: read(documentURL, maximum: 64 * 1_024))
    guard document.schemaVersion == 1, validId(document.requestId),
          document.fingerprint.count == 64, !document.directoryBookmark.isEmpty,
          document.directoryBookmark.count <= 48 * 1_024 else { throw Failure.invalid }
    var stale = false
    let directory = try URL(resolvingBookmarkData: document.directoryBookmark, options: [],
      relativeTo: nil, bookmarkDataIsStale: &stale)
    // An implicit bookmark activates its extension at resolution time.
    defer { directory.stopAccessingSecurityScopedResource() }
    // Cross-process implicit bookmarks can be freshly resolved yet report stale.
    // No bookmark is persisted by the host; content and scope are validated below.
    guard directory.isFileURL, directory.lastPathComponent == document.requestId else { throw Failure.invalid }
    return try importRequest(directory, requestId: document.requestId, fingerprint: document.fingerprint, inbox: inbox)
  }

  static func importRequest(_ source: URL, requestId: String, fingerprint: String, inbox: URL,
                            now: Date = Date(), afterPublication: (() throws -> Void)? = nil) throws -> String {
    guard validId(requestId), source.lastPathComponent == requestId else { throw Failure.invalid }
    let sourceFD = try directoryDescriptor(source)
    defer { Darwin.close(sourceFD) }
    let original = try read("manifest.json", in: sourceFD, maximum: 32 * 1_024)
    guard digest(original) == fingerprint else { throw Failure.invalid }
    let manifest = try JSONDecoder().decode(Manifest.self, from: original)
    try validate(manifest, id: requestId, now: now)
    let lease = try Lock(inbox)
    defer { withExtendedLifetime(lease) {} }
    let destination = inbox.appendingPathComponent(requestId, isDirectory: true)
    do {
      let outcome: String
      if let existing = try receipt(requestId, inbox: inbox) {
        guard existing.fingerprint == fingerprint else { throw Failure.invalid }
        // Accepted data may only disappear through finish(), which persists the
        // final outcome first. Missing pending data is an error, never re-imported.
        guard existing.outcome == "finished" || FileManager.default.fileExists(atPath: destination.path) else { throw Failure.invalid }
        outcome = existing.outcome
      } else {
        let ledger = receiptURL(requestId, inbox: inbox).deletingLastPathComponent()
        try makeDirectory(ledger)
        let hasPublishedBatch = FileManager.default.fileExists(atPath: destination.path)
        var occupiedSlots = try FileManager.default.contentsOfDirectory(atPath: ledger.path).count
        if !hasPublishedBatch {
          // Published-but-unreceipted batches reserve a ledger slot after a
          // crash. A later import must not consume their recovery capacity.
          for batch in try FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)
            where validId(batch.lastPathComponent) {
            if FileManager.default.fileExists(atPath: batch.appendingPathComponent(marker).path),
               !FileManager.default.fileExists(atPath: receiptURL(batch.lastPathComponent, inbox: inbox).path) {
              occupiedSlots += 1
            }
          }
        }
        guard occupiedSlots < maximumReceipts else { throw Failure.ledgerFull }
        if hasPublishedBatch {
          guard try read(destination.appendingPathComponent(marker), maximum: 32 * 1_024) == original else { throw Failure.invalid }
          let fd = try directoryDescriptor(destination)
          defer { Darwin.close(fd) }
          for file in manifest.files {
            let bytes = try read(file.name, in: fd, maximum: maximumFileBytes)
            guard bytes.count == file.size, digest(bytes) == file.sha256 else { throw Failure.invalid }
          }
        } else {
          // No import can be live while this exclusive lock is held. Hidden
          // copies have never been published/accepted and are safe to discard.
          for orphan in try FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil) {
            let name = orphan.lastPathComponent
            if name.hasPrefix(".import-"), validId(String(name.dropFirst(8))) {
              try FileManager.default.removeItem(at: orphan)
            } else if validId(name), try receipt(name, inbox: inbox)?.outcome == "finished" {
              try FileManager.default.removeItem(at: orphan)
            }
          }
          try checkCapacity(inbox, addingFiles: manifest.files.count, addingBytes: manifest.files.reduce(0) { $0 + $1.size })
          let staging = inbox.appendingPathComponent(".import-\(requestId)", isDirectory: true)
          // Incomplete copies are hidden and never accepted. A retry of the
          // same request may replace only its own uncommitted import directory.
          if FileManager.default.fileExists(atPath: staging.path) { try FileManager.default.removeItem(at: staging) }
          try makeDirectory(staging)
          do {
            for file in manifest.files {
              let bytes = try read(file.name, in: sourceFD, maximum: maximumFileBytes)
              guard bytes.count == file.size, digest(bytes) == file.sha256 else { throw Failure.invalid }
              try publish(bytes, to: staging.appendingPathComponent(file.name))
            }
            let legacy: [String: Any] = ["schemaVersion": 1, "requestId": requestId,
              "createdAt": manifest.createdAt, "files": manifest.files.map { ["name": $0.name, "size": $0.size] }]
            try publish(try JSONSerialization.data(withJSONObject: legacy), to: staging.appendingPathComponent("manifest.json"))
            try publish(original, to: staging.appendingPathComponent(marker))
            try FileManager.default.moveItem(at: staging, to: destination)
            let inboxFD = try directoryDescriptor(inbox)
            defer { Darwin.close(inboxFD) }
            guard fsync(inboxFD) == 0 else { throw Failure.unavailable }
          } catch {
            try? FileManager.default.removeItem(at: staging)
            throw error
          }
          try afterPublication?()
        }
        try saveReceipt(Receipt(schemaVersion: 1, requestId: requestId, fingerprint: fingerprint,
          outcome: "accepted", owner: nil), inbox: inbox)
        outcome = "accepted"
      }
      try publish(try JSONEncoder().encode(Acknowledgment(schemaVersion: 1, requestId: requestId,
        fingerprint: fingerprint, outcome: outcome)), name: acknowledgment, in: sourceFD)
      return outcome
    } catch {
      // A rejected or capacity-held request remains in the extension's container;
      // no success receipt is produced and a retry keeps the same request ID.
      let outcome = (error as? Failure) == .capacity ? "capacity" : ((error as? Failure) == .ledgerFull ? "ledgerFull" : "rejected")
      try? publish(try JSONEncoder().encode(Acknowledgment(schemaVersion: 1, requestId: requestId,
        fingerprint: fingerprint, outcome: outcome)), name: acknowledgment, in: sourceFD)
      throw error
    }
  }

  static func readAcknowledgment(_ prepared: Prepared) throws -> String? {
    let url = prepared.directory.appendingPathComponent(acknowledgment)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let value = try JSONDecoder().decode(Acknowledgment.self, from: read(url, maximum: 4_096))
    guard value.schemaVersion == 1, value.requestId == prepared.requestId,
          value.fingerprint == prepared.fingerprint,
          ["accepted", "finished", "capacity", "ledgerFull", "rejected"].contains(value.outcome) else { throw Failure.invalid }
    return value.outcome
  }

  static func removeTemporary(_ prepared: Prepared) {
    // Only called after a durable host acceptance; failure leaves bounded
    // temporary data for the next expiry pass, never deletes host-owned files.
    try? FileManager.default.removeItem(at: prepared.document)
    try? FileManager.default.removeItem(at: prepared.directory)
  }

  private static func signingInfo(_ code: SecStaticCode) -> [CFString: Any]? {
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess else { return nil }
    return info as? [CFString: Any]
  }

  static func verifiedContainingApplication(extensionBundle: URL = Bundle.main.bundleURL) throws -> URL {
    let plugins = extensionBundle.deletingLastPathComponent()
    let contents = plugins.deletingLastPathComponent()
    let host = contents.deletingLastPathComponent()
    guard extensionBundle.pathExtension == "appex", plugins.lastPathComponent == "PlugIns",
          contents.lastPathComponent == "Contents", host.pathExtension == "app" else { throw Failure.unavailable }
    var ownCode: SecCode?, ownStatic: SecStaticCode?, hostCode: SecStaticCode?
    guard SecCodeCopySelf([], &ownCode) == errSecSuccess, let ownCode,
          SecCodeCopyStaticCode(ownCode, [], &ownStatic) == errSecSuccess, let ownStatic,
          SecStaticCodeCreateWithPath(host as CFURL, [], &hostCode) == errSecSuccess, let hostCode,
          SecStaticCodeCheckValidity(hostCode, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess,
          let own = signingInfo(ownStatic), let target = signingInfo(hostCode),
          target[kSecCodeInfoIdentifier] as? String == "app.omniagent.omniagent",
          own[kSecCodeInfoIdentifier] as? String == "app.omniagent.omniagent.share",
          let ownCertificates = own[kSecCodeInfoCertificates] as? [SecCertificate], !ownCertificates.isEmpty,
          let hostCertificates = target[kSecCodeInfoCertificates] as? [SecCertificate],
          ownCertificates.map({ SecCertificateCopyData($0) as Data }) == hostCertificates.map({ SecCertificateCopyData($0) as Data }),
          own[kSecCodeInfoTeamIdentifier] as? String == target[kSecCodeInfoTeamIdentifier] as? String else { throw Failure.unavailable }
    return host
  }

  static let hasAuthorizedLegacyGroup: Bool = {
    var ownCode: SecCode?, ownStatic: SecStaticCode?, requirement: SecRequirement?
    guard SecCodeCopySelf([], &ownCode) == errSecSuccess, let ownCode,
          SecCodeCopyStaticCode(ownCode, [], &ownStatic) == errSecSuccess, let ownStatic,
          let info = signingInfo(ownStatic), let team = info[kSecCodeInfoTeamIdentifier] as? String, !team.isEmpty,
          let entitlements = info[kSecCodeInfoEntitlementsDict] as? [String: Any],
          (entitlements["com.apple.security.application-groups"] as? [String])?.contains("group.app.omniagent.omniagent") == true,
          SecRequirementCreateWithString("anchor apple generic" as CFString, [], &requirement) == errSecSuccess,
          let requirement else { return false }
    return SecStaticCodeCheckValidity(ownStatic, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess
  }()
}
