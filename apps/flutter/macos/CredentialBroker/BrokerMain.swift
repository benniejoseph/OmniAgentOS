import CryptoKit
import Foundation
import LocalAuthentication
import Security

enum CredentialBrokerPolicy {
  static let legacyService = "app.omniagent.omniagent.file-keychain.v2"
  static let service = "app.omniagent.omniagent.credential-broker.v1"
  static let migrationMarker = "asael.credential_broker_migration_v1"
  static let allowedKeys: Set<String> = [
    "asael.session_token",
    "asael.refresh_token",
    "asael.access_expires_at",
    "asael.device_id",
    "asael.biometric_enabled",
    "asael.capture_outbox_secret_v1",
    "asael.offline_projection_secret_v1",
    "asael.offline_projection_owner_v1",
    "asael.push_registration_id_v1",
    "asael.push_preview_policy_v1",
    "asael.pending_push_acknowledgement_v1",
    "omniagent.session_token",
  ]
  static let allowedActions: Set<String> = ["probe", "read", "write", "delete", "migrate"]
  static let maximumInputBytes = 512 * 1_024
  static let maximumValueBytes = 64 * 1_024
}

private enum BrokerFailure: Error {
  case invalidRequest
  case keychainUnavailable
  case interactionRequired
  case unreadableValue
  case legacyUnknownKeys
  case targetUnknownKeys
  case migrationConflict
  case migrationVerificationFailed

  var code: String {
    switch self {
    case .invalidRequest: "invalid_request"
    case .keychainUnavailable: "secure_store_unavailable"
    case .interactionRequired: "secure_store_interaction_required"
    case .unreadableValue: "secure_store_unreadable"
    case .legacyUnknownKeys: "secure_store_legacy_unknown_keys"
    case .targetUnknownKeys: "secure_store_target_unknown_keys"
    case .migrationConflict: "secure_store_migration_conflict"
    case .migrationVerificationFailed: "secure_store_migration_verification_failed"
    }
  }
}

protocol CredentialBackend {
  func accounts(service: String) throws -> Set<String>
  func read(service: String, key: String, allowInteraction: Bool) throws -> Data?
  func write(service: String, key: String, value: Data) throws
  func delete(service: String, key: String, allowInteraction: Bool) throws
}

private struct KeychainBackend: CredentialBackend {
  private func nonInteractiveContext() -> LAContext {
    let context = LAContext()
    context.interactionNotAllowed = true
    return context
  }

  func accounts(service: String) throws -> Set<String> {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecReturnAttributes: true,
      kSecMatchLimit: kSecMatchLimitAll,
      kSecUseAuthenticationContext: nonInteractiveContext(),
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess else { throw map(status) }
    let rows: [[CFString: Any]]
    if let values = result as? [[CFString: Any]] {
      rows = values
    } else if let value = result as? [CFString: Any] {
      rows = [value]
    } else {
      throw BrokerFailure.keychainUnavailable
    }
    return Set(rows.compactMap { $0[kSecAttrAccount] as? String })
  }

  func read(service: String, key: String, allowInteraction: Bool) throws -> Data? {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: key,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    if !allowInteraction {
      query[kSecUseAuthenticationContext] = nonInteractiveContext()
    }
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let value = result as? Data else { throw map(status) }
    return value
  }

  func write(service: String, key: String, value: Data) throws {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: key,
      kSecUseAuthenticationContext: nonInteractiveContext(),
    ]
    let updateStatus = SecItemUpdate(
      query as CFDictionary,
      [kSecValueData: value] as CFDictionary
    )
    if updateStatus == errSecSuccess { return }
    guard updateStatus == errSecItemNotFound else { throw map(updateStatus) }
    let add: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: key,
      kSecValueData: value,
    ]
    let addStatus = SecItemAdd(add as CFDictionary, nil)
    guard addStatus == errSecSuccess else { throw map(addStatus) }
  }

  func delete(service: String, key: String, allowInteraction: Bool) throws {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: key,
    ]
    if !allowInteraction {
      query[kSecUseAuthenticationContext] = nonInteractiveContext()
    }
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw map(status) }
  }

  private func map(_ status: OSStatus) -> BrokerFailure {
    switch status {
    case errSecInteractionNotAllowed, errSecAuthFailed, errSecUserCanceled:
      .interactionRequired
    default:
      .keychainUnavailable
    }
  }
}

struct CredentialBrokerExecutor {
  let backend: CredentialBackend

