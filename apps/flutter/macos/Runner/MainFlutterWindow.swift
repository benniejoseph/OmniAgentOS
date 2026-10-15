import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  private static let desktopChannelName = "app.omniagent.omniagent/desktop"
  private static let localComputerChannelName = "app.omniagent.omniagent/local-computer"
  private static let secureStorageChannelName = "app.omniagent.omniagent/secure-storage"
  private var powerStateChannel: FlutterEventChannel?

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
    powerStateChannel = (NSApp.delegate as? AppDelegate)?.attachPowerStateBridge(
      to: flutterViewController.engine.binaryMessenger
    )

    RegisterGeneratedPlugins(registry: flutterViewController)
    super.awakeFromNib()
  }

  deinit {
    if let powerStateChannel {
      (NSApp.delegate as? AppDelegate)?.detachPowerStateBridge(powerStateChannel)
    }
  }

  private func configureDesktopWindow() {
    title = "Asael"
    minSize = NSSize(width: 1_024, height: 700)
    setContentSize(NSSize(width: 1_360, height: 860))
    center()

    configureAsaelWindowChrome(self, role: .main)
  }
}
