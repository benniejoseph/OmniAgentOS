import 'dart:async';

import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_contracts.dart';
import 'package:asael/features/knowledge/knowledge_graph_contracts.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_private_action_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'knowledge_private_action_fixtures.dart';
import 'knowledge_review_fixtures.dart' show reviewOwner, reviewAt;

Future<Json> graphSeal(Json body, int count) async {
  final raw = await privateSeal(
    body,
    'app.memory.graph.native.${body['view']}',
  );
  final receipt = Map<String, dynamic>.from(raw['serviceReceipt'] as Map)
    ..remove('receiptSha256');
  receipt['resourceType'] = 'memory_graph';
  receipt['resourceCount'] = count;
  return {
    ...raw,
    'serviceReceipt': {...receipt, 'receiptSha256': await memorySha(receipt)},
  };
}

Future<Json> graphNode({String id = 'node:one'}) => graphSeal({
  'contract': privateGraphContract,
  'scope': privateActionScope(reviewOwner),
  'view': 'node',
  'generatedAt': reviewAt,
  'node': {
    'id': id,
    'kind': 'concept',
    'weight': 1,
    'sourceCount': 1,
    'updatedAt': reviewAt,
    'label': 'Private node',
    'summary': 'Exact current content',
    'tags': <String>[],
    'textTruncated': false,
  },
}, 1);

class _GraphRepository extends PrivateActionRepository
    implements KnowledgeGraphRepository {
  final waiting = Completer<KnowledgeGraphRead>();
  @override
  bool get supportsAdvancedGraph => true;
  @override
  Future<KnowledgeGraphRead> readGraph(String view, KnowledgeJson query) =>
      waiting.future;
}

void main() {
  test('exact graph read binds selected identity, current owner role and strict detail', () async {
    final raw = await graphNode();
    expect(
      (await KnowledgeGraphRead.parse(raw, reviewOwner, 'node', {
        'id': 'node:one',
      })).raw['node'],
      isNotNull,
    );
    await expectLater(
      KnowledgeGraphRead.parse(raw, reviewOwner, 'node', {'id': 'node:two'}),
      throwsFormatException,
    );
    const viewer = KnowledgeOwner(
      'tenant',
      'operator@example.test',
      '00000000-0000-4000-8000-000000000001',
      'viewer',
      'https://example.test',
    );
    await expectLater(
      KnowledgeGraphRead.parse(raw, viewer, 'node', {'id': 'node:one'}),
      throwsFormatException,
    );
    final body = {...raw}..remove('serviceReceipt');
    body['node'] = {...raw['node'] as Map, 'unexpected': true};
    await expectLater(
      KnowledgeGraphRead.parse(await graphSeal(body, 1), reviewOwner, 'node', {
        'id': 'node:one',
      }),
      throwsFormatException,
    );
  });
  test('temporal read requires exact filters and path evidence receipt binds query', () async {
    final query = {'history': true, 'limit': 25};
    final body = {
      'contract': privateGraphContract,
      'scope': privateActionScope(reviewOwner),
      'generatedAt': reviewAt,
      'view': 'temporal',
      'query': query,
      'relations': [],
      'limitReached': false,
      'total': null,
    };
    final raw = await graphSeal(body, 0);
    expect(
      (await KnowledgeGraphRead.parse(
        raw,
        reviewOwner,
        'temporal',
        query,
      )).view,
      'temporal',
    );
    await expectLater(
      KnowledgeGraphRead.parse(raw, reviewOwner, 'temporal', {
        'history': false,
        'limit': 25,
      }),
      throwsFormatException,
    );
    final pathsQuery = {'q': 'Who owns this?', 'maxHops': 2, 'limit': 12};
    final proof = {
      'version': 'p5.5-graph-retrieval:1',
      'querySha256': await memorySha(pathsQuery['q']),
      'asOfTime': reviewAt,
      'maxHops': 2,
      'anchorCount': 0,
      'authorizedRelationCount': 0,
      'rejectedRelationCount': 0,
      'pathCount': 0,
    };
    final paths = {
      'contract': privateGraphContract,
      'scope': privateActionScope(reviewOwner),
      'generatedAt': reviewAt,
      'view': 'paths',
      'query': pathsQuery,
      'coverage': 'bounded_authorized_paths',
      'result': {
        'paths': [],
        'receipt': {...proof, 'receiptSha256': await memorySha(proof)},
      },
    };
    expect(
      (await KnowledgeGraphRead.parse(
        await graphSeal(paths, 0),
        reviewOwner,
        'paths',
        pathsQuery,
      )).view,
      'paths',
    );
    (paths['result'] as Map)['receipt'] = {
      ...proof,
      'querySha256': 'a' * 64,
      'receiptSha256': await memorySha({...proof, 'querySha256': 'a' * 64}),
    };
    await expectLater(
      KnowledgeGraphRead.parse(
        await graphSeal(paths, 0),
        reviewOwner,
        'paths',
        pathsQuery,
      ),
      throwsFormatException,
    );
  });
  test('graph completion cannot escape an owner replacement', () async {
    final repository = _GraphRepository();
    final controller = KnowledgeController(
      repository,
      canManage: true,
      mutationsAvailable: false,
    );
    final pending = controller.inspectGraph('node', {'id': 'node:one'});
    final assertion = expectLater(pending, throwsA(anything));
    repository.access.close();
    repository.waiting.complete(
      await KnowledgeGraphRead.parse(await graphNode(), reviewOwner, 'node', {
        'id': 'node:one',
      }),
    );
    await assertion;
    controller.dispose();
  });
}
