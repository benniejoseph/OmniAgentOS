import 'dart:convert';
import 'dart:async';

import 'package:asael/features/computer_use/local_computer.dart';
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
          String? agentId,
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
    String? agentId,
  }) async* {
    calls.add((
      message: message,
      mode: mode,
      strategy: strategy,
      executionTarget: executionTarget,
      agentId: agentId,
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
    String? agentId,
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
    String? agentId,
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
      'fileArtifacts': [
        {
          'artifactId': 'artifact_service_cloud_pitch',
          'version': 2,
          'kind': 'presentation',
          'title': 'Service Cloud AI pitch',
          'filename': 'service-cloud-ai-pitch.pptx',
          'mediaType': TalkMediaArtifactSummary.powerPointMediaType,
          'byteCount': 3,
          'status': 'ready',
          'slideCount': 10,
          'theme': 'aurora',
          'contentUrl': 'https://untrusted.example/private-presentation.pptx',
        },
      ],
      'workspaceArtifactState': 'ready',
      'workspaceArtifacts': [
        {
          'executionId': 'execution_google_doc_123',
          'sequence': 9,
          'provider': 'google_workspace',
          'kind': 'document',
          'resourceId': 'google_resource_pitch_123',
          'title': 'Service Cloud proposal',
          'createdAt': '2026-09-19T08:30:00.000Z',
          'openUrl': 'https://untrusted.example/steal-session',
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
    String? agentId,
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

class _LocalPreviewTalkRepository implements TalkRepository {
  @override
  Future<void> cancelRun(String runId) async {}

  @override
  Future<TalkRunInspection> inspectRun(String runId) async => _runInspection(
    runId,
    'completed',
    response: 'The requested screenshot is ready.',
  );

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
  }) async* {
    yield const SseEvent(
      event: 'run',
      data: {'type': 'run', 'runId': 'run-local-preview'},
    );
    yield const SseEvent(
      event: 'tool',
      data: {
        'type': 'tool',
        'toolId': 'local.macos.observe',
        'toolName': 'Observe This Mac',
        'status': 'executed',
        'executionId': 'run-local-preview:execution-local-preview',
      },
    );
    yield const SseEvent(
      event: 'done',
      data: {'type': 'done', 'response': 'The requested screenshot is ready.'},
    );
  }

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => 'Unused';
}

class _HeldLocalPreviewTalkRepository implements TalkRepository {
  final events = StreamController<SseEvent>();

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
  }) => events.stream;

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => 'Unused';
}

class _LocalPreviewSource implements LocalComputerPreviewSource {
  _LocalPreviewSource({
    Duration ttl = const Duration(minutes: 5),
    String runId = 'run-local-preview',
    String executionId = 'run-local-preview:execution-local-preview',
  }) : _preview = LocalComputerScreenshotPreview(
         runId: runId,
         executionId: executionId,
         mediaType: 'image/png',
         bytes: base64Decode(
           'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
         ),
         capturedAt: DateTime.now().toUtc(),
         expiresAt: DateTime.now().toUtc().add(ttl),
         applicationName: 'Google Chrome',
       );

  LocalComputerScreenshotPreview? _preview;
  final takeCalls = <String>[];
  final takeRunCalls = <String>[];

  @override
  void discardRunPreviews(String runId) {
    if (_preview?.runId == runId) _preview = null;
  }

  @override
  LocalComputerScreenshotPreview? takePreview(
    String runId,
    String executionId,
  ) {
    takeCalls.add('$runId/$executionId');
    final preview = _preview;
    if (preview?.runId != runId || preview?.executionId != executionId) {
      return null;
    }
    _preview = null;
    return preview;
  }

  @override
  List<LocalComputerScreenshotPreview> takeRunPreviews(String runId) {
    takeRunCalls.add(runId);
    final preview = _preview;
    if (preview?.runId != runId) return const [];
    _preview = null;
    return [preview!];
  }
}

class _QueuedTalkRepository implements TalkRepository {
  final calls = <String>[];
  final targets = <TalkExecutionTarget>[];
  final agentIds = <String?>[];
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
    String? agentId,
  }) async* {
    calls.add(message);
    targets.add(executionTarget);
    agentIds.add(agentId);
    if (calls.length == 1) await firstRun.future;
    yield SseEvent(
      event: 'done',
      data: {'type': 'done', 'response': 'Finished $message'},
    );
  }

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => 'Unused';
}

