import '../../core/network/api_client.dart';
import 'agents.dart';

class ApiAgentsRepository implements AgentsRepository {
  const ApiAgentsRepository(this.api);
  final ApiClient api;
  @override
  Future<AgentLedger> load() async {
    final responses = await Future.wait([
      api.getJson('/api/agents'),
      api.getJson('/api/skills'),
      api.getJson('/api/agents/performance'),
    ]);
    final a = responses[0], s = responses[1], p = responses[2];
    return AgentLedger(
      agents: [
        ...(a['builtIns'] as List? ?? const []).whereType<Map>().map(
          (j) => AgentProfile.fromJson(
            Map<String, dynamic>.from(j),
            builtIn: true,
          ),
        ),
        ...(a['agents'] as List? ?? const []).whereType<Map>().map(
          (j) => AgentProfile.fromJson(Map<String, dynamic>.from(j)),
        ),
      ],
      skills: (s['skills'] as List? ?? const [])
          .whereType<Map>()
          .map((j) => AgentSkill.fromJson(Map<String, dynamic>.from(j)))
          .toList(),
      performance: (p['agents'] as List? ?? const [])
          .whereType<Map>()
          .map((j) => AgentPerformance.fromJson(Map<String, dynamic>.from(j)))
          .toList(),
    );
  }

  @override
  Future<AgentProfile> saveAgent(Json input, {String? id}) async {
    final j = id == null
        ? await api.postJson('/api/agents', data: input)
        : await api.patchJson('/api/agents/$id', data: input);
    return AgentProfile.fromJson(Map<String, dynamic>.from(j['agent'] as Map));
  }

  @override
  Future<AgentSkill> saveSkill(Json input, {String? id}) async {
    final j = id == null
        ? await api.postJson('/api/skills', data: input)
        : await api.patchJson('/api/skills/$id', data: input);
    return AgentSkill.fromJson(Map<String, dynamic>.from(j['skill'] as Map));
  }

  @override
  Future<void> deleteAgent(String id) async {
    await api.deleteJson('/api/agents/$id');
  }

  @override
  Future<void> deleteSkill(String id) async {
    await api.deleteJson('/api/skills/$id');
  }
}
