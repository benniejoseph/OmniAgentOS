import 'dart:convert';

typedef AutomationJson = Map<String, dynamic>;

const automationPluginManifestMaxBytes = 128000;

enum AutomationSource {
  skills,
  connections,
  mcp,
  tools,
  workflows,
  triggers,
  plugins,
}

enum AutomationResourceStatus { idle, loading, ready, failed }

class AutomationResource<T> {
  const AutomationResource._({required this.status, this.data, this.error});

  const AutomationResource.idle()
    : this._(status: AutomationResourceStatus.idle);

  const AutomationResource.loading([T? previous])
    : this._(status: AutomationResourceStatus.loading, data: previous);

  const AutomationResource.ready(T value)
    : this._(status: AutomationResourceStatus.ready, data: value);

  const AutomationResource.failed(String message, [T? previous])
    : this._(
        status: AutomationResourceStatus.failed,
        data: previous,
        error: message,
      );

  final AutomationResourceStatus status;
  final T? data;
  final String? error;

  bool get isLoading => status == AutomationResourceStatus.loading;
  bool get isReady => status == AutomationResourceStatus.ready;
  bool get hasError => status == AutomationResourceStatus.failed;
}

class AutomationSnapshot {
  const AutomationSnapshot({
    this.skills = const AutomationResource.idle(),
    this.connections = const AutomationResource.idle(),
    this.mcp = const AutomationResource.idle(),
    this.tools = const AutomationResource.idle(),
    this.workflows = const AutomationResource.idle(),
    this.triggers = const AutomationResource.idle(),
    this.plugins = const AutomationResource.idle(),
  });

  factory AutomationSnapshot.loadingFrom(AutomationSnapshot previous) =>
      AutomationSnapshot(
        skills: AutomationResource.loading(previous.skills.data),
        connections: AutomationResource.loading(previous.connections.data),
        mcp: AutomationResource.loading(previous.mcp.data),
        tools: AutomationResource.loading(previous.tools.data),
        workflows: AutomationResource.loading(previous.workflows.data),
        triggers: AutomationResource.loading(previous.triggers.data),
        plugins: AutomationResource.loading(previous.plugins.data),
      );

  final AutomationResource<List<AutomationSkill>> skills;
  final AutomationResource<AutomationConnectionInventory> connections;
  final AutomationResource<List<AutomationMcpServer>> mcp;
  final AutomationResource<List<AutomationTool>> tools;
  final AutomationResource<List<AutomationWorkflowRun>> workflows;
  final AutomationResource<List<AutomationTrigger>> triggers;
  final AutomationResource<AutomationPluginCatalog> plugins;

  Iterable<AutomationResource<Object>> get sources sync* {
    yield _erase(skills);
    yield _erase(connections);
    yield _erase(mcp);
    yield _erase(tools);
    yield _erase(workflows);
    yield _erase(triggers);
    yield _erase(plugins);
  }

  int get failureCount => sources.where((source) => source.hasError).length;
  bool get connectionsPartial =>
      !connections.hasError &&
      connections.data?.state.toLowerCase() == 'partial';
  int get attentionCount => failureCount + (connectionsPartial ? 1 : 0);
  bool get loading => sources.any((source) => source.isLoading);

  AutomationSnapshot copyWith({
    AutomationResource<List<AutomationSkill>>? skills,
    AutomationResource<AutomationConnectionInventory>? connections,
    AutomationResource<List<AutomationMcpServer>>? mcp,
    AutomationResource<List<AutomationTool>>? tools,
    AutomationResource<List<AutomationWorkflowRun>>? workflows,
    AutomationResource<List<AutomationTrigger>>? triggers,
    AutomationResource<AutomationPluginCatalog>? plugins,
  }) => AutomationSnapshot(
    skills: skills ?? this.skills,
    connections: connections ?? this.connections,
    mcp: mcp ?? this.mcp,
    tools: tools ?? this.tools,
    workflows: workflows ?? this.workflows,
    triggers: triggers ?? this.triggers,
    plugins: plugins ?? this.plugins,
  );
}

class AutomationSkill {
  const AutomationSkill({
    required this.id,
    required this.name,
    required this.description,
    required this.category,
    required this.status,
    required this.builtIn,
    required this.toolIds,
    required this.knowledgeTags,
    required this.raw,
  });

