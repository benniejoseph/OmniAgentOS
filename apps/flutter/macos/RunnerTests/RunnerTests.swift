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

  func testNotificationBridgeStorePersistsDeduplicatesAndRemovesEvents() throws {
    let suiteName = "app.omniagent.omniagent.RunnerTests.push.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    defer {
      defaults.removePersistentDomain(forName: suiteName)
      _ = defaults.synchronize()
    }
    let store = NativeNotificationBridgeEventStore(defaults: defaults)
    let arguments: [String: Any] = [
      "data": [
        "asael": [
          "schemaVersion": "1",
          "deliveryId": "delivery-one",
          "causeKind": "meeting",
          "causeId": "meeting-one",
          "deepLink": "/meetings/meeting-one",
        ],
      ],
      "appLifecycle": "foreground",
      "observedAt": "2026-09-18T12:00:00Z",
    ]

    XCTAssertTrue(store.enqueue(method: "notificationReceived", arguments: arguments))
    XCTAssertTrue(store.enqueue(method: "notificationReceived", arguments: arguments))
    XCTAssertEqual(store.count, 1)

    let reloaded = NativeNotificationBridgeEventStore(defaults: defaults)
    let event = try XCTUnwrap(reloaded.first())
    XCTAssertEqual(event["method"] as? String, "notificationReceived")
    let id = try XCTUnwrap(event["id"] as? String)
    reloaded.remove(id: id)
    XCTAssertEqual(reloaded.count, 0)
  }

  func testNotificationBridgeStorePrioritizesUserActionWhenFull() throws {
    let suiteName = "app.omniagent.omniagent.RunnerTests.push-full.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    defer {
      defaults.removePersistentDomain(forName: suiteName)
      _ = defaults.synchronize()
    }
    let store = NativeNotificationBridgeEventStore(defaults: defaults)
    for index in 0..<NativeNotificationBridgeEventStore.maximumEvents {
      XCTAssertTrue(
        store.enqueue(
          method: "notificationReceived",
          arguments: notificationArguments(deliveryId: "delivery-\(index)")
        )
      )
    }

    XCTAssertTrue(
      store.enqueue(
        method: "notificationAction",
        arguments: notificationArguments(
          deliveryId: "delivery-action",
          action: "complete"
        )
      )
    )
    XCTAssertEqual(store.count, NativeNotificationBridgeEventStore.maximumEvents)

    var receivedCount = 0
    var actionCount = 0
    while let event = store.first(), let id = event["id"] as? String {
      switch event["method"] as? String {
      case "notificationReceived": receivedCount += 1
      case "notificationAction": actionCount += 1
      default: XCTFail("Unexpected notification bridge method")
      }
      store.remove(id: id)
    }
    XCTAssertEqual(receivedCount, NativeNotificationBridgeEventStore.maximumEvents - 1)
    XCTAssertEqual(actionCount, 1)
  }

  func testNotificationBridgeStoreRejectsActionWhenOnlyActionsAreRetained() throws {
    let suiteName = "app.omniagent.omniagent.RunnerTests.push-actions.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    defer {
      defaults.removePersistentDomain(forName: suiteName)
      _ = defaults.synchronize()
    }
    let store = NativeNotificationBridgeEventStore(defaults: defaults)
    for index in 0..<NativeNotificationBridgeEventStore.maximumEvents {
      XCTAssertTrue(
        store.enqueue(
          method: "notificationAction",
          arguments: notificationArguments(
            deliveryId: "delivery-action-\(index)",
            action: "complete"
          )
        )
      )
    }

    XCTAssertFalse(
      store.enqueue(
        method: "notificationAction",
        arguments: notificationArguments(
          deliveryId: "delivery-overflow",
          action: "dismiss"
        )
      )
    )
    XCTAssertEqual(store.count, NativeNotificationBridgeEventStore.maximumEvents)
  }

  func testNotificationBridgeStoreRollsBackFailedPersistence() throws {
    let suiteName = "app.omniagent.omniagent.RunnerTests.push-failure.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = NativeNotificationBridgeEventStore(
      defaults: defaults,
      synchronize: { false }
    )

    XCTAssertFalse(
      store.enqueue(
        method: "notificationAction",
        arguments: notificationArguments(
          deliveryId: "delivery-failure",
          action: "snooze15"
        )
      )
    )
    XCTAssertEqual(store.count, 0)
  }

  private func migrationRequiredProbe() -> [String: Any] {
    [
      "state": "migration_required",
      "migrationRequired": true,
      "legacyItemCount": 7,
      "targetItemCount": 7,
    ]
  }

  private func notificationArguments(
    deliveryId: String,
    action: String? = nil
  ) -> [String: Any] {
    var arguments: [String: Any] = [
      "data": [
        "asael": [
          "schemaVersion": "1",
          "deliveryId": deliveryId,
          "causeKind": "meeting",
          "causeId": "meeting-one",
          "deepLink": "/meetings/meeting-one",
        ],
      ],
      "appLifecycle": "background",
      "observedAt": "2026-09-18T12:00:00Z",
    ]
    if let action { arguments["action"] = action }
    return arguments
  }
}
