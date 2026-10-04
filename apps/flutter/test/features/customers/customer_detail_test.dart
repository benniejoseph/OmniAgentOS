import 'package:asael/features/customers/accounts_controller.dart';
import 'package:asael/features/customers/accounts_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_test_support.dart';

void main() {
  testWidgets(
    'exact conflicting fact remains inspectable with source identity and revision',
    (tester) async {
      final repository = TestAccountsRepository();
      final value = AccountsController(
        repository,
        active: true,
        accountId: customerId,
      );
      addTearDown(value.dispose);
      await value.refresh();
      await tester.pumpWidget(
        MaterialApp(home: AccountsWorkspace(controller: value)),
      );
      await tester.pumpAndSettle();
      final scrollable = find
          .descendant(
            of: find.byKey(accountsStorageKey(value, 'scroll')),
            matching: find.byType(Scrollable),
          )
          .first;
      final fact = value.detail.value!.facts.first;
      final factCard = find.ancestor(
        of: find.byWidgetPredicate(
          (widget) => widget is SelectableText && widget.data == fact.id,
        ),
        matching: find.byType(Card),
      );
      // This finder can remain empty until the exact lazy fact row is built;
      // `.first` would throw during scrollUntilVisible's initial empty check.
      final inspect = find.descendant(
        of: factCard,
        matching: find.widgetWithText(TextButton, 'Inspect exact fact'),
      );
      await tester.scrollUntilVisible(inspect, 350, scrollable: scrollable);
      await tester.pumpAndSettle();
      await tester.ensureVisible(inspect);
      await tester.pumpAndSettle();
      expect(inspect.hitTestable(), findsOneWidget);
      await tester.tap(inspect.hitTestable());
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Exact fact evidence'),
        -300,
        scrollable: scrollable,
      );
      await tester.pumpAndSettle();
      expect(find.text('Exact fact evidence'), findsOneWidget);
      expect(fact.conflictingIds, isNotEmpty);
      expect(find.text(fact.revisionId), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('Source · sourceRevisionSha256'),
        350,
        scrollable: scrollable,
      );
      await tester.pumpAndSettle();
      expect(find.text('b' * 64), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'failed exact read never selects a portfolio account as fallback',
    (tester) async {
      final repository = TestAccountsRepository();
      repository.detailRead = (_) => Future.error(StateError('unavailable'));
      final controller = AccountsController(
        repository,
        active: true,
        accountId: otherCustomerId,
      );
      addTearDown(controller.dispose);
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(home: AccountsWorkspace(controller: controller)),
      );
      expect(find.text(otherCustomerId), findsOneWidget);
      expect(find.text('Acme customer'), findsNothing);
      expect(find.text('Account evidence · unavailable'), findsOneWidget);
    },
  );
}
