import CoreGraphics
import Darwin
import Foundation

@main
private enum InputDeliveryPolicyTests {
  static func main() {
    frontmostWindow()
    unreadableWindows()
    windowEdges()
    chosenElement()
    parentLoops()
    windowInspectionKeepsDenials()
    boundedClickDiagnostic()
    sanitizedClickDiagnostic()
    diagnosticStagesAndFailureOnly()
    print("Input delivery policy cases passed (9)")
  }

  private static let observedApp: pid_t = 501
  private static let host: pid_t = 4_242

  private static func window(
    _ pid: pid_t?,
    _ bounds: CGRect?,
    alpha: Double? = 1
  ) -> [String: Any] {
    var description: [String: Any] = [:]
    if let pid { description[kCGWindowOwnerPID as String] = NSNumber(value: pid) }
    if let bounds { description[kCGWindowBounds as String] = bounds.dictionaryRepresentation }
    if let alpha { description[kCGWindowAlpha as String] = NSNumber(value: alpha) }
    return description
  }

  private static func owner(_ x: CGFloat, _ y: CGFloat, _ windows: [[String: Any]]) -> pid_t? {
    InputDeliveryPolicy.windowOwner(at: CGPoint(x: x, y: y), windows: windows)
  }

  private static let appWindow = CGRect(x: 100, y: 50, width: 800, height: 600)

  private static func frontmostWindow() {
    expect(
      owner(400, 400, [window(observedApp, appWindow)]) == observedApp,
      "the observed app's window takes a click inside it"
    )
    let floating = window(host, CGRect(x: 350, y: 300, width: 200, height: 200))
    expect(
      owner(400, 400, [floating, window(observedApp, appWindow)]) == host,
      "a floating window over the point takes the click"
    )
    expect(
      owner(200, 400, [floating, window(observedApp, appWindow)]) == observedApp,
      "a window above that misses the point is passed over"
    )
    expect(
      owner(400, 400, [window(host, appWindow, alpha: 0), window(observedApp, appWindow)])
        == observedApp,
      "a fully transparent window is passed over"
    )
    expect(
      owner(400, 400, [window(host, appWindow, alpha: nil), window(observedApp, appWindow)])
        == host,
      "a window without an alpha counts as opaque"
    )
    expect(
      owner(400, 400, [window(observedApp, appWindow), window(host, appWindow)]) == observedApp,
      "the first window listed over the point wins"
    )
    expect(owner(400, 400, []) == nil, "no window answers no owner")
    expect(
      owner(50, 400, [window(observedApp, appWindow)]) == nil,
      "a point outside every window answers no owner"
    )
  }

  private static func unreadableWindows() {
    expect(
      owner(400, 400, [window(host, nil), window(observedApp, appWindow)]) == nil,
      "a window above without bounds refuses the click"
    )
    let malformed: [String: Any] = [
      kCGWindowOwnerPID as String: NSNumber(value: host),
      kCGWindowBounds as String: ["X": "wide"] as NSDictionary,
    ]
    expect(
      owner(400, 400, [malformed, window(observedApp, appWindow)]) == nil,
      "a window above with unreadable bounds refuses the click"
    )
    expect(
      owner(400, 400, [window(nil, appWindow)]) == nil,
      "a window without an owner refuses the click"
    )
  }

  private static func windowEdges() {
    let windows = [window(observedApp, appWindow)]
    expect(owner(100, 50, windows) == observedApp, "a window's top-left corner is inside it")
    expect(owner(99.5, 400, windows) == nil, "a point left of a window is outside it")
    expect(owner(400, 49.5, windows) == nil, "a point above a window is outside it")
    expect(owner(900, 400, windows) == nil, "a window's right edge is outside it")
    expect(owner(400, 650, windows) == nil, "a window's bottom edge is outside it")
    expect(owner(899.5, 649.5, windows) == observedApp, "the last point before the edges is inside")
  }

