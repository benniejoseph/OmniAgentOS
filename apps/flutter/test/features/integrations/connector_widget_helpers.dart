import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Opens the phone management disclosure before testing its protected journals.
Future<void> openConnectorRecoveryControls(WidgetTester tester) async {
  await tapVisibleConnectorAction(tester, 'Manage & recover connections');
}

/// Lazy lists can build an action before its center enters the viewport.
Future<void> tapVisibleConnectorAction(
  WidgetTester tester,
  String label, {
  Finder? scrollable,
}) async {
  final action = find.text(label);
  await tester.scrollUntilVisible(
    action,
    180,
    scrollable: scrollable ?? find.byType(Scrollable).first,
  );
  await Scrollable.ensureVisible(tester.element(action), alignment: 0.5);
  await tester.pumpAndSettle();
  expect(action.hitTestable(), findsOneWidget);
  await tester.tap(action.hitTestable());
  await tester.pumpAndSettle();
}
