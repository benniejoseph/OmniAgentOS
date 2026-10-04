import 'knowledge.dart';
import 'knowledge_contracts.dart';
import 'knowledge_mutations.dart';

const memoryReviewReadContract = 'asael-memory-reconciliation-read:1';
const memoryReviewDecisionContract = 'asael-memory-reconciliation-decision:1';
const memoryReviewDecisions = {
  'confirm_candidate',
  'keep_existing',
  'keep_both',
};
const _tiers = {
  'working',
  'episodic',
  'semantic',
  'procedural',
  'preference',
  'decision',
  'commitment',
  'summary',
};
const _claims = {
  'active',
  'candidate',
  'superseded',
  'contradicted',
  'forgotten',
};
const _archiveReasons = {'manual', 'exact_duplicate', 'retention_expired'};

KnowledgeJson _object(Object? value, String required, [String optional = '']) {
  final row = knowledgeMap(value, 'Memory review');
  final keys = required.split(' ').where((key) => key.isNotEmpty).toSet();
  final allowed = {
    ...keys,
    ...optional.split(' ').where((key) => key.isNotEmpty),
  };
  memoryRequire(
    keys.every(row.containsKey) && row.keys.every(allowed.contains),
  );
  return row;
}

String _text(Object? value, int maximum, {bool empty = false}) {
  memoryRequire(
    value is String && value.length <= maximum && (empty || value.isNotEmpty),
  );
  return value as String;
}

String memoryReviewId(Object? value) {
  final id = _text(value, 200);
  memoryRequire(RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$').hasMatch(id));
  return id;
}

String _choice(Object? value, Set<String> choices) {
  memoryRequire(value is String && choices.contains(value));
  return value as String;
}

int _count(Object? value, {int minimum = 0, int maximum = 9007199254740991}) {
  memoryRequire(value is int && value >= minimum && value <= maximum);
  return value as int;
}

void _number(Object? value, {double? maximum}) {
  memoryRequire(
    value is num &&
        value.isFinite &&
        value >= 0 &&
        (maximum == null || value <= maximum),
  );
}

String _instant(Object? value) {
  final text = _text(value, 80);
  final match = RegExp(
    r'^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$',
  ).firstMatch(text);
  memoryRequire(match != null && DateTime.tryParse(text) != null);
  final year = int.parse(match![1]!),
      month = int.parse(match[2]!),
      day = int.parse(match[3]!);
  final leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
  final days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  memoryRequire(
    month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1],
  );
  return text;
}

void _strings(Object? value, int maximum, void Function(Object?) validate) {
  memoryRequire(value is List && value.length <= maximum);
  for (final item in value as List) {
    validate(item);
  }
}

void _policy(Object? value) {
  final row = _object(
    value,
    'version tier retention promotion correction retrieval',
  );
  memoryRequire(row['version'] == 1);
  _choice(row['tier'], _tiers);
  final retention = _object(
    row['retention'],
    'mode defaultDays expiredRecordsAreRetrievable',
  );
  _choice(retention['mode'], {
    'time_bounded',
    'source_policy',
    'until_invalidated',
    'obligation_lifecycle',
  });
  if (retention['defaultDays'] != null) {
    _number(retention['defaultDays']);
  }
  memoryRequire(retention['expiredRecordsAreRetrievable'] == false);
  final promotion = _object(
    row['promotion'],
    'targets automatic minimumVerifiedOccurrences review',
  );
  _strings(promotion['targets'], 8, (item) => _choice(item, _tiers));
  memoryRequire(promotion['automatic'] == false);
  _count(promotion['minimumVerifiedOccurrences']);
  _choice(promotion['review'], {
    'user_or_governed_evidence_review',
    'not_promotable',
  });
  final correction = _object(
    row['correction'],
    'strategy preserveHistory confidenceIncreaseRequiresEvidence',
  );
  memoryRequire(
    correction['strategy'] == 'superseding_revision' &&
        correction['preserveHistory'] == true &&
        correction['confidenceIncreaseRequiresEvidence'] == true,
  );
  final retrieval = _object(
    row['retrieval'],
    'requiresActiveClaim requiresTemporalValidity requiresAuthorizedScope sessionAffinityRequired priorityWeight',
  );
  memoryRequire(
    retrieval['requiresActiveClaim'] == true &&
        retrieval['requiresTemporalValidity'] == true &&
        retrieval['requiresAuthorizedScope'] == true &&
        retrieval['sessionAffinityRequired'] is bool,
  );
  _number(retrieval['priorityWeight']);
}

