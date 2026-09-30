import Darwin
import Foundation

@main
private enum RestrictedApplicationPolicyTests {
  static func main() {
    categories()
    lookalikes()
    finance()
    bundleMetadata()
    browserPages()
    trustedHost()
  }

  private static func refused(
    _ bundleIdentifier: String?,
    category: String? = nil,
    genre: Int? = nil
  ) -> Bool {
    RestrictedApplicationPolicy.refuses(
      bundleIdentifier: bundleIdentifier,
      declaredCategory: category,
      storeGenre: genre
    )
  }

  private static func categories() {
    for identifier in [
      "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable",
      "com.mitchellh.ghostty", "co.zeit.hyper", "com.apple.systempreferences",
      "com.apple.SystemSettings", "com.apple.keychainaccess", "com.apple.Passwords",
      "com.apple.ActivityMonitor", "com.apple.DiskUtility", "com.apple.SecurityAgent",
      "com.apple.ScriptEditor2", "com.apple.Automator", "com.apple.shortcuts",
      "com.hicknhacksoftware.MacPass", "com.1password.1password", "com.1password",
      "com.agilebits.onepassword7", "com.bitwarden.desktop", "org.keepassxc.keepassxc",
      "me.proton.pass.electron", "COM.APPLE.TERMINAL",
    ] {
      expect(refused(identifier), "\(identifier) is refused")
    }
    let lists = [
      RestrictedApplicationPolicy.shells, RestrictedApplicationPolicy.systemAndSecurity,
      RestrictedApplicationPolicy.automation, RestrictedApplicationPolicy.credentialApplications,
      RestrictedApplicationPolicy.credentialVendors, RestrictedApplicationPolicy.browsers,
    ]
    for list in lists {
      for identifier in list {
        expect(identifier == identifier.lowercased(), "\(identifier) is listed in lower case")
      }
    }
    for browser in RestrictedApplicationPolicy.browsers {
      expect(!refused(browser), "the browser \(browser) is not refused")
    }
    expect(
      !refused(SafeBrowserNavigationPolicy.bundleIdentifier(for: "chrome")),
      "the navigation browser is not refused"
    )
  }

  private static func lookalikes() {
    for identifier in [
      "com.1passwordx.app", "com.bitwardenclone.desktop", "com.apple.terminalx",
      "com.apple.Safari", "com.google.Chrome", "com.spotify.client", "com.apple.Notes",
      "com.apple", "org.keepass", "pass", "",
    ] {
      expect(!refused(identifier), "\(identifier) is not refused")
    }
    expect(!refused(nil), "an application without a bundle identifier is not refused")
  }

  private static func finance() {
    let financeCategory = "public.app-category.finance"
    expect(refused("com.example.bank", category: financeCategory), "a finance app is refused")
    expect(
      refused(nil, category: "Public.App-Category.Finance"),
      "a finance category in other case is refused without a bundle identifier"
    )
    expect(refused("com.example.wallet", genre: 6015), "a finance store genre is refused")
    expect(
      !refused("com.example.notes", category: "public.app-category.productivity", genre: 6000),
      "an app in another category and genre is not refused"
    )
  }

