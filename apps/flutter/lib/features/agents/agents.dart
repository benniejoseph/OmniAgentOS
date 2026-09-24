import 'package:flutter/material.dart';

import 'agent_governance.dart';
import 'agent_governance_view.dart';
import 'agent_learning.dart';

typedef Json = Map<String, dynamic>;

const maxAssignedAgentSkills = 8;
const moltbookDisclosureVersion = 'moltbook-public-activity-v1';
const moltbookAutonomyDisclosureVersion = 'moltbook-autonomy-public-actions-v1';
const moltbookLegacyToolIds = <String>{
  'moltbook.home.read',
  'moltbook.feed.read',
  'moltbook.thread.read',
  'moltbook.post.create',
  'moltbook.comment.create',
  'moltbook.post.vote',
  'moltbook.comment.upvote',
  'moltbook.agent.follow',
  'moltbook.verify',
};
const moltbookToolIds = <String>{
  'moltbook.home.read',
  'moltbook.feed.read',
  'moltbook.thread.read',
  'moltbook.submolts.list',
  'moltbook.submolt.read',
  'moltbook.submolt.feed',
  'moltbook.post.create',
  'moltbook.comment.create',
  'moltbook.post.vote',
  'moltbook.comment.upvote',
  'moltbook.agent.follow',
  'moltbook.submolt.subscribe',
  'moltbook.verify',
};

List<String> _strings(Object? value) =>
    (value as List? ?? const []).map((e) => e.toString()).toList();

List<String> _splitCsv(String value) => value
    .split(',')
    .map((item) => item.trim())
    .where((item) => item.isNotEmpty)
    .toSet()
    .toList();

bool _capabilityFlag(Json value, String key, bool fallback) =>
    !value.containsKey(key) ? fallback : value[key] == true;

class AgentSkill {
  const AgentSkill({
    required this.id,
    required this.name,
    required this.description,
    required this.category,
    required this.status,
    required this.instructions,
    required this.toolIds,
    required this.tags,
    bool builtIn = false,
    this.selectable = true,
    bool? manageable,
  }) : builtIn = builtIn,
       manageable = manageable ?? !builtIn;
  final String id, name, description, category, status, instructions;
  final List<String> toolIds, tags;
  final bool builtIn, selectable, manageable;
  factory AgentSkill.fromJson(Json j) => AgentSkill(
    id: '${j['id']}',
    name: '${j['name'] ?? 'Skill'}',
    description: '${j['description'] ?? ''}',
    category: '${j['category'] ?? 'personal'}',
    status: '${j['status'] ?? 'active'}',
    instructions: '${j['instructions'] ?? ''}',
    toolIds: _strings(j['toolIds']),
    tags: _strings(j['tags']),
    builtIn: j['builtIn'] == true,
    selectable: _capabilityFlag(j, 'selectable', true),
    manageable: _capabilityFlag(j, 'manageable', j['builtIn'] != true),
  );
}

Set<String> filterSelectableSkillIds(
  Iterable<AgentSkill> skills,
  Iterable<String> selectedIds,
) {
  final selectableIds = skills
      .where((skill) => skill.selectable)
      .map((skill) => skill.id)
      .toSet();
  return selectedIds.where(selectableIds.contains).toSet();
}

bool canSelectAgentSkill(Set<String> selectedIds, String skillId) =>
    selectedIds.contains(skillId) ||
    selectedIds.length < maxAssignedAgentSkills;

class AgentProfile {
  const AgentProfile({
    required this.id,
    required this.name,
    required this.role,
    required this.description,
    required this.instructions,
    required this.status,
    required this.accent,
    required this.modelPolicy,
    required this.autonomy,
    required this.approvalPolicy,
    required this.memoryScope,
    required this.skillIds,
    required this.toolIds,
    bool builtIn = false,
    this.selectable = true,
    bool? manageable,
  }) : builtIn = builtIn,
       manageable = manageable ?? !builtIn;
  final String id,
      name,
      role,
      description,
      instructions,
      status,
      accent,
      modelPolicy,
      autonomy,
      approvalPolicy,
      memoryScope;
  final List<String> skillIds, toolIds;
  final bool builtIn, selectable, manageable;
  factory AgentProfile.fromJson(Json j, {bool builtIn = false}) => AgentProfile(
    id: '${j['id']}',
    name: '${j['name'] ?? 'Agent'}',
    role: '${j['role'] ?? ''}',
    description: '${j['description'] ?? ''}',
    instructions: '${j['instructions'] ?? ''}',
    status: '${j['status'] ?? 'ready'}',
    accent: '${j['accent'] ?? 'emerald'}',
    modelPolicy: '${j['modelPolicy'] ?? 'auto'}',
    autonomy: '${j['autonomy'] ?? 'assist'}',
    approvalPolicy: '${j['approvalPolicy'] ?? 'risk_based'}',
    memoryScope: '${j['memoryScope'] ?? 'all'}',
    skillIds: _strings(j['skillIds']),
    toolIds: _strings(j['toolIds'] ?? j['tools']),
    builtIn: builtIn,
    selectable: _capabilityFlag(j, 'selectable', true),
    manageable: _capabilityFlag(j, 'manageable', !builtIn),
  );
}

bool isExactMoltbookAgentBoundary(AgentProfile agent) =>
    agent.skillIds.isEmpty &&
    (_isExactToolSet(agent.toolIds, moltbookToolIds) ||
        _isExactToolSet(agent.toolIds, moltbookLegacyToolIds)) &&
    _hasExactMoltbookPolicyBoundary(agent);

bool _isExactToolSet(List<String> actual, Set<String> expected) =>
    actual.length == expected.length && actual.toSet().containsAll(expected);

bool _hasExactMoltbookPolicyBoundary(AgentProfile agent) =>
    agent.memoryScope == 'session' &&
    agent.autonomy == 'governed' &&
    (agent.approvalPolicy == 'risk_based' || agent.approvalPolicy == 'always');

