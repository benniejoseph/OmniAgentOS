import Foundation

private final class MemoryCredentialBackend: CredentialBackend {
  var values: [String: [String: Data]]
  var reads: [(service: String, key: String, interactive: Bool)] = []
  var deletes: [(service: String, key: String, interactive: Bool)] = []

  init(_ values: [String: [String: String]] = [:]) {
    self.values = values.mapValues { service in
      service.mapValues { Data($0.utf8) }
    }
  }

  func accounts(service: String) throws -> Set<String> {
    Set(values[service]?.keys ?? [String: Data]().keys)
  }

  func read(service: String, key: String, allowInteraction: Bool) throws -> Data? {
    reads.append((service, key, allowInteraction))
    return values[service]?[key]
  }

  func write(service: String, key: String, value: Data) throws {
    values[service, default: [:]][key] = value
  }

  func delete(service: String, key: String, allowInteraction: Bool) throws {
    deletes.append((service, key, allowInteraction))
    values[service]?[key] = nil
  }
}

@main
private enum CredentialBrokerPolicyTests {
  static func main() {
    rejectsCommandsAndKeysOutsideTheProtocol()
    probeNeverReadsSecretValues()
    migrationCopiesVerifiesThenDeletesKnownSource()
    migrationConflictPreservesBothStores()
    unknownSourceAccountFailsClosed()
  }

  private static func rejectsCommandsAndKeysOutsideTheProtocol() {
    let backend = MemoryCredentialBackend()
    let executor = CredentialBrokerExecutor(backend: backend)
    let command = executor.execute(["id": "invalid-01", "action": "execute"])
    let key = executor.execute([
      "id": "invalid-02", "action": "write", "key": "arbitrary.key", "value": "secret",
    ])
    precondition(command["code"] as? String == "invalid_request")
    precondition(key["code"] as? String == "invalid_request")
    precondition(backend.values.isEmpty)
  }

  private static func probeNeverReadsSecretValues() {
    let backend = MemoryCredentialBackend([
      CredentialBrokerPolicy.legacyService: ["asael.session_token": "legacy"]
    ])
    let response = CredentialBrokerExecutor(backend: backend).execute([
      "id": "probe-0001", "action": "probe",
    ])
    precondition(response["outcome"] as? String == "succeeded")
    precondition(response["migrationRequired"] as? Bool == true)
    precondition(backend.reads.isEmpty)
  }

  private static func migrationCopiesVerifiesThenDeletesKnownSource() {
    let backend = MemoryCredentialBackend([
      CredentialBrokerPolicy.legacyService: [
        "asael.session_token": "access",
        "asael.refresh_token": "refresh",
      ]
    ])
    let response = CredentialBrokerExecutor(backend: backend).execute([
      "id": "migrate-0001", "action": "migrate",
    ])
    precondition(response["outcome"] as? String == "succeeded")
    precondition(backend.values[CredentialBrokerPolicy.legacyService]?.isEmpty == true)
    precondition(
      backend.values[CredentialBrokerPolicy.service]?["asael.session_token"] == Data("access".utf8)
    )
    precondition(
      backend.values[CredentialBrokerPolicy.service]?[CredentialBrokerPolicy.migrationMarker]
        == Data("1".utf8)
    )
    precondition(
      backend.reads.filter { $0.service == CredentialBrokerPolicy.legacyService }
        .allSatisfy(\.interactive)
    )
    precondition(
      backend.deletes.filter { $0.service == CredentialBrokerPolicy.legacyService }
        .allSatisfy(\.interactive)
    )
  }

  private static func migrationConflictPreservesBothStores() {
    let backend = MemoryCredentialBackend([
      CredentialBrokerPolicy.legacyService: ["asael.session_token": "old"],
      CredentialBrokerPolicy.service: ["asael.session_token": "different"],
    ])
    let response = CredentialBrokerExecutor(backend: backend).execute([
      "id": "migrate-0002", "action": "migrate",
    ])
    precondition(response["code"] as? String == "secure_store_migration_conflict")
    precondition(
      backend.values[CredentialBrokerPolicy.legacyService]?["asael.session_token"]
        == Data("old".utf8)
    )
    precondition(
      backend.values[CredentialBrokerPolicy.service]?["asael.session_token"]
        == Data("different".utf8)
    )
  }

  private static func unknownSourceAccountFailsClosed() {
    let backend = MemoryCredentialBackend([
      CredentialBrokerPolicy.legacyService: ["unrecognized.private.item": "untouched"]
    ])
    let response = CredentialBrokerExecutor(backend: backend).execute([
      "id": "migrate-0003", "action": "migrate",
    ])
    precondition(response["code"] as? String == "secure_store_legacy_unknown_keys")
    precondition(
      backend.values[CredentialBrokerPolicy.legacyService]?["unrecognized.private.item"]
        == Data("untouched".utf8)
    )
  }
}
