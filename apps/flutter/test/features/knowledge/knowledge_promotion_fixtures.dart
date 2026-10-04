import 'dart:async';

import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_promotion_contracts.dart';
import 'package:asael/features/knowledge/knowledge_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'knowledge_review_fixtures.dart'
    show reviewAt, reviewMemory, reviewOwner, reviewScope;

const promotionId = 'promotion:one';
List<Json> promotionSources() => [
  for (final id in ['memory:a', 'memory:b'])
    {
      'memoryId': id,
      'claimStatus': 'active',
      'targetRevision': 3,
      'lifecycleRevision': 1,
      'sourcePolicySha256': 'b' * 64,
    },
];

Future<Json> promotionRow({
  String id = promotionId,
  String? decision,
  bool writable = true,
  List<Json>? sources,
}) async {
  final targets = sources ?? promotionSources();
  return {
    'id': id,
    'tenantId': reviewOwner.tenantId,
    'policyVersion': 1,
    'status': decision == null ? 'pending' : 'resolved',
    'decision': decision,
    'canonicalMemoryId': 'memory:a',
    'canonicalTitle': 'memory:a',
    'sourceMemoryIds': ['memory:a', 'memory:b'],
    'targetTier': 'procedural',
    'promotedMemoryId': decision == 'promote'
        ? 'memory_promoted_${(await memoryShaText(id)).substring(0, 48)}'
        : null,
    'createdAt': reviewAt,
    'updatedAt': reviewAt,
    'resolvedAt': decision == null ? null : reviewAt,
    'canonical': reviewMemory(
      'memory:a',
      claim: targets.first['claimStatus'] as String,
      content: 'Prepare complete private review notes before each meeting.',
    ),
    'sourceTargets': targets,
    'policySha256': 'c' * 64,
    'sourceManifestSha256': await memorySha(targets),
    'allowedDecisions': decision == null && writable
        ? ['promote', 'dismiss']
        : <String>[],
    'reviewToken': decision == null && writable ? 'a' * 64 : null,
  };
}

Json promotionSummary(Json row) {
  final summary = {...row};
  for (final field in [
    'canonical',
    'sourceTargets',
    'policySha256',
    'sourceManifestSha256',
    'allowedDecisions',
    'reviewToken',
  ]) {
    summary.remove(field);
  }
  return summary;
}

Future<Json> sealPromotion(
  Json body, {
  required String operation,
  MemorySubmission? sent,
  KnowledgeOwner owner = reviewOwner,
  int count = 1,
}) async {
  final mutation = sent != null;
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': operation,
    'action': mutation ? 'write.memory' : 'read',
    'resourceType': 'memory_promotion_review',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? 'memory.atomic-events.v1'
        : 'read_only:no_domain_mutation',
    'authoritySha256': await memorySha({
      'boundaryVersion': 'p9.1-app-service-boundary:1',
      'tenantId': owner.tenantId,
      'actorId': owner.actorId,
      'role': owner.role,
      'executionScope': mutation
          ? {
              'version': 1,
              'tenantId': owner.tenantId,
              'initiatingActorId': owner.actorId,
              'executingPrincipalType': 'user',
              'executingPrincipalId': owner.actorId,
              'workspaceId': null,
              'projectId': null,
              'missionId': null,
              'delegationId': null,
              'correlationId': sent.key.length <= 256
                  ? sent.key
                  : 'idempotency-key:${await memorySha(sent.key)}',
              'causationId': sent.id,
              'contextGrantIds': <String>[],
              'capabilityGrantIds': <String>[],
              'purpose': 'api.memory.promotions.decide',
            }
          : null,
    }),
    'idempotencyKeySha256': mutation
        ? await memoryShaText('${owner.tenantId}\u0000${sent.key}')
        : null,
    'outcomeSha256': await memorySha(body),
    'resourceCount': count,
    'occurredAt': reviewAt,
  };
  return {
    ...body,
    'serviceReceipt': {...receipt, 'receiptSha256': await memorySha(receipt)},
  };
}

Future<Json> promotionResponse(
  Json row, {
  Json? acceptance,
  MemorySubmission? sent,
  bool replayed = false,
  KnowledgeOwner owner = reviewOwner,
}) => sealPromotion(
  {
    'contract': memoryPromotionReadContract,
    'scope': reviewScope(owner),
    'review': row,
    'acceptance': acceptance,
    if (sent != null) ...{
      'replayed': replayed,
      'projections': {
        'graph': replayed
            ? 'not_repeated'
            : sent.body['decision'] == 'dismiss'
            ? 'not_applicable'
            : 'unconfirmed',
        'entities': replayed ? 'not_repeated' : 'not_applicable',
      },
    },
  },
  operation: sent == null
      ? 'memory.promotions.read'
      : 'memory.promotions.decide',
  sent: sent,
  owner: owner,
);

