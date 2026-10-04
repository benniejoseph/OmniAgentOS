import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/customers/accounts_controller.dart';
import 'package:asael/features/customers/accounts_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_test_support.dart';

void main() {
  testWidgets(
    'Mac keyboard search and exact selection keep a bounded readable portfolio',
    (tester) async {
      tester.view.physicalSize = const Size(1024, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = TestAccountsRepository();
      final value = AccountsController(repository, active: true);
      addTearDown(value.dispose);
      await value.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: MacosAppTheme.light(),
          home: AccountsWorkspace(controller: value),
        ),
      );
      await tester.pump();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyF);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pump();
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.focusNode!.hasFocus, isTrue);
      await tester.enterText(find.byType(TextField), 'No match');
      await tester.pump();
      expect(
        find.text('No matching customer accounts in this returned snapshot.'),
        findsOneWidget,
      );
      await tester.enterText(find.byType(TextField), 'Acme');
      await tester.pump();
      await tester.scrollUntilVisible(
        find.text('Acme customer'),
        250,
        scrollable: find
            .descendant(
              of: find.byKey(accountsStorageKey(value, 'scroll')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(find.text('Acme customer'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
