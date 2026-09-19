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
