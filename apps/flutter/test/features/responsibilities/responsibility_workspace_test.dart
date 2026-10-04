import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/responsibilities/responsibility_contracts.dart';
import 'package:asael/features/responsibilities/responsibility_controller.dart';
import 'package:asael/features/responsibilities/responsibility_recovery_store.dart';
import 'package:asael/features/responsibilities/responsibility_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'responsibility_test_support.dart';

void main() {
  testWidgets(
    'mobile draft supports 200 percent text and keyboard without overflow',
    (tester) async {
      tester.view.physicalSize = const Size(420, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = TestResponsibilityRepository(),
          controller = ResponsibilityController(
            repository,
            MemoryResponsibilityRecoveryStore(),
          );
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: ResponsibilityWorkspaceView(controller: controller),
        ),
      );
      await tester.pumpAndSettle();
      final purpose = find.byKey(
        const ValueKey('responsibility-field-purpose'),
      );
      await tester.ensureVisible(purpose);
      await tester.enterText(purpose, 'A finite meeting responsibility');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      expect(controller.draft['purpose'], 'A finite meeting responsibility');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 300));
    },
  );
  testWidgets('read-only owner sees exact detail and no mutation controls', (
    tester,
  ) async {
    const viewer = ResponsibilityOwner(
      userId: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tenant-a',
      requestActorId: 'owner@example.test',
      role: 'viewer',
      apiBaseUrl: 'https://example.test',
    );
    final repository = TestResponsibilityRepository(owner: viewer),
        controller = ResponsibilityController(
          repository,
          MemoryResponsibilityRecoveryStore(),
        );
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: ResponsibilityWorkspaceView(
          controller: controller,
          focusId: testId,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('responsibility-save')), findsNothing);
    expect(find.byKey(const Key('responsibility-new')), findsNothing);
    expect(repository.writes, isEmpty);
    expect(tester.takeException(), isNull);
  });
  testWidgets(
    'uncertain write offers explicit original request recovery and never auto-runs it',
    (tester) async {
      final repository = TestResponsibilityRepository(),
          controller = ResponsibilityController(
            repository,
            MemoryResponsibilityRecoveryStore(),
          );
      addTearDown(controller.dispose);
      await controller.initialize();
      controller.edit(fullDraft);
      repository.onMutation = (_, _, _, _) async =>
          throw const ApiException('Lost response');
      await controller.saveDraft();
      await tester.pumpWidget(
        MaterialApp(home: ResponsibilityWorkspaceView(controller: controller)),
      );
      await tester.pumpAndSettle();
      expect(repository.writes, hasLength(1));
      expect(find.byKey(const Key('responsibility-recover')), findsOneWidget);
      final originalKey = controller.pending!.key;
      repository.onMutation = null;
      await tester.ensureVisible(
        find.byKey(const Key('responsibility-recover')),
      );
      await tester.pumpAndSettle();
      final recoveryButton = find
          .byKey(const Key('responsibility-recover'))
          .hitTestable();
      expect(recoveryButton, findsOneWidget);
      await tester.tap(recoveryButton);
      await tester.pumpAndSettle();
      expect(repository.writes.last.$3, originalKey);
      expect(controller.accepted, hasLength(1));
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'New draft callback resets exact route explicitly and accepted creation opens its canonical link',
    (tester) async {
      tester.view.physicalSize = const Size(1400, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = TestResponsibilityRepository(),
          controller = ResponsibilityController(
            repository,
            MemoryResponsibilityRecoveryStore(),
          );
      addTearDown(controller.dispose);
      var newDraftCalls = 0;
      final opened = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: ResponsibilityWorkspaceView(
            controller: controller,
            focusId: testId,
            onNewDraft: () {
              newDraftCalls++;
            },
            onOpenResponsibility: opened.add,
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('responsibility-new')));
      await tester.pumpAndSettle();
      expect(newDraftCalls, 1);
      expect(controller.selectedId, isNull);
      controller.edit(fullDraft);
      await tester.pump();
      await tester.ensureVisible(find.byKey(const Key('responsibility-save')));
      await tester.pumpAndSettle();
      final saveButton = find
          .byKey(const Key('responsibility-save'))
          .hitTestable();
      expect(saveButton, findsOneWidget);
      await tester.tap(saveButton);
      await tester.pumpAndSettle();
      expect(opened.single, controller.selectedId);
      expect(opened.single, startsWith('responsibility:'));
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets('mounted controller replacement removes previous owner draft', (
    tester,
  ) async {
    final first = ResponsibilityController(
          TestResponsibilityRepository(),
          MemoryResponsibilityRecoveryStore(),
        ),
        next = ResponsibilityController(
          TestResponsibilityRepository(),
          MemoryResponsibilityRecoveryStore(),
        );
    addTearDown(first.dispose);
    addTearDown(next.dispose);
    await first.initialize();
    first.edit({
      ...emptyResponsibilityDraft(),
      'purpose': 'Private predecessor draft',
    });
    await tester.pumpWidget(
      MaterialApp(home: ResponsibilityWorkspaceView(controller: first)),
    );
    await tester.pumpAndSettle();
    first.invalidateAuthority(notify: false);
    await tester.pumpWidget(
      MaterialApp(home: ResponsibilityWorkspaceView(controller: next)),
    );
    await tester.pumpAndSettle();
    expect(find.text('Private predecessor draft'), findsNothing);
    expect(first.available, isFalse);
    expect(tester.takeException(), isNull);
  });
}
