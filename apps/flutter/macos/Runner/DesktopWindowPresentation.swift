import AppKit

enum AsaelWindowRole {
  case main
  case workspace
}

/// The shared native chrome for full workspaces. This is also the recovery
/// path, so it restores every property that the compact voice window changes.
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
  window.isMovableByWindowBackground = false
  window.tabbingMode = role == .main ? .disallowed : .preferred
  window.collectionBehavior.insert(.fullScreenPrimary)
  window.contentView?.layer?.cornerRadius = 0
  window.contentView?.layer?.masksToBounds = false
  for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
    window.standardWindowButton(type)?.isHidden = false
    window.standardWindowButton(type)?.isEnabled = true
  }
}

/// One temporary presentation stack for the primary window. Voice appearance
/// changes and Quick Entry handoffs retain the original workspace geometry.
final class DesktopWindowPresentation {
  private var regularFrame: NSRect?
  static let regularMinimumSize = NSSize(width: 1_024, height: 700)

  func prepareVoice(_ window: NSWindow, size: NSSize, appearance: String) {
    captureRegularFrame(window)
    window.minSize = size
    window.level = .floating
    window.collectionBehavior.remove(.fullScreenPrimary)
    window.collectionBehavior.insert(.fullScreenAuxiliary)
    window.styleMask.insert(.fullSizeContentView)
    window.styleMask.remove(.resizable)
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isMovableByWindowBackground = true
    window.isOpaque = false
    window.backgroundColor = .clear
    let isPerch = appearance == "perch"
    window.hasShadow = !isPerch
    window.contentView?.wantsLayer = true
    window.contentView?.layer?.cornerRadius = isPerch ? 0 : 20
    window.contentView?.layer?.masksToBounds = !isPerch
    for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
      window.standardWindowButton(type)?.isHidden = true
    }
  }

  func prepareQuickEntry(_ window: NSWindow, minimumSize: NSSize) {
    captureRegularFrame(window)
    configureAsaelWindowChrome(window, role: .main)
    window.minSize = minimumSize
    window.level = .floating
    window.collectionBehavior.remove(.fullScreenPrimary)
    window.collectionBehavior.insert(.fullScreenAuxiliary)
  }

  func restoreMain(_ window: NSWindow) {
    configureAsaelWindowChrome(window, role: .main)
    window.level = .normal
    window.collectionBehavior.remove(.fullScreenAuxiliary)
    window.minSize = Self.regularMinimumSize
    if let regularFrame {
      // Restoration is synchronous: an in-flight compact-window animation
      // must not finish later and leave the workspace at the voice dimensions.
      NSAnimationContext.runAnimationGroup { context in
        context.duration = 0
        window.animator().setFrame(regularFrame, display: true)
      }
      self.regularFrame = nil
    } else if window.frame.width < Self.regularMinimumSize.width ||
                window.frame.height < Self.regularMinimumSize.height {
      var frame = window.frame
      frame.size.width = max(frame.width, Self.regularMinimumSize.width)
      frame.size.height = max(frame.height, Self.regularMinimumSize.height)
      window.setFrame(frame, display: true)
    }
  }

  private func captureRegularFrame(_ window: NSWindow) {
    if regularFrame == nil { regularFrame = window.frame }
  }
}
