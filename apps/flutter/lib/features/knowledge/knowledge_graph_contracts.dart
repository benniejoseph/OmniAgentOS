import 'knowledge_contracts.dart';
import 'knowledge_mutations.dart';
import 'knowledge_private_action_contracts.dart';

const privateGraphContract = 'asael-private-memory-graph-read:1';
const graphEntityKinds = [
  'person',
  'organization',
  'account',
  'project',
  'work_item',
  'event',
  'meeting',
  'place',
  'asset',
  'decision',
  'commitment',
  'preference',
  'risk',
  'goal',
  'product',
  'case',
  'opportunity',
];
const graphRelationKinds = [
  'affiliated_with',
  'belongs_to',
  'assigned_to',
  'attends',
  'located_at',
  'references',
  'decides',
  'commits_to',
  'prefers',
  'introduces_risk_to',
  'targets',
  'produces',
  'related_to',
];
const graphEpistemicKinds = ['asserted', 'observed', 'inferred', 'computed'];
String graphIdentity(Object? value) {
  final text = privateActionId(value);
  memoryRequire(text.length <= 240);
  return text;
}

void _member(Object? value, List<String> choices) {
  memoryRequire(choices.contains(value));
}

void _weight(Object? value, {bool nonnegative = true}) {
  memoryRequire(value is num && value.isFinite && (!nonnegative || value >= 0));
}

List<KnowledgeJson> _rows(
  Object? value,
  int maximum,
  KnowledgeJson Function(Object?) parse, {
  int minimum = 0,
}) {
  memoryRequire(
    value is List && value.length >= minimum && value.length <= maximum,
  );
  return (value as List).map(parse).toList(growable: false);
}

void _unique(List<KnowledgeJson> values, String key) {
  memoryRequire(
    values.map((value) => value[key]).toSet().length == values.length,
  );
}

KnowledgeJson _endpoint(Object? value, {bool label = false}) {
  final row = privateActionObject(
    value,
    'entityId entityTypeId${label ? ' label' : ''}',
  );
  graphIdentity(row['entityId']);
  _member(row['entityTypeId'], graphEntityKinds);
  if (label) {
    privateActionText(row['label'], 320);
  }
  return row;
}

KnowledgeJson _node(Object? value, {bool detail = false}) {
  final row = privateActionObject(
    value,
    'id kind weight sourceCount updatedAt${detail ? ' label summary tags textTruncated' : ''}',
  );
  graphIdentity(row['id']);
  _member(row['kind'], [
    'concept',
    'tag',
    'system',
    'workflow',
    'tool',
    'memory',
    'trace',
  ]);
  _weight(row['weight']);
  privateActionCount(row['sourceCount'], 9007199254740991);
  privateActionInstant(row['updatedAt']);
  if (detail) {
    privateActionText(row['label'], 500, empty: true);
    privateActionText(row['summary'], 4000, empty: true);
    final tags = row['tags'];
    memoryRequire(
      tags is List && tags.length <= 20 && row['textTruncated'] is bool,
    );
    for (final tag in tags as List) {
      privateActionText(tag, 200, empty: true);
    }
  }
  return row;
}

KnowledgeJson _entity(Object? value, {bool detail = false}) {
  final row = privateActionObject(
    value,
    'id kind sourceCount updatedAt${detail ? ' label state' : ''}',
  );
  graphIdentity(row['id']);
  _member(row['kind'], graphEntityKinds);
  privateActionCount(row['sourceCount'], 9007199254740991);
  privateActionInstant(row['updatedAt']);
  if (detail) {
    privateActionText(row['label'], 320);
    memoryRequire(row['state'] == 'active');
  }
  return row;
}

KnowledgeJson _relation(Object? value) {
  final row = privateActionObject(
    value,
    'claimId revisionId previousRevisionId relationTypeId source target epistemicKind claimState confidenceBasisPoints validFrom validTo recordedAt supersededAt lineageCount',
  );
  graphIdentity(row['claimId']);
  graphIdentity(row['revisionId']);
  if (row['previousRevisionId'] != null) {
    graphIdentity(row['previousRevisionId']);
  }
  _member(row['relationTypeId'], graphRelationKinds);
  _member(row['epistemicKind'], graphEpistemicKinds);
  _member(row['claimState'], ['active', 'retracted']);
  _endpoint(row['source']);
  _endpoint(row['target']);
  privateActionCount(row['confidenceBasisPoints'], 10000);
  privateActionCount(row['lineageCount'], 9007199254740991);
  privateActionInstant(row['validFrom']);
  privateActionInstant(row['recordedAt']);
  for (final field in ['validTo', 'supersededAt']) {
    if (row[field] != null) {
      privateActionInstant(row[field]);
    }
  }
  return row;
}