  factory AutomationSkill.fromJson(AutomationJson value) => AutomationSkill(
    id: _text(value, const ['id'], fallback: 'skill'),
    name: _text(value, const ['name'], fallback: 'Untitled skill'),
    description: _text(value, const ['description']),
    category: _text(value, const ['category'], fallback: 'uncategorized'),
    status: _text(value, const ['status'], fallback: 'unknown'),
    builtIn: value['builtIn'] == true,
    toolIds: _strings(value['toolIds']),
    knowledgeTags: _strings(value['knowledgeTags']),
    raw: Map.unmodifiable(value),
  );

  final String id, name, description, category, status;
  final bool builtIn;
  final List<String> toolIds, knowledgeTags;
  final AutomationJson raw;
}

class AutomationConnectionInventory {
  const AutomationConnectionInventory({
    required this.state,
    required this.generatedAt,
    required this.installed,
    required this.suggestions,
    required this.raw,
  });

  factory AutomationConnectionInventory.fromResponse(AutomationJson response) {
    final overview = _record(response['overview']);
    if (overview.isEmpty) {
      throw const FormatException(
        'The connection service returned no integrations overview.',
      );
    }
    return AutomationConnectionInventory(
      state: _text(overview, const ['state'], fallback: 'unknown'),
      generatedAt: DateTime.tryParse(_text(overview, const ['generatedAt'])),
      installed: _records(overview['installed'])
          .map(AutomationConnection.fromJson)
          .toList(growable: false),
      suggestions: _records(overview['suggestions'])
          .map(AutomationConnectionSuggestion.fromJson)
          .toList(growable: false),
      raw: Map.unmodifiable(overview),
    );
  }

  final String state;
  final DateTime? generatedAt;
  final List<AutomationConnection> installed;
  final List<AutomationConnectionSuggestion> suggestions;
  final AutomationJson raw;
}

class AutomationConnection {
  const AutomationConnection({
    required this.id,
    required this.name,
    required this.kind,
    required this.adapter,
    required this.state,
    required this.connected,
    required this.manageable,
    required this.permissionMode,
    required this.syncStatus,
    required this.nextAction,
    required this.raw,
  });

  factory AutomationConnection.fromJson(AutomationJson value) {
    final permissions = _record(value['permissions']);
    final sync = _record(value['sync']);
    return AutomationConnection(
      id: _text(value, const ['id'], fallback: 'connection'),
      name: _text(value, const ['name'], fallback: 'Unnamed connection'),
      kind: _text(value, const ['kind'], fallback: 'unknown'),
      adapter: _text(value, const ['adapter'], fallback: 'unknown'),
      state: _text(value, const ['state'], fallback: 'unknown'),
      connected: value['connected'] == true,
      manageable: value['manageable'] == true,
      permissionMode: _text(permissions, const [
        'mode',
      ], fallback: 'unclassified'),
      syncStatus: _text(sync, const ['status'], fallback: 'unavailable'),
      nextAction: _text(value, const ['nextAction']),
      raw: Map.unmodifiable(value),
    );
  }

  final String id,
      name,
      kind,
      adapter,
      state,
      permissionMode,
      syncStatus,
      nextAction;
  final bool connected, manageable;
  final AutomationJson raw;
}

class AutomationConnectionSuggestion {
  const AutomationConnectionSuggestion({
    required this.id,
    required this.name,
    required this.adapter,
    required this.state,
    required this.detail,
    required this.capabilities,
    required this.raw,
  });

  factory AutomationConnectionSuggestion.fromJson(AutomationJson value) =>
      AutomationConnectionSuggestion(
        id: _text(value, const ['id'], fallback: 'suggestion'),
        name: _text(value, const ['name'], fallback: 'Connection'),
        adapter: _text(value, const ['adapter'], fallback: 'unknown'),
        state: _text(value, const ['state'], fallback: 'unknown'),
        detail: _text(value, const ['detail']),
        capabilities: _strings(value['capabilities']),
        raw: Map.unmodifiable(value),
      );

  final String id, name, adapter, state, detail;
  final List<String> capabilities;
  final AutomationJson raw;
}

