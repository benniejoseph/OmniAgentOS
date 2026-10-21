import Foundation
import Darwin
#if !SHARED_CAPTURE_HANDOFF_TESTS
import XCTest
@testable import omniagent
#endif

private enum HandoffTestFailure: Error { case failed(String), interrupted }
private func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() { throw HandoffTestFailure.failed(message) }
}
private func rejects(_ message: String, _ operation: () throws -> Void) throws {
  do { try operation() } catch { return }
  throw HandoffTestFailure.failed(message)
}

private enum SharedCaptureHandoffCases {
  typealias Transport = SharedCaptureHandoff
  static let owner = String(repeating: "a", count: 64)
  static let otherOwner = String(repeating: "b", count: 64)

  struct Fixture {
    let root: URL
    let source: URL
    let inbox: URL
    let id: String
    let manifest: Transport.Manifest
    let original: Data
    var fingerprint: String { Transport.digest(original) }
    var destination: URL { inbox.appendingPathComponent(id, isDirectory: true) }

    init(files: [(String, Data)] = [("01-note.txt", Data("Selected synthetic content".utf8))],
         now: Date = Date(), mutate: ((inout [Transport.Entry]) -> Void)? = nil) throws {
      root = FileManager.default.temporaryDirectory.appendingPathComponent("asael-handoff-test-\(UUID().uuidString)", isDirectory: true)
      id = UUID().uuidString.lowercased()
      source = root.appendingPathComponent(id, isDirectory: true)
      inbox = root.appendingPathComponent("inbox", isDirectory: true)
      try Transport.makeDirectory(source)
      var entries: [Transport.Entry] = []
      for (name, bytes) in files {
        try Transport.publish(bytes, to: source.appendingPathComponent(name))
        entries.append(.init(name: name, size: bytes.count, sha256: Transport.digest(bytes)))
      }
      mutate?(&entries)
      manifest = .init(schemaVersion: 2, requestId: id, createdAt: ISO8601DateFormatter().string(from: now), files: entries)
      original = try JSONEncoder().encode(manifest)
      try Transport.publish(original, to: source.appendingPathComponent("manifest.json"))
    }
    func clean() { try? FileManager.default.removeItem(at: root) }
    func receive(afterPublication: (() throws -> Void)? = nil) throws -> String {
      try Transport.importRequest(source, requestId: id, fingerprint: fingerprint, inbox: inbox, afterPublication: afterPublication)
    }
    func acknowledgeAll() throws {
      let names = Set(manifest.files.map(\.name))
      try require(try DesktopSharedCaptureReceipts.bindOwner(Self.owner, directory: destination, allowed: names), "Owner was not bound")
      try Transport.recordOwner(Self.owner, requestId: id, inbox: inbox)
      for name in names {
        try DesktopSharedCaptureReceipts.acknowledge(name, owner: Self.owner, directory: destination, allowed: names)
        try FileManager.default.removeItem(at: destination.appendingPathComponent(name))
      }
    }
    private static var owner: String { SharedCaptureHandoffCases.owner }
  }

  static func durableImportAndDuplicate() throws {
    let fixture = try Fixture(); defer { fixture.clean() }
    try require(try fixture.receive() == "accepted", "First import not accepted")
    let bytes = try Transport.read(fixture.destination.appendingPathComponent("01-note.txt"), maximum: 1_024)
    try require(bytes == Data("Selected synthetic content".utf8), "Imported bytes changed")
    try require(try fixture.receive() == "accepted", "Duplicate was not idempotent")
    let stored = try FileManager.default.contentsOfDirectory(atPath: fixture.inbox.path).filter { Transport.validId($0) }
    try require(stored == [fixture.id], "Duplicate produced another batch")
    try fixture.acknowledgeAll()
    try Transport.finish(fixture.destination, inbox: fixture.inbox)
    try require(!FileManager.default.fileExists(atPath: fixture.destination.path), "Finished batch was not cleaned")
    try require(try fixture.receive() == "finished", "Replay after cleanup lost final outcome")
    try require(!FileManager.default.fileExists(atPath: fixture.destination.path), "Replay resurrected a consumed batch")
    // Simulate termination mid-cleanup: the receipt survived, but only an
    // arbitrary residual file remains and the normal manifest scan cannot read it.
    try Transport.makeDirectory(fixture.destination)
    try Transport.publish(Data("residual".utf8), to: fixture.destination.appendingPathComponent("residual.txt"))
    try require(try Transport.removeFinishedIfNeeded(fixture.destination, inbox: fixture.inbox), "Finished tombstone did not authorize interrupted cleanup")
    try require(!FileManager.default.fileExists(atPath: fixture.destination.path), "Interrupted deletion kept consuming capacity")
    try rejects("A consumed request changed owner") {
      try Transport.recordOwner(otherOwner, requestId: fixture.id, inbox: fixture.inbox)
    }
  }

