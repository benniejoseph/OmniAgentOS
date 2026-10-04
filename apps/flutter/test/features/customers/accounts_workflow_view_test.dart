import 'package:asael/features/customers/accounts_controller.dart';
import 'package:asael/features/customers/accounts_advanced_contracts.dart';
import 'package:asael/features/customers/accounts_recovery_store.dart';
import 'package:asael/features/customers/accounts_workflow_review.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_health_fixtures.dart';
import 'accounts_test_support.dart';
import 'accounts_workflow_fixtures.dart';

void main() {
  for (final width in [320.0, 1440.0]) {
    testWidgets(
      'workflow setup uses actual review and confirmation targets at $width',
      (tester) async {
        final previous = WidgetController.hitTestWarningShouldBeFatal;
        WidgetController.hitTestWarningShouldBeFatal = true;
        addTearDown(
          () => WidgetController.hitTestWarningShouldBeFatal = previous,
        );
        tester.view.physicalSize = Size(width, 1000);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final repo = WorkflowRepository(
              await healthAccount(),
              await workflowDefinition(),
            ),
            store = MemoryAccountsRecoveryStore();
        final controller = AccountsController(
          repo,
          accountId: customerId,
          active: true,
          recovery: store,
        );
        addTearDown(controller.dispose);
        await controller.refreshCore();
        await controller.refreshAdvanced(AccountAdvancedKind.workflows);
        await tester.pumpWidget(
          ProviderScope(
            child: MaterialApp(
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(
                  context,
                ).copyWith(textScaler: TextScaler.linear(width == 320 ? 2 : 1)),
                child: child!,
              ),
              home: Scaffold(
                body: SingleChildScrollView(
                  padding: const EdgeInsets.all(16),
                  child: ListenableBuilder(
                    listenable: controller,
                    builder: (context, _) => Column(
                      children: [
                        AccountWorkflowReview(controller: controller),
                        AccountWorkflowRecovery(controller: controller),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final chooser = find.byType(DropdownButtonFormField<String>);
        await tester.ensureVisible(chooser);
        await tester.pumpAndSettle();
        expect(chooser.hitTestable(), findsOneWidget);
        await tester.tap(chooser);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Customer onboarding').last);
        await tester.pumpAndSettle();
        Future<void> reach(Finder target) async {
          expect(target, findsOneWidget);
          await tester.ensureVisible(target);
          await tester.pumpAndSettle();
          expect(target.hitTestable(), findsOneWidget);
        }

        final objective = find.widgetWithText(TextField, 'Objective *'),
            criteria = find.widgetWithText(TextField, 'Success criteria *');
        await reach(objective);
        await tester.enterText(objective, 'Prepare the reviewed customer plan');
        await tester.pumpAndSettle(const Duration(milliseconds: 600));
        await reach(criteria);
        await tester.enterText(criteria, 'Confirm the first checkpoint');
        await tester.pumpAndSettle(const Duration(milliseconds: 600));
        final review = find.widgetWithText(
          OutlinedButton,
          'Review workflow setup',
        );
        await reach(review);
        await tester.tap(review);
        await tester.pumpAndSettle();
        expect(repo.writes, isEmpty);
        final confirm = find.widgetWithText(
          FilledButton,
          'Confirm workflow setup',
        );
        await reach(confirm);
        await tester.tap(confirm);
        await tester.pumpAndSettle();
        expect(repo.writes, hasLength(1));
        expect(
          controller.actions!.acceptedWorkflow!.acceptance!['effectAuthority'],
          'none',
        );
        final receipt = find.text('Accepted workflow start · in_progress');
        await reach(receipt);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );
  }
}