KnowledgeJson validatePrivateGraphQuery(String view, KnowledgeJson value) {
  final query = {...value};
  if (view == 'universe') {
    privateActionObject(query, 'limit');
    privateActionCount(query['limit'], 500, minimum: 1);
  } else if (view == 'node' || view == 'entity') {
    privateActionObject(query, 'id');
    graphIdentity(query['id']);
  } else if (view == 'temporal') {
    memoryRequire(
      query.keys.every(
            const {
              'entityId',
              'relationTypeId',
              'epistemicKind',
              'validAt',
              'recordedAt',
              'history',
              'limit',
            }.contains,
          ) &&
          query['history'] is bool,
    );
    privateActionCount(query['limit'], 200, minimum: 1);
    if (query.containsKey('entityId')) {
      graphIdentity(query['entityId']);
    }
    if (query.containsKey('relationTypeId')) {
      _member(query['relationTypeId'], graphRelationKinds);
    }
    if (query.containsKey('epistemicKind')) {
      _member(query['epistemicKind'], graphEpistemicKinds);
    }
    for (final field in ['validAt', 'recordedAt']) {
      if (query.containsKey(field)) {
        privateActionInstant(query[field]);
      }
    }
  } else {
    memoryRequire(view == 'paths');
    privateActionObject(query, 'q maxHops limit');
    final text = privateActionText(query['q'], 4000);
    memoryRequire(text.trim() == text && text.isNotEmpty);
    privateActionCount(query['maxHops'], 3, minimum: 1);
    privateActionCount(query['limit'], 24, minimum: 1);
  }
  return freezeKnowledgeJson(query) as KnowledgeJson;
}

