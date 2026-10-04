import 'dart:async';

import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_contracts.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_private_action_contracts.dart';
import 'package:asael/features/knowledge/knowledge_recovery_store.dart';

import 'knowledge_review_fixtures.dart';

final sourceMapTestId = 'cognition_batch_${'a' * 48}';
Future<Json> privateSeal(
  Json body,
  String operation, {
  MemorySubmission? sent,
  KnowledgeOwner owner = reviewOwner,
}) async {
  final deletion = operation.contains('sources.native'),
      mutation = sent != null;
  final execution = mutation
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
              : await memorySha(sent.key),
          'causationId': sent.id,
          'contextGrantIds': <String>[],
          'capabilityGrantIds': <String>[],
          'purpose': deletion
              ? 'api.knowledge.sources.delete'
              : 'api.knowledge.cognification.decide',
        }
      : null;
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': operation,
    'action': mutation ? 'write.memory' : 'read',
    'resourceType': deletion ? 'knowledge' : 'knowledge_cognition',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? deletion
              ? 'knowledge-source-deletion-native-events.v1'
              : 'knowledge-cognification-native-events.v1'
        : 'read_only:no_domain_mutation',
    'authoritySha256': await memorySha({
      'boundaryVersion': 'p9.1-app-service-boundary:1',
      'tenantId': owner.tenantId,
      'actorId': owner.actorId,
      'role': owner.role,
      'executionScope': execution,
    }),
    'idempotencyKeySha256': sent == null
        ? null
        : await memoryShaText('${sent.owner.tenantId}\u0000${sent.key}'),
    'outcomeSha256': await memorySha(body),
    'resourceCount': body.containsKey('reviews')
        ? (body['reviews'] as List).length
        : deletion &&
              body.containsKey('acceptance') &&
              body['acceptance'] == null
        ? 0
        : 1,
    'occurredAt': reviewAt,
  };
  return {
    ...body,
    'serviceReceipt': {...receipt, 'receiptSha256': await memorySha(receipt)},
  };
}

Future<Json> sourceMapRow({String? decision}) async {
  final pin = {
    'candidateId': sourceMapTestId,
    'candidateSha256': 'b' * 64,
    'documentId': 'doc:one',
    'sourceItemId': 'source:one',
    'sourceRevisionId': 'source:one:v1',
    'sourcePolicySha256': 'c' * 64,
    'retentionExpiresAt': null,
    'reviewStateSha256': 'd' * 64,
    'policySha256': await memorySha({
      'version': 1,
      'operation': 'knowledge.cognition.decide',
      'scope': 'current-owner-private',
      'review': 'exact-source-policy-and-candidate',
      'formation': 'reviewed_source_cognition',
      'projections': 'new-commit-only',
    }),
  };
  return {
    'id': sourceMapTestId,
    'documentId': 'doc:one',
    'sourceTitle': 'Private project notes',
    'status': decision == null
        ? 'pending_review'
        : decision == 'confirm'
        ? 'confirmed'
        : 'dismissed',
    'decision': decision,
    'createdAt': reviewAt,
    'updatedAt': reviewAt,
    'reviewedAt': decision == null ? null : reviewAt,
    'batchIndex': 0,
    'batchCount': 1,
    'summary': {
      'text': 'Review this private planning claim.',
      'confidenceBasisPoints': 8000,
      'evidence': [
        {'quote': 'The rollout requires explicit review.'},
      ],
    },
    'topics': [
      {'label': 'Rollout'},
    ],
    'claims': [
      {'statement': 'Review is required.'},
    ],
    'entities': [
      {'canonicalLabel': 'Project One'},
    ],
    'relations': <Json>[],
    'allowedDecisions': decision == null ? ['confirm', 'dismiss'] : <String>[],
    'review': decision == null
        ? {...pin, 'reviewSha256': await memorySha(pin)}
        : null,
    'projection': decision == 'confirm' ? 'unconfirmed' : 'not_requested',
  };
}

