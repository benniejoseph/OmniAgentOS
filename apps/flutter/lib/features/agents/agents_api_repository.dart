import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'agents.dart';

class ApiAgentsRepository
    implements AgentsRepository, MoltbookAgentsRepository {
  const ApiAgentsRepository(this.api);
  final ApiClient api;

  Map<String, dynamic> _mutationHeaders(String operation) => {
    'idempotency-key':
        'native-agent-$operation-${DateTime.now().microsecondsSinceEpoch}',
  };

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
    final response = id == null
        ? await api.postJson(
            NativePaths.agentsCreate,
            data: input,
            headers: _mutationHeaders('create'),
          )
        : await api.patchJson(
            NativePaths.agentsUpdate(id),
            data: input,
            headers: _mutationHeaders('update'),
          );
    final agent = response['agent'];
    if (agent is! Map) {
      throw const FormatException('The service returned an invalid Agent.');
    }
    return AgentProfile.fromJson(Map<String, dynamic>.from(agent));
  }

  @override
  Future<AgentSkill> saveSkill(Json input, {String? id}) => Future.error(
    UnsupportedError(
      'Skill mutations are not published by the current native contract.',
    ),
  );

  @override
  Future<void> deleteAgent(String id) => Future.error(
    UnsupportedError(
      'Agent deletion is not published by the current native contract.',
    ),
  );

  @override
  Future<void> deleteSkill(String id) => Future.error(
    UnsupportedError(
      'Skill mutations are not published by the current native contract.',
    ),
  );

  @override
  Future<MoltbookProjection> loadMoltbook(
    String agentId, {
    String? cursor,
    int limit = 20,
  }) async {
    if (limit < 1 || limit > 100) {
      throw RangeError.range(limit, 1, 100, 'limit');
    }
    return MoltbookProjection.fromJson(
      await api.getJsonFresh(
        NativePaths.moltbookConnectionShow(
          agentId,
          cursor: cursor,
          limit: limit,
        ),
      ),
    );
  }

  @override
  Future<void> changeMoltbook(String agentId, Json input) async {
    await api.postJson(
      NativePaths.moltbookConnectionManage(agentId),
      data: input,
      headers: _mutationHeaders('moltbook'),
    );
  }
}
