import 'package:flutter/foundation.dart';

import 'agents.dart';

const agentCouncilProjectionVersion = 'p11.5-agent-council-map:1';

/// Read-only projection of canonical delegated Agent work.
///
/// This model deliberately mirrors the server projection instead of deriving
/// state from the editable Agent roster. Unknown or missing evidence remains
/// unknown, and never becomes a reassuring zero in the desktop UI.
@immutable
class AgentCouncilProjection {
  const AgentCouncilProjection({
    required this.version,
    required this.authority,
    required this.generatedAt,
    required this.state,
    required this.summary,
    required this.executions,
  });

  final String version, authority, generatedAt, state;
  final AgentCouncilSummary summary;
  final List<AgentCouncilExecution> executions;

  factory AgentCouncilProjection.fromJson(Json value) {
    final version = _string(value, 'version');
    if (version != agentCouncilProjectionVersion) {
      throw const FormatException(
        'The Agent Council projection version is not supported.',
      );
    }
    final authority = _string(value, 'authority');
    if (authority != 'canonical_delegation_ledger') {
      throw const FormatException('The Agent Council authority is invalid.');
    }
    final state = _string(value, 'state');
    if (!const {'ready', 'empty', 'unavailable'}.contains(state)) {
      throw const FormatException('The Agent Council state is invalid.');
    }
    return AgentCouncilProjection(
      version: version,
      authority: authority,
      generatedAt: _timestamp(value, 'generatedAt'),
      state: state,
      summary: AgentCouncilSummary.fromJson(_object(value, 'summary')),
      executions: _objects(
        value,
        'executions',
      ).map(AgentCouncilExecution.fromJson).toList(growable: false),
    );
  }
}

@immutable
class AgentCouncilSummary {
  const AgentCouncilSummary({
    required this.executionCount,
    required this.memberCount,
    required this.activeMemberCount,
    required this.waitingMemberCount,
    required this.acceptedMemberCount,
    required this.knownEstimatedCostMicrousd,
  });

  final int executionCount,
      memberCount,
      activeMemberCount,
      waitingMemberCount,
      acceptedMemberCount,
      knownEstimatedCostMicrousd;

  factory AgentCouncilSummary.fromJson(Json value) => AgentCouncilSummary(
    executionCount: _integer(value, 'executionCount'),
    memberCount: _integer(value, 'memberCount'),
    activeMemberCount: _integer(value, 'activeMemberCount'),
    waitingMemberCount: _integer(value, 'waitingMemberCount'),
    acceptedMemberCount: _integer(value, 'acceptedMemberCount'),
    knownEstimatedCostMicrousd: _integer(value, 'knownEstimatedCostMicrousd'),
  );
}

@immutable
class AgentCouncilExecution {
  const AgentCouncilExecution({
    required this.parentExecutionId,
    required this.href,
    required this.status,
    required this.currentWork,
    required this.startedAt,
    required this.updatedAt,
    required this.members,
    required this.verifierCost,
  });

  final String parentExecutionId,
      href,
      status,
      currentWork,
      startedAt,
      updatedAt;
  final List<AgentCouncilMember> members;
  final AgentCouncilCost verifierCost;

  factory AgentCouncilExecution.fromJson(Json value) => AgentCouncilExecution(
    parentExecutionId: _string(value, 'parentExecutionId'),
    href: _string(value, 'href'),
    status: _string(value, 'status'),
    currentWork: _string(value, 'currentWork'),
    startedAt: _timestamp(value, 'startedAt'),
    updatedAt: _timestamp(value, 'updatedAt'),
    members: _objects(
      value,
      'members',
    ).map(AgentCouncilMember.fromJson).toList(growable: false),
    verifierCost: AgentCouncilCost.fromJson(_object(value, 'verifierCost')),
  );
}

@immutable
class AgentCouncilMember {
  const AgentCouncilMember({
    required this.taskId,
    required this.delegationId,
    required this.identity,
    required this.state,
    required this.lifecycleRevision,
    required this.currentWork,
    required this.updatedAt,
    required this.authority,
    required this.messages,
    required this.outputs,
    required this.cost,
    required this.confidence,
    required this.verifier,
  });

