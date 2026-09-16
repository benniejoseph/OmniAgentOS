import 'dart:convert';
import 'dart:typed_data';

import 'package:asael/features/talk/talk.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _TalkRepository implements TalkRepository {
  final calls = <({String message, String mode, String strategy})>[];
  var failNext = false;
  var transcriptions = 0;

  @override
  Future<void> cancelRun(String runId) async {}

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
  }) async* {
    calls.add((message: message, mode: mode, strategy: strategy));
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
  Future<String> transcribeVoice(Uint8List bytes) async => 'Unused';

  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
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

      await controller.send('Do this', strategy: 'direct');
      expect(controller.messages, hasLength(2));
      expect(controller.messages.last.failed, isTrue);
      expect(controller.canRetry, isTrue);

      await controller.retryLast();
      expect(controller.messages, hasLength(2));
      expect(controller.messages.last.text, 'Ready');
      expect(repository.calls, [
        (message: 'Do this', mode: 'orchestrate', strategy: 'direct'),
        (message: 'Do this', mode: 'orchestrate', strategy: 'direct'),
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
