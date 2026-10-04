import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../../core/storage/secure_session_store.dart';
import '../../generated/native_contract.g.dart';
import 'specialist_contracts.dart';
import 'agent_skill_contracts.dart';
import 'specialist_recovery_store.dart';

final specialistRecoveryProvider = Provider<SpecialistRecoveryStore>(
  (ref) => EncryptedSpecialistRecoveryStore(
    ref.watch(secureSessionStoreProvider).readOrCreateOfflineProjectionSecret,
  ),
);
final specialistApiProvider = Provider.autoDispose
    .family<SpecialistApiClient, String>((ref, family) {
      final access = ref.watch(nativeWorkspaceAccessProvider);
      final client = SpecialistApiClient(
        access,
        ref.watch(secureSessionStoreProvider),
        ref.watch(specialistRecoveryProvider),
        family,
      );
      ref.onDispose(client.close);
      if (access != null) unawaited(client.initialize());
      return client;
    });

/// Existing repositories keep their domain parsers. This adapter supplies the
/// live authority transport and a durable decision boundary. Legacy entries
/// retain digests only; exact catalog decisions use an encrypted request slot.
class SpecialistApiClient extends ApiClient with ChangeNotifier {
  SpecialistApiClient(
    this.access,
    SecureSessionStore store,
    this.recovery,
    this.family,
  ) : super(Dio(), Dio(), store);
  final NativeWorkspaceAccess? access;
  final SpecialistRecoveryStore recovery;
  final String family;
  final List<SpecialistJson> _journal = [];
  final Map<SpecialistJson, String> _responses = Map.identity();
  final Set<CancelToken> _reads = {};
  Future<void>? _initialization;
  bool _closed = false, _ready = false, _writing = false, _revoked = false;
  String? recoveryError;
  SpecialistJson? _nativeDecision;
  SpecialistJson? get nativeDecision => current ? _nativeDecision : null;
  bool get nativeDecisionAvailable =>
      current &&
      _ready &&
      !_writing &&
      recoveryError == null &&
      _nativeDecision?['pending'] == null &&
      !_journal.any(
        (row) =>
            row['state'] != 'accepted' &&
            row['newDecisionAcknowledgedAt'] == null,
      );
  bool get current =>
      !_closed &&
      !_revoked &&
      access != null &&
      access!.current &&
      !_closed &&
      !_revoked;
  void _denyIfUnauthorized(Object error) {
    final status = error is ApiException
        ? error.statusCode
        : error is DioException
        ? error.response?.statusCode
        : null;
    if (!_closed && (status == 401 || status == 403)) {
      _revoked = true;
      _journal.clear();
      _responses.clear();
      for (final token in _reads) {
        token.cancel('Specialist access was revoked.');
      }
      _emit();
    }
  }

  NativeRequestAuthority get _authority {
    final owner = access!.authority;
    return NativeRequestAuthority(
      tenantId: owner.tenantId,
      actorId: owner.actorId,
      canonicalUserId: owner.canonicalUserId,
      role: owner.role,
      apiBaseUrl: owner.apiBaseUrl,
      isCurrent: () => current,
    );
  }

  List<SpecialistJson> get journal =>
      current ? List.unmodifiable(_journal) : const [];
  @override
  String get apiBaseUrl => access?.authority.apiBaseUrl ?? '';
  void _emit() {
    if (!_closed) notifyListeners();
  }

  void _require(String operation, {bool mutation = false}) {
    final allowedFamily = family == 'agents'
        ? operation.startsWith('agents.') ||
              operation.startsWith('moltbook.') ||
              operation.startsWith('skills.')
        : family == 'automation' &&
              (operation.startsWith('plugins.') ||
                  operation.startsWith('admin.') ||
                  operation.startsWith('automation.') ||
                  operation == 'integrations.overview' ||
                  operation == 'skills.list');
    specialistRequire(
      allowedFamily &&
          current &&
          NativeContract.supportsOperation(operation) &&
          (!mutation || access!.canManage),
      'The current account, role, API and published specialist operation are required.',
    );
  }

  Future<void> initialize() => _initialization ??= _restore();
  Future<void> reloadRecovery() async {
    specialistRequire(current && !_writing);
    final pending = _initialization;
    if (pending != null) await pending;
    specialistRequire(current && !_writing);
    _ready = false;
    _initialization = null;
    recoveryError = null;
    _journal.clear();
    _responses.clear();
    _emit();
    await initialize();
  }