  static func crashRecoveryBeforeAcknowledgment() throws {
    let fixture = try Fixture(); defer { fixture.clean() }
    try rejects("Injected publication interruption did not fail") {
      _ = try fixture.receive { throw HandoffTestFailure.interrupted }
    }
    let ledger = fixture.inbox.appendingPathComponent(".transport-receipts/\(fixture.id).json")
    try require(!FileManager.default.fileExists(atPath: ledger.path), "Receipt preceded complete publication")
    try require(FileManager.default.fileExists(atPath: fixture.destination.path), "Published copy lost after interruption")
    try Transport.ensureReady(fixture.destination, inbox: fixture.inbox)
    try require(FileManager.default.fileExists(atPath: ledger.path), "Restart scan did not recover receipt")
    try require(try fixture.receive() == "accepted", "Delivery retry did not recover")
  }

  static func ownerAndPartialAcknowledgment() throws {
    let fixture = try Fixture(files: [("01-one.txt", Data("one".utf8)), ("02-two.txt", Data("two".utf8))])
    defer { fixture.clean() }
    _ = try fixture.receive()
    let names = Set(fixture.manifest.files.map(\.name))
    try require(try DesktopSharedCaptureReceipts.bindOwner(owner, directory: fixture.destination, allowed: names), "Owner rejected")
    // Simulate termination before external owner mirror; the journal is durable.
    try require(try !DesktopSharedCaptureReceipts.bindOwner(otherOwner, directory: fixture.destination, allowed: names), "Account switch rebound native journal")
    try DesktopSharedCaptureReceipts.acknowledge("01-one.txt", owner: owner, directory: fixture.destination, allowed: names)
    try FileManager.default.removeItem(at: fixture.destination.appendingPathComponent("01-one.txt"))
    try Transport.ensureReady(fixture.destination, inbox: fixture.inbox)
    try require(try fixture.receive() == "accepted", "Partial accepted batch could not replay")
    try require(try !Transport.removeFinishedIfNeeded(fixture.destination, inbox: fixture.inbox), "Pending data was treated as finished")
    try rejects("Partial acknowledgment deleted pending data") { try Transport.finish(fixture.destination, inbox: fixture.inbox) }
    try require(FileManager.default.fileExists(atPath: fixture.destination.appendingPathComponent("02-two.txt").path), "Pending file vanished")
    try DesktopSharedCaptureReceipts.acknowledge("02-two.txt", owner: owner, directory: fixture.destination, allowed: names)
    try Transport.finish(fixture.destination, inbox: fixture.inbox)
    try rejects("Restart cleanup lost immutable owner") { try Transport.recordOwner(otherOwner, requestId: fixture.id, inbox: fixture.inbox) }
  }

