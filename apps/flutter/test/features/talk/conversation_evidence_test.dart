import 'dart:async';
import 'dart:typed_data';

import 'package:asael/features/talk/talk.dart';
import 'package:asael/features/talk/talk_rich_message.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _threadA = 'thread-a';
const _threadB = 'thread-b';
const _citation = 'web:0123456789abcdef';
const _unknownCitation = 'web:fedcba9876543210';
const _answer = 'Two nights are available. [$_citation]';

Map<String, dynamic> _source({
  String id = _citation,
  String url = 'https://hotel.example/rooms',
  String kind = 'web',
}) => {
  'citationId': id,
  'kind': kind,
  'url': url,
  'title': 'Hotel room availability',
};

TalkRunInspection _inspection(
  String runId, {
  String threadId = _threadA,
  List<Map<String, dynamic>>? sources,
  bool quickResearch = false,
}) => TalkRunInspection.fromJson({
  'run': {
    'id': runId,
    'threadId': threadId,
    'status': 'completed',
    'mode': quickResearch ? 'research' : 'orchestrate',
    'response': _answer,
    'grounding': {
      'status': 'missing',
      'sources': sources ?? [_source()],
      'citedIds': [_citation],
    },
    if (quickResearch)
      'researchProgress': {
        'schemaVersion': 1,
        'depth': 'quick',
        'stage': 'complete',
        'reportStatus': 'partial',
      },
  },
});

TalkThreadDetail _history(
  String threadId,
  List<String> runIds, {
  String content = _answer,
}) => TalkThreadDetail.fromJson({
  'thread': {'id': threadId, 'title': 'Room comparison'},
  'turns': [
    for (final id in runIds)
      {
        'threadId': threadId,
        'runId': id,
        'role': 'assistant',
        'content': content,
      },
  ],
});

class _EvidenceRepository implements TalkRepository, TalkHistoryRepository {
  final details = <String, TalkThreadDetail>{};
  final inspections = <String, TalkRunInspection>{};
  final streamSources = <String, List<Map<String, dynamic>>>{};
  final heldInspections = <String, Completer<TalkRunInspection>>{};
  final inspectedIds = <String>[];
  int sent = 0;

  @override
  Future<TalkThreadDetail> getThread(String threadId) async =>
      details[threadId]!;

  @override
  Future<List<TalkThreadSummary>> listThreads({int limit = 30}) async =>
      details.values.map((detail) => detail.thread).toList();

  @override
  Future<List<TalkThreadMemorySummary>> listThreadMemories(
    String threadId, {
    int limit = 24,
  }) async => const [];

  @override
  Future<TalkRunInspection> inspectRun(String runId) async {
    inspectedIds.add(runId);
    if (heldInspections[runId] case final held?) return held.future;
    final inspection = inspections[runId];
    if (inspection == null) throw StateError('Unavailable exact run');
    return inspection;
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
    final id = 'run-${++sent}';
    yield SseEvent(
      event: 'run',
      data: {'runId': id, 'threadId': threadId ?? _threadA},
    );
    yield SseEvent(
      event: 'done',
      data: {
        'response': _answer,
        if (streamSources[id] case final sources?)
          'grounding': {'sources': sources},
      },
    );
  }

  @override
  Future<void> cancelRun(String runId) async {}

  @override
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId) async =>
      throw UnimplementedError();

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => 'Unused';
}

Future<void> _settleProjection() => Future<void>.delayed(Duration.zero);

