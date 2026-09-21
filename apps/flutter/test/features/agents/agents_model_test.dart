import 'package:flutter_test/flutter_test.dart';
import 'package:asael/features/agents/agents.dart';

void main() {
  test('agent policy and assignments parse from API data', () {
    final agent = AgentProfile.fromJson({
      'id': 'agent-1',
      'name': 'Architect',
      'role': 'Principal',
      'modelPolicy': 'openai_reasoning',
      'autonomy': 'governed',
      'approvalPolicy': 'risk_based',
      'memoryScope': 'project',
      'skillIds': ['research'],
      'toolIds': ['knowledge.search'],
    });
    expect(agent.modelPolicy, 'openai_reasoning');
    expect(agent.skillIds, ['research']);
    expect(agent.memoryScope, 'project');
  });

  test('agent actionability honors flags with legacy-safe defaults', () {
    final legacyCustom = AgentProfile.fromJson({
      'id': 'custom-current',
      'name': 'Current custom agent',
    });
    final legacyBuiltIn = AgentProfile.fromJson({
      'id': 'atlas',
      'name': 'Atlas',
    }, builtIn: true);
    final canonicalCustom = AgentProfile.fromJson({
      'id': 'custom-canonical',
      'name': 'Canonical custom agent',
      'selectable': false,
      'manageable': false,
    });
    final malformedCapabilities = AgentProfile.fromJson({
      'id': 'custom-malformed',
      'name': 'Malformed capabilities',
      'selectable': 'yes',
      'manageable': 1,
    });

    expect(legacyCustom.selectable, isTrue);
    expect(legacyCustom.manageable, isTrue);
    expect(legacyBuiltIn.selectable, isTrue);
    expect(legacyBuiltIn.manageable, isFalse);
    expect(canonicalCustom.selectable, isFalse);
    expect(canonicalCustom.manageable, isFalse);
    expect(malformedCapabilities.selectable, isFalse);
    expect(malformedCapabilities.manageable, isFalse);
  });

  test('skill actionability honors flags with legacy-safe defaults', () {
    final legacyCustom = AgentSkill.fromJson({
      'id': 'custom-current',
      'name': 'Current custom skill',
    });
    final legacyBuiltIn = AgentSkill.fromJson({
      'id': 'core.research',
      'name': 'Research',
      'builtIn': true,
    });
    final canonicalCustom = AgentSkill.fromJson({
      'id': 'custom-canonical',
      'name': 'Canonical custom skill',
      'selectable': false,
      'manageable': false,
    });
    final malformedCapabilities = AgentSkill.fromJson({
      'id': 'custom-malformed',
      'name': 'Malformed capabilities',
      'selectable': 'yes',
      'manageable': 1,
    });

    expect(legacyCustom.selectable, isTrue);
    expect(legacyCustom.manageable, isTrue);
    expect(legacyBuiltIn.selectable, isTrue);
    expect(legacyBuiltIn.manageable, isFalse);
    expect(canonicalCustom.selectable, isFalse);
    expect(canonicalCustom.manageable, isFalse);
    expect(malformedCapabilities.selectable, isFalse);
    expect(malformedCapabilities.manageable, isFalse);
    expect(
      filterSelectableSkillIds(
        [legacyCustom, legacyBuiltIn, canonicalCustom],
        ['custom-current', 'core.research', 'custom-canonical', 'missing'],
      ),
      {'custom-current', 'core.research'},
    );
  });

  test('agent Skill selection stops at the shared prompt limit', () {
    final selected = {
      for (var index = 0; index < maxAssignedAgentSkills; index++)
        'skill-$index',
    };

    expect(canSelectAgentSkill(selected, 'skill-0'), isTrue);
    expect(canSelectAgentSkill(selected, 'skill-new'), isFalse);
    selected.remove('skill-0');
    expect(canSelectAgentSkill(selected, 'skill-new'), isTrue);
  });

  test('performance accepts normalized API fields', () {
    final metric = AgentPerformance.fromJson({
      'agentId': 'a',
      'agentName': 'A',
      'runCount': 12,
      'successRate': .75,
      'averageLatencyMs': 420,
    });
    expect(metric.runs, 12);
    expect(metric.successRate, .75);
  });

  test('Moltbook projection parses health, rate budget, and safe activity', () {
    final projection = MoltbookProjection.fromJson({
      'connection': {
        'status': 'claimed',
        'health': 'healthy',
        'externalName': 'AsaelResearcher',
        'claimState': 'claimed',
        'heartbeatEnabled': true,
        'consecutiveFailures': 0,
        'credentialConfigured': true,
        'lastHeartbeatAt': '2026-09-21T08:00:00.000Z',
        'nextHeartbeatAt': '2026-09-21T12:00:00.000Z',
        'rateLimit': {
          'limit': 100,
          'remaining': 87,
          'resetAt': '2026-09-21T09:00:00.000Z',
          'observedAt': '2026-09-21T08:00:00.000Z',
        },
      },
      'activities': [
        {
          'id': 'activity-1',
          'kind': 'post.create',
          'status': 'published',
          'summary': 'Published a governed update.',
          'createdAt': '2026-09-21T08:01:00.000Z',
          'runId': 'run-1',
          'providerObject': {
            'type': 'post',
            'ref': 'post-1',
            'url': 'https://www.moltbook.com/post/post-1',
          },
        },
      ],
      'nextCursor': 'older-page',
    });

    expect(projection.connection?.health, 'healthy');
    expect(projection.connection?.credentialConfigured, isTrue);
    expect(projection.connection?.rateLimitRemaining, 87);
    expect(projection.activities.single.providerType, 'post');
    expect(projection.activities.single.providerRef, 'post-1');
    expect(projection.activities.single.runId, 'run-1');
    expect(projection.nextCursor, 'older-page');
  });

  test('Moltbook links are limited to the exact official HTTPS host', () {
    expect(
      exactMoltbookUri('https://www.moltbook.com/claim/agent-1')?.host,
      'www.moltbook.com',
    );
    expect(
      exactMoltbookUri('https://www.moltbook.com:443/post/one'),
      isNotNull,
    );
    for (final value in [
      'http://www.moltbook.com/claim/agent-1',
      'https://moltbook.com/claim/agent-1',
      'https://www.moltbook.com.evil.example/claim/agent-1',
      'https://www.moltbook.com@evil.example/claim/agent-1',
      'https://user@www.moltbook.com/claim/agent-1',
      'https://www.moltbook.com:444/claim/agent-1',
      '/claim/agent-1',
    ]) {
      expect(exactMoltbookUri(value), isNull, reason: value);
    }
  });

  test('Agent mutation authority does not imply Skill or delete authority', () {
    final controller = AgentsController(
      _NoopAgentsRepository(),
      canManage: true,
      mutationsAvailable: true,
    );

    expect(controller.canMutateAgents, isTrue);
    expect(controller.canMutateSkills, isFalse);
    expect(controller.canDeleteAgents, isFalse);
    expect(controller.canManageMoltbook, isFalse);
  });
}

class _NoopAgentsRepository implements AgentsRepository {
  @override
  Future<void> deleteAgent(String id) async {}

  @override
  Future<void> deleteSkill(String id) async {}

  @override
  Future<AgentLedger> load() async =>
      const AgentLedger(agents: [], skills: [], performance: []);

  @override
  Future<AgentProfile> saveAgent(Json input, {String? id}) async =>
      AgentProfile.fromJson({'id': id ?? 'new', ...input});

  @override
  Future<AgentSkill> saveSkill(Json input, {String? id}) async =>
      AgentSkill.fromJson({'id': id ?? 'new', ...input});
}