TalkRunInspection _runInspection(
  String runId,
  String status, {
  String? response,
  String? error,
  Map<String, dynamic>? waitingApproval,
}) => TalkRunInspection.fromJson({
  'run': {
    'id': runId,
    'threadId': 'thread-$runId',
    'status': status,
    'response': ?response,
    'error': ?error,
    'waitingApproval': ?waitingApproval,
  },
});

class _DisconnectedAcceptedRunRepository implements TalkRepository {
  final inspections = <TalkRunInspection>[
    _runInspection('run-recovery', 'running'),
    _runInspection(
      'run-recovery',
      'completed',
      response: 'The exact accepted run completed.',
    ),
  ];
  int sends = 0;
  int reads = 0;

  @override
  Future<void> cancelRun(String runId) async {}

  @override
  Future<TalkRunInspection> inspectRun(String runId) async {
    reads += 1;
    return inspections.length == 1
        ? inspections.single
        : inspections.removeAt(0);
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
    String? agentId,
  }) async* {
    sends += 1;
    yield const SseEvent(
      event: 'run',
      data: {
        'type': 'run',
        'runId': 'run-recovery',
        'threadId': 'thread-run-recovery',
      },
    );
    throw StateError('live transport ended');
  }

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => 'Unused';
}

class _ApprovalRecoveryRepository implements TalkRepository {
  final approved = Completer<void>();
  int sends = 0;
  int reads = 0;

  @override
  Future<void> cancelRun(String runId) async {}

  @override
  Future<TalkRunInspection> inspectRun(String runId) async {
    reads += 1;
    if (reads == 1) {
      return _runInspection(
        runId,
        'waiting_approval',
        response: 'Review the exact click before continuing.',
        waitingApproval: {
          'executionId': 'execution-exact-click',
          'toolId': 'local.macos.click',
          'toolName': 'Click chart',
        },
      );
    }
    if (reads == 2) {
      await approved.future;
      return _runInspection(runId, 'resuming');
    }
    return _runInspection(
      runId,
      'completed',
      response: 'Chrome is open on the requested chart.',
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
    String? agentId,
  }) async* {
    sends += 1;
    yield const SseEvent(
      event: 'run',
      data: {'type': 'run', 'runId': 'run-approval-recovery'},
    );
    yield const SseEvent(
      event: 'waiting_approval',
      data: {
        'type': 'waiting_approval',
        'executionId': 'execution-exact-click',
        'toolId': 'local.macos.click',
        'message': 'Review the exact click before continuing.',
      },
    );
  }

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => 'Unused';
}

class _ReentryRecoveryRepository implements TalkRepository {
  int reads = 0;

  @override
  Future<void> cancelRun(String runId) async {}

