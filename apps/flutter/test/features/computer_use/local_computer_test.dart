import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:asael/core/platform/local_computer_bridge.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/computer_use/local_computer.dart';
import 'package:asael/features/talk/talk.dart';
import 'package:asael/features/talk/talk_providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const _commandId =
    'local_computer_command_0123456789abcdef0123456789abcdef0123456789abcdef';
const _claimToken = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789';

void main() {
  test('coordinator identity follows the exact signed-in owner', () async {
    final localRepository = _FakeRepository();
    final localHost = _FakeHost();
    final container = ProviderContainer(
      overrides: [
        sessionControllerProvider.overrideWith(_TestSessionController.new),
        talkRepositoryProvider.overrideWithValue(_NoopTalkRepository()),
        reconnectCoordinatorProvider.overrideWithValue(
          ReconnectCoordinator(() async => const [], const Stream.empty()),
        ),
        localComputerRepositoryProvider.overrideWithValue(localRepository),
        localComputerNativeHostProvider.overrideWithValue(localHost),
      ],
    );
    addTearDown(container.dispose);
    await container.read(sessionControllerProvider.future);

    expect(container.read(sessionOwnerKeyProvider), _ownerAKey);
    final first = container.read(localComputerCoordinatorProvider);
    final firstTalk = container.read(talkControllerProvider);
    expect(identical(firstTalk.localComputerPreviews, first), isTrue);

    final sessions = container.read(
      sessionControllerProvider.notifier,
    ) as _TestSessionController;
    sessions.replace(_ownerAMetadataRefresh);
    await container.pump();
    expect(container.read(sessionOwnerKeyProvider), _ownerAKey);
    expect(
      identical(container.read(localComputerCoordinatorProvider), first),
      isTrue,
    );
    expect(
      identical(container.read(talkControllerProvider), firstTalk),
      isTrue,
    );

    sessions.replace(_ownerB);
    await container.pump();

    expect(container.read(sessionOwnerKeyProvider), _ownerBKey);
    final second = container.read(localComputerCoordinatorProvider);
    final secondTalk = container.read(talkControllerProvider);
    expect(identical(second, first), isFalse);
    expect(identical(secondTalk, firstTalk), isFalse);
    expect(identical(secondTalk.localComputerPreviews, second), isTrue);

    sessions.setLoading();
    await container.pump();
    expect(container.read(sessionOwnerKeyProvider), isNull);
    final loadingTalk = container.read(talkControllerProvider);
    expect(identical(loadingTalk, secondTalk), isFalse);
    expect(loadingTalk.localComputerPreviews, isNull);

    sessions.replace(_ownerB);
    await container.pump();
    sessions.setError();
    await container.pump();
    expect(container.read(sessionOwnerKeyProvider), isNull);
    expect(
      container.read(talkControllerProvider).localComputerPreviews,
      isNull,
    );

    sessions.replace(null);
    await container.pump();

    final signedOut = container.read(localComputerCoordinatorProvider);
    expect(identical(signedOut, second), isFalse);
    expect(signedOut.authenticated, isFalse);
  });

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

  test(
    'closing an auxiliary engine does not stop the primary Mac broker',
    () async {
      final repository = _FakeRepository();
      final host = _FakeHost();
      final coordinator = LocalComputerCoordinator(
        repository: repository,
        host: host,
        windowContext: const LocalComputerWindowContext(
          role: LocalComputerWindowRole.auxiliary,
        ),
        authenticated: true,
      );
      await Future<void>.delayed(Duration.zero);

      coordinator.dispose();
      await Future<void>.delayed(Duration.zero);

      expect(host.stopCalls, 0);
      expect(repository.stops, 0);
      expect(host.stoppedHandler, isNull);
    },
  );

  test(
    'disposing during native initialization cannot reattach a stale handler',
    () async {
      final initializeGate = Completer<void>();
      final repository = _FakeRepository();
      final host = _FakeHost(initializeGate: initializeGate);
      final coordinator = LocalComputerCoordinator(
        repository: repository,
        host: host,
        windowContext: const LocalComputerWindowContext(
          role: LocalComputerWindowRole.primary,
        ),
        authenticated: true,
      );
      await Future<void>.delayed(Duration.zero);

      coordinator.dispose();
      initializeGate.complete();
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(host.stoppedHandler, isNull);
      expect(host.stopCalls, 1);
      expect(repository.stops, 0);
    },
  );

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

  test(
    'an explicitly requested screenshot stays local and is consumed once',
    () async {
      final repository = _FakeRepository(
        command: _claim(presentScreenshot: true),
      );
      final host = _FakeHost(
        result: LocalComputerCommandResult(
          outcome: LocalComputerOutcome.succeeded,
          summary: 'Observed the active Mac workspace.',
          observation: {
            'snapshotRevision': 'a' * 64,
            'frontmostApplication': {
              'name': 'Google Chrome',
              'bundleId': 'com.google.Chrome',
              'pid': 123,
            },
            'screenshot': {
              'mimeType': 'image/jpeg',
              'dataBase64': base64Encode(const [0xff, 0xd8, 0xff, 0xd9]),
            },
          },
        ),
      );
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

      final preview = coordinator.takePreview(
        'run-local',
        'run-local:execution-local',
      );
      expect(preview?.applicationName, 'Google Chrome');
      expect(preview?.mediaType, 'image/jpeg');
      expect(preview?.bytes, const [0xff, 0xd8, 0xff, 0xd9]);
      expect(
        coordinator.takePreview('run-local', 'run-local:execution-local'),
        isNull,
      );
    },
  );

  test(
    'an open URL stages its explicitly requested post-navigation screenshot',
    () async {
      final repository = _FakeRepository(
        command: _claim(
          action: 'open_url',
          input: {
            'browser': 'chrome',
            'url': 'https://in.tradingview.com/chart/example',
            'loadWaitSeconds': 8,
          },
          presentScreenshot: true,
        ),
      );
      final host = _FakeHost(
        result: LocalComputerCommandResult(
          outcome: LocalComputerOutcome.succeeded,
          summary: 'Opened the requested page in Google Chrome.',
          observation: {
            'snapshotRevision': 'b' * 64,
            'frontmostApplication': {
              'name': 'Google Chrome',
              'bundleId': 'com.google.Chrome',
              'pid': 456,
            },
            'screenshot': {
              'mimeType': 'image/png',
              'dataBase64': base64Encode(const [
                0x89,
                0x50,
                0x4e,
                0x47,
                0x0d,
                0x0a,
                0x1a,
                0x0a,
              ]),
            },
          },
        ),
      );
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

      final preview = coordinator.takePreview(
        'run-local',
        'run-local:execution-local',
      );
      expect(preview?.applicationName, 'Google Chrome');
      expect(preview?.mediaType, 'image/png');
      expect(preview?.bytes, hasLength(8));
    },
  );

  test('an unconsumed screenshot is erased at its hard expiry', () async {
    final repository = _FakeRepository(
      command: _claim(presentScreenshot: true),
    );
    final host = _FakeHost(
      result: LocalComputerCommandResult(
        outcome: LocalComputerOutcome.succeeded,
        summary: 'Observed the active Mac workspace.',
        observation: {
          'snapshotRevision': 'a' * 64,
          'screenshot': {
            'mimeType': 'image/jpeg',
            'dataBase64': base64Encode(const [0xff, 0xd8, 0xff, 0xd9]),
          },
        },
      ),
    );
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
      previewTtl: const Duration(milliseconds: 10),
    );
    addTearDown(coordinator.dispose);

    await repository.completed.future.timeout(const Duration(seconds: 2));
    await Future<void>.delayed(const Duration(milliseconds: 30));

    expect(
      coordinator.takePreview('run-local', 'run-local:execution-local'),
      isNull,
    );
  });

  test(
    'a failed receipt retry drops screenshot bytes when its claim expires',
    () async {
      final repository = _FakeRepository(
        command: _claim(
          presentScreenshot: true,
          expiresAfter: const Duration(milliseconds: 40),
        ),
        alwaysFailCompletion: true,
      );
      final host = _FakeHost(
        becomeNotReadyAfterExecute: true,
        result: LocalComputerCommandResult(
          outcome: LocalComputerOutcome.succeeded,
          summary: 'Observed the active Mac workspace.',
          observation: {
            'snapshotRevision': 'a' * 64,
            'screenshot': {
              'mimeType': 'image/jpeg',
              'dataBase64': base64Encode(const [0xff, 0xd8, 0xff, 0xd9]),
            },
          },
        ),
      );
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

      await Future<void>.delayed(const Duration(milliseconds: 90));
      final attemptsAfterExpiry = repository.completionAttempts;
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(attemptsAfterExpiry, greaterThan(0));
      expect(repository.completionAttempts, attemptsAfterExpiry);
      expect(repository.completionAttempts, 1);
      expect(
        coordinator.takePreview('run-local', 'run-local:execution-local'),
        isNull,
      );
    },
  );

  test(
    'disabling clears a failed screenshot receipt before re-enable',
    () async {
      final repository = _FakeRepository(
        command: _claim(presentScreenshot: true),
        alwaysFailCompletion: true,
      );
      final host = _FakeHost(
        result: LocalComputerCommandResult(
          outcome: LocalComputerOutcome.succeeded,
          summary: 'Observed the active Mac workspace.',
          observation: {
            'snapshotRevision': 'a' * 64,
            'screenshot': {
              'mimeType': 'image/jpeg',
              'dataBase64': base64Encode(const [0xff, 0xd8, 0xff, 0xd9]),
            },
          },
        ),
      );
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

      while (repository.completionAttempts == 0) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
      await coordinator.setEnabled(false);
      final attemptsAtDisable = repository.completionAttempts;
      await coordinator.setEnabled(true);
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(repository.completionAttempts, attemptsAtDisable);
      expect(
        coordinator.takePreview('run-local', 'run-local:execution-local'),
        isNull,
      );
    },
  );

  test(
    'native command result caches have lease-bound physical expiry',
    () async {
      final hostSource = await File('macos/Runner/AppDelegate.swift')
          .readAsString();
      final helperSource = await File(
        'macos/ComputerUseHelper/HelperMain.swift',
      ).readAsString();

      for (final source in [hostSource, helperSource]) {
        expect(source, contains('struct CompletedRequest'));
        expect(source, contains('let expiresAt: Date'));
        expect(source, contains('purgeExpiredCompletions'));
        expect(source, contains('completionExpiryWorkItem'));
        expect(
          source,
          isNot(contains('private var completed: [String: [String: Any]]')),
        );
      }
      expect(hostSource, contains('clearCompletedRequests()'));
    },
  );
}

