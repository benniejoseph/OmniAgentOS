import 'dart:math';

import 'package:dio/dio.dart';

import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../capture/library_contracts.dart';
import '../projects/projects.dart';
import '../settings/portable_archive_canonical.dart';
import 'csm_agent_template.dart';

typedef CsmJson = Map<String, dynamic>;

class CsmClient {
  const CsmClient(this.project, this.profile, this.sourceCount);
  final Project project;
  final CsmJson profile;
  final int sourceCount;
}

class CsmSnapshot {
  const CsmSnapshot(this.raw, this.sources);
  final CsmJson raw;
  final List<LibraryItem> sources;
  String? get revision => raw['revision'] as String?;
  bool get canWrite => (raw['context'] as Map)['canWrite'] == true;
  String get text => raw['text'] as String? ?? '';
  CsmJson get profile => raw['profile'] == null
      ? emptyCsmProfile()
      : Map<String, dynamic>.from(raw['profile']);
  List<CsmJson> get links => (raw['sourceLinks'] as List)
      .map((v) => Map<String, dynamic>.from(v))
      .toList();
}

CsmJson emptyCsmProfile() => {
  'role': 'secondary',
  'successPlan': 'unknown',
  'leadCsm': '',
  'customerGoals': '',
  'successPath': '',
  'stakeholders': '',
};

/// No offline copy: every response and outgoing request belongs to one unlocked owner.
class CsmRepository {
  CsmRepository(this.access);
  final NativeWorkspaceAccess access;
  final _reads = <CancelToken>{};
  bool _disposed = false;
  String? _agentCreationKey;
  ({String path, String method, CsmJson body, String key})? _pending;
  bool get current => !_disposed && access.current;
  bool get hasPending => _pending != null;
  void _check() {
    if (!current)
      throw const ApiException('Your workspace changed. Reopen Work.');
  }

  void dispose() {
    _disposed = true;
    _pending = null;
    for (final read in _reads) {
      read.cancel('Workspace closed');
    }
    _reads.clear();
  }

  Future<CsmJson> _read(String path) async {
    _check();
    final cancel = CancelToken();
    _reads.add(cancel);
    try {
      final data = await access.api
          .getJsonAuthorized(
            path,
            authority: access.authority,
            cancelToken: cancel,
          )
          .timeout(
            const Duration(seconds: 30),
            onTimeout: () {
              cancel.cancel();
              throw const ApiException(
                'Work took too long to load. Try again.',
              );
            },
          );
      _check();
      return data;
    } finally {
      _reads.remove(cancel);
    }
  }

  Future<void> _receipt(
    CsmJson data, {
    required bool role,
    required bool mutation,
    String? key,
  }) async {
    final receipt = libraryMap(data['serviceReceipt']);
    libraryRequire(
      receipt['schemaVersion'] == 1 &&
          receipt['receiptKind'] == 'app_service_receipt' &&
          receipt['boundaryVersion'] == 'p9.1-app-service-boundary:1',
    );
    libraryRequire(
      receipt['operation'] ==
              (role
                  ? 'app.csm.role.${mutation ? 'write' : 'show'}'
                  : 'app.csm.context.${mutation ? 'write' : 'show'}') &&
          receipt['action'] == (mutation ? 'write.memory' : 'read') &&
          receipt['accessMode'] == (mutation ? 'mutation' : 'read') &&
          receipt['resourceType'] ==
              (role
                  ? 'memory'
                  : mutation
                  ? 'shared_memory'
                  : 'project'),
    );
    final receiptBody = {...receipt}..remove('receiptSha256');
    final outcome = {...data}..remove('serviceReceipt');
    libraryRequire(
      receipt['receiptSha256'] == portableCanonicalSha256(receiptBody) &&
          receipt['outcomeSha256'] == portableCanonicalSha256(outcome),
    );
    if (mutation) {
      final hash = portableTextSha256('${access.authority.tenantId}\u0000$key');
      libraryRequire(
        receipt['idempotencyKeySha256'] == hash &&
            data['acceptedRevision'] is String,
      );
    } else {
      libraryRequire(receipt['idempotencyKeySha256'] == null);
    }
    _check();
  }

  Project _project(Object? value) {
    final p = Project.fromJson(libraryMap(value));
    libraryRequire(
      p.tenantId == access.authority.tenantId &&
          (p.actorId == access.authority.actorId ||
              p.actorId == 'actor:${access.authority.canonicalUserId}'),
    );
    return p;
  }

  CsmJson _profile(Object? value) {
    final p = libraryMap(value);
    libraryRequire(
      ['secondary', 'lead'].contains(p['role']) &&
          [
            'unknown',
            'standard',
            'premier',
            'signature',
          ].contains(p['successPlan']),
    );
    for (final key in [
      'leadCsm',
      'customerGoals',
      'successPath',
      'stakeholders',
    ]) {
      libraryText(p[key], max: key == 'leadCsm' ? 240 : 4000, empty: true);
    }
    if (p['nextReviewDate'] != null) {
      libraryRequire(
        p['nextReviewDate'] is String &&
            RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(p['nextReviewDate']) &&
            DateTime.tryParse(p['nextReviewDate']) != null,
      );
    }
    return libraryFreeze(p);
  }

  Future<({List<CsmClient> clients, bool truncated})> clients() async {
    final data = await _read('/api/csm/clients');
    await _receipt(data, role: false, mutation: false);
    final clients = libraryArray(data['clients'], 100, (row) {
      final c = libraryMap(row);
      libraryText(c['revision']);
      return CsmClient(
        _project(c['project']),
        _profile(c['profile']),
        libraryCount(c['sourceCount'], max: 50),
      );
    });
    return (clients: clients, truncated: libraryBool(data['truncated']));
  }