  @override
  Future<TalkRunInspection> inspectRun(String runId) async {
    reads += 1;
    return reads == 1
        ? _runInspection(runId, 'running')
        : _runInspection(
            runId,
            'completed',
            response: 'Recovered after returning to Conversation.',
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
    String? agentId,
  }) async* {
    yield const SseEvent(
      event: 'run',
      data: {'type': 'run', 'runId': 'run-reentry'},
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
          agentId: null,
        ),
        (
          message: 'Do this',
          mode: 'orchestrate',
          strategy: 'direct',
          executionTarget: TalkExecutionTarget.thisMac,
          agentId: null,
        ),
      ]);
    },
  );

  test(
    'pins an assigned Agent through a failed request and exact retry',
    () async {
      final repository = _TalkRepository()..failNext = true;
      final controller = TalkController(repository)
        ..assignAgent(id: 'agent-moltbook', name: 'Moltbook Steward');

      await controller.send('Read the home feed');
      controller.clearAssignedAgent();
      await controller.retryLast();

      expect(repository.calls.map((call) => call.agentId), [
        'agent-moltbook',
        'agent-moltbook',
      ]);
      expect(repository.calls.map((call) => call.strategy), [
        'direct',
        'direct',
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

  test(
    'recovers the exact accepted run without exposing a duplicate retry',
    () async {
      final repository = _DisconnectedAcceptedRunRepository();
      final controller = TalkController(
        repository,
        runRecoveryPollInterval: Duration.zero,
        runRecoveryPollLimit: 4,
      );

      await controller.send('Open the chart');
      await _settleAsync(20);

      expect(repository.sends, 1);
      expect(repository.reads, 2);
      expect(controller.canRetry, isFalse);
      expect(controller.messages.last.failed, isFalse);
      expect(
        controller.messages.last.text,
        'The exact accepted run completed.',
      );
      expect(
        controller.activities
            .singleWhere((activity) => activity.key == 'run')
            .state,
        TalkActivityState.succeeded,
      );
    },
  );

  test(
    'keeps one accepted approval-paused run until its response completes',
    () async {
      final repository = _ApprovalRecoveryRepository();
      final controller = TalkController(
        repository,
        runRecoveryPollInterval: Duration.zero,
        runRecoveryPollLimit: 6,
      );

      await controller.send('Open the chart');
      await _settleAsync(10);

      expect(repository.sends, 1);
      expect(controller.canRetry, isFalse);
      expect(controller.status, 'Waiting for approval');
      expect(
        controller.activities
            .singleWhere((item) => item.key == 'approval:execution-exact-click')
            .actionRoute,
        '/inbox/approvals/execution-exact-click',
      );

      repository.approved.complete();
      await _settleAsync(20);

      expect(repository.sends, 1);
      expect(repository.reads, 3);
      expect(controller.canRetry, isFalse);
      expect(
        controller.messages.last.text,
        'Chrome is open on the requested chart.',
      );
      expect(
        controller.activities
            .singleWhere((item) => item.key == 'approval:execution-exact-click')
            .state,
        TalkActivityState.succeeded,
      );
    },
  );

  test('queues prompts during a run and drains them in order', () async {
    final repository = _QueuedTalkRepository();
    final controller = TalkController(repository);

    final first = controller.send('First prompt');
    await _settleAsync(2);
    controller.assignAgent(id: 'agent-a', name: 'Agent A');
    await controller.send(
      'Second prompt',
      executionTarget: TalkExecutionTarget.thisMac,
    );
    controller.assignAgent(id: 'agent-b', name: 'Agent B');
    await controller.send(
      'Third prompt',
      strategy: 'direct',
      executionTarget: TalkExecutionTarget.agent,
    );

    expect(controller.promptQueue.map((item) => item.input), [
      'Second prompt',
      'Third prompt',
    ]);
    expect(controller.promptQueue.map((item) => item.executionTarget), [
      TalkExecutionTarget.thisMac,
      TalkExecutionTarget.agent,
    ]);
    expect(repository.calls, ['First prompt']);

    repository.firstRun.complete();
    await first;
    await _settleAsync(20);

    expect(repository.calls, ['First prompt', 'Second prompt', 'Third prompt']);
    expect(repository.targets, [
      TalkExecutionTarget.agent,
      TalkExecutionTarget.thisMac,
      TalkExecutionTarget.agent,
    ]);
    expect(repository.agentIds, [null, 'agent-a', 'agent-b']);
    expect(controller.promptQueue, isEmpty);
    expect(
      controller.messages.where((item) => item.role == TalkRole.user),
      hasLength(3),
    );
  });

  test('runs a queued prompt now with its exact assigned Agent', () async {
    final repository = _QueuedTalkRepository();
    final controller = TalkController(repository);

    final first = controller.send('First prompt');
    await _settleAsync(2);
    controller.assignAgent(id: 'agent-moltbook', name: 'Moltbook Steward');
    await controller.send('Read the home feed');
    final queuedId = controller.promptQueue.single.id;
    controller.pauseQueue();

    repository.firstRun.complete();
    await first;
    await _settleAsync(4);
    controller.clearAssignedAgent();
    await controller.runQueuedPrompt(queuedId);

    expect(repository.calls, ['First prompt', 'Read the home feed']);
    expect(repository.agentIds, [null, 'agent-moltbook']);
    expect(controller.promptQueue, isEmpty);
  });

  test('pauses queued prompts behind a governed approval', () async {
    final controller = TalkController(
      _ActivityTalkRepository(),
      runRecoveryPollLimit: 1,
    );

    await controller.send('Prepare an email');
    controller.enqueuePrompt('Continue after approval');
    await _settleAsync();

    expect(controller.queuePaused, isTrue);
    expect(controller.promptQueue.single.input, 'Continue after approval');
  });

  test(
    'projects tools, specialists, and approvals as observable activity',
    () async {
      final controller = TalkController(
        _ActivityTalkRepository(),
        runRecoveryPollLimit: 1,
      );

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

  test('projects supported terminal evidence and ignores legacy isolated-browser evidence', () async {
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
        'Presentation ready',
        'Google Doc ready',
      ]),
    );
    final projection = controller.activities
        .map((activity) => '${activity.title} ${activity.detail}')
        .join(' ');
    expect(projection, contains('Orchestrator · definition v4'));
    expect(projection, contains('1 source · 1 cited · 1 context items used'));
    expect(projection, contains('portrait.png · image/png · 2.0 KB'));
    expect(
      projection,
      contains('Service Cloud AI pitch · 10 slides · 3 B · Private'),
    );
    expect(projection, isNot(contains('Untrusted source title')));
    expect(projection, isNot(contains('private source content')));
    expect(projection, isNot(contains('untrusted.example')));
    expect(projection, isNot(contains('private tool payload')));
    expect(projection, isNot(contains('Computer Use evidence captured')));
    expect(projection, isNot(contains('Open website')));
    expect(projection, isNot(contains('example.com')));
    final workspaceActivity = controller.activities.singleWhere(
      (activity) => activity.title == 'Google Doc ready',
    );
    expect(workspaceActivity.actionLabel, 'Open in Google');
    expect(
      workspaceActivity.externalUri.toString(),
      'https://docs.google.com/document/d/google_resource_pitch_123/edit',
    );
    expect(workspaceActivity.actionRoute, isNull);
    await _settleAsync();
    expect(controller.artifacts.map((item) => item.filename), [
      'service-cloud-ai-pitch.pptx',
      'portrait.png',
    ]);
    expect(repository.loadedAssetIds, ['artifact_service_cloud_pitch']);
    expect(repository.loadedAssetIds, isNot(contains('computer_frame_1')));
    expect(controller.selectedArtifact?.isPresentation, isTrue);
    expect(controller.selectedArtifactContent?.bytes, [1, 2, 3]);
  });

  testWidgets(
    'renders a retired state without fetching a historical computer frame',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1400, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final repository = _TerminalTalkRepository();
      final controller = TalkController(repository);
      const artifact = TalkMediaArtifactSummary(
        assetId: 'computer_frame_legacy',
        kind: 'computer',
        operation: 'observe',
        filename: 'computer-use.png',
        mediaType: 'image/png',
        byteCount: 4096,
        status: 'stored',
        sourceRunId: 'run_legacy',
      );
      controller.artifacts.add(artifact);

      await controller.selectArtifact(artifact);

      expect(controller.artifactError, isA<LegacyComputerPreviewRetired>());
      expect(repository.loadedAssetIds, isEmpty);
      await tester.pumpWidget(
        MaterialApp(home: TalkView(controller: controller)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Artifacts'));
      await tester.pumpAndSettle();

      expect(find.text('Legacy browser preview retired'), findsOneWidget);
      expect(repository.loadedAssetIds, isEmpty);
    },
  );

  test(
    'attaches an exact local screenshot once without loading a remote asset',
    () async {
      final previews = _LocalPreviewSource();
      final controller = TalkController(
        _LocalPreviewTalkRepository(),
        localComputerPreviews: previews,
      );

      await controller.send(
        'Show me a screenshot of the chart',
        executionTarget: TalkExecutionTarget.thisMac,
      );

      expect(previews.takeCalls, [
        'run-local-preview/run-local-preview:execution-local-preview',
      ]);
      expect(controller.artifacts, hasLength(1));
      expect(controller.artifacts.single.status, 'temporary');
      expect(
        controller.artifacts.single.contextLabel,
        contains('Google Chrome'),
      );
      expect(controller.selectedArtifactContent?.bytes, isNotEmpty);
      expect(
        controller.activities.map((activity) => activity.title),
        contains('Screenshot ready'),
      );
    },
  );

  test('a disposed Conversation ignores late screenshot events', () async {
    final repository = _HeldLocalPreviewTalkRepository();
    final previews = _LocalPreviewSource();
    final controller = TalkController(
      repository,
      localComputerPreviews: previews,
    );
    final send = controller.send(
      'Show me a screenshot of the chart',
      executionTarget: TalkExecutionTarget.thisMac,
    );
    await Future<void>.delayed(Duration.zero);
    repository.events.add(
      const SseEvent(
        event: 'run',
        data: {'type': 'run', 'runId': 'run-local-preview'},
      ),
    );
    await Future<void>.delayed(Duration.zero);

    controller.dispose();
    repository.events.add(
      const SseEvent(
        event: 'tool',
        data: {
          'type': 'tool',
          'toolId': 'local.macos.observe',
          'status': 'executed',
          'executionId': 'run-local-preview:execution-local-preview',
        },
      ),
    );
    await repository.events.close();
    await send;

    expect(previews.takeCalls, isEmpty);
    expect(controller.artifacts, isEmpty);
  });

  test(
    'reconnect polling attaches a screenshot before the run is terminal',
    () async {
      final previews = _LocalPreviewSource(
        runId: 'run-recovery',
        executionId: 'run-recovery:execution-observe',
      );
      final controller = TalkController(
        _DisconnectedAcceptedRunRepository(),
        localComputerPreviews: previews,
        runRecoveryPollInterval: Duration.zero,
        runRecoveryPollLimit: 1,
      );

      await controller.send(
        'Open the chart and show me what you see',
        executionTarget: TalkExecutionTarget.thisMac,
      );
      await _settleAsync();

      expect(previews.takeRunCalls, ['run-recovery']);
      expect(controller.artifacts, hasLength(1));
      expect(controller.artifacts.single.kind, 'computer');
    },
  );

  testWidgets(
    'shows the temporary screenshot in Conversation at narrow width',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(900, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final controller = TalkController(
        _LocalPreviewTalkRepository(),
        localComputerPreviews: _LocalPreviewSource(),
      );
      await controller.send(
        'Show me a screenshot of the chart',
        executionTarget: TalkExecutionTarget.thisMac,
      );
      final imageKey = MemoryImage(controller.selectedArtifactContent!.bytes);

      await tester.pumpWidget(
        MaterialApp(
          home: TalkView(
            controller: controller,
            voiceRecorder: _VoiceDraftRecorder(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Screenshot from This Mac'), findsOneWidget);
      expect(
        find.text('Private temporary preview · not kept in Conversation'),
        findsOneWidget,
      );
      expect(find.byTooltip('Run artifacts'), findsOneWidget);
      expect(
        PaintingBinding.instance.imageCache.statusForKey(imageKey).tracked,
        isTrue,
      );

      await tester.pump(const Duration(minutes: 6));
      expect(find.text('Screenshot from This Mac'), findsNothing);
      expect(controller.artifacts, isEmpty);
      expect(
        PaintingBinding.instance.imageCache.statusForKey(imageKey).untracked,
        isTrue,
      );
    },
  );

  testWidgets('shows the live activity rail at a desktop width', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = TalkController(
      _ActivityTalkRepository(),
      runRecoveryPollLimit: 1,
    );
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

  testWidgets('shows the captured Agent on queued and retry work', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final repository = _TalkRepository()..failNext = true;
    final controller = TalkController(repository)
      ..assignAgent(id: 'agent-moltbook', name: 'Moltbook Steward');
    controller.enqueuePrompt('Read the home feed', strategy: 'direct');
    await controller.send('Read the selected thread');
    controller.clearAssignedAgent();

    await tester.pumpWidget(
      MaterialApp(
        home: TalkView(
          controller: controller,
          voiceRecorder: _VoiceDraftRecorder(),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Retry as Moltbook Steward'), findsOneWidget);
    await tester.tap(find.byTooltip('Prompt queue'));
    await tester.pump();
    expect(find.text('Moltbook Steward · Direct · Asael only'), findsOneWidget);
  });

  testWidgets('Conversation re-entry resumes an accepted exact run', (
    tester,
  ) async {
    final repository = _ReentryRecoveryRepository();
    final controller = TalkController(
      repository,
      runRecoveryPollInterval: Duration.zero,
      runRecoveryPollLimit: 1,
    );
    await controller.send('Continue the accepted run');
    await tester.pump();
    expect(repository.reads, 1);
    expect(controller.monitoringAcceptedRun, isFalse);

    await tester.pumpWidget(
      MaterialApp(
        home: TalkView(
          controller: controller,
          voiceRecorder: _VoiceDraftRecorder(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(repository.reads, 2);
    expect(
      controller.messages.last.text,
      'Recovered after returning to Conversation.',
    );
    expect(controller.canRetry, isFalse);
  });

  testWidgets(
    'Quick Entry exits on submit and Escape while retaining its controller',
    (tester) async {
      final repository = _TalkRepository();
      final controller = TalkController(repository)
        ..assignAgent(id: 'agent-moltbook', name: 'Moltbook Steward');
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
      expect(find.text('Moltbook Steward · Direct'), findsOneWidget);
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
      expect(repository.calls.single.agentId, 'agent-moltbook');
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
