import 'dart:async';

import 'package:asael/core/platform/macos_power_state.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

class _PowerHost extends Fake implements BinaryMessenger {
  static const codec = StandardMethodCodec();
  final calls = <String>[];
  MessageHandler? handler;
  Completer<void>? cancelBarrier;
  Completer<void>? listenBarrier;
  String? initialState;
  String? activationFailure;

  @override
  void setMessageHandler(String channel, MessageHandler? handler) {
    expectSync(channel, MacosPowerStateMonitor.channelName);
    this.handler = handler;
  }

  @override
  Future<ByteData?> send(String channel, ByteData? message) async {
    expectSync(channel, MacosPowerStateMonitor.channelName);
    final call = codec.decodeMethodCall(message!);
    expectSync(call.arguments, isNull);
    calls.add(call.method);
    if (call.method == 'listen') {
      if (initialState != null) {
        await emit(initialState!);
      }
      await listenBarrier?.future;
      if (activationFailure == 'missing') {
        return null;
      }
      if (activationFailure == 'error') {
        return codec.encodeErrorEnvelope(code: 'unavailable');
      }
    } else {
      expectSync(call.method, 'cancel');
      await cancelBarrier?.future;
    }
    return codec.encodeSuccessEnvelope(null);
  }

  Future<void> emit(String state) =>
      event({'schemaVersion': 1, 'lowPowerMode': state});

