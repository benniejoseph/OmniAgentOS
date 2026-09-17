import 'dart:async';

import 'package:asael/core/platform/local_computer_bridge.dart';
import 'package:asael/features/computer_use/local_computer.dart';
import 'package:flutter_test/flutter_test.dart';

const _commandId =
    'local_computer_command_0123456789abcdef0123456789abcdef0123456789abcdef';
const _claimToken = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789';

void main() {
  test('only an unmarked primary Flutter engine can claim commands', () {
    expect(
      LocalComputerWindowContext.fromArguments(const []).canClaimCommands,
      isTrue,
    );
    final auxiliary = LocalComputerWindowContext.fromArguments(const [
      '--asael-route=/talk',
      '--asael-window=123e4567-e89b-42d3-a456-426614174000',
    ]);
    expect(auxiliary.role, LocalComputerWindowRole.auxiliary);
    expect(auxiliary.windowId, '123e4567-e89b-42d3-a456-426614174000');
    expect(auxiliary.canClaimCommands, isFalse);

    final malformed = LocalComputerWindowContext.fromArguments(const [
      '--asael-window=not-trusted',
    ]);
    expect(malformed.role, LocalComputerWindowRole.auxiliary);
    expect(malformed.windowId, isNull);
    expect(malformed.canClaimCommands, isFalse);
  });

  test(
    'a completion receipt retries without replaying the local action',
    () async {
      final repository = _FakeRepository(
        command: _claim(),
        failFirstCompletion: true,
      );
      final host = _FakeHost();
      final coordinator = LocalComputerCoordinator(
        repository: repository,
        host: host,
        windowContext: const LocalComputerWindowContext(
          role: LocalComputerWindowRole.primary,
        ),
        authenticated: true,
        idleRefreshInterval: const Duration(milliseconds: 1),
        heartbeatInterval: const Duration(milliseconds: 20),
        failureRetryInterval: const Duration(milliseconds: 1),
      );
      addTearDown(coordinator.dispose);

      await repository.completed.future.timeout(const Duration(seconds: 2));

      expect(host.executedIds, [_commandId]);
      expect(repository.completionAttempts, 2);
      expect(
        repository.acceptedCompletions.single.payload['outcome'],
        'succeeded',
      );
    },
  );

  test(
    'an expired prior claim fails closed instead of executing twice',
    () async {
      final repository = _FakeRepository(command: _claim(claimGeneration: 2));
      final host = _FakeHost();
      final coordinator = LocalComputerCoordinator(
        repository: repository,
        host: host,
        windowContext: const LocalComputerWindowContext(
          role: LocalComputerWindowRole.primary,
        ),
        authenticated: true,
        idleRefreshInterval: const Duration(milliseconds: 1),
        heartbeatInterval: const Duration(milliseconds: 20),
        failureRetryInterval: const Duration(milliseconds: 1),
      );
      addTearDown(coordinator.dispose);

      await repository.completed.future.timeout(const Duration(seconds: 2));

      expect(host.executedIds, isEmpty);
      expect(repository.acceptedCompletions.single.payload, {
        'schemaVersion': localComputerProtocolVersion,
        'claimToken': _claimToken,
        'outcome': 'canceled',
        'errorCode': 'uncertain_prior_claim',
      });
    },
  );

  test('an auxiliary engine can inspect but never claims', () async {
    final repository = _FakeRepository(command: _claim());
    final host = _FakeHost();
    final coordinator = LocalComputerCoordinator(
      repository: repository,
      host: host,
      windowContext: const LocalComputerWindowContext(
        role: LocalComputerWindowRole.auxiliary,
        windowId: '123e4567-e89b-42d3-a456-426614174000',
      ),
      authenticated: true,
      idleRefreshInterval: const Duration(milliseconds: 1),
      heartbeatInterval: const Duration(milliseconds: 1),
      failureRetryInterval: const Duration(milliseconds: 1),
    );
    addTearDown(coordinator.dispose);

    await Future<void>.delayed(const Duration(milliseconds: 30));

    expect(coordinator.status?.ready, isTrue);
    expect(repository.claims, 0);
    expect(host.executedIds, isEmpty);
  });

  test('Stop now trips the native kill switch before server cleanup', () async {
    final order = <String>[];
    final repository = _FakeRepository(order: order);
    final host = _FakeHost(order: order);
    final coordinator = LocalComputerCoordinator(
      repository: repository,
      host: host,
      windowContext: const LocalComputerWindowContext(
        role: LocalComputerWindowRole.auxiliary,
      ),
      authenticated: true,
    );
    addTearDown(coordinator.dispose);
    await Future<void>.delayed(Duration.zero);

    await coordinator.stopNow();

    expect(order.take(2), ['native-stop', 'server-stop']);
    expect(coordinator.phase, LocalComputerBrokerPhase.stopped);
  });
}

