import 'package:asael/features/customers/accounts_controller.dart';
import 'package:asael/features/customers/accounts_fact_panel.dart';
import 'package:asael/features/customers/accounts_recovery_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_fact_fixtures.dart';
import 'accounts_health_fixtures.dart';
import 'accounts_test_support.dart';

void main() {
  testWidgets(
    'phone manual fact review has real hit targets and saves protected intent before its single POST',
    (tester) async {
      final previous = WidgetController.hitTestWarningShouldBeFatal;
      WidgetController.hitTestWarningShouldBeFatal = true;
      addTearDown(
        () => WidgetController.hitTestWarningShouldBeFatal = previous,
      );
      tester.view.physicalSize = const Size(320, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repo = FactRepository(await healthAccount()),
          store = MemoryAccountsRecoveryStore();
      final controller = AccountsController(
        repo,
        accountId: customerId,
        active: true,
        recovery: store,
      );
      addTearDown(controller.dispose);
      await controller.refreshCore();
      repo.beforeFact = (intent) async {
        final saved = (await store.read(healthOwner, accountWorkspace))!;
        expect(saved['fact']['pending']['requestSha256'], intent.requestSha256);
      };
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: Scaffold(
            body: SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: ListenableBuilder(
                listenable: controller,
                builder: (context, _) =>
                    AccountFactPanel(controller: controller),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Manual account facts'));
      await tester.pumpAndSettle();
      Future<void> reach(Finder target) async {
        expect(target, findsOneWidget);
        await tester.ensureVisible(target);
        await tester.pumpAndSettle();
        expect(target.hitTestable(), findsOneWidget);
      }

      for (final (label, value) in [
        ('Field name', 'manual.organization'),
        ('Organization reference', 'organization:acme'),
        ('Name', 'Acme assertion'),
      ]) {
        final field = find.widgetWithText(TextField, label);
        await reach(field);
        await tester.enterText(field, value);
        await tester.pumpAndSettle(const Duration(milliseconds: 600));
      }
      final review = find.widgetWithText(FilledButton, 'Review fact');
      await reach(review);
      await tester.tap(review);
      await tester.pumpAndSettle();
      expect(repo.writes, isEmpty);
      final exact = find.text('Name: Acme assertion');
      await reach(exact);
      final confirm = find.widgetWithText(FilledButton, 'Confirm fact');
      await reach(confirm);
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(repo.writes, hasLength(1));
      expect(controller.actions!.factState.pending, isNull);
      expect(
        controller.actions!.factState.accepted!.acceptance!['permissionBasis'],
        'operator_assertion',
      );
      final accepted = find.text('Accepted manual fact create');
      await reach(accepted);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
