import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../generated/native_contract.g.dart';
import 'automation_models.dart';
import '../agents/specialist_api_client.dart';

abstract interface class AutomationRepository {
  Future<AutomationSnapshot> load();

  Future<AutomationScheduleDetail> loadSchedule(String triggerId);

  Future<AutomationResource<AutomationPluginCatalog>> loadPlugins();

  Future<AutomationPluginPreview> previewCatalogPlugin(
    AutomationPlugin plugin, {
    required String idempotencyKey,
  });

  Future<AutomationPluginPreview> previewManifest(
    AutomationJson manifest, {
    required String idempotencyKey,
  });

  Future<AutomationPluginMutation> installPlugin(
    AutomationPluginPreview preview, {
    required String idempotencyKey,
  });

  Future<AutomationPluginMutation> setPluginEnabled(
    AutomationPlugin plugin, {
    required bool enabled,
    required String idempotencyKey,
  });

  Future<AutomationPluginMutation> uninstallPlugin(
    AutomationPlugin plugin, {
    required String idempotencyKey,
  });
}

class ApiAutomationRepository implements AutomationRepository {
  const ApiAutomationRepository(this.api);

  final ApiClient api;

  @override
  Future<AutomationSnapshot> load() async {
    final skills = _load(
      () => api.getJson(NativePaths.skillsList),
      (json) =>
          _records(json['skills'])
              .map(AutomationSkill.fromJson)
              .toList(growable: false),
      'Skills',
    );
    final connections = _load(
      () => api.getJson(NativePaths.integrationsOverview()),
      AutomationConnectionInventory.fromResponse,
      'Connections',
    );
    final mcp = _load(
      () => api.getJson(NativePaths.adminConnectors),
      (json) =>
          _records(json['connectors'])
              .map(AutomationMcpServer.fromJson)
              .toList(growable: false),
      'MCP servers',
    );
    final tools = _load(
      () => api.getJson(NativePaths.adminTools),
      (json) =>
          _records(json['tools'])
              .map(AutomationTool.fromJson)
              .toList(growable: false),
      'Tools',
    );
    final workflows = _load(
      () => api.getJson(NativePaths.adminWorkflows, query: const {'limit': 24}),
      (json) =>
          _records(json['runs'])
              .map(AutomationWorkflowRun.fromJson)
              .toList(growable: false),
      'Workflow runs',
    );
    final triggers = _load(
      () => api.getJson(NativePaths.adminTriggers, query: const {'limit': 48}),
      (json) =>
          _records(json['triggers'])
              .map(AutomationTrigger.fromJson)
              .toList(growable: false),
      'Automation triggers',
    );
    final plugins = loadPlugins();

    await Future.wait<Object?>([
      skills,
      connections,
      mcp,
      tools,
      workflows,
      triggers,
      plugins,
    ]);
    return AutomationSnapshot(
      skills: await skills,
      connections: await connections,
      mcp: await mcp,
      tools: await tools,
      workflows: await workflows,
      triggers: await triggers,
      plugins: await plugins,
    );
  }

  @override
  Future<AutomationScheduleDetail> loadSchedule(String triggerId) async {
    final normalized = triggerId.trim();
    if (normalized.isEmpty || normalized.length > 200) {
      throw ArgumentError.value(triggerId, 'triggerId');
    }
    return AutomationScheduleDetail.fromResponse(
      await api.getJsonFresh(NativePaths.automationScheduleShow(normalized)),
    );
  }

  @override
  Future<AutomationResource<AutomationPluginCatalog>> loadPlugins() => _load(
    () => api.getJson(NativePaths.pluginsList),
    AutomationPluginCatalog.fromResponse,
    'Plugins',
  );

  @override
  Future<AutomationPluginPreview> previewCatalogPlugin(
    AutomationPlugin plugin, {
    required String idempotencyKey,
  }) async {
    _requireSha256(plugin.manifestSha256, 'manifestSha256');
    final response = await api.postJson(
      NativePaths.pluginsPreview,
      data: {
        'pluginId': plugin.pluginId,
        'version': plugin.version,
        'manifestSha256': plugin.manifestSha256,
      },
      headers: _mutationHeaders(idempotencyKey),
    );
    final result = AutomationPluginPreview.fromResponse(response);
    if (result.pluginId != plugin.pluginId ||
        result.pluginVersion != plugin.version ||
        result.manifestSha256 != plugin.manifestSha256) {
      throw const FormatException(
        'Plugin preview identifies another manifest.',
      );
    }
    await acceptSpecialistResponse(api, response);
    return result;
  }

  @override
  Future<AutomationPluginPreview> previewManifest(
    AutomationJson manifest, {
    required String idempotencyKey,
  }) async {
    if (manifest['schemaVersion'] != 1) {
      throw const FormatException(
        'A Plugin manifest must use schemaVersion 1.',
      );
    }
    final response = await api.postJson(
      NativePaths.pluginsPreview,
      data: {'manifest': manifest},
      headers: _mutationHeaders(idempotencyKey),
    );
    final result = AutomationPluginPreview.fromResponse(response);
    if (result.pluginId != manifest['pluginId'] ||
        result.pluginVersion != manifest['version']) {
      throw const FormatException(
        'Plugin preview identifies another submitted manifest.',
      );
    }
    await acceptSpecialistResponse(api, response);
    return result;
  }