class AutomationMcpServer {
  const AutomationMcpServer({
    required this.id,
    required this.name,
    required this.status,
    required this.authType,
    required this.toolCount,
    required this.defaultRiskLevel,
    required this.approvalRequired,
    required this.raw,
  });

  factory AutomationMcpServer.fromJson(AutomationJson value) {
    final review = _record(value['review']);
    return AutomationMcpServer(
      id: _text(value, const ['id'], fallback: 'mcp'),
      name: _text(value, const ['name'], fallback: 'Unnamed MCP server'),
      status: _text(value, const ['status'], fallback: 'unknown'),
      authType: _text(value, const ['authType'], fallback: 'unknown'),
      toolCount:
          _integer(value['toolCount']) ?? _integer(review['toolCount']) ?? 0,
      defaultRiskLevel: _integer(value['defaultRiskLevel']) ?? 2,
      approvalRequired: value['approvalRequired'] != false,
      raw: Map.unmodifiable(value),
    );
  }

  final String id, name, status, authType;
  final int toolCount, defaultRiskLevel;
  final bool approvalRequired;
  final AutomationJson raw;
}

class AutomationTool {
  const AutomationTool({
    required this.id,
    required this.name,
    required this.description,
    required this.status,
    required this.riskLevel,
    required this.approvalRequired,
    required this.raw,
  });

  factory AutomationTool.fromJson(AutomationJson value) => AutomationTool(
    id: _text(value, const ['id'], fallback: 'tool'),
    name: _text(value, const ['name', 'id'], fallback: 'Unnamed tool'),
    description: _text(value, const ['description']),
    status: _text(value, const ['status'], fallback: 'unknown'),
    riskLevel: _integer(value['riskLevel']) ?? 3,
    approvalRequired: value['approvalRequired'] != false,
    raw: Map.unmodifiable(value),
  );

  final String id, name, description, status;
  final int riskLevel;
  final bool approvalRequired;
  final AutomationJson raw;
}

class AutomationWorkflowRun {
  const AutomationWorkflowRun({
    required this.id,
    required this.title,
    required this.status,
    required this.mode,
    required this.updatedAt,
    required this.raw,
  });

  factory AutomationWorkflowRun.fromJson(AutomationJson value) {
    final input = _record(value['input']);
    return AutomationWorkflowRun(
      id: _text(value, const ['id'], fallback: 'workflow'),
      title: _text(input, const [
        'goal',
      ], fallback: _text(value, const ['name'], fallback: 'Workflow run')),
      status: _text(value, const [
        'canonicalStatus',
        'status',
      ], fallback: 'unknown'),
      mode: _text(value, const [
        'mode',
      ], fallback: _text(input, const ['mode'], fallback: 'workflow')),
      updatedAt: DateTime.tryParse(
        _text(value, const ['updatedAt', 'createdAt']),
      ),
      raw: Map.unmodifiable(value),
    );
  }

  final String id, title, status, mode;
  final DateTime? updatedAt;
  final AutomationJson raw;
}

class AutomationTrigger {
  const AutomationTrigger({
    required this.id,
    required this.name,
    required this.status,
    required this.source,
    required this.workflowMode,
    required this.raw,
  });

  factory AutomationTrigger.fromJson(AutomationJson value) => AutomationTrigger(
    id: _text(value, const ['id'], fallback: 'trigger'),
    name: _text(value, const ['name'], fallback: 'Untitled trigger'),
    status: _text(value, const ['status'], fallback: 'unknown'),
    source: _text(value, const ['source'], fallback: 'manual'),
    workflowMode: _text(value, const ['workflowMode'], fallback: 'orchestrate'),
    raw: Map.unmodifiable(value),
  );

  final String id, name, status, source, workflowMode;
  final AutomationJson raw;
}

class AutomationScheduleDetail {
  const AutomationScheduleDetail({
    required this.trigger,
    required this.previewTimes,
    required this.occurrences,
    required this.receipts,
    required this.policyLeasesAvailable,
    required this.policyLeases,
  });

