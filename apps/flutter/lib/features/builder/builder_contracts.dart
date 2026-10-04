import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../auth/domain/app_session.dart';

typedef BuilderJson = Map<String, dynamic>;
void builderRequire(
  bool condition, [
  String message = 'The Builder response is invalid or incomplete.',
]) {
  if (!condition) {
    throw FormatException(message);
  }
}

BuilderJson builderMap(Object? value) {
  builderRequire(value is Map && value.keys.every((key) => key is String));
  return Map<String, dynamic>.from(value as Map);
}

Object? freezeBuilder(Object? value, [int depth = 0]) {
  builderRequire(depth <= 20, 'Builder data exceeds the nesting bound.');
  if (value is Map) {
    return Map<String, dynamic>.unmodifiable(
      builderMap(value)
          .map((key, item) => MapEntry(key, freezeBuilder(item, depth + 1))),
    );
  }
  if (value is List) {
    return List<Object?>.unmodifiable(
      value.map((item) => freezeBuilder(item, depth + 1)),
    );
  }
  builderRequire(
    value == null ||
        value is String ||
        value is bool ||
        value is num && value.isFinite,
  );
  return value;
}

String builderText(Object? value, {int max = 1000, bool empty = false}) {
  builderRequire(
    value is String &&
        value.length <= max &&
        (empty || value.trim().isNotEmpty),
  );
  return value as String;
}

String builderId(Object? value, String kind) {
  final result = builderText(value, max: 240);
  if (kind != 'project' && kind != 'activity') {
    builderRequire(
      RegExp('^app_build_${kind == 'session' ? '' : '${kind}_'}[a-f0-9]{48}\$')
          .hasMatch(result),
      'The exact Builder $kind identity is invalid.',
    );
  } else if (kind == 'project') {
    builderRequire(result.length <= 200 && result.trim() == result);
  }
  return result;
}

String builderHash(Object? value, {bool git = false}) {
  final text = builderText(value, max: 64);
  builderRequire(
    RegExp(git ? r'^(?:[a-f0-9]{40}|[a-f0-9]{64})$' : r'^[a-f0-9]{64}$')
        .hasMatch(text),
  );
  return text;
}

int builderInt(
  Object? value, {
  int minimum = 0,
  int maximum = 9007199254740991,
}) {
  builderRequire(value is int && value >= minimum && value <= maximum);
  return value as int;
}

String builderMember(Object? value, Iterable<String> values) {
  builderRequire(value is String && values.contains(value));
  return value as String;
}

DateTime builderDate(Object? value) {
  final text = builderText(value, max: 64);
  final match = RegExp(
    r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$',
  ).firstMatch(text);
  builderRequire(match != null);
  final parts = [
    for (var index = 1; index <= 6; index++) int.parse(match!.group(index)!),
  ];
  builderRequire(
    parts[1] >= 1 &&
        parts[1] <= 12 &&
        parts[2] >= 1 &&
        parts[2] <= DateTime.utc(parts[0], parts[1] + 1, 0).day &&
        parts[3] < 24 &&
        parts[4] < 60 &&
        parts[5] < 60,
  );
  final zone = match!.group(7)!;
  builderRequire(
    zone == 'Z' ||
        int.parse(zone.substring(1, 3)) < 24 &&
            int.parse(zone.substring(4, 6)) < 60,
  );
  final result = DateTime.tryParse(text);
  builderRequire(result != null);
  return result!.toUtc();
}

List<T> builderList<T>(
  Object? value,
  int maximum,
  T Function(BuilderJson) parse,
) {
  builderRequire(value is List && value.length <= maximum);
  return List<T>.unmodifiable(
    (value as List).map((item) => parse(builderMap(item))),
  );
}

String builderPath(Object? value) {
  final path = builderText(value, max: 240);
  builderRequire(
    !path.startsWith('/') &&
        !path.contains('\\') &&
        !path.contains('\u0000') &&
        !path
            .split('/')
            .any((part) => part == '..' || part == '.' || part.isEmpty),
  );
  return path;
}

Uri? builderExternalUri(Object? value, {String? apiOrigin}) {
  if (value is! String ||
      value.length > 8192 ||
      value.trim() != value ||
      RegExp(r'[\x00-\x20\x7f]').hasMatch(value)) {
    return null;
  }
  final uri = Uri.tryParse(value);
  if (uri == null ||
      uri.scheme != 'https' ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty) {
    return null;
  }
  if (apiOrigin != null && uri.origin == Uri.parse(apiOrigin).origin) {
    return null;
  }
  return uri;
}