class AgentPerformance {
  const AgentPerformance({
    required this.id,
    required this.name,
    required this.runs,
    required this.successRate,
    required this.averageLatencyMs,
    required this.memoriesFormed,
  });
  final String id, name;
  final int runs, averageLatencyMs, memoriesFormed;
  final double successRate;
  factory AgentPerformance.fromJson(Json j) => AgentPerformance(
    id: '${j['id'] ?? j['agentId']}',
    name: '${j['name'] ?? j['agentName'] ?? 'Agent'}',
    runs: (j['runs'] as num?)?.toInt() ?? (j['runCount'] as num?)?.toInt() ?? 0,
    successRate: (j['successRate'] as num?)?.toDouble() ?? 0,
    averageLatencyMs: (j['averageLatencyMs'] as num?)?.toInt() ?? 0,
    memoriesFormed:
        (j['memoriesFormed'] as num?)?.toInt() ??
        (j['memoriesLearned'] as num?)?.toInt() ??
        0,
  );
}

class AgentLedger {
  const AgentLedger({
    required this.agents,
    required this.skills,
    required this.performance,
  });
  final List<AgentProfile> agents;
  final List<AgentSkill> skills;
  final List<AgentPerformance> performance;
}

class MoltbookConnection {
  const MoltbookConnection({
    required this.status,
    required this.health,
    required this.externalName,
    required this.claimState,
    required this.heartbeatEnabled,
    required this.consecutiveFailures,
    required this.credentialConfigured,
    this.disclosureAccepted = false,
    this.disclosureVersion,
    this.claimUrl,
    this.verificationCode,
    this.lastHeartbeatAt,
    this.nextHeartbeatAt,
    this.lastErrorCode,
    this.createdAt,
    this.updatedAt,
    this.rateLimitLimit,
    this.rateLimitRemaining,
    this.rateLimitResetAt,
    this.rateLimitObservedAt,
  });

  final String status, health, externalName, claimState;
  final bool heartbeatEnabled, credentialConfigured, disclosureAccepted;
  final int consecutiveFailures;
  final String? claimUrl,
      verificationCode,
      lastHeartbeatAt,
      nextHeartbeatAt,
      lastErrorCode,
      createdAt,
      updatedAt,
      rateLimitResetAt,
      rateLimitObservedAt;
  final String? disclosureVersion;
  final int? rateLimitLimit, rateLimitRemaining;

  factory MoltbookConnection.fromJson(Json value) {
    final rateLimit = value['rateLimit'];
    return MoltbookConnection(
      status: '${value['status'] ?? 'error'}',
      health: '${value['health'] ?? 'error'}',
      externalName: '${value['externalName'] ?? ''}',
      claimState: '${value['claimState'] ?? 'unavailable'}',
      heartbeatEnabled: value['heartbeatEnabled'] == true,
      consecutiveFailures: (value['consecutiveFailures'] as num?)?.toInt() ?? 0,
      credentialConfigured: value['credentialConfigured'] == true,
      disclosureAccepted: value['disclosureAccepted'] == true,
      disclosureVersion: value['disclosureVersion']?.toString(),
      claimUrl: value['claimUrl']?.toString(),
      verificationCode: value['verificationCode']?.toString(),
      lastHeartbeatAt: value['lastHeartbeatAt']?.toString(),
      nextHeartbeatAt: value['nextHeartbeatAt']?.toString(),
      lastErrorCode: value['lastErrorCode']?.toString(),
      createdAt: value['createdAt']?.toString(),
      updatedAt: value['updatedAt']?.toString(),
      rateLimitLimit: rateLimit is Map
          ? (rateLimit['limit'] as num?)?.toInt()
          : null,
      rateLimitRemaining: rateLimit is Map
          ? (rateLimit['remaining'] as num?)?.toInt()
          : null,
      rateLimitResetAt: rateLimit is Map
          ? rateLimit['resetAt']?.toString()
          : null,
      rateLimitObservedAt: rateLimit is Map
          ? rateLimit['observedAt']?.toString()
          : null,
    );
  }
}

class MoltbookActivity {
  const MoltbookActivity({
    required this.id,
    required this.kind,
    required this.status,
    required this.summary,
    required this.createdAt,
    this.externalUrl,
    this.providerType,
    this.providerRef,
    this.runId,
  });

  final String id, kind, status, summary, createdAt;
  final String? externalUrl, providerType, providerRef, runId;

  factory MoltbookActivity.fromJson(Json value) {
    final providerObject = value['providerObject'];
    return MoltbookActivity(
      id: '${value['id']}',
      kind: '${value['kind'] ?? 'activity'}',
      status: '${value['status'] ?? 'failed'}',
      summary: '${value['summary'] ?? 'Moltbook activity'}',
      createdAt: '${value['createdAt'] ?? ''}',
      externalUrl: providerObject is Map
          ? providerObject['url']?.toString()
          : null,
      providerType: providerObject is Map
          ? providerObject['type']?.toString()
          : null,
      providerRef: providerObject is Map
          ? providerObject['ref']?.toString()
          : null,
      runId: value['runId']?.toString(),
    );
  }
}

class MoltbookActionBudget {
  const MoltbookActionBudget({
    required this.key,
    required this.label,
    required this.used,
    required this.limit,
  });

  final String key, label;
  final int used, limit;
  int get remaining => (limit - used).clamp(0, limit).toInt();
}

class MoltbookInterest {
  const MoltbookInterest({
    required this.topic,
    required this.score,
    required this.confidence,
    required this.evidenceCount,
  });

  final String topic;
  final double score, confidence;
  final int evidenceCount;
}

class MoltbookCycleReceipt {
  const MoltbookCycleReceipt({
    required this.id,
    required this.status,
    this.trigger,
    this.createdAt,
    this.completedAt,
    this.runId,
  });

  final String id, status;
  final String? trigger, createdAt, completedAt, runId;
}

class MoltbookAutonomy {
  const MoltbookAutonomy({
    required this.status,
    required this.cadenceMs,
    required this.budgets,
    required this.interests,
    required this.cycles,
    this.executable = false,
    this.blockedReason,
    this.lastCycleAt,
    this.nextCycleAt,
    this.lastRunId,
    this.budgetResetAt,
  });

