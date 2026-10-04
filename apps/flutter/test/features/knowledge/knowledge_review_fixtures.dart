import 'dart:async';

import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_recovery_store.dart';
import 'package:asael/features/knowledge/knowledge_review_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

const reviewOwner = KnowledgeOwner(
  'tenant',
  'operator@example.test',
  '00000000-0000-4000-8000-000000000001',
  'operator',
  'https://example.test',
);
const reviewAt = '2026-10-04T12:00:00.000Z';
final reviewToken = 'a' * 64;

Json reviewMemory(
  String id, {
  String claim = 'candidate',
  String content = 'Private candidate content',
}) => {
  'id': id,
  'tenantId': reviewOwner.tenantId,
  'type': 'fact',
  'tier': 'semantic',
  'tierPolicyVersion': 1,
  'title': id,
  'content': content,
  'tags': <String>[],
  'scope': 'user',
  'source': 'User review',
  'importance': .5,
  'confidence': .8,
  'claimStatus': claim,
  'assertedBy': 'user',
  'createdAt': reviewAt,
  'updatedAt': reviewAt,
  'access': {
    'visibility': 'user_private',
    'sensitivity': 'confidential',
    'scope': 'user',
    'owner': 'current_user',
  },
  'explainability': {
    'why': 'Awaiting review',
    'source': 'User review',
    'scope': 'user',
    'confidence': .8,
    'lastUsedAt': null,
    'useCount': 0,
    'validity': claim,
    'validFrom': null,
    'validTo': null,
    'retentionExpiresAt': null,
    'policy': {
      'version': 1,
      'tier': 'semantic',
      'retention': {
        'mode': 'until_invalidated',
        'defaultDays': null,
        'expiredRecordsAreRetrievable': false,
      },
      'promotion': {
        'targets': <String>[],
        'automatic': false,
        'minimumVerifiedOccurrences': 1,
        'review': 'not_promotable',
      },
      'correction': {
        'strategy': 'superseding_revision',
        'preserveHistory': true,
        'confidenceIncreaseRequiresEvidence': true,
      },
      'retrieval': {
        'requiresActiveClaim': true,
        'requiresTemporalValidity': true,
        'requiresAuthorizedScope': true,
        'sessionAffinityRequired': false,
        'priorityWeight': 1,
      },
    },
    'lifecycle': {
      'policyVersion': 1,
      'pinned': false,
      'pinnedAt': null,
      'archived': false,
      'archivedAt': null,
      'archiveReason': null,
      'duplicateOfMemoryId': null,
      'retrievalPriorityMultiplier': 1,
      'historicalTruthChanged': false,
    },
  },
};

Json reviewRow({
  String id = 'review:one',
  bool contradiction = false,
  bool writable = true,
  String? decision,
  String content = 'Private candidate content',
}) => {
  'id': id,
  'tenantId': reviewOwner.tenantId,
  'kind': contradiction ? 'contradiction' : 'confirmation',
  'status': decision == null ? 'pending' : 'resolved',
  'detectionReason': contradiction
      ? 'explicit_contradiction'
      : 'unconfirmed_candidate',
  'candidate': reviewMemory(
    'memory:candidate',
    claim: decision == null
        ? 'candidate'
        : decision == 'keep_existing'
        ? 'superseded'
        : 'active',
    content: content,
  ),
  if (contradiction)
    'existing': reviewMemory(
      'memory:existing',
      claim: decision == 'confirm_candidate' ? 'contradicted' : 'active',
      content: 'Existing private content',
    ),
  'createdAt': reviewAt,
  'updatedAt': reviewAt,
  'reviewToken': decision == null && writable ? reviewToken : null,
  if (decision != null) ...{'decision': decision, 'resolvedAt': reviewAt},
};
Json reviewScope(KnowledgeOwner owner) => {
  'tenantId': owner.tenantId,
  'ownerActorId': owner.canonicalActorId,
  'visibility': 'user_private',
};

Future<Json> sealReview(
  Json body, {
  required String operation,
  KnowledgeOwner owner = reviewOwner,
  MemorySubmission? sent,
  int count = 1,
}) async {
  final mutation = operation == 'memory.reconciliation.resolve';
  final receipt = <String, dynamic>{
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': operation,
    'action': mutation ? 'write.memory' : 'read',
    'resourceType': 'memory_reconciliation',
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
              'correlationId': sent!.key.length <= 256
                  ? sent.key
                  : 'idempotency-key:${await memorySha(sent.key)}',
              'causationId': sent.id,
              'contextGrantIds': <String>[],
              'capabilityGrantIds': <String>[],
              'purpose': 'api.memory.reconciliation.native.resolve',
            }
          : null,
    }),
    'idempotencyKeySha256': mutation
        ? await memoryShaText('${owner.tenantId}\u0000${sent!.key}')
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

Future<Json> reviewList(
  List<Json> rows, {
  KnowledgeOwner owner = reviewOwner,
}) => sealReview(
  {
    'contract': memoryReviewReadContract,
    'scope': reviewScope(owner),
    'reviews': rows,
  },
  operation: 'memory.reconciliation.list',
  owner: owner,
  count: rows.length,
);

