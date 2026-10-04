import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/knowledge/knowledge_api_repository.dart';
import 'package:asael/features/knowledge/knowledge_contracts.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

class _Api extends Fake implements ApiClient {
  final reads =
      <({String path, Map<String, dynamic>? query, CancelToken cancel})>[];
  Future<Map<String, dynamic>> Function()? response;
  @override
  Future<Map<String, dynamic>> getJsonFreshCancelable(
    String path, {
    Map<String, dynamic>? query,
    Map<String, dynamic>? headers,
    required CancelToken cancelToken,
  }) {
    reads.add((path: path, query: query, cancel: cancelToken));
    return response!();
  }
}

Map<String, dynamic> _workspace() => {
  'memory': {
    'items': [
      {
        'id': 'memory:one',
        'title': 'One',
        'type': 'fact',
        'tier': 'semantic',
        'state': 'active',
        'confidence': .8,
        'importance': .5,
      },
    ],
    'total': 1000,
    'nextCursor': 'opaque-page-two',
  },
  'knowledge': {'items': [], 'total': 0, 'nextCursor': null},
  'graph': {
    'nodes': [],
    'edges': [],
    'stats': {
      'nodes': 200,
      'edges': 500,
      'communityCountScope': 'visible_sample',
    },
  },
  'overview': {
    'version': 'memory-intelligence-observatory:4',
    'generatedAt': '2026-10-04T12:00:00Z',
    'summary': {},
    'steward': {},
  },
};
Map<String, dynamic> _exact({
  String id = 'memory:one',
  String tenant = 'tenant-a',
}) => {
  'memory': {
    'id': id,
    'tenantId': tenant,
    'title': 'Exact',
    'content': 'Current claim',
    'confidence': .8,
    'importance': .5,
    'access': {
      'visibility': 'user_legacy',
      'sensitivity': 'legacy_unspecified',
    },
    'explainability': {
      'validity': 'retention_expired',
      'useCount': 2,
      'lifecycle': {'pinned': true, 'archived': false},
    },
    'evidenceRefs': ['evidence:full-id'],
  },
};
Map<String, dynamic> _preview() => {
  'preview': {
    'schemaVersion': 1,
    'contractKind': 'memory_deletion_preview',
    'state': 'ready',
    'memory': {'id': 'memory:one', 'title': 'One', 'type': 'fact'},
    'descendantMemories': [],
    'guarantee': 'best_effort',
    'generatedAt': '2026-10-04T12:00:00Z',
    'expectedReceiptManifestSha256': 'a' * 64,
    'impact': {
      'rootMemoryCount': 1,
      'descendantMemoryCount': 0,
      'graphNodeCount': 1,
      'graphEdgeCount': 2,
      'retrievalTraceCount': 3,
      'pendingAgentRunCount': 0,
      'pendingWorkflowRunCount': 0,
    },
  },
};
void main() {
  test('uses bounded fresh reads, preserves real classification and immutable provenance', () async {
    final api = _Api()..response = () async => _workspace();
    final repository = ApiKnowledgeRepository(
      api,
      expectedTenantId: 'tenant-a',
    );
    final state = await repository.loadWorkspace(
      const KnowledgeQuery(
        query: 'review',
        tier: 'semantic',
        state: 'archived',
      ),
    );
    expect(api.reads.single.path, NativePaths.memoryIntelligenceGet);
    expect(api.reads.single.query, {
      'view': 'workspace',
      'limit': 40,
      'q': 'review',
      'category': 'all',
      'tier': 'semantic',
      'state': 'archived',
    });
    expect(state.memoryCatalogTotal, 1000);
    expect(state.memoryCursor, 'opaque-page-two');
    expect(() => state.memories.clear(), throwsUnsupportedError);
    api.response = () async => _exact();
    final memory = await repository.getMemory('memory:one');
    expect(memory.metadata.visibility, 'user_legacy');
    expect(memory.metadata.validity, 'retention_expired');
    expect(() => memory.evidenceRefs.add('other'), throwsUnsupportedError);
    expect(() => memory.metadata.raw['access'] = {}, throwsUnsupportedError);
  });
  test(
    'rejects an exact identity or tenant mismatch and missing exact body',
    () async {
      final api = _Api();
      final repository = ApiKnowledgeRepository(
        api,
        expectedTenantId: 'tenant-a',
      );
      for (final body in [
        _exact(id: 'memory:two'),
        _exact(tenant: 'tenant-b'),
        {
          'memory': {
            'id': 'memory:one',
            'tenantId': 'tenant-a',
            'title': 'Index only',
          },
        },
      ]) {
        api.response = () async => body;
        await expectLater(
          repository.getMemory('memory:one'),
          throwsFormatException,
        );
      }
      expect(
        api.reads.every(
          (read) => read.path == NativePaths.memoryGet('memory:one'),
        ),
        isTrue,
      );
    },
  );
  test('fails closed for missing pages, duplicate identities, overlarge pages and graph samples', () async {
    final api = _Api();
    final repository = ApiKnowledgeRepository(api);
    final missing = _workspace()..remove('memory');
    final duplicate = _workspace();
    final valid = Map<String, dynamic>.from(
      ((duplicate['memory'] as Map)['items'] as List).single as Map,
    );
    (duplicate['memory'] as Map)['items'] = [
      valid,
      {...valid},
    ];
    final huge = _workspace();
    (huge['memory'] as Map)['items'] = List.generate(
      41,
      (i) => {'id': 'id:$i'},
    );
    final graph = _workspace();
    (graph['graph'] as Map)['nodes'] = List.generate(
      101,
      (i) => {'id': 'node:$i'},
    );
    for (final value in [missing, duplicate, huge, graph]) {
      api.response = () async => value;
      await expectLater(repository.load(), throwsFormatException);
    }
  });
  test(
    'page reads preserve the opaque cursor and all server filters',
    () async {
      final api = _Api()
        ..response = () async => {
          'memory': {'items': [], 'total': 0, 'nextCursor': null},
        };
      final repository = ApiKnowledgeRepository(api);
      await repository.loadMemoryPage(
        const KnowledgeQuery(query: 'escaped % query', state: 'superseded'),
        'cursor:=opaque',
      );
      expect(api.reads.single.query, containsPair('cursor', 'cursor:=opaque'));
      expect(api.reads.single.query, containsPair('state', 'superseded'));
      expect(api.reads.single.query, containsPair('view', 'memory'));
    },
  );
  test('disposal cancels the live read and rejects even a late successful response', () async {
    final api = _Api();
    final result = Completer<Map<String, dynamic>>();
    api.response = () => result.future;
    final repository = ApiKnowledgeRepository(api);
    final pending = repository.load();
    final assertion = expectLater(pending, throwsStateError);
    repository.dispose();
    expect(api.reads.single.cancel.isCancelled, isTrue);
    result.complete(_workspace());
    await assertion;
    await expectLater(repository.load(), throwsStateError);
    expect(api.reads, hasLength(1));
  });
  test('impact reads require exact enumerated identities, counts and a complete digest', () async {
    final api = _Api()..response = () async => _preview();
    final repository = ApiKnowledgeRepository(api);
    final preview = await repository.previewForgetMemory('memory:one');
    expect(preview.memoryId, 'memory:one');
    expect(preview.guarantee, 'best_effort');
    expect(api.reads.single.query, {'view': 'deletion-preview'});
    for (final change in [
      (Map<String, dynamic> value) =>
          (value['memory'] as Map)['id'] = 'another',
      (Map<String, dynamic> value) =>
          (value['impact'] as Map)['descendantMemoryCount'] = 1,
      (Map<String, dynamic> value) =>
          (value['impact'] as Map).remove('pendingAgentRunCount'),
      (Map<String, dynamic> value) =>
          value['expectedReceiptManifestSha256'] = '',
    ]) {
      final value = _preview();
      change(value['preview'] as Map<String, dynamic>);
      api.response = () async => value;
      await expectLater(
        repository.previewForgetMemory('memory:one'),
        throwsFormatException,
      );
    }
  });
  test('unpublished mutation adapters fail without network effects', () async {
    final api = _Api();
    final repository = ApiKnowledgeRepository(api);
    expect(NativeContract.supportsOperation('memory.get'), isTrue);
    for (final action in <Future<void> Function()>[
      () => repository.addMemory({}),
      () => repository.correctMemory('id', {}),
      () => repository.forgetMemory('id', 'a' * 64),
      repository.rebuildGraph,
      () => repository.deleteConnectedSource('mail'),
    ]) {
      await expectLater(action(), throwsUnsupportedError);
    }
    expect(api.reads, isEmpty);
  });
}