String builderApiScope(String value) {
  final uri = Uri.tryParse(value);
  builderRequire(
    uri != null &&
        const {'https', 'http'}.contains(uri.scheme) &&
        uri.host.isNotEmpty &&
        uri.userInfo.isEmpty &&
        !uri.hasQuery &&
        !uri.hasFragment,
    'The Builder API deployment is invalid.',
  );
  return uri!
      .replace(
        host: uri.host.toLowerCase(),
        path: uri.path.replaceFirst(RegExp(r'/+$'), ''),
      )
      .toString();
}

@immutable
class BuilderOwner {
  const BuilderOwner({
    required this.userId,
    required this.tenantId,
    required this.actorId,
    required this.role,
    required this.apiScope,
  });
  final String userId, tenantId, actorId, role, apiScope;
  static BuilderOwner? fromSession(AppSession? session, String api) {
    if (session == null ||
        !RegExp(
          r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
        ).hasMatch(session.userId) ||
        session.tenantId.isEmpty ||
        session.actorId.isEmpty ||
        !const {
          'viewer',
          'operator',
          'admin',
          'system',
        }.contains(session.role)) {
      return null;
    }
    return BuilderOwner(
      userId: session.userId.toLowerCase(),
      tenantId: session.tenantId,
      actorId: session.actorId,
      role: session.role,
      apiScope: builderApiScope(api),
    );
  }

  String get key => jsonEncode([userId, tenantId, actorId, role, apiScope]);
  bool get canRun => const {'operator', 'admin', 'system'}.contains(role);
}

class BuilderSession {
  BuilderSession._(this.raw);
  final BuilderJson raw;
  factory BuilderSession.parse(BuilderJson value, String projectId) {
    builderRequire(
      value['projectId'] == projectId &&
          value['contractVersion'] == 'app-builder-session:1',
    );
    builderId(value['id'], 'session');
    builderInt(value['revision'], minimum: 1);
    builderMember(value['status'], [
      'provisioning',
      'ready',
      'running',
      'failed',
      'stopped',
    ]);
    builderText(value['templateId'], max: 120);
    builderDate(value['updatedAt']);
    builderDate(value['createdAt']);
    if (value['currentCheckpointId'] != null) {
      builderId(value['currentCheckpointId'], 'checkpoint');
    }
    return BuilderSession._(freezeBuilder(value) as BuilderJson);
  }
  String get id => raw['id'] as String;
  String get status => raw['status'] as String;
  String get projectId => raw['projectId'] as String;
  int get revision => raw['revision'] as int;
  String? get checkpointId => raw['currentCheckpointId'] as String?;
  bool get running => const {'ready', 'running'}.contains(status);
}

class BuilderFile {
  BuilderFile._(this.path, this.content, this.sha256, this.size);
  final String path, content, sha256;
  final int size;
  factory BuilderFile.parse(BuilderJson value, String requested) {
    builderRequire(
      value['path'] == requested,
      'The file response changed the exact requested path.',
    );
    builderPath(value['path']);
    builderText(value['content'], max: 500000, empty: true);
    final range = value['lineRange'];
    if (range != null) {
      builderRequire(
        builderMap(range)['truncated'] == false,
        'A partial file cannot be edited.',
      );
    }
    return BuilderFile._(
      requested,
      value['content'] as String,
      builderHash(value['sha256']),
      builderInt(value['size'], maximum: 4000000),
    );
  }
  BuilderJson get json => {
    'path': path,
    'content': content,
    'sha256': sha256,
    'size': size,
  };
}

