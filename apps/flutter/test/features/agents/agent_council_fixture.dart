import 'package:asael/features/agents/agent_council.dart';

const fixtureTimestamp = '2026-09-22T08:30:00.000Z';

Map<String, dynamic> agentCouncilFixtureJson({
  String state = 'ready',
  bool includeExecutions = true,
}) => {
  'version': agentCouncilProjectionVersion,
  'authority': 'canonical_delegation_ledger',
  'generatedAt': fixtureTimestamp,
  'state': state,
  'summary': {
    'executionCount': includeExecutions ? 1 : 0,
    'memberCount': includeExecutions ? 2 : 0,
    'activeMemberCount': includeExecutions ? 1 : 0,
    'waitingMemberCount': includeExecutions ? 1 : 0,
    'acceptedMemberCount': 0,
    'knownEstimatedCostMicrousd': includeExecutions ? 18200 : 0,
  },
  'executions': includeExecutions
      ? [
          {
            'parentExecutionId': 'run-council-one',
            'href': '/app/command?run=run-council-one',
            'status': 'running',
            'currentWork': 'Compare the current memory architecture with the target design.',
            'startedAt': '2026-09-22T08:20:00.000Z',
            'updatedAt': fixtureTimestamp,
            'members': [
              _member(
                taskId: 'task-scout-one',
                agentId: 'scout',
                name: 'Scout',
                role: 'Research specialist',
                state: 'working',
                confidence: .82,
                verdict: 'pending',
                score: null,
                messages: [
                  {
                    'messageId': 'message-one',
                    'kind': 'status',
                    'body':
                        'Primary sources have been collected for comparison.',
                    'direction': 'received',
                    'createdAt': fixtureTimestamp,
                    'trust': 'untrusted_shared_content',
                  },
                ],
                outputs: [
                  {
                    'artifactId': 'artifact-one',
                    'title': 'Architecture comparison',
                    'kind': 'report',
                    'mediaType': 'text/markdown',
                    'content': 'The durable event ledger is the strongest existing boundary.',
                    'createdAt': fixtureTimestamp,
                    'trust': 'untrusted_shared_content',
                  },
                ],
              ),
              _member(
                taskId: 'task-forge-one',
                agentId: 'forge',
                name: 'Forge',
                role: 'Implementation specialist',
                state: 'waiting',
                confidence: null,
                verdict: 'pending',
                score: null,
                messages: const [],
                outputs: const [],
              ),
            ],
            'verifierCost': _cost(
              state: 'partial',
              receiptCount: 1,
              tokens: 320,
              microusd: 4200,
            ),
          },
        ]
      : const [],
};

Map<String, dynamic> _member({
  required String taskId,
  required String agentId,
  required String name,
  required String role,
  required String state,
  required double? confidence,
  required String verdict,
  required double? score,
  required List<Map<String, dynamic>> messages,
  required List<Map<String, dynamic>> outputs,
}) => {
  'taskId': taskId,
  'delegationId': 'delegation-$taskId',
  'identity': _identity(agentId: agentId, name: name, role: role),
  'state': state,
  'lifecycleRevision': state == 'working' ? 3 : 4,
  'currentWork': state == 'working'
      ? 'Review sources and identify evidence-backed architecture gaps.'
      : 'Waiting for the parent Agent to provide an approved implementation boundary.',
  'updatedAt': fixtureTimestamp,
  'authority': {
    'source': 'delegation_grants',
    'receiptSha256': _digest('a'),
    'contractSha256': _digest('b'),
    'purpose': 'Produce a bounded contribution for the parent Agent to verify.',
    'scope': {
      'workspaceId': 'workspace-one',
      'projectId': 'project-one',
      'missionId': 'mission-one',
    },
    'context': {'state': 'granted', 'grantCount': 2},
    'capabilities': {'state': 'granted', 'grantCount': 1},
    'tools': {
      'state': 'granted',
      'ids': ['web.search', 'memory.inspect'],
    },
    'budgets': {
      'modelTurns': 4,
      'tokens': 12000,
      'costMicrousd': 500000,
      'wallTimeMs': 120000,
      'toolCalls': 8,
      'browserActions': 0,
    },
  },
  'messages': {'state': 'available', 'items': messages},
  'outputs': {
    'state': outputs.isEmpty ? 'none' : 'shared',
    'items': outputs,
    'proposalReceiptSha256': outputs.isEmpty ? null : _digest('c'),
  },
  'cost': _cost(state: 'exact', receiptCount: 2, tokens: 1400, microusd: 14000),
  'confidence': confidence,
  'verifier': {
    'identity': _identity(
      agentId: 'sentinel',
      name: 'Sentinel',
      role: 'Independent verifier',
    ),
    'acceptanceThreshold': .78,
    'method': 'agent_then_deterministic',
    'verdict': verdict,
    'score': score,
  },
};

Map<String, dynamic> _identity({
  required String agentId,
  required String name,
  required String role,
}) => {
  'agentId': agentId,
  'name': name,
  'role': role,
  'charter': 'Work within the delegated purpose and return evidence.',
  'visualIdentity': 'A precise geometric identity.',
  'definitionVersion': 1,
  'source': 'agent_definition',
};

Map<String, dynamic> _cost({
  required String state,
  required int receiptCount,
  required int tokens,
  required int microusd,
}) => {
  'authority': 'ai_usage_ledger_v1',
  'state': state,
  'receiptCount': receiptCount,
  'unknownCostReceiptCount': state == 'partial' ? 1 : 0,
  'totalTokens': tokens,
  'knownEstimatedCostMicrousd': microusd,
};

String _digest(String value) => List.filled(64, value).join();
