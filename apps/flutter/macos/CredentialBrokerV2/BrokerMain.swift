import CryptoKit
import Foundation
import LocalAuthentication
import Security

enum CredentialBrokerV2Policy {
  static let service = "app.omniagent.omniagent.credential-broker.v2"
  static let initializationMarker = "asael.credential_broker_initialization_v2"
  static let initializationMarkerValue = Data("asael.credential-broker.v2:fresh-sign-in-complete".utf8)
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
  static let allowedActions: Set<String> = ["probe", "read", "write", "delete"]
  static let maximumInputBytes = 512 * 1_024
  static let maximumValueBytes = 64 * 1_024
}

private enum BrokerV2Failure: Error {
  case invalidRequest
  case keychainUnavailable
  case interactionRequired
  case unreadableValue
  case targetUnknownKeys
  case initializationVerificationFailed
  case freshSignInRequired

  var code: String {
    switch self {
    case .invalidRequest: "invalid_request"
    case .keychainUnavailable: "secure_store_unavailable"
    case .interactionRequired: "secure_store_interaction_required"
    case .unreadableValue: "secure_store_unreadable"
    case .targetUnknownKeys: "secure_store_target_unknown_keys"
    case .initializationVerificationFailed: "secure_store_initialization_verification_failed"
    case .freshSignInRequired: "secure_store_fresh_sign_in_required"
    }
  }
}

protocol CredentialBackendV2 {
  func accounts(service: String) throws -> Set<String>
  func read(service: String, key: String, allowInteraction: Bool) throws -> Data?
  func write(service: String, key: String, value: Data) throws
  func delete(service: String, key: String, allowInteraction: Bool) throws
}

private struct KeychainBackendV2: CredentialBackendV2 {
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
      throw BrokerV2Failure.keychainUnavailable
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

  private func map(_ status: OSStatus) -> BrokerV2Failure {
    switch status {
    case errSecInteractionNotAllowed, errSecAuthFailed, errSecUserCanceled:
      .interactionRequired
    default:
      .keychainUnavailable
    }
  }
}

struct CredentialBrokerV2Executor {
  let backend: CredentialBackendV2

  func execute(_ request: [String: Any]) -> [String: Any] {
    let id = (request["id"] as? String) ?? "invalid"
    do {
      guard id.count >= 8, id.count <= 80,
        let action = request["action"] as? String
      else { throw BrokerV2Failure.invalidRequest }
      if action == "migrate" {
        guard request.count == 2 else { throw BrokerV2Failure.invalidRequest }
        throw BrokerV2Failure.freshSignInRequired
      }
      guard CredentialBrokerV2Policy.allowedActions.contains(action) else {
        throw BrokerV2Failure.invalidRequest
      }
      switch action {
      case "probe":
        guard request.count == 2 else { throw BrokerV2Failure.invalidRequest }
        let readiness = try readiness()
        return success(
          id,
          [
            "brokerVersion": "2.0.0+2",
            "state": readiness.initialized ? "ready" : "fresh_sign_in_required",
            "freshSignInRequired": !readiness.initialized,
            "migrationRequired": false,
            "targetItemCount": readiness.accounts.subtracting([
              CredentialBrokerV2Policy.initializationMarker
            ]).count,
          ])
      case "read":
        let key = try validatedKey(request, valueRequired: false)
        guard request.count == 3 else { throw BrokerV2Failure.invalidRequest }
        // A partial first-sign-in write must never be mistaken for a resumable
        // v1 session. Until v2 has committed its own marker, every read is empty.
        guard try readiness().initialized else {
          return success(id, ["value": NSNull()])
        }
        let data = try backend.read(
          service: CredentialBrokerV2Policy.service,
          key: key,
          allowInteraction: false
        )
        let value: Any
        if let data {
          guard data.count <= CredentialBrokerV2Policy.maximumValueBytes,
            let string = String(data: data, encoding: .utf8)
          else { throw BrokerV2Failure.unreadableValue }
          value = string
        } else {
          value = NSNull()
        }
        return success(id, ["value": value])
      case "write":
        let key = try validatedKey(request, valueRequired: true)
        guard request.count == 4, let value = request["value"] as? String,
          let data = value.data(using: .utf8),
          data.count <= CredentialBrokerV2Policy.maximumValueBytes
        else { throw BrokerV2Failure.invalidRequest }
        _ = try readiness()
        try verifiedWrite(key: key, value: data)
        if key == "asael.session_token" {
          try verifiedWrite(
            key: CredentialBrokerV2Policy.initializationMarker,
            value: CredentialBrokerV2Policy.initializationMarkerValue
          )
        }
        return success(id)
      case "delete":
        let key = try validatedKey(request, valueRequired: false)
        guard request.count == 3 else { throw BrokerV2Failure.invalidRequest }
        _ = try readiness()
        try backend.delete(
          service: CredentialBrokerV2Policy.service,
          key: key,
          allowInteraction: false
        )
        return success(id)
      default:
        throw BrokerV2Failure.invalidRequest
      }
    } catch let error as BrokerV2Failure {
      return failure(id, error.code)
    } catch {
      return failure(id, BrokerV2Failure.keychainUnavailable.code)
    }
  }

  private func readiness() throws -> (accounts: Set<String>, initialized: Bool) {
    let accounts = try backend.accounts(service: CredentialBrokerV2Policy.service)
    let allowed = CredentialBrokerV2Policy.allowedKeys.union([
      CredentialBrokerV2Policy.initializationMarker
    ])
    guard accounts.isSubset(of: allowed) else {
      throw BrokerV2Failure.targetUnknownKeys
    }
    guard accounts.contains(CredentialBrokerV2Policy.initializationMarker) else {
      return (accounts, false)
    }
    guard
      try backend.read(
        service: CredentialBrokerV2Policy.service,
        key: CredentialBrokerV2Policy.initializationMarker,
        allowInteraction: false
      ) == CredentialBrokerV2Policy.initializationMarkerValue
    else { throw BrokerV2Failure.initializationVerificationFailed }
    return (accounts, true)
  }

  private func verifiedWrite(key: String, value: Data) throws {
    try backend.write(service: CredentialBrokerV2Policy.service, key: key, value: value)
    guard
      try backend.read(
        service: CredentialBrokerV2Policy.service,
        key: key,
        allowInteraction: false
      ) == value
    else { throw BrokerV2Failure.initializationVerificationFailed }
  }

  private func validatedKey(_ request: [String: Any], valueRequired: Bool) throws -> String {
    guard let key = request["key"] as? String,
      CredentialBrokerV2Policy.allowedKeys.contains(key),
      !valueRequired || request["value"] is String
    else { throw BrokerV2Failure.invalidRequest }
    return key
  }

  private func success(_ id: String, _ values: [String: Any] = [:]) -> [String: Any] {
    ["id": id, "outcome": "succeeded"].merging(values) { _, new in new }
  }

  private func failure(_ id: String, _ code: String) -> [String: Any] {
    ["id": id, "outcome": "failed", "code": code]
  }
}

private enum ParentVerifierV2 {
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
  private enum CredentialBrokerV2Main {
    static func main() {
      guard ParentVerifierV2.verify() else { exit(77) }
      let executor = CredentialBrokerV2Executor(backend: KeychainBackendV2())
      while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
          data.count <= CredentialBrokerV2Policy.maximumInputBytes,
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
        data.count <= CredentialBrokerV2Policy.maximumInputBytes
      else { exit(70) }
      FileHandle.standardOutput.write(data)
      FileHandle.standardOutput.write(Data([0x0a]))
    }
  }
#endif
