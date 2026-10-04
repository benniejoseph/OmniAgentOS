import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'agents.dart';
import 'agent_governance.dart';
import 'agent_learning.dart';
import 'specialist_api_client.dart';

class ApiAgentsRepository
    implements
        AgentsRepository,
        ProgressiveAgentsRepository,
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
    final primary = await loadPrimary();
    return AgentLedger(
      agents: primary.agents,
      skills: primary.skills,
      performance: await loadPerformance(),
    );
  }

  @override
  Future<AgentLedger> loadPrimary() async {
    // Roster and skills are the primary editing projection. Performance is a
    // secondary read, so load it in a second bounded wave rather than opening
    // three database-backed requests alongside the live Agent Council read.
    final primary = await Future.wait([
      api.getJson(NativePaths.agentsList),
      api.getJson(NativePaths.skillsList),
    ]);
    final a = primary[0], s = primary[1];
    for (final rows in [a['builtIns'], a['agents'], s['skills']]) {
      if (rows is! List ||
          rows.length > 1000 ||
          rows.any((row) => row is! Map)) {
        throw const FormatException(
          'The Agent inventory is incomplete or exceeds the native bound.',
        );
      }
    }
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
      performance: const [],
    );
  }

  @override
  Future<List<AgentPerformance>> loadPerformance() async {
    final response = await api.getJson(NativePaths.agentsPerformance);
    if (response['agents'] is! List ||
        (response['agents'] as List).length > 1000) {
      throw const FormatException(
        'Agent outcomes are incomplete or exceed the native bound.',
      );
    }
    return (response['agents'] as List? ?? const [])
        .whereType<Map>()
        .map((j) => AgentPerformance.fromJson(Map<String, dynamic>.from(j)))
        .toList(growable: false);
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
    final saved = AgentProfile.fromJson(Map<String, dynamic>.from(agent));
    if ((id != null && saved.id != id) ||
        (input.containsKey('name') &&
            saved.name != input['name'].toString().trim())) {
      throw const FormatException(
        'The returned Agent differs from the exact submitted definition.',
      );
    }
    await acceptSpecialistResponse(api, response);
    return saved;
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
    final response = await api.postJson(
      NativePaths.moltbookConnectionManage(agentId),
      data: input,
      headers: _mutationHeaders('moltbook'),
    );
    final connection = response['connection'];
    if (connection is! Map ||
        connection['agentId'] != agentId ||
        !const {
          'registering',
          'pending_claim',
          'claimed',
          'paused',
          'error',
          'revoked',
        }.contains(connection['status'])) {
      throw const FormatException(
        'The connection receipt does not identify the exact Agent.',
      );
    }
    // A provider cycle can report an uncertain effect even with HTTP success.
    if (input['action'] != 'run_autonomy_once') {
      await acceptSpecialistResponse(api, response);
    }
  }

  @override
  Future<AgentGovernanceSnapshot> loadGovernance(String agentId) async {
    _requireAgentId(agentId);
    final releaseResponse = await api.getJsonFresh(
      NativePaths.agentsReleaseShow(agentId),
    );
    final adaptationResponse = await api.getJsonFresh(
      NativePaths.agentsAdaptationsList(agentId),
    );
    final adaptation = AgentAdaptationProjection.listFromResponse(
      adaptationResponse,
      expectedAgentId: agentId,
    );
    final release = AgentReleaseProjection.fromResponse(releaseResponse);
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
    final response = await api.postJson(
      NativePaths.agentsReleaseManage(agentId),
      data: action,
      headers: {'idempotency-key': idempotencyKey},
    );
    // The current release projection is read independently from this response.
    final release = AgentReleaseProjection.fromResponse(response);
    if (release.agentId != agentId) {
      throw const FormatException('Release receipt identifies another Agent.');
    }
    await acceptSpecialistResponse(api, response);
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
    final response = await api.postJson(
      NativePaths.agentsAdaptationsManage(agentId),
      data: action,
      headers: {'idempotency-key': idempotencyKey},
    );
    if (response['adaptations'] is! List) {
      throw const FormatException('Adaptation receipt is missing.');
    }
    final adaptations = AgentAdaptationProjection.listFromResponse(
      response,
      expectedAgentId: agentId,
    );
    if (name != 'refresh' &&
        !adaptations.items.any(
          (item) => item.adaptationId == action['adaptationId'],
        )) {
      throw const FormatException(
        'The exact adaptation is missing from the accepted projection.',
      );
    }
    await acceptSpecialistResponse(api, response);
    return loadGovernance(agentId);
  }

  void _requireAgentId(String agentId) {
    if (agentId.trim().isEmpty || agentId.length > 200) {
      throw ArgumentError.value(agentId, 'agentId');
    }
  }
}