void main() {
  test(
    'history preserves Markdown structure while titles stay single line',
    () {
      const content =
          '# Rooms\r\n\r\nFirst paragraph.\r\n\r\n'
          '- Breakfast\r\n- Refundable\r\n\r\n'
          '```dart\r\n  final total = 100;\r\n\treturn total;\r\n```\r\n\r\n'
          '| Room | Total |\r\n| --- | --- |\r\n| Deluxe | 100 |';
      final detail = TalkThreadDetail.fromJson({
        'thread': {'id': _threadA, 'title': '  Room\n\t comparison  '},
        'turns': [
          {'threadId': _threadA, 'role': 'assistant', 'content': content},
        ],
      });
      expect(detail.thread.title, 'Room comparison');
      expect(detail.turns.single.text, content.replaceAll('\r\n', '\n'));
      expect(
        detail.turns.single.text,
        contains('  final total = 100;\n\treturn'),
      );
    },
  );

  test(
    'history still removes controls and bounds bodies by Unicode scalar',
    () {
      final turn = TalkThreadTurn.tryFromJson({
        'threadId': _threadA,
        'role': 'user',
        'content': 'Start\u0000\n${'😀' * 40000}',
      }, _threadA)!;
      expect(turn.text, startsWith('Start \n'));
      expect(turn.text.runes.length, 40000);
      expect(turn.text, endsWith('😀…'));
      expect(turn.text, isNot(contains('\u0000')));
    },
  );

  test('catalog accepts only bounded, unambiguous HTTP web sources', () {
    final sources = talkWebSourcesFromGrounding({
      'sources': [
        _source(),
        _source(),
        _source(id: 'knowledge:one'),
        _source(id: 'web:1111111111111111', kind: 'knowledge'),
        _source(id: 'web:2222222222222222', url: 'javascript:alert(1)'),
        _source(
          id: 'web:3333333333333333',
          url: 'https://user:secret@hotel.example',
        ),
        _source(id: 'web:4444444444444444', url: 'https://hotel.\nexample'),
        _source(id: 'web:5555555555555555', url: 'https:///rooms'),
        _source(id: _unknownCitation, url: 'https://one.example'),
        _source(id: _unknownCitation, url: 'https://two.example'),
        _source(id: _unknownCitation, url: 'https://one.example'),
      ],
    });
    expect(sources.map((source) => source.citationId), [_citation]);
    expect(sources.single.uri.toString(), 'https://hotel.example/rooms');
    expect(
      talkWebSourcesFromGrounding({
        'sources': [
          for (var index = 0; index < 100; index += 1) null,
          _source(),
        ],
      }),
      isEmpty,
    );
  });

  test('citation links preserve code and never infer unknown destinations', () {
    final sources = talkWebSourcesFromGrounding({
      'sources': [_source(url: 'https://hotel.example/rooms(deluxe)')],
    });
    final content =
        'Offer [$_citation]. Unknown [$_unknownCitation].\n\n'
        '`[$_citation]`\n\n```text\n[$_citation]\n```';
    final linked = linkTalkWebCitations(content, sources);
    expect(
      linked,
      startsWith(
        'Offer [hotel.example](https://hotel.example/rooms%28deluxe%29). '
        'Unknown [Source unavailable].',
      ),
    );
    expect(linked, endsWith('`[$_citation]`\n\n```text\n[$_citation]\n```'));
    expect(content, contains('Offer [$_citation]'));
  });

  test('ordinary live answers and copies use their own catalog, not prior runs', () async {
    final repository = _EvidenceRepository()
      ..inspections['run-1'] = _inspection('run-1')
      ..inspections['run-2'] = _inspection('run-2', sources: []);
    final controller = TalkController(repository);
    addTearDown(controller.dispose);
    await controller.send('Find a room');
    final first = controller.messages.last;
    expect(
      controller.displayMessageText(first),
      'Two nights are available. [hotel.example](https://hotel.example/rooms)',
    );
    expect(
      controller.copyMessageText(first),
      controller.displayMessageText(first),
    );
    expect(first.text, _answer);
    expect(controller.quickResearch, isNull);
    await controller.send('Find cheaper offers');
    expect(
      controller.displayMessageText(controller.messages.last),
      'Two nights are available. [Source unavailable]',
    );
    expect(
      controller.displayMessageText(first),
      contains('https://hotel.example/rooms'),
    );
    const user = TalkMessage(
      role: TalkRole.user,
      text: _answer,
      runId: 'run-1',
    );
    expect(controller.displayMessageText(user), _answer);
    expect(controller.copyMessageText(user), _answer);
  });

  test(
    'accepted stream sources survive an unavailable follow-up inspection',
    () async {
      final repository = _EvidenceRepository()
        ..streamSources['run-1'] = [_source()];
      final controller = TalkController(repository);
      addTearDown(controller.dispose);
      await controller.send('Find a room');
      expect(
        controller.displayMessageText(controller.messages.last),
        contains('[hotel.example](https://hotel.example/rooms)'),
      );
      expect(controller.messages.last.text, _answer);
      await controller.send('Find another room');
      expect(
        controller.displayMessageText(controller.messages.last),
        contains('[Source unavailable]'),
      );
    },
  );

  test('a missing, different-run or different-thread inspection cannot provide links', () async {
    for (final inspection in <TalkRunInspection?>[
      null,
      _inspection('different-run'),
      _inspection('run-1', threadId: _threadB),
    ]) {
      final repository = _EvidenceRepository();
      if (inspection != null) repository.inspections['run-1'] = inspection;
      final controller = TalkController(repository);
      await controller.send('Find a room');
      expect(
        controller.displayMessageText(controller.messages.last),
        'Two nights are available. [Source unavailable]',
      );
      expect(controller.messages.last.text, _answer);
      controller.dispose();
    }
  });

  test(
    'reopened ordinary answers restore sources even beyond eight recent runs',
    () async {
      final runIds = List.generate(12, (index) => 'saved-$index');
      final repository = _EvidenceRepository()
        ..details[_threadA] = _history(_threadA, runIds);
      for (final id in runIds) {
        repository.inspections[id] = _inspection(id);
      }
      final controller = TalkController(repository);
      addTearDown(controller.dispose);
      expect(await controller.openThread(_threadA), isTrue);
      await _settleProjection();
      expect(repository.inspectedIds, runIds.reversed);
      for (final message in controller.messages) {
        expect(
          controller.displayMessageText(message),
          contains('https://hotel.example/rooms'),
        );
        expect(message.text, _answer);
      }
    },
  );

  test('a same-thread follow-up preserves slow saved citations without restoring an old work panel', () async {
    final held = Completer<TalkRunInspection>();
    final repository = _EvidenceRepository()
      ..details[_threadA] = _history(_threadA, ['saved-a'])
      ..heldInspections['saved-a'] = held
      ..inspections['run-1'] = _inspection('run-1', sources: []);
    final controller = TalkController(repository);
    addTearDown(controller.dispose);
    await controller.openThread(_threadA);
    final oldMessage = controller.messages.last;
    expect(
      controller.displayMessageText(oldMessage),
      contains('[Source unavailable]'),
    );
    await controller.send('Find cheaper offers');
    held.complete(_inspection('saved-a', quickResearch: true));
    await _settleProjection();
    expect(controller.threadId, _threadA);
    expect(controller.runId, 'run-1');
    expect(
      controller.displayMessageText(oldMessage),
      contains('[Source 1](https://hotel.example/rooms)'),
    );
    expect(controller.copyMessageText(oldMessage), contains('## Sources'));
    expect(oldMessage.text, _answer);
    expect(
      controller.displayMessageText(controller.messages.last),
      contains('[Source unavailable]'),
    );
    expect(controller.quickResearch, isNull);
    expect(controller.researchProgress, isNull);
  });

  test('history rejects mismatched sources and stale reads after a conversation switch', () async {
    final held = Completer<TalkRunInspection>();
    final repository = _EvidenceRepository()
      ..details[_threadA] = _history(_threadA, ['saved-a'])
      ..details[_threadB] = _history(_threadB, ['saved-b'])
      ..heldInspections['saved-a'] = held
      ..inspections['saved-b'] = _inspection('saved-b', threadId: _threadA);
    final controller = TalkController(repository);
    addTearDown(controller.dispose);
    await controller.openThread(_threadA);
    final oldMessage = controller.messages.last;
    await controller.openThread(_threadB);
    held.complete(_inspection('saved-a'));
    await _settleProjection();
    expect(controller.threadId, _threadB);
    expect(
      controller.displayMessageText(controller.messages.last),
      contains('[Source unavailable]'),
    );
    expect(
      controller.displayMessageText(oldMessage),
      contains('[Source unavailable]'),
    );
    controller.newConversation();
    expect(controller.messages, isEmpty);
    expect(
      controller.displayMessageText(oldMessage),
      contains('[Source unavailable]'),
    );
  });

  test(
    'Quick research retains its own numbered report and copy source list',
    () async {
      final repository = _EvidenceRepository()
        ..details[_threadA] = _history(_threadA, ['quick'])
        ..inspections['quick'] = _inspection('quick', quickResearch: true);
      final controller = TalkController(repository);
      addTearDown(controller.dispose);
      await controller.openThread(_threadA);
      await _settleProjection();
      expect(
        controller.displayMessageText(controller.messages.last),
        contains('[Source 1](https://hotel.example/rooms)'),
      );
      expect(
        controller.copyMessageText(controller.messages.last),
        contains('## Sources'),
      );
      expect(controller.quickResearch?.report?.partial, isTrue);
    },
  );

  testWidgets(
    'reopened Markdown renders separate paragraphs, a table and a readable source link',
    (tester) async {
      const body =
          '# Rooms\n\nFirst paragraph.\n\nSecond paragraph. [$_citation]\n\n'
          '| Room | Total |\n| --- | --- |\n| Deluxe | 100 |\n\n'
          '```dart\n  final total = 100;\n```';
      final repository = _EvidenceRepository()
        ..details[_threadA] = _history(_threadA, ['saved'], content: body)
        ..inspections['saved'] = _inspection('saved');
      final controller = TalkController(repository);
      addTearDown(controller.dispose);
      await controller.openThread(_threadA);
      await tester.pump();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: TalkRichMessage(
                text: controller.displayMessageText(controller.messages.last),
              ),
            ),
          ),
        ),
      );
      expect(find.text('Rooms'), findsOneWidget);
      expect(find.text('First paragraph.'), findsOneWidget);
      expect(find.text('hotel.example'), findsOneWidget);
      expect(find.byType(Table), findsOneWidget);
      expect(find.text('  final total = 100;'), findsOneWidget);
      expect(find.textContaining(_citation), findsNothing);
    },
  );
}
