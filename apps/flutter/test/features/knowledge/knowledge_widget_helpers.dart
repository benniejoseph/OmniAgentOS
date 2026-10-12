import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> openMemoryTool(WidgetTester tester, String label) async {
  await tester.tap(find.byTooltip('Memory tools'));
  await tester.pumpAndSettle();
  final entry = find.text(label);
  await Scrollable.ensureVisible(tester.element(entry), alignment: 0.5);
  await tester.pumpAndSettle();
  expect(entry.hitTestable(), findsOneWidget);
  await tester.tap(entry.hitTestable());
  await tester.pumpAndSettle();
}

Future<void> openMemoryDisclosure(
  WidgetTester tester,
  String label, {
  required Finder scrollable,
}) async {
  final entry = find.text(label);
  await tester.scrollUntilVisible(entry, 250, scrollable: scrollable);
  await Scrollable.ensureVisible(tester.element(entry), alignment: 0.5);
  await tester.pumpAndSettle();
  expect(entry.hitTestable(), findsOneWidget);
  await tester.tap(entry.hitTestable());
  await tester.pumpAndSettle();
}
