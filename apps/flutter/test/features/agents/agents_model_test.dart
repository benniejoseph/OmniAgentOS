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
}
