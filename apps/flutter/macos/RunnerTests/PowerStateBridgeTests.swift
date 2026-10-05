import AppKit
import Foundation
#if !POWER_STATE_POLICY_TESTS
import XCTest
@testable import omniagent
#endif

private enum PowerStateTestError: Error { case failed(String) }
private func checkPower(_ condition: @autoclosure () -> Bool, _ detail: String) throws {
  if !condition() { throw PowerStateTestError.failed(detail) }
}

private enum PowerStatePolicyCases {
  static func initialAndUnknown() throws {
    let application = NotificationCenter(), workspace = NotificationCenter()
    var enabled: Bool? = nil
    var reads = 0
    let monitor = PowerStateMonitor(readEnabled: { reads += 1; return enabled },
      applicationCenter: application, workspaceCenter: workspace)
    let stream = PowerStateSubscription(monitor: monitor)
    var states: [NativeLowPowerMode] = []
    try checkPower(!monitor.isObserving && reads == 0, "An unused bridge must not observe or read power")
    try checkPower(stream.listen { states.append($0) }, "Initial stream was refused")
    try checkPower(states == [.unknown] && reads == 1, "Initial unavailable state must remain unknown")
    enabled = false
    application.post(name: .NSProcessInfoPowerStateDidChange, object: nil)
    enabled = true
    application.post(name: .NSProcessInfoPowerStateDidChange, object: nil)
    enabled = nil
    application.post(name: .NSProcessInfoPowerStateDidChange, object: nil)
    try checkPower(states == [.unknown, .disabled, .enabled, .unknown], "Power transitions lost their exact state")
    let payload = NativeLowPowerMode.unknown.payload
    try checkPower(Set(payload.keys) == ["schemaVersion", "lowPowerMode"], "Power payload changed its contract")
    try checkPower(payload["schemaVersion"] as? Int == 1 && payload["lowPowerMode"] as? String == "unknown", "Unknown payload is not explicit")
    stream.detach()
  }

  static func independentEngines() throws {
    let application = NotificationCenter(), workspace = NotificationCenter()
    var enabled: Bool? = false
    var reads = 0
    let monitor = PowerStateMonitor(readEnabled: { reads += 1; return enabled },
      applicationCenter: application, workspaceCenter: workspace)
    let primary = PowerStateSubscription(monitor: monitor), auxiliary = PowerStateSubscription(monitor: monitor)
    var mainStates: [NativeLowPowerMode] = [], auxiliaryStates: [NativeLowPowerMode] = []
    _ = primary.listen { mainStates.append($0) }
    enabled = true
    _ = auxiliary.listen { auxiliaryStates.append($0) }
    try checkPower(mainStates == [.disabled] && auxiliaryStates == [.enabled], "Each engine needs its own fresh handshake")
    primary.cancel()
    try checkPower(monitor.isObserving, "Cancelling one engine stopped another engine's observer")
    enabled = false
    application.post(name: .NSProcessInfoPowerStateDidChange, object: nil)
    try checkPower(mainStates == [.disabled] && auxiliaryStates == [.enabled, .disabled], "Cancelled engine received an event or live engine missed it")
    enabled = true
    try checkPower(primary.listen { mainStates.append($0) }, "A cancelled stream could not resume")
    try checkPower(mainStates == [.disabled, .enabled], "Resume reused an obsolete snapshot")
    auxiliary.detach()
    try checkPower(!auxiliary.listen { auxiliaryStates.append($0) }, "Detached engine subscribed again")
    enabled = nil
    application.post(name: .NSProcessInfoPowerStateDidChange, object: nil)
    try checkPower(mainStates.last == .unknown && auxiliaryStates == [.enabled, .disabled], "Detach did not isolate a closed engine")
    primary.detach()
    try checkPower(!monitor.isObserving, "Last client detach left process observers alive")
    let before = reads
    application.post(name: .NSProcessInfoPowerStateDidChange, object: nil)
    workspace.post(name: NSWorkspace.didWakeNotification, object: nil)
    try checkPower(reads == before, "Power was read with no clients")
  }

