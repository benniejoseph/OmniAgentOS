import 'package:asael/app/router/app_router.dart';
import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/results/results.dart';
import 'package:asael/features/results/results_providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('explicit Results approval entry keeps its validated kind', () {
    final route =
        '/results/${Uri.encodeComponent('approval:outside/window%2Fencoded:Ω')}?kind=slo_policy';
    expect(isSafeInitialAppLocation(route), true);
    expect(initialAppLocation(['--asael-route=$route']), route);
    expect(isSafeInitialAppLocation('$route&kind=tool'), false);
  });

  for (final detail in [false, true]) {
    testWidgets(
      'mounted Results ${detail ? 'detail' : 'list'} follows repository replacement',
      (tester) async {
        final first = _Repository('First owner output'),
            next = _Repository('Replacement owner output');
        var current = first;
        final container = ProviderContainer(
          overrides: [
            resultsRepositoryProvider.overrideWith((ref) => current),
            reconnectCoordinatorProvider.overrideWithValue(
              ReconnectCoordinator(() async => const [], const Stream.empty()),
            ),
          ],
        );
        addTearDown(container.dispose);
        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: MaterialApp(
              theme: AppTheme.light(),
              home: detail
                  ? const ProviderBoundResultRoute(
                      keyValue: 'agent:run/full%2Fid',
                    )
                  : const ProviderBoundResultsRoute(),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('First owner output'), findsOneWidget);
        current = next;
        container.invalidate(resultsRepositoryProvider);
        await tester.pumpAndSettle();
        expect(find.text('First owner output'), findsNothing);
        expect(find.text('Replacement owner output'), findsOneWidget);
        expect(next.reads, greaterThan(0));
        expect(first.effects + next.effects, 0);
        expect(tester.takeException(), isNull);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.android),
    );
  }
}

class _Repository implements ResultsRepository {
  _Repository(this.title);
  final String title;
  int reads = 0, effects = 0;
  ResultItem get item => ResultItem(
    key: 'agent:run/full%2Fid',
    kind: ResultKind.agent,
    title: title,
    status: 'completed',
    body: 'Unverified stored output.',
    meta: 'Exact fixture',
    tone: ResultTone.neutral,
  );
  @override
  Future<ResultsSnapshot> list() async {
    reads++;
    return ResultsSnapshot(
      items: [item],
      evaluations: const [],
      sourceErrors: const [],
    );
  }

  @override
  Future<ResultItem?> detail(String key) async {
    reads++;
    return key == item.key ? item : null;
  }

  @override
  Future<void> cancel(String runId) async {
    effects++;
    throw StateError('Unexpected effect');
  }
}
