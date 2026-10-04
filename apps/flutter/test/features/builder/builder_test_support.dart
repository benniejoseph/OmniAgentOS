import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/builder/builder_contracts.dart';
import 'package:asael/features/builder/builder_recovery_store.dart';
import 'package:asael/features/builder/builder_repository.dart';
import 'package:dio/dio.dart';

const builderProject = 'project:東京/full%2F';
const builderApi = 'https://builder.example.test';
const builderUser = '11111111-1111-4111-8111-111111111111';
const builderOtherUser = '22222222-2222-4222-8222-222222222222';
String repeated(String char, int count) => List.filled(count, char).join();
String buildId(String kind, [String char = 'a']) =>
    'app_build_${kind == 'session' ? '' : '${kind}_'}${repeated(char, 48)}';
String sha([String char = 'a']) => repeated(char, 64);
const builderTime = '2026-10-04T10:00:00.000Z';
AppSession builderSession({
  String user = builderUser,
  String role = 'operator',
  String tenant = 'tenant',
  String actor = 'owner@example.test',
}) => AppSession(
  tenantId: tenant,
  actorId: actor,
  userId: user,
  email: 'owner@example.test',
  displayName: 'Test',
  workspaceName: 'Test',
  role: role,
);
BuilderOwner testBuilderOwner({
  String user = builderUser,
  String role = 'operator',
  String api = builderApi,
  String tenant = 'tenant',
  String actor = 'owner@example.test',
}) => BuilderOwner.fromSession(
  builderSession(user: user, role: role, tenant: tenant, actor: actor),
  api,
)!;
BuilderJson sessionJson({
  String project = builderProject,
  String? id,
  int revision = 2,
  String status = 'ready',
}) => {
  'id': id ?? buildId('session'),
  'projectId': project,
  'contractVersion': 'app-builder-session:1',
  'templateId': 'nextjs-starter-v1',
  'status': status,
  'revision': revision,
  'currentCheckpointId': buildId('checkpoint'),
  'createdAt': builderTime,
  'updatedAt': builderTime,
};
BuilderJson evidenceJson() => {
  'status': 'retired',
  'captures': <Object?>[],
  'replacement': {
    'mode': 'deterministic',
    'version': 1,
    'phase': 'checkpoint',
    'status': 'passed',
    'summary': 'Deterministic checks completed.',
    'signals': [
      {'name': 'lint', 'status': 'passed'},
      {'name': 'typecheck', 'status': 'passed'},
    ],
  },
};
BuilderJson recordJson(
  String kind, {
  String char = 'a',
  String? session,
  String project = builderProject,
}) {
  final base = <String, dynamic>{
    'id': buildId(kind, char),
    'projectId': project,
    'sessionId': session ?? buildId('session'),
    'contractVersion': 'app-builder-$kind:1',
    'createdAt': builderTime,
    'updatedAt': builderTime,
  };
  final deliveryEvidence = {
    'logs': {'status': 'captured', 'sha256': sha(), 'eventCount': 1},
    'routeEvidence': {
      'status': 'passed',
      'routes': [
        {
          'path': '/',
          'status': 'passed',
          'durationMs': 12,
          'statusCode': 200,
          'bodySha256': sha(),
        },
      ],
    },
    'browserEvidence': evidenceJson(),
  };
  return switch (kind) {
    'checkpoint' => {
      ...base,
      'workspaceSha256': sha(),
      'fileCount': 2,
      'snapshotBytes': 123,
      'sessionRevision': 2,
      'reason': 'manual',
      'label': 'Saved checkpoint',
    },
    'verification' => {
      ...base,
      'checkpointId': buildId('checkpoint'),
      'workspaceSha256': sha(),
      'status': 'passed',
      'checks': [
        for (final command in ['lint', 'typecheck'])
          {
            'command': command,
            'status': 'passed',
            'exitCode': 0,
            'durationMs': 12,
            'outputSha256': sha(),
          },
      ],
      'browserEvidence': evidenceJson(),
    },
    'repository' => {
      ...base,
      'repositoryId': '123',
      'repositoryFullName': 'owner/repository',
      'private': true,
      'defaultBranch': 'main',
      'baseSha': repeated('b', 40),
      'revision': 3,
    },
    'delivery' => {
      ...base,
      'repositoryBindingId': buildId('repository'),
      'checkpointId': buildId('checkpoint'),
      'verificationId': buildId('verification'),
      'workspaceSha256': sha(),
      'baseSha': repeated('b', 40),
      'secretScanSha256': sha('c'),
      'secretFindingCount': 0,
      'branchName': 'review/native-build',
      'status': 'pull_request_open',
      'pullRequestUrl': 'https://github.com/owner/repository/pull/1',
    },
    'deployment' => {
      ...base,
      'checkpointId': buildId('checkpoint'),
      'verificationId': buildId('verification'),
      'workspaceSha256': sha(),
      'fileManifestSha256': sha(),
      'secretScanSha256': sha('c'),
      'fileCount': 2,
      'byteCount': 123,
      'smokeRoutes': ['/'],
      'status': 'ready',
      'providerDeploymentId': 'provider-preview',
      'deploymentUrl': 'https://preview.example.test',
      ...deliveryEvidence,
    },
    'release' => {
      ...base,
      'deploymentId': buildId('deployment'),
      'previewProviderDeploymentId': 'provider-preview',
      'workspaceSha256': sha(),
      'previewEvidenceSha256': sha(),
      'releaseDigest': sha('d'),
      'status': 'review_pending',
      'expiresAt': '2026-10-04T11:00:00.000Z',
      'migrationEvidence': {
        'status': 'not_declared',
        'fileCount': 0,
        'manifestSha256': sha(),
      },
      'rollbackEvidence': {'status': 'first_release'},
      ...deliveryEvidence,
    },
    _ => throw StateError('Unknown test record $kind'),
  };
}