  func execute(_ request: [String: Any]) -> [String: Any] {
    let id = (request["id"] as? String) ?? "invalid"
    do {
      guard id.count >= 8, id.count <= 80,
        let action = request["action"] as? String,
        CredentialBrokerPolicy.allowedActions.contains(action)
      else { throw BrokerFailure.invalidRequest }
      switch action {
      case "probe":
        guard request.count == 2 else { throw BrokerFailure.invalidRequest }
        let target = try checkedAccounts(service: CredentialBrokerPolicy.service, target: true)
        let legacy = try checkedAccounts(
          service: CredentialBrokerPolicy.legacyService, target: false)
        return success(
          id,
          [
            "state": legacy.isEmpty ? "ready" : "migration_required",
            "migrationRequired": !legacy.isEmpty,
            "legacyItemCount": legacy.count,
            "targetItemCount": target.subtracting([CredentialBrokerPolicy.migrationMarker]).count,
          ])
      case "read":
        let key = try validatedKey(request, valueRequired: false)
        guard request.count == 3 else { throw BrokerFailure.invalidRequest }
        let data = try backend.read(
          service: CredentialBrokerPolicy.service,
          key: key,
          allowInteraction: false
        )
        let value: Any
        if let data {
          guard data.count <= CredentialBrokerPolicy.maximumValueBytes,
            let string = String(data: data, encoding: .utf8)
          else { throw BrokerFailure.unreadableValue }
          value = string
        } else {
          value = NSNull()
        }
        return success(id, ["value": value])
      case "write":
        let key = try validatedKey(request, valueRequired: true)
        guard request.count == 4, let value = request["value"] as? String,
          let data = value.data(using: .utf8),
          data.count <= CredentialBrokerPolicy.maximumValueBytes
        else { throw BrokerFailure.invalidRequest }
        try backend.write(service: CredentialBrokerPolicy.service, key: key, value: data)
        guard
          try backend.read(
            service: CredentialBrokerPolicy.service,
            key: key,
            allowInteraction: false
          ) == data
        else { throw BrokerFailure.migrationVerificationFailed }
        return success(id)
      case "delete":
        let key = try validatedKey(request, valueRequired: false)
        guard request.count == 3 else { throw BrokerFailure.invalidRequest }
        try backend.delete(
          service: CredentialBrokerPolicy.service,
          key: key,
          allowInteraction: false
        )
        return success(id)
      case "migrate":
        guard request.count == 2 else { throw BrokerFailure.invalidRequest }
        return try migrate(id: id)
      default:
        throw BrokerFailure.invalidRequest
      }
    } catch let error as BrokerFailure {
      return failure(id, error.code)
    } catch {
      return failure(id, BrokerFailure.keychainUnavailable.code)
    }
  }

  private func migrate(id: String) throws -> [String: Any] {
    let sourceKeys = try checkedAccounts(
      service: CredentialBrokerPolicy.legacyService,
      target: false
    )
    _ = try checkedAccounts(service: CredentialBrokerPolicy.service, target: true)
    if sourceKeys.isEmpty {
      return success(id, ["state": "ready", "migratedItemCount": 0])
    }

    // Every source remains intact until every target value has been read back
    // byte-for-byte and the completion marker has itself been verified.
    for key in sourceKeys.sorted() {
      guard
        let source = try backend.read(
          service: CredentialBrokerPolicy.legacyService,
          key: key,
          allowInteraction: true
        )
      else { throw BrokerFailure.migrationVerificationFailed }
      guard source.count <= CredentialBrokerPolicy.maximumValueBytes,
        String(data: source, encoding: .utf8) != nil
      else { throw BrokerFailure.unreadableValue }
      if let target = try backend.read(
        service: CredentialBrokerPolicy.service,
        key: key,
        allowInteraction: false
      ) {
        guard target == source else { throw BrokerFailure.migrationConflict }
      } else {
        try backend.write(service: CredentialBrokerPolicy.service, key: key, value: source)
      }
      guard
        try backend.read(
          service: CredentialBrokerPolicy.service,
          key: key,
          allowInteraction: false
        ) == source
      else { throw BrokerFailure.migrationVerificationFailed }
    }

    let marker = Data("1".utf8)
    try backend.write(
      service: CredentialBrokerPolicy.service,
      key: CredentialBrokerPolicy.migrationMarker,
      value: marker
    )
    guard
      try backend.read(
        service: CredentialBrokerPolicy.service,
        key: CredentialBrokerPolicy.migrationMarker,
        allowInteraction: false
      ) == marker
    else { throw BrokerFailure.migrationVerificationFailed }
    for key in sourceKeys.sorted() {
      try backend.delete(
        service: CredentialBrokerPolicy.legacyService,
        key: key,
        allowInteraction: true
      )
    }
    return success(id, ["state": "ready", "migratedItemCount": sourceKeys.count])
  }

