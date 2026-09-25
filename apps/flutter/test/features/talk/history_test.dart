import 'dart:typed_data';

import 'package:asael/features/talk/talk.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _threadA = '11111111-1111-4111-8111-111111111111';
const _threadB = '22222222-2222-4222-8222-222222222222';

class _HistoryRepository implements TalkRepository, TalkHistoryRepository {
  bool failList = false;
  bool failDetail = false;
  bool failMemory = false;
  final sentThreadIds = <String?>[];
  final openedThreadIds = <String>[];
  final memoryThreadIds = <String>[];

  final threads = <TalkThreadSummary>[
    TalkThreadSummary(
      id: _threadA,
      title: 'Launch planning',
      mode: 'orchestrate',
      updatedAt: DateTime.now().subtract(const Duration(minutes: 8)),
    ),
    TalkThreadSummary(
      id: _threadB,
      title: 'Research notebook',
      mode: 'research',
      updatedAt: DateTime.now().subtract(const Duration(days: 1)),
    ),
  ];

  @override
  Future<List<TalkThreadSummary>> listThreads({int limit = 30}) async {
    if (failList) throw StateError('offline');
    return threads.take(limit).toList();
  }

  @override
  Future<TalkThreadDetail> getThread(String threadId) async {
    openedThreadIds.add(threadId);
    if (failDetail) throw StateError('offline');
    final thread = threads.singleWhere((item) => item.id == threadId);
    return TalkThreadDetail(
      thread: thread,
      turns: [
        TalkThreadTurn(
          role: TalkThreadRole.user,
          text: 'Question for $threadId',
        ),
        TalkThreadTurn(
          role: TalkThreadRole.assistant,
          text: 'Public answer for $threadId',
        ),
      ],
    );
  }

  @override
  Future<List<TalkThreadMemorySummary>> listThreadMemories(
    String threadId, {
    int limit = 24,
  }) async {
    memoryThreadIds.add(threadId);
    if (failMemory) throw StateError('offline');
    return [
      TalkThreadMemorySummary(
        id: 'memory-$threadId',
        title: 'Preferred launch window',
        type: 'decision',
      ),
    ];
  }

  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    String? agentId,
    TalkCommandModelSelection? modelSelection,
  }) async* {
    sentThreadIds.add(threadId);
    yield const SseEvent(
      event: 'done',
      data: {'type': 'done', 'response': 'Continued exact conversation.'},
    );
  }

  @override
  Future<void> cancelRun(String runId) async {}

  @override
  Future<TalkRunInspection> inspectRun(String runId) async =>
      throw UnimplementedError();

  @override
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId) async =>
      throw UnimplementedError();

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => 'voice';
}

class _VoiceRecorder implements VoiceDraftRecorder {
  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() async {}

  @override
  Future<bool> hasPermission() async => true;

  @override
  Future<void> start(String outputPath) async {}

  @override
  Future<String?> stop() async => null;
}