BuilderJson activityJson({String verdict = 'passed', String char = 'a'}) => {
  'id': buildId('event', char),
  'sessionId': buildId('session'),
  'eventType': 'app_builder.sentinel.reviewed',
  'occurredAt': builderTime,
  'payloadSha256': sha(),
  'detail': {
    'verificationId': buildId('verification'),
    'checkpointId': buildId('checkpoint'),
    'workspaceSha256': sha(),
    'verdict': verdict,
  },
};
BuilderJson snapshotJson({bool empty = false}) => {
  'session': empty ? null : sessionJson(),
  'activity': empty ? [] : [activityJson()],
  'checkpoints': empty ? [] : [recordJson('checkpoint')],
  'verifications': empty ? [] : [recordJson('verification')],
  'repositoryBinding': empty ? null : recordJson('repository'),
  'repositoryWorkspace': null,
  'deliveries': empty ? [] : [recordJson('delivery')],
  'deployments': empty ? [] : [recordJson('deployment')],
  'releases': empty ? [] : [recordJson('release')],
  'github': {'configured': true, 'missing': <String>[]},
  'vercel': {'configured': true, 'missing': <String>[]},
  'previewUrl': empty
      ? null
      : 'https://sandbox.example.test/?token=do-not-persist',
};
BuilderJson fileJson({
  String path = 'app/page.tsx',
  String content = 'export default () => null;',
  String hash = 'a',
}) => {
  'path': path,
  'content': content,
  'sha256': sha(hash),
  'size': content.length,
};
BuilderJson receiptJson(String action) {
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
  return {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': 'app.projects.builder.$action',
    'action': 'run.agent',
    'resourceType': 'app_builder_$resource',
    'accessMode': 'mutation',
    'eventContract': 'app-builder-events.v1',
    'authoritySha256': sha(),
    'idempotencyKeySha256': sha('b'),
    'outcomeSha256': sha('c'),
    'resourceCount': 1,
    'occurredAt': builderTime,
    'receiptSha256': sha('e'),
  };
}

