import 'dart:async';

import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'reconciles every registered projection in deterministic order',
    () async {
      final changes = StreamController<List<ConnectivityResult>>.broadcast();
    final coordinator = ReconnectCoordinator(
      () async => [ConnectivityResult.wifi],
      changes.stream,
    );
      final calls = <String>[];
      final complete = Completer<void>();
      coordinator.register('today', () async {
        calls.add('today');
        complete.complete();
      });
      coordinator.register('capture', () async {
        calls.add('capture');
      }, priority: 0);
      await coordinator.start();

      changes.add([ConnectivityResult.none]);
      await Future<void>.delayed(Duration.zero);
      expect(coordinator.phase, ReconnectPhase.offline);

      changes.add([ConnectivityResult.wifi]);
      await complete.future;
      await Future<void>.delayed(Duration.zero);

      expect(calls, ['capture', 'today']);
      expect(coordinator.phase, ReconnectPhase.online);
      expect(coordinator.lastReason, ReconnectReason.networkRestored);
      expect(coordinator.lastReconciledAt, isNotNull);
      coordinator.dispose();
      await changes.close();
    },
  );

  test(
    'continues reconciliation and reports an isolated hook failure',
    () async {
    final coordinator = ReconnectCoordinator(
      () async => [ConnectivityResult.ethernet],
      const Stream.empty(),
    );
      var laterHookRan = false;
      coordinator.register('broken', () async => throw StateError('offline'));
      coordinator.register('later', () async => laterHookRan = true);
      await coordinator.start();

      await coordinator.reconcile(ReconnectReason.manual);

      expect(laterHookRan, isTrue);
      expect(coordinator.phase, ReconnectPhase.degraded);
      expect(coordinator.failures.keys, ['broken']);
      coordinator.dispose();
    },
  );

  test('does not run reconciliation hooks while offline', () async {
    final coordinator = ReconnectCoordinator(
      () async => [ConnectivityResult.none],
      const Stream.empty(),
    );
    var calls = 0;
    coordinator.register('today', () async => calls += 1);
    await coordinator.start();

    await coordinator.reconcile(ReconnectReason.appResumed);

    expect(calls, 0);
    expect(coordinator.phase, ReconnectPhase.offline);
    coordinator.dispose();
  });
}
