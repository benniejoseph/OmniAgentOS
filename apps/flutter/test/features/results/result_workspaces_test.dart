import 'dart:async';

import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/results/result_contracts.dart';
import 'package:asael/features/results/results.dart';
import 'package:asael/features/results/results_repository_contracts.dart';
import 'package:asael/features/results/results_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

ResultItem _item(String id, {String status = 'running', String? body}) =>
    ResultItem.agent({
      'id': id,
      'agentId': 'actual-executor:$id',
      'prompt': 'Exact prompt $id',
      'status': status,
      'response': body ?? 'Full output for $id',
      'grounding': {
        'status': 'missing',
        'citations': [
          {'url': 'https://synthetic.invalid/evidence/$id'},
        ],
      },
    });

class _Repository
    implements
        ResultsRepository,
        ScopedResultsRepository,
        ConfirmedResultsCancellationRepository {
  @override
  final access = ResultsAccess(
    deployment: 'https://synthetic.invalid',
    tenantId: 'tenant',
    actorId: 'actor',
    role: 'operator',
  );
  Future<ResultItem?> Function(String) read = (key) async =>
      _item(key.substring(6));
  Future<ResultsSnapshot> Function() window = () async => ResultsSnapshot(
    items: [_item('one')],
    evaluations: const [],
    sourceErrors: const [],
  );
  Future<ResultCancelReceipt> Function(String) effect = (id) async =>
      ResultCancelReceipt(
        runId: id,
        returnedRun: _item(id, status: 'canceled'),
        canceledJobs: 1,
      );
  int effects = 0;
  @override
  Future<ResultItem?> detail(String key) => read(key);
  @override
  Future<ResultsSnapshot> list() => window();
  @override
  Future<void> cancel(String id) async {
    await cancelConfirmed(id);
  }

  @override
  Future<ResultCancelReceipt> cancelConfirmed(String id) {
    effects++;
    return effect(id);
  }
}

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  double width = 390,
  bool dark = false,
  double scale = 1,
}) async {
  tester.view.physicalSize = Size(width, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: dark
          ? AppTheme.dark(platform: TargetPlatform.android)
          : AppTheme.light(platform: TargetPlatform.android),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          textScaler: TextScaler.linear(scale),
          disableAnimations: true,
        ),
        child: child!,
      ),
      home: child,
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  for (final dark in [false, true]) {
    testWidgets(
      '320px 200% Results reflows full identities and controls in ${dark ? 'dark' : 'light'}',
      (tester) async {
        final repository = _Repository();
        final current = ResultsController(repository);
        await current.refresh();
        await _pump(
          tester,
          ResultsView(controller: current, onOpen: (_) {}),
          width: 320,
          dark: dark,
          scale: 2,
        );
        expect(tester.takeException(), isNull);
        final scroll = find
            .descendant(
              of: find.byKey(const Key('results-scroll')),
              matching: find.byType(Scrollable),
            )
            .first;
        await tester.scrollUntilVisible(
          find.byKey(const Key('macos-result-agent:one')),
          260,
          scrollable: scroll,
        );
        expect(find.text('agent:one'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        current.dispose();
        repository.access.dispose();
      },
    );
  }
  testWidgets(
    'initial failure is unavailable and never a successful empty collection',
    (tester) async {
      final repository = _Repository();
      repository.window = () async =>
          throw const ApiException('Synthetic read failed', statusCode: 503);
      final controller = ResultsController(repository);
      await controller.refresh();
      await _pump(tester, ResultsView(controller: controller, onOpen: (_) {}));
      expect(
        find.text('Work record count unavailable'),
        findsNothing,
      ); // Read failure has the stronger visible notice.
      expect(find.textContaining('could not be refreshed'), findsOneWidget);
      expect(
        find.text('No work records were returned in this bounded window.'),
        findsNothing,
      );
      expect(find.textContaining('Count unavailable'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      repository.access.dispose();
    },
  );
  testWidgets(
    'a successful empty window is explicit without implying all historical work is absent',
    (tester) async {
      final repository = _Repository();
      repository.window = () async =>
          const ResultsSnapshot(items: [], evaluations: [], sourceErrors: []);
      final controller = ResultsController(repository);
      await controller.refresh();
      await _pump(
        tester,
        ResultsView(controller: controller, onOpen: (_) {}),
        width: 1440,
      );
      expect(
        find.text('No work records were returned in this bounded window.'),
        findsOneWidget,
      );
      expect(find.text('0 returned work records'), findsOneWidget);
      expect(
        find.textContaining('Unavailable or partial sources'),
        findsNothing,
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      repository.access.dispose();
    },
  );
  testWidgets(
    'search draft survives failed refresh, but actor replacement removes private content',
    (tester) async {
      final repository = _Repository();
      final current = ResultsController(repository);
      await current.refresh();
      await _pump(
        tester,
        ResultsView(controller: current, onOpen: (_) {}),
        width: 1440,
      );
      await tester.enterText(find.byType(TextField), 'one');
      repository.window = () async =>
          throw const ApiException('Synthetic stale read', statusCode: 503);
      await tester.tap(find.byKey(const Key('macos-results-refresh')));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'one',
      );
      expect(find.text('Exact prompt one'), findsOneWidget);
      repository.access.update(
        tenant: 'tenant',
        actor: 'another',
        nextRole: 'operator',
        available: false,
        clear: true,
      );
      await tester.pump();
      expect(find.text('Exact prompt one'), findsNothing);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '',
      );
      await tester.pumpWidget(const SizedBox());
      current.dispose();
      repository.access.dispose();
    },
  );
  testWidgets('exact detail route replacement fences a late old response', (
    tester,
  ) async {
    final repository = _Repository(), old = Completer<ResultItem?>();
    repository.read = (key) =>
        key == 'agent:old' ? old.future : Future.value(_item('new/東京:part%2F'));
    await _pump(
      tester,
      ResultDetailView(keyValue: 'agent:old', repository: repository),
    );
    await _pump(
      tester,
      ResultDetailView(
        keyValue: 'agent:new/東京:part%2F',
        repository: repository,
      ),
    );
    old.complete(_item('old'));
    await tester.pumpAndSettle();
    expect(find.text('Full output for old'), findsNothing);
    expect(find.text('Full output for new/東京:part%2F'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    repository.access.dispose();
  });
  testWidgets(
    'authority change invalidates an open cancellation dialog without sending an effect',
    (tester) async {
      final repository = _Repository();
      await _pump(
        tester,
        ResultDetailView(keyValue: 'agent:one', repository: repository),
        width: 1440,
      );
      await tester.tap(find.byKey(const Key('macos-result-cancel')));
      await tester.pumpAndSettle();
      repository.access.update(
        tenant: 'tenant',
        actor: 'actor',
        nextRole: 'viewer',
        available: false,
        clear: true,
      );
      await tester.pumpAndSettle();
      expect(find.text('Review expired'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(
              find.byKey(const Key('macos-result-cancel-confirm')),
            )
            .onPressed,
        isNull,
      );
      expect(repository.effects, 0);
      await tester.tap(find.text('Keep run'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      repository.access.dispose();
    },
  );
  testWidgets(
    'accepted cancellation survives failed follow-up and prevents duplicate pending effects',
    (tester) async {
      final repository = _Repository(), held = Completer<ResultCancelReceipt>();
      repository.effect = (_) => held.future;
      await _pump(
        tester,
        ResultDetailView(keyValue: 'agent:one', repository: repository),
        width: 1440,
      );
      await tester.tap(find.byKey(const Key('macos-result-cancel')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('macos-result-cancel-confirm')));
      await tester.pumpAndSettle();
      expect(repository.effects, 1);
      expect(
        tester
            .widget<OutlinedButton>(
              find.byKey(const Key('macos-result-cancel')),
            )
            .onPressed,
        isNull,
      );
      repository.read = (_) async =>
          throw const ApiException('Follow-up unavailable', statusCode: 503);
      held.complete(
        ResultCancelReceipt(
          runId: 'one',
          returnedRun: _item('one', status: 'canceled'),
          canceledJobs: 1,
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.textContaining(
          'Cancellation confirmed. Completed tool actions are not undone.',
        ),
        findsOneWidget,
      );
      expect(find.text('Follow-up unavailable'), findsOneWidget);
      expect(repository.effects, 1);
      await tester.pumpWidget(const SizedBox());
      repository.access.dispose();
    },
  );
  testWidgets(
    '200% exact detail keeps full evidence and minimum touch controls',
    (tester) async {
      final repository = _Repository();
      repository.read = (_) async => _item(
        'exact/東京:part%2F',
        body: List.filled(
          30,
          'Full submitted output and source attribution.',
        ).join(' '),
      );
      await _pump(
        tester,
        ResultDetailView(
          keyValue: 'agent:exact/東京:part%2F',
          repository: repository,
        ),
        width: 320,
        scale: 2,
        dark: true,
      );
      expect(
        tester.getSize(find.byKey(const Key('macos-result-cancel'))).height,
        greaterThanOrEqualTo(48),
      );
      expect(tester.takeException(), isNull);
      final scroll = find
          .descendant(
            of: find.byKey(const Key('result-detail-scroll')),
            matching: find.byType(Scrollable),
          )
          .first;
      await tester.scrollUntilVisible(
        find.text('https://synthetic.invalid/evidence/exact/東京:part%2F'),
        400,
        scrollable: scroll,
        maxScrolls: 50,
      );
      expect(
        find.text('https://synthetic.invalid/evidence/exact/東京:part%2F'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      repository.access.dispose();
    },
  );
}