  Future<void> event(Object? event) async {
    await handler?.call(codec.encodeSuccessEnvelope(event));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('only exact version-one snapshots can permit macOS motion', () {
    expect(
      MacosPowerStateMonitor.parse({
        'schemaVersion': 1,
        'lowPowerMode': 'disabled',
      }),
      MacosPowerState.disabled,
    );
    for (final event in <Object?>[
      null,
      false,
      <String, Object?>{},
      {'schemaVersion': 1.0, 'lowPowerMode': 'disabled'},
      {'schemaVersion': 2, 'lowPowerMode': 'disabled'},
      {'schemaVersion': 1, 'lowPowerMode': false},
      {'schemaVersion': 1, 'lowPowerMode': 'unknown'},
      {'schemaVersion': 1, 'lowPowerMode': 'disabled', 'extra': true},
    ]) {
      expect(MacosPowerStateMonitor.parse(event), MacosPowerState.unknown);
    }
  });

  testWidgets('other platforms preserve motion without a host subscription', (
    tester,
  ) async {
    final host = _PowerHost();
    final monitor = MacosPowerStateMonitor(supported: false, messenger: host);
    monitor.addListener(() {});
    await tester.pump();
    expect(monitor.value, MacosPowerState.disabled);
    expect(host.calls, isEmpty);
    monitor.dispose();
    await tester.pump();
    expect(host.calls, isEmpty);
  });

  testWidgets('listeners share one lazy subscription and restart unknown', (
    tester,
  ) async {
    final host = _PowerHost();
    final monitor = MacosPowerStateMonitor(supported: true, messenger: host);
    void first() {}
    void second() {}
    expect(monitor.value, MacosPowerState.unknown);
    expect(host.calls, isEmpty);
    monitor.addListener(first);
    monitor.addListener(second);
    await tester.pump();
    expect(host.calls, ['listen']);
    await host.emit('disabled');
    expect(monitor.value, MacosPowerState.disabled);
    await host.emit('enabled');
    expect(monitor.value, MacosPowerState.enabled);
    monitor.removeListener(first);
    await tester.pump();
    expect(host.calls, ['listen']);
    monitor.removeListener(second);
    expect(monitor.value, MacosPowerState.unknown);
    await tester.pump();
    expect(host.calls, ['listen', 'cancel']);
    expect(host.handler, isNull);
    monitor.addListener(first);
    await tester.pump();
    expect(monitor.value, MacosPowerState.unknown);
    expect(host.calls, ['listen', 'cancel', 'listen']);
    monitor.dispose();
    await tester.pump();
  });

  for (final failure in ['missing', 'error']) {
    testWidgets(
      '$failure activation remains static without a framework error',
      (tester) async {
        final host = _PowerHost()
          ..initialState = 'disabled'
          ..activationFailure = failure;
        final monitor = MacosPowerStateMonitor(
          supported: true,
          messenger: host,
        );
        monitor.addListener(() {});
        await tester.pump();
        expect(monitor.value, MacosPowerState.unknown);
        expect(host.calls, ['listen', 'cancel']);
        expect(host.handler, isNull);
        expect(tester.takeException(), isNull);
        monitor.dispose();
        await tester.pump();
      },
    );
  }

  testWidgets(
    'malformed and failed events are static; ended streams stay closed',
    (tester) async {
      final host = _PowerHost();
      final monitor = MacosPowerStateMonitor(supported: true, messenger: host);
      monitor.addListener(() {});
      await tester.pump();
      await host.emit('disabled');
      await host.event({'schemaVersion': 1, 'lowPowerMode': false});
      expect(monitor.value, MacosPowerState.unknown);
      await host.emit('disabled');
      await host.handler!(
        _PowerHost.codec.encodeErrorEnvelope(code: 'unavailable'),
      );
      expect(monitor.value, MacosPowerState.unknown);
      await host.emit('disabled');
      await host.handler!(ByteData(1));
      expect(monitor.value, MacosPowerState.unknown);
      await host.emit('disabled');
      final oldHandler = host.handler!;
      await oldHandler(null);
      expect(monitor.value, MacosPowerState.unknown);
      await tester.pump();
      await oldHandler(
        _PowerHost.codec.encodeSuccessEnvelope({
          'schemaVersion': 1,
          'lowPowerMode': 'disabled',
        }),
      );
      expect(monitor.value, MacosPowerState.unknown);
      expect(host.calls, ['listen', 'cancel']);
      monitor.dispose();
      await tester.pump();
    },
  );

  testWidgets('resume waits for cancellation and a fresh host snapshot', (
    tester,
  ) async {
    final host = _PowerHost();
    final monitor = MacosPowerStateMonitor(supported: true, messenger: host);
    monitor.addListener(() {});
    await tester.pump();
    await host.emit('disabled');
    final oldHandler = host.handler!;
    host.cancelBarrier = Completer<void>();
    monitor.didChangeAppLifecycleState(AppLifecycleState.inactive);
    expect(monitor.value, MacosPowerState.unknown);
    await tester.pump();
    expect(host.calls, ['listen', 'cancel']);
    expect(host.handler, isNotNull);
    await host.emit('disabled'); // Dropped while the old host sink is closing.
    monitor.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await tester.pump();
    expect(host.calls, ['listen', 'cancel']);
    expect(monitor.value, MacosPowerState.unknown);
    host.cancelBarrier!.complete();
    await tester.pump();
    expect(host.calls, ['listen', 'cancel', 'listen']);
    await oldHandler(
      _PowerHost.codec.encodeSuccessEnvelope({
        'schemaVersion': 1,
        'lowPowerMode': 'disabled',
      }),
    );
    expect(monitor.value, MacosPowerState.unknown);
    await host.emit('enabled');
    expect(monitor.value, MacosPowerState.enabled);
    await host.emit('disabled');
    expect(monitor.value, MacosPowerState.disabled);
    monitor.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await tester.pump();
    expect(host.calls, ['listen', 'cancel', 'listen']);
    monitor.dispose();
    await tester.pump();
    expect(host.handler, isNull);
  });

  testWidgets(
    'disposal during activation fences late events and closes the sink',
    (tester) async {
      final host = _PowerHost()..listenBarrier = Completer<void>();
      final monitor = MacosPowerStateMonitor(supported: true, messenger: host);
      var notifications = 0;
      monitor.addListener(() => notifications++);
      await tester.pump();
      final oldHandler = host.handler!;
      monitor.dispose();
      await oldHandler(
        _PowerHost.codec.encodeSuccessEnvelope({
          'schemaVersion': 1,
          'lowPowerMode': 'disabled',
        }),
      );
      expect(notifications, 0);
      host.listenBarrier!.complete();
      await tester.pump();
      expect(host.calls, ['listen', 'cancel']);
      expect(host.handler, isNull);
      expect(tester.takeException(), isNull);
    },
  );
}