Future<Json> promotionList(Json row, {KnowledgeOwner owner = reviewOwner}) =>
    sealPromotion(
      {
        'contract': memoryPromotionReadContract,
        'scope': reviewScope(owner),
        'reviews': [promotionSummary(row)],
      },
      operation: 'memory.promotions.list',
      owner: owner,
    );

Future<MemorySubmission> promotionSubmission({
  String decision = 'promote',
  String key = 'fixed-promotion-key',
}) async {
  final review = await MemoryPromotionReview.parseExact(
    await promotionRow(),
    reviewOwner,
  );
  return MemorySubmission(
    kind: MemoryChange.promotion,
    owner: reviewOwner,
    id: review.id,
    key: key,
    body: review.decisionBody(decision),
    promotionEvidence: review.evidence,
  );
}

Future<Json> promotionAcceptance(MemorySubmission sent) async {
  final hash = await memoryShaText(sent.key),
      promote = sent.body['decision'] == 'promote';
  return {
    'contract': 'asael-memory-promotion-acceptance:1',
    'id':
        'memory-promotion-acceptance:${await memorySha(['memory-promotion-acceptance:1', sent.owner.tenantId, sent.owner.canonicalActorId, hash])}',
    'tenantId': sent.owner.tenantId,
    'ownerActorId': sent.owner.canonicalActorId,
    'reviewId': sent.id,
    'canonicalMemoryId': sent.promotionEvidence!['canonicalMemoryId'],
    'decision': sent.body['decision'],
    'idempotencyKeySha256': hash,
    'requestSha256': 'd' * 64,
    'expectedReviewToken': sent.body['expectedReviewToken'],
    'policySha256': sent.body['expectedPolicySha256'],
    'sourceManifestSha256': sent.body['expectedSourceManifestSha256'],
    'sourceTargets': sent.promotionEvidence!['sourceTargets'],
    'promotedMemoryId': promote
        ? 'memory_promoted_${(await memoryShaText(sent.id!)).substring(0, 48)}'
        : null,
    'promotedTargetRevision': promote ? 1 : null,
    'resolvedAt': reviewAt,
  };
}

class PromotionRepository extends Fake
    implements
        KnowledgeRepository,
        KnowledgeMutationRepository,
        KnowledgePromotionRepository {
  PromotionRepository(this.row, {KnowledgeOwner owner = reviewOwner}) {
    access.update(owner, true);
  }
  Json row;
  Json? accepted;
  Object? readFailure, submitFailure;
  bool failCatalogue = false;
  Completer<MemoryPromotionRead>? heldRead;
  Completer<MemoryAcceptance>? heldSubmit;
  Future<void> Function(MemorySubmission)? beforeSubmit;
  final submissions = <MemorySubmission>[];
  final reads = <({String id, String? hash})>[];
  @override
  final access = KnowledgeAccess();
  @override
  bool authorityCurrent() => access.readable;
  @override
  bool supports(MemoryChange kind) => true;
  @override
  bool get supportsPromotions => true;
  @override
  Future<List<MemoryPromotionSummary>> listPromotions({
    String status = 'pending',
    int limit = 25,
  }) async => status == 'all' || status == row['status']
      ? [MemoryPromotionSummary.parse(promotionSummary(row), access.owner!)]
      : [];
  @override
  Future<MemoryPromotionRead> readPromotion(
    String id, {
    String? acceptanceKeySha256,
  }) async {
    reads.add((id: id, hash: acceptanceKeySha256));
    if (readFailure != null) {
      throw readFailure!;
    }
    if (heldRead != null) {
      return heldRead!.future;
    }
    return MemoryPromotionRead.parse(
      await promotionResponse(
        row,
        acceptance: acceptanceKeySha256 == null ? null : accepted,
        owner: access.owner!,
      ),
      access.owner!,
      id,
      keyHash: acceptanceKeySha256,
    );
  }

  @override
  Future<MemoryAcceptance> submit(
    MemorySubmission sent,
    bool Function() current,
  ) async {
    await beforeSubmit?.call(sent);
    memoryRequire(current());
    submissions.add(sent);
    if (submitFailure != null) {
      throw submitFailure!;
    }
    if (heldSubmit != null) {
      return heldSubmit!.future;
    }
    accepted = await promotionAcceptance(sent);
    row = await promotionRow(decision: sent.body['decision'] as String);
    return MemoryAcceptance.parse(
      await promotionResponse(row, acceptance: accepted, sent: sent),
      sent,
    );
  }

  @override
  Future<KnowledgeState> load({String query = '', String type = 'all'}) async {
    if (failCatalogue) {
      throw StateError('Catalogue unavailable');
    }
    return const KnowledgeState(
      memories: [],
      knowledge: [],
      nodes: [],
      edges: [],
    );
  }
}

KnowledgeController promotionController(
  PromotionRepository repository,
  KnowledgeRecoveryStore store,
) => KnowledgeController(
  repository,
  canManage: repository.access.owner!.canWrite,
  mutationsAvailable: false,
  recoveryStore: store,
);
