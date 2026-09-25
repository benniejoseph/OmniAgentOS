import Darwin
import Foundation

@main
private enum TaskAuthorityPolicyTests {
  private static let window = TaskAuthorityElement(
    role: "AXWindow",
    subrole: "AXStandardWindow",
    labels: ["Checkout – Example Store"]
  )
  private static let webArea = TaskAuthorityElement(
    role: "AXWebArea",
    subrole: nil,
    labels: ["Delete your account – Help Center"]
  )

  static func main() {
    envelopes()
    pointerTargets()
    typing()
    keys()
    lexicon()
  }

  private static func envelopes() {
    let command: [String: Any] = [
      "id": "local_computer_command_\(String(repeating: "a", count: 48))",
      "action": "click",
      "input": [String: Any](),
      "expiresAt": "2026-09-25T12:00:00.000Z",
    ]
    expect(
      TaskAuthorityTargetPolicy.envelopeAuthority(command) == false,
      "an unmarked command keeps the four-key envelope"
    )
    for action in ["press", "click", "key", "type"] {
      var marked = command
      marked["action"] = action
      marked["authority"] = "task"
      expect(
        TaskAuthorityTargetPolicy.envelopeAuthority(marked) == true,
        "a \(action) may run on task authority"
      )
    }
    for action in ["observe", "scroll", "activate_app", "open_url", "status"] {
      var marked = command
      marked["action"] = action
      marked["authority"] = "task"
      expect(
        TaskAuthorityTargetPolicy.envelopeAuthority(marked) == nil,
        "task authority on \(action) is malformed"
      )
    }
    for marker in ["approved", NSNull(), true, 1] as [Any] {
      var marked = command
      marked["authority"] = marker
      expect(
        TaskAuthorityTargetPolicy.envelopeAuthority(marked) == nil,
        "only the literal task marker is accepted"
      )
    }
    var extra = command
    extra["reason"] = "task"
    expect(
      TaskAuthorityTargetPolicy.envelopeAuthority(extra) == nil,
      "a fifth key other than the marker is malformed"
    )
    extra["authority"] = "task"
    expect(
      TaskAuthorityTargetPolicy.envelopeAuthority(extra) == nil,
      "the marker never excuses another extra key"
    )
    var short = command
    short.removeValue(forKey: "expiresAt")
    expect(
      TaskAuthorityTargetPolicy.envelopeAuthority(short) == nil,
      "a short envelope is malformed"
    )
  }

