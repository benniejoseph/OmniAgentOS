import 'package:asael/features/agents/agent_skill_controller.dart';
import 'package:asael/features/agents/agent_skill_view.dart';
import 'package:asael/features/agents/specialist_recovery_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'agent_skill_fixtures.dart';

void main() {
  for (final width in [320.0, 1440.0]) {
    testWidgets('exact Skill review and one confirmed write at $width', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final api = CatalogApi(),
          client = catalogClient(api, MemorySpecialistRecoveryStore()),
          controller = AgentSkillController(client);
      await controller.initialize();
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(width == 320 ? 2 : 1)),
            child: child!,
          ),
          home: Scaffold(
            body: Builder(
              builder: (context) => Column(
                children: [
                  AgentSkillRecoveryPanel(controller: controller),
                  TextButton(
                    onPressed: () => showAgentSkillDecision(
                      context,
                      controller,
                      'skill.update',
                      'skill:one',
                    ),
                    child: const Text('Edit reviewed Skill'),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Edit reviewed Skill'));
      await tester.pumpAndSettle();
      expect(find.text('Edit Skill'), findsOneWidget);
      final description = find.widgetWithText(TextField, 'Description');
      await tester.ensureVisible(description);
      await tester.pumpAndSettle();
      expect(description.hitTestable(), findsOneWidget);
      await tester.enterText(description, 'A revised description');
      final review = find.text('Review change');
      await tester.ensureVisible(review);
      await tester.pumpAndSettle();
      expect(review.hitTestable(), findsOneWidget);
      await tester.tap(review);
      await tester.pumpAndSettle();
      expect(api.writes, 0);
      final exact = find.text('Description: A revised description');
      await tester.ensureVisible(exact);
      await tester.pumpAndSettle();
      expect(exact.hitTestable(), findsOneWidget);
      final confirm = find.text('Confirm save');
      await tester.ensureVisible(confirm);
      await tester.pumpAndSettle();
      expect(confirm.hitTestable(), findsOneWidget);
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(api.writes, 1);
      expect(controller.pending, isNull);
      expect(controller.accepted, isNotNull);
      expect(find.text('Accepted skill.update').hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
      client.close();
    });
  }
}
