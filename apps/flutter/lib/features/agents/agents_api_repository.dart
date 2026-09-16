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
  Future<AgentProfile> saveAgent(Json input, {String? id}) => Future.error(
    UnsupportedError(
      'Agent mutations are not published by native contract v8.',
    ),
  );

  @override
  Future<AgentSkill> saveSkill(Json input, {String? id}) => Future.error(
    UnsupportedError(
      'Skill mutations are not published by native contract v8.',
    ),
  );

  @override
  Future<void> deleteAgent(String id) => Future.error(
    UnsupportedError(
      'Agent mutations are not published by native contract v8.',
    ),
  );

  @override
  Future<void> deleteSkill(String id) => Future.error(
    UnsupportedError(
      'Skill mutations are not published by native contract v8.',
    ),
  );
}