class BuilderRecord {
  BuilderRecord._(this.kind, this.raw);
  final String kind;
  final BuilderJson raw;
  String get id => raw['id'] as String;
  String get status => raw['status'] as String? ?? '';
  String text(String field) => raw[field] as String? ?? '';
  int number(String field) => raw[field] as int? ?? 0;
  BuilderJson object(String field) => builderMap(raw[field]);
  factory BuilderRecord.parse(
    BuilderJson value,
    String kind,
    String projectId,
    String sessionId,
  ) {
    builderId(value['id'], kind);
    builderRequire(
      value['sessionId'] == sessionId,
      'Builder history belongs to a different sandbox.',
    );
    if (kind != 'activity') {
      builderRequire(
        value['projectId'] == projectId &&
            value['contractVersion'] == 'app-builder-$kind:1',
      );
    }
    for (final field in [
      'providerDeploymentId',
      'providerState',
      'failureCode',
      'lastErrorCode',
      'sourceRunId',
    ]) {
      if (value[field] != null) {
        builderText(value[field], max: 240);
      }
    }
    switch (kind) {
      case 'activity':
        builderText(value['eventType'], max: 200);
        builderDate(value['occurredAt']);
        builderHash(value['payloadSha256']);
        builderMap(value['detail']);
      case 'checkpoint':
        builderHash(value['workspaceSha256']);
        builderInt(value['fileCount']);
        builderInt(value['snapshotBytes']);
        builderInt(value['sessionRevision'], minimum: 1);
        builderMember(value['reason'], [
          'manual',
          'before_forge',
          'after_forge',
          'before_sentinel',
          'before_restore',
        ]);
        builderText(value['label'], max: 120);
        builderDate(value['createdAt']);
        if (value['expiresAt'] != null) {
          builderDate(value['expiresAt']);
        }
      case 'verification':
        builderId(value['checkpointId'], 'checkpoint');
        builderHash(value['workspaceSha256']);
        builderMember(value['status'], ['passed', 'failed', 'incomplete']);
        builderDate(value['createdAt']);
        final checks = builderList(value['checks'], 2, (row) {
          builderMember(row['command'], ['lint', 'typecheck']);
          builderMember(row['status'], ['passed', 'failed']);
          builderInt(row['exitCode'], minimum: -2147483648);
          builderInt(row['durationMs']);
          builderHash(row['outputSha256']);
          return row;
        });
        builderRequire(
          checks.map((row) => row['command']).toSet().length == checks.length,
        );
        _browserEvidence(value['browserEvidence']);
      case 'repository':
        builderRequire(
          RegExp(r'^\d{1,24}$').hasMatch(builderText(value['repositoryId'])),
        );
        builderText(value['repositoryFullName']);
        builderText(value['defaultBranch'], max: 240);
        builderRequire(value['private'] is bool);
        builderHash(value['baseSha'], git: true);
        builderInt(value['revision'], minimum: 1);
        builderDate(value['updatedAt']);
      case 'delivery':
        builderId(value['repositoryBindingId'], 'repository');
        builderId(value['checkpointId'], 'checkpoint');
        builderId(value['verificationId'], 'verification');
        builderHash(value['workspaceSha256']);
        builderHash(value['baseSha'], git: true);
        builderHash(value['secretScanSha256']);
        builderInt(value['secretFindingCount']);
        builderText(value['branchName'], max: 120);
        builderMember(value['status'], [
          'preparing',
          'pull_request_open',
          'failed',
        ]);
        builderDate(value['createdAt']);
        builderDate(value['updatedAt']);
        if (value['commitSha'] != null) {
          builderHash(value['commitSha'], git: true);
        }
      case 'deployment':
        builderId(value['checkpointId'], 'checkpoint');
        builderId(value['verificationId'], 'verification');
        for (final field in [
          'workspaceSha256',
          'fileManifestSha256',
          'secretScanSha256',
        ]) {
          builderHash(value[field]);
        }
        builderInt(value['fileCount']);
        builderInt(value['byteCount']);
        builderMember(value['status'], [
          'preparing',
          'queued',
          'building',
          'verifying',
          'ready',
          'incomplete',
          'failed',
        ]);
        builderRequire(
          value['smokeRoutes'] is List &&
              (value['smokeRoutes'] as List).length <= 100,
        );
        for (final route in value['smokeRoutes'] as List) {
          builderText(route, max: 240);
        }
        _deliveryEvidence(value);
        builderDate(value['createdAt']);
        builderDate(value['updatedAt']);
      case 'release':
        builderId(value['deploymentId'], 'deployment');
        builderText(value['previewProviderDeploymentId']);
        for (final field in [
          'workspaceSha256',
          'previewEvidenceSha256',
          'releaseDigest',
        ]) {
          builderHash(value[field]);
        }
        builderMember(value['status'], [
          'review_pending',
          'releasing',
          'building',
          'healthy',
          'incomplete',
          'failed',
          'expired',
        ]);
        final migration = builderMap(value['migrationEvidence']),
            rollback = builderMap(value['rollbackEvidence']);
        builderMember(migration['status'], ['not_declared', 'declared']);
        builderInt(migration['fileCount']);
        builderHash(migration['manifestSha256']);
        builderMember(rollback['status'], ['available', 'first_release']);
        if (rollback['status'] == 'available') {
          builderText(rollback['providerDeploymentId']);
        }
        _deliveryEvidence(value);
        builderDate(value['createdAt']);
        builderDate(value['updatedAt']);
        builderDate(value['expiresAt']);
      default:
        throw const FormatException('Unsupported Builder record kind.');
    }
    return BuilderRecord._(kind, freezeBuilder(value) as BuilderJson);
  }
}

