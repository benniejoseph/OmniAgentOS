import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_build_contracts.dart';
import 'package:asael/features/knowledge/knowledge_maintenance_contracts.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_private_action_contracts.dart';
import 'package:asael/features/knowledge/knowledge_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'knowledge_review_fixtures.dart';

Future<Json> _seal(
  Json body,
  String kind,
  String suffix, {
  MemorySubmission? sent,
}) async {
  final build = kind == 'build',
      maintenance = kind == 'maintenance',
      mutation = sent != null;
  final execution = mutation
      ? {
          'version': 1,
          'tenantId': reviewOwner.tenantId,
          'initiatingActorId': reviewOwner.actorId,
          'executingPrincipalType': 'user',
          'executingPrincipalId': reviewOwner.actorId,
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
          'purpose': build
              ? 'api.knowledge.cognification.build'
              : maintenance
              ? 'api.memory.maintenance.run'
              : 'api.memory.graph.rebuild',
        }
      : null;
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': build
        ? 'app.knowledge.cognification.native.$suffix'
        : '${deterministicService(kind)}.$suffix',
    'action': mutation ? 'write.memory' : 'read',
    'resourceType': build ? 'knowledge_cognition' : deterministicResource(kind),
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? build
              ? 'knowledge-cognification-build-native-events.v1'
              : maintenance
              ? 'memory-maintenance-native-events.v1'
              : 'memory-graph-native-events.v1'
        : 'read_only:no_domain_mutation',
    'authoritySha256': await memorySha({
      'boundaryVersion': 'p9.1-app-service-boundary:1',
      'tenantId': reviewOwner.tenantId,
      'actorId': reviewOwner.actorId,
      'role': reviewOwner.role,
      'executionScope': execution,
    }),
    'idempotencyKeySha256': sent == null ? null : await privateActionKey(sent),
    'outcomeSha256': await memorySha(body),
    'resourceCount':
        body.containsKey('acceptance') && body['acceptance'] == null ? 0 : 1,
    'occurredAt': reviewAt,
  };
  return {
    ...body,
    'serviceReceipt': {...receipt, 'receiptSha256': await memorySha(receipt)},
  };
}

Future<Json> _pin(String kind) async {
  final body = kind == 'maintenance'
      ? {
          'policyVersion': 1,
          'eligibleMemoryCount': 1,
          'inventorySha256': 'a' * 64,
          'planSha256': 'b' * 64,
          'policySha256': await deterministicPolicy(kind),
        }
      : kind == 'graph'
      ? {
          'memoryCount': 1,
          'traceCount': 0,
          'sourceManifestSha256': 'a' * 64,
          'graphPolicySha256': await deterministicPolicy(kind),
        }
      : {
          'documentId': 'document:one',
          'sourceItemId': 'source:one',
          'sourceRevisionId': 'source:one:v1',
          'sourcePolicySha256': 'a' * 64,
          'retentionExpiresAt': null,
          'generationId': 'cognition_generation_${'a' * 48}',
          'sourcePlanSha256': 'b' * 64,
          'batchCount': 1,
          'existingReviewCount': 0,
          'existingReviewManifestSha256': 'c' * 64,
          'policySha256': await memorySha({
            'version': 1,
            'source': 'exact_owned_current_document',
            'providerAttempts': 1,
            'recovery': 'get_only',
            'output': 'unconfirmed_source_maps',
            'uncertainProviderEffect': 'hold',
            'maximumChunks': 2048,
            'maximumCharacters': 1000000,
          }),
        };
  return {...body, 'reviewSha256': await memorySha(body)};
}

Future<Json> _review(String kind) async => _seal(
  {
    'contract': kind == 'build'
        ? cognitionBuildReadContract
        : deterministicContract(kind),
    'scope': privateActionScope(reviewOwner),
    if (kind == 'build') 'documentId': 'document:one',
    'review': {
      'eligible': true,
      'reason': null,
      'pin': await _pin(kind),
      if (kind == 'maintenance') 'excludedMemoryCount': 3,
      if (kind == 'build') ...{
        'documentId': 'document:one',
        'title': 'Reviewed private document',
        'model': {'provider': 'configured', 'model': 'fixture-model'},
      },
    },
  },
  kind,
  kind == 'build' ? 'build.review' : 'review',
);

