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

  private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fail(message) }
  }

  private static func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("FAILED: \(message)\n".utf8))
    exit(1)
  }
}
