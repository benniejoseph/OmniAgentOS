import 'dart:async';

import 'package:asael/features/builder/builder_contracts.dart';
import 'package:asael/features/builder/builder_repository.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'builder_test_support.dart';
import 'builder_api_test_support.dart';

void main() {
  late BuilderTestApi api;
  late BuilderAccess access;
  late ApiBuilderRepository repository;
  var current = true;
  setUp(() {
    current = true;
    api = BuilderTestApi();
    access = BuilderAccess(owner: testBuilderOwner(), ready: true);
    repository = ApiBuilderRepository(
      api,
      access: access,
      authorityProbe: () => current,
    );
  });
  tearDown(() {
    repository.dispose();
    access.dispose();
  });
  test('published paths encode the complete project once and reads bypass offline projections', () async {
    await repository.snapshot(builderProject, CancelToken());
    expect(
      api.reads.single.path,
      NativePaths.workspacesBuilderGet(builderProject),
    );
    expect(
      api.reads.single.path,
      contains(Uri.encodeComponent(builderProject)),
    );
    expect(api.reads.single.query, isEmpty);
    expect(NativeContract.supportsOperation('workspaces.builder.get'), isTrue);
    expect(
      NativeContract.supportsOperation('workspaces.builder.update'),
      isTrue,
    );
  });
  test(
    'actual file response has only file and must match the requested path',
    () async {
      api.read = (_, query, _) async {
        expect(query, {
          'view': 'file',
          'sessionId': buildId('session'),
          'path': 'app/page.tsx',
        });
        return {'file': fileJson()};
      };
      expect(
        (await repository.file(
          builderProject,
          buildId('session'),
          'app/page.tsx',
          CancelToken(),
        )).path,
        'app/page.tsx',
      );
      api.read = (_, _, _) async => {'file': fileJson(path: 'other.tsx')};
      await expectLater(
        repository.file(
          builderProject,
          buildId('session'),
          'app/page.tsx',
          CancelToken(),
        ),
        throwsFormatException,
      );
    },
  );
  test('tree requires the exact returned session; search echoes its exact trimmed query', () async {
    api.read = (_, _, _) async => {
      'session': sessionJson(id: buildId('session', 'b')),
      'entries': [],
    };
    await expectLater(
      repository.tree(builderProject, buildId('session'), CancelToken()),
      throwsFormatException,
    );
    api.read = (_, query, _) async {
      expect(query!['query'], 'page');
      return {'query': 'different', 'entries': []};
    };
    await expectLater(
      repository.tree(
        builderProject,
        buildId('session'),
        CancelToken(),
        query: ' page ',
      ),
      throwsFormatException,
    );
    api.read = (_, _, _) async => {
      'query': 'page',
      'entries': [
        {'path': 'app/page.tsx', 'kind': 'file', 'size': 25},
      ],
    };
    expect(
      await repository.tree(
        builderProject,
        buildId('session'),
        CancelToken(),
        query: 'page',
      ),
      hasLength(1),
    );
  });
  test('the provider repository list accepts 300 bounded options and refuses duplicate IDs', () async {
    api.read = (_, _, _) async => {
      'repositories': [
        for (var i = 0; i < 300; i++)
          {
            'repositoryId': '$i',
            'fullName': 'owner/repo-$i',
            'private': true,
            'defaultBranch': 'main',
          },
      ],
    };
    expect(
      await repository.repositories(builderProject, CancelToken()),
      hasLength(300),
    );
    api.read = (_, _, _) async => {
      'repositories': List.generate(
        2,
        (_) => {
          'repositoryId': '1',
          'fullName': 'owner/repo',
          'private': true,
          'defaultBranch': 'main',
        },
      ),
    };
    await expectLater(
      repository.repositories(builderProject, CancelToken()),
      throwsFormatException,
    );
  });
  test('native write binds the exact current owner, API, role and immutable request', () async {
    final request = <String, dynamic>{
      'action': 'stop',
      'sessionId': buildId('session'),
    };
    await repository.mutate(builderProject, request, 'exact-key');
    expect(api.authority!.canonicalUserId, builderUser);
    expect(api.authority!.tenantId, 'tenant');
    expect(api.authority!.actorId, 'owner@example.test');
    expect(api.authority!.role, 'operator');
    expect(api.authority!.apiBaseUrl, builderApi);
    expect(api.authority!.isCurrent(), isTrue);
    expect(api.postPath, NativePaths.workspacesBuilderUpdate(builderProject));
    expect(api.headers, {'idempotency-key': 'exact-key'});
    request['sessionId'] = buildId('session', 'b');
    expect(api.posted!['sessionId'], buildId('session'));
    expect(() => api.posted!['sessionId'] = 'changed', throwsUnsupportedError);
    current = false;
    expect(api.authority!.isCurrent(), isFalse);
  });
  test(
    'role and unpublished write capability block before the transport',
    () async {
      access.update(testBuilderOwner(role: 'viewer'), available: true);
      await expectLater(
        repository.mutate(builderProject, {'action': 'create'}, 'key'),
        throwsStateError,
      );
      expect(api.posted, isNull);
      access.update(testBuilderOwner(), available: true);
      access.writeOperation = false;
      await expectLater(
        repository.mutate(builderProject, {'action': 'create'}, 'key'),
        throwsStateError,
      );
      expect(api.posted, isNull);
    },
  );
  test(
    'authority changes cancel held reads and exclude late private responses',
    () async {
      final held = Completer<BuilderJson>();
      api.read = (_, _, _) => held.future;
      final reading = repository.snapshot(builderProject, CancelToken());
      final check = expectLater(
        reading,
        throwsA(anyOf(isA<StateError>(), isA<FormatException>())),
      );
      access.update(testBuilderOwner(user: builderOtherUser), available: true);
      expect(api.tokens.single.isCancelled, isTrue);
      held.complete(snapshotJson());
      await check;
    },
  );
  test(
    'direct dependency probe fences a late response without a notification',
    () async {
      final held = Completer<BuilderJson>();
      api.read = (_, _, _) => held.future;
      final reading = repository.snapshot(builderProject, CancelToken());
      final check = expectLater(reading, throwsStateError);
      current = false;
      held.complete(snapshotJson());
      await check;
    },
  );
  test(
    'late mutation response cannot become an accepted receipt for a new owner',
    () async {
      final held = Completer<BuilderJson>();
      api.write = (_) => held.future;
      final input = {'action': 'stop', 'sessionId': buildId('session')};
      final writing = repository.mutate(builderProject, input, 'key');
      final check = expectLater(
        writing,
        throwsA(anyOf(isA<StateError>(), isA<FormatException>())),
      );
      access.update(testBuilderOwner(user: builderOtherUser), available: true);
      expect(api.authority!.isCurrent(), isFalse);
      held.complete(responseJson(input));
      await check;
    },
  );
  test('receipt digest and idempotency identity must bind this exact accepted action', () async {
    final input = {'action': 'stop', 'sessionId': buildId('session')};
    final sealed = await sealTestBuilderReceipt(
      responseJson(input),
      'tenant',
      'exact-key',
    );
    final receipt = builderMap(sealed['serviceReceipt']);
    await validateBuilderReceiptIdentity(
      receipt,
      tenantId: 'tenant',
      key: 'exact-key',
    );
    await expectLater(
      validateBuilderReceiptIdentity(
        receipt,
        tenantId: 'tenant',
        key: 'another-key',
      ),
      throwsFormatException,
    );
    receipt['resourceCount'] = 2;
    await expectLater(
      validateBuilderReceiptIdentity(
        receipt,
        tenantId: 'tenant',
        key: 'exact-key',
      ),
      throwsFormatException,
    );
    final wrong = responseJson(input);
    (wrong['serviceReceipt'] as Map)['operation'] =
        'app.projects.builder.create';
    expect(
      () => validateBuilderResponse(wrong, builderProject, input),
      throwsFormatException,
    );
  });
  test(
    'file receipt cannot acknowledge another submitted path or original SHA',
    () {
      final input = {
        'action': 'file.update',
        'sessionId': buildId('session'),
        'path': 'app/page.tsx',
        'expectedSha256': sha(),
        'content': 'new',
      };
      for (final field in ['path', 'previousSha256']) {
        final result = responseJson(input);
        (result['update'] as Map)[field] = field == 'path'
            ? 'other.tsx'
            : sha('b');
        expect(
          () => validateBuilderResponse(result, builderProject, input),
          throwsFormatException,
        );
      }
    },
  );
  test('release receipt must preserve exact reviewed identity and digest', () {
    final input = {
      'action': 'release.production',
      'sessionId': buildId('session'),
      'releaseId': buildId('release'),
      'releaseDigest': sha('d'),
      'confirmation': 'RELEASE',
    };
    for (final field in ['id', 'releaseDigest']) {
      final result = responseJson(input);
      (result['release'] as Map)[field] = field == 'id'
          ? buildId('release', 'b')
          : sha('f');
      expect(
        () => validateBuilderResponse(result, builderProject, input),
        throwsFormatException,
      );
    }
    expect(
      () => validateBuilderResponse(responseJson(input), builderProject, input),
      returnsNormally,
    );
  });
}