  private static func within(
    _ target: Int,
    _ chosen: Int,
    _ parents: [Int: Int],
    limit: Int = 16
  ) -> Bool {
    InputDeliveryPolicy.isWithin(
      target,
      chosen: chosen,
      limit: limit,
      parent: { parents[$0] },
      same: { $0 == $1 }
    )
  }

  private static func chosenElement() {
    // A chain in which each element's parent is the next number down: 0 is the
    // window, and larger numbers sit deeper inside it.
    let chain = Dictionary(uniqueKeysWithValues: (1...40).map { ($0, $0 - 1) })
    expect(within(7, 7, chain), "the chosen element itself is within it")
    expect(within(8, 7, chain), "a child of the chosen element is within it")
    expect(within(23, 7, chain), "a descendant sixteen levels down is within it")
    expect(!within(24, 7, chain), "a descendant seventeen levels down is refused")
    expect(!within(6, 7, chain), "an ancestor of the chosen element is not within it")
    expect(!within(3, 7, chain, limit: 0), "a zero limit accepts only the chosen element")
    expect(within(7, 7, chain, limit: 0), "a zero limit still accepts the chosen element")
    let siblings = [1: 0, 2: 0, 3: 1]
    expect(!within(2, 1, siblings), "a sibling of the chosen element is not within it")
    expect(!within(3, 2, siblings), "a sibling's child is not within the chosen element")
    expect(!within(9, 7, [:]), "an element without a parent is not within another")
  }

  private static func parentLoops() {
    expect(!within(5, 7, [5: 5]), "an element that is its own parent is within no other")
    expect(!within(5, 7, [5: 6, 6: 5]), "a two-element parent loop ends within the limit")
    expect(within(5, 6, [5: 6, 6: 5]), "a loop still finds the chosen element on its way")
  }

  private static func windowInspectionKeepsDenials() {
    let point = CGPoint(x: 400, y: 400)
    var overlay = window(host, appWindow, alpha: 0.0001)
    overlay[kCGWindowLayer as String] = NSNumber(value: 1_001)
    var inspection = InputDeliveryPolicy.inspectWindow(
      at: point, windows: [overlay, window(observedApp, appWindow)]
    )
    expect(inspection.lookup == .ownerFound && inspection.ownerPID == host,
           "diagnostics do not bypass high-layer or almost transparent covering windows")
    expect(inspection.layer == 1_001 && inspection.alpha == 0.0001,
           "only the selected covering window supplies its layer and alpha")
    overlay[kCGWindowAlpha as String] = NSNumber(value: 0)
    inspection = InputDeliveryPolicy.inspectWindow(
      at: point, windows: [overlay, window(observedApp, appWindow, alpha: nil)]
    )
    expect(inspection.ownerPID == observedApp && inspection.alpha == 1 && inspection.alphaDefaulted,
           "fully transparent windows are still skipped and missing alpha still defaults to opaque")
    inspection = InputDeliveryPolicy.inspectWindow(
      at: point, windows: [window(host, nil, alpha: 0), window(observedApp, appWindow)]
    )
    expect(inspection.lookup == .boundsUnavailable && inspection.ownerPID == nil,
           "unreadable bounds still refuse even when a window claims zero alpha")
    inspection = InputDeliveryPolicy.inspectWindow(at: point, windows: [window(nil, appWindow)])
    expect(inspection.lookup == .ownerUnavailable && inspection.ownerPID == nil,
           "an unreadable owner remains a refusal with a distinct diagnostic")
    inspection = InputDeliveryPolicy.inspectWindow(at: point, windows: [])
    expect(inspection.lookup == .noWindow && inspection.ownerPID == nil,
           "an empty window list remains a refusal with a distinct diagnostic")
  }

  private static let commandID = "local_computer_command_" + String(repeating: "a", count: 48)

