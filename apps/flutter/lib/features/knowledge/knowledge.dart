import 'package:flutter/foundation.dart';

import 'knowledge_contracts.dart';
export 'knowledge_view.dart';

typedef Json = Map<String, dynamic>;
List<String> _ss(Object? v) => List<String>.unmodifiable(
  (v as List? ?? const []).map((e) => e.toString()),
);

class MemoryRecord {
  const MemoryRecord({
    required this.id,
    required this.title,
    required this.content,
    required this.type,
    required this.tags,
    required this.scope,
    required this.source,
    required this.importance,
    required this.confidence,
    required this.claimStatus,
    required this.assertedBy,
    required this.evidenceRefs,
    required this.category,
    required this.tier,
    required this.evidenceCount,
    this.supersedesId,
    this.contradictionOfId,
    this.createdAt,
    this.updatedAt,
    this.metadata = const MemoryReadMetadata(),
    this.tenantId,
  });
  final String id, title, content, type, scope, source, claimStatus, assertedBy;
  final String category, tier;
  final String? tenantId;
  final MemoryReadMetadata metadata;
  final List<String> tags, evidenceRefs;
  final int evidenceCount;
  final double importance, confidence;
  final String? supersedesId, contradictionOfId;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  factory MemoryRecord.fromJson(Json j) => MemoryRecord(
    id: knowledgeIdentity(j['id'], 'Memory'),
    tenantId: j['tenantId'] as String?,
    metadata: MemoryReadMetadata.fromJson(j),
    title: '${j['title'] ?? 'Memory'}',
    content: '${j['content'] ?? ''}',
    type: '${j['type'] ?? 'fact'}',
    tags: _ss(j['tags']),
    scope: '${j['scope'] ?? 'workspace'}',
    source: '${j['source'] ?? ''}',
    importance: (j['importance'] as num?)?.toDouble() ?? .5,
    confidence: (j['confidence'] as num?)?.toDouble() ?? .7,
    claimStatus: '${j['claimStatus'] ?? j['state'] ?? 'active'}',
    assertedBy: '${j['assertedBy'] ?? 'system'}',
    evidenceRefs: _ss(j['evidenceRefs']),
    category: '${j['category'] ?? j['type'] ?? 'facts'}',
    tier: '${j['tier'] ?? 'semantic'}',
    evidenceCount:
        (j['evidenceCount'] as num?)?.toInt() ?? _ss(j['evidenceRefs']).length,
    supersedesId: j['supersedesId']?.toString(),
    contradictionOfId: j['contradictionOfId']?.toString(),
    createdAt: DateTime.tryParse('${j['createdAt'] ?? ''}'),
    updatedAt: DateTime.tryParse('${j['updatedAt'] ?? ''}'),
  );
}

class KnowledgeItem {
  const KnowledgeItem({
    required this.id,
    required this.title,
    required this.content,
    required this.source,
    required this.tags,
    required this.kind,
    required this.category,
    required this.chunkCount,
    required this.totalCharacters,
    this.sourceType = 'not_reported',
    this.hasCanonicalLineage = false,
    this.indexedAt,
  });
  final String id, title, content, source, kind, category;
  final int chunkCount, totalCharacters;
  final String sourceType;
  final bool hasCanonicalLineage;
  final DateTime? indexedAt;
  final List<String> tags;
  factory KnowledgeItem.fromJson(Json j, {String kind = 'document'}) =>
      KnowledgeItem(
        id: knowledgeIdentity(j['id'], 'Knowledge source'),
        sourceType: '${j['sourceType'] ?? 'not_reported'}',
        hasCanonicalLineage: j['hasCanonicalLineage'] == true,
        indexedAt: DateTime.tryParse('${j['indexedAt'] ?? ''}'),
        title: '${j['title'] ?? j['documentTitle'] ?? 'Knowledge'}',
        content: '${j['content'] ?? j['text'] ?? j['summary'] ?? ''}',
        source: '${j['sourceLabel'] ?? j['source'] ?? j['sourceUri'] ?? ''}',
        tags: _ss(j['tags']),
        kind: kind,
        category: '${j['category'] ?? 'other'}',
        chunkCount: (j['chunkCount'] as num?)?.toInt() ?? 0,
        totalCharacters: (j['totalCharacters'] as num?)?.toInt() ?? 0,
      );
}