  final String status;
  final bool executable;
  final int cadenceMs;
  final List<MoltbookActionBudget> budgets;
  final List<MoltbookInterest> interests;
  final List<MoltbookCycleReceipt> cycles;
  final String? blockedReason;
  final String? lastCycleAt, nextCycleAt, lastRunId, budgetResetAt;

  factory MoltbookAutonomy.fromJson(Json value) {
    final enrollment = _jsonMap(value['enrollment']) ?? value;
    final enrollmentBudgets = _jsonMap(enrollment['budgets']);
    final rawStatus = _firstString([value['status'], enrollment['status']])
        ?.toLowerCase();
    final status = rawStatus == 'active' ? 'enabled' : rawStatus;
    if (!const {'enabled', 'paused', 'revoked', 'running'}.contains(status)) {
      throw const FormatException('Unsupported Moltbook autonomy status.');
    }
    final executableValue = value.containsKey('executable')
        ? value['executable']
        : enrollment['executable'];
    final executable = executableValue == true;
    final rawBlockedReason = _firstString([
      value['blockedReason'],
      enrollment['blockedReason'],
    ])?.toLowerCase();
    final blockedReason =
        const {
          'connection_unavailable',
          'authority_unavailable',
        }.contains(rawBlockedReason)
        ? rawBlockedReason
        : null;
    final cadenceMs =
        _firstNumber([value['cadenceMs'], enrollment['cadenceMs']])?.toInt() ??
        ((_firstNumber([
                  value['cycleIntervalSeconds'],
                  enrollment['cycleIntervalSeconds'],
                  enrollmentBudgets?['cycleIntervalSeconds'],
                ])?.toInt() ??
                14400) *
            1000);
    final budgetsValue = _jsonMap(value['budgets']);
    final budgetsSource =
        _jsonMap(budgetsValue?['daily']) ??
        _jsonMap(value['dailyBudgets']) ??
        budgetsValue ??
        _jsonMap(value['budget']);
    final usageSource =
        _jsonMap(value['dailyUsage']) ??
        _jsonMap(value['usage']) ??
        _jsonMap(value['budgetUsage']);
    final limitsSource =
        _jsonMap(value['dailyLimits']) ??
        _jsonMap(value['limits']) ??
        _jsonMap(enrollment['dailyLimits']) ??
        _jsonMap(enrollmentBudgets?['daily']);
    final specs = <(String, String, List<String>)>[
      ('post', 'Posts', ['post', 'posts']),
      ('comment', 'Replies', ['comment', 'comments', 'reply', 'replies']),
      ('vote', 'Votes', ['vote', 'votes']),
      ('follow', 'Follows', ['follow', 'follows']),
      (
        'subscribe',
        'Community joins',
        [
          'subscribe',
          'subscribes',
          'subscription',
          'subscriptions',
          'communityJoin',
          'communityJoins',
        ],
      ),
    ];
    final budgets = specs
        .map((spec) {
          final (key, label, aliases) = spec;
          Json? item;
          for (final alias in aliases) {
            item ??= _jsonMap(budgetsSource?[alias]);
          }
          final limitValues = <Object?>[item?['limit'], item?['total']];
          final usedValues = <Object?>[item?['used']];
          for (final alias in aliases) {
            final upper = '${alias[0].toUpperCase()}${alias.substring(1)}';
            final snake = alias
                .replaceAllMapped(
                  RegExp(r'([a-z0-9])([A-Z])'),
                  (match) => '${match[1]}_${match[2]}',
                )
                .toLowerCase();
            limitValues.addAll([
              limitsSource?[alias],
              value['daily${upper}Limit'],
              enrollment['daily${upper}Limit'],
              value['daily_${snake}_limit'],
              enrollment['daily_${snake}_limit'],
            ]);
            usedValues.addAll([
              usageSource?[alias],
              value['daily${upper}Used'],
              value['daily_${snake}_used'],
            ]);
          }
          final limit = _nonNegativeInt(_firstNumber(limitValues) ?? 0);
          final explicitUsed = _firstNumber(usedValues);
          final remaining = _firstNumber([item?['remaining']]);
          final used = _nonNegativeInt(
            explicitUsed ??
                (remaining == null ? 0 : (limit - remaining).clamp(0, limit)),
          );
          return MoltbookActionBudget(
            key: key,
            label: label,
            used: used,
            limit: limit,
          );
        })
        .toList(growable: false);

    final interestValues = _firstList([
      value['interests'],
      value['developingInterests'],
      value['interestProfile'],
    ]);
    final interests = interestValues.map(_jsonMap).whereType<Json>().map((
      interest,
    ) {
      final evidence = _firstList([
        interest['evidence'],
        interest['evidenceSha256s'],
        interest['evidenceIds'],
      ]);
      return MoltbookInterest(
        topic:
            _firstString([
              interest['topic'],
              interest['name'],
              interest['label'],
            ]) ??
            'Emerging topic',
        score: _unit(
          _firstNumber([interest['score'], interest['weight']]) ?? 0,
        ),
        confidence: _unit(_firstNumber([interest['confidence']]) ?? 0),
        evidenceCount: _nonNegativeInt(
          _firstNumber([interest['evidenceCount']]) ?? evidence.length,
        ),
      );
    }).toList()..sort((a, b) => b.score.compareTo(a.score));

    final cycleValues = _firstList([
      value['recentCycles'],
      value['cycles'],
      value['cycleReceipts'],
    ]);
    final cycles = <MoltbookCycleReceipt>[];
    for (var index = 0; index < cycleValues.length && index < 8; index += 1) {
      final cycle = _jsonMap(cycleValues[index]);
      if (cycle == null) continue;
      cycles.add(
        MoltbookCycleReceipt(
          id: _firstString([cycle['id'], cycle['cycleId']]) ?? 'cycle-$index',
          status:
              _firstString([cycle['status'], cycle['outcome']]) ?? 'unknown',
          trigger: _firstString([cycle['trigger'], cycle['triggerKind']]),
          createdAt: _firstString([
            cycle['createdAt'],
            cycle['startedAt'],
            cycle['scheduledFor'],
          ]),
          completedAt: _firstString([cycle['completedAt']]),
          runId: _firstString([cycle['runId'], cycle['agentRunId']]),
        ),
      );
    }
    final lastCycle = cycles.isEmpty ? null : cycles.first;
    return MoltbookAutonomy(
      status: status!,
      executable: executable,
      blockedReason: executable ? null : blockedReason,
      cadenceMs: cadenceMs.clamp(0, 86400000).toInt(),
      budgets: budgets,
      interests: interests.take(8).toList(growable: false),
      cycles: cycles,
      lastCycleAt: _firstString([
        value['lastCycleAt'],
        enrollment['lastCycleAt'],
        lastCycle?.completedAt,
        lastCycle?.createdAt,
      ]),
      nextCycleAt: _firstString([
        value['nextCycleAt'],
        enrollment['nextCycleAt'],
      ]),
      lastRunId: _firstString([
        value['lastRunId'],
        value['agentRunId'],
        lastCycle?.runId,
      ]),
      budgetResetAt: _firstString([
        usageSource?['resetAt'],
        value['budgetResetAt'],
      ]),
    );
  }
}