MemoryRecord parsePrivateMemoryRecord(Object? value, KnowledgeOwner owner) {
  final row = _object(
    value,
    'id tenantId type tier tierPolicyVersion title content tags scope source importance createdAt updatedAt access explainability',
    'formationReason confidence claimStatus assertedBy evidenceRefs validFrom validTo supersedesId contradictionOfId forgottenAt retentionExpiresAt lastUsedAt useCount promotedFromTier promotedAt pinnedAt archivedAt archiveReason duplicateOfMemoryId',
  );
  memoryReviewId(row['id']);
  memoryRequire(
    row['tenantId'] == owner.tenantId &&
        row['scope'] == 'user' &&
        row['tierPolicyVersion'] == 1,
  );
  _choice(row['type'], {
    'preference',
    'fact',
    'episode',
    'procedure',
    'knowledge',
    'decision',
    'task',
  });
  _choice(row['tier'], _tiers);
  _text(row['title'], 240, empty: true);
  _text(row['content'], 200000, empty: true);
  _text(row['source'], 4000, empty: true);
  _strings(row['tags'], 50, (item) => _text(item, 80, empty: true));
  _number(row['importance'], maximum: 1);
  if (row.containsKey('confidence')) {
    _number(row['confidence'], maximum: 1);
  }
  if (row.containsKey('claimStatus')) {
    _choice(row['claimStatus'], _claims.difference({'forgotten'}));
  }
  if (row.containsKey('assertedBy')) {
    _choice(row['assertedBy'], {'user', 'agent', 'system', 'import'});
  }
  if (row.containsKey('formationReason')) {
    _choice(row['formationReason'], {
      'manual_user_entry',
      'explicit_user_request',
      'canonical_source_observation',
      'verified_effect',
      'agent_shared_artifact',
      'assistant_inference_candidate',
      'source_cognition',
      'correction',
      'project_reflection',
      'project_artifact',
      'workflow_output',
      'maintenance_promotion',
      'portable_restore',
      'legacy_record',
    });
  }
  if (row.containsKey('evidenceRefs')) {
    _strings(row['evidenceRefs'], 50, (item) => _text(item, 500, empty: true));
  }
  for (final field in [
    'supersedesId',
    'contradictionOfId',
    'duplicateOfMemoryId',
  ]) {
    if (row.containsKey(field)) {
      memoryReviewId(row[field]);
    }
  }
  for (final field in [
    'createdAt',
    'updatedAt',
    'validFrom',
    'validTo',
    'forgottenAt',
    'retentionExpiresAt',
    'lastUsedAt',
    'promotedAt',
    'pinnedAt',
    'archivedAt',
  ]) {
    if (row.containsKey(field)) {
      _instant(row[field]);
    }
  }
  if (row.containsKey('useCount')) {
    _count(row['useCount']);
  }
  if (row.containsKey('promotedFromTier')) {
    _choice(row['promotedFromTier'], _tiers);
  }
  if (row.containsKey('archiveReason')) {
    _choice(row['archiveReason'], _archiveReasons);
  }
  final access = _object(
    row['access'],
    'visibility sensitivity scope owner',
    'agentId workspaceId projectId missionId',
  );
  memoryRequire(
    access['visibility'] == 'user_private' &&
        access['scope'] == 'user' &&
        access['owner'] == 'current_user',
  );
  _choice(access['sensitivity'], {
    'public',
    'internal',
    'confidential',
    'restricted',
    'legacy_unspecified',
  });
  for (final field in ['agentId', 'workspaceId', 'projectId', 'missionId']) {
    if (access[field] != null) {
      _text(access[field], 500);
    }
  }
  final explain = _object(
    row['explainability'],
    'why source scope confidence lastUsedAt useCount validity validFrom validTo retentionExpiresAt policy lifecycle',
  );
  _text(explain['why'], 1000, empty: true);
  _text(explain['source'], 4000, empty: true);
  memoryRequire(explain['scope'] == 'user');
  _number(explain['confidence'], maximum: 1);
  _count(explain['useCount']);
  _choice(explain['validity'], {
    ..._claims,
    'archived',
    'retention_expired',
    'outside_validity_interval',
  });
  for (final field in [
    'lastUsedAt',
    'validFrom',
    'validTo',
    'retentionExpiresAt',
  ]) {
    if (explain[field] != null) {
      _instant(explain[field]);
    }
  }
  _policy(explain['policy']);
  final lifecycle = _object(
    explain['lifecycle'],
    'policyVersion pinned pinnedAt archived archivedAt archiveReason duplicateOfMemoryId retrievalPriorityMultiplier historicalTruthChanged',
  );
  memoryRequire(
    lifecycle['policyVersion'] == 1 &&
        lifecycle['pinned'] is bool &&
        lifecycle['archived'] is bool &&
        lifecycle['historicalTruthChanged'] == false,
  );
  for (final field in ['pinnedAt', 'archivedAt']) {
    if (lifecycle[field] != null) {
      _instant(lifecycle[field]);
    }
  }
  if (lifecycle['archiveReason'] != null) {
    _choice(lifecycle['archiveReason'], _archiveReasons);
  }
  if (lifecycle['duplicateOfMemoryId'] != null) {
    memoryReviewId(lifecycle['duplicateOfMemoryId']);
  }
  _number(lifecycle['retrievalPriorityMultiplier']);
  return MemoryRecord.fromJson({
    ...row,
    'assertedBy': row['assertedBy'] ?? 'not_reported',
    'claimStatus': row['claimStatus'] ?? 'not_reported',
    'confidence': row['confidence'] ?? explain['confidence'],
  });
}

