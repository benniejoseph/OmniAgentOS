import 'dart:async';

import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_read_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _Repository extends Fake implements KnowledgeRepository {
  final requests = <({String id, Completer<MemoryRecord> response})>[];
  @override
  Future<MemoryRecord> getMemory(String id) {
    final response = Completer<MemoryRecord>();
    requests.add((id: id, response: response));
    return response.future;
  }
}

MemoryRecord _memory(String id, String content) => MemoryRecord.fromJson({
  'id': id,
  'title': 'Selected memory',
  'content': content,
  'access': {'visibility': 'user_legacy'},
  'explainability': {
    'validity': 'retention_expired',
    'lifecycle': {'pinned': true},
  },
  'supersedesId': 'memory:original-full-identity',
  'evidenceRefs': ['source:full-evidence-identity'],
});
KnowledgeController _controller(_Repository repo) =>
    KnowledgeController(repo, canManage: false, mutationsAvailable: false);
Widget _app(Widget child) => MaterialApp(home: Scaffold(body: child));
void main() {
  testWidgets(
    'exact inspector binds its requested identity and retains honest provenance',
    (tester) async {
      final repo = _Repository();
      final current = _controller(repo);
      await tester.pumpWidget(
        _app(
          KnowledgeMemoryInspector(
            controller: current,
            memoryId: 'memory:outside-first-page',
          ),
        ),
      );
      expect(repo.requests.single.id, 'memory:outside-first-page');
      repo.requests.single.response.complete(
        _memory('memory:outside-first-page', 'Exact body outside the index'),
      );
      await tester.pumpAndSettle();
      expect(find.text('Exact body outside the index'), findsOneWidget);
      final inspectorScroll = find
          .descendant(
            of: find.byType(KnowledgeMemoryInspector),
            matching: find.byType(Scrollable),
          )
          .first;
      await tester.scrollUntilVisible(
        find.textContaining('user_legacy'),
        350,
        scrollable: inspectorScroll,
      );
      expect(find.textContaining('user_legacy'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.textContaining('retention_expired'),
        350,
        scrollable: inspectorScroll,
      );
      expect(find.textContaining('retention_expired'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.textContaining('source:full-evidence-identity'),
        350,
        scrollable: inspectorScroll,
      );
      expect(
        find.textContaining('source:full-evidence-identity'),
        findsOneWidget,
      );
      expect(find.text('Review forgetting impact'), findsNothing);
    },
  );
  testWidgets(
    'changing the owner controller clears a loaded record and fences an old request',
    (tester) async {
      final first = _Repository(), second = _Repository();
      final a = _controller(first), b = _controller(second);
      await tester.pumpWidget(
        _app(KnowledgeMemoryInspector(controller: a, memoryId: 'same-id')),
      );
      first.requests.single.response.complete(
        _memory('same-id', 'First owner secret'),
      );
      await tester.pumpAndSettle();
      expect(find.text('First owner secret'), findsOneWidget);
      await tester.tap(find.text('Refresh exact memory'));
      await tester.pump();
      await tester.pumpWidget(
        _app(KnowledgeMemoryInspector(controller: b, memoryId: 'same-id')),
      );
      expect(find.text('First owner secret'), findsNothing);
      first.requests.last.response.complete(
        _memory('same-id', 'Late owner secret'),
      );
      second.requests.single.response.complete(
        _memory('same-id', 'Second owner body'),
      );
      await tester.pumpAndSettle();
      expect(find.text('Late owner secret'), findsNothing);
      expect(find.text('Second owner body'), findsOneWidget);
    },
  );
  testWidgets(
    'unavailable exact memory never substitutes the selected index row',
    (tester) async {
      final repo = _Repository();
      final current = _controller(repo)
        ..state = KnowledgeState(
          memories: [_memory('one', 'Stale index content')],
          knowledge: [],
          nodes: [],
          edges: [],
        );
      await tester.pumpWidget(
        _app(KnowledgeMemoryInspector(controller: current, memoryId: 'one')),
      );
      repo.requests.single.response.completeError(StateError('revoked'));
      await tester.pumpAndSettle();
      expect(find.text('Stale index content'), findsNothing);
      expect(
        find.textContaining('No index content is substituted'),
        findsOneWidget,
      );
    },
  );
  testWidgets(
    'phone deep selection is cleared by session replacement at 320px and 200 percent text',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(320, 800);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final repo = _Repository();
      final controller = _controller(repo)
        ..state = const KnowledgeState(
          memories: [],
          knowledge: [],
          nodes: [],
          edges: [],
        );
      Widget app(KnowledgeController value) => MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: KnowledgeView(
          controller: value,
          initialMemoryId: 'deep-full-identity',
        ),
      );
      await tester.pumpWidget(app(controller));
      repo.requests.single.response.complete(
        _memory('deep-full-identity', 'Private deep result'),
      );
      await tester.pumpAndSettle();
      expect(find.text('Private deep result'), findsOneWidget);
      expect(tester.takeException(), isNull);
      final disabled = KnowledgeController(
        _Repository(),
        canManage: false,
        mutationsAvailable: false,
        enabled: false,
      );
      await tester.pumpWidget(app(disabled));
      expect(find.text('Private deep result'), findsNothing);
      expect(
        find.text('Sign in to read memory and knowledge.'),
        findsOneWidget,
      );
    },
  );
  testWidgets(
    'reviews distinguish missing queue data from zero and assert no automatic truth changes',
    (tester) async {
      await tester.pumpWidget(_app(const KnowledgeReviews(overview: {})));
      expect(find.textContaining('Unavailable pending'), findsOneWidget);
      expect(
        find.textContaining(
          'does not establish that the review queue is empty',
        ),
        findsOneWidget,
      );
      expect(
        find.textContaining('does not execute maintenance'),
        findsOneWidget,
      );
      expect(find.byType(FilledButton), findsNothing);
    },
  );
}
