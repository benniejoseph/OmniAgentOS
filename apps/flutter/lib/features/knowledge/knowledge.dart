import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';

import 'knowledge_contracts.dart';
import 'knowledge_consent_contracts.dart';
import 'knowledge_mutations.dart';
import 'knowledge_recovery_store.dart';
import 'knowledge_review_contracts.dart';
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
    this.recoveryStore,
  }) {
    final repo = repository;
    if (repo is KnowledgeMutationRepository) {
      final access = (repo as KnowledgeMutationRepository).access;
      _ownerKey = access.owner?.key;
      access.addListener(_accessChanged);
      access.addSilentListener(_accessClosed);
    }
  }
  final KnowledgeRepository repository;
  final KnowledgeRecoveryStore? recoveryStore;
  final bool canManage, mutationsAvailable, enabled;
  bool _disposed = false;
  bool _authorityLost = false;
  String? _ownerKey;
  int _generation = 0;
  bool get available =>
      enabled &&
      !_disposed &&
      !_authorityLost &&
      (repository is! KnowledgeMutationRepository ||
          (repository as KnowledgeMutationRepository).authorityCurrent() &&
              (repository as KnowledgeMutationRepository).access.owner?.key ==
                  _ownerKey);
  bool get canMutate => available && canManage && mutationsAvailable;
  KnowledgeMutationRepository? get mutationRepository =>
      repository is KnowledgeMutationRepository
      ? repository as KnowledgeMutationRepository
      : null;
  KnowledgeReviewRepository? get reviewRepository =>
      repository is KnowledgeReviewRepository
      ? repository as KnowledgeReviewRepository
      : null;
  bool get reviewsAvailable =>
      available && reviewRepository?.supportsReviews == true;
  KnowledgeConsentRepository? get consentRepository =>
      repository is KnowledgeConsentRepository
      ? repository as KnowledgeConsentRepository
      : null;
  bool get consentAvailable =>
      available && consentRepository?.supportsConsent == true;
  bool get canRecoverReview => _canRecoverReadOnlyChange(MemoryChange.review);
  bool get canRecoverConsent => _canRecoverReadOnlyChange(MemoryChange.consent);
  bool _canRecoverReadOnlyChange(MemoryChange kind) {
    final sent = pendingChange, owner = mutationRepository?.access.owner;
    if (sent == null || owner == null) {
      return false;
    }
    return (kind == MemoryChange.review
            ? reviewsAvailable
            : consentAvailable) &&
        recoveryReady &&
        !recoveryBusy &&
        !changing &&
        sent.kind == kind &&
        sent.owner.tenantId == owner.tenantId &&
        sent.owner.userId == owner.userId &&
        sent.owner.apiBaseUrl == owner.apiBaseUrl;
  }

  bool supportsChange(MemoryChange kind) =>
      available &&
      canManage &&
      recoveryReady &&
      !recoveryBusy &&
      mutationRepository?.access.owner?.canWrite == true &&
      mutationRepository!.supports(kind);
  MemorySubmission? pendingChange;
  MemoryAcceptance? acceptedChange;
  Object? changeError;
  String? changeRefusal;
  final Set<MemorySubmission> _attemptedChanges = {};
  bool changing = false;
  bool recoveryReady = false, recoveryBusy = false;
  Object? recoveryError;
  int _recoveryGeneration = 0;
  int _changeGeneration = 0;
  bool get hasUnconfirmedChange => pendingChange != null && !changing;
  void _accessChanged() {
    _authorityLost = true;
    _invalidatePrivate();
    _publish();
  }

  void _accessClosed() {
    _authorityLost = true;
    _invalidatePrivate();
  }

  void _invalidatePrivate() {
    ++_generation;
    ++_changeGeneration;
    ++_recoveryGeneration;
    state = null;
    error = null;
    acceptedChange = null;
    pendingChange = null;
    changeError = null;
    changeRefusal = null;
    _attemptedChanges.clear();
    changing = false;
    loading = false;
    recoveryReady = false;
    recoveryBusy = false;
    recoveryError = null;
  }

  Future<void> reloadRecovery() async {
    final store = recoveryStore, owner = mutationRepository?.access.owner;
    if (!available ||
        store == null ||
        owner == null ||
        changing ||
        recoveryBusy) {
      return;
    }
    final generation = ++_recoveryGeneration;
    bool current() =>
        available &&
        generation == _recoveryGeneration &&
        mutationRepository?.access.owner?.key == owner.key;
    recoveryReady = false;
    recoveryBusy = true;
    recoveryError = null;
    _publish();
    try {
      final value = await store.read(owner);
      if (!current()) return;
      if (value == null) {
        // A missing durable file cannot erase a locally uncertain network attempt.
        memoryRequire(
          pendingChange == null || !_attemptedChanges.contains(pendingChange),
          'The saved submission disappeared. The earlier result remains unknown.',
        );
        pendingChange = null;
      } else {
        memoryRequire(
          value['version'] == 1 &&
              const {
                'pending',
                'accepted',
                'refused',
                'not_submitted',
              }.contains(value['state']),
        );
        final sent = MemorySubmission.restore(value['submission'], owner);
        final local = pendingChange;
        memoryRequire(
          local == null ||
              !_attemptedChanges.contains(local) ||
              memoryCanonical(local.recovery) == memoryCanonical(sent.recovery),
          'Another saved submission cannot resolve this earlier uncertain request.',
        );
        if (value['state'] == 'accepted') {
          final receipt = await MemoryAcceptance.parse(
            knowledgeMap(value['receipt'], 'Saved acceptance'),
            sent,
            reviewReadOwner: MemoryAcceptance.restoredReadOwner(value, sent),
          );
          if (!current()) return;
          acceptedChange = receipt;
          pendingChange = null;
        } else if (value['state'] == 'pending') {
          final existing = acceptedChange;
          if (existing != null &&
              memoryCanonical(existing.submission.recovery) ==
                  memoryCanonical(sent.recovery)) {
            // Only this exact already-verified acceptance may settle a lost local save.
            await store.write(owner, {
              'version': 1,
              'state': 'accepted',
              'submission': sent.recovery,
              ...existing.recoveryReceipt,
            }, current);
            if (!current()) return;
            pendingChange = null;
          } else {
            pendingChange = sent;
            _attemptedChanges.add(sent);
          }
        } else {
          pendingChange = null;
          changeRefusal = value['state'] == 'not_submitted'
              ? 'This saved change was stopped before sending. Review the current records before making a new decision.'
              : 'The saved request was refused before acceptance. Review current data before a new change.';
        }
      }
      recoveryReady = true;
    } catch (error) {
      if (current()) recoveryError = error;
    } finally {
      if (current()) {
        recoveryBusy = false;
        _publish();
      }
    }
  }

  Future<Json> lifecycle(String id) async {
    _requireAvailable();
    final repo = mutationRepository;
    if (repo == null) throw StateError('Lifecycle review is unavailable.');
    final result = await repo.readLifecycle(id);
    _requireAvailable();
    return result;
  }

  Future<List<MemoryReview>> reviews({
    String status = 'pending',
    int limit = 50,
  }) async {
    _requireAvailable();
    memoryRequire(
      reviewsAvailable,
      'Your private Memory reviews are unavailable. Check account access or update the app.',
    );
    final value = await reviewRepository!.listReviews(
      status: status,
      limit: limit,
    );
    _requireAvailable();
    return value;
  }

  Future<MemoryReviewRead> inspectReview(String id) async {
    _requireAvailable();
    memoryRequire(
      reviewsAvailable,
      'Your private Memory reviews are unavailable. Check account access or update the app.',
    );
    final value = await reviewRepository!.readReview(memoryReviewId(id));
    _requireAvailable();
    return value;
  }

  Future<void> resolveReview(
    MemoryReview reviewed,
    String decision, {
    bool Function()? isReviewCurrent,
  }) async {
    memoryRequire(
      reviewsAvailable &&
          supportsChange(MemoryChange.review) &&
          pendingChange == null &&
          !changing &&
          reviewed.actionable &&
          memoryReviewDecisions.contains(decision) &&
          (decision != 'keep_both' || reviewed.kind == 'contradiction'),
      'Review the exact current private targets and resolve any pending submission first.',
    );
    final owner = mutationRepository!.access.owner!;
    final generation = ++_changeGeneration;
    bool owned() =>
        available &&
        _changeGeneration == generation &&
        mutationRepository?.access.owner?.key == owner.key &&
        pendingChange == null;
    bool current() => owned() && (isReviewCurrent?.call() ?? true);
    changing = true;
    changeError = null;
    _publish();
    try {
      final exact = await reviewRepository!.readReview(reviewed.id);
      if (!current()) {
        return;
      }
      memoryRequire(
        exact.review.actionable &&
            memoryCanonical(exact.review.raw) == memoryCanonical(reviewed.raw),
        'The review or its targets changed. Refresh and review the current records before deciding.',
      );
      final sent = MemorySubmission(
        kind: MemoryChange.review,
        owner: owner,
        id: reviewed.id,
        reviewEvidence: reviewed.evidence,
        body: {
          'contract': memoryReviewDecisionContract,
          'reviewId': reviewed.id,
          'decision': decision,
          'expectedReviewToken': reviewed.token,
        },
      );
      pendingChange = sent;
      changing = false;
      await _sendChange(sent, isAdmitted: isReviewCurrent);
    } catch (failure) {
      if (owned()) {
        changeError = failure;
        changing = false;
        _publish();
      }
      rethrow;
    } finally {
      if (owned() && changing) {
        changing = false;
        _publish();
      }
    }
  }

  Future<MemoryConsentRead> readConsent() async {
    _requireAvailable();
    memoryRequire(
      consentAvailable,
      'Personal recall consent is unavailable. Check account access or update the app.',
    );
    final result = await consentRepository!.readConsent();
    _requireAvailable();
    return result;
  }

  Future<void> decideConsent(
    MemoryConsentCurrent reviewed,
    String action, {
    required bool Function() isReviewCurrent,
  }) async {
    memoryRequire(
      consentAvailable &&
          supportsChange(MemoryChange.consent) &&
          pendingChange == null &&
          !changing &&
          reviewed.token != null &&
          memoryConsentActions.contains(action) &&
          isReviewCurrent(),
      'Read the current personal recall notice and resolve any pending submission before deciding.',
    );
    final owner = mutationRepository!.access.owner!,
        generation = ++_changeGeneration;
    bool owned() =>
        available &&
        _changeGeneration == generation &&
        mutationRepository?.access.owner?.key == owner.key &&
        pendingChange == null;
    bool current() => owned() && isReviewCurrent();
    changing = true;
    changeError = null;
    _publish();
    try {
      final exact = await consentRepository!.readConsent();
      if (!current()) {
        return;
      }
      memoryRequire(
        exact.current.token != null &&
            memoryCanonical(exact.current.raw) == memoryCanonical(reviewed.raw),
        'Personal recall consent or its notice changed. Refresh and review it before making a new decision.',
      );
      final sent = MemorySubmission(
        kind: MemoryChange.consent,
        owner: owner,
        id: owner.canonicalActorId,
        body: reviewed.decision(action),
        consentNotice: reviewed.notice,
      );
      pendingChange = sent;
      changing = false;
      await _sendChange(sent, isAdmitted: isReviewCurrent);
    } catch (failure) {
      if (owned()) {
        changeError = failure;
      }
      rethrow;
    } finally {
      if (owned() && changing) {
        changing = false;
        _publish();
      }
    }
  }

  /// These uncertain decisions are never PATCHed again. Only an authenticated
  /// exact read with the original raw-key hash can establish acceptance.
  Future<void> recoverReview() => _recoverReadOnlyChange(MemoryChange.review);
  Future<void> recoverConsent() => _recoverReadOnlyChange(MemoryChange.consent);
  Future<void> _recoverReadOnlyChange(MemoryChange kind) async {
    if (!_canRecoverReadOnlyChange(kind)) {
      return;
    }
    final sent = pendingChange!, owner = mutationRepository!.access.owner!;
    final generation = ++_changeGeneration;
    bool current() =>
        available &&
        _changeGeneration == generation &&
        mutationRepository?.access.owner?.key == owner.key;
    changing = true;
    changeError = null;
    _publish();
    try {
      final keyHash = await memoryShaText(sent.key);
      if (!current()) {
        return;
      }
      late final KnowledgeJson raw;
      if (kind == MemoryChange.review) {
        final read = await reviewRepository!.readReview(
          sent.id!,
          acceptanceKeySha256: keyHash,
        );
        memoryRequire(
          read.acceptance != null,
          read.review.status == 'resolved'
              ? 'A resolution is visible, but no matching native receipt confirms this submitted decision. The original request remains held.'
              : 'This review is still pending and has no matching acceptance. The submitted outcome remains unconfirmed; no decision was resent.',
        );
        raw = read.raw;
      } else {
        final read = await consentRepository!.readConsent(
          acceptanceKeySha256: keyHash,
        );
        memoryRequire(
          read.acceptance != null,
          'No matching receipt confirms this personal recall decision. The saved request remains held; its current setting does not prove acceptance and no decision was resent.',
        );
        raw = read.raw;
      }
      if (!current() || !identical(pendingChange, sent)) {
        return;
      }
      final accepted = await MemoryAcceptance.parse(
        raw,
        sent,
        reviewReadOwner: owner,
      );
      if (!current() || !identical(pendingChange, sent)) {
        return;
      }
      acceptedChange = accepted;
      pendingChange = null;
      recoveryReady = false;
      recoveryBusy = true;
      _publish();
      try {
        await recoveryStore!.write(owner, {
          'version': 1,
          'state': 'accepted',
          'submission': sent.recovery,
          ...accepted.recoveryReceipt,
        }, current);
        if (current()) {
          recoveryReady = true;
          _attemptedChanges.remove(sent);
        }
      } catch (failure) {
        if (current()) {
          recoveryError = failure;
        }
      }
    } catch (failure) {
      if (current()) {
        changeError = failure;
      }
    } finally {
      if (current()) {
        changing = false;
        recoveryBusy = false;
        _publish();
      }
    }
  }

  Future<void> submitChange(
    MemoryChange kind,
    Json input, {
    String? id,
    String? previewDigest,
  }) async {
    if (changing || pendingChange != null) {
      throw StateError(
        'Resolve the current Memory submission before another change.',
      );
    }
    if (!supportsChange(kind)) {
      throw StateError(
        'This Memory change is not available for the current account and app version.',
      );
    }
    final sent = MemorySubmission(
      kind: kind,
      owner: mutationRepository!.access.owner!,
      body: input,
      id: id,
      previewDigest: previewDigest,
    );
    pendingChange = sent;
    await _sendChange(sent);
  }

  Future<void> retryChange() async {
    final sent = pendingChange;
    if (sent == null ||
        !sent.replayable ||
        changing ||
        !supportsChange(sent.kind) ||
        sent.owner.key != mutationRepository?.access.owner?.key) {
      return;
    }
    await _sendChange(sent);
  }

  Future<void> _sendChange(
    MemorySubmission sent, {
    bool Function()? isAdmitted,
  }) async {
    final generation = ++_changeGeneration;
    final recovery = _attemptedChanges.contains(sent);
    changing = true;
    changeError = null;
    changeRefusal = null;
    _publish();
    bool current() =>
        available &&
        generation == _changeGeneration &&
        identical(pendingChange, sent);
    bool ownerCurrent() =>
        available &&
        generation == _changeGeneration &&
        mutationRepository?.access.owner?.key == sent.owner.key;
    bool dispatched = false;
    try {
      await recoveryStore!.write(sent.owner, {
        'version': 1,
        'state': 'pending',
        'submission': sent.recovery,
      }, current);
      if (!current()) return;
      if (!(isAdmitted?.call() ?? true)) {
        // No transport was called. Persist this definite local cancellation;
        // a failed acknowledgement keeps the original journal held instead.
        await recoveryStore!.write(sent.owner, {
          'version': 1,
          'state': 'not_submitted',
          'submission': sent.recovery,
        }, current);
        if (current()) {
          pendingChange = null;
          changing = false;
          changeRefusal = 'This saved change was stopped before sending. Review the current records before making a new decision.';
          _publish();
        }
        return;
      }
      _attemptedChanges.add(sent);
      dispatched = true;
      final accepted = await mutationRepository!.submit(
        sent,
        () => current() && (isAdmitted?.call() ?? true),
      );
      if (!current()) return;
      acceptedChange = accepted;
      pendingChange = null;
      changing = false;
      recoveryReady = false;
      recoveryBusy = true;
      _publish();
      try {
        await recoveryStore!.write(sent.owner, {
          'version': 1,
          'state': 'accepted',
          'submission': sent.recovery,
          ...accepted.recoveryReceipt,
        }, ownerCurrent);
        if (ownerCurrent()) {
          recoveryReady = true;
          _attemptedChanges.remove(sent);
        }
      } catch (error) {
        if (ownerCurrent()) recoveryError = error;
      } finally {
        if (ownerCurrent()) {
          recoveryBusy = false;
          _publish();
        }
      }
      // Receipt acceptance is settled before this independent, fallible read.
      if (ownerCurrent() && sent.kind != MemoryChange.consent) await refresh();
    } catch (failure) {
      if (current()) {
        changeError = failure;
        changing = false;
        if (!dispatched) {
          recoveryReady = false;
          recoveryError = failure;
        }
        // A later refusal cannot erase uncertainty about an earlier request.
        final status = failure is ApiException ? failure.statusCode : null;
        if (sent.kind != MemoryChange.review &&
            sent.kind != MemoryChange.consent &&
            !recovery &&
            (const {400, 413, 415}.contains(status) ||
                sent.replayable &&
                    const {401, 403, 404, 409, 428}.contains(status))) {
          recoveryReady = false;
          recoveryBusy = true;
          try {
            await recoveryStore!.write(sent.owner, {
              'version': 1,
              'state': 'refused',
              'submission': sent.recovery,
            }, current);
            if (current()) {
              pendingChange = null;
              _attemptedChanges.remove(sent);
              recoveryReady = true;
              changeRefusal = 'The service refused this change. Refresh the exact target and review it again before submitting.';
            }
          } catch (error) {
            if (current()) recoveryError = error;
          } finally {
            if (ownerCurrent()) recoveryBusy = false;
          }
        }
        _publish();
      }
    }
  }

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
    final access = mutationRepository?.access;
    access?.removeListener(_accessChanged);
    access?.removeSilentListener(_accessClosed);
    _invalidatePrivate();
    _disposed = true;
    ++_generation;
    state = null;
    error = null;
    super.dispose();
  }
}