void main() {
  test('parses only bounded public conversation turns', () {
    final detail = TalkThreadDetail.fromJson({
      'thread': {
        'id': _threadA,
        'title': '  Launch\u0001   planning  ',
        'mode': 'orchestrate',
        'privateAuthority': 'must not project',
      },
      'turns': [
        {
          'id': 'turn-1',
          'threadId': _threadA,
          'role': 'user',
          'content': 'Public question',
          'privateReasoning': 'must not project',
        },
        {
          'id': 'turn-2',
          'threadId': _threadA,
          'role': 'assistant',
          'content': 'Public answer',
          'runId': 'run-public-result',
          'toolPayload': 'must not project',
        },
        {
          'id': 'turn-3',
          'threadId': _threadA,
          'role': 'tool',
          'content': 'private tool output',
        },
        {
          'id': 'turn-4',
          'threadId': _threadB,
          'role': 'assistant',
          'content': 'wrong conversation',
        },
      ],
      'summaries': [
        {'content': 'not a public transcript turn'},
      ],
    });

    expect(detail.thread.title, 'Launch planning');
    expect(detail.turns.map((turn) => turn.text), [
      'Public question',
      'Public answer',
    ]);
    expect(detail.turns.last.runId, 'run-public-result');
    expect(
      detail.turns.map((turn) => turn.text).join(' '),
      isNot(contains('private')),
    );
  });

  test('opens an exact durable thread and continues it on send', () async {
    final repository = _HistoryRepository();
    final controller = TalkController(repository);

    expect(controller.conversationHistorySupported, isTrue);
    await controller.loadRecentThreads();
    expect(controller.historyState, TalkHistoryState.ready);
    expect(controller.recentThreads, hasLength(2));

    await controller.openThread(_threadA);
    expect(controller.threadId, _threadA);
    expect(controller.threadState, TalkThreadState.ready);
    expect(controller.messages.map((message) => message.text), [
      'Question for $_threadA',
      'Public answer for $_threadA',
    ]);
    expect(controller.selectedThreadMemoryCount, 1);
    expect(controller.memoryContextState, TalkMemoryContextState.ready);
    expect(repository.openedThreadIds, [_threadA]);
    expect(repository.memoryThreadIds, [_threadA]);

    await controller.send('Continue');
    expect(repository.sentThreadIds, [_threadA]);
    expect(controller.messages.last.text, 'Continued exact conversation.');

    controller.newConversation();
    expect(controller.threadId, isNull);
    expect(controller.messages, isEmpty);
    expect(controller.threadState, TalkThreadState.idle);
  });

  test(
    'retains last loaded history and transcript as stale on read failure',
    () async {
      final repository = _HistoryRepository();
      final controller = TalkController(repository);

      await controller.loadRecentThreads();
      repository.failList = true;
      await controller.loadRecentThreads(force: true);
      expect(controller.historyState, TalkHistoryState.stale);
      expect(controller.recentThreads, hasLength(2));

      repository.failList = false;
      await controller.openThread(_threadA);
      final transcript = List<TalkMessage>.of(controller.messages);
      repository.failDetail = true;
      await controller.refreshSelectedThread();

      expect(controller.threadState, TalkThreadState.stale);
      expect(controller.failedThreadId, _threadA);
      expect(
        controller.messages.map((item) => item.text),
        transcript.map((item) => item.text),
      );
    },
  );

  test('keeps transcript usable when linked memory is unavailable', () async {
    final repository = _HistoryRepository()..failMemory = true;
    final controller = TalkController(repository);

    await controller.openThread(_threadB);

    expect(controller.threadState, TalkThreadState.ready);
    expect(controller.memoryContextState, TalkMemoryContextState.stale);
    expect(controller.messages, hasLength(2));
  });

  testWidgets('shows history, transcript, and live activity on desktop', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1500, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final repository = _HistoryRepository();
    final controller = TalkController(repository);
    await controller.loadRecentThreads();
    await controller.openThread(_threadA);

    await tester.pumpWidget(
      MaterialApp(
        home: TalkView(controller: controller, voiceRecorder: _VoiceRecorder()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Conversations'), findsOneWidget);
    expect(find.text('Launch planning'), findsWidgets);
    expect(find.text('Research notebook'), findsOneWidget);
    expect(find.text('1 linked memory'), findsOneWidget);
    expect(find.text('Public answer for $_threadA'), findsOneWidget);
    expect(find.text('Live activity'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('conversation-$_threadB')));
    await tester.pumpAndSettle();
    expect(find.text('Public answer for $_threadB'), findsOneWidget);
  });

  testWidgets('uses a conversation-history sheet below desktop width', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = TalkController(_HistoryRepository());

    await tester.pumpWidget(
      MaterialApp(
        home: TalkView(controller: controller, voiceRecorder: _VoiceRecorder()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byTooltip('Conversation history'), findsOneWidget);
    expect(find.text('Conversations'), findsNothing);
    await tester.tap(find.byTooltip('Conversation history'));
    await tester.pumpAndSettle();
    expect(find.text('Conversations'), findsOneWidget);
    expect(find.text('Launch planning'), findsOneWidget);
    expect(find.byTooltip('New conversation'), findsOneWidget);
  });
}