class GraphNode {
  const GraphNode({
    required this.id,
    required this.label,
    required this.kind,
    required this.weight,
    required this.sourceCount,
    required this.tags,
    required this.summary,
  });
  final String id, label, kind, summary;
  final double weight;
  final int sourceCount;
  final List<String> tags;
  factory GraphNode.fromJson(Json j) => GraphNode(
    id: knowledgeIdentity(j['id'], 'Relationship point'),
    label: '${j['label'] ?? 'Node'}',
    kind: '${j['kind'] ?? 'concept'}',
    weight: (j['weight'] as num?)?.toDouble() ?? 0,
    sourceCount: (j['sourceCount'] as num?)?.toInt() ?? 0,
    tags: _ss(j['tags']),
    summary: '${j['summary'] ?? ''}',
  );
}

class GraphEdge {
  const GraphEdge({
    required this.source,
    required this.target,
    required this.relation,
    required this.weight,
  });
  final String source, target, relation;
  final double weight;
  factory GraphEdge.fromJson(Json j) => GraphEdge(
    source: knowledgeIdentity(j['sourceNodeId'], 'Relationship origin'),
    target: knowledgeIdentity(j['targetNodeId'], 'Relationship destination'),
    relation: '${j['relation']}',
    weight: (j['weight'] as num?)?.toDouble() ?? 0,
  );
}

class KnowledgeState {
  const KnowledgeState({
    required this.memories,
    required this.knowledge,
    required this.nodes,
    required this.edges,
    this.stats = const {},
    this.overview = const {},
    this.memoryCursor,
    this.knowledgeCursor,
    this.memoryCatalogTotal,
    this.knowledgeCatalogTotal,
  });
  final List<MemoryRecord> memories;
  final List<KnowledgeItem> knowledge;
  final List<GraphNode> nodes;
  final List<GraphEdge> edges;
  final Json stats;
  final Json overview;
  final String? memoryCursor, knowledgeCursor;
  final int? memoryCatalogTotal, knowledgeCatalogTotal;

  KnowledgeState withMemoryPage(KnowledgePage<MemoryRecord> page) {
    final byId = {for (final item in memories) item.id: item};
    for (final item in page.items) {
      byId[item.id] = item;
    }
    return KnowledgeState(
      memories: List.unmodifiable(byId.values),
      knowledge: knowledge,
      nodes: nodes,
      edges: edges,
      stats: stats,
      overview: overview,
      memoryCursor: page.nextCursor,
      knowledgeCursor: knowledgeCursor,
      memoryCatalogTotal: page.catalogTotal,
      knowledgeCatalogTotal: knowledgeCatalogTotal,
    );
  }

  KnowledgeState withKnowledgePage(KnowledgePage<KnowledgeItem> page) {
    final byId = {for (final item in knowledge) item.id: item};
    for (final item in page.items) {
      byId[item.id] = item;
    }
    return KnowledgeState(
      memories: memories,
      knowledge: List.unmodifiable(byId.values),
      nodes: nodes,
      edges: edges,
      stats: stats,
      overview: overview,
      memoryCursor: memoryCursor,
      knowledgeCursor: page.nextCursor,
      memoryCatalogTotal: memoryCatalogTotal,
      knowledgeCatalogTotal: page.catalogTotal,
    );
  }
}

class MemoryForgetPreview {
  const MemoryForgetPreview({
    required this.expectedReceiptManifestSha256,
    required this.guarantee,
    required this.descendantMemoryCount,
    required this.graphNodeCount,
    required this.graphEdgeCount,
    required this.retrievalTraceCount,
    this.memoryId,
    this.generatedAt,
    this.details = const {},
  });
  final String expectedReceiptManifestSha256, guarantee;
  final int descendantMemoryCount, graphNodeCount, graphEdgeCount;
  final int retrievalTraceCount;
  final String? memoryId, generatedAt;
  final Json details;

  factory MemoryForgetPreview.fromJson(Json json) {
    final impact = json['impact'] is Map
        ? Map<String, dynamic>.from(json['impact'] as Map)
        : const <String, dynamic>{};
    return MemoryForgetPreview(
      memoryId: json['memory'] is Map
          ? (json['memory'] as Map)['id'] as String?
          : null,
      generatedAt: json['generatedAt'] as String?,
      details: freezeKnowledgeJson(json) as Json,
      expectedReceiptManifestSha256:
          '${json['expectedReceiptManifestSha256'] ?? ''}',
      guarantee: '${json['guarantee'] ?? 'best_effort'}',
      descendantMemoryCount:
          (impact['descendantMemoryCount'] as num?)?.toInt() ?? 0,
      graphNodeCount: (impact['graphNodeCount'] as num?)?.toInt() ?? 0,
      graphEdgeCount: (impact['graphEdgeCount'] as num?)?.toInt() ?? 0,
      retrievalTraceCount:
          (impact['retrievalTraceCount'] as num?)?.toInt() ?? 0,
    );
  }
}

