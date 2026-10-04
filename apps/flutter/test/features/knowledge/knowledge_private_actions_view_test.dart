import 'package:asael/features/knowledge/knowledge_recovery_store.dart';
import 'package:asael/features/knowledge/knowledge_source_deletion_view.dart';
import 'package:asael/features/knowledge/knowledge_source_map_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'knowledge_private_action_fixtures.dart';

void main() {
  for (final deletion in [false, true]) {
    testWidgets(
      'phone ${deletion ? 'local cleanup' : 'source map'} review requires an actual confirmation at 200%',
      (tester) async {
        final old = WidgetController.hitTestWarningShouldBeFatal;
        WidgetController.hitTestWarningShouldBeFatal = true;
        addTearDown(() => WidgetController.hitTestWarningShouldBeFatal = old);
        tester.view.physicalSize = const Size(320, 1000);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final repository = PrivateActionRepository(),
            controller = privateController(
              repository,
              MemoryKnowledgeRecoveryStore(),
            );
        await controller.reloadRecovery();
        addTearDown(controller.dispose);
        await tester.pumpWidget(
          MaterialApp(
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: const TextScaler.linear(2)),
              child: child!,
            ),
            home: Scaffold(
              body: deletion
                  ? KnowledgeSourceCleanup(controller: controller)
                  : KnowledgeSourceMaps(controller: controller),
            ),
          ),
        );
        await tester.pumpAndSettle();
        Future<void> reach(Finder target, {bool up = false}) async {
          final scroll = find.byType(Scrollable).first;
          for (
            var attempt = 0;
            attempt < 32 && target.hitTestable().evaluate().isEmpty;
            attempt++
          ) {
            final bounds = tester.getRect(scroll),
                state = tester.state<ScrollableState>(scroll),
                before = state.position.pixels;
            await tester.dragFrom(
              Offset(bounds.left + 8, bounds.center.dy),
              Offset(0, up ? 220 : -220),
            );
            await tester.pumpAndSettle();
            if (state.position.pixels == before) {
              break;
            }
          }
          expect(target.hitTestable(), findsOneWidget);
        }

        if (deletion) {
          final inspect = find.widgetWithText(
            OutlinedButton,
            'Review local deletion impact',
          );
          await reach(inspect);
          await tester.tap(inspect);
          await tester.pumpAndSettle();
          await reach(find.text('1 local documents'));
          final consent = find.byType(CheckboxListTile);
          await reach(consent);
          await tester.tap(consent);
          await tester.pumpAndSettle();
          final confirm = find.widgetWithText(
            FilledButton,
            'Delete reviewed local sources',
          );
          await reach(confirm);
          expect(repository.privateSubmissions, isEmpty);
          await tester.tap(confirm);
        } else {
          final inspect = find.widgetWithText(
            OutlinedButton,
            'Inspect source-map evidence',
          );
          await reach(inspect);
          await tester.tap(inspect);
          await tester.pumpAndSettle();
          await reach(
            find.byWidgetPredicate(
              (widget) =>
                  widget is SelectableText &&
                  widget.data == 'The rollout requires explicit review.',
            ),
          );
          final review = find.widgetWithText(
            OutlinedButton,
            'Save source map as memory',
          );
          await reach(review);
          await tester.tap(review);
          await tester.pumpAndSettle();
          final confirm = find.widgetWithText(
            FilledButton,
            'Confirm source-map memory',
          );
          await reach(confirm);
          expect(repository.privateSubmissions, isEmpty);
          await tester.tap(confirm);
        }
        await tester.pumpAndSettle();
        expect(repository.privateSubmissions, hasLength(1));
        expect(controller.pendingChange, isNull);
        expect(controller.acceptedChange, isNotNull);
        await reach(
          find.text(controller.acceptedChange!.description),
          up: true,
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );
  }
}
