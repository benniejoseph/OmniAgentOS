import 'dart:async';
import 'dart:collection';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/projects/projects.dart';
import 'package:asael/features/projects/projects_api_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'projects_fixture.dart';

void main() {
  test(
    'fresh reads preserve encoded identities and the caller cancellation token',
    () async {
      final setup = fixture();
      final cancel = CancelToken();
      setup.api.gets.add(() async => {'project': projectJson()});
      final project = await setup.repository.detailFresh(projectId, cancel);
      expect(project.id, projectId);
      expect(
        setup.api.reads.single.path,
        '/api/projects/${Uri.encodeComponent(projectId)}',
      );
      expect(setup.api.reads.single.cancel, same(cancel));
      expect(setup.api.reads.single.query, isNull);
      expect(setup.api.reads.single.headers, isNull);
      setup.api.gets.add(
        () async => {
          'projects': [projectJson()],
        },
      );
      expect((await setup.repository.list()).single.id, projectId);
      expect(setup.api.reads.last.path, '/api/projects');
      expect(setup.api.effects, isEmpty);
    },
  );
  test(
    'wrong project and tenant reads are rejected before admitting writes',
    () async {
      final setup = fixture();
      setup.api.gets.add(() async => {'project': projectJson(id: 'other')});
      await expectLater(
        setup.repository.detail(projectId),
        throwsFormatException,
      );
      setup.api.gets.add(
        () async => {
          'project': {...projectJson(), 'tenantId': 'foreign'},
        },
      );
      await expectLater(
        setup.repository.detail(projectId),
        throwsFormatException,
      );
      await expectLater(
        setup.repository.update(projectId, {'status': 'completed'}),
        throwsStateError,
      );
      expect(setup.api.effects, isEmpty);
    },
  );
  test(
    'late canceled reads cannot seed the repository write authority cache',
    () async {
      final setup = fixture(),
          response = Completer<Json>(),
          cancel = CancelToken();
      setup.api.gets.add(() => response.future);
      final pending = setup.repository.detailFresh(projectId, cancel);
      cancel.cancel('Replaced by a newer read');
      response.complete({'project': projectJson()});
      await expectLater(pending, throwsFormatException);
      await expectLater(
        setup.repository.update(projectId, {'status': 'completed'}),
        throwsStateError,
      );
      expect(setup.api.effects, isEmpty);
    },
  );
  test(
    'retained-owner metadata stays readable but cannot authorize a write',
    () async {
      final setup = fixture();
      setup.api.gets.add(
        () async => {
          'project': {...projectJson(), 'actorId': 'previous-owner'},
        },
      );
      expect(
        (await setup.repository.detail(projectId)).actorId,
        'previous-owner',
      );
      await expectLater(
        setup.repository.update(projectId, {'status': 'archived'}),
        throwsStateError,
      );
      expect(setup.api.effects, isEmpty);
    },
  );
  test(
    'a pending write is frozen, exclusive, and checks the reviewed response',
    () async {
      final setup = fixture();
      await seed(setup);
      final response = Completer<Json>();
      setup.api.writes.add(() => response.future);
      final changes = <String, dynamic>{'status': 'completed'};
      final first = setup.repository.update(projectId, changes);
      changes['status'] = 'archived';
      await expectLater(
        setup.repository.update(projectId, {'status': 'archived'}),
        throwsStateError,
      );
      expect(setup.api.effects.single.body, {'status': 'completed'});
      expect(setup.api.effects.single.method, 'PATCH');
      expect(setup.api.effects.single.headers.keys, ['idempotency-key']);
      response.complete({
        'project': {...projectJson(), 'status': 'completed'},
      });
      expect((await first).status, 'completed');
      expect(setup.api.effects, hasLength(1));
    },
  );
  test('an uncertain exact retry retains its key; a mismatched receipt is not accepted', () async {
    final setup = fixture();
    await seed(setup);
    setup.api.writes.add(() async => {'project': projectJson()});
    await expectLater(
      setup.repository.update(projectId, {'status': 'completed'}),
      throwsFormatException,
    );
    final firstKey = setup.api.effects.single.headers['idempotency-key'];
    setup.api.writes.add(
      () async => {
        'project': {...projectJson(), 'status': 'completed'},
      },
    );
    await setup.repository.update(projectId, {'status': 'completed'});
    expect(setup.api.effects.last.headers['idempotency-key'], firstKey);
    setup.api.writes.add(
      () async => {
        'project': {...projectJson(), 'status': 'completed'},
      },
    );
    await setup.repository.update(projectId, {'status': 'completed'});
    expect(setup.api.effects.last.headers['idempotency-key'], isNot(firstKey));
  });
  test(
    '30 uncertain fingerprints fail closed without evicting an exact retry',
    () async {
      final setup = fixture();
      await seed(setup);
      for (var i = 0; i < 30; i++) {
        setup.api.writes.add(
          () async =>
              throw const ApiException('Synthetic unconfirmed transport'),
        );
        await expectLater(
          setup.repository.update(projectId, {'title': 'Reviewed $i'}),
          throwsA(isA<ApiException>()),
        );
      }
      final oldest = setup.api.effects.first.headers['idempotency-key'];
      await expectLater(
        setup.repository.update(projectId, {'title': 'New at capacity'}),
        throwsA(
          isA<StateError>().having(
            (e) => e.message,
            'recovery',
            contains('Retry an exact existing request'),
          ),
        ),
      );
      expect(setup.api.effects, hasLength(30));
      setup.api.writes.add(
        () async => {
          'project': {...projectJson(), 'title': 'Reviewed 0'},
        },
      );
      await setup.repository.update(projectId, {'title': 'Reviewed 0'});
      expect(setup.api.effects.last.headers['idempotency-key'], oldest);
      setup.api.writes.add(
        () async => {
          'project': {...projectJson(), 'title': 'New at capacity'},
        },
      );
      await setup.repository.update(projectId, {'title': 'New at capacity'});
      expect(setup.api.effects, hasLength(32));
    },
  );
  test('execution needs its exact returned project and collections, never a substitute GET', () async {
    final setup = fixture();
    await seed(setup);
    setup.api.writes.add(() async => {'project': projectJson()});
    await expectLater(
      setup.repository.execute(projectId, 'sync'),
      throwsFormatException,
    );
    expect(setup.api.reads, hasLength(1));
    final json = projectJson();
    setup.api.writes.add(
      () async => {
        'project': json,
        'tasks': json['tasks'],
        'artifacts': json['artifacts'],
      },
    );
    expect((await setup.repository.execute(projectId, 'sync')).id, projectId);
    expect(setup.api.effects.last.body, {'action': 'sync'});
    expect(
      setup.api.effects.last.path,
      '/api/projects/${Uri.encodeComponent(projectId)}/execution',
    );
    expect(setup.api.effects.last.headers, setup.api.effects.first.headers);
  });
  test('task and feedback receipts bind exact resource IDs and reviewed fields', () async {
    final setup = fixture();
    await seed(setup);
    setup.api.writes.add(
      () async => {'task': taskJson(id: 'wrong-task', status: 'doing')},
    );
    await expectLater(
      setup.repository.updateTask(projectId, taskId, {'status': 'doing'}),
      throwsFormatException,
    );
    setup.api.writes.add(() async => {'task': taskJson(status: 'doing')});
    expect(
      (await setup.repository.updateTask(projectId, taskId, {
        'status': 'doing',
      })).id,
      taskId,
    );
    expect(
      setup.api.effects.last.path,
      '/api/projects/${Uri.encodeComponent(projectId)}/tasks/${Uri.encodeComponent(taskId)}',
    );
    setup.api.writes.add(
      () async => {
        'artifact': {
          ...artifactJson(),
          'verdict': 'needs_work',
          'lesson': 'Different lesson',
        },
      },
    );
    await expectLater(
      setup.repository.reflect(
        projectId,
        artifactId,
        verdict: 'needs_work',
        lesson: 'Exact reviewed lesson',
      ),
      throwsFormatException,
    );
    setup.api.writes.add(
      () async => {
        'artifact': {
          ...artifactJson(),
          'verdict': 'needs_work',
          'lesson': 'Exact reviewed lesson',
        },
      },
    );
    expect(
      (await setup.repository.reflect(
        projectId,
        artifactId,
        verdict: 'needs_work',
        lesson: 'Exact reviewed lesson',
      )).lesson,
      'Exact reviewed lesson',
    );
    expect(
      setup.api.effects.last.path,
      '/api/projects/${Uri.encodeComponent(projectId)}/artifacts/${Uri.encodeComponent(artifactId)}/feedback',
    );
  });
  test('same-owner access pause and owner replacement invalidate pending reads and effects', () async {
    final setup = fixture();
    await seed(setup);
    final read = Completer<Json>();
    setup.api.gets.add(() => read.future);
    final pendingRead = setup.repository.detail(projectId);
    setup.access.update(available: false);
    read.complete({'project': projectJson()});
    await expectLater(pendingRead, throwsFormatException);
    setup.access.update(
      tenant: 'tenant-one',
      actor: 'actor-one',
      nextRole: 'operator',
      available: true,
    );
    final write = Completer<Json>();
    setup.api.writes.add(() => write.future);
    final pendingWrite = setup.repository.update(projectId, {
      'status': 'completed',
    });
    setup.access.update(
      tenant: 'tenant-one',
      actor: 'other-owner',
      nextRole: 'operator',
      available: true,
    );
    write.complete({
      'project': {...projectJson(), 'status': 'completed'},
    });
    await expectLater(pendingWrite, throwsFormatException);
    await expectLater(
      setup.repository.update(projectId, {'status': 'completed'}),
      throwsStateError,
    );
    expect(setup.api.effects, hasLength(1));
  });
  test('a read older than an accepted exact response cannot roll back current details', () async {
    final setup = fixture();
    await seed(setup);
    setup.api.writes.add(
      () async => {
        'project': {
          ...projectJson(),
          'status': 'completed',
          'updatedAt': '2026-10-04T13:00:00.000Z',
        },
      },
    );
    await setup.repository.update(projectId, {'status': 'completed'});
    setup.api.gets.add(() async => {'project': projectJson()});
    await expectLater(
      setup.repository.detail(projectId),
      throwsA(
        isA<FormatException>().having(
          (e) => e.message,
          'old read',
          contains('predates a confirmed'),
        ),
      ),
    );
  });
  test(
    'native capability and viewer authority reject writes before transport',
    () async {
      final setup = fixture();
      await seed(setup);
      setup.access.mutationsAvailable = false;
      await expectLater(
        setup.repository.update(projectId, {'status': 'completed'}),
        throwsStateError,
      );
      setup.access.mutationsAvailable = true;
      setup.access.update(
        tenant: 'tenant-one',
        actor: 'actor-one',
        nextRole: 'viewer',
        available: true,
      );
      await expectLater(
        setup.repository.create(title: 'Draft', objective: 'Exact objective'),
        throwsStateError,
      );
      expect(setup.api.effects, isEmpty);
    },
  );
  test('disposed repositories cannot publish an old response or admit a later write', () async {
    final setup = fixture();
    await seed(setup);
    final response = Completer<Json>();
    setup.api.writes.add(() => response.future);
    final pending = setup.repository.update(projectId, {'status': 'completed'});
    setup.repository.dispose();
    response.complete({
      'project': {...projectJson(), 'status': 'completed'},
    });
    await expectLater(pending, throwsFormatException);
    await expectLater(
      setup.repository.update(projectId, {'status': 'completed'}),
      throwsStateError,
    );
    expect(setup.api.effects, hasLength(1));
  });
  test('same-owner role replacement cannot give an uncertain exact retry a fresh key', () async {
    final setup = fixture();
    await seed(setup);
    setup.api.writes.add(
      () async => throw const ApiException('Synthetic uncertain response'),
    );
    await expectLater(
      setup.repository.update(projectId, {'status': 'completed'}),
      throwsA(isA<ApiException>()),
    );
    final key = setup.api.effects.single.headers['idempotency-key'];
    setup.access.update(
      tenant: 'tenant-one',
      actor: 'actor-one',
      nextRole: 'viewer',
      available: true,
    );
    setup.access.update(
      tenant: 'tenant-one',
      actor: 'actor-one',
      nextRole: 'operator',
      available: true,
    );
    await expectLater(
      setup.repository.update(projectId, {'status': 'completed'}),
      throwsStateError,
    );
    await seed(setup);
    setup.api.writes.add(
      () async => {
        'project': {...projectJson(), 'status': 'completed'},
      },
    );
    await setup.repository.update(projectId, {'status': 'completed'});
    expect(setup.api.effects.last.headers['idempotency-key'], key);
  });
}

