import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'agents.dart';

class ApiAgentsRepository implements AgentsRepository {
  const ApiAgentsRepository(this.api);
  final ApiClient api;
  @override
  Future<AgentLedger> load() async {
    final responses = await Future.wait([
      api.getJson(NativePaths.agentsList),
      api.getJson(NativePaths.skillsList),
      api.getJson(NativePaths.agentsPerformance),
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
        ? await api.postJson(NativePaths.agentsCreate, data: input)
        : await api.patchJson(NativePaths.agentsUpdate(id), data: input);
    return AgentProfile.fromJson(Map<String, dynamic>.from(j['agent'] as Map));
  }

  @override
  Future<AgentSkill> saveSkill(Json input, {String? id}) async {
    final j = id == null
        ? await api.postJson(NativePaths.skillsCreate, data: input)
        : await api.patchJson(NativePaths.skillsUpdate(id), data: input);
    return AgentSkill.fromJson(Map<String, dynamic>.from(j['skill'] as Map));
  }

  @override
  Future<void> deleteAgent(String id) async {
    await api.deleteJson(NativePaths.agentsDelete(id));
  }

  @override
  Future<void> deleteSkill(String id) async {
    await api.deleteJson(NativePaths.skillsDelete(id));
  }
}
