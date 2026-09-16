import 'package:asael/core/platform/desktop_host_bridge.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('accepts only allowlisted desktop routes', () async {
    final opened = <String>[];
    final bridge = DesktopHostBridge(enabled: false)
      ..attachRouteOpener(opened.add);

    await bridge.handleNativeCall(
      const MethodCall('openRoute', {'route': '/capture'}),
    );
    await bridge.handleNativeCall(
      const MethodCall('openRoute', {'route': '/quick-entry'}),
    );

    expect(opened, ['/capture', '/quick-entry']);
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

  test('queues and validates one native notification action', () async {
    final received = <DesktopNotificationAction>[];
    final bridge = DesktopHostBridge(enabled: false);

    await bridge.handleNativeCall(
      const MethodCall('notificationAction', {
        'action': 'snooze15',
        'data': {'schemaVersion': '1', 'deliveryId': 'delivery-one'},
      }),
    );
    bridge.attachNotificationHandler((action) async => received.add(action));
    await Future<void>.delayed(Duration.zero);

    expect(received, hasLength(1));
    expect(received.single.command, DesktopNotificationCommand.snooze15);
    expect(received.single.data['deliveryId'], 'delivery-one');
    await expectLater(
      bridge.handleNativeCall(
        const MethodCall('notificationAction', {
          'action': 'execute',
          'data': <String, dynamic>{},
        }),
      ),
      throwsA(
        isA<PlatformException>().having(
          (error) => error.code,
          'code',
          'invalid_notification_action',
        ),
      ),
    );
  });

  test('reports only bounded APNs registration receipts', () async {
    final received = <DesktopApnsRegistration>[];
    final bridge = DesktopHostBridge(enabled: false)
      ..attachApnsRegistrationHandler((registration) async {
        received.add(registration);
      });

    await bridge.handleNativeCall(
      MethodCall('apnsRegistration', {
        'token': List.filled(64, 'a').join(),
        'environment': 'sandbox',
      }),
    );
    await bridge.handleNativeCall(
      const MethodCall('apnsRegistration', {
        'errorCode': 'missing_entitlement',
      }),
    );

    expect(received, hasLength(2));
    expect(received.first.succeeded, isTrue);
    expect(received.first.environment, 'sandbox');
    expect(received.last.succeeded, isFalse);
    expect(received.last.errorCode, 'missing_entitlement');
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

  test('rejects file or authority payloads on the navigation bridge', () async {
    final bridge = DesktopHostBridge(enabled: false);

    await expectLater(
      bridge.handleNativeCall(
        const MethodCall('openRoute', {
          'route': '/capture',
          'files': ['/tmp/private.vtt'],
        }),
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

  test('asks AppKit to restore only window presentation', () async {
    const channel = MethodChannel('test.asael.desktop');
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return null;
        });
    final bridge = DesktopHostBridge(channel: channel, enabled: true);

    await bridge.showMainPresentation();

    expect(calls, hasLength(1));
    expect(calls.single.method, 'showMainPresentation');
    expect(calls.single.arguments, isNull);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('asks AppKit to compact only Quick Entry presentation', () async {
    const channel = MethodChannel('test.asael.desktop.quick-entry');
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return null;
        });
    final bridge = DesktopHostBridge(channel: channel, enabled: true);

    await bridge.showQuickEntryPresentation();

    expect(calls, hasLength(1));
    expect(calls.single.method, 'showQuickEntryPresentation');
    expect(calls.single.arguments, isNull);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });
}