LocalComputerClaim _claim({int claimGeneration = 1}) =>
    LocalComputerClaim.fromJson({
      'schemaVersion': localComputerProtocolVersion,
      'id': _commandId,
      'action': 'observe',
      'input': {'includeScreenshot': false},
      'claimToken': _claimToken,
      'claimGeneration': claimGeneration,
      'expiresAt': DateTime.now()
          .toUtc()
          .add(const Duration(minutes: 1))
          .toIso8601String(),
    });

class _FakeRepository implements LocalComputerRepository {
  _FakeRepository({this.command, this.failFirstCompletion = false, this.order});

  LocalComputerClaim? command;
  final bool failFirstCompletion;
  final List<String>? order;
  final completed = Completer<void>();
  final acceptedCompletions = <LocalComputerCompletion>[];
  var completionAttempts = 0;
  var claims = 0;

  @override
  Future<LocalComputerClaimResponse> claim() async {
    claims += 1;
    final next = command;
    command = null;
    return LocalComputerClaimResponse(
      command: next,
      pollAfter: const Duration(milliseconds: 1),
    );
  }

  @override
  Future<void> complete(LocalComputerCompletion completion) async {
    completionAttempts += 1;
    if (failFirstCompletion && completionAttempts == 1) {
      throw StateError('receipt transport failed');
    }
    acceptedCompletions.add(completion);
    if (!completed.isCompleted) completed.complete();
  }

  @override
  Future<void> stop(String reason) async {
    order?.add('server-stop');
  }

  @override
  Future<LocalComputerDeviceSnapshot> updateDevice(
    LocalComputerStatus status,
  ) async => LocalComputerDeviceSnapshot(
    enabled: status.enabled,
    online: status.ready,
    activityState: status.active ? 'active' : 'idle',
    lastSeenAt: DateTime.now().toUtc(),
  );
}

class _FakeHost implements LocalComputerNativeHost {
  _FakeHost({this.order});

  final List<String>? order;
  final executedIds = <String>[];
  LocalComputerStoppedHandler? stoppedHandler;
  var current = const LocalComputerStatus(
    supported: true,
    helperInstalled: true,
    enabled: true,
    active: false,
    accessibility: LocalComputerPermission.granted,
    screenRecording: LocalComputerPermission.granted,
    helperVersion: '1.0.0',
  );

  @override
  bool get supported => true;

  @override
  void attachStoppedHandler(LocalComputerStoppedHandler? handler) {
    stoppedHandler = handler;
  }

  @override
  Future<void> dispose() async {}

  @override
  Future<LocalComputerCommandResult> execute(
    LocalComputerCommand command,
  ) async {
    executedIds.add(command.id);
    return const LocalComputerCommandResult(
      outcome: LocalComputerOutcome.succeeded,
      summary: 'Observed the active Mac workspace.',
    );
  }

  @override
  Future<LocalComputerStatus> getStatus() async => current;

  @override
  Future<void> initialize() async {}

  @override
  Future<LocalComputerStatus> requestPermissions() async => current;

  @override
  Future<LocalComputerStatus> setEnabled(bool enabled) async {
    current = LocalComputerStatus(
      supported: current.supported,
      helperInstalled: current.helperInstalled,
      enabled: enabled,
      active: false,
      accessibility: current.accessibility,
      screenRecording: current.screenRecording,
      helperVersion: current.helperVersion,
    );
    return current;
  }

  @override
  Future<LocalComputerStatus> stop() async {
    order?.add('native-stop');
    current = LocalComputerStatus(
      supported: current.supported,
      helperInstalled: current.helperInstalled,
      enabled: false,
      active: false,
      accessibility: current.accessibility,
      screenRecording: current.screenRecording,
      helperVersion: current.helperVersion,
    );
    return current;
  }
}
