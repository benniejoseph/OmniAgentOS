import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  group('native privacy cover', () {
    test('Android keeps the workspace out of recents and screen captures', () {
      final activity = File(
        'android/app/src/main/kotlin/app/omniagent/omniagent/MainActivity.kt',
      ).readAsStringSync();
      final manifest = File('android/app/src/main/AndroidManifest.xml')
          .readAsStringSync();

      expect(
        activity,
        contains(
          '    override fun onCreate(savedInstanceState: Bundle?) {\n'
          '        super.onCreate(savedInstanceState)\n',
        ),
      );
      expect(
        activity,
        contains(
          '        window.setFlags(\n'
          '            WindowManager.LayoutParams.FLAG_SECURE,\n'
          '            WindowManager.LayoutParams.FLAG_SECURE,\n'
          '        )\n'
          '    }\n'
          '}\n',
        ),
      );
      // Each activity has its own window, so a second one would need the
      // same flag.
      expect(RegExp(r'<activity\b').allMatches(manifest), hasLength(1));
      expect(manifest, contains('android:name=".MainActivity"'));
    });

    test('iOS covers the workspace whenever the scene is inactive', () {
      final delegate = File('ios/Runner/SceneDelegate.swift')
          .readAsStringSync();
      final info = File('ios/Runner/Info.plist').readAsStringSync();

      expect(
        delegate,
        contains(
          '        forName: UIScene.willDeactivateNotification,\n'
          '        object: nil,\n'
          '        queue: nil\n'
          '      ) { [weak self] notification in\n'
          '        MainActor.assumeIsolated {\n'
          '          self?.coverWorkspace(of: notification.object)\n'
          '        }\n',
        ),
      );
      expect(
        delegate,
        contains(
          '        forName: UIScene.didActivateNotification,\n'
          '        object: nil,\n'
          '        queue: nil\n'
          '      ) { [weak self] notification in\n'
          '        MainActor.assumeIsolated {\n'
          '          self?.uncoverWorkspace(of: notification.object)\n'
          '        }\n',
        ),
      );
      expect(
        delegate,
        contains(
          '  private func coverWorkspace(of object: Any?) {\n'
          '    guard let scene = object as? UIScene, scene.delegate === self,\n'
          '      let window = self.window\n'
          '    else { return }\n'
          '    privacyCover.frame = window.bounds\n'
          '    window.addSubview(privacyCover)\n'
          '  }\n',
        ),
      );
      expect(
        delegate,
        contains(
          '  private func uncoverWorkspace(of object: Any?) {\n'
          '    guard let scene = object as? UIScene, scene.delegate === self else {\n'
          '      return\n'
          '    }\n'
          '    privacyCover.removeFromSuperview()\n'
          '  }\n',
        ),
      );
      // The cover is the launch screen, sized with the window.
      expect(
        delegate,
        contains(
          '      UIStoryboard(name: "LaunchScreen", bundle: nil)\n'
          '      .instantiateInitialViewController()?.view ?? UIView()\n'
          '    if cover.backgroundColor == nil {\n'
          '      cover.backgroundColor = .systemBackground\n'
          '    }\n'
          '    cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]\n',
        ),
      );
      expect(
        info,
        contains(
          '\t<key>UILaunchStoryboardName</key>\n'
          '\t<string>LaunchScreen</string>\n',
        ),
      );
      // FlutterSceneDelegate implements the scene callbacks without
      // declaring them, so defining one here would silently replace
      // Flutter's own.
      expect(delegate, isNot(contains('func scene')));
    });
  });
}
