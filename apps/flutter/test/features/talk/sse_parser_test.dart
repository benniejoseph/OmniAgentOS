import 'dart:convert';
import 'dart:async';

import 'package:asael/features/talk/talk.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

class _TalkRepository implements TalkRepository {
  final calls =
      <
        ({
          String message,
          String mode,
          String strategy,
          TalkExecutionTarget executionTarget,
        })
      >[];
  var failNext = false;
  var transcriptions = 0;

  @override
  Future<void> cancelRun(String runId) async {}

  @override
  Future<TalkRunInspection> inspectRun(String runId) async =>
      throw UnimplementedError();

  @override
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId) async =>
      throw UnimplementedError();

  @override
  Future<String> transcribeVoice(Uint8List bytes) async {
    transcriptions += 1;
    return 'Reviewed voice';
  }

  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
  }) async* {
    calls.add((
      message: message,
      mode: mode,
      strategy: strategy,
      executionTarget: executionTarget,
    ));
    if (failNext) {
      failNext = false;
      throw StateError('offline');
    }
    yield const SseEvent(
      event: 'done',
      data: {'type': 'done', 'response': 'Ready'},
    );
  }
}

class _ActivityTalkRepository implements TalkRepository {
  final canceledRunIds = <String>[];

  @override
  Future<void> cancelRun(String runId) async => canceledRunIds.add(runId);

  @override
  Future<TalkRunInspection> inspectRun(String runId) async =>
      throw UnimplementedError();

  @override
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId) async =>
      throw UnimplementedError();

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => 'Unused';

  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
  }) async* {
    yield const SseEvent(
      event: 'run',
      data: {'type': 'run', 'runId': 'run-observable-123456'},
    );
    yield const SseEvent(
      event: 'harness',
      data: {
        'type': 'harness',
        'provider': 'openai',
        'model': 'configured-model',
        'toolCount': 4,
        'skillIds': ['research', 'memory'],
      },
    );
    yield const SseEvent(
      event: 'council_member',
      data: {
        'type': 'council_member',
        'agentId': 'scout',
        'agentName': 'Scout',
        'role': 'Research specialist',
        'status': 'completed',
        'taskId': 'task-1',
      },
    );
    yield const SseEvent(
      event: 'tool',
      data: {
        'type': 'tool',
        'toolId': 'knowledge.search',
        'toolName': 'Knowledge search',
        'status': 'executed',
        'executionId': 'execution-1',
        'summary': 'Searched the allowed workspace context.',
      },
    );
    yield const SseEvent(
      event: 'waiting_approval',
      data: {
        'type': 'waiting_approval',
        'executionId': 'execution-2',
        'toolId': 'mail.send',
        'message': 'Review the email before it is sent.',
      },
    );
  }
}

class _DelegatedTalkRepository implements TalkRepository {
  _DelegatedTalkRepository({this.alwaysRunning = false});

  final bool alwaysRunning;
  int workflowReads = 0;

  @override
  Future<void> cancelRun(String runId) async {}

  @override
  Future<TalkRunInspection> inspectRun(String runId) async =>
      throw UnimplementedError();

  @override
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId) async {
    workflowReads += 1;
    return TalkWorkflowSnapshot(
      id: workflowId,
      status: alwaysRunning || workflowReads == 1 ? 'running' : 'completed',
      currentStep: 'execute',
    );
  }

  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
  }) async* {
    yield const SseEvent(
      event: 'delegated',
      data: {
        'type': 'delegated',
        'threadId': 'thread-durable',
        'workflowId': 'workflow-durable-123456',
        'acknowledgement': 'I moved this into durable background work.',
        'reason': 'The request needs more time than an interactive run.',
      },
    );
  }

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => 'Unused';
}