  Future<void> _restore() async {
    if (!current) return;
    try {
      final stored = await recovery.read(SpecialistOwner(access!), family);
      if (!current) return;
      if (stored != null) {
        specialistRequire(
          (stored['schemaVersion'] == 1 || stored['schemaVersion'] == 2) &&
              stored['entries'] is List &&
              (stored['entries'] as List).length <= 32,
        );
        specialistRequire(
          stored.length == (stored['schemaVersion'] == 1 ? 2 : 3) &&
              stored.keys.every(
                {'schemaVersion', 'entries', 'nativeDecision'}.contains,
              ),
        );
        final nextNative =
            stored['schemaVersion'] == 2 && stored['nativeDecision'] != null
            ? specialistMap(stored['nativeDecision'])
            : null;
        await _validateNativeDecision(nextNative);
        if (!current) return;
        _retainPendingNative(nextNative);
        _nativeDecision = nextNative == null
            ? null
            : specialistFreeze(nextNative);
        final entries = (stored['entries'] as List).map(specialistMap);
        for (final row in entries) {
          const fields = {
            'operation',
            'method',
            'path',
            'target',
            'key',
            'bodySha256',
            'createdAt',
            'state',
            'responseSha256',
            'inspectedAt',
            'inspectionSha256',
            'newDecisionAcknowledgedAt',
          };
          specialistRequire(
            row.length == fields.length && row.keys.every(fields.contains),
          );
          specialistRequire(
            [
              'submitted',
              'unknown',
              'response_received',
              'accepted',
            ].contains(row['state']),
          );
          specialistText(row['key']);
          specialistText(row['operation']);
          specialistText(row['path']);
          specialistText(row['bodySha256'], 64);
          specialistRequire(
            RegExp(r'^[a-f0-9]{64}$').hasMatch(row['bodySha256'] as String) &&
                DateTime.tryParse(specialistText(row['createdAt'])) != null,
          );
          specialistRequire(
            ['POST', 'PATCH', 'DELETE'].contains(row['method']) &&
                _operation(row['method'] as String, row['path'] as String) ==
                    row['operation'] &&
                row['target'] == _target(row['path'] as String),
          );
          specialistRequire(
            !_journal.any((entry) => entry['key'] == row['key']),
          );
          for (final field in ['responseSha256', 'inspectionSha256']) {
            specialistRequire(
              row[field] == null ||
                  row[field] is String &&
                      RegExp(r'^[a-f0-9]{64}$').hasMatch(row[field] as String),
            );
          }
          for (final field in ['inspectedAt', 'newDecisionAcknowledgedAt']) {
            specialistRequire(
              row[field] == null ||
                  row[field] is String &&
                      DateTime.tryParse(row[field] as String) != null,
            );
          }
          specialistRequire(
            (row['inspectedAt'] == null) == (row['inspectionSha256'] == null) &&
                (row['newDecisionAcknowledgedAt'] == null ||
                    row['inspectedAt'] != null),
          );
          _journal.add(
            specialistFreeze({
              ...row,
              if (row['state'] == 'submitted') 'state': 'unknown',
            }),
          );
        }
      } else {
        _retainPendingNative(null);
      }
      _ready = true;
    } catch (_) {
      if (current) {
        _journal.clear();
        recoveryError = 'Protected decision recovery is unavailable. Reads remain available; new writes are held.';
      }
    }
    _emit();
  }

  Future<void> _save() async {
    specialistRequire(current);
    await recovery.write(
      SpecialistOwner(access!),
      family,
      specialistFreeze(
        _nativeDecision == null
            ? {'schemaVersion': 1, 'entries': _journal}
            : {
                'schemaVersion': 2,
                'entries': _journal,
                'nativeDecision': _nativeDecision,
              },
      ),
      isCurrent: () => current,
    );
  }

