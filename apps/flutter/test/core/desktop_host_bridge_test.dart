import 'package:asael/core/platform/desktop_host_bridge.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('accepts only allowlisted desktop routes', () async {
    final opened = <String>[];
    final bridge = DesktopHostBridge(enabled: false)
      ..attachRouteOpener(opened.add);

    await bridge.handleNativeCall(
      const MethodCall('openRoute', {'route': '/capture'}),
    );

    expect(opened, ['/capture']);
    await expectLater(
      bridge.handleNativeCall(
        const MethodCall('openRoute', {'route': '/settings'}),
      ),
      throwsA(
        isA<PlatformException>().having(
          (error) => error.code,
          'code',
          'invalid_desktop_route',
        ),
      ),
    );
  });

  test('retains only the newest route until Flutter is ready', () async {
    final opened = <String>[];
    final bridge = DesktopHostBridge(enabled: false);

    await bridge.handleNativeCall(
      const MethodCall('openRoute', {'route': '/today'}),
    );
    await bridge.handleNativeCall(
      const MethodCall('openRoute', {'route': '/inbox'}),
    );
    bridge.attachRouteOpener(opened.add);
    await Future<void>.delayed(Duration.zero);

    expect(opened, ['/inbox']);
  });

  test('rejects unknown native intents', () async {
    final bridge = DesktopHostBridge(enabled: false);

    await expectLater(
      bridge.handleNativeCall(const MethodCall('executeTool')),
      throwsA(
        isA<PlatformException>().having(
          (error) => error.code,
          'code',
          'unsupported_desktop_intent',
        ),
      ),
    );
  });
}
