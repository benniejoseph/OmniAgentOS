import 'package:asael/app/router/app_router.dart';
import 'package:asael/core/platform/desktop_host_bridge.dart';
import 'package:asael/features/search/content_search_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'search_test_support.dart';

void main() {
  test('typed search links reject external, ambiguous and unrecognized destinations', () {
    for (final href in [
      'https://example.test/app/memory?memory=one',
      '//example.test/app/memory?memory=one',
      '/app/memory?memory=one#fragment',
      '/app/memory?memory=one&memory=two',
      '/app/memory?memory=one&token=secret',
      '/app/memory?memory=',
      '/app/memory?memory=%00',
      '/app/memory?memory=%',
      '/app/../app/memory?memory=one',
      '/app/memory?memory=..%2Fone',
      '/app/projects?project=one&task=two',
      '/app/projects?project=one&fromSearch=0',
      '/app/capture?libraryItem=library:mission_artifact:one',
      '/app/command?thread=not-a-uuid',
    ]) {
      expect(
        () => ContentSearchTarget.parse(href),
        throwsFormatException,
        reason: href,
      );
    }
  });
  test('native targets preserve exact legacy task and encoded identity once', () {
    const id = 'legacy/with%2Fencoded:Ω', task = 'task/selected%value';
    final href =
        '/app/projects?${Uri(queryParameters: {'project': id, 'task': task, 'fromSearch': '1'}).query}';
    final item = ContentSearchItem.parse({
      ...searchItemJson(ContentSearchProvider.work),
      'id': 'canonical-task:unrelated',
      'href': href,
    }, ContentSearchProvider.work);
    expect(item.target.id, id);
    expect(item.target.taskId, task);
    final native = Uri.parse(item.target.location);
    expect(native.pathSegments.last, id);
    expect(native.queryParameters, {'workItemId': task, 'fromSearch': '1'});
    expect(isNativeContentSearchLocation(item.target.location), isTrue);
    expect(DesktopHostBridge.isWorkspaceRoute(item.target.location), isTrue);
    expect(isSafeInitialAppLocation(item.target.location), isTrue);
  });
  test(
    'each source lands on its exact native route and preserves search intent',
    () {
      for (final provider in ContentSearchProvider.values) {
        final item = ContentSearchItem.parse(
          searchItemJson(provider),
          provider,
        );
        final route = Uri.parse(item.target.location);
        expect(route.pathSegments.first, switch (provider) {
          ContentSearchProvider.conversations => 'talk',
          ContentSearchProvider.work => 'projects',
          ContentSearchProvider.memory => 'knowledge',
          ContentSearchProvider.library => 'capture',
        });
        if (provider != ContentSearchProvider.conversations) {
          expect(isNativeContentSearchLocation(item.target.location), isTrue);
        }
        expect(isSafeInitialAppLocation(item.target.location), isTrue);
      }
      for (final route in [
        '/search?unknown=1',
        '/knowledge?memory=one&fromSearch=1&fromSearch=1',
        '/knowledge?memory=%FF&fromSearch=1',
        '/capture?libraryItem=library:source_item:one#other',
      ]) {
        expect(isNativeContentSearchLocation(route), isFalse);
      }
      expect(
        nativeRouteQueryDecodes(Uri.parse('/capture?libraryItem=%FF')),
        isFalse,
      );
      expect(
        nativeRouteQueryDecodes(
          Uri.parse('/knowledge?memory=one&fromSearch=1'),
        ),
        isTrue,
      );
    },
  );
  test('response binds query, source, live consistency and exact non-Work identity', () {
    expect(searchResponse().groups, hasLength(4));
    expect(
      () => ContentSearchResponse.parse(searchResponseJson(), query: 'other'),
      throwsFormatException,
    );
    expect(
      () => ContentSearchResponse.parse({
        ...searchResponseJson(),
        'consistency': 'cached',
      }, query: 'topic'),
      throwsFormatException,
    );
    expect(
      () => ContentSearchItem.parse(
        searchItemJson(ContentSearchProvider.library),
        ContentSearchProvider.memory,
      ),
      throwsFormatException,
    );
    expect(
      () => ContentSearchItem.parse({
        ...searchItemJson(ContentSearchProvider.memory),
        'id': 'another',
      }, ContentSearchProvider.memory),
      throwsFormatException,
    );
    expect(
      () => ContentSearchGroup.parse(
        searchGroupJson(
          ContentSearchProvider.memory,
          items: List.generate(
            21,
            (_) => searchItemJson(ContentSearchProvider.memory),
          ),
        ),
      ),
      throwsFormatException,
    );
    expect(contentSearchQuery('  漢字  '), '漢字');
    expect(contentSearchQuery('100% _draft & plan'), '100% _draft & plan');
    for (final query in ['', 'a', '%%__', 'a' * 241]) {
      expect(() => contentSearchQuery(query), throwsFormatException);
    }
  });
}
