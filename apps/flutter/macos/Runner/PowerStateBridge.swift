import AppKit
import Foundation

enum NativeLowPowerMode: String {
  case enabled
  case disabled
  case unknown

  init(_ enabled: Bool?) {
    switch enabled {
    case true?: self = .enabled
    case false?: self = .disabled
    case nil: self = .unknown
    }
  }

  var payload: [String: Any] {
    ["schemaVersion": 1, "lowPowerMode": rawValue]
  }
}

/// One process reader, observed only while an engine has an active listener.
/// All reads and deliveries share the main queue; notifications carry no state.
final class PowerStateMonitor {
  private let readEnabled: () -> Bool?
  private let applicationCenter: NotificationCenter
  private let workspaceCenter: NotificationCenter
  private var listeners: [UUID: (NativeLowPowerMode) -> Void] = [:]
  private var observations: [(NotificationCenter, NSObjectProtocol)] = []

  init(
    readEnabled: @escaping () -> Bool? = { ProcessInfo.processInfo.isLowPowerModeEnabled },
    applicationCenter: NotificationCenter = .default,
    workspaceCenter: NotificationCenter = NSWorkspace.shared.notificationCenter
  ) {
    self.readEnabled = readEnabled
    self.applicationCenter = applicationCenter
    self.workspaceCenter = workspaceCenter
  }

  var isObserving: Bool { !observations.isEmpty }

  func listen(id: UUID, receive: @escaping (NativeLowPowerMode) -> Void) {
    dispatchPrecondition(condition: .onQueue(.main))
    listeners[id] = receive
    if observations.isEmpty { startObserving() }
    // Install observers before reading so a subscription starts with a fresh
    // state and cannot miss a power change between its read and registration.
    receive(NativeLowPowerMode(readEnabled()))
  }

  func cancel(id: UUID) {
    dispatchPrecondition(condition: .onQueue(.main))
    listeners.removeValue(forKey: id)
    if listeners.isEmpty { removeObservers() }
  }

  func stop() {
    dispatchPrecondition(condition: .onQueue(.main))
    listeners.removeAll()
    removeObservers()
  }

  private func startObserving() {
    observe(applicationCenter, .NSProcessInfoPowerStateDidChange)
    observe(applicationCenter, NSApplication.didBecomeActiveNotification)
    observe(workspaceCenter, NSWorkspace.didWakeNotification)
    observe(workspaceCenter, NSWorkspace.sessionDidBecomeActiveNotification)
  }

  private func observe(_ center: NotificationCenter, _ name: Notification.Name) {
    let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
      self?.refresh()
    }
    observations.append((center, token))
  }

  private func refresh() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard !listeners.isEmpty else { return }
    let state = NativeLowPowerMode(readEnabled())
    for id in Array(listeners.keys) { listeners[id]?(state) }
  }

  private func removeObservers() {
    for (center, token) in observations { center.removeObserver(token) }
    observations.removeAll()
  }

  deinit { removeObservers() }
}

/// A cancelled stream may subscribe again; a detached engine never may.
final class PowerStateSubscription {
  private let monitor: PowerStateMonitor
  private let id = UUID()
  private var attached = true

  init(monitor: PowerStateMonitor) { self.monitor = monitor }

  func listen(_ receive: @escaping (NativeLowPowerMode) -> Void) -> Bool {
    dispatchPrecondition(condition: .onQueue(.main))
    guard attached else { return false }
    monitor.listen(id: id, receive: receive)
    return true
  }

  func cancel() {
    dispatchPrecondition(condition: .onQueue(.main))
    monitor.cancel(id: id)
  }

  func detach() {
    dispatchPrecondition(condition: .onQueue(.main))
    attached = false
    cancel()
  }
}

#if !POWER_STATE_POLICY_TESTS
import FlutterMacOS

private final class PowerStateStreamHandler: NSObject, FlutterStreamHandler {
  private let subscription: PowerStateSubscription

  init(monitor: PowerStateMonitor) { subscription = PowerStateSubscription(monitor: monitor) }

  func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
    guard arguments == nil || arguments is NSNull else {
      return FlutterError(code: "power_state_invalid", message: "Power state takes no arguments.", details: nil)
    }
    guard subscription.listen({ events($0.payload) }) else {
      return FlutterError(code: "power_state_unavailable", message: "Power state is unavailable.", details: nil)
    }
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    subscription.cancel()
    return nil
  }

  func detach() { subscription.detach() }
}

final class PowerStateBridgeController {
  static let channelName = "app.omniagent.omniagent/power-state/events"
  private let monitor = PowerStateMonitor()
  private var bindings: [ObjectIdentifier: (FlutterEventChannel, PowerStateStreamHandler)] = [:]

  func attach(to messenger: FlutterBinaryMessenger) -> FlutterEventChannel {
    dispatchPrecondition(condition: .onQueue(.main))
    let channel = FlutterEventChannel(name: Self.channelName, binaryMessenger: messenger)
    let handler = PowerStateStreamHandler(monitor: monitor)
    bindings[ObjectIdentifier(channel)] = (channel, handler)
    channel.setStreamHandler(handler)
    return channel
  }

  func detach(_ channel: FlutterEventChannel) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard let (_, handler) = bindings.removeValue(forKey: ObjectIdentifier(channel)) else { return }
    handler.detach()
    channel.setStreamHandler(nil)
  }

  func stop() {
    dispatchPrecondition(condition: .onQueue(.main))
    for (channel, _) in Array(bindings.values) { detach(channel) }
    monitor.stop()
  }
}
#endif