  private static func pointerTargets() {
    expect(
      allows([element("AXButton", labels: "Settings"), element("AXGroup"), window]),
      "a named everyday button is covered"
    )
    expect(
      allows([
        element("AXStaticText", labels: "Pricing"),
        element("AXLink"),
        element("AXGroup"),
        webArea,
        element("AXScrollArea"),
        window,
      ]),
      "page and window titles do not refuse the link they contain"
    )
    for label in [
      "Send", "Buy now", "Delete", "Allow", "Sign in", "OK", "Continue with Google",
      "Place your order", "Check out", "Log in", "Pay $24.00", "Accept all cookies",
      "Following", "Subscribed", "Submitting…", "Cancelled", "Unsubscribe",
    ] {
      expect(
        !allows([element("AXButton", labels: label), element("AXGroup"), window]),
        "a button named \(label) needs review"
      )
    }
    expect(
      !allows([
        element("AXStaticText", labels: "Unsubscribe"),
        element("AXLink"),
        webArea,
        window,
      ]),
      "the text inside a link names it"
    )
    expect(
      !allows([
        element("AXImage", labels: "icon"),
        element("AXGroup", labels: "Remove item"),
        webArea,
        window,
      ]),
      "a clickable container's words count even when the hit is an image"
    )
    expect(
      !allows([
        element("AXButton", labels: "Details"),
        element("AXGroup", subrole: "AXApplicationDialog"),
        webArea,
        window,
      ]),
      "a web dialog needs review"
    )
    expect(
      !allows([element("AXButton", labels: "Details"), element("AXSheet"), window]),
      "a sheet needs review"
    )
    expect(
      !allows([
        element("AXButton", labels: "Details"),
        TaskAuthorityElement(role: "AXWindow", subrole: "AXDialog", labels: []),
      ]),
      "a dialog window needs review"
    )
    expect(
      !allows([element("AXButton"), element("AXGroup"), window]),
      "an unnamed button needs review"
    )
    expect(
      !allows([element("AXImage"), element("AXButton"), window]),
      "an unnamed icon inside an unnamed button needs review"
    )
    expect(
      allows([element("AXImage", labels: "Gear"), element("AXButton"), window]),
      "the hit may name the button that contains it"
    )
    expect(
      !allows([element("AXButton", subrole: "AXCloseButton", labels: "Dismiss"), window]),
      "a window close button needs review"
    )
    expect(
      allows([element("AXTextField", labels: "Search"), element("AXGroup"), window]),
      "focusing a text field is covered"
    )
    expect(
      allows([
        element("AXStaticText", labels: "Search mail"),
        element("AXTextField"),
        webArea,
        window,
      ]),
      "a placeholder inside a text field is covered"
    )
    expect(
      !allows([element("AXTextField", labels: "Add a comment"), webArea, window]),
      "any content label that could send or commit needs review"
    )
    expect(
      !allows([
        element("AXTextField", subrole: "AXSecureTextField", labels: "Password"),
        window,
      ]),
      "a secure field needs review"
    )
    expect(
      allows([element("AXStaticText", labels: "Quarterly summary"), element("AXCell"), window]),
      "named passive text is covered"
    )
    expect(
      !allows([element("AXGroup"), window]),
      "unnamed passive content needs review"
    )
    expect(
      !allows([element("AXUnknown", labels: "Canvas"), window]),
      "an unknown role needs review"
    )
    expect(!allows([window]), "the window itself needs review")
    expect(!allows([webArea, window]), "the page itself needs review")
    expect(
      !allows([element("AXButton", labels: "Settings"), element("AXGroup")]),
      "a path that never reaches the observed window needs review"
    )
    expect(!allows([]), "an empty path needs review")
  }

  private static func typing() {
    for role in ["AXTextField", "AXTextArea", "AXComboBox"] {
      expect(
        TaskAuthorityTargetPolicy.allowsTyping(role: role, subrole: nil, text: "hello world"),
        "task authority types into \(role)"
      )
    }
    for role in ["AXButton", "AXWebArea", "AXStaticText", "AXGroup"] {
      expect(
        !TaskAuthorityTargetPolicy.allowsTyping(role: role, subrole: nil, text: "hello"),
        "task authority never types into \(role)"
      )
    }
    expect(
      !TaskAuthorityTargetPolicy.allowsTyping(
        role: "AXTextField",
        subrole: "AXSecureTextField",
        text: "hello"
      ),
      "task authority never types into a secure field"
    )
    for text in ["line\nbreak", "tab\there", "carriage\rreturn", "next\u{85}line",
                 "line\u{2028}separator", "paragraph\u{2029}separator", "bell\u{7}", ""] {
      expect(
        !TaskAuthorityTargetPolicy.allowsTyping(role: "AXTextField", subrole: nil, text: text),
        "control characters and empty text need review"
      )
    }
    expect(
      TaskAuthorityTargetPolicy.allowsTyping(
        role: "AXTextArea",
        subrole: nil,
        text: String(repeating: "a", count: 500)
      ),
      "500 UTF-16 units are covered"
    )
    expect(
      !TaskAuthorityTargetPolicy.allowsTyping(
        role: "AXTextArea",
        subrole: nil,
        text: String(repeating: "a", count: 501)
      ),
      "501 UTF-16 units need review"
    )
    expect(
      TaskAuthorityTargetPolicy.allowsTyping(
        role: "AXTextArea",
        subrole: nil,
        text: String(repeating: "👍", count: 250)
      ),
      "the limit counts UTF-16 units like the server"
    )
    expect(
      !TaskAuthorityTargetPolicy.allowsTyping(
        role: "AXTextArea",
        subrole: nil,
        text: String(repeating: "👍", count: 251)
      ),
      "an emoji counts as two UTF-16 units"
    )
  }