  @override
  Future<AutomationPluginMutation> installPlugin(
    AutomationPluginPreview preview, {
    required String idempotencyKey,
  }) async {
    _requireSha256(preview.previewSha256, 'previewSha256');
    _requireSha256(preview.manifestSha256, 'manifestSha256');
    if (preview.expiresAt.isBefore(DateTime.now().toUtc())) {
      throw StateError(
        'This immutable Plugin preview has expired. Prepare it again.',
      );
    }
    final response = await api.postJson(
      NativePaths.pluginsInstall,
      data: {
        'previewId': preview.previewId,
        'manifestSha256': preview.manifestSha256,
      },
      headers: _mutationHeaders(idempotencyKey),
    );
    final result = AutomationPluginMutation.fromResponse(response);
    if (result.installation.pluginId != preview.pluginId ||
        result.installation.manifestSha256 != preview.manifestSha256 ||
        result.installation.state != 'enabled' ||
        result.installation.revision < 1) {
      throw const FormatException(
        'Plugin installation receipt differs from the exact reviewed manifest.',
      );
    }
    await acceptSpecialistResponse(api, response);
    return result;
  }

  @override
  Future<AutomationPluginMutation> setPluginEnabled(
    AutomationPlugin plugin, {
    required bool enabled,
    required String idempotencyKey,
  }) async {
    final binding = _lifecycleBinding(plugin);
    final response = await api.patchJson(
      NativePaths.pluginsChange(binding.installationId),
      data: {
        'action': enabled ? 'enable' : 'disable',
        'expectedRevision': binding.revision,
      },
      headers: _mutationHeaders(idempotencyKey),
    );
    final result = AutomationPluginMutation.fromResponse(response);
    _validateLifecycleResult(
      result,
      plugin,
      binding,
      enabled ? 'enabled' : 'disabled',
    );
    await acceptSpecialistResponse(api, response);
    return result;
  }

  @override
  Future<AutomationPluginMutation> uninstallPlugin(
    AutomationPlugin plugin, {
    required String idempotencyKey,
  }) async {
    final binding = _lifecycleBinding(plugin);
    final response = await api.deleteJson(
      NativePaths.pluginsUninstall(binding.installationId),
      data: {'expectedRevision': binding.revision},
      headers: _mutationHeaders(idempotencyKey),
    );
    final result = AutomationPluginMutation.fromResponse(response);
    _validateLifecycleResult(result, plugin, binding, 'uninstalled');
    await acceptSpecialistResponse(api, response);
    return result;
  }
}

void _validateLifecycleResult(
  AutomationPluginMutation result,
  AutomationPlugin plugin,
  ({String installationId, int revision}) binding,
  String state,
) {
  final saved = result.installation;
  if (saved.installationId != binding.installationId ||
      saved.pluginId != plugin.pluginId ||
      saved.manifestSha256 != plugin.manifestSha256 ||
      saved.revision != binding.revision + 1 ||
      saved.state != state) {
    throw const FormatException(
      'Plugin receipt differs from the exact submitted lifecycle decision.',
    );
  }
}

Future<AutomationResource<T>> _load<T>(
  Future<AutomationJson> Function() request,
  T Function(AutomationJson) parse,
  String label,
) async {
  try {
    return AutomationResource.ready(parse(await request()));
  } catch (error) {
    return AutomationResource.failed(_sourceFailure(label, error));
  }
}

String _sourceFailure(String label, Object error) {
  final detail = switch (error) {
    ApiException(:final message) => message,
    FormatException(:final message) => message,
    _ => '$label could not be loaded.',
  };
  return '$label: $detail';
}

Map<String, dynamic> _mutationHeaders(String idempotencyKey) {
  final normalized = idempotencyKey.trim();
  if (!RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$')
      .hasMatch(normalized)) {
    throw const FormatException(
      'Plugin changes require a valid opaque Idempotency-Key.',
    );
  }
  return {'Idempotency-Key': normalized};
}

({String installationId, int revision}) _lifecycleBinding(
  AutomationPlugin plugin,
) {
  final installationId = plugin.installationId?.trim() ?? '';
  final revision = plugin.revision ?? 0;
  if (installationId.isEmpty || revision < 1) {
    throw StateError(
      'Refresh this Plugin before changing its installation state.',
    );
  }
  return (installationId: installationId, revision: revision);
}

void _requireSha256(String value, String field) {
  if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(value)) {
    throw FormatException('Plugin $field is not a valid SHA-256 digest.');
  }
}

List<AutomationJson> _records(Object? value) {
  if (value is! List ||
      value.length > 1000 ||
      value.any((row) => row is! Map)) {
    throw const FormatException(
      'The capability inventory is incomplete or exceeds its native bound.',
    );
  }
  return value
      .map((item) => Map<String, dynamic>.from(item as Map))
      .toList(growable: false);
}