  factory AutomationScheduleDetail.fromResponse(AutomationJson response) {
    final trigger = _record(response['trigger']);
    if (trigger.isEmpty) {
      throw const FormatException('The schedule service returned no trigger.');
    }
    final preview = _record(response['preview']);
    final policy = _record(response['policyLeases']);
    if (policy['version'] != 'scheduled-policy-lease-outcomes:1') {
      throw const FormatException(
        'The schedule policy-lease projection version is unsupported.',
      );
    }
    final available = policy['available'];
    if (available is! bool) {
      throw const FormatException(
        'The schedule policy-lease projection has no availability state.',
      );
    }
    if (policy['contentIncluded'] != false) {
      throw const FormatException(
        'Schedule policy history must remain content-free.',
      );
    }
    final occurrences = _requiredRecords(
      response,
      'occurrences',
    ).map(AutomationScheduleOccurrence.fromJson).toList(growable: false);
    final receipts = _requiredRecords(
      response,
      'receipts',
    ).map(AutomationScheduleReceipt.fromJson).toList(growable: false);
    final policyLeases = _requiredRecords(
      policy,
      'outcomes',
    ).map(AutomationPolicyLeaseOutcome.fromJson).toList(growable: false);
    if (!available && policyLeases.isNotEmpty) {
      throw const FormatException(
        'Unavailable PolicyLease history cannot contain projected outcomes.',
      );
    }
    return AutomationScheduleDetail(
      trigger: AutomationTrigger.fromJson(trigger),
      previewTimes: _schedulePreviewTimes(preview),
      occurrences: occurrences,
      receipts: receipts,
      policyLeasesAvailable: available,
      policyLeases: policyLeases,
    );
  }

  final AutomationTrigger trigger;
  final List<DateTime> previewTimes;
  final List<AutomationScheduleOccurrence> occurrences;
  final List<AutomationScheduleReceipt> receipts;
  final bool policyLeasesAvailable;
  final List<AutomationPolicyLeaseOutcome> policyLeases;
}

class AutomationScheduleOccurrence {
  const AutomationScheduleOccurrence({
    required this.id,
    required this.kind,
    required this.status,
    required this.scheduledFor,
    required this.workflowRunId,
    required this.failureCode,
    required this.attemptCount,
    required this.authoritySha256,
    required this.updatedAt,
  });

  factory AutomationScheduleOccurrence.fromJson(AutomationJson value) {
    final scheduledFor = _requiredCanonicalDate(value, 'scheduledFor');
    final updatedAt = _requiredCanonicalDate(value, 'updatedAt');
    if (updatedAt.isBefore(scheduledFor)) {
      throw const FormatException(
        'A schedule occurrence cannot be updated before it is scheduled.',
      );
    }
    return AutomationScheduleOccurrence(
      id: _requiredPattern(
        value,
        'id',
        _scheduleOccurrenceId,
        'a workflow schedule occurrence ID',
      ),
      kind: _requiredChoice(value, 'kind', _scheduleOccurrenceKinds),
      status: _requiredChoice(value, 'status', _scheduleOccurrenceStatuses),
      scheduledFor: scheduledFor,
      workflowRunId: _nullableText(value['workflowRunId']),
      failureCode: _nullableText(value['failureCode']),
      attemptCount: _requiredNonNegativeInteger(value, 'attemptCount'),
      authoritySha256: _requiredSha256(value, 'authoritySha256'),
      updatedAt: updatedAt,
    );
  }

  final String id, kind, status, authoritySha256;
  final String? workflowRunId, failureCode;
  final int attemptCount;
  final DateTime scheduledFor, updatedAt;
}

class AutomationScheduleReceipt {
  const AutomationScheduleReceipt({
    required this.id,
    required this.occurrenceId,
    required this.status,
    required this.receiptSha256,
    required this.stateSha256,
    required this.recordedAt,
  });

  factory AutomationScheduleReceipt.fromJson(AutomationJson value) =>
      AutomationScheduleReceipt(
        id: _requiredPattern(
          value,
          'id',
          _scheduleReceiptId,
          'a workflow schedule receipt ID',
        ),
        occurrenceId: _requiredPattern(
          value,
          'occurrenceId',
          _scheduleOccurrenceId,
          'a workflow schedule occurrence ID',
        ),
        status: _requiredChoice(value, 'status', _scheduleOccurrenceStatuses),
        receiptSha256: _requiredSha256(value, 'receiptSha256'),
        stateSha256: _requiredSha256(value, 'stateSha256'),
        recordedAt: _requiredCanonicalDate(value, 'recordedAt'),
      );