typedef Setup = ({
  _ProjectApi api,
  ApiProjectsRepository repository,
  ProjectAccess access,
});
Setup fixture() {
  final api = _ProjectApi();
  final access = ProjectAccess(
    tenantId: 'tenant-one',
    actorId: 'actor-one',
    role: 'operator',
  );
  final repository = ApiProjectsRepository(api, access: access);
  addTearDown(() {
    repository.dispose();
    access.dispose();
  });
  return (api: api, repository: repository, access: access);
}

Future<void> seed(Setup setup) async {
  setup.api.gets.add(() async => {'project': projectJson()});
  await setup.repository.detail(projectId);
}

class _ProjectApi extends ApiClient {
  _ProjectApi()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));
  final gets = Queue<Future<Json> Function()>(),
      writes = Queue<Future<Json> Function()>();
  final reads =
      <
        ({
          String path,
          Map<String, dynamic>? query,
          Map<String, dynamic>? headers,
          CancelToken cancel,
        })
      >[];
  final effects = <({String path, String method, Json body, Json headers})>[];
  @override
  Future<Json> getJsonFreshCancelable(
    String path, {
    Map<String, dynamic>? query,
    Map<String, dynamic>? headers,
    required CancelToken cancelToken,
  }) {
    reads.add((
      path: path,
      query: query,
      headers: headers,
      cancel: cancelToken,
    ));
    if (gets.isEmpty) throw StateError('Unexpected synthetic GET: $path');
    return gets.removeFirst()();
  }

  Future<Json> effect(String path, String method, Json? data, Json? headers) {
    effects.add((
      path: path,
      method: method,
      body: data ?? {},
      headers: headers ?? {},
    ));
    if (writes.isEmpty) {
      throw StateError('Unexpected synthetic effect: $method $path');
    }
    return writes.removeFirst()();
  }

  @override
  Future<Json> postJson(String path, {Json? data, Json? headers}) =>
      effect(path, 'POST', data, headers);
  @override
  Future<Json> patchJson(String path, {Json? data, Json? headers}) =>
      effect(path, 'PATCH', data, headers);
}
