import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/search/content_search_contracts.dart';
import 'package:asael/features/search/content_search_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'search_test_support.dart';

void main() {
  test('editing fences a pending query before the next submit and drops late results', () async {
    final repo = SearchTestRepository();
    final controller = ContentSearchController(repo);
    final old = controller.submit('first');
    controller.edit();
    expect(repo.requests.first.cancel.isCancelled, isTrue);
    final next = controller.submit('second');
    repo.requests.last.result.complete(searchResponse(query: 'second'));
    await next;
    repo.requests.first.result.complete(searchResponse(query: 'first'));
    await old;
    expect(controller.query, 'second');
    expect(controller.groups, hasLength(4));
    controller.dispose();
  });
  test(
    'source pagination is independent and changed cursors require restart',
    () async {
      final repo = SearchTestRepository();
      final controller = ContentSearchController(repo);
      final initial = controller.submit('topic');
      repo.requests.last.result.complete(searchResponse(cursor: 'first'));
      await initial;
      final memory = controller.loadProvider(ContentSearchProvider.memory),
          work = controller.loadProvider(ContentSearchProvider.work);
      expect(repo.requests[1].cursor, 'first');
      expect(repo.requests[2].provider, ContentSearchProvider.work);
      repo.requests[1].result.completeError(
        const ApiException('changed', statusCode: 409),
      );
      repo.requests[2].result.complete(
        searchResponse(
          provider: ContentSearchProvider.work,
          items: [searchItemJson(ContentSearchProvider.work, id: 'two')],
        ),
      );
      await Future.wait([memory, work]);
      expect(
        controller.groups[ContentSearchProvider.memory]!.restartRequired,
        isTrue,
      );
      expect(
        controller.groups[ContentSearchProvider.work]!.group.items,
        hasLength(2),
      );
      final restart = controller.loadProvider(
        ContentSearchProvider.memory,
        restart: true,
      );
      expect(repo.requests.last.cursor, isNull);
      repo.requests.last.result.complete(
        searchResponse(provider: ContentSearchProvider.memory, ready: false),
      );
      await restart;
      expect(
        controller.groups[ContentSearchProvider.memory]!.group.ready,
        isFalse,
      );
      expect(
        controller.groups[ContentSearchProvider.work]!.group.items,
        hasLength(2),
      );
      controller.dispose();
    },
  );
  test('denial clears content but a deliberate new edit can retry', () async {
    final repo = SearchTestRepository();
    final c = ContentSearchController(repo);
    final read = c.submit('topic');
    repo.requests.last.result.completeError(
      const ApiException('denied', statusCode: 403),
    );
    await read;
    expect(c.denied, isTrue);
    expect(c.groups, isEmpty);
    expect(c.query, isEmpty);
    c.edit();
    expect(c.available, isTrue);
    final retry = c.submit('again');
    repo.requests.last.result.complete(searchResponse(query: 'again'));
    await retry;
    expect(c.groups, hasLength(4));
    c.dispose();
  });
  test('invalidation inside authority probe dispatches no read, disposal clears held reads', () async {
    final repo = SearchTestRepository();
    final c = ContentSearchController(repo);
    repo.probe = () => c.invalidate(notify: false);
    await c.submit('topic');
    expect(repo.requests, isEmpty);
    expect(c.available, isFalse);
    c.dispose();
    final source = SearchTestRepository();
    final second = ContentSearchController(source);
    final held = second.submit('topic');
    second.dispose();
    expect(source.requests.single.cancel.isCancelled, isTrue);
    source.requests.single.result.complete(searchResponse());
    await held;
    expect(second.groups, isEmpty);
    expect(second.query, isEmpty);
  });
  test(
    'one source is bounded at 100 rows and non-advancing cursors stop',
    () async {
      final repo = SearchTestRepository();
      final c = ContentSearchController(repo);
      final initial = c.submit('topic');
      repo.requests.last.result.complete(searchResponse(cursor: 'page0'));
      await initial;
      for (var page = 1; page <= 5; page++) {
        final pending = c.loadProvider(ContentSearchProvider.work);
        repo.requests.last.result.complete(
          searchResponse(
            provider: ContentSearchProvider.work,
            cursor: 'page$page',
            items: List.generate(
              20,
              (i) => searchItemJson(ContentSearchProvider.work, id: '$page-$i'),
            ),
          ),
        );
        await pending;
      }
      expect(c.groups[ContentSearchProvider.work]!.group.items, hasLength(100));
      final count = repo.requests.length;
      await c.loadProvider(ContentSearchProvider.work);
      expect(repo.requests, hasLength(count));
      final stalled = c.loadProvider(ContentSearchProvider.memory);
      repo.requests.last.result.complete(
        searchResponse(provider: ContentSearchProvider.memory, cursor: 'page0'),
      );
      await stalled;
      expect(c.groups[ContentSearchProvider.memory]!.restartRequired, isTrue);
      c.dispose();
    },
  );
}
