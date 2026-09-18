import Flutter
import UIKit
import UserNotifications
import firebase_messaging

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    registerNotificationCategories()
    FLTFirebaseMessagingPlugin.configureNotificationCenterDelegate()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
  }

  private func registerNotificationCategories() {
    let complete = UNNotificationAction(
      identifier: "ASAEL_COMPLETE_V1",
      title: "Complete",
      options: [.authenticationRequired, .foreground]
    )
    let snooze = UNNotificationAction(
      identifier: "ASAEL_SNOOZE_15_V1",
      title: "Snooze 15 min",
      options: [.foreground]
    )
    let dismiss = UNNotificationAction(
      identifier: "ASAEL_DISMISS_V1",
      title: "Dismiss",
      options: [.destructive, .foreground]
    )
    let category = UNNotificationCategory(
      identifier: "ASAEL_ACTIONABLE_V1",
      actions: [complete, snooze, dismiss],
      intentIdentifiers: [],
      hiddenPreviewsBodyPlaceholder: "Asael has an update.",
      options: []
    )
    UNUserNotificationCenter.current().setNotificationCategories([category])
  }
}
