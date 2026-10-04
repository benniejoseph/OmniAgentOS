import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'knowledge.dart';
import 'knowledge_contracts.dart';
import 'knowledge_consent_contracts.dart';
import 'knowledge_mutations.dart';
import 'knowledge_review_contracts.dart';

/// The bounded catalogue never supplies mutation authority. Exact changes use
/// the current token-bound transport and a separately reviewed submitted target.
class ApiKnowledgeRepository
    implements
        KnowledgeRepository,
        PagedKnowledgeRepository,
        KnowledgeMutationRepository,
        KnowledgeReviewRepository,
        KnowledgeConsentRepository {
  ApiKnowledgeRepository(
    this.api, {
    this.expectedTenantId,
    KnowledgeAccess? access,
    bool Function()? authorityProbe,
  }) : access = access ?? KnowledgeAccess(),
       _probe = authorityProbe {
    this.access.addListener(_accessChanged);
  }
  final ApiClient api;
  final String? expectedTenantId;
  @override
  final KnowledgeAccess access;
  final bool Function()? _probe;
  @override
  bool authorityCurrent() =>
      !_disposed && (_probe?.call() ?? true) && !_disposed;
  @override
  bool supports(MemoryChange kind) =>
      NativeContract.supportsOperation(kind.operation) &&
      (kind != MemoryChange.lifecycle ||
          NativeContract.supportsOperation('memory.lifecycle.get'));
  @override
  bool get supportsReviews =>
      NativeContract.supportsOperation('memory.reconciliation.list') &&
      NativeContract.supportsOperation('memory.reconciliation.read');
  @override
  bool get supportsConsent =>
      NativeContract.supportsOperation('memory.personal-context-consent.get') &&
      NativeContract.supportsOperation(
        'memory.personal-context-consent.decision.get',
      );

  @override
  Future<MemoryConsentRead> readConsent({String? acceptanceKeySha256}) async {
    if (acceptanceKeySha256 != null) {
      memoryHash(acceptanceKeySha256);
    }
    final owner = access.owner, generation = access.generation;
    bool current() =>
        authorityCurrent() &&
        access.readable &&
        owner != null &&
        access.generation == generation &&
        access.owner?.key == owner.key;
    memoryRequire(
      current() && supportsConsent,
      'Current personal recall consent access is required.',
    );
    final authority = NativeRequestAuthority(
      tenantId: owner!.tenantId,
      actorId: owner.actorId,
      canonicalUserId: owner.userId,
      role: owner.role,
      apiBaseUrl: owner.apiBaseUrl,
      isCurrent: current,
    );
    final raw = await api.getJsonAuthorized(
      acceptanceKeySha256 == null
          ? NativePaths.memoryPersonalContextConsentGet(
              contract: memoryConsentReadContract,
            )
          : NativePaths.memoryPersonalContextConsentDecisionGet(
              acceptanceKeySha256,
            ),
      authority: authority,
      cancelToken: _lifetime,
    );
    memoryRequire(current(), 'Personal recall consent access changed.');
    final read = await MemoryConsentRead.parse(
      raw,
      owner,
      keyHash: acceptanceKeySha256,
    );
    memoryRequire(current(), 'Personal recall consent access changed.');
    return read;
  }

  Future<Json> _reviewRead(String path) async {
    final owner = access.owner, generation = access.generation;
    bool current() =>
        authorityCurrent() &&
        access.readable &&
        owner != null &&
        access.generation == generation &&
        access.owner?.key == owner.key;
    memoryRequire(
      current() && supportsReviews,
      'Current private Memory review access is required.',
    );
    final authority = NativeRequestAuthority(
      tenantId: owner!.tenantId,
      actorId: owner.actorId,
      canonicalUserId: owner.userId,
      role: owner.role,
      apiBaseUrl: owner.apiBaseUrl,
      isCurrent: current,
    );
    final raw = await api.getJsonAuthorized(
      path,
      authority: authority,
      cancelToken: _lifetime,
    );
    memoryRequire(current(), 'Memory review authority changed.');
    return raw;
  }

  @override
  Future<List<MemoryReview>> listReviews({
    String status = 'pending',
    int limit = 50,
  }) async {
    memoryRequire(
      {'pending', 'resolved', 'all'}.contains(status) &&
          limit >= 1 &&
          limit <= 100,
    );
    final owner = access.owner, generation = access.generation;
    final raw = await _reviewRead(
      NativePaths.memoryReconciliationList(
        contract: memoryReviewReadContract,
        status: status,
        limit: limit,
      ),
    );
    final result = await parseMemoryReviews(
      raw,
      owner!,
      status: status,
      limit: limit,
    );
    memoryRequire(
      authorityCurrent() &&
          access.readable &&
          access.generation == generation &&
          access.owner?.key == owner.key,
    );
    return result;
  }

  @override
  Future<MemoryReviewRead> readReview(
    String id, {
    String? acceptanceKeySha256,
  }) async {
    memoryReviewId(id);
    if (acceptanceKeySha256 != null) {
      memoryHash(acceptanceKeySha256);
    }
    final owner = access.owner, generation = access.generation;
    final path = NativePaths.memoryReconciliationRead(
      id,
      acceptanceKeySha256: acceptanceKeySha256,
    );
    final raw = await _reviewRead(path);
    final result = await MemoryReviewRead.parse(
      raw,
      owner!,
      id,
      keyHash: acceptanceKeySha256,
    );
    memoryRequire(
      authorityCurrent() &&
          access.readable &&
          access.generation == generation &&
          access.owner?.key == owner.key,
    );
    return result;
  }

  CancelToken _lifetime = CancelToken();
  void _accessChanged() {
    _lifetime.cancel('Knowledge authority changed.');
    _lifetime = CancelToken();
  }

  bool _disposed = false;
  void dispose() {
    _disposed = true;
    access.removeListener(_accessChanged);
    _lifetime.cancel('Knowledge session replaced.');
  }

  Future<Json> _read(String path, {Json? query}) async {
    if (!authorityCurrent()) throw StateError('Knowledge session replaced.');
    final generation = access.generation;
    final result = await api.getJsonFreshCancelable(
      path,
      query: query,
      cancelToken: _lifetime,
    );
    if (!authorityCurrent() || access.generation != generation) {
      throw StateError('Knowledge session replaced.');
    }
    return result;
  }

  List<T> _bounded<T>(
    Object? value,
    int maximum,
    T Function(Json) parse,
    String label,
  ) {
    if (value is! List || value.length > maximum) {
      throw FormatException('$label exceeds its read bound.');
    }
    return List<T>.unmodifiable(
      value.map((item) => parse(knowledgeMap(item, label))),
    );
  }

  MemoryRecord _memory(Json value) {
    for (final field in ['confidence', 'importance']) {
      final number = value[field];
      if (number is! num || !number.isFinite || number < 0 || number > 1) {
        throw FormatException('Memory $field is unavailable or invalid.');
      }
    }
    if (value['title'] is! String) {
      throw const FormatException('Memory title is unavailable.');
    }
    return MemoryRecord.fromJson(value);
  }

  @override
  Future<KnowledgeState> load({String query = '', String type = 'all'}) =>
      loadWorkspace(KnowledgeQuery(query: query));

  @override
  Future<KnowledgeState> loadWorkspace(KnowledgeQuery query) async {
    final response = await _read(
      NativePaths.memoryIntelligenceGet,
      query: query.parameters('workspace'),
    );
    final memory = parseKnowledgePage(
      response['memory'],
      _memory,
      (item) => item.id,
    );
    final knowledge = parseKnowledgePage(
      response['knowledge'],
      KnowledgeItem.fromJson,
      (item) => item.id,
    );
    final graph = knowledgeMap(response['graph'], 'Relationship sample');
    final overview = knowledgeMap(response['overview'], 'Memory overview');
    if (overview['version'] != 'memory-intelligence-observatory:4' ||
        overview['generatedAt'] is! String ||
        DateTime.tryParse(overview['generatedAt'] as String) == null) {
      throw const FormatException(
        'Memory overview version or observation time is unavailable.',
      );
    }
    knowledgeMap(overview['summary'], 'Memory summary');
    knowledgeMap(overview['steward'], 'Memory steward');
    final nodes = _bounded(
      graph['nodes'],
      100,
      GraphNode.fromJson,
      'Relationship points',
    );
    final edges = _bounded(
      graph['edges'],
      200,
      GraphEdge.fromJson,
      'Relationship links',
    );
    if (nodes.map((item) => item.id).toSet().length != nodes.length) {
      throw const FormatException(
        'Relationship sample contains duplicate identities.',
      );
    }
    return KnowledgeState(
      memories: memory.items,
      knowledge: knowledge.items,
      nodes: nodes,
      edges: edges,
      stats: freezeKnowledgeJson(
        knowledgeMap(graph['stats'], 'Relationship statistics'),
      ) as Json,
      overview: freezeKnowledgeJson(overview) as Json,
      memoryCursor: memory.nextCursor,
      knowledgeCursor: knowledge.nextCursor,
      memoryCatalogTotal: memory.catalogTotal,
      knowledgeCatalogTotal: knowledge.catalogTotal,
    );
  }

  @override
  Future<KnowledgePage<MemoryRecord>> loadMemoryPage(
    KnowledgeQuery query,
    String cursor,
  ) async {
    final response = await _read(
      NativePaths.memoryIntelligenceGet,
      query: query.parameters(
        'memory',
        cursor: knowledgeIdentity(cursor, 'Memory cursor', maximum: 1000),
      ),
    );
    return parseKnowledgePage(response['memory'], _memory, (item) => item.id);
  }

  @override
  Future<KnowledgePage<KnowledgeItem>> loadKnowledgePage(
    KnowledgeQuery query,
    String cursor,
  ) async {
    final response = await _read(
      NativePaths.memoryIntelligenceGet,
      query: query.parameters(
        'knowledge',
        cursor: knowledgeIdentity(cursor, 'Source cursor', maximum: 1000),
      ),
    );
    return parseKnowledgePage(
      response['knowledge'],
      KnowledgeItem.fromJson,
      (item) => item.id,
    );
  }

  @override
  Future<MemoryRecord> getMemory(String id) async {
    knowledgeIdentity(id, 'Selected memory');
    final response = await _read(NativePaths.memoryGet(id));
    final value = knowledgeMap(response['memory'], 'Selected memory');
    if (value['id'] != id ||
        value['content'] is! String ||
        value['title'] is! String ||
        ((access.owner?.tenantId ?? expectedTenantId) != null &&
            value['tenantId'] !=
                (access.owner?.tenantId ?? expectedTenantId))) {
      throw const FormatException(
        'The exact memory identity or workspace could not be verified.',
      );
    }
    knowledgeMap(value['access'], 'Memory classification');
    knowledgeMap(value['explainability'], 'Memory provenance');
    return _memory(value);
  }

  @override
  Future<MemoryForgetPreview> previewForgetMemory(String id) async {
    knowledgeIdentity(id, 'Selected memory');
    final response = await _read(
      NativePaths.memoryGet(id),
      query: {'view': 'deletion-preview'},
    );
    final preview = knowledgeMap(
      response['preview'],
      'Deletion impact preview',
    );
    final memory = knowledgeMap(preview['memory'], 'Deletion preview memory');
    final impact = knowledgeMap(preview['impact'], 'Deletion impact');
    final descendants = preview['descendantMemories'];
    if (preview['schemaVersion'] != 1 ||
        preview['contractKind'] != 'memory_deletion_preview' ||
        !['ready', 'already_deleted'].contains(preview['state']) ||
        memory['id'] != id ||
        ![
          'rollback_proof_barrier',
          'best_effort',
        ].contains(preview['guarantee']) ||
        preview['expectedReceiptManifestSha256'] is! String ||
        !RegExp(r'^[a-f0-9]{64}$')
            .hasMatch(preview['expectedReceiptManifestSha256'] as String) ||
        preview['generatedAt'] is! String ||
        DateTime.tryParse(preview['generatedAt'] as String) == null ||
        descendants is! List) {
      throw const FormatException(
        'The exact deletion impact preview is incomplete.',
      );
    }
    for (final key in [
      'rootMemoryCount',
      'descendantMemoryCount',
      'retrievalTraceCount',
      'graphNodeCount',
      'graphEdgeCount',
      'pendingAgentRunCount',
      'pendingWorkflowRunCount',
    ]) {
      knowledgeCount(impact[key], 'Deletion impact $key');
    }
    final descendantIds = descendants
        .map(
          (value) => knowledgeIdentity(
            knowledgeMap(value, 'Derived memory')['id'],
            'Derived memory',
          ),
        )
        .toSet();
    if (impact['rootMemoryCount'] != 1 ||
        impact['descendantMemoryCount'] != descendants.length ||
        descendantIds.length != descendants.length ||
        descendantIds.contains(id)) {
      throw const FormatException(
        'Deletion impact identities or counts disagree.',
      );
    }
    return MemoryForgetPreview.fromJson(preview);
  }

  Never _unsupported(String action) => throw UnsupportedError(
    '$action is not published by native contract ${NativeContract.currentVersion}.',
  );
  @override
  Future<Json> readLifecycle(String id) async {
    knowledgeIdentity(id, 'Lifecycle memory', maximum: 200);
    memoryRequire(
      access.readable &&
          NativeContract.supportsOperation('memory.lifecycle.get'),
    );
    final owner = access.owner!, generation = access.generation;
    final response = await _read(
      '/api/memory/${Uri.encodeComponent(id)}/lifecycle',
    );
    memoryRequire(
      access.generation == generation && access.owner?.key == owner.key,
    );
    final current = await parseMemoryLifecycleResponse(response, owner, id);
    memoryRequire(
      authorityCurrent() &&
          access.generation == generation &&
          access.owner?.key == owner.key,
    );
    return current;
  }

  @override
  Future<MemoryAcceptance> submit(
    MemorySubmission submission,
    bool Function() current,
  ) async {
    final owner = access.owner, generation = access.generation;
    bool valid() =>
        authorityCurrent() &&
        access.readable &&
        access.owner?.canWrite == true &&
        access.generation == generation &&
        access.owner?.key == submission.owner.key &&
        current();
    memoryRequire(
      owner != null && valid() && supports(submission.kind),
      'Current Memory write access is required.',
    );
    final authority = NativeRequestAuthority(
      tenantId: owner!.tenantId,
      actorId: owner.actorId,
      canonicalUserId: owner.userId,
      role: owner.role,
      apiBaseUrl: owner.apiBaseUrl,
      isCurrent: valid,
    );
    final headers = <String, dynamic>{
      'Idempotency-Key': submission.key,
      if (submission.previewDigest != null)
        'x-asael-deletion-preview': submission.previewDigest,
    };
    final path = submission.id == null
        ? '/api/memory'
        : '/api/memory/${Uri.encodeComponent(submission.id!)}';
    final Json raw = switch (submission.kind) {
      MemoryChange.create => await api.postJsonAuthorized(
        path,
        authority: authority,
        data: submission.body,
        headers: headers,
      ),
      MemoryChange.correct => await api.patchJsonAuthorized(
        path,
        authority: authority,
        data: submission.body,
        headers: headers,
      ),
      MemoryChange.lifecycle => await api.patchJsonAuthorized(
        '$path/lifecycle',
        authority: authority,
        data: submission.body,
        headers: headers,
      ),
      MemoryChange.forget => await api.deleteJsonAuthorized(
        path,
        authority: authority,
        headers: headers,
      ),
      MemoryChange.review => await api.patchJsonAuthorized(
        NativePaths.memoryReconciliationResolve,
        authority: authority,
        data: submission.body,
        headers: headers,
      ),
      MemoryChange.consent => await api.patchJsonAuthorized(
        NativePaths.memoryPersonalContextConsentDecide,
        authority: authority,
        data: submission.body,
        headers: headers,
      ),
    };
    memoryRequire(
      valid(),
      'Memory authority changed while the response was pending.',
    );
    final receipt = await MemoryAcceptance.parse(raw, submission);
    memoryRequire(
      valid(),
      'Memory authority changed while the receipt was checked.',
    );
    return receipt;
  }

  @override
  Future<void> addMemory(Json input) async => _unsupported('Memory creation');
  @override
  Future<void> correctMemory(String id, Json input) async =>
      _unsupported('Memory correction');
  @override
  Future<void> forgetMemory(String id, String expectedManifestSha256) async =>
      _unsupported('Memory forgetting');
  @override
  Future<void> rebuildGraph() async => _unsupported('Relationship rebuilding');
  @override
  Future<void> deleteConnectedSource(String source) async =>
      _unsupported('Knowledge source deletion');
}
