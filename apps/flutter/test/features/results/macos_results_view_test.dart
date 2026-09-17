import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/results/macos_results_view.dart';
import 'package:asael/features/results/results.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _ResultsRepository implements ResultsRepository {
  _ResultsRepository(this.snapshot);

  final ResultsSnapshot snapshot;

  @override
  Future<void> cancel(String runId) async {}

  @override
  Future<ResultItem?> detail(String key) async =>
      snapshot.items.where((item) => item.key == key).firstOrNull;

  @override
  Future<ResultsSnapshot> list() async => snapshot;
}

void main() {
  testWidgets('fits the minimum Mac workspace viewport', (tester) async {
    tester.view.physicalSize = const Size(786, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final result = ResultItem.agent({
      'id': 'run-one',
      'prompt': 'Research gold',
      'status': 'completed',
      'response': 'Gold research output',
    });
    final snapshot = ResultsSnapshot(
      items: [result],
      evaluations: const [],
      sourceErrors: const [],
    );
    final controller = ResultsController(_ResultsRepository(snapshot))
      ..snapshot = snapshot;

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: MacosResultsView(controller: controller, onOpen: (_) {}),
      ),
    );

    expect(tester.takeException(), isNull);
    expect(find.text('Every kind'), findsOneWidget);
  });

  testWidgets('selects a dense ledger row and keeps output evidence visible', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1500, 920);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final results = [
      ResultItem.agent({
        'id': 'run-one',
        'prompt': 'Research gold',
        'status': 'completed',
        'response': 'Gold research output',
        'completedAt': '2026-09-18T03:00:00.000Z',
        'grounding': {
          'status': 'verified',
          'citations': [
            {'url': 'https://example.test/gold'},
          ],
        },
      }),
      ResultItem.workflow({
        'id': 'workflow-two',
        'goal': 'Publish desktop build',
        'status': 'completed',
        'completedAt': '2026-09-18T04:00:00.000Z',
        'result': {
          'report': 'Desktop build published successfully.',
          'verification': {'status': 'verified'},
          'evidenceRefs': ['release:desktop-15'],
        },
      }),
    ];
    final snapshot = ResultsSnapshot(
      items: results,
      evaluations: const [],
      sourceErrors: const [],
    );
    final controller = ResultsController(_ResultsRepository(snapshot))
      ..snapshot = snapshot;
    ResultItem? opened;

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: MacosResultsView(
          controller: controller,
          onOpen: (item) => opened = item,
        ),
      ),
    );

    await tester.tap(
      find.byKey(const Key('macos-result-workflow:workflow-two')),
    );
    await tester.pump();

    expect(find.text('Desktop build published successfully.'), findsOneWidget);
    expect(find.text('release:desktop-15'), findsOneWidget);
    await tester.tap(find.byKey(const Key('macos-result-open')));
    expect(opened?.key, 'workflow:workflow-two');
  });

  testWidgets('searches the existing controller-backed ledger', (tester) async {
    tester.view.physicalSize = const Size(1500, 920);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final results = [
      ResultItem.agent({
        'id': 'run-one',
        'prompt': 'Research gold',
        'status': 'completed',
        'response': 'Gold research output',
      }),
      ResultItem.workflow({
        'id': 'workflow-two',
        'goal': 'Publish desktop build',
        'status': 'completed',
        'result': {'report': 'Desktop build published successfully.'},
      }),
    ];
    final snapshot = ResultsSnapshot(
      items: results,
      evaluations: const [],
      sourceErrors: const [],
    );
    final controller = ResultsController(_ResultsRepository(snapshot))
      ..snapshot = snapshot;

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: MacosResultsView(controller: controller, onOpen: (_) {}),
      ),
    );

    await tester.enterText(find.byType(TextField), 'gold');
    await tester.pump();

    expect(controller.filtered.single.key, 'agent:run-one');
    expect(find.byKey(const Key('macos-result-agent:run-one')), findsOneWidget);
    expect(
      find.byKey(const Key('macos-result-workflow:workflow-two')),
      findsNothing,
    );
  });
}
