import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'builder_contracts.dart';

class BuilderAccess extends ChangeNotifier {
  BuilderAccess({
    this.owner,
    this.ready = false,
    this.readOperation = true,
    this.writeOperation = true,
  });
  BuilderOwner? owner;
  bool ready, readOperation, writeOperation, closed = false;
  int generation = 0;
  final Set<VoidCallback> _silentCloseListeners = {};
  void addSilentCloseListener(VoidCallback listener) =>
      _silentCloseListeners.add(listener);
  void removeSilentCloseListener(VoidCallback listener) =>
      _silentCloseListeners.remove(listener);
  bool get readable => !closed && ready && owner != null && readOperation;
  bool get writable => readable && writeOperation && owner!.canRun;
  void update(
    BuilderOwner? next, {
    required bool available,
    bool clear = false,
  }) {
    if (closed) {
      return;
    }
    final candidate = next ?? (clear ? null : owner);
    if (candidate?.key == owner?.key && ready == available) {
      return;
    }
    owner = candidate;
    ready = available;
    generation++;
    notifyListeners();
  }

  void close({bool notify = true}) {
    if (!closed) {
      closed = true;
      ready = false;
      generation++;
      if (notify) {
        notifyListeners();
      } else {
        // Clear controller-owned private state without notifying Riverpod's
        // outgoing ChangeNotifierProvider during its dependency teardown.
        for (final listener in _silentCloseListeners.toList()) {
          listener();
        }
      }
    }
  }

  @override
  void dispose() {
    _silentCloseListeners.clear();
    super.dispose();
  }
}

abstract interface class BuilderRepository {
  BuilderAccess get access;
  bool authorityCurrent();
  Future<BuilderSnapshot> snapshot(String project, CancelToken cancel);
  Future<List<BuilderTreeEntry>> tree(
    String project,
    String session,
    CancelToken cancel, {
    String? query,
  });
  Future<BuilderFile> file(
    String project,
    String session,
    String path,
    CancelToken cancel,
  );
  Future<List<BuilderRepositoryChoice>> repositories(
    String project,
    CancelToken cancel,
  );
  Future<BuilderJson> mutate(String project, BuilderJson frozen, String key);
}

class ApiBuilderRepository implements BuilderRepository {
  ApiBuilderRepository(
    this.api, {
    required this.access,
    required bool Function() authorityProbe,
  }) : _probe = authorityProbe {
    access.addListener(_changed);
  }
  final ApiClient api;
  @override
  final BuilderAccess access;
  final bool Function() _probe;
  final Set<CancelToken> _reads = {};
  bool _disposed = false;
  void _changed() {
    for (final cancel in _reads.toList()) {
      cancel.cancel('Builder authority changed.');
    }
  }

  @override
  bool authorityCurrent() =>
      !_disposed &&
      access.readable &&
      _probe() &&
      !_disposed &&
      access.readable;
  void _require([bool write = false]) {
    if (!authorityCurrent() ||
        write &&
            (!access.writable ||
                !NativeContract.supportsOperation(
                  'workspaces.builder.update',
                )) ||
        !NativeContract.supportsOperation('workspaces.builder.get')) {
      throw StateError(
        'Current Builder access and native operation authority are required.',
      );
    }
  }

  Future<BuilderJson> _read(
    String project,
    BuilderJson query,
    CancelToken cancel,
  ) async {
    _require();
    builderId(project, 'project');
    final generation = access.generation;
    _reads.add(cancel);
    try {
      final value = await api.getJsonFreshCancelable(
        NativePaths.workspacesBuilderGet(project),
        query: query,
        cancelToken: cancel,
      );
      _require();
      builderRequire(
        generation == access.generation && !cancel.isCancelled,
        'Builder authority changed during this read.',
      );
      return value;
    } finally {
      _reads.remove(cancel);
    }
  }

  @override
  Future<BuilderSnapshot> snapshot(String project, CancelToken cancel) async =>
      BuilderSnapshot.parse(
        await _read(project, const {}, cancel),
        project,
        access.owner!.apiScope,
      );
  void _sessionResponse(BuilderJson value, String project, String session) {
    final result = BuilderSession.parse(builderMap(value['session']), project);
    builderRequire(
      result.id == session,
      'The exact sandbox changed during this read.',
    );
  }

