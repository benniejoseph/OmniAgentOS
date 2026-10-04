import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/quality/quality_contracts.dart';
import 'package:asael/features/quality/quality_controller.dart';
import 'package:asael/features/quality/quality_workspace_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'quality_test_support.dart';
import 'quality_test_fixtures.dart';

Future<void> _reveal(WidgetTester tester, Finder target) async {
  final scroll = find.byType(Scrollable).first;
  tester.state<ScrollableState>(scroll).position.jumpTo(0);
  await tester.pump();
  await tester.scrollUntilVisible(
    target,
    220,
    scrollable: scroll,
    maxScrolls: 50,
  );
  await tester.pumpAndSettle();
}

void main() {
  for (final outcome in ['open', 'invalidated', 'disposed']) {
    testWidgets(
      'compact late-row selection scrolls and focuses detail only while $outcome',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final repo = QualityTestRepository();
        final controller = QualityController(repo);
        final fixture = qualityEvaluationsJson();
        fixture['runs'] = List.generate(
          20,
          (i) => {
            ...qualityRunJson(),
            'id': 'run-$i',
            'suite': 'Synthetic suite ${i + 1}',
          },
        );
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.light(),
            home: QualityWorkspaceView(
              controller: controller,
              onOpenBrowser: () {},
            ),
          ),
        );
        await tester.pump();
        repo.evaluationsRequests.single.result.complete(
          QualityEvaluationsSnapshot.parse(fixture, tenantId: 'tenant-a'),
        );
        repo.releaseRequests.single.result.complete(qualityReport());
        await tester.pumpAndSettle();
        final last = find.byKey(const ValueKey('quality-run-run-19'));
        await _reveal(tester, last);
        expect(
          tester
              .state<ScrollableState>(find.byType(Scrollable).first)
              .position
              .pixels,
          greaterThan(1500),
        );
        await tester.tap(last);
        if (outcome == 'invalidated') controller.invalidate(notify: false);
        if (outcome == 'disposed') {
          await tester.pumpWidget(const SizedBox.shrink());
        }
        await tester.pumpAndSettle();
        if (outcome == 'open') {
          expect(find.text('Evidence detail').hitTestable(), findsOneWidget);
          expect(
            FocusManager.instance.primaryFocus?.debugLabel,
            'Quality evidence detail',
          );
          expect(controller.selectedId, 'run-19');
          expect(
            tester.getTopLeft(find.text('Evidence detail')).dy,
            lessThan(180),
          );
        } else {
          expect(find.text('Evidence detail'), findsNothing);
          expect(
            FocusManager.instance.primaryFocus?.debugLabel,
            isNot('Quality evidence detail'),
          );
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        controller.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.android),
    );
  }

  for (final desktop in [false, true]) {
    testWidgets(
      '${desktop ? 'desktop' : 'compact 200%'} presentation keeps outcomes, restrictions and detail readable',
      (tester) async {
        tester.view.physicalSize = desktop
            ? const Size(1280, 1000)
            : const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final repo = QualityTestRepository();
        final controller = QualityController(repo);
        var browserOpens = 0;
        await tester.pumpWidget(
          MaterialApp(
            theme: desktop ? MacosAppTheme.light() : AppTheme.light(),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(desktop ? 1 : 2)),
              child: child!,
            ),
            home: QualityWorkspaceView(
              controller: controller,
              onOpenBrowser: () => browserOpens++,
            ),
          ),
        );
        await tester.pump();
        repo.evaluationsRequests.single.result.complete(qualitySnapshot());
        repo.releaseRequests.single.result.complete(qualityReport());
        await tester.pumpAndSettle();
        await _reveal(
          tester,
          find.byKey(const ValueKey('quality-run-eval-run-1')),
        );
        expect(find.text('Completed'), findsOneWidget);
        expect(find.text('1 passed · 1 failed · 1 warnings'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('quality-run-eval-run-1')));
        await tester.pumpAndSettle();
        expect(find.text('Evidence detail'), findsOneWidget);
        expect(find.text('Case outcomes'), findsOneWidget);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(controller.selectedId, isNull);
        await _reveal(tester, find.byKey(const ValueKey('quality-tab-jobs')));
        await tester.tap(find.byKey(const ValueKey('quality-tab-jobs')));
        await tester.pumpAndSettle();
        await _reveal(
          tester,
          find.byKey(const ValueKey('quality-job-evaluation-job-1')),
        );
        expect(find.text('Quarantined'), findsOneWidget);
        await tester.tap(
          find.byKey(const ValueKey('quality-job-evaluation-job-1')),
        );
        await tester.pumpAndSettle();
        expect(find.text('Last error'), findsOneWidget);
        await _reveal(tester, find.byKey(const ValueKey('quality-tab-cases')));
        await tester.tap(find.byKey(const ValueKey('quality-tab-cases')));
        await tester.pumpAndSettle();
        await _reveal(
          tester,
          find.byKey(const ValueKey('quality-case-system.health')),
        );
        await tester.tap(
          find.byKey(const ValueKey('quality-case-system.health')),
        );
        await tester.pumpAndSettle();
        expect(find.text('Mutation approval required'), findsOneWidget);
        expect(find.text('privateInput'), findsNothing);
        await _reveal(
          tester,
          find.byKey(const ValueKey('quality-tab-release')),
        );
        await tester.tap(find.byKey(const ValueKey('quality-tab-release')));
        await tester.pumpAndSettle();
        await _reveal(
          tester,
          find.byKey(const ValueKey('quality-gate-report_signing')),
        );
        await tester.tap(
          find.byKey(const ValueKey('quality-gate-report_signing')),
        );
        await tester.pumpAndSettle();
        expect(find.text('Server approval'), findsOneWidget);
        expect(find.text('Approved'), findsOneWidget);
        expect(find.text('privateDetails'), findsNothing);
        await _reveal(tester, find.text('Open Quality in browser'));
        await tester.tap(find.text('Open Quality in browser'));
        expect(browserOpens, 1);
        expect(tester.takeException(), isNull);
        controller.invalidate();
        await tester.pumpAndSettle();
        expect(find.text('Server approval'), findsNothing);
        expect(find.text('Core operations'), findsNothing);
        expect(find.text('Open Quality in browser'), findsNothing);
        await tester.pumpWidget(const SizedBox.shrink());
        controller.dispose();
      },
      variant: TargetPlatformVariant.only(
        desktop ? TargetPlatform.macOS : TargetPlatform.android,
      ),
    );
  }

  testWidgets(
    'operator evaluation content survives an independently restricted release source',
    (tester) async {
      final repo = QualityTestRepository()..releaseAllowed = false;
      final c = QualityController(repo);
      await tester.pumpWidget(
        MaterialApp(
          home: QualityWorkspaceView(controller: c, onOpenBrowser: () {}),
        ),
      );
      await tester.pump();
      repo.evaluationsRequests.single.result.complete(qualitySnapshot());
      await tester.pumpAndSettle();
      await _reveal(
        tester,
        find.byKey(const ValueKey('quality-run-eval-run-1')),
      );
      expect(find.text('Core operations'), findsOneWidget);
      await _reveal(tester, find.byKey(const ValueKey('quality-tab-release')));
      await tester.tap(find.byKey(const ValueKey('quality-tab-release')));
      await tester.pumpAndSettle();
      expect(
        find.text('Release evidence requires an administrator account.'),
        findsOneWidget,
      );
      expect(repo.releaseRequests, isEmpty);
      await tester.pumpWidget(const SizedBox.shrink());
      c.dispose();
    },
  );
}