  private static func bundleMetadata() {
    let files = FileManager.default
    let scratchRoot = ProcessInfo.processInfo.environment["TMPDIR"].map {
      URL(fileURLWithPath: $0, isDirectory: true)
    } ?? files.temporaryDirectory
    let directory = scratchRoot
      .appendingPathComponent("asael-restricted-policy-\(UUID().uuidString)", isDirectory: true)
    guard (try? files.createDirectory(at: directory, withIntermediateDirectories: false)) != nil
    else { fail("the scratch directory is created") }
    defer { try? files.removeItem(at: directory) }

    func write(_ plist: [String: Any], to relativePath: String) {
      let url = directory.appendingPathComponent(relativePath)
      guard (try? files.createDirectory(
              at: url.deletingLastPathComponent(),
              withIntermediateDirectories: true
            )) != nil,
            let data = try? PropertyListSerialization.data(
              fromPropertyList: plist,
              format: .xml,
              options: 0
            ),
            (try? data.write(to: url)) != nil
      else { fail("\(relativePath) is written") }
    }
    func bundle(_ relativePath: String) -> URL {
      directory.appendingPathComponent(relativePath, isDirectory: true)
    }

    write(
      [
        "CFBundleIdentifier": "com.example.bank",
        "LSApplicationCategoryType": "public.app-category.finance",
      ],
      to: "Bank.app/Contents/Info.plist"
    )
    write(
      [
        "CFBundleIdentifier": "com.example.notes",
        "LSApplicationCategoryType": "public.app-category.productivity",
      ],
      to: "Notes.app/Contents/Info.plist"
    )
    write(["CFBundleIdentifier": "com.example.wallet"], to: "Wallet.app/Wrapper/Wallet.app/Info.plist")
    write(["genreId": 6015, "genre": "Finance"], to: "Wallet.app/Wrapper/iTunesMetadata.plist")
    write(["CFBundleIdentifier": "com.example.game"], to: "Game.app/Wrapper/Game.app/Info.plist")
    write(["genreId": 6014, "genre": "Games"], to: "Game.app/Wrapper/iTunesMetadata.plist")
    write(["CFBundleIdentifier": "com.example.loose"], to: "Loose/Loose.app/Info.plist")
    write(["genreId": 6015], to: "Loose/iTunesMetadata.plist")
    guard (try? files.createSymbolicLink(
      atPath: bundle("Wallet.app/WrappedBundle").path,
      withDestinationPath: "Wrapper/Wallet.app"
    )) != nil else { fail("the wrapped bundle link is created") }

    expect(
      RestrictedApplicationPolicy.declaredCategory(ofBundleAt: bundle("Bank.app"))
        == "public.app-category.finance",
      "a bundle's declared category is read"
    )
    expect(
      RestrictedApplicationPolicy.declaredCategory(ofBundleAt: bundle("Notes.app"))
        == "public.app-category.productivity",
      "another bundle's declared category is read"
    )
    expect(
      RestrictedApplicationPolicy.declaredCategory(ofBundleAt: bundle("Missing.app")) == nil,
      "a missing bundle declares no category"
    )
    for path in ["Wallet.app/Wrapper/Wallet.app", "Wallet.app", "Wallet.app/WrappedBundle"] {
      expect(
        RestrictedApplicationPolicy.storeGenre(ofBundleAt: bundle(path)) == 6015,
        "the store genre is read from \(path)"
      )
    }
    expect(
      RestrictedApplicationPolicy.storeGenre(ofBundleAt: bundle("Game.app/Wrapper/Game.app"))
        == 6014,
      "another store genre is read"
    )
    expect(
      RestrictedApplicationPolicy.storeGenre(ofBundleAt: bundle("Loose/Loose.app")) == nil,
      "store metadata outside a Wrapper folder is ignored"
    )
    expect(
      RestrictedApplicationPolicy.storeGenre(ofBundleAt: bundle("Bank.app")) == nil,
      "a Mac app has no store genre"
    )
  }

  private static func browserPages() {
    for page in [
      "https://example.com/", "http://example.com", "HTTPS://Example.com/path?q=1",
      "file:///Users/example/page.html", "data:text/html,hello",
      "blob:https://example.com/0f0e", "about:blank", "About:Blank", "about:newtab",
      "about:home", "chrome://newtab/", "chrome://new-tab-page/", "edge://newtab/",
      "brave://newtab/", "vivaldi://startpage/", "opera://startpage/", "favorites://",
      "topsites://",
    ] {
      expect(!refusedPage(page), "\(page) is an allowed page")
    }
    for page in [
      "chrome://settings/passwords", "chrome://password-manager/passwords",
      "chrome://newtab/settings", "chrome-extension://abcdef/popup.html",
      "devtools://devtools/bundled/inspector.html", "about:logins", "about:preferences",
      "about:config", "edge://settings/passwords", "brave://settings",
      "safari-web-extension://abcdef/popup.html", "moz-extension://abcdef/popup.html",
      "example.com",
    ] {
      expect(refusedPage(page), "\(page) is a refused page")
    }
    for identifier in ["com.google.Chrome", "com.apple.Safari", "org.mozilla.firefox"] {
      expect(
        RestrictedApplicationPolicy.readsPages(ofBundleIdentifier: identifier),
        "the pages of \(identifier) are read"
      )
    }
    for identifier in ["com.spotify.client", "com.apple.Notes", nil] {
      expect(
        !RestrictedApplicationPolicy.readsPages(ofBundleIdentifier: identifier),
        "the pages of \(identifier ?? "an unnamed app") are not read"
      )
    }
  }

  private static func refusedPage(_ page: String) -> Bool {
    guard let url = URL(string: page) else { fail("\(page) parses") }
    return RestrictedApplicationPolicy.refusesPage(url)
  }

  private static func trustedHost() {
    func isHost(_ pid: pid_t, _ bundleIdentifier: String?) -> Bool {
      RestrictedApplicationPolicy.isTrustedHost(
        pid: pid,
        bundleIdentifier: bundleIdentifier,
        trustedHostPID: 4_242,
        trustedHostBundleIdentifier: "app.omniagent.omniagent"
      )
    }
    expect(isHost(4_242, nil), "the host's process is the host")
    expect(isHost(7, "App.OmniAgent.OmniAgent"), "the host's bundle in other case is the host")
    expect(!isHost(7, "app.omniagent.omniagent.computer-use-helper"), "the helper is not the host")
    expect(!isHost(7, "com.google.Chrome"), "another app is not the host")
    expect(!isHost(7, nil), "an unnamed app is not the host")
  }

  private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fail(message) }
  }

  private static func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("FAILED: \(message)\n".utf8))
    exit(1)
  }
}