  @override
  Future<List<BuilderTreeEntry>> tree(
    String project,
    String session,
    CancelToken cancel, {
    String? query,
  }) async {
    builderId(session, 'session');
    if (query != null) {
      builderRequire(query.trim().length >= 2 && query.length <= 240);
    }
    final result = await _read(project, {
      'view': query == null ? 'tree' : 'search',
      'sessionId': session,
      if (query != null) 'query': query.trim(),
    }, cancel);
    if (query == null) {
      _sessionResponse(result, project, session);
    } else {
      builderRequire(result['query'] == query.trim());
    }
    final entries = builderList(
      result['entries'],
      query == null ? 500 : 100,
      BuilderTreeEntry.parse,
    );
    builderRequire(
      entries.map((row) => row.path).toSet().length == entries.length,
    );
    return entries;
  }

  @override
  Future<BuilderFile> file(
    String project,
    String session,
    String path,
    CancelToken cancel,
  ) async {
    builderId(session, 'session');
    builderPath(path);
    final result = await _read(project, {
      'view': 'file',
      'sessionId': session,
      'path': path,
    }, cancel);
    // The published file response contains only the file; scope is bound by the
    // authenticated exact session request and the controller generation fence.
    return BuilderFile.parse(builderMap(result['file']), path);
  }

  @override
  Future<List<BuilderRepositoryChoice>> repositories(
    String project,
    CancelToken cancel,
  ) async {
    final result = await _read(project, const {
      'view': 'github.repositories',
    }, cancel);
    final rows = builderList(
      result['repositories'],
      300,
      BuilderRepositoryChoice.parse,
    );
    builderRequire(rows.map((row) => row.id).toSet().length == rows.length);
    return rows;
  }

  @override
  Future<BuilderJson> mutate(
    String project,
    BuilderJson frozen,
    String key,
  ) async {
    _require(true);
    builderId(project, 'project');
    validateBuilderAction(frozen);
    final submitted = freezeBuilder(frozen) as BuilderJson;
    builderText(key, max: 240);
    final generation = access.generation;
    final owner = access.owner!;
    final authority = NativeRequestAuthority(
      tenantId: owner.tenantId,
      actorId: owner.actorId,
      canonicalUserId: owner.userId,
      role: owner.role,
      apiBaseUrl: api.apiBaseUrl,
      isCurrent: () =>
          authorityCurrent() &&
          access.writable &&
          access.generation == generation &&
          access.owner?.key == owner.key,
    );
    final result = await api.postJsonAuthorized(
      NativePaths.workspacesBuilderUpdate(project),
      authority: authority,
      data: submitted,
      headers: {'idempotency-key': key},
    );
    _require(true);
    builderRequire(
      generation == access.generation,
      'Builder authority changed after submission. Check the current server state; the effect is unconfirmed.',
    );
    validateBuilderResponse(result, project, submitted);
    await validateBuilderReceiptIdentity(
      builderMap(result['serviceReceipt']),
      tenantId: owner.tenantId,
      key: key,
    );
    _require(true);
    builderRequire(
      generation == access.generation,
      'Builder authority changed while checking the response.',
    );
    return freezeBuilder(result) as BuilderJson;
  }

  void dispose() {
    _disposed = true;
    _changed();
    _reads.clear();
    access.removeListener(_changed);
  }
}

