import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/activity/activity.dart';
import 'package:asael/features/activity/activity_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'activity_fixture.dart';

void main() {
  testWidgets(
    'keyboard paging focuses new results and preserves a later user focus choice',
    (tester) async {
      final repository = ControlledActivityRepository();
      final controller = ActivityController(repository)
        ..snapshot = snapshot(cursor: 'next-one', workingCount: 60);
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light(),
          home: ActivityView(controller: controller, onOpen: (_) {}),
        ),
      );
      final next = find.widgetWithText(OutlinedButton, 'Next');
      await tester.ensureVisible(next);
      Focus.of(tester.element(find.text('Next'))).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.space);
      await tester.pump();
      expect(repository.reads, hasLength(1));
      repository.reads.last.result.complete(
        snapshot(cursor: 'next-two', workingCount: 60),
      );
      await tester.pump();
      expect(
        FocusManager.instance.primaryFocus?.debugLabel,
        'Activity results',
      );
      await tester.ensureVisible(next);
      Focus.of(tester.element(find.text('Next'))).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.space);
      await tester.pump();
      expect(repository.reads, hasLength(2));
      final filter = find.byKey(const ValueKey('activity-filter-updates'));
      await tester.ensureVisible(filter);
      final chosenFocus = Focus.of(
        tester.element(
          find.descendant(of: filter, matching: find.text('Updates')),
        ),
      );
      chosenFocus.requestFocus();
      await tester.pump();
      repository.reads.last.result.complete(snapshot(workingCount: 60));
      await tester.pump();
      expect(FocusManager.instance.primaryFocus, same(chosenFocus));
      expect(tester.takeException(), isNull);
    },
  );

  for (final width in [320.0, 390.0, 1440.0]) {
    for (final dark in [false, true]) {
      testWidgets(
        'full identities reflow at $width ${dark ? 'dark' : 'light'} with 200% text',
        (tester) async {
          tester.view.physicalSize = Size(width, 1000);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final repository = ControlledActivityRepository();
          final controller = ActivityController(repository);
          addTearDown(controller.dispose);
          final id =
              'synthetic/identity%2F:${List.filled(5, 'full-exact-value-').join()}Ω';
          controller.snapshot = snapshot(items: [runFixture(id: id)]);
          final opened = <String>[];
          await tester.pumpWidget(
            MaterialApp(
              theme: dark ? AppTheme.dark() : AppTheme.light(),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context).copyWith(
                  textScaler: const TextScaler.linear(2),
                  disableAnimations: true,
                  highContrast: true,
                ),
                child: child!,
              ),
              home: ActivityView(controller: controller, onOpen: opened.add),
            ),
          );
          expect(
            find.textContaining('up to 100 recent records per source'),
            findsOneWidget,
          );
          final fullId = find.byWidgetPredicate(
            (widget) => widget is SelectableText && widget.data == id,
          );
          await tester.ensureVisible(fullId);
          await tester.pump();
          expect(fullId, findsOneWidget);
          final open = find.widgetWithText(OutlinedButton, 'Inspect run');
          await tester.ensureVisible(open);
          await tester.pump();
          expect(tester.getSize(open).height, greaterThanOrEqualTo(44));
          await tester.tap(open);
          expect(opened, [ActivityItem.runLocation(id)]);
          expect(repository.reads, isEmpty);
          expect(tester.takeException(), isNull);
        },
      );
    }
  }

  testWidgets('read failure preserves rows with last-loaded truth and retry', (
    tester,
  ) async {
    final repository = ControlledActivityRepository();
    final controller = ActivityController(repository)..snapshot = snapshot();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: ActivityView(controller: controller, onOpen: (_) {}),
      ),
    );
    await tester.tap(find.widgetWithText(OutlinedButton, 'Refresh activity'));
    await tester.pump();
    expect(
      find.textContaining('Last loaded records remain below.'),
      findsOneWidget,
    );
    repository.reads.single.result.completeError(
      const ApiException('Synthetic source read failed'),
    );
    await tester.pump();
    expect(find.text('Synthetic source read failed'), findsOneWidget);
    expect(find.textContaining('Last loaded rows and counts'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('activity-record-run:run-one')),
      findsOneWidget,
    );
    await tester.ensureVisible(
      find.widgetWithText(OutlinedButton, 'Retry activity'),
    );
    await tester.tap(find.widgetWithText(OutlinedButton, 'Retry activity'));
    repository.reads.last.result.complete(snapshot(items: []));
    await tester.pump();
    expect(find.text('No activity in this window'), findsOneWidget);
    expect(find.text('Synthetic source read failed'), findsNothing);
    expect(find.text('Activity is unavailable'), findsNothing);
  });

  testWidgets('initial unavailable never becomes an empty-state success', (
    tester,
  ) async {
    final controller = ActivityController(ControlledActivityRepository())
      ..snapshot = snapshot(items: [], state: 'unavailable');
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark(),
        home: ActivityView(controller: controller, onOpen: (_) {}),
      ),
    );
    expect(find.text('Activity is unavailable'), findsOneWidget);
    expect(find.text('Count unavailable'), findsNWidgets(6));
    expect(find.text('No activity in this window'), findsNothing);
    await tester.ensureVisible(find.text('Source coverage · unavailable'));
    await tester.tap(find.text('Source coverage · unavailable'));
    await tester.pumpAndSettle();
    expect(find.text('Source could not be checked'), findsNWidgets(3));
    expect(find.text('Count unavailable.'), findsNWidgets(3));
  });
}