  final String id, occurrenceId, status, receiptSha256, stateSha256;
  final DateTime recordedAt;
}

class AutomationPolicyLeaseOutcome {
  const AutomationPolicyLeaseOutcome({
    required this.leaseId,
    required this.leaseSha256,
    required this.occurrenceId,
    required this.executionId,
    required this.toolId,
    required this.status,
    required this.bindingIndex,
    required this.bindingSha256,
    required this.toolContractSha256,
    required this.policySha256,
    required this.influenceManifestSha256,
    required this.issuedAt,
    required this.expiresAt,
    required this.consumedAt,
    required this.consumptionReceiptId,
    required this.consumptionReceiptSha256,
  });

  factory AutomationPolicyLeaseOutcome.fromJson(AutomationJson value) {
    if (value['contentIncluded'] != false ||
        value['leaseGrantsAuthority'] != false) {
      throw const FormatException(
        'PolicyLease history must be content-free and non-authorizing.',
      );
    }
    final status = _requiredChoice(value, 'status', _policyLeaseStatuses);
    final issuedAt = _requiredCanonicalDate(value, 'issuedAt');
    final expiresAt = _requiredCanonicalDate(value, 'expiresAt');
    final consumedAt = _nullableCanonicalDate(value['consumedAt']);
    final consumptionReceiptId = _nullablePattern(
      value['consumptionReceiptId'],
      _policyLeaseReceiptId,
      'a PolicyLease consumption receipt ID',
    );
    final consumptionReceiptSha256 = _nullableSha256(
      value['consumptionReceiptSha256'],
    );
    if (!expiresAt.isAfter(issuedAt)) {
      throw const FormatException(
        'A PolicyLease expiry must be after its issue time.',
      );
    }
    if (status == 'consumed') {
      if (consumedAt == null ||
          consumptionReceiptId == null ||
          consumptionReceiptSha256 == null ||
          consumedAt.isBefore(issuedAt) ||
          !consumedAt.isBefore(expiresAt)) {
        throw const FormatException(
          'A consumed PolicyLease needs a bounded consumption time and exact receipt.',
        );
      }
    } else if (consumedAt != null ||
        consumptionReceiptId != null ||
        consumptionReceiptSha256 != null) {
      throw const FormatException(
        'An issued or expired PolicyLease cannot contain consumption evidence.',
      );
    }
    return AutomationPolicyLeaseOutcome(
      leaseId: _requiredPattern(
        value,
        'leaseId',
        _policyLeaseId,
        'a PolicyLease ID',
      ),
      leaseSha256: _requiredSha256(value, 'leaseSha256'),
      occurrenceId: _requiredPattern(
        value,
        'occurrenceId',
        _scheduleOccurrenceId,
        'a workflow schedule occurrence ID',
      ),
      executionId: _requiredText(value, 'executionId'),
      toolId: _requiredText(value, 'toolId'),
      status: status,
      bindingIndex: _requiredNonNegativeInteger(value, 'bindingIndex'),
      bindingSha256: _requiredSha256(value, 'bindingSha256'),
      toolContractSha256: _requiredSha256(value, 'toolContractSha256'),
      policySha256: _requiredSha256(value, 'policySha256'),
      influenceManifestSha256: _requiredSha256(
        value,
        'influenceManifestSha256',
      ),
      issuedAt: issuedAt,
      expiresAt: expiresAt,
      consumedAt: consumedAt,
      consumptionReceiptId: consumptionReceiptId,
      consumptionReceiptSha256: consumptionReceiptSha256,
    );
  }

  final String leaseId,
      leaseSha256,
      occurrenceId,
      executionId,
      toolId,
      status,
      bindingSha256,
      toolContractSha256,
      policySha256,
      influenceManifestSha256;
  final int bindingIndex;
  final DateTime issuedAt, expiresAt;
  final DateTime? consumedAt;
  final String? consumptionReceiptId, consumptionReceiptSha256;
}