class MoltbookProjection {
  const MoltbookProjection({
    required this.connection,
    required this.activities,
    this.autonomy,
    this.nextCursor,
  });

  final MoltbookConnection? connection;
  final List<MoltbookActivity> activities;
  final MoltbookAutonomy? autonomy;
  final String? nextCursor;

  factory MoltbookProjection.fromJson(Json value) {
    final connection = value['connection'];
    return MoltbookProjection(
      connection: connection is Map
          ? MoltbookConnection.fromJson(Map<String, dynamic>.from(connection))
          : null,
      activities: (value['activities'] as List? ?? const [])
          .whereType<Map>()
          .map(
            (item) =>
                MoltbookActivity.fromJson(Map<String, dynamic>.from(item)),
          )
          .toList(),
      autonomy: _parseMoltbookAutonomy(value['autonomy']),
      nextCursor: value['nextCursor']?.toString(),
    );
  }
}

MoltbookAutonomy? _parseMoltbookAutonomy(Object? value) {
  final map = _jsonMap(value);
  if (map == null) return null;
  try {
    return MoltbookAutonomy.fromJson(map);
  } on FormatException {
    return null;
  }
}

Json? _jsonMap(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : null;

String? _firstString(Iterable<Object?> values) {
  for (final value in values) {
    if (value is String && value.trim().isNotEmpty) return value.trim();
  }
  return null;
}

num? _firstNumber(Iterable<Object?> values) {
  for (final value in values) {
    if (value is num && value.isFinite) return value;
    if (value is String) {
      final parsed = num.tryParse(value);
      if (parsed != null && parsed.isFinite) return parsed;
    }
  }
  return null;
}

List<Object?> _firstList(Iterable<Object?> values) {
  for (final value in values) {
    if (value is List) return value;
  }
  return const [];
}

int _nonNegativeInt(num value) => value.floor().clamp(0, 1 << 31).toInt();
double _unit(num value) => value.toDouble().clamp(0, 1).toDouble();

Uri? exactMoltbookUri(String? value) {
  if (value == null || value.isEmpty) return null;
  final uri = Uri.tryParse(value);
  if (uri == null ||
      uri.scheme != 'https' ||
      uri.host != 'www.moltbook.com' ||
      !uri.isAbsolute ||
      uri.userInfo.isNotEmpty ||
      (uri.hasPort && uri.port != 443)) {
    return null;
  }
  return uri;
}

abstract interface class AgentsRepository {
  Future<AgentLedger> load();
  Future<AgentProfile> saveAgent(Json input, {String? id});
  Future<AgentSkill> saveSkill(Json input, {String? id});
  Future<void> deleteAgent(String id);
  Future<void> deleteSkill(String id);
}

abstract interface class ProgressiveAgentsRepository {
  Future<AgentLedger> loadPrimary();
  Future<List<AgentPerformance>> loadPerformance();
}

abstract interface class MoltbookAgentsRepository {
  Future<MoltbookProjection> loadMoltbook(
    String agentId, {
    String? cursor,
    int limit = 20,
  });
  Future<void> changeMoltbook(String agentId, Json input);
}

abstract interface class AgentLearningRepository {
  Future<AgentDailyLearningStatus> loadLearning(String agentId);
}

class AgentsController extends ChangeNotifier {
  AgentsController(
    this.repository, {
    required this.canManage,
    required this.mutationsAvailable,
    this.skillMutationsAvailable = false,
    this.agentDeleteAvailable = false,
    this.moltbookAvailable = false,
    this.learningReadAvailable = false,
    this.governanceReadAvailable = false,
    this.governanceMutationAvailable = false,
  });
  final AgentsRepository repository;
  final bool canManage;
  final bool mutationsAvailable;
  final bool skillMutationsAvailable,
      agentDeleteAvailable,
      moltbookAvailable,
      learningReadAvailable;
  final bool governanceReadAvailable, governanceMutationAvailable;
  Future<void>? _refreshing;
  bool get canMutate => canMutateAgents;
  bool get canMutateAgents => canManage && mutationsAvailable;
  bool get canMutateSkills => canManage && skillMutationsAvailable;
  bool get canDeleteAgents => canManage && agentDeleteAvailable;
  bool get canManageMoltbook => canManage && moltbookAvailable;
  bool get canReadLearning =>
      learningReadAvailable && repository is AgentLearningRepository;
  bool get canReadGovernance =>
      governanceReadAvailable && repository is AgentGovernanceRepository;
  bool get canManageGovernance =>
      canManage && governanceMutationAvailable && canReadGovernance;
  AgentLedger? ledger;
  bool loading = false;
  Object? error;
  Future<void> refresh() {
    final refreshing = _refreshing;
    if (refreshing != null) return refreshing;
    final operation = _refresh();
    _refreshing = operation;
    return operation.whenComplete(() {
      if (identical(_refreshing, operation)) _refreshing = null;
    });
  }

  Future<void> _refresh() async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      final source = repository;
      final progressive = source is ProgressiveAgentsRepository
          ? source as ProgressiveAgentsRepository
          : null;
      if (progressive != null) {
        final primary = await progressive.loadPrimary();
        ledger = primary;
        notifyListeners();
        ledger = AgentLedger(
          agents: primary.agents,
          skills: primary.skills,
          performance: await progressive.loadPerformance(),
        );
      } else {
        ledger = await source.load();
      }
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> saveAgent(Json value, {String? id}) async {
    _requireManageableAgent(id);
    final saved = await repository.saveAgent(value, id: id);
    final current = ledger;
    if (current == null) {
      await _refreshAfterMutation();
      return;
    }
    final agents = [...current.agents];
    final index = agents.indexWhere((agent) => agent.id == saved.id);
    if (index < 0) {
      agents.add(saved);
    } else {
      agents[index] = saved;
    }
    ledger = AgentLedger(
      agents: List.unmodifiable(agents),
      skills: current.skills,
      performance: current.performance,
    );
    error = null;
    notifyListeners();
  }

  Future<void> saveSkill(Json value, {String? id}) async {
    if (!canMutateSkills) {
      throw StateError('Skill changes are not available here.');
    }
    await repository.saveSkill(value, id: id);
    await _refreshAfterMutation();
  }

  Future<void> removeAgent(String id) async {
    if (!canDeleteAgents ||
        !(ledger?.agents.any((agent) => agent.id == id && agent.manageable) ??
            false)) {
      throw StateError('Agent deletion is not available here.');
    }
    await repository.deleteAgent(id);
    await _refreshAfterMutation();
  }

  Future<void> removeSkill(String id) async {
    if (!canMutateSkills) {
      throw StateError('Skill changes are not available here.');
    }
    await repository.deleteSkill(id);
    await _refreshAfterMutation();
  }

  Future<void> _refreshAfterMutation() async {
    final refreshing = _refreshing;
    if (refreshing != null) await refreshing;
    final operation = _refresh();
    _refreshing = operation;
    try {
      await operation;
    } finally {
      if (identical(_refreshing, operation)) _refreshing = null;
    }
  }

  void _requireManageableAgent(String? id) {
    if (!canMutateAgents ||
        (id != null &&
            !(ledger?.agents.any(
                  (agent) => agent.id == id && agent.manageable,
                ) ??
                false))) {
      throw StateError('This Agent is read-only.');
    }
  }

  Future<MoltbookProjection> loadMoltbook(
    String agentId, {
    String? cursor,
    int limit = 20,
  }) {
    final source = repository;
    if (!moltbookAvailable || source is! MoltbookAgentsRepository) {
      throw StateError('Moltbook management is not available here.');
    }
    return (source as MoltbookAgentsRepository).loadMoltbook(
      agentId,
      cursor: cursor,
      limit: limit,
    );
  }

  Future<void> changeMoltbook(String agentId, Json input) {
    final source = repository;
    if (!canManageMoltbook || source is! MoltbookAgentsRepository) {
      throw StateError('Moltbook management is not available here.');
    }
    return (source as MoltbookAgentsRepository).changeMoltbook(agentId, input);
  }

  Future<AgentGovernanceSnapshot> loadGovernance(String agentId) {
    final source = repository;
    if (!canReadGovernance || source is! AgentGovernanceRepository) {
      throw StateError('Agent release and adaptation evidence is unavailable.');
    }
    return (source as AgentGovernanceRepository).loadGovernance(agentId);
  }

  Future<AgentDailyLearningStatus> loadLearning(String agentId) {
    final source = repository;
    if (!canReadLearning || source is! AgentLearningRepository) {
      throw StateError('Daily learning evidence is unavailable here.');
    }
    return (source as AgentLearningRepository).loadLearning(agentId);
  }

  Future<AgentGovernanceSnapshot> manageRelease(
    String agentId,
    AgentGovernanceJson action,
  ) {
    final source = repository;
    if (!canManageGovernance || source is! AgentGovernanceRepository) {
      throw StateError('Agent release changes are unavailable here.');
    }
    return (source as AgentGovernanceRepository).manageRelease(
      agentId,
      action,
      idempotencyKey: _governanceKey(agentId, '${action['action']}'),
    );
  }

  Future<AgentGovernanceSnapshot> manageAdaptation(
    String agentId,
    AgentGovernanceJson action,
  ) {
    final source = repository;
    if (!canManageGovernance || source is! AgentGovernanceRepository) {
      throw StateError('Agent adaptation changes are unavailable here.');
    }
    return (source as AgentGovernanceRepository).manageAdaptation(
      agentId,
      action,
      idempotencyKey: _governanceKey(agentId, 'adaptation-${action['action']}'),
    );
  }

  String _governanceKey(String agentId, String action) =>
      'native-agent-governance-$action-${DateTime.now().microsecondsSinceEpoch}-${agentId.hashCode.abs()}';
}

class AgentsView extends StatefulWidget {
  const AgentsView({
    super.key,
    required this.controller,
    this.liveWork,
    this.onRefreshLiveWork,
  });
  final AgentsController controller;
  final Widget? liveWork;
  final Future<void> Function()? onRefreshLiveWork;
  @override
  State<AgentsView> createState() => _AgentsViewState();
}

class _AgentsViewState extends State<AgentsView>
    with SingleTickerProviderStateMixin {
  late final TabController tabs;
  @override
  void initState() {
    super.initState();
    tabs = TabController(length: widget.liveWork == null ? 3 : 4, vsync: this)
      ..addListener(_onTabChanged);
    if (widget.liveWork == null && widget.controller.ledger == null) {
      widget.controller.refresh();
    }
  }

  @override
  void dispose() {
    tabs.removeListener(_onTabChanged);
    tabs.dispose();
    super.dispose();
  }

  void _onTabChanged() {
    if (!tabs.indexIsChanging && mounted) {
      setState(() {});
      if (!_showingLiveWork &&
          widget.controller.ledger == null &&
          !widget.controller.loading) {
        widget.controller.refresh();
      }
    }
  }

  int get _agentsTab => widget.liveWork == null ? 0 : 1;
  int get _skillsTab => widget.liveWork == null ? 1 : 2;
  bool get _showingLiveWork => widget.liveWork != null && tabs.index == 0;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (_, _) {
      final c = widget.controller;
      return Scaffold(
        appBar: AppBar(
          title: Text(
            tabs.index == 0 && widget.liveWork != null
                ? 'Agent Control'
                : 'Agent arsenal',
          ),
          bottom: TabBar(
            controller: tabs,
            tabs: [
              if (widget.liveWork != null) const Tab(text: 'Live work'),
              const Tab(text: 'Agents'),
              const Tab(text: 'Skills'),
              const Tab(text: 'Performance'),
            ],
          ),
          actions: [
            if ((tabs.index == _agentsTab && c.canMutateAgents) ||
                (tabs.index == _skillsTab && c.canMutateSkills))
              IconButton(
                tooltip: 'Create',
                onPressed: tabs.index == _skillsTab
                    ? (c.canMutateSkills ? _editSkill : null)
                    : (c.canMutateAgents ? _editAgent : null),
                icon: const Icon(Icons.add_rounded),
              ),
            IconButton(
              onPressed: tabs.index == 0 && widget.liveWork != null
                  ? widget.onRefreshLiveWork
                  : c.refresh,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
        ),
        body: !_showingLiveWork && c.loading && c.ledger == null
            ? const _AgentSkeleton()
            : !_showingLiveWork && c.error != null && c.ledger == null
            ? _Retry(onTap: c.refresh)
            : AnimatedSwitcher(
                duration: _motionDuration(context),
                switchInCurve: Curves.easeOutQuart,
                child: TabBarView(
                  key: ValueKey(c.ledger),
                  controller: tabs,
                  children: [
                    if (widget.liveWork != null) widget.liveWork!,
                    _agents(c.ledger?.agents ?? const []),
                    _skills(c.ledger?.skills ?? const []),
                    _performance(c.ledger?.performance ?? const []),
                  ],
                ),
              ),
      );
    },
  );
  Widget _agents(List<AgentProfile> values) => values.isEmpty
      ? const _Empty(icon: Icons.hub_outlined, text: 'No agents configured')
      : LayoutBuilder(
          builder: (context, box) {
            final wide = box.maxWidth >= 760;
            return GridView.builder(
              padding: EdgeInsets.symmetric(
                horizontal: wide ? 32 : 16,
                vertical: 20,
              ),
              gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: wide ? 2 : 1,
                mainAxisExtent: 142,
                crossAxisSpacing: 12,
                mainAxisSpacing: 12,
              ),
              itemCount: values.length,
              itemBuilder: (_, i) {
                final a = values[i];
                return Card(
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: () => _showAgent(a),
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Row(
                        children: [
                          _AgentAvatar(agent: a),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        a.name,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: Theme.of(context)
                                            .textTheme
                                            .titleMedium,
                                      ),
                                    ),
                                    _Status(a.status),
                                  ],
                                ),
                                const SizedBox(height: 3),
                                Text(
                                  a.role,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                                const Spacer(),
                                Wrap(
                                  spacing: 6,
                                  runSpacing: 6,
                                  children: [
                                    _MetaPill(
                                      icon: Icons.model_training_outlined,
                                      label: a.modelPolicy.replaceAll('_', ' '),
                                    ),
                                    _MetaPill(
                                      icon: Icons.shield_outlined,
                                      label: a.autonomy,
                                    ),
                                    _MetaPill(
                                      icon: Icons.bolt_outlined,
                                      label: '${a.skillIds.length} skills',
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                          if (a.manageable && widget.controller.canMutateAgents)
                            PopupMenuButton<String>(
                              onSelected: (v) => v == 'edit'
                                  ? _editAgent(a)
                                  : _confirmDelete(
                                      a.name,
                                      () => widget.controller.removeAgent(a.id),
                                    ),
                              itemBuilder: (_) => [
                                const PopupMenuItem(
                                  value: 'edit',
                                  child: Text('Edit'),
                                ),
                                if (widget.controller.canDeleteAgents)
                                  const PopupMenuItem(
                                    value: 'delete',
                                    child: Text('Delete'),
                                  ),
                              ],
                            ),
                        ],
                      ),
                    ),
                  ),
                );
              },
            );
          },
        );
  Widget _skills(List<AgentSkill> values) => values.isEmpty
      ? const _Empty(
          icon: Icons.auto_awesome_outlined,
          text: 'No skills available',
        )
      : ListView.separated(
          padding: const EdgeInsets.all(16),
          itemCount: values.length,
          separatorBuilder: (_, _) => const Divider(),
          itemBuilder: (_, i) {
            final s = values[i];
            return ListTile(
              leading: const Icon(Icons.bolt_rounded),
              title: Text(s.name),
              subtitle: Text(
                '${s.category} · ${s.toolIds.length} tools\n${s.description}',
                maxLines: 3,
              ),
              isThreeLine: true,
              trailing: !s.manageable || !widget.controller.canMutateSkills
                  ? _Status(s.status)
                  : PopupMenuButton<String>(
                      onSelected: (v) => v == 'edit'
                          ? _editSkill(s)
                          : _confirmDelete(
                              s.name,
                              () => widget.controller.removeSkill(s.id),
                            ),
                      itemBuilder: (_) => const [
                        PopupMenuItem(value: 'edit', child: Text('Edit')),
                        PopupMenuItem(value: 'delete', child: Text('Delete')),
                      ],
                    ),
            );
          },
        );
  Widget _performance(List<AgentPerformance> values) => values.isEmpty
      ? const _Empty(
          icon: Icons.query_stats_rounded,
          text: 'Performance appears after the first run',
        )
      : ListView.builder(
          padding: const EdgeInsets.all(16),
          itemCount: values.length,
          itemBuilder: (_, i) {
            final p = values[i];
            final rate = p.successRate > 1
                ? p.successRate / 100
                : p.successRate;
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          p.name,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      ),
                      Text('${(rate * 100).round()}% success'),
                    ],
                  ),
                  const SizedBox(height: 8),
                  LinearProgressIndicator(value: rate.clamp(0, 1)),
                  const SizedBox(height: 8),
                  Text(
                    '${p.runs} runs · ${p.averageLatencyMs} ms avg · ${p.memoriesFormed} memories formed',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            );
          },
        );
  Future<void> _showAgent(AgentProfile a) => showModalBottomSheet(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 32),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(a.name, style: Theme.of(context).textTheme.headlineSmall),
            Text(a.role),
            const SizedBox(height: 20),
            Text(a.description),
            const SizedBox(height: 16),
            Text('Policy', style: Theme.of(context).textTheme.titleMedium),
            Text(
              '${a.modelPolicy} · ${a.autonomy} · ${a.approvalPolicy} approvals · ${a.memoryScope} memory',
            ),
            const SizedBox(height: 16),
            Text(
              'Instructions',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            Text(a.instructions),
            const SizedBox(height: 16),
            Wrap(
              spacing: 8,
              children: a.skillIds.map((s) => Chip(label: Text(s))).toList(),
            ),
            const SizedBox(height: 20),
            Text(
              'Release & learning',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 9),
            AgentGovernanceView(
              agentId: a.id,
              builtIn: a.builtIn,
              canRead: widget.controller.canReadGovernance,
              canManage: widget.controller.canManageGovernance,
              load: () => widget.controller.loadGovernance(a.id),
              manageRelease: (action) =>
                  widget.controller.manageRelease(a.id, action),
              manageAdaptation: (action) =>
                  widget.controller.manageAdaptation(a.id, action),
            ),
          ],
        ),
      ),
    ),
  );
  Future<void> _editAgent([AgentProfile? a]) async {
    if (a != null && !a.manageable) return;
    final result = await showDialog<Json>(
      context: context,
      builder: (_) => _AgentDialog(
        agent: a,
        skills: widget.controller.ledger?.skills ?? const [],
      ),
    );
    if (result != null) {
      await _run(() => widget.controller.saveAgent(result, id: a?.id));
    }
  }

  Future<void> _editSkill([AgentSkill? s]) async {
    final result = await showDialog<Json>(
      context: context,
      builder: (_) => _SkillDialog(skill: s),
    );
    if (result != null) {
      await _run(() => widget.controller.saveSkill(result, id: s?.id));
    }
  }

  Future<void> _confirmDelete(
    String name,
    Future<void> Function() action,
  ) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text('Delete $name?'),
        content: const Text('This cannot be undone.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (yes == true) await _run(action);
  }

  Future<void> _run(Future<void> Function() action) async {
    try {
      await action();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }
}