void validateBuilderResponse(
  BuilderJson result,
  String project,
  BuilderJson input,
) {
  final sessionId = input['sessionId'];
  if (result['session'] != null) {
    final session = BuilderSession.parse(
      builderMap(result['session']),
      project,
    );
    builderRequire(
      sessionId == null || session.id == sessionId,
      'The accepted response changed its exact sandbox.',
    );
  }
  for (final field in [
    'checkpoint',
    'verification',
    'repositoryBinding',
    'delivery',
    'deployment',
    'release',
  ]) {
    if (result[field] == null) {
      continue;
    }
    final kind = field == 'repositoryBinding' ? 'repository' : field;
    final record = BuilderRecord.parse(
      builderMap(result[field]),
      kind,
      project,
      sessionId as String? ?? '',
    );
    final target = field == 'repositoryBinding'
        ? 'repositoryBindingId'
        : '${field}Id';
    builderRequire(
      input[target] == null || record.id == input[target],
      'The response changed the exact submitted target.',
    );
    for (final ref in [
      'checkpointId',
      'verificationId',
      'deploymentId',
      'releaseDigest',
      'repositoryId',
    ]) {
      builderRequire(
        !record.raw.containsKey(ref) ||
            !input.containsKey(ref) ||
            record.raw[ref] == input[ref],
        'The response changed a submitted evidence reference.',
      );
    }
  }
  final action = input['action'];
  final requiredRecord = switch (action) {
    'create' ||
    'stop' ||
    'file.update' ||
    'file.delete' ||
    'checkpoint.create' ||
    'checkpoint.restore' ||
    'repository.checkout' => 'session',
    'verification.run' => 'verification',
    'repository.bind' => 'repositoryBinding',
    'delivery.create' => 'delivery',
    'deployment.preview' || 'deployment.refresh' => 'deployment',
    'release.preview' || 'release.production' || 'release.refresh' => 'release',
    'command.run' => 'result',
    _ => null,
  };
  builderRequire(
    requiredRecord != null && result[requiredRecord] is Map,
    'The action response is missing its authoritative record.',
  );
  if (action == 'command.run') {
    final command = builderMap(result['result']);
    builderInt(command['exitCode'], minimum: -2147483648);
    builderInt(command['durationMs']);
    builderText(command['stdout'], max: 1000000, empty: true);
    builderText(command['stderr'], max: 1000000, empty: true);
  }
  if (action == 'file.update' || action == 'file.delete') {
    final effect = builderMap(
      result[action == 'file.update' ? 'update' : 'deletion'],
    );
    builderRequire(
      effect['path'] == input['path'] &&
          effect['previousSha256'] == input['expectedSha256'],
      'The response changed the exact submitted file revision.',
    );
    if (action == 'file.update') {
      builderHash(effect['sha256']);
      builderInt(effect['size']);
    }
  }
  final receipt = builderMap(result['serviceReceipt']);
  const receiptKeys = {
    'schemaVersion',
    'receiptKind',
    'boundaryVersion',
    'operation',
    'action',
    'resourceType',
    'accessMode',
    'eventContract',
    'authoritySha256',
    'idempotencyKeySha256',
    'outcomeSha256',
    'resourceCount',
    'occurredAt',
    'receiptSha256',
  };
  builderRequire(
    receipt.keys.toSet().difference(receiptKeys).isEmpty &&
        receiptKeys.every(receipt.containsKey),
  );
  builderRequire(
    receipt['schemaVersion'] == 1 &&
        receipt['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
        receipt['receiptKind'] == 'app_service_receipt' &&
        receipt['accessMode'] == 'mutation' &&
        receipt['action'] == 'run.agent' &&
        receipt['eventContract'] == 'app-builder-events.v1' &&
        receipt['operation'] == 'app.projects.builder.$action',
    'The receipt does not identify this submitted Builder action.',
  );
  final resource = switch (action) {
    'create' || 'stop' => 'session',
    'file.update' || 'file.delete' => 'file',
    'command.run' => 'command',
    'checkpoint.create' || 'checkpoint.restore' => 'checkpoint',
    'verification.run' => 'verification',
    'repository.bind' || 'repository.checkout' => 'repository',
    'delivery.create' => 'delivery',
    'deployment.preview' || 'deployment.refresh' => 'deployment',
    _ => 'release',
  };
  builderRequire(receipt['resourceType'] == 'app_builder_$resource');
  for (final field in [
    'authoritySha256',
    'idempotencyKeySha256',
    'outcomeSha256',
    'receiptSha256',
  ]) {
    builderHash(receipt[field]);
  }
  builderInt(receipt['resourceCount'], maximum: 1000000);
  builderDate(receipt['occurredAt']);
}

Future<void> validateBuilderReceiptIdentity(
  BuilderJson receipt, {
  required String tenantId,
  required String key,
}) async {
  Future<String> hash(String value) async =>
      (await Sha256().hash(utf8.encode(value))).bytes
          .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
          .join();
  // Receipt body fields are scalar strings and safe integers. This is the
  // server's sorted-key JSON form; no content or provider objects are signed here.
  final names = receipt.keys.where((name) => name != 'receiptSha256').toList()
    ..sort();
  final body = {for (final name in names) name: receipt[name]};
  builderRequire(
    receipt['receiptSha256'] == await hash(jsonEncode(body)),
    'The Builder receipt body changed.',
  );
  builderRequire(
    receipt['idempotencyKeySha256'] == await hash('$tenantId\u0000$key'),
    'The receipt belongs to another submitted request.',
  );
}
