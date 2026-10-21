import Foundation
import CoreFoundation

/// Shared by all Flutter engines. An old owner or stale unlock cannot release
/// a newer lock, replace another owner, or clear a newer session.
private enum DesktopSessionProtectionError: Error { case staleOrInvalid }

final class DesktopSessionProtectionState {
  private(set) var epoch = 0
  private(set) var sessionEpoch = 0
  private(set) var scope: String?
  private(set) var locked = false
  private(set) var ended = false
  private var biometricEnabled = false
  var payload: [String: Any] {
    ["schemaVersion": 1, "epoch": epoch, "sessionEpoch": sessionEpoch, "biometricEnabled": biometricEnabled, "scope": scope as Any? ?? NSNull(), "locked": locked, "ended": ended]
  }
  func protectForSystemEvent() -> Bool {
    guard biometricEnabled, !ended else { return false }
    // A later OS lock/sleep must invalidate authentication that began while
    // the app was already locked. The caller deduplicates lifecycle events.
    locked = true; epoch += 1; return true
  }
  func change(_ value: Any?) throws -> [String: Any] {
    guard let values = value as? [String: Any],
          let expected = values["epoch"] as? NSNumber,
          CFGetTypeID(expected) != CFBooleanGetTypeID(), expected.intValue == epoch,
          expected.doubleValue == Double(epoch),
          let action = values["action"] as? String,
          (values["expectedScope"] is NSNull && scope == nil) || values["expectedScope"] as? String == scope
    else { throw DesktopSessionProtectionError.staleOrInvalid }
    let base: Set<String> = ["action", "epoch", "expectedScope"]
    switch action {
    case "bind":
      guard Set(values.keys) == base.union(["scope", "biometricEnabled"]),
            let next = values["scope"] as? String,
            next.range(of: "^[a-f0-9]{64}$", options: .regularExpression) == next.startIndex..<next.endIndex,
            !ended, scope == nil || scope == next,
            let enabled = values["biometricEnabled"] as? Bool else { throw DesktopSessionProtectionError.staleOrInvalid }
      if scope != next || biometricEnabled != enabled {
        scope = next; biometricEnabled = enabled; ended = false
        if !enabled { locked = false }
        epoch += 1
      }
    case "lock", "unlock", "end", "replace":
      guard Set(values.keys) == base else { throw DesktopSessionProtectionError.staleOrInvalid }
      switch action {
      case "lock":
        if biometricEnabled && !ended && !locked { locked = true; epoch += 1 }
      case "unlock":
        guard !ended else { throw DesktopSessionProtectionError.staleOrInvalid }
        if locked { locked = false; epoch += 1 }
      case "end":
        if !ended { ended = true; locked = true; epoch += 1; sessionEpoch += 1 }
      default:
        scope = nil; ended = false; locked = false; biometricEnabled = false
        epoch += 1; sessionEpoch += 1
      }
    default: throw DesktopSessionProtectionError.staleOrInvalid
    }
    return payload
  }
}

#if !SESSION_PROTECTION_POLICY_TESTS
import FlutterMacOS
final class DesktopSessionProtectionController {
  private let state = DesktopSessionProtectionState()
  private var channels: [ObjectIdentifier: FlutterMethodChannel] = [:]
  func attach(to messenger: FlutterBinaryMessenger) -> FlutterMethodChannel {
    let channel = FlutterMethodChannel(name: "app.omniagent.omniagent/session-protection", binaryMessenger: messenger)
    channels[ObjectIdentifier(channel)] = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { result(FlutterError(code: "session_protection_unavailable", message: nil, details: nil)); return }
      if call.method == "snapshot", call.arguments == nil { result(self.state.payload); return }
      guard call.method == "change" else { result(FlutterMethodNotImplemented); return }
      do {
        let before = self.state.epoch
        let value = try self.state.change(call.arguments)
        if before != self.state.epoch { self.broadcast() }
        result(value)
      } catch { result(FlutterError(code: "session_protection_changed", message: "The current session or lock changed. Try again.", details: nil)) }
    }
    return channel
  }
  func acceptsCredentialEpoch(_ value: Int) -> Bool { state.sessionEpoch == value }
  func detach(_ channel: FlutterMethodChannel) {
    channels.removeValue(forKey: ObjectIdentifier(channel))
    channel.setMethodCallHandler(nil)
  }
  func protectForSystemEvent() {
    if state.protectForSystemEvent() { broadcast() }
  }
  private func broadcast() {
    for channel in channels.values { channel.invokeMethod("changed", arguments: state.payload) }
  }
}
#endif