Future<Json> _result(
  MemorySubmission sent,
  String kind, {
  bool absent = false,
  bool mutation = false,
}) async {
  final key = await privateActionKey(sent),
      scope = privateActionScope(reviewOwner),
      pin = sent.body['review'] as Map;
  final build = kind == 'build';
  final receipt = {
    'contract': build
        ? 'asael-knowledge-cognition-build-acceptance:1'
        : kind == 'maintenance'
        ? 'asael-memory-maintenance-acceptance:1'
        : 'asael-memory-graph-rebuild-acceptance:1',
    'id':
        '${build ? 'cognition-build-acceptance' : 'private-action-acceptance'}:${await memorySha({'scope': scope, 'keySha256': key})}',
    'scope': scope,
    'keySha256': key,
    'requestSha256': await memorySha(
      build
          ? await cognitionBuildIntent(sent)
          : await deterministicIntent(sent, kind),
    ),
    'reviewSha256': pin['reviewSha256'],
    'acceptedAt': reviewAt,
    if (build) ...{
      'documentId': sent.id,
      'sourcePlanSha256': pin['sourcePlanSha256'],
      'operationJobId': 'job:one',
      'totalBatches': 1,
      'reusedBatches': 0,
    } else ...{
      'operation': deterministicOperation(kind),
      'resourceId': sent.id,
      'result': kind == 'maintenance'
          ? {
              'policyVersion': 1,
              'scanned': 1,
              'eligible': 1,
              'exactDuplicateGroups': 0,
              'autoArchivedDuplicates': 0,
              'pinnedDuplicateConflicts': 0,
              'promotionReviewsCreated': 0,
              'expiredArchived': 0,
              'duplicateRateBefore': 0,
              'duplicateRateAfter': 0,
              'duplicateRateTarget': 0.01,
            }
          : {'memoryCount': 1, 'traceCount': 0, 'nodeCount': 1, 'edgeCount': 0},
    },
  };
  return _seal(
    {
      'contract': build
          ? cognitionBuildReadContract
          : deterministicContract(kind),
      'scope': scope,
      if (build) 'documentId': sent.id,
      'acceptance': absent
          ? null
          : {...receipt, 'acceptanceSha256': await memorySha(receipt)},
      if (build)
        'processing': absent
            ? null
            : {
                'phase': 'reconciliation_required',
                'totalBatches': 1,
                'completedBatches': 0,
                'reusedBatches': 0,
                'reviewIds': [],
                'reason': 'provider_effect_unconfirmed',
                'automaticRetryAllowed': false,
              },
      if (mutation) 'replayed': false,
    },
    kind,
    build
        ? mutation
              ? 'build'
              : 'build.get'
        : mutation
        ? 'run'
        : 'get',
    sent: mutation ? sent : null,
  );
}

class _OperationsRepository extends ReviewRepository
    implements KnowledgeMaintenanceRepository, KnowledgeBuildRepository {
  MemorySubmission? saved;
  int posts = 0, acceptanceReads = 0;
  bool absent = true;
  @override
  bool supportsMaintenance(String kind) => true;
  @override
  bool get supportsBuilds => true;
  @override
  Future<KnowledgeMaintenanceReview> reviewMaintenance(String kind) async =>
      KnowledgeMaintenanceReview.parse(await _review(kind), reviewOwner, kind);
  @override
  Future<KnowledgeBuildReview> reviewBuild(String documentId) async =>
      KnowledgeBuildReview.parse(
        await _review('build'),
        reviewOwner,
        documentId,
      );
  @override
  Future<KnowledgeMaintenanceRead> readMaintenance(
    String kind,
    String keySha256,
  ) async {
    acceptanceReads++;
    return KnowledgeMaintenanceRead.parse(
      await _result(saved!, kind, absent: absent),
      reviewOwner,
      kind,
      keyHash: keySha256,
    );
  }

  @override
  Future<KnowledgeBuildRead> readBuild(
    String documentId,
    String keySha256,
  ) async {
    acceptanceReads++;
    return KnowledgeBuildRead.parse(
      await _result(saved!, 'build', absent: absent),
      reviewOwner,
      documentId,
      keyHash: keySha256,
    );
  }

  @override
  Future<MemoryAcceptance> submit(
    MemorySubmission sent,
    bool Function() current,
  ) async {
    await beforeSubmit?.call(sent);
    memoryRequire(current());
    posts++;
    saved = sent;
    throw StateError('Accepted response lost');
  }
}

void main() {
  for (final kind in ['maintenance', 'graph', 'build']) {
    test(
      '$kind saves exact intent before one POST and restores GET-only uncertainty',
      () async {
        final repository = _OperationsRepository(),
            store = MemoryKnowledgeRecoveryStore();
        KnowledgeController make() => KnowledgeController(
          repository,
          canManage: true,
          mutationsAvailable: false,
          recoveryStore: store,
        );
        var controller = make();
        await controller.reloadRecovery();
        repository.beforeSubmit = (sent) async {
          expect((await store.read(reviewOwner))!['submission'], sent.recovery);
        };
        if (kind == 'build') {
          await controller.buildReviewedDocument(
            await controller.inspectBuild('document:one'),
            isReviewCurrent: () => true,
          );
        } else {
          await controller.runReviewedMaintenance(
            await controller.inspectMaintenance(kind),
            isReviewCurrent: () => true,
          );
        }
        final held = controller.pendingChange!;
        expect(repository.posts, 1);
        expect(held.replayable, isFalse);
        controller.dispose();
        controller = make();
        await controller.reloadRecovery();
        expect(controller.pendingChange!.key, held.key);
        await controller.recoverPrivateOperation(held.kind);
        expect(controller.pendingChange!.key, held.key);
        expect(repository.posts, 1);
        repository.absent = false;
        await controller.recoverPrivateOperation(held.kind);
        expect(controller.pendingChange, isNull);
        expect(controller.acceptedChange!.submission.key, held.key);
        expect(repository.posts, 1);
        expect(repository.acceptanceReads, 2);
        final receipt = controller.acceptedChange!;
        final altered = MemorySubmission(
          kind: held.kind,
          owner: held.owner,
          body: held.body,
          id: held.id,
          key: 'different-key',
        );
        await expectLater(
          MemoryAcceptance.parse(
            receipt.raw,
            altered,
            reviewReadOwner: reviewOwner,
          ),
          throwsFormatException,
        );
        if (kind == 'build') {
          expect(
            (receipt.raw['processing'] as Map)['phase'],
            'reconciliation_required',
          );
          expect(
            (await controller.inspectBuildProcessing(receipt))
                .processing!['automaticRetryAllowed'],
            false,
          );
          expect(repository.posts, 1);
        }
        controller.dispose();
      },
    );
  }
}