  String _operation(String method, String path) {
    final uri = Uri.parse(path), route = uri.path;
    specialistRequire(
      !uri.hasScheme &&
          !uri.hasAuthority &&
          !uri.hasFragment &&
          route.startsWith('/api/'),
    );
    const reads = {
      '/api/agents': 'agents.list',
      '/api/agents/performance': 'agents.performance',
      '/api/agents/council': 'agents.council',
      '/api/skills': 'skills.list',
      '/api/plugins': 'plugins.list',
      '/api/integrations/overview': 'integrations.overview',
      '/api/connectors': 'admin.connectors',
      '/api/tools': 'admin.tools',
      '/api/workflows': 'admin.workflows',
      '/api/triggers': 'admin.triggers',
    };
    if (method == 'GET' && reads.containsKey(route)) {
      return reads[route]!;
    }
    if (method == 'GET' &&
        RegExp(r'^/api/agents/[^/]+/deletion-review$').hasMatch(route)) {
      return 'agents.delete.review';
    }
    if (method == 'GET' &&
        RegExp(r'^/api/skills/[^/]+/mutation-review$').hasMatch(route)) {
      return 'skills.mutation.review';
    }
    if (method == 'GET' &&
        RegExp(r'^/api/agents/mutations/[a-f0-9]{64}$').hasMatch(route)) {
      return 'agents.mutations.get';
    }
    if (method == 'GET' &&
        RegExp(r'^/api/skills/mutations/[a-f0-9]{64}$').hasMatch(route)) {
      return 'skills.mutations.get';
    }
    if (method == 'DELETE' && RegExp(r'^/api/agents/[^/]+$').hasMatch(route)) {
      return 'agents.delete';
    }
    if (method == 'POST' && route == '/api/skills') {
      return 'skills.create';
    }
    if (RegExp(r'^/api/skills/[^/]+$').hasMatch(route)) {
      if (method == 'PATCH') {
        return 'skills.update';
      }
      if (method == 'DELETE') {
        return 'skills.delete';
      }
    }
    if (method == 'POST' && route == '/api/agents') {
      return 'agents.create';
    }
    if (method == 'POST' && route == '/api/plugins/preview') {
      return 'plugins.preview';
    }
    if (method == 'POST' && route == '/api/plugins/install') {
      return 'plugins.install';
    }
    if (RegExp(r'^/api/plugins/[^/]+$').hasMatch(route)) {
      if (method == 'PATCH') {
        return 'plugins.change';
      }
      if (method == 'DELETE') {
        return 'plugins.uninstall';
      }
    }
    if (method == 'GET' && RegExp(r'^/api/triggers/[^/]+$').hasMatch(route)) {
      return 'automation.schedule.show';
    }
    if (method == 'GET' &&
        RegExp(r'^/api/agents/tasks/[^/]+$').hasMatch(route)) {
      return 'agents.tasks.show';
    }
    if (method == 'POST' &&
        RegExp(r'^/api/agents/tasks/[^/]+/cancel$').hasMatch(route)) {
      return 'agents.tasks.cancel';
    }
    if (method == 'PATCH' && RegExp(r'^/api/agents/[^/]+$').hasMatch(route)) {
      return 'agents.update';
    }
    for (final (suffix, read, write) in [
      ('moltbook', 'moltbook.connection.show', 'moltbook.connection.manage'),
      ('release', 'agents.release.show', 'agents.release.manage'),
      ('adaptations', 'agents.adaptations.list', 'agents.adaptations.manage'),
      ('learning', 'agents.learning.show', ''),
    ]) {
      if (RegExp('^/api/agents/[^/]+/$suffix\$').hasMatch(route)) {
        if (method == 'GET') {
          return read;
        }
        if (method == 'POST' && write.isNotEmpty) {
          return write;
        }
      }
    }
    throw StateError('This specialist path is not enrolled for this method.');
  }

  String _target(String path) {
    final agent = RegExp(
      r'^/api/agents/([^/]+)(?:/(moltbook|release|adaptations))?$',
    ).firstMatch(path);
    if (agent != null) {
      return 'agent:${agent.group(1)}';
    }
    // Plugin enable, disable and uninstall share one installation boundary.
    return path;
  }

  @override
  Future<SpecialistJson> getJson(String path, {SpecialistJson? query}) =>
      _read(path, query);
  @override
  Future<SpecialistJson> getJsonFresh(String path, {SpecialistJson? query}) =>
      _read(path, query);
  @override
  Future<SpecialistJson> getJsonFreshCancelable(
    String path, {
    SpecialistJson? query,
    SpecialistJson? headers,
    required CancelToken cancelToken,
  }) => _read(path, query, cancelToken);
  Future<SpecialistJson> _read(
    String path,
    SpecialistJson? query, [
    CancelToken? supplied,
  ]) async {
    final operation = _operation('GET', path),
        token = supplied ?? CancelToken();
    _require(operation);
    _reads.add(token);
    try {
      final result = await access!.api.getJsonAuthorized(
        path,
        authority: _authority,
        query: query,
        cancelToken: token,
      );
      _require(operation);
      specialistRequire(
        !token.isCancelled &&
            utf8.encode(jsonEncode(result)).length <= 4 * 1024 * 1024,
        'The specialist read exceeds the native inspection bound.',
      );
      for (final value in result.values) {
        if (value is List) {
          specialistRequire(
            value.length <= 1000,
            'This inventory exceeds the native page bound. Open the full workspace in the browser.',
          );
        }
      }
      return specialistFreeze(result);
    } catch (error) {
      _denyIfUnauthorized(error);
      rethrow;
    } finally {
      _reads.remove(token);
    }
  }

