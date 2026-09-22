import Foundation

private final class MemoryCredentialBackendV2: CredentialBackendV2 {
  var values: [String: [String: Data]]
  var accountRequests: [String] = []
  var reads: [(service: String, key: String, interactive: Bool)] = []
  var writes: [(service: String, key: String)] = []
  var deletes: [(service: String, key: String, interactive: Bool)] = []

  init(_ values: [String: [String: String]] = [:]) {
    self.values = values.mapValues { service in
      service.mapValues { Data($0.utf8) }
    }
  }

  func accounts(service: String) throws -> Set<String> {
    accountRequests.append(service)
    return Set(values[service]?.keys ?? [String: Data]().keys)
  }

  func read(service: String, key: String, allowInteraction: Bool) throws -> Data? {
    reads.append((service, key, allowInteraction))
    return values[service]?[key]
  }

  func write(service: String, key: String, value: Data) throws {
    writes.append((service, key))
    values[service, default: [:]][key] = value
  }

  func delete(service: String, key: String, allowInteraction: Bool) throws {
    deletes.append((service, key, allowInteraction))
    values[service]?[key] = nil
  }
}

@main
private enum CredentialBrokerV2PolicyTests {
  static func main() {
    probeRequiresFreshSignInWithoutConsultingV1()
    partialV2CredentialsRemainUnreadableBeforeInitialization()
    freshSessionWriteCommitsAndVerifiesTheV2Marker()
    migrationAndArbitraryKeysAreRejectedWithoutSideEffects()
    invalidMarkerAndUnknownTargetAccountsFailClosed()
  }

  private static func probeRequiresFreshSignInWithoutConsultingV1() {
    let backend = MemoryCredentialBackendV2([
      "app.omniagent.omniagent.credential-broker.v1": [
        "asael.session_token": "must-not-be-read"
      ]
    ])
    let response = CredentialBrokerV2Executor(backend: backend).execute([
      "id": "probe-v2-0001", "action": "probe",
    ])
    precondition(response["outcome"] as? String == "succeeded")
    precondition(response["state"] as? String == "fresh_sign_in_required")
    precondition(response["freshSignInRequired"] as? Bool == true)
    precondition(response["migrationRequired"] as? Bool == false)
    precondition(backend.accountRequests == [CredentialBrokerV2Policy.service])
    precondition(backend.reads.isEmpty)
  }

  private static func partialV2CredentialsRemainUnreadableBeforeInitialization() {
    let backend = MemoryCredentialBackendV2([
      CredentialBrokerV2Policy.service: [
        "asael.session_token": "incomplete-session"
      ]
    ])
    let response = CredentialBrokerV2Executor(backend: backend).execute([
      "id": "read-v2-000001", "action": "read", "key": "asael.session_token",
    ])
    precondition(response["outcome"] as? String == "succeeded")
    precondition(response["value"] is NSNull)
    precondition(backend.reads.isEmpty)
  }

  private static func freshSessionWriteCommitsAndVerifiesTheV2Marker() {
    let backend = MemoryCredentialBackendV2()
    let executor = CredentialBrokerV2Executor(backend: backend)
    let write = executor.execute([
      "id": "write-v2-00001", "action": "write", "key": "asael.session_token",
      "value": "fresh-session",
    ])
    precondition(write["outcome"] as? String == "succeeded")
    precondition(
      backend.values[CredentialBrokerV2Policy.service]?["asael.session_token"]
        == Data("fresh-session".utf8)
    )
    precondition(
      backend.values[CredentialBrokerV2Policy.service]?[CredentialBrokerV2Policy.initializationMarker]
        == CredentialBrokerV2Policy.initializationMarkerValue
    )

    let probe = executor.execute(["id": "probe-v2-0002", "action": "probe"])
    precondition(probe["state"] as? String == "ready")
    precondition(probe["freshSignInRequired"] as? Bool == false)
    let read = executor.execute([
      "id": "read-v2-000002", "action": "read", "key": "asael.session_token",
    ])
    precondition(read["value"] as? String == "fresh-session")
  }

  private static func migrationAndArbitraryKeysAreRejectedWithoutSideEffects() {
    let backend = MemoryCredentialBackendV2()
    let executor = CredentialBrokerV2Executor(backend: backend)
    let migration = executor.execute(["id": "migrate-v2-001", "action": "migrate"])
    let arbitrary = executor.execute([
      "id": "write-v2-00002", "action": "write", "key": "arbitrary.key",
      "value": "secret",
    ])
    precondition(migration["code"] as? String == "secure_store_fresh_sign_in_required")
    precondition(arbitrary["code"] as? String == "invalid_request")
    precondition(backend.values.isEmpty)
    precondition(backend.accountRequests.isEmpty)
    precondition(backend.reads.isEmpty)
    precondition(backend.writes.isEmpty)
    precondition(backend.deletes.isEmpty)
  }

  private static func invalidMarkerAndUnknownTargetAccountsFailClosed() {
    let invalidMarker = MemoryCredentialBackendV2([
      CredentialBrokerV2Policy.service: [
        CredentialBrokerV2Policy.initializationMarker: "not-the-v2-marker",
        "asael.session_token": "hidden",
      ]
    ])
    let markerResponse = CredentialBrokerV2Executor(backend: invalidMarker).execute([
      "id": "probe-v2-0003", "action": "probe",
    ])
    precondition(
      markerResponse["code"] as? String == "secure_store_initialization_verification_failed"
    )

    let unknown = MemoryCredentialBackendV2([
      CredentialBrokerV2Policy.service: ["unrecognized.private.item": "untouched"]
    ])
    let unknownResponse = CredentialBrokerV2Executor(backend: unknown).execute([
      "id": "probe-v2-0004", "action": "probe",
    ])
    precondition(unknownResponse["code"] as? String == "secure_store_target_unknown_keys")
    precondition(
      unknown.values[CredentialBrokerV2Policy.service]?["unrecognized.private.item"]
        == Data("untouched".utf8)
    )
  }
}
