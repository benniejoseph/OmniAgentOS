import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'automation_api_repository.dart';
import 'automation_models.dart';

class AutomationController extends ChangeNotifier {
  AutomationController(
    this.repository, {
    required this.canManage,
    required this.mutationsAvailable,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final AutomationRepository repository;
  final bool canManage, mutationsAvailable;
  final DateTime Function() _now;

  AutomationSnapshot snapshot = const AutomationSnapshot();
  AutomationPluginPreview? pluginPreview;
  DateTime? refreshedAt;
  String? pluginMutationKey, notice, error;
  bool refreshing = false;
  final Map<String, AutomationScheduleDetail> scheduleDetails =
      <String, AutomationScheduleDetail>{};
  final Set<String> loadingScheduleIds = <String>{};
  final Map<String, Object> scheduleErrors = <String, Object>{};
  int _generation = 0;
  bool _disposed = false;

  bool get canMutatePlugins => canManage && mutationsAvailable;
  bool get pluginBusy => pluginMutationKey != null;

  Future<void> loadSchedule(String triggerId, {bool refresh = false}) async {
    if (!refresh && scheduleDetails.containsKey(triggerId)) return;
    if (loadingScheduleIds.contains(triggerId)) return;
    loadingScheduleIds.add(triggerId);
    scheduleErrors.remove(triggerId);
    _emit();
    try {
      final detail = await repository.loadSchedule(triggerId);
      if (detail.trigger.id != triggerId) {
        throw const FormatException(
          'The service returned history for a different schedule.',
        );
      }
      scheduleDetails[triggerId] = detail;
    } catch (value) {
      scheduleErrors[triggerId] = value;
    } finally {
      loadingScheduleIds.remove(triggerId);
      _emit();
    }
  }

  Future<void> refresh() async {
    final generation = ++_generation;
    refreshing = true;
    error = null;
    snapshot = AutomationSnapshot.loadingFrom(snapshot);
    _emit();
    try {
      final loaded = await repository.load();
      if (generation != _generation) return;
      snapshot = loaded;
      refreshedAt = _now().toUtc();
    } catch (value) {
      if (generation == _generation) {
        error = _message(value, 'Automation could not be refreshed.');
      }
    } finally {
      if (generation == _generation) refreshing = false;
      _emit();
    }
  }

  Future<AutomationPluginPreview?> previewCatalogPlugin(
    AutomationPlugin plugin,
  ) async {
    if (!_beginPluginMutation('preview:${plugin.pluginId}')) return null;
    try {
      final idempotencyKey = _idempotencyKey('preview');
      final preview = plugin.catalogSource == 'installed_manifest'
          ? await _previewRetainedManifest(plugin, idempotencyKey)
          : await repository.previewCatalogPlugin(
              plugin,
              idempotencyKey: idempotencyKey,
            );
      pluginPreview = preview;
      notice = 'Review the exact effects before installing ${preview.name}.';
      return preview;
    } catch (value) {
      error = _message(value, 'Plugin review could not be prepared.');
      return null;
    } finally {
      _finishPluginMutation();
    }
  }

  Future<AutomationPluginPreview> _previewRetainedManifest(
    AutomationPlugin plugin,
    String idempotencyKey,
  ) {
    if (plugin.manifest.isEmpty) {
      throw StateError(
        'The retained Plugin manifest is unavailable. Import it again to continue.',
      );
    }
    return repository.previewManifest(
      plugin.manifest,
      idempotencyKey: idempotencyKey,
    );
  }

  Future<AutomationPluginPreview?> previewManifest(String source) async {
    if (!_beginPluginMutation('preview:manifest')) return null;
    try {
      final manifest = parseAutomationPluginManifest(source);
      final preview = await repository.previewManifest(
        manifest,
        idempotencyKey: _idempotencyKey('manifest-preview'),
      );
      pluginPreview = preview;
      notice = 'Review the exact effects before installing ${preview.name}.';
      return preview;
    } catch (value) {
      error = _message(value, 'Plugin manifest review could not be prepared.');
      return null;
    } finally {
      _finishPluginMutation();
    }
  }

  Future<bool> installPreview() async {
    final preview = pluginPreview;
    if (preview == null || !_beginPluginMutation('install')) return false;
    try {
      final result = await repository.installPlugin(
        preview,
        idempotencyKey: _idempotencyKey('install'),
      );
      pluginPreview = null;
      notice = result.explanation.isNotEmpty
          ? result.explanation
          : '${result.installation.name} was installed.';
      await _refreshPlugins();
      return true;
    } catch (value) {
      error = _message(value, 'Plugin installation failed.');
      return false;
    } finally {
      _finishPluginMutation();
    }
  }

  Future<bool> setPluginEnabled(AutomationPlugin plugin, bool enabled) async {
    final action = enabled ? 'enable' : 'disable';
    if (!_beginPluginMutation('$action:${plugin.pluginId}')) return false;
    try {
      final result = await repository.setPluginEnabled(
        plugin,
        enabled: enabled,
        idempotencyKey: _idempotencyKey(action),
      );
      notice = result.explanation.isNotEmpty
          ? result.explanation
          : '${result.installation.name} is now ${enabled ? 'enabled' : 'disabled'}.';
      await _refreshPlugins();
      return true;
    } catch (value) {
      error = _message(value, 'Plugin $action failed.');
      return false;
    } finally {
      _finishPluginMutation();
    }
  }

  Future<bool> uninstallPlugin(AutomationPlugin plugin) async {
    if (!_beginPluginMutation('uninstall:${plugin.pluginId}')) return false;
    try {
      final result = await repository.uninstallPlugin(
        plugin,
        idempotencyKey: _idempotencyKey('uninstall'),
      );
      if (pluginPreview?.pluginId == plugin.pluginId) pluginPreview = null;
      notice = '${result.installation.name} was uninstalled.';
      await _refreshPlugins();
      return true;
    } catch (value) {
      error = _message(value, 'Plugin uninstall failed.');
      return false;
    } finally {
      _finishPluginMutation();
    }
  }

  void clearPluginPreview() {
    pluginPreview = null;
    _emit();
  }

  void clearMessage() {
    error = null;
    notice = null;
    _emit();
  }

  bool _beginPluginMutation(String key) {
    if (pluginBusy) return false;
    if (!canMutatePlugins) {
      error = 'Plugin changes require an operator or administrator on native contract v17.';
      _emit();
      return false;
    }
    pluginMutationKey = key;
    error = null;
    notice = null;
    _emit();
    return true;
  }

  void _finishPluginMutation() {
    pluginMutationKey = null;
    _emit();
  }

  Future<void> _refreshPlugins() async {
    final previous = snapshot.plugins.data;
    snapshot = snapshot.copyWith(plugins: AutomationResource.loading(previous));
    _emit();
    final plugins = await repository.loadPlugins();
    snapshot = snapshot.copyWith(
      plugins: plugins.hasError && previous != null
          ? AutomationResource.failed(plugins.error!, previous)
          : plugins,
    );
    refreshedAt = _now().toUtc();
    _emit();
  }

  String _idempotencyKey(String action) {
    final micros = _now().toUtc().microsecondsSinceEpoch;
    final entropy = base64Url
        .encode(utf8.encode('$action:$micros:${identityHashCode(this)}'))
        .replaceAll('=', '');
    return 'native-plugin-$action-$micros-$entropy';
  }

  void _emit() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation += 1;
    super.dispose();
  }
}

String _message(Object value, String fallback) {
  final message = value.toString().trim();
  return message.isEmpty ? fallback : message;
}