class AutomationPluginCatalog {
  const AutomationPluginCatalog({
    required this.plugins,
    required this.installations,
    required this.storage,
    required this.raw,
  });

  factory AutomationPluginCatalog.fromResponse(AutomationJson response) =>
      AutomationPluginCatalog(
        plugins: _records(response['plugins'])
            .map(AutomationPlugin.fromJson)
            .toList(growable: false),
        installations: _records(response['installations'])
            .map(AutomationPluginInstallation.fromJson)
            .toList(growable: false),
        storage: _text(response, const ['storage'], fallback: 'unknown'),
        raw: Map.unmodifiable(response),
      );

  final List<AutomationPlugin> plugins;
  final List<AutomationPluginInstallation> installations;
  final String storage;
  final AutomationJson raw;
}

class AutomationPlugin {
  const AutomationPlugin({
    required this.pluginId,
    required this.version,
    required this.name,
    required this.description,
    required this.publisherName,
    required this.catalogSource,
    required this.manifestSha256,
    required this.installed,
    required this.status,
    required this.installationId,
    required this.revision,
    required this.skillCount,
    required this.mcpTemplateCount,
    required this.workflowTemplateCount,
    required this.updateRequiresUninstall,
    required this.manifest,
    required this.raw,
  });

  factory AutomationPlugin.fromJson(AutomationJson value) {
    final publisher = _record(value['publisher']);
    final counts = _record(value['componentCounts']);
    return AutomationPlugin(
      pluginId: _text(value, const ['pluginId'], fallback: 'plugin'),
      version: _text(value, const ['version'], fallback: '0.0.0'),
      name: _text(value, const ['name'], fallback: 'Unnamed Plugin'),
      description: _text(value, const ['description']),
      publisherName: _text(publisher, const ['name'], fallback: 'Unknown'),
      catalogSource: _text(value, const ['catalogSource'], fallback: 'catalog'),
      manifestSha256: _text(value, const ['manifestSha256']),
      installed: value['installed'] == true,
      status: _nullableText(value['status']) ?? _nullableText(value['state']),
      installationId: _nullableText(value['installationId']),
      revision: _integer(value['revision']),
      skillCount: _integer(counts['skills']) ?? 0,
      mcpTemplateCount: _integer(counts['mcpTemplates']) ?? 0,
      workflowTemplateCount: _integer(counts['workflowTemplates']) ?? 0,
      updateRequiresUninstall: value['updateRequiresUninstall'] == true,
      manifest: Map.unmodifiable(_record(value['manifest'])),
      raw: Map.unmodifiable(value),
    );
  }

  final String pluginId,
      version,
      name,
      description,
      publisherName,
      catalogSource,
      manifestSha256;
  final bool installed, updateRequiresUninstall;
  final String? status, installationId;
  final int? revision;
  final int skillCount, mcpTemplateCount, workflowTemplateCount;
  final AutomationJson manifest, raw;
}

class AutomationPluginInstallation {
  const AutomationPluginInstallation({
    required this.installationId,
    required this.pluginId,
    required this.name,
    required this.state,
    required this.revision,
    required this.manifestSha256,
    required this.raw,
  });

  factory AutomationPluginInstallation.fromJson(AutomationJson value) =>
      AutomationPluginInstallation(
        installationId: _text(value, const [
          'installationId',
        ], fallback: 'installation'),
        pluginId: _text(value, const ['pluginId'], fallback: 'plugin'),
        name: _text(value, const ['name'], fallback: 'Unnamed Plugin'),
        state: _text(value, const ['state'], fallback: 'unknown'),
        revision: _integer(value['revision']) ?? 0,
        manifestSha256: _text(value, const ['manifestSha256']),
        raw: Map.unmodifiable(value),
      );

  final String installationId, pluginId, name, state, manifestSha256;
  final int revision;
  final AutomationJson raw;
}

class AutomationPluginPreview {
  const AutomationPluginPreview({
    required this.previewId,
    required this.pluginId,
    required this.pluginVersion,
    required this.name,
    required this.manifestSha256,
    required this.previewSha256,
    required this.effects,
    required this.limitations,
    required this.expiresAt,
    required this.manifest,
    required this.raw,
  });

