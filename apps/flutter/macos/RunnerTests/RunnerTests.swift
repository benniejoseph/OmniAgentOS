import Cocoa
import FlutterMacOS
import XCTest
@testable import omniagent

class RunnerTests: XCTestCase {
  func testV2FreshSignInProbeIsAcceptedWithoutMigration() {
    let normalized = CredentialBrokerV2ResponsePolicy.normalizeSucceeded(
      action: "probe",
      response: v2Probe(freshSignInRequired: true)
    )

    XCTAssertEqual(normalized?["state"] as? String, "fresh_sign_in_required")
    XCTAssertEqual(normalized?["freshSignInRequired"] as? Bool, true)
    XCTAssertEqual(normalized?["migrationRequired"] as? Bool, false)
  }

  func testV2ReadyProbeIsAccepted() {
    let normalized = CredentialBrokerV2ResponsePolicy.normalizeSucceeded(
      action: "probe",
      response: v2Probe(freshSignInRequired: false)
    )

    XCTAssertEqual(normalized?["state"] as? String, "ready")
    XCTAssertEqual(normalized?["freshSignInRequired"] as? Bool, false)
  }

  func testV2ProbeFailsClosedOnWrongVersionOrInconsistentState() {
    var wrongVersion = v2Probe(freshSignInRequired: true)
    wrongVersion["brokerVersion"] = "1.0.0+1"
    var inconsistent = v2Probe(freshSignInRequired: true)
    inconsistent["state"] = "ready"
    var numericBoolean = v2Probe(freshSignInRequired: true)
    numericBoolean["freshSignInRequired"] = 1

    XCTAssertNil(
      CredentialBrokerV2ResponsePolicy.normalizeSucceeded(
        action: "probe",
        response: wrongVersion
      )
    )
    XCTAssertNil(
      CredentialBrokerV2ResponsePolicy.normalizeSucceeded(
        action: "probe",
        response: inconsistent
      )
    )
    XCTAssertNil(
      CredentialBrokerV2ResponsePolicy.normalizeSucceeded(
        action: "probe",
        response: numericBoolean
      )
    )
  }

  func testV2ResponsePolicyRejectsMigrationAndUnexpectedPayloads() {
    XCTAssertNil(
      CredentialBrokerV2ResponsePolicy.normalizeSucceeded(
        action: "migrate",
        response: [:]
      )
    )
    XCTAssertNil(
      CredentialBrokerV2ResponsePolicy.normalizeSucceeded(
        action: "write",
        response: ["unexpected": true]
      )
    )
    XCTAssertNil(
      CredentialBrokerV2ResponsePolicy.normalizeSucceeded(
        action: "read",
        response: ["value": 7]
      )
    )
    XCTAssertNotNil(
      CredentialBrokerV2ResponsePolicy.normalizeSucceeded(
        action: "read",
        response: ["value": NSNull()]
      )
    )
    XCTAssertNotNil(
      CredentialBrokerV2ResponsePolicy.normalizeSucceeded(
        action: "write",
        response: [:]
      )
    )
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

  private func v2Probe(freshSignInRequired: Bool) -> [String: Any] {
    [
      "brokerVersion": "2.0.0+2",
      "state": freshSignInRequired ? "fresh_sign_in_required" : "ready",
      "freshSignInRequired": freshSignInRequired,
      "migrationRequired": false,
      "targetItemCount": freshSignInRequired ? 0 : 7,
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