  private static func diagnosticJSON(_ diagnostic: ClickFailureDiagnostic) -> [String: Any] {
    guard let encoded = diagnostic.encoded(commandID: commandID, action: "click",
                                           errorCode: "click_target_covered"),
          let bytes = encoded.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]
    else { fail("the bounded diagnostic did not encode") }
    expect(bytes.count <= ClickFailureDiagnostic.maximumEncodedBytes, "the local log record stays bounded")
    return json
  }

  private static func boundedClickDiagnostic() {
    let point = CGPoint(x: 12.3456, y: 55.6789)
    var overlay = window(host, CGRect(x: -800, y: -200, width: 1_200, height: 1_000), alpha: 0.25)
    overlay[kCGWindowLayer as String] = NSNumber(value: 25)
    overlay[kCGWindowName as String] = "PRIVATE_TITLE_MUST_NOT_BE_LOGGED"
    let inspection = InputDeliveryPolicy.inspectWindow(
      at: point, windows: [overlay, window(observedApp, appWindow)]
    )
    let diagnostic = ClickFailureDiagnostic(
      reason: .coveringWindow, expectedPID: observedApp,
      expectedBundleIdentifier: "com.google.Chrome", point: point,
      displayBounds: CGRect(x: 0, y: 0, width: 1_000, height: 700),
      window: inspection, coveringBundleIdentifier: "app.omniagent.omniagent"
    )
    let json = diagnosticJSON(diagnostic)
    expect(Set(json.keys) == Set(["schemaVersion", "commandId", "errorCode", "stage", "reason",
                                 "expectedApplication", "point", "topWindow"]),
           "the record has only the fixed content-free diagnostic fields")
    expect(json["commandId"] as? String == commandID && json["errorCode"] as? String == "click_target_covered",
           "the diagnostic correlates with the original command and unchanged refusal")
    expect(json["stage"] as? String == "window_owner" && json["reason"] as? String == "covering_window",
           "the covering-window stage is unambiguous")
    let expected = json["expectedApplication"] as? [String: Any]
    expect(expected?["pid"] as? Int == Int(observedApp)
      && expected?["bundleIdentifier"] as? String == "com.google.Chrome", "expected process identity is retained")
    let recordedPoint = json["point"] as? [String: Any]
    expect(recordedPoint?["x"] as? Double == 12.35 && recordedPoint?["y"] as? Double == 55.68,
           "point metadata is rounded to hundredths of a logical point")
    let top = json["topWindow"] as? [String: Any]
    expect(Set(top?.keys.map { $0 } ?? []) == Set(["ownerPID", "ownerBundleIdentifier", "layer", "alpha",
                                                "alphaDefaulted", "displayClippedFrame"]),
           "only the first relevant window's allowlisted metadata is recorded")
    expect(top?["ownerPID"] as? Int == Int(host) && top?["layer"] as? Int == 25
      && top?["alpha"] as? Double == 0.25, "covering process, layer and opacity remain inspectable")
    let clipped = top?["displayClippedFrame"] as? [String: Double]
    expect(clipped == ["x": 0, "y": 0, "width": 400, "height": 700],
           "window geometry is clipped to the single captured display")
    let encoded = diagnostic.encoded(commandID: commandID, action: "click", errorCode: "click_target_covered")!
    expect(!encoded.contains("PRIVATE_TITLE") && !encoded.contains("windows"),
           "window titles and a broad window inventory never enter the log")
  }

  private static func sanitizedClickDiagnostic() {
    var diagnostic = ClickFailureDiagnostic(
      reason: .coveringWindow, expectedPID: -1,
      expectedBundleIdentifier: "com.private\nSECRET", point: CGPoint(x: CGFloat.infinity, y: CGFloat.nan),
      displayBounds: CGRect(x: 0, y: 0, width: 1_000, height: 700),
      window: InputDeliveryPolicy.WindowInspection(
        lookup: .ownerFound, ownerPID: 0,
        bounds: CGRect(x: -100, y: 0, width: CGFloat.infinity, height: 100),
        layer: .nan, alpha: .infinity, alphaDefaulted: false
      ),
      coveringBundleIdentifier: "com.private\n"
    )
    var json = diagnosticJSON(diagnostic)
    expect((json["expectedApplication"] as? [String: Any])?.isEmpty == true,
           "invalid process and multiline bundle identities are omitted")
    expect(json["point"] == nil, "non-finite coordinates never enter JSON")
    var top = json["topWindow"] as? [String: Any]
    expect(Set(top?.keys.map { $0 } ?? []) == Set(["alphaDefaulted"]),
           "non-finite geometry/layer/alpha and invalid identity are omitted")
    diagnostic = ClickFailureDiagnostic(
      reason: .coveringWindow, expectedPID: observedApp,
      expectedBundleIdentifier: String(repeating: "a", count: 256),
      point: CGPoint(x: 100_001, y: 1), displayBounds: nil,
      window: InputDeliveryPolicy.WindowInspection(
        lookup: .ownerFound, ownerPID: host, bounds: appWindow,
        layer: 1.25, alpha: 2, alphaDefaulted: false
      ), coveringBundleIdentifier: "com.example.🌿"
    )
    json = diagnosticJSON(diagnostic)
    top = json["topWindow"] as? [String: Any]
    expect((json["expectedApplication"] as? [String: Any])?["bundleIdentifier"] == nil
      && top?["ownerBundleIdentifier"] == nil, "oversized and non-identifier text is never truncated into an apparent identity")
    expect(json["point"] == nil && top?["displayClippedFrame"] == nil,
           "out-of-bound coordinates and a window without a captured display are omitted")
    expect(top?["layer"] == nil && top?["alpha"] == nil, "invalid layer and alpha values are omitted")
    let maximal = ClickFailureDiagnostic(
      reason: .coveringWindow, expectedPID: .max,
      expectedBundleIdentifier: String(repeating: "a", count: 255),
      point: CGPoint(x: -999.99, y: -100),
      displayBounds: CGRect(x: -1_000, y: -500, width: 1_000, height: 800),
      window: InputDeliveryPolicy.WindowInspection(
        lookup: .ownerFound, ownerPID: .max, bounds: CGRect(x: -2_000, y: -600, width: 2_000, height: 900),
        layer: -1_000_000, alpha: 1, alphaDefaulted: false
      ), coveringBundleIdentifier: String(repeating: "b", count: 255)
    )
    let maximalJSON = diagnosticJSON(maximal)
    let maximalFrame = (maximalJSON["topWindow"] as? [String: Any])?["displayClippedFrame"] as? [String: Double]
    expect(maximalFrame == ["x": -1_000, "y": -500, "width": 1_000, "height": 800],
           "negative-origin displays are clipped without changing coordinate space")
  }

  private static func diagnosticStagesAndFailureOnly() {
    let elementReasons: Set<ClickFailureDiagnostic.Reason> = [
      .axExpectedApplicationUnavailable, .axQueryFailed, .axHitUnavailable,
      .axHitMismatch, .axMetadataUnavailable, .axSecureTarget,
    ]
    for reason in ClickFailureDiagnostic.Reason.allCases {
      let diagnostic = ClickFailureDiagnostic(reason: reason, expectedPID: observedApp,
        expectedBundleIdentifier: "com.google.Chrome", point: CGPoint(x: 400, y: 400), displayBounds: nil)
      let json = diagnosticJSON(diagnostic)
      expect(json["stage"] as? String == (elementReasons.contains(reason) ? "element_hit_test" : "window_owner"),
             "each refusal reason belongs to exactly one diagnostic stage")
      expect(json["reason"] as? String == reason.rawValue, "the bounded refusal enum is preserved")
      expect(diagnostic.encoded(commandID: commandID, action: "press", errorCode: "click_target_covered") == nil,
             "other actions cannot emit a click diagnostic")
      expect(diagnostic.encoded(commandID: commandID, action: "click", errorCode: "stale_observation") == nil,
             "other refusals cannot be mislabeled as covering-window failures")
      for invalid in ["invalid", commandID + "\n", commandID + "0", commandID.uppercased()] {
        expect(diagnostic.encoded(commandID: invalid, action: "click", errorCode: "click_target_covered") == nil,
               "only the full exact opaque command ID can correlate a diagnostic")
      }
    }
  }

  private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fail(message) }
  }

  private static func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("FAILED: \(message)\n".utf8))
    exit(1)
  }
}