Future<Json> deletionReviewFixture({String kind = 'mail'}) async {
  final pin = {
    'sourceKind': kind,
    'documentCount': 1,
    'derivedMemoryCount': 2,
    'retrievalTraceCount': 1,
    'graphNodeCount': 2,
    'graphEdgeCount': 1,
    'manifestSha256': 'a' * 64,
    'policySha256': await memorySha({
      'version': 1,
      'scope': 'owned-private-connected-source',
      'maximumDocuments': 500,
      'maximumMemories': 2000,
      'maximumGraphItemsPerKind': 5000,
      'localOnly': true,
      'exactReviewedLineage': true,
    }),
  };
  return privateSeal({
    'contract': sourceDeletionReadContract,
    'scope': privateActionScope(reviewOwner),
    'sourceKind': kind,
    'review': {
      'sourceKind': kind,
      'localOnly': true,
      'futureImportsMayReappear': true,
      'eligible': true,
      'reason': null,
      'pin': {...pin, 'reviewSha256': await memorySha(pin)},
      'documents': [
        {
          'id': 'document:mail-one',
          'title': 'Private imported message',
          'expired': false,
        },
      ],
    },
  }, 'app.knowledge.sources.native.deletion.review');
}

Future<MemorySubmission> privateSubmission({
  bool deletion = false,
  String key = 'private-action-key',
  String decision = 'confirm',
}) async {
  final body = deletion
      ? (await KnowledgeSourceDeletionReview.parse(
          await deletionReviewFixture(),
          reviewOwner,
          'mail',
        )).decisionBody
      : (await KnowledgeSourceMap.parse(await sourceMapRow()))
            .decisionBody(decision);
  return MemorySubmission(
    kind: deletion ? MemoryChange.sourceDelete : MemoryChange.sourceMap,
    owner: reviewOwner,
    id: deletion ? await sourceDeletionTarget('mail') : sourceMapTestId,
    key: key,
    body: body,
  );
}

Future<Json> privateAcceptance(MemorySubmission sent) async {
  final deletion = sent.kind == MemoryChange.sourceDelete,
      scope = privateActionScope(sent.owner),
      keyHash = await memoryShaText('${sent.owner.tenantId}\u0000${sent.key}');
  final operation = deletion
      ? 'knowledge.source.delete'
      : 'knowledge.cognition.decide';
  final pin = knowledgeMap(sent.body['review'], 'Pin');
  final intent = {
    'contract': 'asael-private-memory-action-intent:1',
    'operation': operation,
    'scope': scope,
    'resourceId': sent.id,
    'keySha256': keyHash,
    'request': sent.body,
  };
  final acceptance = {
    'contract': deletion
        ? 'asael-knowledge-source-deletion-acceptance:1'
        : 'asael-knowledge-cognition-acceptance:1',
    'id':
        'private-action-acceptance:${await memorySha({'scope': scope, 'keySha256': keyHash})}',
    'operation': operation,
    'scope': scope,
    'resourceId': sent.id,
    'keySha256': keyHash,
    'requestSha256': await memorySha(intent),
    'reviewSha256': pin['reviewSha256'],
    'acceptedAt': reviewAt,
    'result': deletion
        ? {
            'sourceKind': pin['sourceKind'],
            'localOnly': true,
            'manifestSha256': pin['manifestSha256'],
            'documents': pin['documentCount'],
            'memories': pin['derivedMemoryCount'],
            'retrievalTraces': pin['retrievalTraceCount'],
            'graphNodes': pin['graphNodeCount'],
            'graphEdges': pin['graphEdgeCount'],
          }
        : {
            'decision': sent.body['decision'],
            'status': sent.body['decision'] == 'confirm'
                ? 'confirmed'
                : 'dismissed',
            'memoryId': sent.body['decision'] == 'confirm'
                ? 'memory:${sent.id}'
                : null,
            'memoryTargetRevision': sent.body['decision'] == 'confirm'
                ? 1
                : null,
          },
  };
  return {...acceptance, 'acceptanceSha256': await memorySha(acceptance)};
}

