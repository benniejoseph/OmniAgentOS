import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/capture/capture.dart';
import 'package:asael/features/capture/capture_outbox.dart';
import 'package:asael/features/talk/talk.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Capture uses a Mac intake workspace with processing inspector', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    tester.view.physicalSize = const Size(1360, 860);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = CaptureController(
      _CaptureRepository(),
      _CaptureOutbox(),
      const CaptureOwnerBinding(tenantId: 'tenant', actorId: 'actor'),
    );
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: CaptureView(controller: controller),
      ),
    );

    expect(find.text('Capture'), findsOneWidget);
    expect(find.text('Note'), findsOneWidget);
    expect(find.text('Record'), findsOneWidget);
    expect(find.text('Upload'), findsOneWidget);
    expect(find.text('Source and processing'), findsOneWidget);
    expect(tester.takeException(), isNull);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets(
    'Conversation uses compact Mac chrome and desktop activity rail',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      tester.view.physicalSize = const Size(1360, 860);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller = TalkController(_TalkRepository());
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        MaterialApp(
          theme: MacosAppTheme.light(),
          home: TalkView(controller: controller),
        ),
      );

      final scaffold = tester.widget<Scaffold>(find.byType(Scaffold).first);
      expect((scaffold.appBar! as AppBar).toolbarHeight, 56);
      expect(find.text('Assistant'), findsOneWidget);
      expect(find.text('Use a team'), findsNothing);
      final options = find.byKey(const ValueKey('talk-composer-options'));
      expect(options.hitTestable(), findsOneWidget);
      await tester.tap(options);
      await tester.pumpAndSettle();
      expect(find.text('Use a team'), findsOneWidget);
      expect(find.text('Work alone'), findsOneWidget);
      expect(
        find.byTooltip('Conversation actions').hitTestable(),
        findsOneWidget,
      );
      expect(find.text('What Asael is doing'), findsOneWidget);
      expect(tester.takeException(), isNull);
      debugDefaultTargetPlatformOverride = null;
    },
  );
}

class _CaptureRepository implements CaptureRepository {
  @override
  Future<CaptureJobSnapshot> readJob(
    String jobId, {
    required CaptureOwnerBinding owner,
  }) async => CaptureJobSnapshot(id: jobId, status: 'completed');

  @override
  Future<CaptureReceipt> submit(
    CaptureDraft draft, {
    required String idempotencyKey,
    required CaptureOwnerBinding owner,
  }) async => const CaptureReceipt(
    jobId: 'job-1',
    title: 'Saved',
    tags: [],
    jobStatus: 'completed',
  );
}

class _CaptureOutbox implements CaptureOutbox {
  @override
  Future<CaptureOutboxEntry> enqueue(
    CaptureOwnerBinding owner,
    CaptureDraft draft,
  ) => throw UnimplementedError();

  @override
  Future<CaptureOutboxEntry?> get(
    CaptureOwnerBinding owner,
    String entryId,
  ) async => null;

  @override
  Future<List<CaptureOutboxEntry>> list(CaptureOwnerBinding owner) async =>
      const [];

  @override
  Future<void> remove(CaptureOwnerBinding owner, String entryId) async {}
}

class _TalkRepository implements TalkRepository {
  @override
  Future<void> cancelRun(String runId) async {}

  @override
  Future<TalkRunInspection> inspectRun(String runId) =>
      throw UnimplementedError();

  @override
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId) =>
      throw UnimplementedError();

  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    String? agentId,
    TalkCommandModelSelection? modelSelection,
  }) => const Stream.empty();

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => '';
}