  private func checkedAccounts(service: String, target: Bool) throws -> Set<String> {
    let accounts = try backend.accounts(service: service)
    let allowed =
      target
      ? CredentialBrokerPolicy.allowedKeys.union([CredentialBrokerPolicy.migrationMarker])
      : CredentialBrokerPolicy.allowedKeys
    guard accounts.isSubset(of: allowed) else {
      throw target ? BrokerFailure.targetUnknownKeys : BrokerFailure.legacyUnknownKeys
    }
    return accounts
  }

  private func validatedKey(_ request: [String: Any], valueRequired: Bool) throws -> String {
    guard let key = request["key"] as? String,
      CredentialBrokerPolicy.allowedKeys.contains(key),
      !valueRequired || request["value"] is String
    else { throw BrokerFailure.invalidRequest }
    return key
  }

  private func success(_ id: String, _ values: [String: Any] = [:]) -> [String: Any] {
    ["id": id, "outcome": "succeeded"].merging(values) { _, new in new }
  }

  private func failure(_ id: String, _ code: String) -> [String: Any] {
    ["id": id, "outcome": "failed", "code": code]
  }
}

private enum ParentVerifier {
  static let hostSigningIdentifier = "app.omniagent.omniagent"
  static let brokerBundleIdentifier = "app.omniagent.omniagent.credential-broker"

  static func verify() -> Bool {
    guard Bundle.main.bundleIdentifier == brokerBundleIdentifier,
      getppid() > 1,
      let broker = copySelfCode(), let host = copyParentCode(),
      SecCodeCheckValidity(broker, [], nil) == errSecSuccess,
      SecCodeCheckValidity(host, [], nil) == errSecSuccess,
      signingIdentifier(broker) == hostSigningIdentifier,
      signingIdentifier(host) == hostSigningIdentifier,
      parentExecutableIsContainer(host),
      certificateDigests(broker) == certificateDigests(host),
      !certificateDigests(broker).isEmpty
    else { return false }
    let brokerTeam = signingValue(kSecCodeInfoTeamIdentifier, from: broker) as? String
    let hostTeam = signingValue(kSecCodeInfoTeamIdentifier, from: host) as? String
    return brokerTeam == hostTeam
  }

  private static func copySelfCode() -> SecCode? {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess else { return nil }
    return code
  }

  private static func copyParentCode() -> SecCode? {
    var code: SecCode?
    let attributes = [kSecGuestAttributePid: NSNumber(value: getppid())] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess else {
      return nil
    }
    return code
  }

  private static func signingIdentifier(_ code: SecCode) -> String? {
    signingValue(kSecCodeInfoIdentifier, from: code) as? String
  }

  private static func signingValue(_ key: CFString, from code: SecCode) -> Any? {
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess,
      let staticCode
    else { return nil }
    var information: CFDictionary?
    let flags = SecCSFlags(rawValue: kSecCSSigningInformation)
    guard SecCodeCopySigningInformation(staticCode, flags, &information) == errSecSuccess,
      let values = information as? [CFString: Any]
    else { return nil }
    return values[key]
  }

  private static func certificateDigests(_ code: SecCode) -> [Data] {
    guard
      let certificates = signingValue(kSecCodeInfoCertificates, from: code)
        as? [SecCertificate]
    else { return [] }
    return certificates.map {
      Data(SHA256.hash(data: SecCertificateCopyData($0) as Data))
    }
  }

  private static func parentExecutableIsContainer(_ host: SecCode) -> Bool {
    guard let executable = signingValue(kSecCodeInfoMainExecutable, from: host) as? URL
    else { return false }
    let brokerBundle = Bundle.main.bundleURL.standardizedFileURL.resolvingSymlinksInPath()
    let hostBundle = brokerBundle.deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
    let hostExecutable = executable.standardizedFileURL.resolvingSymlinksInPath()
    return hostBundle.pathExtension == "app"
      && hostExecutable.path.hasPrefix(hostBundle.path + "/Contents/MacOS/")
  }
}

#if !ASAEL_CREDENTIAL_BROKER_TESTING
  @main
  private enum CredentialBrokerMain {
    static func main() {
      guard ParentVerifier.verify() else { exit(77) }
      let executor = CredentialBrokerExecutor(backend: KeychainBackend())
      while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
          data.count <= CredentialBrokerPolicy.maximumInputBytes,
          let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
          write(["id": "invalid", "outcome": "failed", "code": "invalid_request"])
          continue
        }
        write(executor.execute(request))
      }
    }

    private static func write(_ response: [String: Any]) {
      guard JSONSerialization.isValidJSONObject(response),
        let data = try? JSONSerialization.data(withJSONObject: response),
        data.count <= CredentialBrokerPolicy.maximumInputBytes
      else { exit(70) }
      FileHandle.standardOutput.write(data)
      FileHandle.standardOutput.write(Data([0x0a]))
    }
  }
#endif