  static func allOrNothingAndBoundaries() throws {
    let fixture = try Fixture(files: [("01-one.txt", Data("one".utf8)), ("02-two.txt", Data("two".utf8))])
    defer { fixture.clean() }
    try Transport.publish(Data("bad".utf8), to: fixture.source.appendingPathComponent("02-two.txt"))
    try rejects("Changed bytes accepted") { _ = try fixture.receive() }
    try require(!FileManager.default.fileExists(atPath: fixture.destination.path), "A failed file published a partial batch")
    let oversized = try Fixture(mutate: { entries in
      entries[0] = .init(name: entries[0].name, size: Transport.maximumFileBytes + 1, sha256: entries[0].sha256)
    }); defer { oversized.clean() }
    try rejects("Oversized count accepted") { _ = try oversized.receive() }
    let traversal = try Fixture(mutate: { entries in
      entries[0] = .init(name: "../outside.txt", size: entries[0].size, sha256: entries[0].sha256)
    }); defer { traversal.clean() }
    try rejects("Traversal accepted") { _ = try traversal.receive() }
    let tooMany = try Fixture(mutate: { entries in
      entries = (1...26).map { .init(name: "\($0).txt", size: 1, sha256: entries[0].sha256) }
    }); defer { tooMany.clean() }
    try rejects("More than25 files accepted") { _ = try tooMany.receive() }
    try require(!Transport.safeName("bad\u{202e}.txt") && !Transport.safeName("unsafe.exe"), "Unsafe filename/type accepted")
  }

  static func symlinksAndManifestReplacement() throws {
    let fixture = try Fixture(); defer { fixture.clean() }
    let file = fixture.source.appendingPathComponent("01-note.txt")
    let outside = fixture.root.appendingPathComponent("outside.txt")
    try FileManager.default.moveItem(at: file, to: outside)
    try FileManager.default.createSymbolicLink(at: file, withDestinationURL: outside)
    try rejects("Symlink escaped request directory") { _ = try fixture.receive() }
    let original = fixture.source.appendingPathComponent("manifest.json")
    try Transport.publish(Data("{}".utf8), to: original)
    try rejects("Manifest fingerprint ignored") { _ = try fixture.receive() }
    let aliasRoot = fixture.root.appendingPathComponent("alias", isDirectory: true)
    try Transport.makeDirectory(aliasRoot)
    let directoryLink = aliasRoot.appendingPathComponent(fixture.id, isDirectory: true)
    try FileManager.default.createSymbolicLink(at: directoryLink, withDestinationURL: fixture.source)
    try rejects("Symlink source directory accepted") {
      _ = try Transport.importRequest(directoryLink, requestId: fixture.id, fingerprint: fixture.fingerprint, inbox: fixture.inbox)
    }
  }

  static func expirationAndFutureDates() throws {
    for date in [Date().addingTimeInterval(-Transport.lifetime - 5), Date().addingTimeInterval(600)] {
      let fixture = try Fixture(now: date); defer { fixture.clean() }
      try rejects("Expired/future source accepted") { _ = try fixture.receive() }
    }
  }

  static func capacityAndAbandonedCopies() throws {
    let fixture = try Fixture(); defer { fixture.clean() }
    try Transport.makeDirectory(fixture.inbox)
    for _ in 0..<Transport.maximumPendingRequests {
      let directory = fixture.inbox.appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
      try Transport.makeDirectory(directory)
      try Transport.publish(Data("pending".utf8), to: directory.appendingPathComponent("01-pending.txt"))
    }
    try rejects("Host pending capacity ignored") { _ = try fixture.receive() }
    try require(FileManager.default.fileExists(atPath: fixture.source.path), "Capacity rejection discarded source")
    let requests = try FileManager.default.contentsOfDirectory(at: fixture.inbox, includingPropertiesForKeys: nil).filter { Transport.validId($0.lastPathComponent) }
    try require(requests.count == Transport.maximumPendingRequests, "Capacity rejection removed accepted data")
    // Orphan imports are unaccepted and must not permanently block retries.
    for request in requests {
      try FileManager.default.moveItem(at: request, to: fixture.inbox.appendingPathComponent(".import-" + request.lastPathComponent))
    }
    try require(try fixture.receive() == "accepted", "Abandoned copies blocked retry")
    try require(try FileManager.default.contentsOfDirectory(atPath: fixture.inbox.path).allSatisfy { !$0.hasPrefix(".import-") }, "Orphan import survived reconciliation")
  }

