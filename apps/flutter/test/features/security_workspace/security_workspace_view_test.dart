import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/security/security_controller.dart';
import 'package:asael/features/security/security_repository.dart';
import 'package:asael/features/security/security_workspace_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'security_test_support.dart';

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

Future<void> _tap(WidgetTester tester, Finder target) async {
  await _reveal(tester, target);
  await tester.tap(target);
  await tester.pumpAndSettle();
}

void main() {
  for (final desktop in [false, true]) {
    testWidgets(
      '${desktop ? 'desktop' : 'compact200%'} Security presents typed evidence and fixed browser handoff',
      (tester) async {
        tester.view.physicalSize = desktop
            ? const Size(1280, 1100)
            : const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final repo = SecurityTestRepository();
        final controller = SecurityController(repo);
        var browserOpens = 0;
        await tester.pumpWidget(
          MaterialApp(
            theme: desktop ? MacosAppTheme.light() : AppTheme.light(),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(desktop ? 1 : 2)),
              child: child!,
            ),
            home: SecurityWorkspaceView(
              controller: controller,
              onOpenBrowser: () => browserOpens++,
            ),
          ),
        );
        await tester.pump();
        repo.completeAll();
        await tester.pumpAndSettle();
        await _tap(
          tester,
          find.byKey(const ValueKey('security-rule-read.security')),
        );
        expect(find.text('Allowed roles'), findsOneWidget);
        expect(
          find.text(
            'This rule is explanatory policy evidence, not an executable grant.',
          ),
          findsOneWidget,
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(controller.selectedId, isNull);
        await _tap(tester, find.byKey(const ValueKey('security-tab-audits')));
        await _tap(
          tester,
          find.byKey(const ValueKey('security-audit-audit-1')),
        );
        expect(find.text('Recorded reason'), findsOneWidget);
        expect(
          find.text('The requested scope is unavailable.'),
          findsOneWidget,
        );
        await _tap(
          tester,
          find.byKey(const ValueKey('security-tab-isolation')),
        );
        await _tap(
          tester,
          find.byKey(const Key('security-isolation-evaluation')),
        );
        expect(find.text('Execution status'), findsOneWidget);
        expect(find.text('Case result'), findsOneWidget);
        expect(find.text('Completed'), findsWidgets);
        expect(find.text('Fail'), findsOneWidget);
        await _tap(
          tester,
          find.byKey(const ValueKey('security-table-omni_items')),
        );
        expect(find.text('Row security forced'), findsOneWidget);
        await _tap(
          tester,
          find.byKey(const ValueKey('security-tab-retention')),
        );
        await _tap(
          tester,
          find.byKey(const ValueKey('security-retention-securityAuditDays')),
        );
        expect(find.text('Configured duration'), findsOneWidget);
        expect(
          find.text(
            'The reported window does not establish that records were deleted or a sweep completed.',
          ),
          findsOneWidget,
        );
        for (final text in [
          'PRIVATE_METADATA',
          'PRIVATE_SESSION',
          'PRIVATE_DEVICE',
          'PRIVATE_VAULT',
          'PRIVATE_CONTEXT_STATS',
          'PRIVATE_LATEST',
        ]) {
          expect(find.textContaining(text), findsNothing);
        }
        await _tap(tester, find.text('Open security in browser'));
        expect(browserOpens, 1);
        expect(repo.contextRequests, hasLength(1));
        controller.invalidate();
        await tester.pumpAndSettle();
        expect(find.text('Security evidence'), findsNothing);
        expect(find.text('Open security in browser'), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        controller.dispose();
      },
      variant: TargetPlatformVariant.only(
        desktop ? TargetPlatform.macOS : TargetPlatform.android,
      ),
    );
  }
  for (final end in ['focus', 'invalidate', 'dispose']) {
    testWidgets(
      'compact late audit selection $end stays bound to live controller and evidence',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final api = SecurityTestApi();
        api.reader = (path) async {
          final json = securityResponse(path);
          if (path == '/api/security/audits') {
            json['records'] = List.generate(
              20,
              (index) => securityAuditJson(id: 'audit-$index'),
            );
          }
          return json;
        };
        final repo = ApiSecurityRepository(securityAccess(api));
        final controller = SecurityController(repo);
        await tester.pumpWidget(
          MaterialApp(
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: const TextScaler.linear(2)),
              child: child!,
            ),
            home: SecurityWorkspaceView(
              controller: controller,
              onOpenBrowser: () {},
            ),
          ),
        );
        await tester.pumpAndSettle();
        await _tap(tester, find.byKey(const ValueKey('security-tab-audits')));
        final lateRow = find.byKey(const ValueKey('security-audit-audit-19'));
        await _reveal(tester, lateRow);
        await tester.tap(lateRow);
        if (end == 'invalidate') controller.invalidate();
        if (end == 'dispose') await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
        if (end == 'focus') {
          expect(find.text('Evidence detail').hitTestable(), findsOneWidget);
          expect(
            FocusManager.instance.primaryFocus?.debugLabel,
            'Security evidence detail',
          );
          expect(controller.selectedId, 'audit-19');
        } else {
          expect(find.text('Evidence detail'), findsNothing);
          expect(
            FocusManager.instance.primaryFocus?.debugLabel,
            isNot('Security evidence detail'),
          );
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        controller.dispose();
        repo.dispose();
      },
    );
  }
  testWidgets(
    'local filters reset on controller replacement and keyboard refresh performs fresh reads',
    (tester) async {
      tester.view.physicalSize = const Size(900, 1200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final firstApi = SecurityTestApi(), secondApi = SecurityTestApi();
      final firstRepo = ApiSecurityRepository(securityAccess(firstApi)),
          secondRepo = ApiSecurityRepository(securityAccess(secondApi));
      final first = SecurityController(firstRepo),
          second = SecurityController(secondRepo);
      Widget app(SecurityController controller) => MaterialApp(
        home: SecurityWorkspaceView(
          controller: controller,
          onOpenBrowser: () {},
        ),
      );
      await tester.pumpWidget(app(first));
      await tester.pumpAndSettle();
      await _reveal(tester, find.byType(TextFormField));
      await tester.enterText(find.byType(TextFormField), 'no-such-rule');
      await tester.pumpAndSettle();
      await _reveal(tester, find.text('No role rules match this view.'));
      expect(find.text('No role rules match this view.'), findsOneWidget);
      await tester.pumpWidget(app(second));
      await tester.pumpAndSettle();
      await _reveal(
        tester,
        find.byKey(const ValueKey('security-rule-read.security')),
      );
      expect(
        find.byKey(const ValueKey('security-rule-read.security')),
        findsOneWidget,
      );
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyR);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pumpAndSettle();
      expect(secondApi.paths, hasLength(8));
      expect(firstApi.paths, hasLength(4));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      first.dispose();
      second.dispose();
      firstRepo.dispose();
      secondRepo.dispose();
    },
  );
}
