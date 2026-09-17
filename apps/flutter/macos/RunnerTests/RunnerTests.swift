import Cocoa
import FlutterMacOS
import XCTest
@testable import omniagent

class RunnerTests: XCTestCase {
  private final class ReceiptStore: CredentialBrokerCutoverReceiptStoring {
    init(receipt: Any? = nil, persistenceSucceeds: Bool = true) {
      storedReceipt = receipt
      self.persistenceSucceeds = persistenceSucceeds
    }

    var storedReceipt: Any?
    var persistenceSucceeds: Bool
    var persistenceAttempts = 0

    func receipt() -> Any? {
      storedReceipt
    }

    func persist(_ receipt: [String: String]) -> Bool {
      persistenceAttempts += 1
      guard persistenceSucceeds else { return false }
      storedReceipt = receipt
      return true
    }
  }

  func testProbeWithoutReceiptPreservesMigrationRequirement() {
    let response = migrationRequiredProbe()

    let normalized = CredentialBrokerCutoverPolicy.normalizeSucceeded(
      action: "probe",
      response: response,
      store: ReceiptStore()
    )

    XCTAssertEqual(normalized?["migrationRequired"] as? Bool, true)
    XCTAssertEqual(normalized?["state"] as? String, "migration_required")
    XCTAssertNil(normalized?["legacyCleanupPending"])
  }

  func testProbeWithWrongReceiptPreservesMigrationRequirement() {
    let store = ReceiptStore(receipt: ["schema": "wrong", "version": "1"])

    let normalized = CredentialBrokerCutoverPolicy.normalizeSucceeded(
      action: "probe",
      response: migrationRequiredProbe(),
      store: store
    )

    XCTAssertEqual(normalized?["migrationRequired"] as? Bool, true)
    XCTAssertEqual(normalized?["state"] as? String, "migration_required")
    XCTAssertNil(normalized?["legacyCleanupPending"])
  }

  func testProbeWithExactReceiptUsesCommittedTargetAndReportsCleanup() {
    let store = ReceiptStore(receipt: CredentialBrokerCutoverPolicy.receipt)

    let normalized = CredentialBrokerCutoverPolicy.normalizeSucceeded(
      action: "probe",
      response: migrationRequiredProbe(),
      store: store
    )

    XCTAssertEqual(normalized?["migrationRequired"] as? Bool, false)
    XCTAssertEqual(normalized?["state"] as? String, "ready")
    XCTAssertEqual(normalized?["legacyCleanupPending"] as? Bool, true)
  }

  func testMigrationPersistenceFailureDoesNotReturnSuccess() {
    let store = ReceiptStore(persistenceSucceeds: false)

    let normalized = CredentialBrokerCutoverPolicy.normalizeSucceeded(
      action: "migrate",
      response: ["state": "ready", "migratedItemCount": 7],
      store: store
    )

    XCTAssertNil(normalized)
    XCTAssertEqual(store.persistenceAttempts, 1)
    XCTAssertNil(store.storedReceipt)
  }

  func testMigrationPersistsExactVersionedReceiptBeforeReturningSuccess() {
    let store = ReceiptStore()
    let response: [String: Any] = ["state": "ready", "migratedItemCount": 7]

    let normalized = CredentialBrokerCutoverPolicy.normalizeSucceeded(
      action: "migrate",
      response: response,
      store: store
    )

    XCTAssertNotNil(normalized)
    XCTAssertEqual(store.persistenceAttempts, 1)
    XCTAssertTrue(CredentialBrokerCutoverPolicy.hasExactReceipt(store.storedReceipt))
  }

  func testUserDefaultsReceiptStorePersistsAndReadsBackExactReceipt() throws {
    let suiteName = "app.omniagent.omniagent.RunnerTests.cutover.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    defer {
      defaults.removePersistentDomain(forName: suiteName)
      _ = defaults.synchronize()
    }

    let store = UserDefaultsCredentialBrokerCutoverReceiptStore(defaults: defaults)

    XCTAssertTrue(store.persist(CredentialBrokerCutoverPolicy.receipt))

    let reloadedDefaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    let persisted = reloadedDefaults.object(
      forKey: CredentialBrokerCutoverPolicy.receiptKey
    )
    XCTAssertTrue(CredentialBrokerCutoverPolicy.hasExactReceipt(persisted))
  }

  private func migrationRequiredProbe() -> [String: Any] {
    [
      "state": "migration_required",
      "migrationRequired": true,
      "legacyItemCount": 7,
      "targetItemCount": 7,
    ]
  }
}