  String path(String? projectId) => projectId == null
      ? '/api/csm/role-context'
      : '/api/projects/${Uri.encodeComponent(projectId)}/csm';
  Future<CsmSnapshot> read(String? projectId) async {
    final data = await _read(path(projectId));
    await _receipt(data, role: projectId == null, mutation: false);
    return _snapshot(data, projectId);
  }

  CsmSnapshot _snapshot(CsmJson data, String? projectId) {
    libraryOptionalId(data['revision']);
    final context = libraryMap(data['context']);
    libraryBool(context['canWrite']);
    if (projectId == null) {
      libraryRequire(data['schemaVersion'] == 1 && context['scope'] == 'user');
      libraryText(data['text'], max: 20000, empty: true);
    } else {
      libraryRequire(
        _project(data['project']).id == projectId &&
            context['projectId'] == projectId &&
            context['scope'] == 'project',
      );
      libraryHash(context['authoritySha256']);
      if (data['profile'] != null) _profile(data['profile']);
    }
    final owner = LibraryOwner(
      access.authority.tenantId,
      access.authority.actorId,
      access.authority.canonicalUserId,
    );
    final sources = libraryArray(
      data['sources'],
      50,
      (v) => LibraryItem.parse(v, owner),
    );
    final links = libraryArray(data['sourceLinks'], 50, (v) {
      final link = libraryMap(v);
      libraryText(link['libraryItemId']);
      libraryText(link['versionId']);
      libraryHash(link['contentSha256']);
      libraryRequire(
        [
          'current',
          'processing',
          'changed',
          'unavailable',
        ].contains(link['status']),
      );
      return link;
    });
    libraryRequire(
      links.map((l) => l['libraryItemId']).toSet().length == links.length,
    );
    for (final item in sources) {
      libraryRequire(links.any((l) => l['libraryItemId'] == item.id));
      if (projectId == null) libraryRequire(privateRoleSource(item));
    }
    _check();
    return CsmSnapshot(libraryFreeze(data), sources);
  }

  bool privateRoleSource(LibraryItem item) =>
      item.scope['visibility'] == 'user_private' &&
      item.scope['permissionBasis'] == 'owner' &&
      [
        'projectId',
        'workspaceId',
        'missionId',
        'workItemId',
      ].every((key) => item.scope[key] == null);
  Future<CsmSnapshot> write(
    String? projectId,
    CsmJson body, {
    String method = 'PUT',
    bool source = false,
  }) async {
    _check();
    final target = '${path(projectId)}${source ? '/sources' : ''}';
    if (_pending != null &&
        (_pending!.path != target ||
            _pending!.method != method ||
            libraryCanonical(_pending!.body) != libraryCanonical(body)))
      throw const ApiException(
        'Resolve the previous save before making another change.',
      );
    _pending ??= (
      path: target,
      method: method,
      body: libraryFreeze(body),
      key:
          'csm-native:${List.generate(24, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}',
    );
    return retry(projectId);
  }

  Future<CsmSnapshot> retry(String? projectId) async {
    _check();
    final p = _pending!;
    final headers = <String, dynamic>{'Idempotency-Key': p.key};
    try {
      final data = await (switch (p.method) {
        'POST' => access.api.postJsonAuthorized(
          p.path,
          authority: access.authority,
          data: p.body,
          headers: headers,
        ),
        'DELETE' => access.api.deleteJsonAuthorized(
          p.path,
          authority: access.authority,
          data: p.body,
          headers: headers,
        ),
        _ => access.api.putJsonAuthorized(
          p.path,
          authority: access.authority,
          data: p.body,
          headers: headers,
        ),
      }).timeout(const Duration(seconds: 35));
      _check();
      await _receipt(data, role: projectId == null, mutation: true, key: p.key);
      final snapshot = _snapshot(data, projectId);
      _pending = null;
      return snapshot;
    } on ApiException catch (error) {
      if (const [400, 401, 403, 404, 409, 422].contains(error.statusCode))
        _pending = null;
      rethrow;
    }
  }

  void discardPending() {
    _check();
    _pending = null;
  }

  Future<({String id, String name})> createClientAgent() async {
    _check();
    _agentCreationKey ??=
        'csm-agent:${List.generate(24, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
    final data = await access.api
        .postJsonAuthorized(
          '/api/agents',
          authority: access.authority,
          data: csmAgentTemplate(),
          headers: {'Idempotency-Key': _agentCreationKey},
        )
        .timeout(const Duration(seconds: 35));
    _check();
    final agent = libraryMap(data['agent']);
    libraryRequire(
      agent['name'] == 'Client Success Partner' &&
          agent['status'] == 'ready' &&
          agent['approvalPolicy'] == 'read_only' &&
          agent['memoryScope'] == 'project',
    );
    final result = (
      id: libraryText(agent['id']),
      name: 'Client Success Partner',
    );
    _agentCreationKey = null;
    return result;
  }

  Future<({String id, String name})?> clientAgent() async {
    final data = await _read('/api/agents?ownerScope=exact');
    final agents = libraryArray(data['agents'], 1000, libraryMap);
    for (final agent in agents) {
      if (agent['name'] == 'Client Success Partner') {
        if (agent['status'] != 'ready' || agent['selectable'] == false)
          throw const ApiException(
            'Client Success Partner is paused or unavailable. Open Agents to review it.',
          );
        return (id: libraryText(agent['id']), name: 'Client Success Partner');
      }
    }
    return null;
  }
}