  @override
  Future<SpecialistJson> postJson(
    String path, {
    SpecialistJson? data,
    SpecialistJson? headers,
  }) => _mutate('POST', path, data, headers);
  @override
  Future<SpecialistJson> patchJson(
    String path, {
    SpecialistJson? data,
    SpecialistJson? headers,
  }) => _mutate('PATCH', path, data, headers);
  @override
  Future<SpecialistJson> deleteJson(
    String path, {
    SpecialistJson? data,
    SpecialistJson? query,
    SpecialistJson? headers,
  }) {
    specialistRequire(query == null || query.isEmpty);
    return _mutate('DELETE', path, data, headers);
  }

  Future<SpecialistJson> _mutate(
    String method,
    String path,
    SpecialistJson? data,
    SpecialistJson? headers,
  ) async {
    final operation = _operation(method, path);
    specialistRequire(
      !{
        'agents.delete',
        'skills.create',
        'skills.update',
        'skills.delete',
      }.contains(operation),
      'Use the exact reviewed catalog decision flow.',
    );
    _require(operation, mutation: true);
    await initialize();
    _require(operation, mutation: true);
    specialistRequire(
      _ready &&
          recoveryError == null &&
          !_writing &&
          _journal.length < 32 &&
          _nativeDecision?['pending'] == null,
      'Inspect protected decision recovery before another specialist action.',
    );
    final key = specialistText(
          headers?['Idempotency-Key'] ?? headers?['idempotency-key'],
        ),
        body = specialistFreeze(data ?? {}),
        route = Uri.parse(path).path;
    specialistRequire(
      !_journal.any((row) => row['key'] == key),
      'This exact key already has a protected decision record. Inspect it before choosing a separate decision.',
    );
    final target = _target(route);
    specialistRequire(
      !_journal.any(
        (row) =>
            row['target'] == target &&
            row['state'] != 'accepted' &&
            row['newDecisionAcknowledgedAt'] == null,
      ),
      'A previous exact decision has an unresolved outcome. Inspect its current resource before explicitly choosing another decision.',
    );
    _writing = true;
    late final SpecialistJson intent;
    try {
      final digest = await specialistSha(body);
      _require(operation, mutation: true);
      intent = specialistFreeze({
        'operation': operation,
        'method': method,
        'path': route,
        'target': target,
        'key': key,
        'bodySha256': digest,
        'createdAt': DateTime.now().toUtc().toIso8601String(),
        'state': 'submitted',
        'responseSha256': null,
        'inspectedAt': null,
        'inspectionSha256': null,
        'newDecisionAcknowledgedAt': null,
      });
    } catch (_) {
      _writing = false;
      rethrow;
    }
    _journal.add(intent);
    _emit();
    try {
      await _save();
      _require(operation, mutation: true);
      final response = switch (method) {
        'PATCH' => await access!.api.patchJsonAuthorized(
          path,
          authority: _authority,
          data: body,
          headers: {'Idempotency-Key': key},
        ),
        'DELETE' => await access!.api.deleteJsonAuthorized(
          path,
          authority: _authority,
          data: body,
          headers: {'Idempotency-Key': key},
        ),
        _ => await access!.api.postJsonAuthorized(
          path,
          authority: _authority,
          data: body,
          headers: {'Idempotency-Key': key},
        ),
      };
      _require(operation, mutation: true);
      final result = specialistFreeze(response),
          digest = await specialistSha(response);
      _require(operation, mutation: true);
      final index = _journal.indexWhere((row) => row['key'] == key);
      _journal[index] = specialistFreeze({
        ...intent,
        'state': 'response_received',
        'responseSha256': digest,
      });
      await _save();
      _require(operation, mutation: true);
      _responses[result] = key;
      return result;
    } catch (error) {
      _denyIfUnauthorized(error);
      if (current) {
        final index = _journal.indexWhere((row) => row['key'] == key);
        if (index >= 0 && _journal[index]['state'] == 'submitted') {
          _journal[index] = specialistFreeze({...intent, 'state': 'unknown'});
        }
        try {
          await _save();
        } catch (_) {
          recoveryError = 'Protected decision storage needs reconciliation. New writes are held.';
        }
      }
      rethrow;
    } finally {
      _writing = false;
      _emit();
    }
  }