void _browserEvidence(Object? value) {
  final evidence = builderMap(value);
  builderMember(evidence['status'], [
    'pending',
    'captured',
    'unavailable',
    'failed',
    'retired',
  ]);
  builderList(evidence['captures'], 10, (row) {
    builderMember(row['viewport'], ['desktop', 'mobile']);
    builderInt(row['width'], minimum: 1);
    builderInt(row['height'], minimum: 1);
    builderHash(row['screenshotSha256']);
    builderText(row['mimeType'], max: 120);
    builderInt(row['byteLength']);
    return row;
  });
  if (evidence['replacement'] != null) {
    final replacement = builderMap(evidence['replacement']);
    builderRequire(
      replacement['mode'] == 'deterministic' && replacement['version'] == 1,
    );
    builderMember(replacement['phase'], ['checkpoint', 'preview', 'release']);
    builderMember(replacement['status'], ['pending', 'passed', 'failed']);
    builderText(replacement['summary'], max: 4000);
    builderList(replacement['signals'], 4, (row) {
      builderMember(row['name'], [
        'lint',
        'typecheck',
        'build_logs',
        'route_smokes',
      ]);
      builderMember(row['status'], ['pending', 'passed', 'failed']);
      return row;
    });
  }
}

void _deliveryEvidence(BuilderJson value) {
  final logs = builderMap(value['logs']),
      routes = builderMap(value['routeEvidence']);
  builderMember(logs['status'], ['pending', 'captured', 'unavailable']);
  builderInt(logs['eventCount']);
  if (logs['sha256'] != null) {
    builderHash(logs['sha256']);
  }
  builderMember(routes['status'], ['pending', 'passed', 'failed']);
  builderList(routes['routes'], 100, (row) {
    builderText(row['path'], max: 240);
    builderMember(row['status'], ['passed', 'failed']);
    builderInt(row['durationMs']);
    if (row['statusCode'] != null) {
      builderInt(row['statusCode'], minimum: 100, maximum: 599);
    }
    if (row['bodySha256'] != null) {
      builderHash(row['bodySha256']);
    }
    return row;
  });
  _browserEvidence(value['browserEvidence']);
}

class BuilderSnapshot {
  BuilderSnapshot._({
    required this.session,
    required this.histories,
    required this.github,
    required this.vercel,
    this.repository,
    this.repositoryWorkspace,
    this.preview,
  });
  final BuilderSession? session;
  final Map<String, List<BuilderRecord>> histories;
  final BuilderJson github, vercel;
  final BuilderRecord? repository;
  final BuilderJson? repositoryWorkspace;
  final Uri? preview;
  List<BuilderRecord> records(String kind) => histories[kind] ?? const [];
  BuilderRecord? find(String kind, String? id) => id == null
      ? null
      : records(kind).where((record) => record.id == id).firstOrNull;
  BuilderRecord? get checkpoint => find('checkpoint', session?.checkpointId);
  bool passingSentinel(BuilderRecord verification) {
    // Activity is newest first. A newer BLOCK supersedes an older PASS.
    final review = records('activity').where((event) {
      final detail = event.object('detail');
      return event.text('eventType') == 'app_builder.sentinel.reviewed' &&
          detail['verificationId'] == verification.id &&
          detail['checkpointId'] == verification.text('checkpointId') &&
          detail['workspaceSha256'] == verification.text('workspaceSha256') &&
          const {'passed', 'blocked'}.contains(detail['verdict']);
    }).firstOrNull;
    return review?.object('detail')['verdict'] == 'passed';
  }