abstract interface class KnowledgeRepository {
  Future<KnowledgeState> load({String query = '', String type = 'all'});
  Future<MemoryRecord> getMemory(String id);
  Future<void> addMemory(Json input);
  Future<void> correctMemory(String id, Json input);
  Future<MemoryForgetPreview> previewForgetMemory(String id);
  Future<void> forgetMemory(String id, String expectedManifestSha256);
  Future<void> rebuildGraph();
  Future<void> deleteConnectedSource(String source);
}

abstract interface class PagedKnowledgeRepository {
  Future<KnowledgeState> loadWorkspace(KnowledgeQuery query);
  Future<KnowledgePage<MemoryRecord>> loadMemoryPage(
    KnowledgeQuery query,
    String cursor,
  );
  Future<KnowledgePage<KnowledgeItem>> loadKnowledgePage(
    KnowledgeQuery query,
    String cursor,
  );
}

/// One controller belongs to one authenticated owner, role, and API instance.
/// Disposed controllers cannot expose private projections or publish late reads.
class KnowledgeController extends ChangeNotifier {
  KnowledgeController(
    this.repository, {
    required this.canManage,
    required this.mutationsAvailable,
    this.enabled = true,
  });
  final KnowledgeRepository repository;
  final bool canManage, mutationsAvailable, enabled;
  bool _disposed = false;
  int _generation = 0;
  bool get available => enabled && !_disposed;
  bool get canMutate => available && canManage && mutationsAvailable;
  KnowledgeState? state;
  bool loading = false, loadingMoreMemory = false, loadingMoreKnowledge = false;
  Object? error, memoryPageError, knowledgePageError;
  String query = '', type = 'all', tier = 'all', claimState = 'all';
  KnowledgeQuery get selection =>
      KnowledgeQuery(query: query, tier: tier, state: claimState);
  Future<void>? _refreshOperation;
  String? _refreshFingerprint;
  final Set<String> _memoryCursors = {}, _knowledgeCursors = {};
  static const maximumRetainedItems = 200;
  bool get canLoadMoreMemory =>
      available &&
      !loading &&
      !loadingMoreMemory &&
      state?.memoryCursor != null &&
      (state?.memories.length ?? 0) <= maximumRetainedItems - 40;
  bool get canLoadMoreKnowledge =>
      available &&
      !loading &&
      !loadingMoreKnowledge &&
      state?.knowledgeCursor != null &&
      (state?.knowledge.length ?? 0) <= maximumRetainedItems - 40;
  void _publish() {
    if (!_disposed) notifyListeners();
  }

  bool _current(int generation) => available && generation == _generation;
  void _requireAvailable() {
    if (!available) {
      throw StateError('This knowledge session is no longer available.');
    }
  }

  Future<void> refresh() {
    if (!available) return Future.value();
    final fingerprint = '${selection.fingerprint}\u0000$type';
    if (_refreshOperation != null && _refreshFingerprint == fingerprint) {
      return _refreshOperation!;
    }
    final generation = ++_generation;
    final requested = selection;
    final requestedType = type;
    _refreshFingerprint = fingerprint;
    loading = true;
    loadingMoreMemory = loadingMoreKnowledge = false;
    error = memoryPageError = knowledgePageError = null;
    _publish();
    final operation = _performRefresh(generation, requested, requestedType);
    _refreshOperation = operation;
    return operation;
  }

  Future<void> _performRefresh(
    int generation,
    KnowledgeQuery requested,
    String requestedType,
  ) async {
    try {
      final repo = repository;
      final next = repo is PagedKnowledgeRepository
          ? await (repo as PagedKnowledgeRepository).loadWorkspace(requested)
          : await repo.load(query: requested.query, type: requestedType);
      if (!_current(generation)) return;
      state = next;
      _memoryCursors.clear();
      _knowledgeCursors.clear();
    } catch (failure) {
      if (_current(generation)) error = failure;
    } finally {
      if (_current(generation)) {
        loading = false;
        _refreshOperation = null;
        _refreshFingerprint = null;
        _publish();
      }
    }
  }