class _TerminalTalkRepository
    implements TalkRepository, TalkArtifactRepository {
  final inspectedRunIds = <String>[];
  final loadedAssetIds = <String>[];

  @override
  Future<void> cancelRun(String runId) async {}

  @override
  Future<TalkRunInspection> inspectRun(String runId) async {
    inspectedRunIds.add(runId);
    return TalkRunInspection.fromJson({
      'run': {
        'id': runId,
        'status': 'completed',
        'grounding': {
          'status': 'verified',
          'citedIds': ['knowledge:one'],
          'invalidIds': <String>[],
          'sources': [
            {
              'title': 'Untrusted source title',
              'snippet': 'private source content must not enter activity',
            },
          ],
        },
      },
      'contextReceipt': {
        'actualCount': 1,
        'actualEvidenceIds': ['knowledge:one'],
      },
      'agentIdentity': {
        'state': 'ready',
        'card': {
          'name': 'Atlas',
          'role': 'Orchestrator',
          'definitionVersion': 4,
        },
      },
      'mediaArtifacts': [
        {
          'assetId': 'capture_asset_portrait',
          'kind': 'image',
          'operation': 'generate',
          'filename': 'portrait.png',
          'mediaType': 'image/png',
          'byteCount': 2048,
          'status': 'stored',
          'contentUrl': 'https://untrusted.example/private.png',
          'rawOutput': 'private tool payload',
        },
      ],
      'computerUseEvidence': [
        {
          'executionId': 'execution-browser-1',
          'sequence': 7,
          'action': 'Open website',
          'operation': 'browser_navigate',
          'status': 'executed',
          'targetOrigin': 'https://example.com',
          'frame': {
            'id': 'computer_frame_1',
            'mediaType': 'image/png',
            'byteCount': 4096,
            'filename': 'computer-use-0007.png',
            'contentUrl': 'https://untrusted.example/computer.png',
          },
        },
      ],
    });
  }

  @override
  Future<TalkArtifactContent> loadArtifact(
    TalkMediaArtifactSummary artifact,
  ) async {
    final assetId = artifact.assetId;
    loadedAssetIds.add(assetId);
    return TalkArtifactContent(
      assetId: assetId,
      bytes: Uint8List.fromList([1, 2, 3]),
    );
  }

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
  }) async* {
    yield const SseEvent(
      event: 'run',
      data: {'type': 'run', 'runId': 'run-terminal-123456'},
    );
    yield const SseEvent(
      event: 'done',
      data: {'type': 'done', 'response': 'Finished with evidence.'},
    );
  }

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => 'Unused';
}

class _QueuedTalkRepository implements TalkRepository {
  final calls = <String>[];
  final targets = <TalkExecutionTarget>[];
  final firstRun = Completer<void>();

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
  }) async* {
    calls.add(message);
    targets.add(executionTarget);
    if (calls.length == 1) await firstRun.future;
    yield SseEvent(
      event: 'done',
      data: {'type': 'done', 'response': 'Finished $message'},
    );
  }

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => 'Unused';
}

