import 'dart:async';

import 'package:asael/features/customers/accounts_advanced_contracts.dart';
import 'package:asael/features/customers/accounts_controller.dart';
import 'package:asael/features/customers/accounts_health_contracts.dart';
import 'package:asael/features/customers/accounts_recovery_store.dart';
import 'package:asael/features/customers/accounts_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_health_fixtures.dart';
import 'accounts_test_support.dart';

void main() {
  for (final width in [320.0, 1440.0]) {
    testWidgets('health review and receipt are reachable at width $width', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repo = HealthRepository(await healthAccount())
            ..heldEvaluation = Completer<AccountHealthRead>(),
          store = MemoryAccountsRecoveryStore();
      final controller = AccountsController(
        repo,
        accountId: customerId,
        active: true,
        recovery: store,
      );
      addTearDown(controller.dispose);
      await controller.refreshCore();
      // The advanced source has already been read; missing current score is
      // distinct from a failed read and permits the first reviewed evaluation.
      controller.advancedReads[AccountAdvancedKind.health]!.state =
          AccountReadState.current;
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(width == 320 ? 2 : 1)),
            child: child!,
          ),
          home: AccountsWorkspace(controller: controller),
        ),
      );
      await tester.pumpAndSettle();
      final scroll = find
          .descendant(
            of: find.byKey(accountsStorageKey(controller, 'scroll')),
            matching: find.byType(Scrollable),
          )
          .first;
      Future<void> reachFromListGutter(Finder target, double movement) async {
        for (var step = 0; step < 80 && target.evaluate().isEmpty; step++) {
          final position = tester.state<ScrollableState>(scroll).position;
          final before = position.pixels;
          final bounds = tester.getRect(scroll);
          // The list has 16px horizontal padding. Its empty gutter avoids the
          // nested EditableText scrollables used by selectable evidence.
          await tester.dragFrom(
            Offset(bounds.left + 8, bounds.center.dy),
            Offset(0, movement),
          );
          await tester.pumpAndSettle();
          expect(
            target.evaluate().isNotEmpty || position.pixels != before,
            isTrue,
            reason: 'The outer Account list must move toward the requested content.',
          );
        }
        expect(target, findsOneWidget);
        await tester.ensureVisible(target);
        await tester.pumpAndSettle();
        expect(target.hitTestable(), findsOneWidget);
      }

      final review = find.widgetWithText(
        OutlinedButton,
        'Review health evaluation',
      );
      await tester.scrollUntilVisible(review, 300, scrollable: scroll);
      await tester.pumpAndSettle();
      await tester.ensureVisible(review);
      await tester.pumpAndSettle();
      expect(review.hitTestable(), findsOneWidget);
      await tester.tap(review.hitTestable());
      await tester.pumpAndSettle();
      final confirm = find.widgetWithText(
        FilledButton,
        'Confirm health evaluation',
      );
      await tester.scrollUntilVisible(confirm, 250, scrollable: scroll);
      await tester.pumpAndSettle();
      await tester.ensureVisible(confirm);
      await tester.pumpAndSettle();
      expect(confirm.hitTestable(), findsOneWidget);
      await tester.tap(confirm.hitTestable());
      await tester.pumpAndSettle();
      expect(repo.evaluations, hasLength(1));
      expect(controller.actions!.acceptedHealth, isNull);
      expect(controller.actions!.pendingHealth, isNotNull);
      final intent = repo.evaluations.single;
      repo.heldEvaluation!.complete(
        await AccountHealthRead.parse(
          await healthResponse(intent),
          intent,
          mutation: true,
        ),
      );
      await tester.pumpAndSettle();
      expect(controller.actions!.acceptedHealth?.acceptance, isNotNull);
      expect(controller.actions!.pendingHealth, isNull);
      // The pending recovery card above the editor shrinks on acceptance.
      // Start from a known list anchor instead of assuming the old lazy-list
      // offset is still below the newly built receipt.
      final top = find.text(
        'Customer relationship records. Connection and login accounts are separate. Recommendations do not authorize actions.',
      );
      await reachFromListGutter(top, 300);
      final receipt = find.text('Accepted health evaluation · unknown');
      await reachFromListGutter(receipt, -250);
      expect(controller.actions!.pendingHealth, isNull);
      expect(repo.evaluations, hasLength(1));
      expect(tester.takeException(), isNull);
    });
  }
}
