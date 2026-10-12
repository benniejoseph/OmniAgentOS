import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Finder operationalVerticalScroll() => find
    .byWidgetPredicate(
      (widget) =>
          widget is Scrollable && widget.axisDirection == AxisDirection.down,
    )
    .first;

Future<void> revealOperationalWidget(WidgetTester tester, Finder target) async {
  final scroll = operationalVerticalScroll();
  tester.state<ScrollableState>(scroll).position.jumpTo(0);
  await tester.pump();
  await tester.scrollUntilVisible(
    target,
    220,
    scrollable: scroll,
    maxScrolls: 100,
  );
  await Scrollable.ensureVisible(tester.element(target), alignment: 0.5);
  await tester.pumpAndSettle();
}

Future<void> closeOperationalDetail(WidgetTester tester) async {
  final close = find.byTooltip('Close evidence detail');
  await revealOperationalWidget(tester, close);
  expect(close.hitTestable(), findsOneWidget);
  await tester.tap(close.hitTestable());
  await tester.pumpAndSettle();
}

Future<void> selectOperationalSection(
  WidgetTester tester, {
  required bool desktop,
  required String key,
  required String mobileLabel,
}) async {
  if (!desktop &&
      find.byTooltip('Close evidence detail').evaluate().isNotEmpty) {
    await closeOperationalDetail(tester);
  }
  final tab = desktop
      ? find.byKey(ValueKey(key))
      : find.widgetWithText(TextButton, mobileLabel);
  await revealOperationalWidget(tester, tab);
  expect(tab.hitTestable(), findsOneWidget);
  await tester.tap(tab.hitTestable());
  await tester.pumpAndSettle();
}