class KnowledgeGraphRead {
  const KnowledgeGraphRead(this.raw, this.view);
  final KnowledgeJson raw;
  final String view;
  static Future<KnowledgeGraphRead> parse(
    Object? value,
    KnowledgeOwner owner,
    String view,
    KnowledgeJson requested,
  ) async {
    final query = validatePrivateGraphQuery(view, requested);
    final fields = switch (view) {
      'universe' => 'graph',
      'node' => 'node',
      'entity' => 'entity',
      'temporal' => 'query relations limitReached total',
      _ => 'query result coverage',
    };
    final row = privateActionObject(
      value,
      'contract scope generatedAt serviceReceipt view $fields',
    );
    memoryRequire(row['view'] == view);
    privateActionInstant(row['generatedAt']);
    var count = 1;
    if (view == 'universe') {
      final graph = privateActionObject(
        row['graph'],
        'nodes edges entities relations coverage',
      );
      final nodes = _rows(graph['nodes'], 500, _node),
          entities = _rows(graph['entities'], 200, _entity),
          relations = _rows(graph['relations'], 200, _relation);
      final edges = _rows(graph['edges'], 1000, (value) {
        final edge = privateActionObject(
          value,
          'id sourceNodeId targetNodeId relation weight evidenceCount',
        );
        graphIdentity(edge['id']);
        graphIdentity(edge['sourceNodeId']);
        graphIdentity(edge['targetNodeId']);
        _weight(edge['weight']);
        privateActionCount(edge['evidenceCount'], 9007199254740991);
        _member(edge['relation'], [
          'co_occurs',
          'tagged_with',
          'mentions',
          'retrieved_with',
          'query_about',
          'supports',
        ]);
        return edge;
      });
      _unique(nodes, 'id');
      _unique(entities, 'id');
      _unique(edges, 'id');
      _unique(relations, 'revisionId');
      final nodeIds = nodes.map((value) => value['id']).toSet(),
          entityIds = entities.map((value) => value['id']).toSet();
      memoryRequire(
        edges.every(
              (edge) =>
                  nodeIds.contains(edge['sourceNodeId']) &&
                  nodeIds.contains(edge['targetNodeId']),
            ) &&
            relations.every(
              (relation) =>
                  entityIds.contains((relation['source'] as Map)['entityId']) &&
                  entityIds.contains((relation['target'] as Map)['entityId']),
            ),
      );
      final coverage = privateActionObject(
        graph['coverage'],
        'kind nodeLimit edgeLimit entityLimit relationLimit nodeLimitReached edgeLimitReached entityLimitReached relationLimitReached total',
      );
      memoryRequire(
        coverage['kind'] == 'bounded_private_sample' &&
            coverage['nodeLimit'] == query['limit'] &&
            coverage['edgeLimit'] == (query['limit'] as int) * 2 &&
            coverage['entityLimit'] == 200 &&
            coverage['relationLimit'] == 200 &&
            coverage['total'] == null &&
            nodes.length <= (query['limit'] as int) &&
            edges.length <= (query['limit'] as int) * 2,
      );
      for (final flag in [
        'nodeLimitReached',
        'edgeLimitReached',
        'entityLimitReached',
        'relationLimitReached',
      ]) {
        memoryRequire(coverage[flag] is bool);
      }
      count = nodes.length + entities.length;
    } else if (view == 'node' || view == 'entity') {
      final detail = view == 'node'
          ? _node(row['node'], detail: true)
          : _entity(row['entity'], detail: true);
      memoryRequire(detail['id'] == query['id']);
    } else if (view == 'temporal') {
      memoryRequire(
        privateActionSame(row['query'], query) &&
            row['total'] == null &&
            row['limitReached'] is bool,
      );
      final relations = _rows(
        row['relations'],
        query['limit'] as int,
        _relation,
      );
      _unique(relations, 'revisionId');
      count = relations.length;
    } else {
      memoryRequire(
        row['coverage'] == 'bounded_authorized_paths' &&
            privateActionSame(row['query'], query),
      );
      final result = privateActionObject(row['result'], 'paths receipt'),
          proof = privateActionObject(
            result['receipt'],
            'version querySha256 asOfTime maxHops anchorCount authorizedRelationCount rejectedRelationCount pathCount receiptSha256',
          );
      final paths = _rows(
        result['paths'],
        query['limit'] as int,
        (value) => privateActionObject(
          value,
          'pathId anchor terminal hopCount score explanation hops pathSha256',
        ),
      );
      _unique(paths, 'pathId');
      for (final path in paths) {
        graphIdentity(path['pathId']);
        _endpoint(path['anchor'], label: true);
        _endpoint(path['terminal'], label: true);
        _weight(path['score'], nonnegative: false);
        privateActionText(path['explanation'], 16000, empty: true);
        final hops = _rows(path['hops'], query['maxHops'] as int, (value) {
          final hop = privateActionObject(
            value,
            'claimId revisionId relationTypeId relationLabel direction source target epistemicKind confidenceBasisPoints validFrom validTo evidence',
          );
          graphIdentity(hop['claimId']);
          graphIdentity(hop['revisionId']);
          _member(hop['relationTypeId'], graphRelationKinds);
          privateActionText(hop['relationLabel'], 320, empty: true);
          _member(hop['direction'], ['forward', 'reverse', 'symmetric']);
          _member(hop['epistemicKind'], graphEpistemicKinds);
          _endpoint(hop['source'], label: true);
          _endpoint(hop['target'], label: true);
          privateActionCount(hop['confidenceBasisPoints'], 10000);
          privateActionInstant(hop['validFrom']);
          if (hop['validTo'] != null) {
            privateActionInstant(hop['validTo']);
          }
          _rows(hop['evidence'], 4, (value) {
            final evidence = privateActionObject(
              value,
              'evidenceId kind title excerpt source observedAt',
            );
            graphIdentity(evidence['evidenceId']);
            _member(evidence['kind'], ['memory', 'canonical_evidence']);
            privateActionText(evidence['title'], 4000, empty: true);
            privateActionText(evidence['excerpt'], 16000, empty: true);
            privateActionText(evidence['source'], 4000, empty: true);
            privateActionInstant(evidence['observedAt']);
            return evidence;
          }, minimum: 1);
          return hop;
        }, minimum: 1);
        memoryRequire(
          path['hopCount'] == hops.length &&
              path['pathSha256'] ==
                  await memorySha({...path}..remove('pathSha256')),
        );
      }
      memoryRequire(
        proof['version'] == 'p5.5-graph-retrieval:1' &&
            proof['querySha256'] == await memorySha(query['q']) &&
            proof['maxHops'] == query['maxHops'] &&
            proof['pathCount'] == paths.length,
      );
      for (final field in [
        'anchorCount',
        'authorizedRelationCount',
        'rejectedRelationCount',
      ]) {
        privateActionCount(proof[field], 9007199254740991);
      }
      privateActionInstant(proof['asOfTime']);
      memoryRequire(
        proof['receiptSha256'] ==
            await memorySha({...proof}..remove('receiptSha256')),
      );
      count = paths.length;
    }
    await privateActionReceipt(
      row,
      owner,
      contract: privateGraphContract,
      service: 'app.memory.graph.native.$view',
      resourceType: 'memory_graph',
      count: count,
    );
    return KnowledgeGraphRead(freezeKnowledgeJson(row) as KnowledgeJson, view);
  }
}

abstract interface class KnowledgeGraphRepository {
  bool get supportsAdvancedGraph;
  Future<KnowledgeGraphRead> readGraph(String view, KnowledgeJson query);
}