  final String taskId, delegationId, state, currentWork, updatedAt;
  final int lifecycleRevision;
  final AgentCouncilIdentity identity;
  final AgentCouncilAuthority authority;
  final AgentCouncilMessages messages;
  final AgentCouncilOutputs outputs;
  final AgentCouncilCost cost;
  final double? confidence;
  final AgentCouncilVerifier verifier;

  factory AgentCouncilMember.fromJson(Json value) => AgentCouncilMember(
    taskId: _string(value, 'taskId'),
    delegationId: _string(value, 'delegationId'),
    identity: AgentCouncilIdentity.fromJson(_object(value, 'identity')),
    state: _string(value, 'state'),
    lifecycleRevision: _integer(value, 'lifecycleRevision'),
    currentWork: _string(value, 'currentWork'),
    updatedAt: _timestamp(value, 'updatedAt'),
    authority: AgentCouncilAuthority.fromJson(_object(value, 'authority')),
    messages: AgentCouncilMessages.fromJson(_object(value, 'messages')),
    outputs: AgentCouncilOutputs.fromJson(_object(value, 'outputs')),
    cost: AgentCouncilCost.fromJson(_object(value, 'cost')),
    confidence: _nullableDouble(value, 'confidence'),
    verifier: AgentCouncilVerifier.fromJson(_object(value, 'verifier')),
  );
}

@immutable
class AgentCouncilIdentity {
  const AgentCouncilIdentity({
    required this.agentId,
    required this.name,
    required this.role,
    required this.charter,
    required this.visualIdentity,
    required this.definitionVersion,
    required this.source,
  });

  final String agentId, name, role, charter, visualIdentity, source;
  final int definitionVersion;

  factory AgentCouncilIdentity.fromJson(Json value) => AgentCouncilIdentity(
    agentId: _string(value, 'agentId'),
    name: _string(value, 'name'),
    role: _string(value, 'role'),
    charter: _string(value, 'charter'),
    visualIdentity: _string(value, 'visualIdentity'),
    definitionVersion: _integer(value, 'definitionVersion'),
    source: _string(value, 'source'),
  );
}

@immutable
class AgentCouncilAuthority {
  const AgentCouncilAuthority({
    required this.source,
    required this.receiptSha256,
    required this.contractSha256,
    required this.purpose,
    required this.workspaceId,
    required this.projectId,
    required this.missionId,
    required this.contextState,
    required this.contextGrantCount,
    required this.capabilityState,
    required this.capabilityGrantCount,
    required this.toolState,
    required this.toolIds,
    required this.budgets,
  });

  final String source,
      contractSha256,
      purpose,
      contextState,
      capabilityState,
      toolState;
  final String? receiptSha256, workspaceId, projectId, missionId;
  final int contextGrantCount, capabilityGrantCount;
  final List<String> toolIds;
  final AgentCouncilBudgets budgets;

  factory AgentCouncilAuthority.fromJson(Json value) {
    final scope = _object(value, 'scope');
    final context = _object(value, 'context');
    final capabilities = _object(value, 'capabilities');
    final tools = _object(value, 'tools');
    return AgentCouncilAuthority(
      source: _string(value, 'source'),
      receiptSha256: _nullableString(value, 'receiptSha256'),
      contractSha256: _string(value, 'contractSha256'),
      purpose: _string(value, 'purpose'),
      workspaceId: _nullableString(scope, 'workspaceId'),
      projectId: _nullableString(scope, 'projectId'),
      missionId: _nullableString(scope, 'missionId'),
      contextState: _string(context, 'state'),
      contextGrantCount: _integer(context, 'grantCount'),
      capabilityState: _string(capabilities, 'state'),
      capabilityGrantCount: _integer(capabilities, 'grantCount'),
      toolState: _string(tools, 'state'),
      toolIds: _strings(tools, 'ids'),
      budgets: AgentCouncilBudgets.fromJson(_object(value, 'budgets')),
    );
  }
}