  factory AutomationPluginPreview.fromResponse(AutomationJson response) {
    final value = _record(response['preview']);
    final previewId = _text(value, const ['previewId']);
    final manifestSha256 = _text(value, const ['manifestSha256']);
    final previewSha256 = _text(value, const ['previewSha256']);
    if (previewId.isEmpty ||
        !_sha256.hasMatch(manifestSha256) ||
        !_sha256.hasMatch(previewSha256)) {
      throw const FormatException(
        'The Plugin service returned an incomplete immutable preview.',
      );
    }
    final expiresAt = DateTime.tryParse(_text(value, const ['expiresAt']));
    if (expiresAt == null) {
      throw const FormatException('The Plugin preview has no valid expiry.');
    }
    return AutomationPluginPreview(
      previewId: previewId,
      pluginId: _text(value, const ['pluginId'], fallback: 'plugin'),
      pluginVersion: _text(value, const ['pluginVersion'], fallback: '0.0.0'),
      name: _text(value, const ['name'], fallback: 'Unnamed Plugin'),
      manifestSha256: manifestSha256,
      previewSha256: previewSha256,
      effects: _strings(value['effects']),
      limitations: _strings(value['limitations']),
      expiresAt: expiresAt,
      manifest: Map.unmodifiable(_record(response['manifest'])),
      raw: Map.unmodifiable(value),
    );
  }

  final String previewId,
      pluginId,
      pluginVersion,
      name,
      manifestSha256,
      previewSha256;
  final List<String> effects, limitations;
  final DateTime expiresAt;
  final AutomationJson manifest, raw;
}

class AutomationPluginMutation {
  const AutomationPluginMutation({
    required this.installation,
    required this.manifest,
    required this.activation,
    required this.explanation,
  });

  factory AutomationPluginMutation.fromResponse(AutomationJson response) {
    final installation = _record(response['installation']);
    if (installation.isEmpty) {
      throw const FormatException(
        'The Plugin service returned no installation projection.',
      );
    }
    final activation = _record(response['activation']);
    return AutomationPluginMutation(
      installation: AutomationPluginInstallation.fromJson(installation),
      manifest: Map.unmodifiable(_record(response['manifest'])),
      activation: Map.unmodifiable(activation),
      explanation: _text(activation, const ['explanation']),
    );
  }

  final AutomationPluginInstallation installation;
  final AutomationJson manifest, activation;
  final String explanation;
}

AutomationJson parseAutomationPluginManifest(String source) {
  final bytes = utf8.encode(source).length;
  if (source.trim().isEmpty) {
    throw const FormatException('Paste a Plugin manifest first.');
  }
  if (bytes > automationPluginManifestMaxBytes) {
    throw const FormatException('Plugin manifests must be 128 KB or smaller.');
  }
  final Object? decoded;
  try {
    decoded = jsonDecode(source);
  } on FormatException catch (error) {
    throw FormatException('Plugin manifest JSON is invalid: ${error.message}');
  }
  if (decoded is! Map) {
    throw const FormatException('A Plugin manifest must be one JSON object.');
  }
  final manifest = Map<String, dynamic>.from(decoded);
  if (manifest['schemaVersion'] != 1) {
    throw const FormatException('A Plugin manifest must use schemaVersion 1.');
  }
  return manifest;
}

final _sha256 = RegExp(r'^[a-f0-9]{64}$');
final _scheduleOccurrenceId = RegExp(
  r'^workflow_schedule_occurrence_[a-f0-9]{40}$',
);
final _scheduleReceiptId = RegExp(r'^workflow_schedule_receipt_[a-f0-9]{40}$');
final _policyLeaseId = RegExp(r'^policy_lease_[a-f0-9]{48}$');
final _policyLeaseReceiptId = RegExp(r'^policy_lease_receipt_[a-f0-9]{48}$');
const _scheduleOccurrenceKinds = {'scheduled', 'manual'};
const _scheduleOccurrenceStatuses = {
  'claimed',
  'enqueued',
  'completed',
  'skipped',
  'failed',
};
const _policyLeaseStatuses = {'issued', 'consumed', 'expired'};