  static func foregroundAndWake() throws {
    let application = NotificationCenter(), workspace = NotificationCenter()
    var enabled: Bool? = false
    let monitor = PowerStateMonitor(readEnabled: { enabled }, applicationCenter: application, workspaceCenter: workspace)
    let stream = PowerStateSubscription(monitor: monitor)
    var states: [NativeLowPowerMode] = []
    _ = stream.listen { states.append($0) }
    enabled = true
    application.post(name: NSApplication.didBecomeActiveNotification, object: nil)
    enabled = false
    workspace.post(name: NSWorkspace.didWakeNotification, object: nil)
    enabled = nil
    workspace.post(name: NSWorkspace.sessionDidBecomeActiveNotification, object: nil)
    try checkPower(states == [.disabled, .enabled, .disabled, .unknown], "Foreground or wake used cached power instead of rereading")
    stream.detach()
  }

  static func replacementAndImmediateCancellation() throws {
    let application = NotificationCenter(), workspace = NotificationCenter()
    var enabled: Bool? = false
    let monitor = PowerStateMonitor(readEnabled: { enabled }, applicationCenter: application, workspaceCenter: workspace)
    let stream = PowerStateSubscription(monitor: monitor)
    var oldStates: [NativeLowPowerMode] = [], newStates: [NativeLowPowerMode] = []
    _ = stream.listen { oldStates.append($0) }
    enabled = true
    _ = stream.listen { newStates.append($0) }
    enabled = false
    application.post(name: .NSProcessInfoPowerStateDidChange, object: nil)
    try checkPower(oldStates == [.disabled] && newStates == [.enabled, .disabled], "Replacing a subscription retained the old sink")
    stream.cancel()
    _ = stream.listen { _ in stream.cancel() }
    try checkPower(!monitor.isObserving, "Cancellation during initial delivery leaked the observer")
    stream.detach()
  }

  static func stopAndRelease() throws {
    let application = NotificationCenter(), workspace = NotificationCenter()
    var reads = 0, events = 0
    var monitor: PowerStateMonitor? = PowerStateMonitor(readEnabled: { reads += 1; return false },
      applicationCenter: application, workspaceCenter: workspace)
    weak var released = monitor
    monitor!.listen(id: UUID()) { _ in events += 1 }
    monitor!.stop()
    try checkPower(!monitor!.isObserving, "Termination left process observers registered")
    application.post(name: .NSProcessInfoPowerStateDidChange, object: nil)
    try checkPower(reads == 1 && events == 1, "Stopped bridge still delivered events")
    monitor!.listen(id: UUID()) { _ in events += 1 }
    monitor = nil
    try checkPower(released == nil, "Notification center retained the monitor")
    workspace.post(name: NSWorkspace.didWakeNotification, object: nil)
    try checkPower(reads == 2 && events == 2, "Released bridge still delivered events")
  }
}

#if POWER_STATE_POLICY_TESTS
@main
private enum PowerStatePolicyRunner {
  static func main() throws {
    try PowerStatePolicyCases.initialAndUnknown()
    try PowerStatePolicyCases.independentEngines()
    try PowerStatePolicyCases.foregroundAndWake()
    try PowerStatePolicyCases.replacementAndImmediateCancellation()
    try PowerStatePolicyCases.stopAndRelease()
    print("Power state policy cases passed (5)")
  }
}
#else
final class PowerStateBridgeTests: XCTestCase {
  private func onMain(_ operation: () throws -> Void) rethrows {
    if Thread.isMainThread { try operation() }
    else { try DispatchQueue.main.sync(execute: operation) }
  }

  func testInitialAndUnknownStates() throws { try onMain { try PowerStatePolicyCases.initialAndUnknown() } }
  func testIndependentEngineLifetimes() throws { try onMain { try PowerStatePolicyCases.independentEngines() } }
  func testForegroundAndWakeReread() throws { try onMain { try PowerStatePolicyCases.foregroundAndWake() } }
  func testReplacementAndImmediateCancellation() throws { try onMain { try PowerStatePolicyCases.replacementAndImmediateCancellation() } }
  func testStopAndRelease() throws { try onMain { try PowerStatePolicyCases.stopAndRelease() } }
}
#endif