@immutable
class AgentCouncilBudgets {
  const AgentCouncilBudgets({
    required this.modelTurns,
    required this.tokens,
    required this.costMicrousd,
    required this.wallTimeMs,
    required this.toolCalls,
    required this.browserActions,
  });

  final int? modelTurns,
      tokens,
      costMicrousd,
      wallTimeMs,
      toolCalls,
      browserActions;

  factory AgentCouncilBudgets.fromJson(Json value) => AgentCouncilBudgets(
    modelTurns: _nullableInteger(value, 'modelTurns'),
    tokens: _nullableInteger(value, 'tokens'),
    costMicrousd: _nullableInteger(value, 'costMicrousd'),
    wallTimeMs: _nullableInteger(value, 'wallTimeMs'),
    toolCalls: _nullableInteger(value, 'toolCalls'),
    browserActions: _nullableInteger(value, 'browserActions'),
  );
}

@immutable
class AgentCouncilMessages {
  const AgentCouncilMessages({required this.state, required this.items});

  final String state;
  final List<AgentCouncilMessage> items;

  factory AgentCouncilMessages.fromJson(Json value) => AgentCouncilMessages(
    state: _string(value, 'state'),
    items: _objects(
      value,
      'items',
    ).map(AgentCouncilMessage.fromJson).toList(growable: false),
  );
}

@immutable
class AgentCouncilMessage {
  const AgentCouncilMessage({
    required this.messageId,
    required this.kind,
    required this.body,
    required this.direction,
    required this.createdAt,
    required this.trust,
  });

  final String messageId, kind, body, direction, createdAt, trust;

  factory AgentCouncilMessage.fromJson(Json value) => AgentCouncilMessage(
    messageId: _string(value, 'messageId'),
    kind: _string(value, 'kind'),
    body: _string(value, 'body'),
    direction: _string(value, 'direction'),
    createdAt: _timestamp(value, 'createdAt'),
    trust: _string(value, 'trust'),
  );
}

@immutable
class AgentCouncilOutputs {
  const AgentCouncilOutputs({
    required this.state,
    required this.items,
    required this.proposalReceiptSha256,
  });

  final String state;
  final List<AgentCouncilOutput> items;
  final String? proposalReceiptSha256;

  factory AgentCouncilOutputs.fromJson(Json value) => AgentCouncilOutputs(
    state: _string(value, 'state'),
    items: _objects(
      value,
      'items',
    ).map(AgentCouncilOutput.fromJson).toList(growable: false),
    proposalReceiptSha256: _nullableString(value, 'proposalReceiptSha256'),
  );
}

@immutable
class AgentCouncilOutput {
  const AgentCouncilOutput({
    required this.artifactId,
    required this.title,
    required this.kind,
    required this.mediaType,
    required this.content,
    required this.createdAt,
    required this.trust,
  });

  final String artifactId, title, kind, mediaType, content, createdAt, trust;

  factory AgentCouncilOutput.fromJson(Json value) => AgentCouncilOutput(
    artifactId: _string(value, 'artifactId'),
    title: _string(value, 'title'),
    kind: _string(value, 'kind'),
    mediaType: _string(value, 'mediaType'),
    content: _string(value, 'content', allowEmpty: true),
    createdAt: _timestamp(value, 'createdAt'),
    trust: _string(value, 'trust'),
  );
}

@immutable
class AgentCouncilCost {
  const AgentCouncilCost({
    required this.authority,
    required this.state,
    required this.receiptCount,
    required this.unknownCostReceiptCount,
    required this.totalTokens,
    required this.knownEstimatedCostMicrousd,
  });

  final String authority, state;
  final int receiptCount,
      unknownCostReceiptCount,
      totalTokens,
      knownEstimatedCostMicrousd;