Future<Json> privateResponse(
  MemorySubmission sent, {
  bool mutation = true,
  bool absent = false,
  KnowledgeOwner owner = reviewOwner,
}) async {
  final deletion = sent.kind == MemoryChange.sourceDelete;
  return privateSeal(
    {
      'contract': deletion ? sourceDeletionReadContract : sourceMapReadContract,
      'scope': privateActionScope(owner),
      if (deletion)
        'sourceKind': (sent.body['review'] as Map)['sourceKind']
      else
        'review': await sourceMapRow(
          decision: absent ? null : sent.body['decision'] as String,
        ),
      'acceptance': absent ? null : await privateAcceptance(sent),
      if (mutation) 'replayed': false,
    },
    deletion
        ? 'app.knowledge.sources.native.${mutation ? 'delete' : 'deletion.get'}'
        : 'app.knowledge.cognification.native.${mutation ? 'decide' : 'decision.get'}',
    sent: mutation ? sent : null,
    owner: owner,
  );
}

class PrivateActionRepository extends ReviewRepository
    implements KnowledgePrivateActionRepository {
  bool loseResponse = false, returnAbsent = false;
  Completer<KnowledgeSourceMapRead>? heldMap;
  final privateSubmissions = <MemorySubmission>[];
  MemorySubmission? acceptedPrivate;
  @override
  bool get supportsSourceMaps => true;
  @override
  bool get supportsSourceDeletion => true;
  @override
  Future<List<KnowledgeSourceMap>> listSourceMaps({
    String status = 'pending_review',
    int limit = 25,
  }) async => [await KnowledgeSourceMap.parse(await sourceMapRow())];
  @override
  Future<KnowledgeSourceMapRead> readSourceMap(
    String id, {
    String? keySha256,
  }) async {
    if (heldMap != null) {
      return await heldMap!.future;
    }
    final raw = keySha256 == null
        ? await privateSeal(
            {
              'contract': sourceMapReadContract,
              'scope': privateActionScope(access.owner!),
              'review': await sourceMapRow(),
            },
            'app.knowledge.cognification.native.read',
            owner: access.owner!,
          )
        : await privateResponse(
            acceptedPrivate!,
            mutation: false,
            absent: returnAbsent,
            owner: access.owner!,
          );
    return KnowledgeSourceMapRead.parse(
      raw,
      access.owner!,
      id,
      keyHash: keySha256,
    );
  }

  @override
  Future<KnowledgeSourceDeletionReview> reviewSourceDeletion(
    String kind,
  ) async => KnowledgeSourceDeletionReview.parse(
    await deletionReviewFixture(kind: kind),
    access.owner!,
    kind,
  );
  @override
  Future<KnowledgeSourceDeletionRead> readSourceDeletion(
    String kind,
    String keySha256,
  ) async => KnowledgeSourceDeletionRead.parse(
    await privateResponse(
      acceptedPrivate!,
      mutation: false,
      absent: returnAbsent,
      owner: access.owner!,
    ),
    access.owner!,
    kind,
    keyHash: keySha256,
  );
  @override
  Future<MemoryAcceptance> submit(
    MemorySubmission sent,
    bool Function() current,
  ) async {
    await beforeSubmit?.call(sent);
    memoryRequire(current());
    privateSubmissions.add(sent);
    acceptedPrivate = sent;
    if (loseResponse) {
      throw StateError('Response lost');
    }
    return MemoryAcceptance.parse(await privateResponse(sent), sent);
  }
}

KnowledgeController privateController(
  PrivateActionRepository repository,
  KnowledgeRecoveryStore store,
) => KnowledgeController(
  repository,
  canManage: repository.access.owner!.canWrite,
  mutationsAvailable: false,
  recoveryStore: store,
);
