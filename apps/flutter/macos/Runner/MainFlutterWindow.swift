import Cocoa
import FlutterMacOS

enum AsaelWindowRole {
  case main
  case workspace
}

/// Applies the native chrome shared by every full Asael workspace window.
///
/// Keep the standard titled-window controls and titlebar hit testing intact.
/// Flutter does not yet provide a draggable region or titlebar safe-area, so
/// content must not extend underneath this transparent system titlebar.
func configureAsaelWindowChrome(_ window: NSWindow, role: AsaelWindowRole) {
  window.styleMask.formUnion([.titled, .closable, .miniaturizable, .resizable])
  window.styleMask.remove(.fullSizeContentView)
  window.titleVisibility = .hidden
  window.titlebarAppearsTransparent = true
  window.toolbarStyle = .unifiedCompact
  window.backgroundColor = .windowBackgroundColor
  window.isOpaque = true
  window.hasShadow = true
  window.isReleasedWhenClosed = false
  window.tabbingMode = role == .main ? .disallowed : .preferred
  window.collectionBehavior.insert(.fullScreenPrimary)
}

class MainFlutterWindow: NSWindow {
  private static let desktopChannelName = "app.omniagent.omniagent/desktop"
  private static let localComputerChannelName = "app.omniagent.omniagent/local-computer"
  private static let secureStorageChannelName = "app.omniagent.omniagent/secure-storage"

  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = frame
    contentViewController = flutterViewController
    setFrame(windowFrame, display: true)

    configureDesktopWindow()

    let channel = FlutterMethodChannel(
      name: Self.desktopChannelName,
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    (NSApp.delegate as? AppDelegate)?.attachDesktopBridge(channel: channel, window: self)

    let localComputerChannel = FlutterMethodChannel(
      name: Self.localComputerChannelName,
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    (NSApp.delegate as? AppDelegate)?.attachLocalComputerBridge(channel: localComputerChannel)

    let secureStorageChannel = FlutterMethodChannel(
      name: Self.secureStorageChannelName,
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    (NSApp.delegate as? AppDelegate)?.attachCredentialBrokerBridge(channel: secureStorageChannel)

    RegisterGeneratedPlugins(registry: flutterViewController)
    super.awakeFromNib()
  }

  private func configureDesktopWindow() {
    title = "Asael"
    minSize = NSSize(width: 1_024, height: 700)
    setContentSize(NSSize(width: 1_360, height: 860))
    center()

    configureAsaelWindowChrome(self, role: .main)
  }
}