Duration _motionDuration(BuildContext context) =>
    MediaQuery.maybeOf(context)?.disableAnimations == true
    ? Duration.zero
    : const Duration(milliseconds: 190);

class _AgentAvatar extends StatelessWidget {
  const _AgentAvatar({required this.agent});
  final AgentProfile agent;
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: 46,
      height: 46,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: scheme.primaryContainer,
        borderRadius: BorderRadius.circular(13),
      ),
      child: Text(
        agent.name.characters.first.toUpperCase(),
        style: TextStyle(
          color: scheme.onPrimaryContainer,
          fontWeight: FontWeight.w800,
          fontSize: 17,
        ),
      ),
    );
  }
}

class _MetaPill extends StatelessWidget {
  const _MetaPill({required this.icon, required this.label});
  final IconData icon;
  final String label;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(8),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 13),
        const SizedBox(width: 4),
        Text(label, style: Theme.of(context).textTheme.labelSmall),
      ],
    ),
  );
}

class _AgentSkeleton extends StatelessWidget {
  const _AgentSkeleton();
  @override
  Widget build(BuildContext context) => ListView.builder(
    padding: const EdgeInsets.all(20),
    itemCount: 5,
    itemBuilder: (_, i) => Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Container(
        height: 116,
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHighest
              .withValues(alpha: .55),
          borderRadius: BorderRadius.circular(14),
        ),
      ),
    ),
  );
}