  factory AgentCouncilCost.fromJson(Json value) => AgentCouncilCost(
    authority: _string(value, 'authority'),
    state: _string(value, 'state'),
    receiptCount: _integer(value, 'receiptCount'),
    unknownCostReceiptCount: _integer(value, 'unknownCostReceiptCount'),
    totalTokens: _integer(value, 'totalTokens'),
    knownEstimatedCostMicrousd: _integer(value, 'knownEstimatedCostMicrousd'),
  );
}

@immutable
class AgentCouncilVerifier {
  const AgentCouncilVerifier({
    required this.identity,
    required this.acceptanceThreshold,
    required this.method,
    required this.verdict,
    required this.score,
  });

  final AgentCouncilIdentity identity;
  final double acceptanceThreshold;
  final String method, verdict;
  final double? score;

  factory AgentCouncilVerifier.fromJson(Json value) => AgentCouncilVerifier(
    identity: AgentCouncilIdentity.fromJson(_object(value, 'identity')),
    acceptanceThreshold: _double(value, 'acceptanceThreshold'),
    method: _string(value, 'method'),
    verdict: _string(value, 'verdict'),
    score: _nullableDouble(value, 'score'),
  );
}

abstract interface class AgentCouncilRepository {
  Future<AgentCouncilProjection> load({int limit = 60});
}

class AgentCouncilController extends ChangeNotifier {
  AgentCouncilController(this.repository);

  final AgentCouncilRepository repository;
  AgentCouncilProjection? projection;
  bool loading = false;
  Object? error;
  Future<void>? _refreshInFlight;

  Future<void> refresh() {
    final existing = _refreshInFlight;
    if (existing != null) return existing;
    final operation = _refresh();
    _refreshInFlight = operation;
    return operation.whenComplete(() {
      if (identical(_refreshInFlight, operation)) _refreshInFlight = null;
    });
  }

  Future<void> _refresh() async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      projection = await repository.load();
    } catch (caught) {
      error = caught;
    } finally {
      loading = false;
      notifyListeners();
    }
  }
}

Json _object(Json source, String key) {
  final value = source[key];
  if (value is! Map) {
    throw FormatException('Agent Council field $key must be an object.');
  }
  return Map<String, dynamic>.from(value);
}

List<Json> _objects(Json source, String key) {
  final value = source[key];
  if (value is! List || value.any((item) => item is! Map)) {
    throw FormatException(
      'Agent Council field $key must be a list of objects.',
    );
  }
  return value
      .cast<Map>()
      .map((item) => Map<String, dynamic>.from(item))
      .toList(growable: false);
}

String _string(Json source, String key, {bool allowEmpty = false}) {
  final value = source[key];
  if (value is! String || (!allowEmpty && value.trim().isEmpty)) {
    throw FormatException('Agent Council field $key must be a string.');
  }
  return value;
}

String? _nullableString(Json source, String key) {
  final value = source[key];
  if (value == null) return null;
  if (value is! String || value.trim().isEmpty) {
    throw FormatException('Agent Council field $key must be null or a string.');
  }
  return value;
}

String _timestamp(Json source, String key) {
  final value = _string(source, key);
  if (DateTime.tryParse(value) == null) {
    throw FormatException('Agent Council field $key must be a timestamp.');
  }
  return value;
}

int _integer(Json source, String key) {
  final value = source[key];
  if (value is! num || value.toInt() != value || value < 0) {
    throw FormatException(
      'Agent Council field $key must be a non-negative integer.',
    );
  }
  return value.toInt();
}

int? _nullableInteger(Json source, String key) =>
    source[key] == null ? null : _integer(source, key);

double _double(Json source, String key) {
  final value = source[key];
  if (value is! num || !value.isFinite) {
    throw FormatException('Agent Council field $key must be a number.');
  }
  return value.toDouble();
}

double? _nullableDouble(Json source, String key) =>
    source[key] == null ? null : _double(source, key);

List<String> _strings(Json source, String key) {
  final value = source[key];
  if (value is! List || value.any((item) => item is! String)) {
    throw FormatException(
      'Agent Council field $key must be a list of strings.',
    );
  }
  return value.cast<String>().toList(growable: false);
}
