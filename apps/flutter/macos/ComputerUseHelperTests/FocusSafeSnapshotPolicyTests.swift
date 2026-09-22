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

    let revision = String(repeating: "a", count: 64)
    let screenshotMapping = ScreenshotCoordinateMapping(
      snapshotRevision: revision,
      displayID: 42,
      displayLogicalBounds: CGRect(x: -1512, y: 0, width: 1512, height: 945),
      imageWidth: 1440,
      imageHeight: 900
    )
    expect(screenshotMapping != nil, "a finite display-to-image mapping is valid")
    expect(
      screenshotMapping?.logicalPointsPerPixelX == 1.05
        && screenshotMapping?.logicalPointsPerPixelY == 1.05,
      "the mapping derives an independent logical-point scale for each image axis"
    )
    let mappedCenter = screenshotMapping?.globalLogicalPoint(
      screenshotX: 720,
      screenshotY: 450,
      revision: revision
    )
    expect(
      mappedCenter == CGPoint(x: -756, y: 472.5),
      "Retina/downscaled screenshot pixels map into negative-origin global logical space"
    )
    expect(
      screenshotMapping?.globalLogicalPoint(
        screenshotX: 1,
        screenshotY: 1,
        revision: String(repeating: "b", count: 64)
      ) == nil,
      "a screenshot coordinate cannot cross snapshot revisions"
    )
    for refusedPoint in [
      CGPoint(x: -1, y: 1),
      CGPoint(x: 1, y: -1),
      CGPoint(x: 1440, y: 1),
      CGPoint(x: 1, y: 900),
    ] {
      expect(
        screenshotMapping?.globalLogicalPoint(
          screenshotX: refusedPoint.x,
          screenshotY: refusedPoint.y,
          revision: revision
        ) == nil,
        "a screenshot click must remain inside the exact captured image"
      )
    }
    expect(
      ScreenshotCoordinateMapping(
        snapshotRevision: revision,
        displayID: 0,
        displayLogicalBounds: CGRect(x: 0, y: 0, width: 100, height: 100),
        imageWidth: 100,
        imageHeight: 100
      ) == nil,
      "an unidentified display cannot authorize image-coordinate clicks"
    )
    expect(
      sanitizedLocalComputerText("A\u{0000}B\u{001f}C\u{007f}D", limit: 7)
        == "A B C D",
      "untrusted accessibility controls are normalized before JSON size accounting"
    )
    expect(
      SafeBrowserNavigationPolicy.bundleIdentifier(for: "chrome")
        == chromeBundleIdentifier,
      "only the known Chrome browser key resolves to its exact bundle identity"
    )
    expect(
      SafeBrowserNavigationPolicy.bundleIdentifier(for: "terminal") == nil,
      "terminal never resolves as a browser target"
    )
    expect(
      SafeBrowserNavigationPolicy.effectVerdict(browserObservationConfirmed: true)
        == "confirmed",
      "accepted delivery is confirmed only when the exact browser is frontmost"
    )
    expect(
      SafeBrowserNavigationPolicy.effectVerdict(browserObservationConfirmed: false)
        == "unverifiable",
      "a focus mismatch never becomes a false success claim"
    )
    expect(
      SafeBrowserNavigationPolicy.matchesExpectedApplication(
        expectedPID: chromePID,
        expectedBundleIdentifier: chromeBundleIdentifier,
        observedPID: chromePID,
        observedBundleIdentifier: chromeBundleIdentifier
      ),
      "post-navigation observation is bound to the exact opened browser process"
    )
    expect(
      !SafeBrowserNavigationPolicy.matchesExpectedApplication(
        expectedPID: chromePID,
        expectedBundleIdentifier: chromeBundleIdentifier,
        observedPID: 900,
        observedBundleIdentifier: "com.apple.mail"
      ),
      "post-navigation observation refuses an unrelated foreground application"
    )
    expect(
      !SafeBrowserNavigationPolicy.matchesExpectedApplication(
        expectedPID: chromePID,
        expectedBundleIdentifier: chromeBundleIdentifier,
        observedPID: chromePID,
        observedBundleIdentifier: "com.google.Chrome.canary"
      ),
      "post-navigation observation requires the expected browser bundle identity"
    )
    expect(
      SnapshotPixelHitPolicy.disposition(
        hitFound: true,
        hitBelongsToSnapshot: true,
        identityMatches: true
      ) == .exactSnapshotElement,
      "a live z-order hit is accepted only when its exact identity remains in the snapshot"
    )
    expect(
      SnapshotPixelHitPolicy.disposition(
        hitFound: true,
        hitBelongsToSnapshot: false,
        identityMatches: false
      ) == .refuse,
      "a newly covering overlay that was not in the snapshot is refused"
    )
    expect(
      SnapshotPixelHitPolicy.disposition(
        hitFound: true,
        hitBelongsToSnapshot: true,
        identityMatches: false
      ) == .refuse,
      "a changed live hit identity is refused instead of clicking through"
    )
    expect(
      SafeBrowserNavigationPolicy.validatedURL(
        "https://in.tradingview.com/chart/example?symbol=OANDA%3AXAUUSD"
      ) != nil,
      "an absolute credential-free HTTPS URL is accepted"
    )
    for refused in [
      "file:///private/etc/hosts",
      "javascript:alert(1)",
      "data:text/plain,secret",
      "https://user:secret@example.test/chart",
      "https://localhost/chart",
      "https://asael.localhost/chart",
      "http://127.0.0.1:3000/admin",
      "http://2130706433/admin",
      "http://0x7f000001/admin",
      "http://0x7f.1/admin",
      "http://0177.0.0.1/admin",
      "http://127.1/admin",
      "http://169.254.169.254/latest/meta-data",
      "http://10.10.0.4/internal",
      "http://172.20.0.4/internal",
      "http://192.168.1.4/internal",
      "http://100.64.0.1/internal",
      "http://[::1]/internal",
      "http://[fe80::1]/internal",
      "http://[fc00::1]/internal",
      "http://[2001:db8::1]/documentation",
      "https://example.test/unsafe path",
      "https:\\example.test\\chart",
      " https://example.test",
    ] {
      expect(
        SafeBrowserNavigationPolicy.validatedURL(refused) == nil,
        "unsafe or non-web navigation is refused: \(refused)"
      )
    }
    for accepted in [
      "https://8.8.8.8/",
      "https://[2606:4700:4700::1111]/",
      "https://example.com/",
    ] {
      expect(
        SafeBrowserNavigationPolicy.validatedURL(accepted) != nil,
        "a public browser destination is accepted: \(accepted)"
      )
    }
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
