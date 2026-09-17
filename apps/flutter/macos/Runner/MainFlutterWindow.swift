import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  private static let desktopChannelName = "app.omniagent.omniagent/desktop"
  private static let localComputerChannelName = "app.omniagent.omniagent/local-computer"

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

    RegisterGeneratedPlugins(registry: flutterViewController)
    super.awakeFromNib()
  }

  private func configureDesktopWindow() {
    title = "Asael"
    minSize = NSSize(width: 1_024, height: 700)
    setContentSize(NSSize(width: 1_360, height: 860))
    center()

    isReleasedWhenClosed = false
    tabbingMode = .disallowed
    collectionBehavior.insert(.fullScreenPrimary)
    styleMask.formUnion([.titled, .closable, .miniaturizable, .resizable])
  }
}