class _AgentDialog extends StatefulWidget {
  const _AgentDialog({this.agent, required this.skills});
  final AgentProfile? agent;
  final List<AgentSkill> skills;
  @override
  State<_AgentDialog> createState() => _AgentDialogState();
}

class _AgentDialogState extends State<_AgentDialog> {
  late final name = TextEditingController(text: widget.agent?.name);
  late final role = TextEditingController(text: widget.agent?.role);
  late final description = TextEditingController(
    text: widget.agent?.description,
  );
  late final instructions = TextEditingController(
    text: widget.agent?.instructions,
  );
  late final toolIds = TextEditingController(
    text: widget.agent?.toolIds.join(', '),
  );
  late final List<AgentSkill> selectableSkills;
  late Set<String> selected;
  String model = 'auto',
      autonomy = 'assist',
      approval = 'risk_based',
      memory = 'all',
      accent = 'emerald',
      status = 'ready';
  @override
  void initState() {
    super.initState();
    selectableSkills = widget.skills
        .where((skill) => skill.selectable)
        .toList(growable: false);
    selected = filterSelectableSkillIds(
      selectableSkills,
      widget.agent?.skillIds ?? const <String>[],
    );
    final a = widget.agent;
    if (a != null) {
      model = a.modelPolicy;
      autonomy = a.autonomy;
      approval = a.approvalPolicy;
      memory = a.memoryScope;
      accent = a.accent;
      status = a.status;
    }
  }