  Future<void> acceptParsedResponse(SpecialistJson response) async {
    specialistRequire(current);
    final key = _responses.remove(response);
    if (key == null) return;
    final digest = await specialistSha(response);
    specialistRequire(current);
    final index = _journal.indexWhere((row) => row['key'] == key);
    specialistRequire(
      index >= 0 && _journal[index]['responseSha256'] == digest,
    );
    _journal[index] = specialistFreeze({
      ..._journal[index],
      'state': 'accepted',
    });
    try {
      await _save();
    } catch (_) {
      recoveryError = 'The accepted response is visible, but its protected receipt could not be saved. New writes are held.';
    }
    _emit();
  }

  Future<SpecialistJson> inspectDecision(String key) async {
    specialistRequire(current && !_writing && recoveryError == null);
    _writing = true;
    try {
      final entry = _journal.firstWhere((row) => row['key'] == key),
          path = specialistText(entry['path']);
      final inspectionPath = path.startsWith('/api/plugins')
          ? '/api/plugins'
          : path.endsWith('/cancel')
          ? path.substring(0, path.length - '/cancel'.length)
          : RegExp(r'^/api/agents/[^/]+/(moltbook|release|adaptations)$')
                .hasMatch(path)
          ? path
          : '/api/agents';
      final response = await _read(
        inspectionPath,
        inspectionPath.endsWith('/moltbook') ? {'limit': 20} : null,
      );
      specialistRequire(current);
      final digest = await specialistSha(response);
      specialistRequire(current);
      final index = _journal.indexWhere((row) => row['key'] == key);
      _journal[index] = specialistFreeze({
        ..._journal[index],
        'inspectedAt': DateTime.now().toUtc().toIso8601String(),
        'inspectionSha256': digest,
      });
      await _save();
      return specialistFreeze({
        'decision': _journal[index],
        'inspectionPath': inspectionPath,
        'currentResource': response,
        'disclosure': 'This authorized current read does not prove the outcome of the earlier request. It never executes or retries that request.',
      });
    } finally {
      _writing = false;
      _emit();
    }
  }

  Future<void> acknowledgeNewDecision(String key) async {
    specialistRequire(
      current && access!.canManage && !_writing && recoveryError == null,
    );
    final index = _journal.indexWhere((row) => row['key'] == key),
        entry = _journal[index];
    final inspected = DateTime.tryParse(entry['inspectedAt']?.toString() ?? '');
    specialistRequire(
      inspected != null &&
          !inspected.isAfter(DateTime.now().toUtc()) &&
          DateTime.now().toUtc().difference(inspected).inMinutes < 5 &&
          entry['inspectionSha256'] != null,
      'Refresh and inspect the current resource before authorizing a new decision.',
    );
    _writing = true;
    _journal[index] = specialistFreeze({
      ...entry,
      'newDecisionAcknowledgedAt': DateTime.now().toUtc().toIso8601String(),
    });
    try {
      await _save();
    } catch (_) {
      _journal[index] = entry;
      recoveryError = 'The new decision acknowledgement could not be saved. New writes remain held.';
      rethrow;
    } finally {
      _writing = false;
      _emit();
    }
  }

  Future<void> dismissAccepted(String key) async {
    specialistRequire(current && !_writing && recoveryError == null);
    _writing = true;
    _journal.removeWhere(
      (row) => row['key'] == key && row['state'] == 'accepted',
    );
    try {
      await _save();
    } catch (_) {
      recoveryError =
          'Receipt dismissal could not be saved. New writes are held.';
      rethrow;
    } finally {
      _writing = false;
      _emit();
    }
  }

  void _retainPendingNative(SpecialistJson? next) {
    final held = _nativeDecision?['pending'];
    if (held == null) return;
    specialistRequire(
      specialistCanonical(held) == specialistCanonical(next?['pending']) ||
          (next?['accepted'] != null &&
              specialistCanonical(held) ==
                  specialistCanonical(next?['acceptedIntent'])),
      'The protected unresolved catalog decision is missing or differs. New actions remain held.',
    );
  }