BuilderJson responseJson(BuilderJson input) {
  final action = input['action'];
  final output = <String, dynamic>{
    'serviceReceipt': receiptJson(action as String),
  };
  if (action == 'command.run') {
    return {
      ...output,
      'result': {
        'exitCode': 0,
        'durationMs': 12,
        'stdout': 'passed',
        'stderr': '',
      },
    };
  }
  if (action == 'file.update') {
    return {
      ...output,
      'session': sessionJson(revision: 3),
      'update': {
        'path': input['path'],
        'previousSha256': input['expectedSha256'],
        'sha256': sha('b'),
        'size': (input['content'] as String).length,
      },
    };
  }
  if (action == 'file.delete') {
    return {
      ...output,
      'session': sessionJson(revision: 3),
      'deletion': {
        'path': input['path'],
        'previousSha256': input['expectedSha256'],
      },
    };
  }
  final kind = switch (action) {
    'verification.run' => 'verification',
    'repository.bind' => 'repository',
    'delivery.create' => 'delivery',
    'deployment.preview' || 'deployment.refresh' => 'deployment',
    'release.preview' || 'release.production' || 'release.refresh' => 'release',
    _ => null,
  };
  if (kind != null) {
    return {
      ...output,
      (kind == 'repository' ? 'repositoryBinding' : kind): recordJson(kind),
    };
  }
  return {
    ...output,
    'session': sessionJson(status: action == 'stop' ? 'stopped' : 'ready'),
  };
}

class TestBuilderRepository implements BuilderRepository {
  TestBuilderRepository({BuilderOwner? owner})
    : access = BuilderAccess(owner: owner ?? testBuilderOwner(), ready: true);
  @override
  final BuilderAccess access;
  bool current = true;
  BuilderJson data = snapshotJson(), source = fileJson();
  final List<BuilderJson> submissions = [];
  final List<String> keys = [], paths = [];
  int reads = 0;
  Future<BuilderSnapshot> Function()? snapshotReader;
  Future<BuilderFile> Function(String)? fileReader;
  Future<BuilderJson> Function(BuilderJson, String)? mutation;
  @override
  bool authorityCurrent() => current && access.readable;
  @override
  Future<BuilderSnapshot> snapshot(String project, CancelToken cancel) async {
    reads++;
    return snapshotReader != null
        ? snapshotReader!()
        : BuilderSnapshot.parse(data, project, access.owner!.apiScope);
  }

  @override
  Future<List<BuilderTreeEntry>> tree(
    String project,
    String session,
    CancelToken cancel, {
    String? query,
  }) async => [const BuilderTreeEntry('app/page.tsx', 'file', 25)];
  @override
  Future<BuilderFile> file(
    String project,
    String session,
    String path,
    CancelToken cancel,
  ) async {
    paths.add(path);
    return fileReader != null
        ? fileReader!(path)
        : BuilderFile.parse({...source, 'path': path}, path);
  }

  @override
  Future<List<BuilderRepositoryChoice>> repositories(
    String project,
    CancelToken cancel,
  ) async => [
    BuilderRepositoryChoice.parse({
      'repositoryId': '123',
      'fullName': 'owner/repository',
      'private': true,
      'defaultBranch': 'main',
    }),
  ];
  @override
  Future<BuilderJson> mutate(
    String project,
    BuilderJson frozen,
    String key,
  ) async {
    submissions.add(frozen);
    keys.add(key);
    return mutation != null ? mutation!(frozen, key) : responseJson(frozen);
  }
}

class TestRecoveryStore extends MemoryBuilderRecoveryStore {
  Future<void> Function(BuilderJson)? beforeWrite;
  bool failRead = false, failWrite = false;
  final List<BuilderJson> writes = [];
  @override
  Future<BuilderJson?> read(BuilderOwner owner, String project) async {
    if (failRead) throw StateError('Protected storage is locked.');
    return super.read(owner, project);
  }

  @override
  Future<void> write(
    BuilderOwner owner,
    String project,
    BuilderJson value, {
    required bool Function() isCurrent,
  }) async {
    await beforeWrite?.call(value);
    if (failWrite) throw StateError('Protected storage is full.');
    await super.write(owner, project, value, isCurrent: isCurrent);
    writes.add(freezeBuilder(value) as BuilderJson);
  }
}