  Future<void> search(String value) async {
    _requireAvailable();
    final next = value.trim();
    if (next.length > 4000) {
      throw const FormatException('Search is limited to 4,000 characters.');
    }
    if (query != next) state = null;
    query = next;
    await refresh();
  }

  Future<void> filter({String? memoryTier, String? stateFilter}) async {
    _requireAvailable();
    tier = memoryTier ?? tier;
    claimState = stateFilter ?? claimState;
    state = null;
    await refresh();
  }

  Future<void> loadMoreMemory() async {
    if (!canLoadMoreMemory || repository is! PagedKnowledgeRepository) return;
    final cursor = state!.memoryCursor!;
    final generation = _generation;
    loadingMoreMemory = true;
    memoryPageError = null;
    _publish();
    try {
      if (_memoryCursors.contains(cursor)) {
        throw const FormatException(
          'The live memory cursor repeated. Refresh to restart.',
        );
      }
      final page = await (repository as PagedKnowledgeRepository)
          .loadMemoryPage(selection, cursor);
      if (!_current(generation)) return;
      if (page.nextCursor == cursor) {
        throw const FormatException('The live memory cursor did not advance.');
      }
      _memoryCursors.add(cursor);
      state = state!.withMemoryPage(page);
    } catch (failure) {
      if (_current(generation)) memoryPageError = failure;
    } finally {
      if (_current(generation)) {
        loadingMoreMemory = false;
        _publish();
      }
    }
  }

  Future<void> loadMoreKnowledge() async {
    if (!canLoadMoreKnowledge || repository is! PagedKnowledgeRepository) {
      return;
    }
    final cursor = state!.knowledgeCursor!;
    final generation = _generation;
    loadingMoreKnowledge = true;
    knowledgePageError = null;
    _publish();
    try {
      if (_knowledgeCursors.contains(cursor)) {
        throw const FormatException(
          'The live source cursor repeated. Refresh to restart.',
        );
      }
      final page = await (repository as PagedKnowledgeRepository)
          .loadKnowledgePage(selection, cursor);
      if (!_current(generation)) return;
      if (page.nextCursor == cursor) {
        throw const FormatException('The live source cursor did not advance.');
      }
      _knowledgeCursors.add(cursor);
      state = state!.withKnowledgePage(page);
    } catch (failure) {
      if (_current(generation)) knowledgePageError = failure;
    } finally {
      if (_current(generation)) {
        loadingMoreKnowledge = false;
        _publish();
      }
    }
  }

  Future<MemoryRecord> inspect(String id) async {
    _requireAvailable();
    knowledgeIdentity(id, 'Selected memory');
    final exact = await repository.getMemory(id);
    _requireAvailable();
    if (exact.id != id) {
      throw const FormatException('The selected memory identity changed.');
    }
    return exact;
  }

  Future<MemoryForgetPreview> previewForget(String id) async {
    _requireAvailable();
    if (!canManage) {
      throw StateError(
        'Memory impact previews require memory management permission.',
      );
    }
    final preview = await repository.previewForgetMemory(id);
    _requireAvailable();
    if (preview.memoryId != null && preview.memoryId != id) {
      throw const FormatException(
        'The impact preview belongs to another memory.',
      );
    }
    return preview;
  }

  Future<void> add(Json value) async {
    _requireMutation();
    await repository.addMemory(freezeKnowledgeJson(value) as Json);
    _requireAvailable();
    await refresh();
  }

  Future<void> correct(String id, Json value) async {
    _requireMutation();
    await repository.correctMemory(id, freezeKnowledgeJson(value) as Json);
    _requireAvailable();
    await refresh();
  }

  Future<void> forget(String id, String digest) async {
    _requireMutation();
    await repository.forgetMemory(id, digest);
    _requireAvailable();
    await refresh();
  }

  Future<void> rebuild() async {
    _requireMutation();
    await repository.rebuildGraph();
    _requireAvailable();
    await refresh();
  }

  void _requireMutation() {
    if (!canMutate) throw StateError('Memory changes are not available here.');
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    ++_generation;
    state = null;
    error = null;
    // Owned inspector routes listen to this fence before ChangeNotifier closes.
    notifyListeners();
    super.dispose();
  }
}