AutomationResource<Object> _erase<T>(AutomationResource<T> value) =>
    AutomationResource<Object>._(
      status: value.status,
      data: value.data,
      error: value.error,
    );

AutomationJson _record(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

List<AutomationJson> _records(Object? value) => (value as List? ?? const [])
    .whereType<Map>()
    .map((item) => Map<String, dynamic>.from(item))
    .toList(growable: false);

List<AutomationJson> _requiredRecords(AutomationJson value, String key) {
  final entries = value[key];
  if (entries is! List || entries.any((entry) => entry is! Map)) {
    throw FormatException('$key must be a list of records.');
  }
  return entries
      .map((entry) => Map<String, dynamic>.from(entry as Map))
      .toList(growable: false);
}

List<DateTime> _schedulePreviewTimes(AutomationJson preview) {
  final values = preview['occurrences'] ?? preview['times'];
  return (values as List? ?? const [])
      .map((value) {
        if (value is String) return DateTime.tryParse(value);
        if (value is Map) {
          final record = Map<String, dynamic>.from(value);
          return DateTime.tryParse(_text(record, const ['scheduledFor', 'at']));
        }
        return null;
      })
      .whereType<DateTime>()
      .toList(growable: false);
}

String _requiredText(AutomationJson value, String key) {
  final result = value[key];
  if (result is! String || result.trim().isEmpty) {
    throw FormatException('$key must be a non-empty string.');
  }
  return result.trim();
}

String _requiredPattern(
  AutomationJson value,
  String key,
  RegExp pattern,
  String description,
) {
  final result = _requiredText(value, key);
  if (!pattern.hasMatch(result)) {
    throw FormatException('$key must be $description.');
  }
  return result;
}

String _requiredChoice(AutomationJson value, String key, Set<String> choices) {
  final result = _requiredText(value, key);
  if (!choices.contains(result)) {
    throw FormatException('$key has an unsupported value.');
  }
  return result;
}

String _requiredSha256(AutomationJson value, String key) {
  final result = _requiredText(value, key);
  if (!_sha256.hasMatch(result)) {
    throw FormatException('$key must be a SHA-256 digest.');
  }
  return result;
}

String? _nullableSha256(Object? value) {
  if (value == null) return null;
  if (value is! String || !_sha256.hasMatch(value)) {
    throw const FormatException('A receipt digest is invalid.');
  }
  return value;
}

String? _nullablePattern(Object? value, RegExp pattern, String description) {
  if (value == null) return null;
  if (value is! String || !pattern.hasMatch(value)) {
    throw FormatException('The optional value must be $description.');
  }
  return value;
}

DateTime _requiredCanonicalDate(AutomationJson value, String key) {
  final source = _requiredText(value, key);
  final parsed = DateTime.tryParse(source);
  if (parsed == null ||
      !parsed.isUtc ||
      parsed.toUtc().toIso8601String() != source) {
    throw FormatException('$key must be a canonical UTC timestamp.');
  }
  return parsed;
}

DateTime? _nullableCanonicalDate(Object? value) {
  if (value == null) return null;
  if (value is! String) {
    throw const FormatException('A nullable timestamp must be canonical UTC.');
  }
  final parsed = DateTime.tryParse(value);
  if (parsed == null ||
      !parsed.isUtc ||
      parsed.toUtc().toIso8601String() != value) {
    throw const FormatException('A nullable timestamp must be canonical UTC.');
  }
  return parsed;
}

int _requiredNonNegativeInteger(AutomationJson value, String key) {
  final result = value[key];
  if (result is! num || result.toInt() != result || result < 0) {
    throw FormatException('$key must be a non-negative integer.');
  }
  return result.toInt();
}

List<String> _strings(Object? value) => (value as List? ?? const [])
    .whereType<String>()
    .map((item) => item.trim())
    .where((item) => item.isNotEmpty)
    .toList(growable: false);

String _text(AutomationJson value, List<String> keys, {String fallback = ''}) {
  for (final key in keys) {
    final candidate = _nullableText(value[key]);
    if (candidate != null) return candidate;
  }
  return fallback;
}

String? _nullableText(Object? value) {
  if (value is! String || value.trim().isEmpty) return null;
  return value.trim();
}

int? _integer(Object? value) => value is num ? value.toInt() : null;