  @override
  void dispose() {
    name.dispose();
    role.dispose();
    description.dispose();
    instructions.dispose();
    toolIds.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.agent == null ? 'New agent' : 'Edit agent'),
    content: SizedBox(
      width: 560,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: name,
              decoration: const InputDecoration(labelText: 'Name'),
            ),
            TextField(
              controller: role,
              decoration: const InputDecoration(labelText: 'Role'),
            ),
            TextField(
              controller: description,
              maxLines: 2,
              decoration: const InputDecoration(labelText: 'Description'),
            ),
            TextField(
              controller: instructions,
              maxLines: 4,
              decoration: const InputDecoration(
                labelText: 'Operating instructions',
              ),
            ),
            TextField(
              controller: toolIds,
              decoration: const InputDecoration(
                labelText: 'Direct tool IDs, comma separated',
              ),
            ),
            _drop('Model', model, const [
              'auto',
              'openai_fast',
              'openai_reasoning',
              'gemini_fast',
              'anthropic_fast',
              'anthropic_reasoning',
            ], (v) => setState(() => model = v)),
            _drop('Autonomy', autonomy, const [
              'assist',
              'governed',
              'execute',
            ], (v) => setState(() => autonomy = v)),
            _drop('Approvals', approval, const [
              'always',
              'risk_based',
              'read_only',
            ], (v) => setState(() => approval = v)),
            _drop('Memory', memory, const [
              'session',
              'project',
              'all',
            ], (v) => setState(() => memory = v)),
            const Align(
              alignment: Alignment.centerLeft,
              child: Padding(
                padding: EdgeInsets.only(top: 12),
                child: Text('Assigned skills'),
              ),
            ),
            Align(
              alignment: Alignment.centerLeft,
              child: Text(
                '${selected.length}/$maxAssignedAgentSkills selected',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
            ...selectableSkills.map(
              (s) => CheckboxListTile(
                dense: true,
                value: selected.contains(s.id),
                title: Text(s.name),
                onChanged: canSelectAgentSkill(selected, s.id)
                    ? (v) => setState(
                        () => v == true
                            ? selected.add(s.id)
                            : selected.remove(s.id),
                      )
                    : null,
              ),
            ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: selected.length > maxAssignedAgentSkills
            ? null
            : () {
                if (name.text.trim().isEmpty ||
                    role.text.trim().isEmpty ||
                    description.text.trim().length < 2 ||
                    instructions.text.trim().length < 10) {
                  return;
                }
                Navigator.pop(context, {
                  'name': name.text.trim(),
                  'role': role.text.trim(),
                  'description': description.text.trim(),
                  'instructions': instructions.text.trim(),
                  'status': status,
                  'accent': accent,
                  'modelPolicy': model,
                  'autonomy': autonomy,
                  'approvalPolicy': approval,
                  'memoryScope': memory,
                  'skillIds': selected.toList(),
                  'toolIds': _splitCsv(toolIds.text),
                });
              },
        child: const Text('Save'),
      ),
    ],
  );
  Widget _drop(
    String label,
    String value,
    List<String> values,
    ValueChanged<String> onChanged,
  ) => DropdownButtonFormField<String>(
    initialValue: value,
    decoration: InputDecoration(labelText: label),
    items: values
        .map(
          (v) =>
              DropdownMenuItem(value: v, child: Text(v.replaceAll('_', ' '))),
        )
        .toList(),
    onChanged: (v) => onChanged(v!),
  );
}