Future<void> _settleAsync([int turns = 12]) async {
  for (var index = 0; index < turns; index += 1) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  test('parses SSE across arbitrary byte boundaries', () async {
    final source =
        'event: status\r\ndata: {"type":"status","label":"Thinking"}\r\n\r\nevent: delta\ndata: {"type":"delta",\ndata: "text":"Hello"}\n\n';
    final bytes = utf8.encode(source);
    final chunks = <List<int>>[
      bytes.sublist(0, 7),
      bytes.sublist(7, 31),
      bytes.sublist(31, 68),
      bytes.sublist(68),
    ];
    final events = await parseSse(Stream.fromIterable(chunks)).toList();
    expect(events.map((e) => e.event), ['status', 'delta']);
    expect(events.first.data['label'], 'Thinking');
    expect(events.last.data['text'], 'Hello');
  });

  test('flushes final event without trailing newline', () async {
    final events = await parseSse(
      Stream.value(
        utf8.encode('event: done\ndata: {"type":"done","response":"Ready"}'),
      ),
    ).toList();
    expect(events.single.data['response'], 'Ready');
  });

  test(
    'maps Direct to strategy and retries without duplicating the user',
    () async {
      final repository = _TalkRepository()..failNext = true;
      final controller = TalkController(repository);

      await controller.send(
        'Do this',
        strategy: 'direct',
        executionTarget: TalkExecutionTarget.thisMac,
      );
      expect(controller.messages, hasLength(2));
      expect(controller.messages.last.failed, isTrue);
      expect(controller.canRetry, isTrue);

      await controller.retryLast();
      expect(controller.messages, hasLength(2));
      expect(controller.messages.last.text, 'Ready');
      expect(repository.calls, [
        (
          message: 'Do this',
          mode: 'orchestrate',
          strategy: 'direct',
          executionTarget: TalkExecutionTarget.thisMac,
        ),
        (
          message: 'Do this',
          mode: 'orchestrate',
          strategy: 'direct',
          executionTarget: TalkExecutionTarget.thisMac,
        ),
      ]);
    },
  );

  test(
    'transcribes voice into a reviewable draft without sending it',
    () async {
      final repository = _TalkRepository();
      final controller = TalkController(repository);

      final transcript = await controller.transcribeVoice(
        Uint8List.fromList([1]),
      );

      expect(transcript, 'Reviewed voice');
      expect(controller.messages, isEmpty);
      expect(repository.calls, isEmpty);
    },
  );

  test('queues prompts during a run and drains them in order', () async {
    final repository = _QueuedTalkRepository();
    final controller = TalkController(repository);

    final first = controller.send('First prompt');
    await _settleAsync(2);
    await controller.send(
      'Second prompt',
      executionTarget: TalkExecutionTarget.thisMac,
    );
    await controller.send(
      'Third prompt',
      strategy: 'direct',
      executionTarget: TalkExecutionTarget.isolatedBrowser,
    );

    expect(controller.promptQueue.map((item) => item.input), [
      'Second prompt',
      'Third prompt',
    ]);
    expect(controller.promptQueue.map((item) => item.executionTarget), [
      TalkExecutionTarget.thisMac,
      TalkExecutionTarget.isolatedBrowser,
    ]);
    expect(repository.calls, ['First prompt']);

    repository.firstRun.complete();
    await first;
    await _settleAsync(20);

    expect(repository.calls, ['First prompt', 'Second prompt', 'Third prompt']);
    expect(repository.targets, [
      TalkExecutionTarget.agent,
      TalkExecutionTarget.thisMac,
      TalkExecutionTarget.isolatedBrowser,
    ]);
    expect(controller.promptQueue, isEmpty);
    expect(
      controller.messages.where((item) => item.role == TalkRole.user),
      hasLength(3),
    );
  });

  test('pauses queued prompts behind a governed approval', () async {
    final controller = TalkController(_ActivityTalkRepository());

    await controller.send('Prepare an email');
    controller.enqueuePrompt('Continue after approval');
    await _settleAsync();

    expect(controller.queuePaused, isTrue);
    expect(controller.promptQueue.single.input, 'Continue after approval');
  });

  test(
    'projects tools, specialists, and approvals as observable activity',
    () async {
      final controller = TalkController(_ActivityTalkRepository());

      await controller.send('Research and prepare the result');

      expect(controller.runId, 'run-observable-123456');
      expect(
        controller.activities.map((activity) => activity.title),
        containsAll([
          'Main agent',
          'Run context prepared',
          'Scout',
          'Knowledge search',
          'Approval required',
        ]),
      );
      expect(
        controller.activities
            .singleWhere((activity) => activity.title == 'Knowledge search')
            .state,
        TalkActivityState.succeeded,
      );
      expect(
        controller.activities
            .singleWhere((activity) => activity.title == 'Approval required')
            .state,
        TalkActivityState.waiting,
      );
      expect(
        controller.activities
            .singleWhere((activity) => activity.title == 'Approval required')
            .actionRoute,
        '/inbox/approvals/execution-2',
      );
      expect(controller.messages.last.streaming, isFalse);
      expect(
        controller.messages.last.text,
        'Review the email before it is sent.',
      );
    },
  );

  test(
    'retains delegated workflows and monitors them to a terminal state',
    () async {
      final repository = _DelegatedTalkRepository();
      final controller = TalkController(
        repository,
        workflowPollInterval: Duration.zero,
        workflowPollLimit: 4,
      );

      await controller.send('Continue this in the background');
      await _settleAsync();

      expect(controller.workflowIds, ['workflow-durable-123456']);
      expect(repository.workflowReads, 2);
      expect(controller.monitoringWorkflowIds, isEmpty);
      final activity = controller.activities.singleWhere(
        (item) => item.key == 'workflow:workflow-durable-123456',
      );
      expect(activity.title, 'Background work complete');
      expect(activity.state, TalkActivityState.succeeded);
      expect(
        activity.actionRoute,
        '/results/workflow%3Aworkflow-durable-123456',
      );
    },
  );

  test('stops live workflow checks at the configured bound', () async {
    final repository = _DelegatedTalkRepository(alwaysRunning: true);
    final controller = TalkController(
      repository,
      workflowPollInterval: Duration.zero,
      workflowPollLimit: 2,
    );

    await controller.send('Keep working durably');
    await _settleAsync();

    expect(repository.workflowReads, 2);
    expect(controller.monitoringWorkflowIds, isEmpty);
    final activity = controller.activities.singleWhere(
      (item) => item.key == 'workflow:workflow-durable-123456',
    );
    expect(activity.title, 'Background work still running');
    expect(activity.state, TalkActivityState.waiting);
  });

  test('fetches terminal run evidence without projecting raw source or tool output', () async {
    final repository = _TerminalTalkRepository();
    final controller = TalkController(repository);

    await controller.send('Create the evidence-backed media');

    expect(repository.inspectedRunIds, ['run-terminal-123456']);
    expect(
      controller.activities.map((activity) => activity.title),
      containsAll([
        'Atlas',
        'Evidence verified',
        'Image Generate',
        'Computer Use evidence captured',
      ]),
    );
    final projection = controller.activities
        .map((activity) => '${activity.title} ${activity.detail}')
        .join(' ');
    expect(projection, contains('Orchestrator · definition v4'));
    expect(projection, contains('1 source · 1 cited · 1 context items used'));
    expect(projection, contains('portrait.png · image/png · 2.0 KB'));
    expect(projection, isNot(contains('Untrusted source title')));
    expect(projection, isNot(contains('private source content')));
    expect(projection, isNot(contains('untrusted.example')));
    expect(projection, isNot(contains('private tool payload')));
    await _settleAsync();
    expect(controller.artifacts.map((item) => item.filename), [
      'portrait.png',
      'computer-use-0007.png',
    ]);
    expect(repository.loadedAssetIds, ['capture_asset_portrait']);
    expect(controller.selectedArtifactContent?.bytes, [1, 2, 3]);
  });

  testWidgets('shows the live activity rail at a desktop width', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = TalkController(_ActivityTalkRepository());
    await controller.send('Research and prepare the result');

    await tester.pumpWidget(
      MaterialApp(
        home: TalkView(
          controller: controller,
          voiceRecorder: _VoiceDraftRecorder(),
        ),
      ),
    );

    expect(find.text('Live activity'), findsOneWidget);
    expect(find.text('Scout'), findsOneWidget);
    expect(find.text('Approval required'), findsOneWidget);
    expect(find.text('Review approval'), findsOneWidget);
    expect(find.textContaining('Governed run run-observab'), findsOneWidget);
  });

  testWidgets(
    'Quick Entry exits on submit and Escape while retaining its controller',
    (tester) async {
      final repository = _TalkRepository();
      final controller = TalkController(repository);
      var exits = 0;
      var presentationReady = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: TalkView(
            controller: controller,
            voiceRecorder: _VoiceDraftRecorder(),
            quickEntry: true,
            onQuickEntryReady: () => presentationReady += 1,
            onExitQuickEntry: () => exits += 1,
          ),
        ),
      );
      await tester.pump();

      expect(presentationReady, 1);
      expect(find.text('Quick Entry'), findsOneWidget);
      expect(find.text('Conversation'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('talk-execution-target')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('This Mac').last);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('quick-entry-input')),
        'Prepare my briefing',
      );
      await tester.tap(find.byTooltip('Send and open Conversation'));
      await tester.pump();

      expect(exits, 1);
      expect(repository.calls.single.message, 'Prepare my briefing');
      expect(
        repository.calls.single.executionTarget,
        TalkExecutionTarget.thisMac,
      );
      expect(controller.messages.first.text, 'Prepare my briefing');

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(exits, 2);
    },
  );

  testWidgets(
    'interrupts a backgrounded voice draft without transcription or send',
    (tester) async {
      final repository = _TalkRepository();
      final recorder = _VoiceDraftRecorder();
      await tester.pumpWidget(
        MaterialApp(
          home: TalkView(
            controller: TalkController(repository),
            voiceRecorder: recorder,
          ),
        ),
      );

      await tester.tap(find.byTooltip('Record voice draft'));
      await tester.pump();
      expect(recorder.starts, 1);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pumpAndSettle();

      expect(recorder.cancels, greaterThanOrEqualTo(1));
      expect(repository.transcriptions, 0);
      expect(repository.calls, isEmpty);
      expect(find.text('Recording voice draft…'), findsNothing);
    },
  );
}

class _VoiceDraftRecorder implements VoiceDraftRecorder {
  var starts = 0;
  var cancels = 0;

  @override
  Future<void> cancel() async => cancels += 1;

  @override
  Future<void> dispose() async {}

  @override
  Future<bool> hasPermission() async => true;

  @override
  Future<void> start(String outputPath) async => starts += 1;

  @override
  Future<String?> stop() async => null;
}
