import Foundation
import Darwin

/// The immutable Share manifest is paired with a durable owner and per-file
/// receipts. Publish a receipt before removing bytes; partial requests stay
/// bound to their first owner across lock, account changes and restarts.
enum DesktopSharedCaptureReceipts {
  static let filename = ".asael-completed-files.json"
  private struct Journal {
    let owner: String
    var completed: Set<String>
  }
  private static func load(directory: URL, allowed: Set<String>) throws -> Journal? {
    let url = directory.appendingPathComponent(filename)
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    if fd < 0 && errno == ENOENT { return nil }
    guard fd >= 0 else { throw CocoaError(.fileReadUnknown) }
    defer { _ = close(fd) }
    var metadata = stat()
    guard fstat(fd, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG,
          metadata.st_size >= 0, metadata.st_size <= 16_384 else { throw CocoaError(.fileReadCorruptFile) }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
    let data = try handle.read(upToCount: 16_385) ?? Data()
    guard data.count <= 16_384,
          let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(value.keys) == ["schemaVersion", "owner", "completed"],
          value["schemaVersion"] as? Int == 1,
          let owner = value["owner"] as? String, DesktopWatchIntentStore.validScope(owner),
          let names = value["completed"] as? [String],
          names.count <= 25, Set(names).count == names.count,
          Set(names).isSubset(of: allowed) else { throw CocoaError(.fileReadCorruptFile) }
    return Journal(owner: owner, completed: Set(names))
  }
  static func read(directory: URL, allowed: Set<String>) throws -> Set<String> {
    try load(directory: directory, allowed: allowed)?.completed ?? []
  }
  static func bindOwner(_ owner: String, directory: URL, allowed: Set<String>) throws -> Bool {
    guard DesktopWatchIntentStore.validScope(owner) else { throw CocoaError(.fileWriteInvalidFileName) }
    if let journal = try load(directory: directory, allowed: allowed) { return journal.owner == owner }
    try publish(Journal(owner: owner, completed: []), directory: directory)
    return true
  }
  static func acknowledge(_ name: String, owner: String, directory: URL, allowed: Set<String>) throws {
    guard allowed.contains(name),
          var journal = try load(directory: directory, allowed: allowed), journal.owner == owner else {
      throw CocoaError(.fileWriteInvalidFileName)
    }
    journal.completed.insert(name)
    try publish(journal, directory: directory)
  }
  private static func publish(_ journal: Journal, directory: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "owner": journal.owner, "completed": journal.completed.sorted()])
    let url = directory.appendingPathComponent(filename)
    try data.write(to: url, options: .atomic)
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
    defer { _ = close(fd) }
    guard fsync(fd) == 0 else { throw CocoaError(.fileWriteUnknown) }
    let directoryFD = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard directoryFD >= 0 else { throw CocoaError(.fileWriteUnknown) }
    defer { _ = close(directoryFD) }
    guard fsync(directoryFD) == 0 else { throw CocoaError(.fileWriteUnknown) }
  }
}
