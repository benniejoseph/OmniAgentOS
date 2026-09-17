import Darwin
import Foundation

@main
private enum FocusSafeSnapshotPolicyTests {
  private static let hostPID: pid_t = 410
  private static let chromePID: pid_t = 820
  private static let hostBundleIdentifier = "app.omniagent.omniagent"
  private static let chromeBundleIdentifier = "com.google.Chrome"

  static func main() {
    expect(
      disposition(
        currentPID: chromePID,
        currentBundleIdentifier: chromeBundleIdentifier,
        focusedWindowMatches: true
      ) == .alreadyFocused,
      "an unchanged target stays valid"
    )
    expect(
      disposition(
        currentPID: hostPID,
        currentBundleIdentifier: hostBundleIdentifier,
        focusedWindowMatches: false
      ) == .restoreFromTrustedHost,
      "the exact Asael host may restore the captured target after approval"
    )
    expect(
      disposition(
        currentPID: hostPID,
        currentBundleIdentifier: "app.omniagent.lookalike",
        focusedWindowMatches: false
      ) == .stale,
      "the host process must retain Asael's exact bundle identity"
    )
    expect(
      disposition(
        currentPID: 999,
        currentBundleIdentifier: hostBundleIdentifier,
        focusedWindowMatches: false
      ) == .stale,
      "a matching bundle identifier cannot substitute for the verified parent process"
    )
    expect(
      disposition(
        currentPID: 900,
        currentBundleIdentifier: "com.apple.mail",
        focusedWindowMatches: false
      ) == .stale,
      "an unrelated foreground application never triggers automatic restoration"
    )
    expect(
      disposition(
        currentPID: chromePID,
        currentBundleIdentifier: chromeBundleIdentifier,
        focusedWindowMatches: false
      ) == .stale,
      "a user-selected different window in the target application remains stale"
    )
    expect(
      disposition(
        currentPID: chromePID,
        currentBundleIdentifier: "com.google.Chrome.canary",
        focusedWindowMatches: true
      ) == .stale,
      "PID reuse with a different application identity remains stale"
    )

    let hostWindowDisposition = FocusSafeSnapshotPolicy.disposition(
      expectedPID: hostPID,
      expectedBundleIdentifier: hostBundleIdentifier,
      currentPID: hostPID,
      currentBundleIdentifier: hostBundleIdentifier,
      focusedWindowMatches: false,
      trustedHostPID: hostPID,
      trustedHostBundleIdentifier: hostBundleIdentifier
    )
    expect(
      hostWindowDisposition == .restoreFromTrustedHost,
      "Asael may restore its exact prior window when Inbox opened a separate approval window"
    )

    let capturedIdentity = SnapshotElementIdentity(
      role: "AXButton",
      subrole: nil,
      label: "Open chart",
      value: nil,
      frame: CGRect(x: 40, y: 60, width: 120, height: 36)
    )
    expect(
      capturedIdentity == SnapshotElementIdentity(
        role: "AXButton",
        subrole: nil,
        label: "Open chart",
        value: nil,
        frame: CGRect(x: 40, y: 60, width: 120, height: 36)
      ),
      "an exact refreshed accessibility identity remains eligible"
    )
    expect(
      capturedIdentity != SnapshotElementIdentity(
        role: "AXButton",
        subrole: nil,
        label: "Delete account",
        value: nil,
        frame: CGRect(x: 40, y: 60, width: 120, height: 36)
      ),
      "changed target content remains stale"
    )
    expect(
      capturedIdentity != SnapshotElementIdentity(
        role: "AXButton",
        subrole: nil,
        label: "Open chart",
        value: nil,
        frame: CGRect(x: 400, y: 600, width: 120, height: 36)
      ),
      "a moved target remains stale"
    )
  }

  private static func disposition(
    currentPID: pid_t?,
    currentBundleIdentifier: String?,
    focusedWindowMatches: Bool
  ) -> FocusSafeSnapshotDisposition {
    FocusSafeSnapshotPolicy.disposition(
      expectedPID: chromePID,
      expectedBundleIdentifier: chromeBundleIdentifier,
      currentPID: currentPID,
      currentBundleIdentifier: currentBundleIdentifier,
      focusedWindowMatches: focusedWindowMatches,
      trustedHostPID: hostPID,
      trustedHostBundleIdentifier: hostBundleIdentifier
    )
  }

  private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
      FileHandle.standardError.write(Data("FAILED: \(message)\n".utf8))
      exit(1)
    }
  }
}
