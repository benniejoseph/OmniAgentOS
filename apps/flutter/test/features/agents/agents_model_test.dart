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
