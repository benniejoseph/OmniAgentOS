import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_controller.dart';
import 'package:asael/features/customers/accounts_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_test_support.dart';

void main() {
  testWidgets(
    '320px and 200 percent text retain exact identity, unknown health and explicit open',
    (tester) async {
      tester.view.physicalSize = const Size(320, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = TestAccountsRepository();
      final value = AccountsController(repository, active: true);
      addTearDown(value.dispose);
      await value.refresh();
      CustomerAccountSummary? opened;
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: AccountsWorkspace(
            controller: value,
            onOpen: (account) => opened = account,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Customer portfolio'), findsOneWidget);
      expect(tester.takeException(), isNull);
      final open = find.widgetWithText(
        FilledButton,
        'Open exact customer account',
      );
      final scrollable = find
          .descendant(
            of: find.byKey(accountsStorageKey(value, 'scroll')),
            matching: find.byType(Scrollable),
          )
          .first;
      await tester.scrollUntilVisible(open, 300, scrollable: scrollable);
      // The card can be taller than the viewport at 200% text. Lay out the
      // lazy child's new scroll extent before aligning and tapping its button.
      await tester.pumpAndSettle();
      await tester.ensureVisible(open);
      await tester.pumpAndSettle();
      expect(open.hitTestable(), findsOneWidget);
      await tester.tap(open.hitTestable());
      await tester.pumpAndSettle();
      expect(opened?.id, customerId);
      expect(opened?.owner, 'Other workspace member');
      expect(tester.takeException(), isNull);
      value.setActive(false);
      await tester.pump();
      expect(find.text('Acme customer'), findsNothing);
      expect(
        find.textContaining('Customer records are hidden'),
        findsOneWidget,
      );
    },
  );
  testWidgets(
    'independent failed intelligence does not claim a healthy score',
    (tester) async {
      final repository = TestAccountsRepository();
      repository.portfolioRead = (_) => Future.error(StateError('offline'));
      final controller = AccountsController(repository, active: true);
      addTearDown(controller.dispose);
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(home: AccountsWorkspace(controller: controller)),
      );
      expect(find.text('Portfolio intelligence · unavailable'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.textContaining('Missing intelligence is not a healthy status'),
        250,
        scrollable: find
            .descendant(
              of: find.byKey(accountsStorageKey(controller, 'scroll')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(
        find.textContaining('Missing intelligence is not a healthy status'),
        findsOneWidget,
      );
      expect(find.textContaining('Score 0'), findsNothing);
    },
  );

  testWidgets(
    'scroll offsets and private receipt expansion use independent scoped storage',
    (tester) async {
      final repository = TestAccountsRepository();
      final controller = AccountsController(repository, active: true);
      addTearDown(controller.dispose);
      addTearDown(repository.access.dispose);
      await controller.refreshCore();
      await tester.pumpWidget(
        MaterialApp(home: AccountsWorkspace(controller: controller)),
      );
      final scrollKey = accountsStorageKey(controller, 'scroll');
      final scrollContext = tester.element(find.byKey(scrollKey));
      final bucket = PageStorage.of(scrollContext);
      bucket.writeState(scrollContext, 240.0);
      await controller.refreshIntelligence();
      await tester.pump();
      final scrollable = find
          .descendant(
            of: find.byKey(scrollKey),
            matching: find.byType(Scrollable),
          )
          .first;
      await tester.scrollUntilVisible(
        find.text('Suggested next action · not authoritative'),
        250,
        scrollable: scrollable,
      );
      expect(tester.takeException(), isNull);
      final tiles = tester
          .widgetList<ExpansionTile>(find.byType(ExpansionTile))
          .toList();
      expect(tiles, isNotEmpty);
      expect(tiles.every((tile) => tile.key is PageStorageKey), isTrue);
      expect(tiles.map((tile) => tile.key).toSet().length, tiles.length);
      expect(tiles.map((tile) => tile.key), isNot(contains(scrollKey)));
      final tileContext = tester.element(find.byKey(tiles.first.key!));
      bucket.writeState(tileContext, true);
      expect(bucket.readState(tileContext), isTrue);
      expect(bucket.readState(scrollContext), isA<double>());
      final previousKey = accountsStorageKey(controller, 'receipt:exact');
      controller.repository.access.update(
        accountOwner(role: 'admin'),
        available: true,
      );
      expect(
        accountsStorageKey(controller, 'receipt:exact'),
        isNot(previousKey),
      );
      expect(controller.overview.value, isNull);
      await tester.pump();
      expect(tester.takeException(), isNull);
    },
  );
}