class MemoryReview {
  const MemoryReview(this.raw, this.candidate, this.existing);
  final KnowledgeJson raw;
  final MemoryRecord candidate;
  final MemoryRecord? existing;
  String get id => raw['id'] as String;
  String get kind => raw['kind'] as String;
  String get status => raw['status'] as String;
  String? get token => raw['reviewToken'] as String?;
  String? get decision => raw['decision'] as String?;
  bool get actionable => status == 'pending' && token != null;
  KnowledgeJson get evidence => {
    'kind': kind,
    'candidateMemoryId': candidate.id,
    'existingMemoryId': existing?.id,
  };
  static MemoryReview parse(Object? value, KnowledgeOwner owner) {
    final row = _object(
      value,
      'id tenantId kind status detectionReason candidate createdAt updatedAt reviewToken',
      'existing decision resolvedAt',
    );
    memoryReviewId(row['id']);
    memoryRequire(row['tenantId'] == owner.tenantId);
    final kind = _choice(row['kind'], {'confirmation', 'contradiction'});
    final status = _choice(row['status'], {'pending', 'resolved'});
    _choice(row['detectionReason'], {
      'unconfirmed_candidate',
      'unverified_inference',
      'unverified_workflow_output',
      'similar_claim_conflict',
      'explicit_contradiction',
      'legacy_candidate',
    });
    _instant(row['createdAt']);
    _instant(row['updatedAt']);
    final candidate = parsePrivateMemoryRecord(row['candidate'], owner);
    final existing = row.containsKey('existing')
        ? parsePrivateMemoryRecord(row['existing'], owner)
        : null;
    memoryRequire(
      (kind == 'contradiction') == (existing != null) &&
          candidate.id != existing?.id,
    );
    if (status == 'pending') {
      memoryRequire(
        !row.containsKey('decision') && !row.containsKey('resolvedAt'),
      );
      if (row['reviewToken'] != null) {
        memoryHash(row['reviewToken']);
        memoryRequire(
          candidate.claimStatus == 'candidate' &&
              (existing == null || existing.claimStatus == 'active'),
        );
      }
    } else {
      _choice(row['decision'], memoryReviewDecisions);
      _instant(row['resolvedAt']);
      memoryRequire(
        row['reviewToken'] == null &&
            (kind == 'contradiction' || row['decision'] != 'keep_both'),
      );
    }
    return MemoryReview(
      freezeKnowledgeJson(row) as KnowledgeJson,
      candidate,
      existing,
    );
  }
}

void _scope(Object? value, KnowledgeOwner owner) {
  final scope = _object(value, 'tenantId ownerActorId visibility');
  memoryRequire(
    scope['tenantId'] == owner.tenantId &&
        scope['ownerActorId'] == owner.canonicalActorId &&
        scope['visibility'] == 'user_private',
  );
}

