import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'agents.dart';
import 'agent_governance.dart';
import 'agent_learning.dart';

class ApiAgentsRepository
    implements
        AgentsRepository,
        MoltbookAgentsRepository,
        AgentGovernanceRepository,
        AgentLearningRepository {
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

  @override
  Future<AgentGovernanceSnapshot> loadGovernance(String agentId) async {
    _requireAgentId(agentId);
    final responses = await Future.wait([
      api.getJsonFresh(NativePaths.agentsReleaseShow(agentId)),
      api.getJsonFresh(NativePaths.agentsAdaptationsList(agentId)),
    ]);
    final adaptation = AgentAdaptationProjection.listFromResponse(
      responses[1],
      expectedAgentId: agentId,
    );
    final release = AgentReleaseProjection.fromResponse(responses[0]);
    if (release.agentId != agentId ||
        release.latestDefinitionVersion != adaptation.definitionVersion) {
      throw const FormatException(
        'The governance services returned different Agent snapshots.',
      );
    }
    return AgentGovernanceSnapshot(
      release: release,
      definitionVersion: adaptation.definitionVersion,
      adaptations: adaptation.items,
    );
  }

  @override
  Future<AgentDailyLearningStatus> loadLearning(String agentId) async {
    _requireAgentId(agentId);
    return AgentDailyLearningStatus.fromResponse(
      await api.getJsonFresh(NativePaths.agentsLearningShow(agentId)),
      expectedAgentId: agentId,
    );
  }

  @override
  Future<AgentGovernanceSnapshot> manageRelease(
    String agentId,
    AgentGovernanceJson action, {
    required String idempotencyKey,
  }) async {
    _requireAgentId(agentId);
    final name = action['action'];
    if (!const {'evaluate', 'promote', 'rollback'}.contains(name)) {
      throw const FormatException(
        'Native Agent release controls allow only evaluate, promote, or rollback.',
      );
    }
    await api.postJson(
      NativePaths.agentsReleaseManage(agentId),
      data: action,
      headers: {'idempotency-key': idempotencyKey},
    );
    return loadGovernance(agentId);
  }

  @override
  Future<AgentGovernanceSnapshot> manageAdaptation(
    String agentId,
    AgentGovernanceJson action, {
    required String idempotencyKey,
  }) async {
    _requireAgentId(agentId);
    final name = action['action'];
    if (!const {'refresh', 'evaluate', 'activate', 'rollback'}.contains(name)) {
      throw const FormatException(
        'Native Agent adaptation controls do not accept this action.',
      );
    }
    await api.postJson(
      NativePaths.agentsAdaptationsManage(agentId),
      data: action,
      headers: {'idempotency-key': idempotencyKey},
    );
    return loadGovernance(agentId);
  }

  void _requireAgentId(String agentId) {
    if (agentId.trim().isEmpty || agentId.length > 200) {
      throw ArgumentError.value(agentId, 'agentId');
    }
  }
}