  Future<void> _validateNativeDecision(SpecialistJson? value) async {
    if (value == null) {
      return;
    }
    final row = agentSkillExact(value, {
          'pending',
          'acceptedIntent',
          'accepted',
          'notSubmitted',
        }),
        owner = AgentSkillOwner.fromAccess(access!);
    if (row['pending'] != null) {
      await AgentSkillIntent.restore(row['pending'], owner);
    }
    specialistRequire(
      (row['acceptedIntent'] == null) == (row['accepted'] == null),
    );
    if (row['acceptedIntent'] != null) {
      final intent = await AgentSkillIntent.restore(
        row['acceptedIntent'],
        owner,
      );
      await AgentSkillAcceptance.restore(row['accepted'], owner, intent);
    }
    if (row['notSubmitted'] != null) {
      await AgentSkillIntent.restore(row['notSubmitted'], owner);
    }
  }

  /// A single protected transaction coordinates typed decisions with the legacy
  /// Specialist journal. It never retries an HTTP mutation.
  Future<T> withNativeDecision<T>(
    Future<T> Function() operation, {
    bool recovery = false,
  }) async {
    await initialize();
    specialistRequire(
      current &&
          _ready &&
          !_writing &&
          recoveryError == null &&
          (recovery || nativeDecisionAvailable),
    );
    _writing = true;
    _emit();
    try {
      return await operation();
    } finally {
      _writing = false;
      _emit();
    }
  }

  Future<void> saveNativeDecision(SpecialistJson value) async {
    specialistRequire(current && _writing);
    await _validateNativeDecision(value);
    specialistRequire(current);
    _nativeDecision = specialistFreeze(value);
    try {
      await _save();
    } catch (_) {
      recoveryError = 'The protected catalog decision could not be confirmed locally. Reload recovery before continuing.';
      _emit();
      rethrow;
    }
  }

  Future<SpecialistJson> dispatchNativeDecision(
    AgentSkillIntent intent, {
    required bool Function() isCurrent,
  }) async {
    final path = switch (intent.operation) {
          'agent.delete' => NativePaths.agentsDelete(intent.resourceId!),
          'skill.create' => NativePaths.skillsCreate,
          'skill.update' => NativePaths.skillsUpdate(intent.resourceId!),
          _ => NativePaths.skillsDelete(intent.resourceId!),
        },
        method = intent.operation == 'skill.create'
            ? 'POST'
            : intent.operation == 'skill.update'
            ? 'PATCH'
            : 'DELETE';
    final operation = _operation(method, path);
    _require(operation, mutation: true);
    specialistRequire(
      _writing &&
          recoveryError == null &&
          isCurrent() &&
          specialistCanonical(_nativeDecision?['pending']) ==
              specialistCanonical(intent.toJson()),
    );
    final owner = access!.authority;
    final authority = NativeRequestAuthority(
      tenantId: owner.tenantId,
      actorId: owner.actorId,
      canonicalUserId: owner.canonicalUserId,
      role: owner.role,
      apiBaseUrl: owner.apiBaseUrl,
      isCurrent: () => current && isCurrent(),
    );
    final response = switch (method) {
      'POST' => await access!.api.postJsonAuthorized(
        path,
        authority: authority,
        data: intent.request,
        headers: {'Idempotency-Key': intent.key},
      ),
      'PATCH' => await access!.api.patchJsonAuthorized(
        path,
        authority: authority,
        data: intent.request,
        headers: {'Idempotency-Key': intent.key},
      ),
      _ => await access!.api.deleteJsonAuthorized(
        path,
        authority: authority,
        data: intent.request,
        headers: {'Idempotency-Key': intent.key},
      ),
    };
    specialistRequire(current);
    return specialistFreeze(response);
  }

  void close() {
    if (_closed) return;
    _closed = true;
    for (final token in _reads) {
      token.cancel('Specialist authority changed.');
    }
    _reads.clear();
    _responses.clear();
    _journal.clear();
    _nativeDecision = null;
    super.dispose();
  }
}

Future<void> acceptSpecialistResponse(
  ApiClient api,
  SpecialistJson response,
) async {
  if (api is SpecialistApiClient) await api.acceptParsedResponse(response);
}
