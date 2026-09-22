import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/features/agents/agent_control_view.dart';
import 'package:asael/features/agents/agent_council.dart';
import 'package:asael/features/agents/agents.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'agent_council_fixture.dart';

void main() {
  testWidgets('exposes Agent Control and exact cancellation on Android', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final agentController = AgentsController(
      _AgentsRepository(),
      canManage: false,
      mutationsAvailable: false,
    );
    final councilRepository = _CouncilRepository();
    final councilController = AgentCouncilController(
      councilRepository,
      controlAvailable: true,
    );
    addTearDown(agentController.dispose);
    addTearDown(councilController.dispose);
    await agentController.refresh();
    await councilController.refresh();

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: AgentsView(
          controller: agentController,
          liveWork: AgentControlView(controller: councilController),
          onRefreshLiveWork: councilController.refresh,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Live work'), findsOneWidget);
    expect(find.text('Agent Control'), findsWidgets);
    expect(find.byKey(const Key('android-agent-control-list')), findsOneWidget);
    expect(find.textContaining('openai · gpt-6-astra'), findsWidgets);
    expect(
      find.byKey(const Key('android-agent-control-cancel-task-scout-one')),
      findsOneWidget,
    );

    final cancel = find.byKey(
      const Key('android-agent-control-cancel-task-scout-one'),
    );
    await tester.ensureVisible(cancel);
    await tester.pumpAndSettle();
    await tester.tap(cancel);
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const Key('android-agent-control-confirm-cancel')),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(councilRepository.canceled, ['task-scout-one']);
  });
}

class _AgentsRepository implements AgentsRepository {
  @override
  Future<AgentLedger> load() async =>
      const AgentLedger(agents: [], skills: [], performance: []);

  @override
  Future<void> deleteAgent(String id) async {}

  @override
  Future<void> deleteSkill(String id) async {}

  @override
  Future<AgentProfile> saveAgent(Json input, {String? id}) =>
      throw UnimplementedError();

  @override
  Future<AgentSkill> saveSkill(Json input, {String? id}) =>
      throw UnimplementedError();
}

class _CouncilRepository
    implements AgentCouncilRepository, AgentCouncilControlRepository {
  final canceled = <String>[];

  @override
  Future<AgentCouncilProjection> load({int limit = 60}) async =>
      AgentCouncilProjection.fromJson(agentCouncilFixtureJson());

  @override
  Future<AgentCouncilCancellation> cancel({
    required String executionId,
    required int expectedRevision,
    required String reason,
    required String idempotencyKey,
  }) async {
    canceled.add(executionId);
    return AgentCouncilCancellation.fromJson({
      'task': {
        'executionId': executionId,
        'state': 'canceled',
        'lifecycleRevision': expectedRevision + 1,
        'canCancel': false,
        'updatedAt': '2026-09-22T08:31:00.000Z',
        'terminalAt': '2026-09-22T08:31:00.000Z',
      },
      'idempotent': false,
    });
  }
}