  static func stagingLockAndAbandonedPreparation() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("asael-staging-test-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    var prepared: (Transport.Lock, URL)? = try Transport.prepareStaging(root: root, count: 1)
    try Transport.publish(Data("partial".utf8), to: prepared!.1.appendingPathComponent("01-partial.txt"))
    try rejects("Concurrent extension preparation was not serialized") { _ = try Transport.prepareStaging(root: root, count: 1) }
    let abandoned = prepared!.1
    prepared = nil
    let next = try Transport.prepareStaging(root: root, count: 1)
    try require(!FileManager.default.fileExists(atPath: abandoned.path), "Abandoned preparation consumed capacity for24 hours")
    withExtendedLifetime(next.0) {}
    try rejects("More than25 providers silently truncated") { _ = try Transport.prepareStaging(root: root, count: 26) }
  }

  static func acceptedTemporaryCleanup() throws {
    let fixture = try Fixture(); defer { fixture.clean() }
    let document = fixture.root.appendingPathComponent(fixture.id + "." + Transport.documentExtension)
    try Transport.publish(Data("document".utf8), to: document)
    let ack = Transport.Acknowledgment(schemaVersion: 1, requestId: fixture.id,
      fingerprint: fixture.fingerprint, outcome: "accepted")
    try Transport.publish(try JSONEncoder().encode(ack), to: fixture.source.appendingPathComponent(Transport.acknowledgment))
    let next = try Transport.prepareStaging(root: fixture.root, count: 1)
    try require(!FileManager.default.fileExists(atPath: document.path), "Accepted handoff document not reclaimed")
    try require(!FileManager.default.fileExists(atPath: fixture.source.path), "Accepted temporary copy not reclaimed")
    withExtendedLifetime(next.0) {}
  }

  static func ledgerRecoveryReservation() throws {
    let first = try Fixture(); defer { first.clean() }
    let second = try Fixture(); defer { second.clean() }
    try rejects("Publication interruption not injected") {
      _ = try first.receive { throw HandoffTestFailure.interrupted }
    }
    let ledger = first.inbox.appendingPathComponent(".transport-receipts", isDirectory: true)
    // Inventory entries need no payload reads for admission. Empty fixtures
    // exercise the bound without inventing10,000 synthetic completed captures.
    for index in 0..<(Transport.maximumReceipts - 1) {
      guard FileManager.default.createFile(atPath: ledger.appendingPathComponent("history-\(index).json").path, contents: Data()) else {
        throw HandoffTestFailure.failed("Could not create receipt inventory fixture")
      }
    }
    do {
      _ = try Transport.importRequest(second.source, requestId: second.id, fingerprint: second.fingerprint, inbox: first.inbox)
      throw HandoffTestFailure.failed("New import stole an interrupted batch's final receipt slot")
    } catch Transport.Failure.ledgerFull { }
    try Transport.ensureReady(first.destination, inbox: first.inbox)
    try require(try first.receive() == "accepted", "Reserved receipt could not recover at ledger capacity")
    try require(Transport.Failure.ledgerFull.localizedDescription.contains("file picker"), "Ledger exhaustion gives false pending-cleanup guidance")
  }

  static let all: [(String, () throws -> Void)] = [
    ("durable import, duplicate and completed replay", durableImportAndDuplicate),
    ("interrupted publication recovery", crashRecoveryBeforeAcknowledgment),
    ("owner switch and partial acknowledgment", ownerAndPartialAcknowledgment),
    ("all-or-nothing, count, size, path and type bounds", allOrNothingAndBoundaries),
    ("symlinks and manifest replacement", symlinksAndManifestReplacement),
    ("expired and future requests", expirationAndFutureDates),
    ("capacity deferral and abandoned copies", capacityAndAbandonedCopies),
    ("cross-instance staging lock and abandoned preparation", stagingLockAndAbandonedPreparation),
    ("accepted temporary copy and document cleanup", acceptedTemporaryCleanup),
    ("ledger capacity reserves interrupted imports", ledgerRecoveryReservation),
  ]
}

#if SHARED_CAPTURE_HANDOFF_TESTS
@main private enum SharedCaptureHandoffTestRunner {
  static func main() throws {
    for (name, test) in SharedCaptureHandoffCases.all {
      try test()
      print("PASS \(name)")
    }
  }
}
#else
final class SharedCaptureHandoffTests: XCTestCase {
  func testTransportCases() throws {
    for (_, test) in SharedCaptureHandoffCases.all { try test() }
  }
}
#endif
