import 'dart:convert';

import 'knowledge.dart';
import 'knowledge_contracts.dart';
import 'knowledge_mutations.dart';
import 'knowledge_review_contracts.dart';

const memoryPromotionReadContract = 'asael-memory-promotion-read:1';
const memoryPromotionDecisionContract = 'asael-memory-promotion-decision:1';
const memoryPromotionDecisions = {'promote', 'dismiss'};

KnowledgeJson _object(Object? value, String fields) {
  final row = knowledgeMap(value, 'Memory promotion');
  final keys = fields.split(' ').toSet();
  memoryRequire(row.length == keys.length && row.keys.every(keys.contains));
  return row;
}

String _instant(Object? value) {
  memoryRequire(value is String && value.length <= 80);
  final text = value as String;
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

int _revision(Object? value, {int minimum = 0}) {
  memoryRequire(value is int && value >= minimum && value <= 9007199254740990);
  return value as int;
}

List<KnowledgeJson> memoryPromotionSourceTargets(Object? value) {
  memoryRequire(value is List && value.length >= 2 && value.length <= 50);
  final targets = <KnowledgeJson>[];
  String? previous;
  for (final item in value as List) {
    final row = _object(
      item,
      'memoryId claimStatus targetRevision lifecycleRevision sourcePolicySha256',
    );
    final id = memoryReviewId(row['memoryId']);
    memoryRequire(previous == null || previous.compareTo(id) < 0);
    memoryRequire(
      const {
        'active',
        'candidate',
        'superseded',
        'contradicted',
      }.contains(row['claimStatus']),
    );
    _revision(row['targetRevision'], minimum: 1);
    _revision(row['lifecycleRevision']);
    memoryHash(row['sourcePolicySha256']);
    targets.add(freezeKnowledgeJson(row) as KnowledgeJson);
    previous = id;
  }
  return List.unmodifiable(targets);
}

void validateMemoryPromotionSubmission(
  KnowledgeJson body,
  String? id,
  Object? evidence,
) {
  _object(
    body,
    'contract reviewId decision expectedReviewToken expectedPolicySha256 expectedSourceManifestSha256',
  );
  memoryRequire(
    body['contract'] == memoryPromotionDecisionContract &&
        memoryReviewId(body['reviewId']) == id &&
        memoryPromotionDecisions.contains(body['decision']),
  );
  for (final field in [
    'expectedReviewToken',
    'expectedPolicySha256',
    'expectedSourceManifestSha256',
  ]) {
    memoryHash(body[field]);
  }
  final target = _object(
    evidence,
    'canonicalMemoryId targetTier sourceTargets',
  );
  final canonical = memoryReviewId(target['canonicalMemoryId']);
  final sources = memoryPromotionSourceTargets(target['sourceTargets']);
  memoryRequire(
    target['targetTier'] == 'procedural' &&
        sources.any((source) => source['memoryId'] == canonical) &&
        (body['decision'] != 'promote' ||
            sources.every((source) => source['claimStatus'] == 'active')),
  );
}

class MemoryPromotionSummary {
  const MemoryPromotionSummary(this.raw);
  final KnowledgeJson raw;
  String get id => raw['id'] as String;
  String get title => raw['canonicalTitle'] as String;
  String get status => raw['status'] as String;
  String? get decision => raw['decision'] as String?;
  String get canonicalId => raw['canonicalMemoryId'] as String;
  List<String> get sourceIds =>
      List<String>.from(raw['sourceMemoryIds'] as List);
  static MemoryPromotionSummary parse(Object? value, KnowledgeOwner owner) {
    final row = _object(
      value,
      'id tenantId policyVersion status decision canonicalMemoryId canonicalTitle sourceMemoryIds targetTier promotedMemoryId createdAt updatedAt resolvedAt',
    );
    memoryReviewId(row['id']);
    final canonical = memoryReviewId(row['canonicalMemoryId']);
    memoryRequire(
      row['tenantId'] == owner.tenantId &&
          row['policyVersion'] == 1 &&
          const {'pending', 'resolved'}.contains(row['status']) &&
          row['targetTier'] == 'procedural' &&
          row['canonicalTitle'] is String &&
          (row['canonicalTitle'] as String).length <= 240,
    );
    final sources = row['sourceMemoryIds'];
    memoryRequire(
      sources is List && sources.length >= 2 && sources.length <= 50,
    );
    String? previous;
    for (final value in sources as List) {
      final source = memoryReviewId(value);
      memoryRequire(previous == null || previous.compareTo(source) < 0);
      previous = source;
    }
    memoryRequire(sources.contains(canonical));
    _instant(row['createdAt']);
    _instant(row['updatedAt']);
    if (row['promotedMemoryId'] != null) {
      memoryReviewId(row['promotedMemoryId']);
      memoryRequire(!sources.contains(row['promotedMemoryId']));
    }
    if (row['status'] == 'pending') {
      memoryRequire(
        row['decision'] == null &&
            row['resolvedAt'] == null &&
            row['promotedMemoryId'] == null,
      );
    } else {
      memoryRequire(
        memoryPromotionDecisions.contains(row['decision']) &&
            (row['decision'] == 'promote') == (row['promotedMemoryId'] != null),
      );
      _instant(row['resolvedAt']);
    }
    return MemoryPromotionSummary(freezeKnowledgeJson(row) as KnowledgeJson);
  }
}

class MemoryPromotionReview extends MemoryPromotionSummary {
  const MemoryPromotionReview(super.raw, this.canonical, this.sources);
  final MemoryRecord canonical;
  final List<KnowledgeJson> sources;
  String? get token => raw['reviewToken'] as String?;
  List<String> get allowedDecisions =>
      List<String>.from(raw['allowedDecisions'] as List);
  KnowledgeJson get evidence => {
    'canonicalMemoryId': canonicalId,
    'targetTier': 'procedural',
    'sourceTargets': sources,
  };
  KnowledgeJson decisionBody(String decision) => {
    'contract': memoryPromotionDecisionContract,
    'reviewId': id,
    'decision': decision,
    'expectedReviewToken': token,
    'expectedPolicySha256': raw['policySha256'],
    'expectedSourceManifestSha256': raw['sourceManifestSha256'],
  };
  static Future<MemoryPromotionReview> parseExact(
    Object? value,
    KnowledgeOwner owner,
  ) async {
    final row = _object(
      value,
      'id tenantId policyVersion status decision canonicalMemoryId canonicalTitle sourceMemoryIds targetTier promotedMemoryId createdAt updatedAt resolvedAt canonical sourceTargets policySha256 sourceManifestSha256 allowedDecisions reviewToken',
    );
    final summary = {...row};
    for (final key in [
      'canonical',
      'sourceTargets',
      'policySha256',
      'sourceManifestSha256',
      'allowedDecisions',
      'reviewToken',
    ]) {
      summary.remove(key);
    }
    final base = MemoryPromotionSummary.parse(summary, owner);
    final canonical = parsePrivateMemoryRecord(row['canonical'], owner);
    final canonicalRaw = knowledgeMap(
      row['canonical'],
      'Canonical promotion memory',
    );
    final access = knowledgeMap(
      canonicalRaw['access'],
      'Private promotion scope',
    );
    final sources = memoryPromotionSourceTargets(row['sourceTargets']);
    memoryRequire(
      canonical.id == base.canonicalId &&
          canonical.title == base.title &&
          !canonicalRaw.containsKey('forgottenAt') &&
          [
            'agentId',
            'workspaceId',
            'projectId',
            'missionId',
          ].every((key) => access[key] == null) &&
          memoryCanonical(base.sourceIds) ==
              memoryCanonical(
                sources.map((source) => source['memoryId']).toList(),
              ) &&
          sources.singleWhere(
                (source) => source['memoryId'] == canonical.id,
              )['claimStatus'] ==
              canonical.claimStatus,
    );
    memoryHash(row['policySha256']);
    memoryRequire(row['sourceManifestSha256'] == await memorySha(sources));
    final allowed = row['allowedDecisions'];
    memoryRequire(
      allowed is List &&
          allowed.length <= 2 &&
          allowed.toSet().length == allowed.length &&
          allowed.every(memoryPromotionDecisions.contains) &&
          (row['reviewToken'] != null) == allowed.isNotEmpty &&
          (!allowed.contains('promote') || allowed.contains('dismiss')) &&
          (base.status != 'resolved' ||
              allowed.isEmpty && row['reviewToken'] == null),
    );
    if (row['reviewToken'] != null) {
      memoryHash(row['reviewToken']);
    }
    return MemoryPromotionReview(
      freezeKnowledgeJson(row) as KnowledgeJson,
      canonical,
      sources,
    );
  }
}

void _scope(Object? value, KnowledgeOwner owner) {
  final row = _object(value, 'tenantId ownerActorId visibility');
  memoryRequire(
    row['tenantId'] == owner.tenantId &&
        row['ownerActorId'] == owner.canonicalActorId &&
        row['visibility'] == 'user_private',
  );
}

Future<void> _receipt(
  KnowledgeJson raw,
  KnowledgeOwner owner,
  String operation,
  int count, {
  MemorySubmission? sent,
}) async {
  final row = _object(
    raw['serviceReceipt'],
    'schemaVersion receiptKind boundaryVersion operation action resourceType accessMode eventContract authoritySha256 idempotencyKeySha256 outcomeSha256 resourceCount occurredAt receiptSha256',
  );
  final mutation = operation == 'memory.promotions.decide';
  memoryRequire(!mutation || sent != null);
  final authority = mutation ? sent!.owner : owner;
  final execution = mutation
      ? {
          'version': 1,
          'tenantId': authority.tenantId,
          'initiatingActorId': authority.actorId,
          'executingPrincipalType': 'user',
          'executingPrincipalId': authority.actorId,
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
          'purpose': 'api.memory.promotions.decide',
        }
      : null;
  memoryRequire(
    row['schemaVersion'] == 1 &&
        row['receiptKind'] == 'app_service_receipt' &&
        row['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
        row['operation'] == operation &&
        row['action'] == (mutation ? 'write.memory' : 'read') &&
        row['resourceType'] == 'memory_promotion_review' &&
        row['accessMode'] == (mutation ? 'mutation' : 'read') &&
        row['eventContract'] ==
            (mutation
                ? 'memory.atomic-events.v1'
                : 'read_only:no_domain_mutation') &&
        row['resourceCount'] == count &&
        row['idempotencyKeySha256'] ==
            (mutation
                ? await memoryShaText(
                    '${sent!.owner.tenantId}\u0000${sent.key}',
                  )
                : null),
  );
  memoryRequire(
    row['authoritySha256'] ==
        await memorySha({
          'boundaryVersion': 'p9.1-app-service-boundary:1',
          'tenantId': authority.tenantId,
          'actorId': authority.actorId,
          'role': authority.role,
          'executionScope': execution,
        }),
  );
  _instant(row['occurredAt']);
  final receiptBody = {...row}..remove('receiptSha256');
  final body = {...raw}..remove('serviceReceipt');
  memoryRequire(
    row['receiptSha256'] == await memorySha(receiptBody) &&
        row['outcomeSha256'] == await memorySha(body),
  );
}

Future<List<MemoryPromotionSummary>> parseMemoryPromotions(
  Object? value,
  KnowledgeOwner owner, {
  required String status,
  required int limit,
}) async {
  final raw = _object(value, 'contract scope reviews serviceReceipt');
  memoryRequire(
    raw['contract'] == memoryPromotionReadContract &&
        limit >= 1 &&
        limit <= 50 &&
        const {'pending', 'resolved', 'all'}.contains(status) &&
        utf8.encode(jsonEncode(raw)).length <= 1000000,
  );
  _scope(raw['scope'], owner);
  final values = raw['reviews'];
  memoryRequire(values is List && values.length <= limit);
  final reviews = (values as List)
      .map((row) => MemoryPromotionSummary.parse(row, owner))
      .toList();
  memoryRequire(
    reviews.map((row) => row.id).toSet().length == reviews.length &&
        reviews.every((row) => status == 'all' || row.status == status),
  );
  await _receipt(raw, owner, 'memory.promotions.list', reviews.length);
  return List.unmodifiable(reviews);
}

class MemoryPromotionRead {
  const MemoryPromotionRead(this.raw, this.review, this.acceptance);
  final KnowledgeJson raw;
  final MemoryPromotionReview review;
  final KnowledgeJson? acceptance;
  static Future<MemoryPromotionRead> parse(
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
    memoryRequire(
      raw['contract'] == memoryPromotionReadContract &&
          utf8.encode(jsonEncode(raw)).length <= 1000000,
    );
    _scope(raw['scope'], owner);
    final review = await MemoryPromotionReview.parseExact(raw['review'], owner);
    memoryRequire(review.id == id);
    if (keyHash != null) {
      memoryHash(keyHash);
    }
    KnowledgeJson? accepted;
    if (raw['acceptance'] != null) {
      accepted = _object(
        raw['acceptance'],
        'contract id tenantId ownerActorId reviewId canonicalMemoryId decision idempotencyKeySha256 requestSha256 expectedReviewToken policySha256 sourceManifestSha256 sourceTargets promotedMemoryId promotedTargetRevision resolvedAt',
      );
      final hash = memoryHash(accepted['idempotencyKeySha256']);
      for (final field in [
        'requestSha256',
        'expectedReviewToken',
        'policySha256',
      ]) {
        memoryHash(accepted[field]);
      }
      final sources = memoryPromotionSourceTargets(accepted['sourceTargets']);
      memoryRequire(
        accepted['contract'] == 'asael-memory-promotion-acceptance:1' &&
            accepted['tenantId'] == owner.tenantId &&
            accepted['ownerActorId'] == owner.canonicalActorId &&
            accepted['reviewId'] == id &&
            accepted['canonicalMemoryId'] == review.canonicalId &&
            accepted['decision'] == review.decision &&
            review.status == 'resolved' &&
            accepted['resolvedAt'] == review.raw['resolvedAt'] &&
            accepted['promotedMemoryId'] == review.raw['promotedMemoryId'] &&
            accepted['sourceManifestSha256'] == await memorySha(sources) &&
            memoryCanonical(
                  sources.map((source) => source['memoryId']).toList(),
                ) ==
                memoryCanonical(review.sourceIds) &&
            (keyHash == null || keyHash == hash) &&
            accepted['id'] ==
                'memory-promotion-acceptance:${await memorySha(['memory-promotion-acceptance:1', owner.tenantId, owner.canonicalActorId, hash])}',
      );
      _instant(accepted['resolvedAt']);
      if (accepted['decision'] == 'promote') {
        memoryRequire(
          accepted['promotedMemoryId'] ==
                  'memory_promoted_${(await memoryShaText(id)).substring(0, 48)}' &&
              sources.every((source) => source['claimStatus'] == 'active'),
        );
        memoryRequire(accepted['promotedTargetRevision'] == 1);
      } else {
        memoryRequire(
          accepted['decision'] == 'dismiss' &&
              accepted['promotedMemoryId'] == null &&
              accepted['promotedTargetRevision'] == null,
        );
      }
      for (var index = 0; index < sources.length; index++) {
        final before = sources[index], current = review.sources[index];
        memoryRequire(
          (current['targetRevision'] as int) >=
                  (before['targetRevision'] as int) &&
              (current['lifecycleRevision'] as int) >=
                  (before['lifecycleRevision'] as int) &&
              (current['targetRevision'] != before['targetRevision'] ||
                  current['claimStatus'] == before['claimStatus'] &&
                      current['sourcePolicySha256'] ==
                          before['sourcePolicySha256']),
        );
      }
      if (sent != null) {
        memoryRequire(
          sent.kind == MemoryChange.promotion &&
              sent.id == id &&
              sent.owner.tenantId == owner.tenantId &&
              sent.owner.userId == owner.userId &&
              sent.owner.apiBaseUrl == owner.apiBaseUrl &&
              hash == await memoryShaText(sent.key) &&
              accepted['decision'] == sent.body['decision'] &&
              accepted['expectedReviewToken'] ==
                  sent.body['expectedReviewToken'] &&
              accepted['policySha256'] == sent.body['expectedPolicySha256'] &&
              accepted['sourceManifestSha256'] ==
                  sent.body['expectedSourceManifestSha256'] &&
              accepted['canonicalMemoryId'] ==
                  sent.promotionEvidence!['canonicalMemoryId'] &&
              memoryCanonical(sources) ==
                  memoryCanonical(sent.promotionEvidence!['sourceTargets']),
        );
      }
    }
    if (mutation) {
      memoryRequire(
        sent != null && accepted != null && raw['replayed'] is bool,
      );
      final committed = accepted!;
      final projections = _object(raw['projections'], 'graph entities');
      const states = {
        'confirmed',
        'unconfirmed',
        'not_applicable',
        'not_repeated',
      };
      memoryRequire(
        projections.values.every(
          (state) =>
              states.contains(state) &&
              (state == 'not_repeated') == raw['replayed'],
        ),
      );
      if (raw['replayed'] == false) {
        memoryRequire(
          review.raw['policySha256'] == committed['policySha256'] &&
              review.raw['sourceManifestSha256'] ==
                  committed['sourceManifestSha256'] &&
              (committed['decision'] == 'dismiss'
                  ? projections.values.every(
                      (value) => value == 'not_applicable',
                    )
                  : projections['graph'] != 'not_applicable'),
        );
      }
    } else if (keyHash == null) {
      memoryRequire(accepted == null);
    }
    await _receipt(
      raw,
      owner,
      mutation ? 'memory.promotions.decide' : 'memory.promotions.read',
      1,
      sent: sent,
    );
    return MemoryPromotionRead(
      freezeKnowledgeJson(raw) as KnowledgeJson,
      review,
      accepted == null ? null : freezeKnowledgeJson(accepted) as KnowledgeJson,
    );
  }
}

abstract interface class KnowledgePromotionRepository {
  bool get supportsPromotions;
  Future<List<MemoryPromotionSummary>> listPromotions({
    String status = 'pending',
    int limit = 25,
  });
  Future<MemoryPromotionRead> readPromotion(
    String id, {
    String? acceptanceKeySha256,
  });
}