Future<Json> reviewRead(
  Json row, {
  Json? acceptance,
  KnowledgeOwner owner = reviewOwner,
}) => sealReview(
  {
    'contract': memoryReviewReadContract,
    'scope': reviewScope(owner),
    'review': row,
    'acceptance': acceptance,
  },
  operation: 'memory.reconciliation.read',
  owner: owner,
);

MemorySubmission reviewSubmission({
  String key = 'review-fixed-key',
  String decision = 'confirm_candidate',
  bool contradiction = false,
}) => MemorySubmission(
  kind: MemoryChange.review,
  owner: reviewOwner,
  id: 'review:one',
  key: key,
  body: {
    'contract': memoryReviewDecisionContract,
    'reviewId': 'review:one',
    'decision': decision,
    'expectedReviewToken': reviewToken,
  },
  reviewEvidence: {
    'kind': contradiction ? 'contradiction' : 'confirmation',
    'candidateMemoryId': 'memory:candidate',
    'existingMemoryId': contradiction ? 'memory:existing' : null,
  },
);

Future<Json> reviewAcceptance(MemorySubmission sent) async {
  final hash = await memoryShaText(sent.key), decision = sent.body['decision'];
  final existing = sent.reviewEvidence!['existingMemoryId'] as String?;
  Json target(String id, String claim, int revision) => {
    'memoryId': id,
    'claimStatus': claim,
    'targetRevision': revision,
    'lifecycleRevision': 0,
  };
  return {
    'contract': 'asael-memory-reconciliation-acceptance:1',
    'id':
        'memory-reconciliation-acceptance:${await memorySha(['memory-reconciliation-acceptance:1', sent.owner.tenantId, sent.owner.canonicalActorId, hash])}',
    'tenantId': sent.owner.tenantId,
    'ownerActorId': sent.owner.canonicalActorId,
    'reviewId': sent.id,
    'candidateMemoryId': sent.reviewEvidence!['candidateMemoryId'],
    'existingMemoryId': existing,
    'decision': decision,
    'idempotencyKeySha256': hash,
    'requestSha256': 'b' * 64,
    'expectedReviewToken': sent.body['expectedReviewToken'],
    'resolvedAt': reviewAt,
    'before': {
      'candidate': target('memory:candidate', 'candidate', 3),
      'existing': existing == null ? null : target(existing, 'active', 7),
    },
    'after': {
      'candidate': target(
        'memory:candidate',
        decision == 'keep_existing' ? 'superseded' : 'active',
        4,
      ),
      'existing': existing == null
          ? null
          : target(
              existing,
              decision == 'confirm_candidate' ? 'contradicted' : 'active',
              decision == 'confirm_candidate' ? 8 : 7,
            ),
    },
  };
}

Future<Json> reviewDecisionResponse(
  MemorySubmission sent, {
  bool replayed = false,
}) async => sealReview(
  {
    'contract': memoryReviewReadContract,
    'scope': reviewScope(sent.owner),
    'review': reviewRow(
      contradiction: sent.reviewEvidence!['kind'] == 'contradiction',
      decision: sent.body['decision'] as String,
    ),
    'acceptance': await reviewAcceptance(sent),
    'replayed': replayed,
    'projections': {
      'graph': replayed ? 'not_repeated' : 'unconfirmed',
      'entities': replayed ? 'not_repeated' : 'confirmed',
      'retiredLineage': replayed ? 'not_repeated' : 'not_applicable',
    },
  },
  operation: 'memory.reconciliation.resolve',
  owner: sent.owner,
  sent: sent,
);

class ReviewRepository extends Fake
    implements
        KnowledgeRepository,
        KnowledgeMutationRepository,
        KnowledgeReviewRepository {
  ReviewRepository({KnowledgeOwner owner = reviewOwner}) {
    access.update(owner, true);
  }
  @override
  final access = KnowledgeAccess();
  final submissions = <MemorySubmission>[];
  final reads = <({String id, String? hash})>[];
  Json row = reviewRow();
  Json? accepted;
  Object? readFailure, submitFailure;
  bool failCatalogue = false;
  Completer<MemoryReviewRead>? heldRead;
  Future<void> Function(MemorySubmission)? beforeSubmit;
  @override
  bool get supportsReviews => true;
  @override
  bool authorityCurrent() => access.readable;
  @override
  bool supports(MemoryChange kind) => true;
  @override
  Future<List<MemoryReview>> listReviews({
    String status = 'pending',
    int limit = 50,
  }) async => [MemoryReview.parse(row, access.owner!)];
  @override
  Future<MemoryReviewRead> readReview(
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
    return MemoryReviewRead.parse(
      await reviewRead(
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
    accepted = await reviewAcceptance(sent);
    row = reviewRow(
      contradiction: sent.reviewEvidence!['kind'] == 'contradiction',
      decision: sent.body['decision'] as String,
    );
    return MemoryAcceptance.parse(await reviewDecisionResponse(sent), sent);
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

KnowledgeController reviewController(
  ReviewRepository repo,
  KnowledgeRecoveryStore store,
) => KnowledgeController(
  repo,
  canManage: repo.access.owner!.canWrite,
  mutationsAvailable: true,
  recoveryStore: store,
);
