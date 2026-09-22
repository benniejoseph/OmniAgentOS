import 'package:asael/features/agents/agent_council.dart';
import 'package:asael/features/agents/task_authority_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'agent_council_fixture.dart';

void main() {
  testWidgets(
    'inspector refreshes validation while preserving every immutable pin',
    (tester) async {
      tester.view.physicalSize = const Size(800, 1300);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = _AuthorityRepository();
      final controller = AgentCouncilController(repository);
      addTearDown(controller.dispose);

      await controller.loadTaskDetail('execution-one');
      expect(
        controller.taskDetail('execution-one')?.authority.validation.status,
        'current',
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: AgentTaskAuthorityView(
                controller: controller,
                taskId: 'execution-one',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(repository.detailReads, 2);
      expect(find.text('Signed grants · Changed'), findsOneWidget);
      expect(find.text('grant-skill-one'), findsOneWidget);
      expect(find.text('skill:research:v3'), findsOneWidget);
      expect(find.text(_digest('c')), findsOneWidget);
      expect(find.text('grant-plugin-one'), findsOneWidget);
      expect(find.text(_digest('d')), findsOneWidget);
      expect(find.textContaining('skill.research'), findsOneWidget);
      expect(find.textContaining('plugin.workflow'), findsOneWidget);
      expect(find.text('grant-mcp-one'), findsOneWidget);
      expect(find.textContaining('market.news.search'), findsOneWidget);
      expect(find.textContaining('market.calendar.read'), findsOneWidget);
      expect(find.textContaining('twelve-data'), findsOneWidget);
      expect(find.textContaining('fred'), findsOneWidget);
      expect(
        find.textContaining('signed grants cannot be edited or revoked'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );
}

class _AuthorityRepository
    implements AgentCouncilRepository, AgentCouncilDetailRepository {
  int detailReads = 0;

  @override
  Future<AgentCouncilProjection> load({int limit = 60}) async =>
      AgentCouncilProjection.fromJson(agentCouncilFixtureJson());

  @override
  Future<AgentTaskDetail> loadTaskDetail(String executionId) async {
    detailReads += 1;
    return AgentTaskDetail.fromJson(
      _detail(
        executionId: executionId,
        validationStatus: detailReads == 1 ? 'current' : 'changed',
      ),
    );
  }
}

Map<String, dynamic> _detail({
  required String executionId,
  required String validationStatus,
}) => {
  'task': {
    'executionId': executionId,
    'authority': {
      'immutable': true,
      'contractSha256': _digest('a'),
      'grantRequestSha256': _digest('b'),
      'validation': {
        'status': validationStatus,
        'category': validationStatus == 'changed'
            ? 'capability_binding'
            : 'all_grants',
        'validatedAt': '2026-09-22T10:00:00.000Z',
      },
      'nativeReadTools': [
        {'toolId': 'knowledge.search'},
      ],
      'skills': [
        {
          'capabilityGrantId': 'grant-skill-one',
          'skillId': 'research',
          'skillVersion': 3,
          'skillVersionId': 'skill:research:v3',
          'skillSha256': _digest('c'),
        },
      ],
      'plugins': [
        {
          'capabilityGrantId': 'grant-plugin-one',
          'installationId': 'installation-one',
          'installationRevision': 4,
          'installationSha256': _digest('d'),
          'pluginId': 'project-kit',
          'pluginVersion': '1.0.0',
          'manifestSha256': _digest('e'),
          'componentIds': ['skill.research', 'plugin.workflow'],
        },
      ],
      'mcpServers': [
        {
          'capabilityGrantId': 'grant-mcp-one',
          'serverId': 'market-research',
          'serverVersionId': 'mcp:market-research:v2',
          'serverContractSha256': _digest('f'),
          'governedToolIds': ['market.news.search', 'market.calendar.read'],
          'connectorTargetIds': ['twelve-data', 'fred'],
        },
      ],
    },
    'controls': {
      'grantsImmutable': true,
      'allowedActions': ['cancel'],
    },
  },
};

String _digest(String character) => List.filled(64, character).join();
