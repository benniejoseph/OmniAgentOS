import 'dart:typed_data';

import 'package:asael/app/router/app_router.dart';
import 'package:asael/core/platform/local_computer_bridge.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/computer_use/local_computer.dart';
import 'package:asael/features/talk/talk.dart';
import 'package:asael/features/talk/talk_providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'mounted Conversation follows owner-scoped controller replacement',
    (tester) async {
      final firstRepository = _RecordingTalkRepository();
      final liveRepository = _RecordingTalkRepository();
      final container = ProviderContainer(
        overrides: [
          sessionControllerProvider.overrideWith(_TestSessionController.new),
          talkRepositoryProvider.overrideWith((ref) {
            final owner = ref.watch(sessionOwnerKeyProvider);
            return owner?.actorId == _ownerB.actorId
                ? liveRepository
                : firstRepository;
          }),
          reconnectCoordinatorProvider.overrideWithValue(
            ReconnectCoordinator(() async => const [], const Stream.empty()),
          ),
          localComputerRepositoryProvider.overrideWithValue(
            _UnusedLocalComputerRepository(),
          ),
          localComputerNativeHostProvider.overrideWithValue(
            _UnsupportedLocalComputerHost(),
          ),
        ],
      );
      addTearDown(container.dispose);
      await container.read(sessionControllerProvider.future);

      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: ProviderBoundTalkRoute()),
        ),
      );
      await tester.pump();

      final firstView = tester.widget<TalkView>(find.byType(TalkView));
      final firstController = firstView.controller;
      expect(
        identical(
          firstView.localComputer,
          container.read(localComputerCoordinatorProvider),
        ),
        isTrue,
      );

      firstController.enqueuePrompt('notification-only update');
      await tester.pump();
      expect(
        identical(tester.widget<TalkView>(find.byType(TalkView)), firstView),
        isTrue,
        reason: 'controller notifications must not rebuild the route binding',
      );

      final sessions = container.read(
        sessionControllerProvider.notifier,
      ) as _TestSessionController;
      sessions.replace(_ownerB);
      await tester.pump();

      final liveView = tester.widget<TalkView>(find.byType(TalkView));
      expect(identical(liveView.controller, firstController), isFalse);
      expect(
        identical(liveView.controller, container.read(talkControllerProvider)),
        isTrue,
      );
      expect(
        identical(
          liveView.localComputer,
          container.read(localComputerCoordinatorProvider),
        ),
        isTrue,
      );

      await tester.enterText(find.byType(TextField), 'Open my XAUUSD chart');
      await tester.tap(find.byTooltip('Send message'));
      await tester.pump();

      expect(firstRepository.messages, isEmpty);
      expect(liveRepository.messages, ['Open my XAUUSD chart']);
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

class _TestSessionController extends SessionController {
  @override
  Future<AppSession?> build() async => _ownerA;

  void replace(AppSession? session) {
    state = AsyncData(session);
  }
}

class _RecordingTalkRepository implements TalkRepository {
  final messages = <String>[];

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
  }) {
    messages.add(message);
    return const Stream.empty();
  }

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => '';
}

class _UnusedLocalComputerRepository implements LocalComputerRepository {
  @override
  Future<LocalComputerClaimResponse> claim() async =>
      throw UnimplementedError();

  @override
  Future<void> complete(LocalComputerCompletion completion) async =>
      throw UnimplementedError();

  @override
  Future<void> stop(String reason) async => throw UnimplementedError();

  @override
  Future<LocalComputerDeviceSnapshot> updateDevice(
    LocalComputerStatus status,
  ) async => throw UnimplementedError();
}

class _UnsupportedLocalComputerHost implements LocalComputerNativeHost {
  @override
  bool get supported => false;

  @override
  void attachStoppedHandler(LocalComputerStoppedHandler? handler) {}

  @override
  Future<void> dispose() async {}

  @override
  Future<LocalComputerCommandResult> execute(
    LocalComputerCommand command,
  ) async => throw UnimplementedError();

  @override
  Future<LocalComputerStatus> getStatus() async => throw UnimplementedError();

  @override
  Future<void> initialize() async => throw UnimplementedError();

  @override
  Future<LocalComputerStatus> requestPermissions() async =>
      throw UnimplementedError();

  @override
  Future<LocalComputerStatus> setEnabled(bool enabled) async =>
      throw UnimplementedError();

  @override
  Future<LocalComputerStatus> stop() async => throw UnimplementedError();
}
