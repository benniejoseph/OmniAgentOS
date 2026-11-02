import 'package:asael/features/builder/builder_controller.dart';
import 'package:asael/features/builder/builder_providers.dart';
import 'package:asael/features/talk/assistant_coding_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../builder/builder_test_support.dart';

void main() {
  for (final desktop in [false, true]) {
    testWidgets(
      '${desktop ? 'Mac' : 'mobile'} close flushes a file draft before disposing its workspace',
      (tester) async {
        final repository = TestBuilderRepository();
        final recovery = TestRecoveryStore();
        final controller = BuilderController(
          repository,
          recovery,
          builderProject,
        );
        await open(tester, controller, desktop: desktop);
        await controller.openFile('app/page.tsx');
        controller.editDraft('Keep this unfinished source edit.');
        await tester.pump();
        expect(controller.localRecoveryPending, isTrue);

        await tester.tap(find.byTooltip('Close coding workspace'));
        await tester.pumpAndSettle();

        expect(find.byType(AssistantCodingWorkspace), findsNothing);
        expect(
          recovery.writes.last['draft'],
          'Keep this unfinished source edit.',
        );
        expect(repository.submissions, isEmpty);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        repository.access.dispose();
      },
    );
  }

  testWidgets('failed draft storage keeps the inspector open for recovery', (
    tester,
  ) async {
    final repository = TestBuilderRepository();
    final recovery = TestRecoveryStore();
    final controller = BuilderController(repository, recovery, builderProject);
    await open(tester, controller, desktop: true);
    await controller.openFile('app/page.tsx');
    recovery.failWrite = true;
    controller.editDraft('An edit that must not be discarded.');
    await tester.pump();
    await tester.tap(find.byTooltip('Close coding workspace'));
    await tester.pumpAndSettle();

    expect(find.byType(AssistantCodingWorkspace), findsOneWidget);
    expect(controller.localRecoveryPending, isTrue);
    expect(controller.draft, 'An edit that must not be discarded.');
    expect(
      find.textContaining('Keep the workspace open and try again.'),
      findsOneWidget,
    );
    expect(repository.submissions, isEmpty);

    recovery.failWrite = false;
    await tester.tap(find.byTooltip('Close coding workspace'));
    await tester.pumpAndSettle();
    expect(find.byType(AssistantCodingWorkspace), findsNothing);
    expect(
      recovery.writes.last['draft'],
      'An edit that must not be discarded.',
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    repository.access.dispose();
  });
}

Future<void> open(
  WidgetTester tester,
  BuilderController controller, {
  required bool desktop,
}) async {
  tester.view.physicalSize = Size(desktop ? 1440 : 360, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        builderControllerProvider(builderProject)
            .overrideWith((ref) => controller),
      ],
      child: MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showDialog<void>(
                context: context,
                barrierDismissible: false,
                builder: (_) => AssistantCodingWorkspace(
                  projectId: builderProject,
                  desktop: desktop,
                ),
              ),
              child: const Text('Open files'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open files'));
  await tester.pumpAndSettle();
}
