import 'package:flutter/foundation.dart';

typedef AgentCouncilJson = Map<String, dynamic>;

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

  factory AgentCouncilProjection.fromJson(AgentCouncilJson value) {
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

  AgentCouncilProjection withCanceledTask(AgentCouncilCancellation result) {
    var activeDelta = 0;
    var waitingDelta = 0;
    final nextExecutions = executions
        .map((execution) {
          var changed = false;
          final nextMembers = execution.members
              .map((member) {
                if (member.taskId != result.executionId) return member;
                changed = true;
                if (const {
                  'proposed',
                  'accepted',
                  'working',
                  'waiting',
                  'challenged',
                  'completed_proposed',
                }.contains(member.state)) {
                  activeDelta = -1;
                }
                if (member.state == 'waiting') waitingDelta = -1;
                return member.canceled(result);
              })
              .toList(growable: false);
          return changed
              ? AgentCouncilExecution(
                  parentExecutionId: execution.parentExecutionId,
                  href: execution.href,
                  status: execution.status,
                  currentWork: execution.currentWork,
                  startedAt: execution.startedAt,
                  updatedAt: result.updatedAt,
                  members: nextMembers,
                  verifierCost: execution.verifierCost,
                )
              : execution;
        })
        .toList(growable: false);
    return AgentCouncilProjection(
      version: version,
      authority: authority,
      generatedAt: result.updatedAt,
      state: state,
      summary: AgentCouncilSummary(
        executionCount: summary.executionCount,
        memberCount: summary.memberCount,
        activeMemberCount: (summary.activeMemberCount + activeDelta)
            .clamp(0, summary.memberCount)
            .toInt(),
        waitingMemberCount: (summary.waitingMemberCount + waitingDelta)
            .clamp(0, summary.memberCount)
            .toInt(),
        acceptedMemberCount: summary.acceptedMemberCount,
        knownEstimatedCostMicrousd: summary.knownEstimatedCostMicrousd,
      ),
      executions: nextExecutions,
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

  factory AgentCouncilSummary.fromJson(AgentCouncilJson value) =>
      AgentCouncilSummary(
        executionCount: _integer(value, 'executionCount'),
        memberCount: _integer(value, 'memberCount'),
        activeMemberCount: _integer(value, 'activeMemberCount'),
        waitingMemberCount: _integer(value, 'waitingMemberCount'),
        acceptedMemberCount: _integer(value, 'acceptedMemberCount'),
        knownEstimatedCostMicrousd: _integer(
          value,
          'knownEstimatedCostMicrousd',
        ),
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

  factory AgentCouncilExecution.fromJson(AgentCouncilJson value) =>
      AgentCouncilExecution(
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
    required this.canCancel,
    required this.runtime,
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
  final bool canCancel;
  final AgentCouncilRuntime? runtime;
  final AgentCouncilIdentity identity;
  final AgentCouncilAuthority authority;
  final AgentCouncilMessages messages;
  final AgentCouncilOutputs outputs;
  final AgentCouncilCost cost;
  final double? confidence;
  final AgentCouncilVerifier verifier;

  factory AgentCouncilMember.fromJson(AgentCouncilJson value) =>
      AgentCouncilMember(
        taskId: _string(value, 'taskId'),
        delegationId: _string(value, 'delegationId'),
        identity: AgentCouncilIdentity.fromJson(_object(value, 'identity')),
        state: _string(value, 'state'),
        lifecycleRevision: _integer(value, 'lifecycleRevision'),
        canCancel: value['canCancel'] == true,
        runtime: _nullableObject(value, 'runtime') == null
            ? null
            : AgentCouncilRuntime.fromJson(_nullableObject(value, 'runtime')!),
        currentWork: _string(value, 'currentWork'),
        updatedAt: _timestamp(value, 'updatedAt'),
        authority: AgentCouncilAuthority.fromJson(_object(value, 'authority')),
        messages: AgentCouncilMessages.fromJson(_object(value, 'messages')),
        outputs: AgentCouncilOutputs.fromJson(_object(value, 'outputs')),
        cost: AgentCouncilCost.fromJson(_object(value, 'cost')),
        confidence: _nullableDouble(value, 'confidence'),
        verifier: AgentCouncilVerifier.fromJson(_object(value, 'verifier')),
      );

  AgentCouncilMember canceled(AgentCouncilCancellation result) =>
      AgentCouncilMember(
        taskId: taskId,
        delegationId: delegationId,
        identity: identity,
        state: 'canceled',
        lifecycleRevision: result.lifecycleRevision,
        canCancel: false,
        runtime: runtime,
        currentWork: currentWork,
        updatedAt: result.updatedAt,
        authority: authority,
        messages: messages,
        outputs: outputs,
        cost: cost,
        confidence: confidence,
        verifier: verifier,
      );
}

@immutable
class AgentCouncilRuntime {
  const AgentCouncilRuntime({
    required this.providerId,
    required this.modelId,
    required this.modelTier,
  });

  final String providerId, modelId, modelTier;

  factory AgentCouncilRuntime.fromJson(AgentCouncilJson value) {
    final tier = _string(value, 'modelTier');
    if (!const {'fast', 'reasoning'}.contains(tier)) {
      throw const FormatException('The Agent Council model tier is invalid.');
    }
    return AgentCouncilRuntime(
      providerId: _string(value, 'providerId'),
      modelId: _string(value, 'modelId'),
      modelTier: tier,
    );
  }
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

  factory AgentCouncilIdentity.fromJson(AgentCouncilJson value) =>
      AgentCouncilIdentity(
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

  factory AgentCouncilAuthority.fromJson(AgentCouncilJson value) {
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

  factory AgentCouncilBudgets.fromJson(AgentCouncilJson value) =>
      AgentCouncilBudgets(
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

  factory AgentCouncilMessages.fromJson(AgentCouncilJson value) =>
      AgentCouncilMessages(
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

  factory AgentCouncilMessage.fromJson(AgentCouncilJson value) =>
      AgentCouncilMessage(
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

  factory AgentCouncilOutputs.fromJson(AgentCouncilJson value) =>
      AgentCouncilOutputs(
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

  factory AgentCouncilOutput.fromJson(AgentCouncilJson value) =>
      AgentCouncilOutput(
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

  factory AgentCouncilCost.fromJson(AgentCouncilJson value) => AgentCouncilCost(
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
    required this.runtime,
    required this.acceptanceThreshold,
    required this.method,
    required this.verdict,
    required this.score,
  });

  final AgentCouncilIdentity identity;
  final AgentCouncilRuntime? runtime;
  final double acceptanceThreshold;
  final String method, verdict;
  final double? score;

  factory AgentCouncilVerifier.fromJson(AgentCouncilJson value) =>
      AgentCouncilVerifier(
        identity: AgentCouncilIdentity.fromJson(_object(value, 'identity')),
        runtime: _nullableObject(value, 'runtime') == null
            ? null
            : AgentCouncilRuntime.fromJson(_nullableObject(value, 'runtime')!),
        acceptanceThreshold: _double(value, 'acceptanceThreshold'),
        method: _string(value, 'method'),
        verdict: _string(value, 'verdict'),
        score: _nullableDouble(value, 'score'),
      );
}

abstract interface class AgentCouncilRepository {
  Future<AgentCouncilProjection> load({int limit = 60});
}

abstract interface class AgentCouncilControlRepository {
  Future<AgentCouncilCancellation> cancel({
    required String executionId,
    required int expectedRevision,
    required String reason,
    required String idempotencyKey,
  });
}

abstract interface class AgentCouncilDetailRepository {
  Future<AgentTaskDetail> loadTaskDetail(String executionId);
}

@immutable
class AgentTaskDetail {
  const AgentTaskDetail({
    required this.executionId,
    required this.authority,
    required this.grantsImmutable,
    required this.allowedActions,
  });

  final String executionId;
  final AgentTaskAuthority authority;
  final bool grantsImmutable;
  final List<String> allowedActions;

  factory AgentTaskDetail.fromJson(AgentCouncilJson value) {
    final task = _object(value, 'task');
    _rejectPrivateTaskFields(task);
    final controls = _object(task, 'controls');
    final actions = _strings(controls, 'allowedActions');
    if (controls['grantsImmutable'] != true ||
        actions.any((action) => action != 'cancel')) {
      throw const FormatException(
        'The delegated task exposed an unsupported authority control.',
      );
    }
    return AgentTaskDetail(
      executionId: _string(task, 'executionId'),
      authority: AgentTaskAuthority.fromJson(_object(task, 'authority')),
      grantsImmutable: true,
      allowedActions: actions,
    );
  }
}

@immutable
class AgentTaskAuthority {
  const AgentTaskAuthority({
    required this.contractSha256,
    required this.grantRequestSha256,
    required this.validation,
    required this.nativeReadTools,
    required this.skills,
    required this.plugins,
    required this.mcpServers,
  });

  final String contractSha256, grantRequestSha256;
  final AgentTaskGrantValidation validation;
  final List<AgentTaskNativeReadGrant> nativeReadTools;
  final List<AgentTaskSkillGrant> skills;
  final List<AgentTaskPluginGrant> plugins;
  final List<AgentTaskMcpGrant> mcpServers;

  factory AgentTaskAuthority.fromJson(AgentCouncilJson value) {
    if (value['immutable'] != true) {
      throw const FormatException('Delegated task grants must be immutable.');
    }
    return AgentTaskAuthority(
      contractSha256: _sha256(value, 'contractSha256'),
      grantRequestSha256: _sha256(value, 'grantRequestSha256'),
      validation: AgentTaskGrantValidation.fromJson(
        _object(value, 'validation'),
      ),
      nativeReadTools: _objects(
        value,
        'nativeReadTools',
      ).map(AgentTaskNativeReadGrant.fromJson).toList(growable: false),
      skills: _objects(
        value,
        'skills',
      ).map(AgentTaskSkillGrant.fromJson).toList(growable: false),
      plugins: _objects(
        value,
        'plugins',
      ).map(AgentTaskPluginGrant.fromJson).toList(growable: false),
      mcpServers: _objects(
        value,
        'mcpServers',
      ).map(AgentTaskMcpGrant.fromJson).toList(growable: false),
    );
  }
}

@immutable
class AgentTaskGrantValidation {
  const AgentTaskGrantValidation({
    required this.status,
    required this.category,
    required this.validatedAt,
  });

  final String status;
  final String? category, validatedAt;

  factory AgentTaskGrantValidation.fromJson(AgentCouncilJson value) {
    final status = _string(value, 'status');
    final category = _nullableString(value, 'category');
    final validatedAt = _nullableTimestamp(value, 'validatedAt');
    final valid = switch (status) {
      'not_checked' => category == null && validatedAt == null,
      'current' => category == 'all_grants' && validatedAt != null,
      'changed' => category == 'capability_binding' && validatedAt != null,
      _ => false,
    };
    if (!valid) {
      throw const FormatException(
        'Grant validation lifecycle coordinates are invalid.',
      );
    }
    return AgentTaskGrantValidation(
      status: status,
      category: category,
      validatedAt: validatedAt,
    );
  }
}

@immutable
class AgentTaskNativeReadGrant {
  const AgentTaskNativeReadGrant({required this.toolId});
  final String toolId;
  factory AgentTaskNativeReadGrant.fromJson(AgentCouncilJson value) =>
      AgentTaskNativeReadGrant(toolId: _string(value, 'toolId'));
}

@immutable
class AgentTaskSkillGrant {
  const AgentTaskSkillGrant({
    required this.capabilityGrantId,
    required this.skillId,
    required this.skillVersion,
    required this.skillVersionId,
    required this.skillSha256,
  });
  final String capabilityGrantId, skillId, skillVersionId, skillSha256;
  final int skillVersion;
  factory AgentTaskSkillGrant.fromJson(AgentCouncilJson value) =>
      AgentTaskSkillGrant(
        capabilityGrantId: _string(value, 'capabilityGrantId'),
        skillId: _string(value, 'skillId'),
        skillVersion: _integer(value, 'skillVersion'),
        skillVersionId: _string(value, 'skillVersionId'),
        skillSha256: _sha256(value, 'skillSha256'),
      );
}

@immutable
class AgentTaskPluginGrant {
  const AgentTaskPluginGrant({
    required this.capabilityGrantId,
    required this.installationId,
    required this.installationRevision,
    required this.installationSha256,
    required this.pluginId,
    required this.pluginVersion,
    required this.manifestSha256,
    required this.componentIds,
  });
  final String capabilityGrantId,
      installationId,
      installationSha256,
      pluginId,
      pluginVersion,
      manifestSha256;
  final int installationRevision;
  final List<String> componentIds;
  factory AgentTaskPluginGrant.fromJson(AgentCouncilJson value) =>
      AgentTaskPluginGrant(
        capabilityGrantId: _string(value, 'capabilityGrantId'),
        installationId: _string(value, 'installationId'),
        installationRevision: _integer(value, 'installationRevision'),
        installationSha256: _sha256(value, 'installationSha256'),
        pluginId: _string(value, 'pluginId'),
        pluginVersion: _string(value, 'pluginVersion'),
        manifestSha256: _sha256(value, 'manifestSha256'),
        componentIds: _strings(value, 'componentIds'),
      );
}

@immutable
class AgentTaskMcpGrant {
  const AgentTaskMcpGrant({
    required this.capabilityGrantId,
    required this.serverId,
    required this.serverVersionId,
    required this.serverContractSha256,
    required this.governedToolIds,
    required this.connectorTargetIds,
  });
  final String capabilityGrantId,
      serverId,
      serverVersionId,
      serverContractSha256;
  final List<String> governedToolIds, connectorTargetIds;
  factory AgentTaskMcpGrant.fromJson(AgentCouncilJson value) =>
      AgentTaskMcpGrant(
        capabilityGrantId: _string(value, 'capabilityGrantId'),
        serverId: _string(value, 'serverId'),
        serverVersionId: _string(value, 'serverVersionId'),
        serverContractSha256: _sha256(value, 'serverContractSha256'),
        governedToolIds: _strings(value, 'governedToolIds'),
        connectorTargetIds: _strings(value, 'connectorTargetIds'),
      );
}

@immutable
class AgentCouncilCancellation {
  const AgentCouncilCancellation({
    required this.executionId,
    required this.lifecycleRevision,
    required this.updatedAt,
    required this.terminalAt,
    required this.idempotent,
  });

  final String executionId, updatedAt, terminalAt;
  final int lifecycleRevision;
  final bool idempotent;

  factory AgentCouncilCancellation.fromJson(AgentCouncilJson value) {
    final task = _object(value, 'task');
    _rejectPrivateTaskFields(task);
    if (_string(task, 'state') != 'canceled' || task['canCancel'] != false) {
      throw const FormatException(
        'The Agent task cancellation was not confirmed by the service.',
      );
    }
    return AgentCouncilCancellation(
      executionId: _string(task, 'executionId'),
      lifecycleRevision: _integer(task, 'lifecycleRevision'),
      updatedAt: _timestamp(task, 'updatedAt'),
      terminalAt: _timestamp(task, 'terminalAt'),
      idempotent: value['idempotent'] == true,
    );
  }
}

class AgentCouncilController extends ChangeNotifier {
  AgentCouncilController(this.repository, {this.controlAvailable = false});

  final AgentCouncilRepository repository;
  final bool controlAvailable;
  AgentCouncilProjection? projection;
  bool loading = false;
  Object? error;
  final Set<String> _cancelingTaskIds = <String>{};
  final Map<String, Object> _cancellationErrors = <String, Object>{};
  final Map<String, String> _cancellationKeys = <String, String>{};
  final Map<String, AgentTaskDetail> _taskDetails = <String, AgentTaskDetail>{};
  final Set<String> _loadingTaskDetails = <String>{};
  final Map<String, Object> _taskDetailErrors = <String, Object>{};
  Future<void>? _refreshInFlight;

  bool canCancel(AgentCouncilMember member) =>
      controlAvailable &&
      repository is AgentCouncilControlRepository &&
      member.canCancel;

  bool isCanceling(String taskId) => _cancelingTaskIds.contains(taskId);

  Object? cancellationError(String taskId) => _cancellationErrors[taskId];

  AgentTaskDetail? taskDetail(String taskId) => _taskDetails[taskId];
  bool isLoadingTaskDetail(String taskId) =>
      _loadingTaskDetails.contains(taskId);
  Object? taskDetailError(String taskId) => _taskDetailErrors[taskId];

  Future<void> loadTaskDetail(String taskId, {bool refresh = false}) async {
    final source = repository;
    if (source is! AgentCouncilDetailRepository) {
      _taskDetailErrors[taskId] = StateError(
        'Exact task authority is unavailable on this installation.',
      );
      notifyListeners();
      return;
    }
    if (!refresh && _taskDetails.containsKey(taskId)) return;
    if (_loadingTaskDetails.contains(taskId)) return;
    _loadingTaskDetails.add(taskId);
    _taskDetailErrors.remove(taskId);
    notifyListeners();
    try {
      final detail = await (source as AgentCouncilDetailRepository)
          .loadTaskDetail(taskId);
      if (detail.executionId != taskId) {
        throw const FormatException(
          'The service returned authority for a different task.',
        );
      }
      _taskDetails[taskId] = detail;
    } catch (caught) {
      _taskDetailErrors[taskId] = caught;
    } finally {
      _loadingTaskDetails.remove(taskId);
      notifyListeners();
    }
  }

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

  Future<AgentCouncilCancellation> cancelTask(
    AgentCouncilMember member, {
    required String reason,
  }) async {
    final normalizedReason = reason.trim();
    final source = repository;
    if (!canCancel(member) || source is! AgentCouncilControlRepository) {
      throw StateError('This delegated task cannot be canceled here.');
    }
    if (normalizedReason.isEmpty || normalizedReason.length > 500) {
      throw ArgumentError.value(reason, 'reason');
    }
    if (_cancelingTaskIds.contains(member.taskId)) {
      throw StateError('This delegated task is already being canceled.');
    }
    final attempt =
        '${member.taskId}|${member.lifecycleRevision}|$normalizedReason';
    final idempotencyKey = _cancellationKeys.putIfAbsent(
      attempt,
      () => stableAgentTaskCancellationKey(
        executionId: member.taskId,
        expectedRevision: member.lifecycleRevision,
        reason: normalizedReason,
      ),
    );
    _cancelingTaskIds.add(member.taskId);
    _cancellationErrors.remove(member.taskId);
    notifyListeners();
    final controlSource = source as AgentCouncilControlRepository;
    try {
      final result = await controlSource.cancel(
        executionId: member.taskId,
        expectedRevision: member.lifecycleRevision,
        reason: normalizedReason,
        idempotencyKey: idempotencyKey,
      );
      if (result.executionId != member.taskId) {
        throw const FormatException(
          'The service canceled a different delegated task.',
        );
      }
      projection = projection?.withCanceledTask(result);
      _cancellationErrors.remove(member.taskId);
      return result;
    } catch (caught) {
      _cancellationErrors[member.taskId] = caught;
      rethrow;
    } finally {
      _cancelingTaskIds.remove(member.taskId);
      notifyListeners();
    }
  }
}

String stableAgentTaskCancellationKey({
  required String executionId,
  required int expectedRevision,
  required String reason,
}) {
  final canonical = '$executionId\u0000$expectedRevision\u0000${reason.trim()}';
  var first = 0x811c9dc5;
  var second = 0x9e3779b9;
  for (final value in canonical.codeUnits) {
    first = ((first ^ value) * 0x01000193) & 0xffffffff;
    second = ((second ^ (value + 0x7f)) * 0x01000193) & 0xffffffff;
  }
  final digest =
      first.toRadixString(16).padLeft(8, '0') +
      second.toRadixString(16).padLeft(8, '0');
  return 'native-agent-task-cancel-v1-$digest';
}

AgentCouncilJson _object(AgentCouncilJson source, String key) {
  final value = source[key];
  if (value is! Map) {
    throw FormatException('Agent Council field $key must be an object.');
  }
  return Map<String, dynamic>.from(value);
}

AgentCouncilJson? _nullableObject(AgentCouncilJson source, String key) {
  final value = source[key];
  if (value == null) return null;
  if (value is! Map) {
    throw FormatException(
      'Agent Council field $key must be null or an object.',
    );
  }
  return Map<String, dynamic>.from(value);
}

void _rejectPrivateTaskFields(AgentCouncilJson task) {
  const privateFields = {
    'tenantId',
    'ownerActorId',
    'contract',
    'contextCapsule',
    'executionScope',
    'delegatePrincipalId',
    'runtimeAssignmentId',
    'runtimeAssignmentSha256',
    'budgetLimits',
    'budgetLimitsSha256',
    'grants',
    'credential',
  };
  if (task.keys.any(privateFields.contains)) {
    throw const FormatException(
      'The Agent task response exposed a private delegation field.',
    );
  }
}

List<AgentCouncilJson> _objects(AgentCouncilJson source, String key) {
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

String _string(AgentCouncilJson source, String key, {bool allowEmpty = false}) {
  final value = source[key];
  if (value is! String || (!allowEmpty && value.trim().isEmpty)) {
    throw FormatException('Agent Council field $key must be a string.');
  }
  return value;
}

String? _nullableString(AgentCouncilJson source, String key) {
  final value = source[key];
  if (value == null) return null;
  if (value is! String || value.trim().isEmpty) {
    throw FormatException('Agent Council field $key must be null or a string.');
  }
  return value;
}

String _timestamp(AgentCouncilJson source, String key) {
  final value = _string(source, key);
  if (DateTime.tryParse(value) == null) {
    throw FormatException('Agent Council field $key must be a timestamp.');
  }
  return value;
}

String? _nullableTimestamp(AgentCouncilJson source, String key) {
  final value = _nullableString(source, key);
  if (value != null && DateTime.tryParse(value) == null) {
    throw FormatException('Agent Council field $key must be a timestamp.');
  }
  return value;
}

String _sha256(AgentCouncilJson source, String key) {
  final value = _string(source, key);
  if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(value)) {
    throw FormatException('Agent Council field $key must be a SHA-256 digest.');
  }
  return value;
}

int _integer(AgentCouncilJson source, String key) {
  final value = source[key];
  if (value is! num || value.toInt() != value || value < 0) {
    throw FormatException(
      'Agent Council field $key must be a non-negative integer.',
    );
  }
  return value.toInt();
}

int? _nullableInteger(AgentCouncilJson source, String key) =>
    source[key] == null ? null : _integer(source, key);

double _double(AgentCouncilJson source, String key) {
  final value = source[key];
  if (value is! num || !value.isFinite) {
    throw FormatException('Agent Council field $key must be a number.');
  }
  return value.toDouble();
}

double? _nullableDouble(AgentCouncilJson source, String key) =>
    source[key] == null ? null : _double(source, key);

List<String> _strings(AgentCouncilJson source, String key) {
  final value = source[key];
  if (value is! List || value.any((item) => item is! String)) {
    throw FormatException(
      'Agent Council field $key must be a list of strings.',
    );
  }
  return value.cast<String>().toList(growable: false);
}
