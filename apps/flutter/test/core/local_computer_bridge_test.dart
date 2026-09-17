import 'package:asael/core/platform/local_computer_bridge.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const status = <String, Object?>{
    'supported': true,
    'helperInstalled': true,
    'enabled': true,
    'active': false,
    'accessibility': 'granted',
    'screenRecording': 'granted',
    'helperVersion': '1.0.0',
  };

  test('reads status and keeps native enablement explicit', () async {
    const channel = MethodChannel('test.asael.local-computer.status');
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return status;
        });
    final bridge = LocalComputerBridge(channel: channel, enabled: true);

    final initial = await bridge.getStatus();
    final enabled = await bridge.setEnabled(true);
    final stopped = await bridge.stop();

    expect(initial.ready, isTrue);
    expect(enabled.accessibility, LocalComputerPermission.granted);
    expect(stopped.helperVersion, '1.0.0');
    expect(calls.map((call) => call.method), [
      'getStatus',
      'setEnabled',
      'stop',
    ]);
    expect(calls[1].arguments, {'enabled': true});
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('sends only an expiring allowlisted governed command', () async {
    const channel = MethodChannel('test.asael.local-computer.execute');
    MethodCall? received;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          received = call;
          return {
            'outcome': 'succeeded',
            'result': {
              'summary': 'Observed the active Mac workspace.',
              'observation': {
                'snapshotRevision': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                'accessibilitySnapshot': 'id=e:bbbbbbbbbbbb:1 role=AXWindow',
              },
            },
          };
        });
    final bridge = LocalComputerBridge(channel: channel, enabled: true);
    final command = LocalComputerCommand(
      id: 'local_computer_command_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      action: 'observe',
      input: const {'includeScreenshot': false},
      expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 1)),
    );

    final response = await bridge.execute(command);

    expect(response.outcome, LocalComputerOutcome.succeeded);
    expect(
      response.observation?['snapshotRevision'],
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    expect(received?.method, 'executeLocalComputerCommand');
    expect((received?.arguments as Map)['action'], 'observe');
    expect((received?.arguments as Map).keys, {
      'id',
      'action',
      'input',
      'expiresAt',
    });
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('rejects unsafe action, payload, and malformed native result', () async {
    expect(
      () => LocalComputerCommand(
        id: 'local_computer_command_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        action: 'shell',
        input: const {},
        expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 1)),
      ),
      throwsArgumentError,
    );
    expect(
      () => LocalComputerCommand(
        id: 'local_computer_command_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        action: 'type',
        input: {'text': List.filled(70 * 1024, 'x').join()},
        expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 1)),
      ),
      throwsArgumentError,
    );
    expect(
      () => LocalComputerCommandResult.fromArguments(const {
        'outcome': 'succeeded',
        'result': {'summary': ''},
      }),
      throwsFormatException,
    );
  });

  test('delivers only a bounded native kill-switch event', () async {
    const channel = MethodChannel('test.asael.local-computer.events');
    final reasons = <String>[];
    final bridge = LocalComputerBridge(channel: channel, enabled: true)
      ..attachStoppedHandler(reasons.add);
    await bridge.initialize();

    await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(
            const MethodCall('localComputerStopped', {'reason': 'kill_switch'}),
          ),
          (_) {},
        );
    await Future<void>.delayed(Duration.zero);

    expect(reasons, ['kill_switch']);
    await bridge.dispose();
  });
}
