import Flutter
import UIKit

class SceneDelegate: FlutterSceneDelegate {
  private var sceneObservers: [NSObjectProtocol] = []

  /// The launch screen, drawn over the workspace while the scene is inactive.
  private lazy var privacyCover: UIView = {
    let cover =
      UIStoryboard(name: "LaunchScreen", bundle: nil)
      .instantiateInitialViewController()?.view ?? UIView()
    if cover.backgroundColor == nil {
      cover.backgroundColor = .systemBackground
    }
    cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    return cover
  }()

  override init() {
    super.init()
    // FlutterSceneDelegate implements the scene callbacks without declaring
    // them, so a subclass that defined them would replace Flutter's own.
    // UIKit posts these notifications beside the callbacks, on the main
    // thread, and a nil queue runs each block before the post returns.
    let center = NotificationCenter.default
    sceneObservers = [
      center.addObserver(
        forName: UIScene.willDeactivateNotification,
        object: nil,
        queue: nil
      ) { [weak self] notification in
        MainActor.assumeIsolated {
          self?.coverWorkspace(of: notification.object)
        }
      },
      center.addObserver(
        forName: UIScene.didActivateNotification,
        object: nil,
        queue: nil
      ) { [weak self] notification in
        MainActor.assumeIsolated {
          self?.uncoverWorkspace(of: notification.object)
        }
      },
    ]
  }

  deinit {
    sceneObservers.forEach(NotificationCenter.default.removeObserver)
  }

  /// Covers the workspace before the app switcher takes its snapshot, and
  /// while Notification Center, Control Center, or a system prompt sits on
  /// top. The cover goes up whether or not biometric lock is on.
  private func coverWorkspace(of object: Any?) {
    guard let scene = object as? UIScene, scene.delegate === self,
      let window = self.window
    else { return }
    privacyCover.frame = window.bounds
    window.addSubview(privacyCover)
  }

  private func uncoverWorkspace(of object: Any?) {
    guard let scene = object as? UIScene, scene.delegate === self else {
      return
    }
    privacyCover.removeFromSuperview()
  }
}