const _ownerA = AppSession(
  tenantId: 'tenant-a',
  actorId: 'actor-a',
  userId: 'user-a',
  email: 'a@example.test',
  displayName: 'A',
  workspaceName: 'A',
);
const _ownerB = AppSession(
  tenantId: 'tenant-b',
  actorId: 'actor-b',
  userId: 'user-b',
  email: 'b@example.test',
  displayName: 'B',
  workspaceName: 'B',
);
const _ownerAMetadataRefresh = AppSession(
  tenantId: 'tenant-a',
  actorId: 'actor-a',
  userId: 'user-a',
  email: 'a@example.test',
  displayName: 'A refreshed',
  workspaceName: 'A refreshed workspace',
);
const _ownerAKey = (tenantId: 'tenant-a', actorId: 'actor-a');
const _ownerBKey = (tenantId: 'tenant-b', actorId: 'actor-b');

class _TestSessionController extends SessionController {
  @override
  Future<AppSession?> build() async => _ownerA;

  void replace(AppSession? session) {
    state = AsyncData(session);
  }

  void setLoading() {
    state = const AsyncLoading();
  }

  void setError() {
    state = AsyncError(StateError('session unavailable'), StackTrace.current);
  }
}

class _NoopTalkRepository implements TalkRepository {
  @override
  Future<void> cancelRun(String runId) async {}