Future<void> _receipt(
  KnowledgeJson raw,
  KnowledgeOwner owner,
  String operation,
  int count, {
  MemorySubmission? sent,
}) async {
  final receipt = _object(
    raw['serviceReceipt'],
    'schemaVersion receiptKind boundaryVersion operation action resourceType accessMode eventContract authoritySha256 idempotencyKeySha256 outcomeSha256 resourceCount occurredAt receiptSha256',
  );
  final mutation = operation == 'memory.reconciliation.resolve';
  memoryRequire(
    receipt['schemaVersion'] == 1 &&
        receipt['receiptKind'] == 'app_service_receipt' &&
        receipt['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
        receipt['operation'] == operation &&
        receipt['action'] == (mutation ? 'write.memory' : 'read') &&
        receipt['resourceType'] == 'memory_reconciliation' &&
        receipt['accessMode'] == (mutation ? 'mutation' : 'read') &&
        receipt['eventContract'] ==
            (mutation
                ? 'memory.atomic-events.v1'
                : 'read_only:no_domain_mutation') &&
        receipt['resourceCount'] == count,
  );
  memoryRequire(!mutation || sent != null);
  final authorityOwner = mutation ? sent!.owner : owner;
  final executionScope = mutation
      ? {
          'version': 1,
          'tenantId': authorityOwner.tenantId,
          'initiatingActorId': authorityOwner.actorId,
          'executingPrincipalType': 'user',
          'executingPrincipalId': authorityOwner.actorId,
          'workspaceId': null,
          'projectId': null,
          'missionId': null,
          'delegationId': null,
          'correlationId': sent!.key.length <= 256
              ? sent.key
              : 'idempotency-key:${await memorySha(sent.key)}',
          'causationId': sent.id,
          'contextGrantIds': <String>[],
          'capabilityGrantIds': <String>[],
          'purpose': 'api.memory.reconciliation.native.resolve',
        }
      : null;
  memoryRequire(
    receipt['authoritySha256'] ==
        await memorySha({
          'boundaryVersion': 'p9.1-app-service-boundary:1',
          'tenantId': authorityOwner.tenantId,
          'actorId': authorityOwner.actorId,
          'role': authorityOwner.role,
          'executionScope': executionScope,
        }),
  );
  _instant(receipt['occurredAt']);
  memoryRequire(
    receipt['idempotencyKeySha256'] ==
        (mutation && sent != null
            ? await memoryShaText('${sent.owner.tenantId}\u0000${sent.key}')
            : null),
  );
  final receiptBody = {...receipt}..remove('receiptSha256');
  final body = {...raw}..remove('serviceReceipt');
  memoryRequire(
    receipt['receiptSha256'] == await memorySha(receiptBody) &&
        receipt['outcomeSha256'] == await memorySha(body),
  );
}

Future<List<MemoryReview>> parseMemoryReviews(
  Object? value,
  KnowledgeOwner owner, {
  required String status,
  required int limit,
}) async {
  final raw = _object(value, 'contract scope reviews serviceReceipt');
  memoryRequire(
    raw['contract'] == memoryReviewReadContract &&
        {'pending', 'resolved', 'all'}.contains(status) &&
        limit >= 1 &&
        limit <= 100,
  );
  _scope(raw['scope'], owner);
  memoryRequire(
    raw['reviews'] is List && (raw['reviews'] as List).length <= limit,
  );
  final reviews = (raw['reviews'] as List)
      .map((item) => MemoryReview.parse(item, owner))
      .toList();
  memoryRequire(
    reviews.map((item) => item.id).toSet().length == reviews.length &&
        reviews.every((item) => status == 'all' || item.status == status),
  );
  await _receipt(raw, owner, 'memory.reconciliation.list', reviews.length);
  return List.unmodifiable(reviews);
}

KnowledgeJson _target(Object? value) {
  final row = _object(
    value,
    'memoryId claimStatus targetRevision lifecycleRevision',
  );
  memoryReviewId(row['memoryId']);
  _choice(row['claimStatus'], _claims.difference({'forgotten'}));
  _count(row['targetRevision'], minimum: 1, maximum: 9007199254740990);
  _count(row['lifecycleRevision'], maximum: 9007199254740990);
  return row;
}

Future<KnowledgeJson> _acceptance(
  Object? value,
  KnowledgeOwner owner,
  MemoryReview review, {
  String? keyHash,
  MemorySubmission? sent,
}) async {
  final row = _object(
    value,
    'contract id tenantId ownerActorId reviewId candidateMemoryId existingMemoryId decision idempotencyKeySha256 requestSha256 expectedReviewToken resolvedAt before after',
  );
  final hash = memoryHash(row['idempotencyKeySha256']);
  memoryHash(
    row['requestSha256'],
  ); // Server HMAC: opaque, never recomputed by the client.
  memoryHash(row['expectedReviewToken']);
  _instant(row['resolvedAt']);
  _choice(row['decision'], memoryReviewDecisions);
  memoryRequire(
    row['contract'] == 'asael-memory-reconciliation-acceptance:1' &&
        row['tenantId'] == owner.tenantId &&
        row['ownerActorId'] == owner.canonicalActorId &&
        row['reviewId'] == review.id &&
        row['candidateMemoryId'] == review.candidate.id &&
        row['existingMemoryId'] == review.existing?.id &&
        review.status == 'resolved' &&
        row['decision'] == review.decision &&
        row['resolvedAt'] == review.raw['resolvedAt'] &&
        (keyHash == null || keyHash == hash),
  );
  memoryRequire(
    row['id'] ==
        'memory-reconciliation-acceptance:${await memorySha(['memory-reconciliation-acceptance:1', owner.tenantId, owner.canonicalActorId, hash])}',
  );
  final before = _object(row['before'], 'candidate existing'),
      after = _object(row['after'], 'candidate existing');
  final bc = _target(before['candidate']), ac = _target(after['candidate']);
  final be = before['existing'] == null ? null : _target(before['existing']);
  final ae = after['existing'] == null ? null : _target(after['existing']);
  memoryRequire(
    bc['memoryId'] == row['candidateMemoryId'] &&
        ac['memoryId'] == row['candidateMemoryId'] &&
        be?['memoryId'] == row['existingMemoryId'] &&
        ae?['memoryId'] == row['existingMemoryId'] &&
        bc['claimStatus'] == 'candidate' &&
        ac['targetRevision'] == (bc['targetRevision'] as int) + 1 &&
        ac['lifecycleRevision'] == bc['lifecycleRevision'] &&
        (be == null || be['claimStatus'] == 'active') &&
        ac['claimStatus'] ==
            (row['decision'] == 'keep_existing' ? 'superseded' : 'active') &&
        (row['decision'] != 'keep_both' || be != null),
  );
  if (be != null && ae != null) {
    final changed = row['decision'] == 'confirm_candidate';
    memoryRequire(
      ae['claimStatus'] == (changed ? 'contradicted' : 'active') &&
          ae['targetRevision'] ==
              (be['targetRevision'] as int) + (changed ? 1 : 0) &&
          ae['lifecycleRevision'] == be['lifecycleRevision'],
    );
  }
  if (sent != null) {
    memoryRequire(
      sent.kind == MemoryChange.review &&
          sent.id == review.id &&
          sent.owner.tenantId == owner.tenantId &&
          sent.owner.userId == owner.userId &&
          sent.owner.apiBaseUrl == owner.apiBaseUrl &&
          row['decision'] == sent.body['decision'] &&
          row['expectedReviewToken'] == sent.body['expectedReviewToken'] &&
          hash == await memoryShaText(sent.key) &&
          memoryCanonical(sent.reviewEvidence) ==
              memoryCanonical(review.evidence),
    );
  }
  return freezeKnowledgeJson(row) as KnowledgeJson;
}

class MemoryReviewRead {
  const MemoryReviewRead(this.raw, this.review, this.acceptance);
  final KnowledgeJson raw;
  final MemoryReview review;
  final KnowledgeJson? acceptance;
  static Future<MemoryReviewRead> parse(
    Object? value,
    KnowledgeOwner owner,
    String id, {
    String? keyHash,
    MemorySubmission? sent,
    bool mutation = false,
  }) async {
    final raw = _object(
      value,
      'contract scope review acceptance serviceReceipt${mutation ? ' replayed projections' : ''}',
    );
    memoryRequire(raw['contract'] == memoryReviewReadContract);
    _scope(raw['scope'], owner);
    final review = MemoryReview.parse(raw['review'], owner);
    memoryRequire(review.id == memoryReviewId(id));
    if (keyHash != null) {
      memoryHash(keyHash);
    }
    final accepted = raw['acceptance'] == null
        ? null
        : await _acceptance(
            raw['acceptance'],
            owner,
            review,
            keyHash: keyHash,
            sent: sent,
          );
    if (mutation) {
      memoryRequire(
        accepted != null && raw['replayed'] is bool && sent != null,
      );
      final projections = _object(
        raw['projections'],
        'graph entities retiredLineage',
      );
      for (final state in projections.values) {
        _choice(state, {
          'confirmed',
          'unconfirmed',
          'not_applicable',
          'not_repeated',
        });
        memoryRequire((state == 'not_repeated') == raw['replayed']);
      }
    }
    await _receipt(
      raw,
      owner,
      mutation ? 'memory.reconciliation.resolve' : 'memory.reconciliation.read',
      1,
      sent: sent,
    );
    return MemoryReviewRead(
      freezeKnowledgeJson(raw) as KnowledgeJson,
      review,
      accepted,
    );
  }
}

abstract interface class KnowledgeReviewRepository {
  bool get supportsReviews;
  Future<List<MemoryReview>> listReviews({
    String status = 'pending',
    int limit = 50,
  });
  Future<MemoryReviewRead> readReview(String id, {String? acceptanceKeySha256});
}
