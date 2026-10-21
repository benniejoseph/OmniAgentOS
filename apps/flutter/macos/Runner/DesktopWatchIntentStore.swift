import Foundation

/// A click carries only a destination, never authority. Keep it through cold
/// launch or local lock until the matching owner has opened it successfully.
final class DesktopWatchIntentStore {
  static let key = "AsaelPendingWatchIntentsV1"
  private let defaults: UserDefaults
  private let synchronize: () -> Bool
  private let now: () -> Date
  init(defaults: UserDefaults = .standard, now: @escaping () -> Date = Date.init,
       synchronize: (() -> Bool)? = nil) {
    self.defaults = defaults; self.now = now
    self.synchronize = synchronize ?? { defaults.synchronize() }
  }
  static func validScope(_ value: String) -> Bool {
    value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) == value.startIndex..<value.endIndex
  }
  static func validWatch(_ value: String) -> Bool {
    value.range(of: "^watch_[a-f0-9]{48}$", options: .regularExpression) == value.startIndex..<value.endIndex
  }
  private func load() -> [[String: Any]] {
    (defaults.array(forKey: Self.key) ?? []).compactMap { value in
      guard let item = value as? [String: Any], item.count == 4,
            let id = item["id"] as? String, UUID(uuidString: id) != nil,
            let scope = item["scope"] as? String, Self.validScope(scope),
            let watch = item["watchId"] as? String, Self.validWatch(watch),
            let time = item["createdAt"] as? Date,
            time <= now(), now().timeIntervalSince(time) < 86_400 else { return nil }
      return item
    }
  }
  func enqueue(scope: String, watchId: String) -> Bool {
    guard Self.validScope(scope), Self.validWatch(watchId) else { return false }
    let previous = load()
    if previous.contains(where: { $0["scope"] as? String == scope && $0["watchId"] as? String == watchId }) { return true }
    guard previous.count < 32 else { return false }
    let id = UUID().uuidString.lowercased()
    defaults.set(previous + [["id": id, "scope": scope, "watchId": watchId, "createdAt": now()]], forKey: Self.key)
    guard synchronize(), load().contains(where: { $0["id"] as? String == id }) else {
      defaults.set(previous, forKey: Self.key); _ = synchronize(); return false
    }
    return true
  }
  func first(scope: String) -> [String: Any]? { load().first(where: { $0["scope"] as? String == scope }) }
  @discardableResult
  func remove(id: String) -> Bool {
    let previous = load()
    defaults.set(previous.filter { $0["id"] as? String != id }, forKey: Self.key)
    guard synchronize() else {
      defaults.set(previous, forKey: Self.key); _ = synchronize(); return false
    }
    return true
  }
}