  BuilderRecord? get deliveryVerification => records('verification')
      .where(
        (record) =>
            record.status == 'passed' &&
            record.text('checkpointId') == session?.checkpointId &&
            record.text('workspaceSha256') ==
                checkpoint?.text('workspaceSha256') &&
            passingSentinel(record),
      )
      .firstOrNull;
  factory BuilderSnapshot.parse(
    BuilderJson value,
    String projectId,
    String apiOrigin,
  ) {
    final session = value['session'] == null
        ? null
        : BuilderSession.parse(builderMap(value['session']), projectId);
    final histories = <String, List<BuilderRecord>>{};
    for (final entry in const [
      ('activity', 'activity', 40),
      ('checkpoint', 'checkpoints', 20),
      ('verification', 'verifications', 10),
      ('delivery', 'deliveries', 20),
      ('deployment', 'deployments', 20),
      ('release', 'releases', 20),
    ]) {
      final rows = builderList(
        value[entry.$2],
        entry.$3,
        (row) =>
            BuilderRecord.parse(row, entry.$1, projectId, session?.id ?? ''),
      );
      builderRequire(
        rows.map((record) => record.id).toSet().length == rows.length,
        'Builder history has duplicate identities.',
      );
      histories[entry.$1] = rows;
    }
    final github = builderMap(value['github']),
        vercel = builderMap(value['vercel']);
    for (final status in [github, vercel]) {
      builderRequire(
        status['configured'] is bool &&
            status['missing'] is List &&
            (status['missing'] as List).length <= 30,
      );
      for (final key in status['missing'] as List) {
        builderText(key, max: 240);
      }
    }
    final repository = value['repositoryBinding'] == null
        ? null
        : BuilderRecord.parse(
            builderMap(value['repositoryBinding']),
            'repository',
            projectId,
            session?.id ?? '',
          );
    BuilderJson? workspace;
    if (value['repositoryWorkspace'] != null) {
      workspace = builderMap(value['repositoryWorkspace']);
      builderRequire(
        workspace['contractVersion'] == 'app-builder-repository-workspace:1',
      );
      builderText(workspace['repositoryId']);
      builderText(workspace['repositoryFullName']);
      builderHash(workspace['baseSha'], git: true);
      builderHash(workspace['workspaceSha256']);
      builderHash(workspace['archiveSha256']);
      builderInt(workspace['fileCount']);
      builderDate(workspace['importedAt']);
      workspace = freezeBuilder(workspace) as BuilderJson;
    }
    return BuilderSnapshot._(
      session: session,
      histories: Map.unmodifiable(histories),
      github: freezeBuilder(github) as BuilderJson,
      vercel: freezeBuilder(vercel) as BuilderJson,
      repository: repository,
      repositoryWorkspace: workspace,
      preview: builderExternalUri(value['previewUrl'], apiOrigin: apiOrigin),
    );
  }
}

class BuilderTreeEntry {
  const BuilderTreeEntry(this.path, this.kind, this.size);
  final String path, kind;
  final int? size;
  factory BuilderTreeEntry.parse(BuilderJson value) => BuilderTreeEntry(
    builderPath(value['path']),
    builderMember(value['kind'], ['file', 'directory']),
    value['size'] == null ? null : builderInt(value['size']),
  );
}

class BuilderRepositoryChoice {
  BuilderRepositoryChoice._(this.id, this.label, this.private, this.branch);
  final String id, label, branch;
  final bool private;
  factory BuilderRepositoryChoice.parse(BuilderJson value) {
    final id = builderText(value['repositoryId'], max: 24);
    builderRequire(
      RegExp(r'^\d{1,24}$').hasMatch(id) && value['private'] is bool,
    );
    return BuilderRepositoryChoice._(
      id,
      builderText(value['fullName'], max: 240),
      value['private'] as bool,
      builderText(value['defaultBranch'], max: 240),
    );
  }
}

enum BuilderOutcomeState { prepared, accepted, rejected, uncertain }

