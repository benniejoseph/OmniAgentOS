import 'package:asael/features/agents/agent_adaptation_comparison.dart';
import 'package:asael/features/agents/agent_adaptation_comparison_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'agent_comparison_test_support.dart';

AgentAdaptationComparison parse(Map<String, dynamic> value) =>
    AgentAdaptationComparison.fromJson(
      value,
      adaptationId: comparisonAdaptationId,
      observedDefinitionVersion: 2,
      effectSha256: comparisonShaB,
    );

void main() {
  test(
    'literal suites are bounded, distinct, and cannot contradict themselves',
    () {
      expect(
        parseAdaptationComparisonSuite(comparisonSuite())['cases'],
        hasLength(3),
      );
      for (final edit in <void Function(Map<String, dynamic>)>[
        (s) => (s['cases'] as List).removeLast(),
        (s) => s['cases'] = List.filled(11, s['cases'][0]),
        (s) => s['cases'][1]['task'] =
            '   SUMMARIZE THE NEXT STEP FOR PROJECT 1.  ',
        (s) => s['cases'][1]['id'] = 'case-1',
        (s) => s['cases'][0]['assertions']['noneOf'] = ['STEP'],
        (s) => s['cases'][0]['assertions']['minLength'] = 8001,
        (s) => s['cases'][0]['assertions']['allOf'] = List.filled(6, 'phrase'),
        (s) => s['extra'] = true,
      ]) {
        final suite = comparisonSuite();
        edit(suite);
        expect(
          () => parseAdaptationComparisonSuite(suite),
          throwsFormatException,
        );
      }
    },
  );

  for (final verdict in ['improved', 'no_change', 'regressed', 'incomplete']) {
    test('rechecks $verdict from paired output evidence', () {
      final result = parse(comparisonReceipt(verdict: verdict));
      expect(result.verdict, verdict);
      expect(result.results, hasLength(3));
      expect(
        result.costUsd,
        verdict == 'incomplete' ? null : closeTo(.06, .0001),
      );
    });
  }

  test(
    'unknown provider cost stays unknown and scoring uses Unicode code points',
    () {
      expect(parse(comparisonReceipt(unknownCost: true)).costUsd, isNull);
      final task = {
        'assertions': {
          'allOf': <String>[],
          'noneOf': <String>[],
          'minLength': 1,
          'maxLength': 1,
        },
      };
      expect(
        const AgentComparisonObservation(
          'completed',
          '🌱',
          null,
          null,
        ).passes(task),
        isTrue,
      );
    },
  );

  test('receipt rejects mismatched scores, identities, bounds and totals', () {
    for (final edit in <void Function(Map<String, dynamic>)>[
      (r) => r['adaptationId'] = 'agent-adaptation:$comparisonShaC',
      (r) => r['pins']['definitionVersion'] = 3,
      (r) => r['pins']['candidateEffectSha256'] = comparisonShaC,
      (r) => r['pins']['maxCalls'] = 20,
      (r) => r['pins']['mode'] = 'plan',
      (r) => r['results'][0]['caseId'] = 'case-2',
      (r) => r['results'][0]['candidate']['output'] = 'No evidence.',
      (r) => r['baselinePassed'] = 1,
      (r) => r['costUsd'] = 0,
      (r) => r['verdict'] = 'no_change',
    ]) {
      final receipt = comparisonReceipt();
      edit(receipt);
      expect(() => parse(receipt), throwsFormatException);
    }
  });

  test(
    'activation requires current improved evidence no more than 24 hours old',
    () {
      final now = DateTime.utc(2026, 10, 12, 12);
      expect(
        comparisonProjection(completedAt: now).canActivateAt(2, now),
        isTrue,
      );
      for (final verdict in ['no_change', 'regressed', 'incomplete']) {
        expect(
          comparisonProjection(
            verdict: verdict,
            completedAt: now,
          ).canActivateAt(2, now),
          isFalse,
        );
      }
      expect(
        comparisonProjection(missing: true).canActivateAt(2, now),
        isFalse,
      );
      expect(
        comparisonProjection(completedAt: now).canActivateAt(3, now),
        isFalse,
      );
      expect(
        comparisonProjection(
          completedAt: now.subtract(const Duration(hours: 24, seconds: 1)),
        ).canActivateAt(2, now),
        isFalse,
      );
      expect(
        comparisonProjection(completedAt: now.add(const Duration(seconds: 1)))
            .canActivateAt(2, now),
        isFalse,
      );
    },
  );

  testWidgets(
    'owner form submits literal tasks only after validation and recovers the same suite',
    (tester) async {
      tester.view.physicalSize = const Size(420, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final submitted = <ComparisonJson>[];
      bool failed = false;
      late StateSetter update;
      await tester.pumpWidget(
        MaterialApp(
          home: StatefulBuilder(
            builder: (context, setState) {
              update = setState;
              return MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: const TextScaler.linear(2)),
                child: Scaffold(
                  body: SingleChildScrollView(
                    child: AgentAdaptationComparisonForm(
                      busy: false,
                      failed: failed,
                      onCompare: submitted.add,
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      );
      await tester.tap(find.text('Compare on my tasks'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('agent-run-comparison')));
      await tester.tap(find.byKey(const Key('agent-run-comparison')));
      await tester.pumpAndSettle();
      expect(submitted, isEmpty);
      for (var i = 0; i < 3; i++) {
        await tester.enterText(
          find.byKey(ValueKey('comparison-task-$i')),
          'Summarize project $i with an exact next step.',
        );
        await tester.enterText(
          find.byKey(ValueKey('comparison-required-$i')),
          'next step\nevidence',
        );
      }
      await tester.ensureVisible(find.byKey(const Key('agent-run-comparison')));
      await tester.tap(find.byKey(const Key('agent-run-comparison')));
      await tester.pumpAndSettle();
      expect(submitted, hasLength(1));
      expect(submitted.single['cases'], hasLength(3));
      expect(submitted.single['cases'][0]['assertions']['allOf'], [
        'next step',
        'evidence',
      ]);
      update(() => failed = true);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('comparison-task-0')),
        'This edited task must never change the saved recovery request.',
      );
      await tester.ensureVisible(find.text('Check same comparison'));
      await tester.tap(find.text('Check same comparison'));
      await tester.pumpAndSettle();
      expect(submitted, hasLength(2));
      expect(submitted.last, same(submitted.first));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'evidence shows paired text and unknown cost without claiming real-world success',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: AgentAdaptationComparisonEvidence(
                comparison: parse(comparisonReceipt(unknownCost: true)),
              ),
            ),
          ),
        ),
      );
      expect(find.text('Improved on these tasks'), findsOneWidget);
      expect(find.textContaining('Cost: unknown'), findsOneWidget);
      await tester.tap(find.text('Task 1: Pass'));
      await tester.pumpAndSettle();
      expect(find.text('Next step: inspect the evidence.'), findsOneWidget);
      expect(find.text('A generic summary.'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
