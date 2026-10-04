import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/monitoring/monitoring_controller.dart';
import 'package:asael/features/monitoring/monitoring_repository.dart';
import 'package:asael/features/monitoring/monitoring_workspace_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'monitoring_test_support.dart';

Future<void> _reveal(WidgetTester tester, Finder target) async {
  final scroll = find.byType(Scrollable).first;
  tester.state<ScrollableState>(scroll).position.jumpTo(0);
  await tester.pump();
  await tester.scrollUntilVisible(
    target,
    240,
    scrollable: scroll,
    maxScrolls: 100,
  );
  await tester.pumpAndSettle();
}

void main() {
  for (final desktop in [false, true]) {
    testWidgets(
      '${desktop ? 'desktop' : 'compact 200%'} Monitoring presents typed outcomes and read-only browser handoff',
      (tester) async {
        tester.view.physicalSize = desktop
            ? const Size(1280, 1100)
            : const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final repo = MonitoringTestRepository();
        final c = MonitoringController(repo);
        var browserOpens = 0;
        await tester.pumpWidget(
          MaterialApp(
            theme: desktop ? MacosAppTheme.light() : AppTheme.light(),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(desktop ? 1 : 2)),
              child: child!,
            ),
            home: MonitoringWorkspaceView(
              controller: c,
              onOpenBrowser: () => browserOpens++,
            ),
          ),
        );
        await tester.pump();
        repo.completeAll();
        await tester.pumpAndSettle();
        expect(find.text('Healthy'), findsOneWidget);
        expect(
          find.text(
            'Configuration indicators do not establish provider reachability.',
          ),
          findsOneWidget,
        );
        await _reveal(
          tester,
          find.byKey(const ValueKey('monitoring-slo-lcp-p75')),
        );
        await tester.tap(find.byKey(const ValueKey('monitoring-slo-lcp-p75')));
        await tester.pumpAndSettle();
        expect(find.text('Samples'), findsOneWidget);
        expect(find.text('3 of 20 required'), findsOneWidget);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(c.selectedId, isNull);
        await _reveal(
          tester,
          find.byKey(const ValueKey('monitoring-tab-incidents')),
        );
        await tester.tap(
          find.byKey(const ValueKey('monitoring-tab-incidents')),
        );
        await tester.pumpAndSettle();
        await _reveal(
          tester,
          find.byKey(const ValueKey('monitoring-incident-incident-1')),
        );
        await tester.tap(
          find.byKey(const ValueKey('monitoring-incident-incident-1')),
        );
        await tester.pumpAndSettle();
        expect(find.text('Occurrences'), findsOneWidget);
        await _reveal(
          tester,
          find.byKey(const ValueKey('monitoring-tab-alerts')),
        );
        await tester.tap(find.byKey(const ValueKey('monitoring-tab-alerts')));
        await tester.pumpAndSettle();
        await _reveal(
          tester,
          find.byKey(const ValueKey('monitoring-alert-delivery-1')),
        );
        await tester.tap(
          find.byKey(const ValueKey('monitoring-alert-delivery-1')),
        );
        await tester.pumpAndSettle();
        expect(
          find.text(
            'Skipped delivery does not establish that the alert reached its target.',
          ),
          findsOneWidget,
        );
        await _reveal(
          tester,
          find.byKey(const ValueKey('monitoring-tab-timeline')),
        );
        await tester.tap(find.byKey(const ValueKey('monitoring-tab-timeline')));
        await tester.pumpAndSettle();
        await _reveal(
          tester,
          find.byKey(const ValueKey('monitoring-event-event-1')),
        );
        await tester.tap(
          find.byKey(const ValueKey('monitoring-event-event-1')),
        );
        await tester.pumpAndSettle();
        expect(find.text('HTTP status'), findsOneWidget);
        for (final text in [
          'PRIVATE_METADATA',
          'PRIVATE_PAYLOAD',
          'PRIVATE_RESPONSE',
          'PRIVATE_LEASE',
          'PRIVATE_RAW_ERROR',
        ]) {
          expect(find.textContaining(text), findsNothing);
        }
        await _reveal(tester, find.text('Open monitoring in browser'));
        await tester.tap(find.text('Open monitoring in browser'));
        expect(browserOpens, 1);
        expect(repo.healthRequests, hasLength(1));
        expect(tester.takeException(), isNull);
        c.invalidate();
        await tester.pumpAndSettle();
        expect(find.text('Service health'), findsNothing);
        expect(find.text('Open monitoring in browser'), findsNothing);
        await tester.pumpWidget(const SizedBox.shrink());
        c.dispose();
      },
      variant: TargetPlatformVariant.only(
        desktop ? TargetPlatform.macOS : TargetPlatform.android,
      ),
    );
  }

  for (final end in ['focus', 'invalidate', 'dispose']) {
    testWidgets(
      'compact late-row selection $end keeps navigation bound to live evidence',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final api = MonitoringTestApi();
        api.reader = (path) async {
          if (path != '/api/observability/slo') return monitoringResponse(path);
          final json = monitoringSloJson();
          final policies = <Map<String, dynamic>>[],
              evaluations = <Map<String, dynamic>>[];
          for (var i = 0; i < 20; i++) {
            final policy = monitoringPolicyJson()
              ..['id'] = 'policy-$i'
              ..['name'] = 'Measurement $i';
            policies.add(policy);
            evaluations.add(monitoringEvaluationJson()..['policy'] = policy);
          }
          json['policies'] = policies;
          json['evaluations'] = evaluations;
          return json;
        };
        final repo = ApiMonitoringRepository(monitoringAccess(api));
        final controller = MonitoringController(repo);
        await tester.pumpWidget(
          MaterialApp(
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: const TextScaler.linear(2)),
              child: child!,
            ),
            home: MonitoringWorkspaceView(
              controller: controller,
              onOpenBrowser: () {},
            ),
          ),
        );
        await tester.pumpAndSettle();
        final lateRow = find.byKey(const ValueKey('monitoring-slo-policy-19'));
        await _reveal(tester, lateRow);
        await tester.tap(lateRow);
        if (end == 'invalidate') controller.invalidate();
        if (end == 'dispose') await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
        if (end == 'focus') {
          expect(find.text('Evidence detail').hitTestable(), findsOneWidget);
          expect(
            FocusManager.instance.primaryFocus?.debugLabel,
            'Monitoring evidence detail',
          );
          expect(controller.selectedId, 'policy-19');
        } else {
          expect(find.text('Evidence detail'), findsNothing);
          expect(
            FocusManager.instance.primaryFocus?.debugLabel,
            isNot('Monitoring evidence detail'),
          );
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        controller.dispose();
        repo.dispose();
      },
    );
  }
}