  private static func keys() {
    for name in ["tab", "escape"] {
      expect(key(name, focusedRole: "AXButton") == .allow, "\(name) is covered anywhere")
    }
    for name in ["left", "right", "up", "down", "home", "end", "page_up", "page_down"] {
      expect(key(name, focusedRole: "AXList") == .allow, "\(name) moves through a list")
      for role in ["AXSlider", "AXIncrementor", "AXPopUpButton", "AXRadioButton", "AXDateField"] {
        expect(key(name, focusedRole: role) == .refuse, "\(name) would change \(role)")
      }
    }
    for role in ["AXWebArea", "AXScrollArea", "AXTextField", "AXTextArea"] {
      expect(key("space", focusedRole: role) == .allow, "space scrolls or types in \(role)")
    }
    for role in ["AXButton", "AXCheckBox", "AXLink", "AXGroup"] {
      expect(
        key("space", focusedRole: role) == .checkFocusedTarget,
        "space on \(role) is checked like a click"
      )
    }
    for name in ["return", "delete", "f1"] {
      for role in ["AXTextField", "AXWebArea", "AXList"] {
        expect(key(name, focusedRole: role) == .refuse, "\(name) needs review")
      }
    }
    expect(key("tab", modifiers: ["shift"]) == .allow, "shift+tab moves back")
    expect(key("home", modifiers: ["command"]) == .allow, "command+home goes to the top")
    for (name, modifiers) in [
      ("tab", ["command"]), ("home", ["shift"]), ("tab", ["shift", "shift"]),
      ("home", ["command", "shift"]), ("left", ["option"]), ("tab", ["control"]),
      ("space", ["command"]), ("return", ["command"]),
    ] {
      expect(
        key(name, modifiers: modifiers) == .refuse,
        "\(modifiers.joined(separator: "+"))+\(name) needs review"
      )
    }
  }

  private static func lexicon() {
    for label in [
      "Send", "send", "Resend code", " Place your order ", "Sign in with Apple",
      "SIGN-IN", "Continue", "I understand the risks", "Turn on notifications",
      "Go live", "Top-up", "log-out", "check-out", "Opt-out", "OK", "Yes, delete it",
      "Following", "Subscribed", "Replies", "Denied", "Submitted", "Running",
      "Downloads", "Unsubscribed",
    ] {
      expect(TaskAuthorityTargetPolicy.lexiconHit(label), "\(label) is refused")
    }
    for label in [
      "Settings", "Inbox", "Search", "Next page", "Sender", "Pricing", "Dropdown",
      "Postcode", "Checklist", "Likely", "Log", "Turnover", "Top", "Live",
      "Checking account", "Messages", "Status",
    ] {
      expect(!TaskAuthorityTargetPolicy.lexiconHit(label), "\(label) is not refused")
    }
  }

  private static func element(
    _ role: String,
    subrole: String? = nil,
    labels: String...
  ) -> TaskAuthorityElement {
    TaskAuthorityElement(role: role, subrole: subrole, labels: labels)
  }

  private static func allows(_ path: [TaskAuthorityElement]) -> Bool {
    TaskAuthorityTargetPolicy.allowsPointer(path: path)
  }

  private static func key(
    _ name: String,
    modifiers: [String] = [],
    focusedRole: String = "AXWebArea"
  ) -> TaskAuthorityKeyDisposition {
    TaskAuthorityTargetPolicy.keyDisposition(
      name: name,
      modifiers: modifiers,
      focusedRole: focusedRole
    )
  }

  private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
      FileHandle.standardError.write(Data("FAILED: \(message)\n".utf8))
      exit(1)
    }
  }
}