class BuilderOutcome {
  BuilderOutcome({
    required this.key,
    required this.submitted,
    required this.at,
    required this.state,
    this.receipt,
    this.detail,
  });
  final String key;
  final BuilderJson submitted;
  final DateTime at;
  final BuilderOutcomeState state;
  final String? receipt, detail;
  String get action => submitted['action'] as String;
  BuilderOutcome change(
    BuilderOutcomeState next, {
    String? receipt,
    String? detail,
  }) => BuilderOutcome(
    key: key,
    submitted: submitted,
    at: at,
    state: next,
    receipt: receipt,
    detail: detail,
  );
  BuilderJson get json => {
    'key': key,
    'submitted': submitted,
    'at': at.toIso8601String(),
    'state': state.name,
    if (receipt != null) 'receipt': receipt,
    if (detail != null) 'detail': detail,
  };
  factory BuilderOutcome.parse(BuilderJson value) {
    final state = builderMember(
      value['state'],
      BuilderOutcomeState.values.map((state) => state.name),
    );
    final submitted = builderMap(value['submitted']);
    validateBuilderAction(submitted);
    return BuilderOutcome(
      key: builderText(value['key'], max: 240),
      submitted: freezeBuilder(submitted) as BuilderJson,
      at: builderDate(value['at']),
      state: state == 'prepared'
          ? BuilderOutcomeState.uncertain
          : BuilderOutcomeState.values.firstWhere((item) => item.name == state),
      receipt: value['receipt'] == null ? null : builderHash(value['receipt']),
      detail: value['detail'] == null
          ? null
          : builderText(value['detail'], max: 4000),
    );
  }
}

void validateBuilderAction(BuilderJson value) {
  final action = builderText(value['action'], max: 50);
  const specs = {
    'create': <String>[],
    'stop': ['sessionId'],
    'file.update': ['sessionId', 'path', 'expectedSha256', 'content'],
    'file.delete': ['sessionId', 'path', 'expectedSha256'],
    'command.run': ['sessionId', 'command'],
    'checkpoint.create': [
      'sessionId',
      'expectedSessionRevision',
      'reason',
      'label',
    ],
    'checkpoint.restore': [
      'sessionId',
      'checkpointId',
      'expectedSessionRevision',
    ],
    'verification.run': [
      'sessionId',
      'checkpointId',
      'expectedSessionRevision',
    ],
    'repository.bind': ['sessionId', 'repositoryId'],
    'repository.checkout': [
      'sessionId',
      'repositoryBindingId',
      'expectedBindingRevision',
      'expectedSessionRevision',
    ],
    'delivery.create': [
      'sessionId',
      'repositoryBindingId',
      'expectedBindingRevision',
      'checkpointId',
      'verificationId',
      'branchName',
      'title',
      'body',
      'draft',
    ],
    'deployment.preview': ['sessionId', 'checkpointId', 'verificationId'],
    'deployment.refresh': ['sessionId', 'deploymentId'],
    'release.preview': ['sessionId', 'deploymentId'],
    'release.production': [
      'sessionId',
      'releaseId',
      'releaseDigest',
      'confirmation',
    ],
    'release.refresh': ['sessionId', 'releaseId'],
  };
  final candidate = specs[action];
  builderRequire(
    candidate != null,
    'This native Builder action is unsupported.',
  );
  final spec = candidate!;
  builderRequire(
    value.keys.toSet().difference({'action', ...spec}).isEmpty &&
        spec.every(value.containsKey),
    'The exact Builder action fields are incomplete.',
  );
  for (final field in spec) {
    final raw = value[field];
    switch (field) {
      case 'sessionId':
        builderId(raw, 'session');
      case 'checkpointId':
        builderId(raw, 'checkpoint');
      case 'verificationId':
        builderId(raw, 'verification');
      case 'repositoryBindingId':
        builderId(raw, 'repository');
      case 'deploymentId':
        builderId(raw, 'deployment');
      case 'releaseId':
        builderId(raw, 'release');
      case 'expectedSessionRevision':
      case 'expectedBindingRevision':
        builderInt(raw, minimum: 1);
      case 'expectedSha256':
      case 'releaseDigest':
        builderHash(raw);
      case 'path':
        builderPath(raw);
      case 'content':
        builderText(raw, max: 500000, empty: true);
      case 'command':
        builderMember(raw, [
          'lint',
          'typecheck',
          'test',
          'build',
          'start_preview',
        ]);
      case 'reason':
        builderRequire(raw == 'manual');
      case 'label':
        builderText(raw, max: 120);
      case 'repositoryId':
        builderRequire(
          RegExp(r'^\d{1,24}$').hasMatch(builderText(raw, max: 24)),
        );
      case 'branchName':
        builderText(raw, max: 120);
      case 'title':
        builderRequire(builderText(raw, max: 180).trim().length >= 3);
      case 'body':
        builderText(raw, max: 8000, empty: true);
      case 'draft':
        builderRequire(raw == true);
      case 'confirmation':
        builderRequire(raw == 'RELEASE');
      default:
        throw const FormatException('Unknown Builder request field.');
    }
  }
}
