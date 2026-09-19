import 'package:asael/core/platform/desktop_host_bridge.dart';
import 'package:asael/app/router/app_router.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('accepts only a validated native initial workspace route', () {
    expect(
      initialAppLocation(const ['--asael-route=/results/agent%3Arun-123']),
      '/results/agent%3Arun-123',
    );
    expect(
      initialAppLocation(const ['--asael-route=/automation']),
      '/automation',
    );
    expect(
      initialAppLocation(const ['--asael-route=/settings?token=private']),
      appHomePath(),
    );
  });

  test('consolidates legacy Mac automation routes without changing mobile', () {
    expect(
      legacyAutomationRedirect('/workflows', macos: true),
      '/automation?section=automations',
    );
    expect(
      legacyAutomationRedirect('/integrations', macos: true),
      '/automation?section=connections',
    );
    expect(
      legacyAutomationRedirect('/tools', macos: true),
      '/automation?section=skills',
    );
    expect(legacyAutomationRedirect('/tools', macos: false), isNull);
  });

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
    expect(received.single.appLifecycle, 'unknown');
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

  test(
    'queues a bounded native delivery until its receipt handler is ready',
    () async {
      final received = <DesktopNotificationReceived>[];
      final bridge = DesktopHostBridge(enabled: false);

      await bridge.handleNativeCall(
        const MethodCall('notificationReceived', {
          'data': {'schemaVersion': '1', 'deliveryId': 'delivery-one'},
          'appLifecycle': 'foreground',
          'observedAt': '2026-09-18T12:00:00Z',
        }),
      );
      bridge.attachNotificationReceivedHandler((delivery) async {
        received.add(delivery);
      });
      await Future<void>.delayed(Duration.zero);

      expect(received, hasLength(1));
      expect(received.single.appLifecycle, 'foreground');
      expect(received.single.observedAt, DateTime.utc(2026, 9, 18, 12));
      expect(received.single.data['deliveryId'], 'delivery-one');
    },
  );

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

  test('queues and validates App Group capture requests', () async {
    final received = <DesktopSharedCapture>[];
    final bridge = DesktopHostBridge(enabled: false);
    const requestId = 'b14b1388-38aa-4dd7-bf14-f511b47e52e2';

    await bridge.handleNativeCall(
      const MethodCall('sharedCapture', {
        'requestId': requestId,
        'files': ['/private/group/Inbox/request/course-01.vtt'],
      }),
    );
    bridge.attachSharedCaptureHandler((capture) async {
      received.add(capture);
    });
    await Future<void>.delayed(Duration.zero);

    expect(received, hasLength(1));
    expect(received.single.requestId, requestId);
    expect(received.single.paths.single, endsWith('course-01.vtt'));

    await expectLater(
      bridge.handleNativeCall(
        const MethodCall('sharedCapture', {
          'requestId': requestId,
          'files': ['/private/a.vtt', '/private/a.vtt'],
        }),
      ),
      throwsA(
        isA<PlatformException>().having(
          (error) => error.code,
          'code',
          'invalid_shared_capture',
        ),
      ),
    );
  });

  test('returns App Group capture disposition to AppKit', () async {
    const channel = MethodChannel('test.asael.desktop.share');
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return null;
        });
    final bridge = DesktopHostBridge(channel: channel, enabled: true);

    await bridge.completeSharedCapture('b14b1388-38aa-4dd7-bf14-f511b47e52e2');
    await bridge.retrySharedCapture('b14b1388-38aa-4dd7-bf14-f511b47e52e2');

    expect(calls.map((call) => call.method), [
      'completeSharedCapture',
      'retrySharedCapture',
    ]);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
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

  test(
    'reads and updates only a bounded Quick Entry shortcut preset',
    () async {
      const channel = MethodChannel('test.asael.desktop.shortcuts');
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add(call);
            final requested = call.arguments is Map
                ? (call.arguments as Map)['shortcut']
                : null;
            return {
              'shortcut': requested ?? 'command_shift_space',
              'registered': requested != 'disabled',
            };
          });
      final bridge = DesktopHostBridge(channel: channel, enabled: true);

      final initial = await bridge.getQuickEntryShortcut();
      final changed = await bridge.setQuickEntryShortcut(
        DesktopQuickEntryShortcut.optionSpace,
      );

      expect(initial.shortcut, DesktopQuickEntryShortcut.commandShiftSpace);
      expect(initial.registered, isTrue);
      expect(changed.shortcut, DesktopQuickEntryShortcut.optionSpace);
      expect(calls.map((call) => call.method), [
        'getQuickEntryShortcut',
        'setQuickEntryShortcut',
      ]);
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    },
  );

  test('opens only an allowlisted independent workspace route', () async {
    const channel = MethodChannel('test.asael.desktop.windows');
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return null;
        });
    final bridge = DesktopHostBridge(channel: channel, enabled: true);

    await bridge.openWorkspaceWindow('/results/agent%3Arun-123');
    expect(calls.single.method, 'openWorkspaceWindow');
    expect(calls.single.arguments, {'route': '/results/agent%3Arun-123'});
    await bridge.openWorkspaceWindow('/automation');
    expect(calls.last.arguments, {'route': '/automation'});
    await expectLater(
      bridge.openWorkspaceWindow('/settings?token=private'),
      throwsArgumentError,
    );
    expect(
      DesktopHostBridge.isWorkspaceRoute('/capture/../../private'),
      isFalse,
    );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });
}