  @override
  Future<TalkRunInspection> inspectRun(String runId) async =>
      throw UnimplementedError();

  @override
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId) async =>
      throw UnimplementedError();

  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    String? agentId,
  }) => const Stream.empty();

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => '';
}

LocalComputerClaim _claim({
  int claimGeneration = 1,
  bool presentScreenshot = false,
  String action = 'observe',
  Map<String, Object?> input = const {'includeScreenshot': false},
  Duration expiresAfter = const Duration(minutes: 1),
}) => LocalComputerClaim.fromJson({
  'schemaVersion': localComputerProtocolVersion,
  'id': _commandId,
  'runId': 'run-local',
  'executionId': 'run-local:execution-local',
  'action': action,
  'input': input,
  'presentScreenshot': presentScreenshot,
  'claimToken': _claimToken,
  'claimGeneration': claimGeneration,
  'expiresAt': DateTime.now().toUtc().add(expiresAfter).toIso8601String(),
});

class _FakeRepository implements LocalComputerRepository {
  _FakeRepository({
    this.command,
    this.failFirstCompletion = false,
    this.alwaysFailCompletion = false,
    this.order,
  });

  LocalComputerClaim? command;
  final bool failFirstCompletion;
  final bool alwaysFailCompletion;
  final List<String>? order;
  final completed = Completer<void>();
  final acceptedCompletions = <LocalComputerCompletion>[];
  var completionAttempts = 0;
  var claims = 0;
  var stops = 0;

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
    if (alwaysFailCompletion ||
        (failFirstCompletion && completionAttempts == 1)) {
      throw StateError('receipt transport failed');
    }
    acceptedCompletions.add(completion);
    if (!completed.isCompleted) completed.complete();
  }

  @override
  Future<void> stop(String reason) async {
    stops += 1;
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
  _FakeHost({
    this.order,
    this.result,
    this.initializeGate,
    this.becomeNotReadyAfterExecute = false,
  });

  final List<String>? order;
  final LocalComputerCommandResult? result;
  final Completer<void>? initializeGate;
  final bool becomeNotReadyAfterExecute;
  final executedIds = <String>[];
  LocalComputerStoppedHandler? stoppedHandler;
  var stopCalls = 0;
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
    if (becomeNotReadyAfterExecute) {
      current = LocalComputerStatus(
        supported: current.supported,
        helperInstalled: current.helperInstalled,
        enabled: current.enabled,
        active: false,
        accessibility: LocalComputerPermission.denied,
        screenRecording: current.screenRecording,
        helperVersion: current.helperVersion,
      );
    }
    return result ??
        const LocalComputerCommandResult(
          outcome: LocalComputerOutcome.succeeded,
          summary: 'Observed the active Mac workspace.',
        );
  }

  @override
  Future<LocalComputerStatus> getStatus() async => current;

  @override
  Future<void> initialize() async {
    await initializeGate?.future;
  }

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
    stopCalls += 1;
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
