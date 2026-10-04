import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/search/content_search_contracts.dart';
import 'package:asael/features/search/content_search_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import '../projects/projects_fixture.dart';
import 'search_test_support.dart';

void main() {
  test(
    'authorized search encodes literal query/cursor and binds exact authority',
    () async {
      final api = SearchTestApi(), cancel = CancelToken();
      const query = '100% _draft & plan? 漢字', cursor = 'opaque/+%?cursor';
      api.reader = (_) async => searchResponseJson(
        query: query,
        provider: ContentSearchProvider.work,
      );
      final access = searchAccess(api);
      final repo = ApiContentSearchRepository(access);
      await repo.search(
        query,
        cancel,
        provider: ContentSearchProvider.work,
        cursor: cursor,
      );
      expect(Uri.parse(api.paths.single).queryParameters, {
        'q': query,
        'limit': '8',
        'provider': 'work',
        'cursor': cursor,
      });
      expect(api.authorities.single, same(access.authority));
      expect(api.tokens.single, same(cancel));
      repo.dispose();
    },
  );
  test(
    'exact Work preserves requested task beyond the normal 200-row page',
    () async {
      final api = SearchTestApi();
      final repo = ApiContentSearchRepository(searchAccess(api));
      api.reader = (_) async => {
        'project': {
          ...projectJson(),
          'tasks': [
            taskJson(),
            for (var i = 0; i < 200; i++) taskJson(id: 'other-$i'),
          ],
        },
      };
      final project = await repo.work(projectId, taskId, CancelToken());
      expect(project.tasks, hasLength(201));
      expect(project.tasks.first.id, taskId);
      expect(Uri.parse(api.paths.single).pathSegments.last, projectId);
      expect(Uri.parse(api.paths.single).queryParameters, {'task': taskId});
      api.reader = (_) async => {
        'project': {
          ...projectJson(),
          'tasks': [taskJson(id: 'wrong')],
        },
      };
      await expectLater(
        repo.work(projectId, taskId, CancelToken()),
        throwsFormatException,
      );
      api.reader = (_) async =>
          throw const ApiException('gone', statusCode: 404);
      await expectLater(
        repo.work(projectId, taskId, CancelToken()),
        throwsA(isA<ApiException>()),
      );
      expect(
        api.paths.every((path) => path.startsWith('/api/content-search/work/')),
        isTrue,
      );
      repo.dispose();
    },
  );
  test(
    'exact Memory verifies active private classification and never falls back',
    () async {
      final api = SearchTestApi();
      final repo = ApiContentSearchRepository(searchAccess(api));
      final memory = <String, dynamic>{
        'id': 'memory-one',
        'tenantId': 'tenant-one',
        'title': 'Private memory',
        'content': 'Current content',
        'importance': .5,
        'confidence': .9,
        'claimStatus': 'active',
        'tier': 'semantic',
        'access': {'visibility': 'user_private'},
        'explainability': {
          'validity': 'active',
          'lifecycle': {'archived': false},
        },
      };
      api.reader = (_) async => {'memory': memory};
      expect(
        (await repo.memory('memory-one', CancelToken())).content,
        'Current content',
      );
      api.reader = (_) async => {
        'memory': {...memory, 'tenantId': 'another'},
      };
      await expectLater(
        repo.memory('memory-one', CancelToken()),
        throwsFormatException,
      );
      api.reader = (_) async => {
        'memory': {
          ...memory,
          'access': {'visibility': 'workspace'},
        },
      };
      await expectLater(
        repo.memory('memory-one', CancelToken()),
        throwsFormatException,
      );
      api.reader = (_) async =>
          throw const ApiException('gone', statusCode: 404);
      await expectLater(
        repo.memory('memory-one', CancelToken()),
        throwsA(isA<ApiException>()),
      );
      expect(
        api.paths.every(
          (path) => path.startsWith('/api/content-search/memory/'),
        ),
        isTrue,
      );
      repo.dispose();
    },
  );
  test('late reads are rejected after disposal or identity loss and no fresh read is sent', () async {
    final api = SearchTestApi();
    final held = Completer<SearchJson>();
    var active = true;
    final repo = ApiContentSearchRepository(
      searchAccess(api, current: () => active),
    );
    api.reader = (_) => held.future;
    final cancel = CancelToken();
    final read = repo.search('topic', cancel);
    final rejected = expectLater(read, throwsStateError);
    active = false;
    held.complete(searchResponseJson());
    await rejected;
    await expectLater(repo.search('again', CancelToken()), throwsStateError);
    expect(api.paths, hasLength(1));
    repo.dispose();
    late ApiContentSearchRepository second;
    second = ApiContentSearchRepository(
      searchAccess(
        api,
        current: () {
          second.dispose();
          return true;
        },
      ),
    );
    await expectLater(second.search('topic', CancelToken()), throwsStateError);
    expect(api.paths, hasLength(1));
  });
}