class _SkillDialog extends StatefulWidget {
  const _SkillDialog({this.skill});
  final AgentSkill? skill;
  @override
  State<_SkillDialog> createState() => _SkillDialogState();
}

class _SkillDialogState extends State<_SkillDialog> {
  late final name = TextEditingController(text: widget.skill?.name);
  late final description = TextEditingController(
    text: widget.skill?.description,
  );
  late final instructions = TextEditingController(
    text: widget.skill?.instructions,
  );
  late final tools = TextEditingController(
    text: widget.skill?.toolIds.join(', '),
  );
  late final tags = TextEditingController(text: widget.skill?.tags.join(', '));
  String category = 'personal', status = 'active';
  @override
  void initState() {
    super.initState();
    category = widget.skill?.category ?? 'personal';
    status = widget.skill?.status ?? 'active';
  }

  List<String> split(String v) =>
      v.split(',').map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.skill == null ? 'New skill' : 'Edit skill'),
    content: SizedBox(
      width: 520,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: name,
              decoration: const InputDecoration(labelText: 'Name'),
            ),
            TextField(
              controller: description,
              maxLines: 2,
              decoration: const InputDecoration(labelText: 'Description'),
            ),
            TextField(
              controller: instructions,
              maxLines: 5,
              decoration: const InputDecoration(labelText: 'Instructions'),
            ),
            DropdownButtonFormField<String>(
              initialValue: category,
              decoration: const InputDecoration(labelText: 'Category'),
              items: const [
                'research',
                'creation',
                'analysis',
                'memory',
                'automation',
                'personal',
              ].map((v) => DropdownMenuItem(value: v, child: Text(v))).toList(),
              onChanged: (v) => setState(() => category = v!),
            ),
            TextField(
              controller: tools,
              decoration: const InputDecoration(
                labelText: 'Tool IDs, comma separated',
              ),
            ),
            TextField(
              controller: tags,
              decoration: const InputDecoration(
                labelText: 'Tags, comma separated',
              ),
            ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: () {
          if (name.text.trim().isEmpty ||
              instructions.text.trim().length < 10) {
            return;
          }
          Navigator.pop(context, {
            'name': name.text.trim(),
            'description': description.text.trim(),
            'instructions': instructions.text.trim(),
            'category': category,
            'status': status,
            'toolIds': split(tools.text),
            'tags': split(tags.text),
            'knowledgeTags': <String>[],
          });
        },
        child: const Text('Save'),
      ),
    ],
  );
}

class _Status extends StatelessWidget {
  const _Status(this.value);
  final String value;
  @override
  Widget build(BuildContext context) => Chip(
    label: Text(value == 'learning' ? 'observing' : value),
    visualDensity: VisualDensity.compact,
  );
}

class _Empty extends StatelessWidget {
  const _Empty({required this.icon, required this.text});
  final IconData icon;
  final String text;
  @override
  Widget build(BuildContext context) => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [Icon(icon, size: 42), const SizedBox(height: 12), Text(text)],
    ),
  );
}

class _Retry extends StatelessWidget {
  const _Retry({required this.onTap});
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Center(
    child: FilledButton.tonal(
      onPressed: onTap,
      child: const Text('Reconnect agent arsenal'),
    ),
  );
}
