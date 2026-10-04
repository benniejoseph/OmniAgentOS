import 'knowledge_contracts.dart';
import 'knowledge_mutations.dart';
import 'knowledge_private_action_contracts.dart';

const cognitionBuildReadContract = 'asael-knowledge-cognition-build-read:1';
KnowledgeJson _buildPin(Object? value) {
  final pin = privateActionObject(
    value,
    'documentId sourceItemId sourceRevisionId sourcePolicySha256 retentionExpiresAt generationId sourcePlanSha256 batchCount existingReviewCount existingReviewManifestSha256 policySha256 reviewSha256',
  );
  for (final field in ['documentId', 'sourceItemId', 'sourceRevisionId']) {
    privateActionId(pin[field]);
  }
  memoryRequire(
    pin['generationId'] is String &&
        RegExp(r'^cognition_generation_[a-f0-9]{48}$')
            .hasMatch(pin['generationId'] as String),
  );
  for (final field in [
    'sourcePolicySha256',
    'sourcePlanSha256',
    'existingReviewManifestSha256',
    'policySha256',
    'reviewSha256',
  ]) {
    memoryHash(pin[field]);
  }
  if (pin['retentionExpiresAt'] != null) {
    privateActionInstant(pin['retentionExpiresAt']);
  }
  memoryRequire(
    privateActionCount(pin['existingReviewCount'], 2048) <=
        privateActionCount(pin['batchCount'], 2048, minimum: 1),
  );
  return pin;
}

Future<void> verifyBuildPin(Object? value) async {
  final pin = _buildPin(value);
  memoryRequire(
    pin['reviewSha256'] == await memorySha({...pin}..remove('reviewSha256')) &&
        pin['policySha256'] ==
            await memorySha({
              'version': 1,
              'source': 'exact_owned_current_document',
              'providerAttempts': 1,
              'recovery': 'get_only',
              'output': 'unconfirmed_source_maps',
              'uncertainProviderEffect': 'hold',
              'maximumChunks': 2048,
              'maximumCharacters': 1000000,
            }),
  );
}

void validateCognitionBuildRequest(KnowledgeJson body, String? id) {
  privateActionObject(body, 'contract review');
  memoryRequire(
    body['contract'] == 'asael-knowledge-cognition-build:1' &&
        _buildPin(body['review'])['documentId'] == privateActionId(id),
  );
}

Future<KnowledgeJson> cognitionBuildIntent(MemorySubmission sent) async => {
  'contract': 'asael-knowledge-cognition-build-intent:1',
  'scope': privateActionScope(sent.owner),
  'documentId': sent.id,
  'keySha256': await privateActionKey(sent),
  'request': sent.body,
};

class KnowledgeBuildReview {
  const KnowledgeBuildReview(this.raw, this.review);
  final KnowledgeJson raw, review;
  String get id => review['documentId'] as String;
  bool get eligible => review['eligible'] == true;
  KnowledgeJson get pin => knowledgeMap(review['pin'], 'Exact build plan');
  KnowledgeJson get decisionBody => {
    'contract': 'asael-knowledge-cognition-build:1',
    'review': pin,
  };
  static Future<KnowledgeBuildReview> parse(
    Object? value,
    KnowledgeOwner owner,
    String id,
  ) async {
    privateActionId(id);
    final row = privateActionObject(
          value,
          'contract scope documentId review serviceReceipt',
        ),
        review = privateActionObject(
          row['review'],
          'documentId title pin eligible reason model',
        );
    final model = privateActionObject(review['model'], 'provider model');
    if (model['provider'] != null) {
      privateActionText(model['provider'], 80);
    }
    if (model['model'] != null) {
      privateActionText(model['model'], 240);
    }
    privateActionText(review['title'], 500);
    memoryRequire(
      row['documentId'] == id &&
          review['documentId'] == id &&
          review['eligible'] is bool &&
          (review['reason'] == null ||
              const [
                'model_unavailable',
                'already_completed',
                'already_accepted',
                'legacy_work_unconfirmed',
                'write_permission_required',
              ].contains(review['reason'])) &&
          review['eligible'] == (review['reason'] == null),
    );
    await verifyBuildPin(review['pin']);
    memoryRequire((review['pin'] as Map)['documentId'] == id);
    await privateActionReceipt(
      row,
      owner,
      contract: cognitionBuildReadContract,
      service: 'app.knowledge.cognification.native.build.review',
      resourceType: 'knowledge_cognition',
      count: 1,
    );
    return KnowledgeBuildReview(
      freezeKnowledgeJson(row) as KnowledgeJson,
      freezeKnowledgeJson(review) as KnowledgeJson,
    );
  }
}

class KnowledgeBuildRead {
  const KnowledgeBuildRead(this.raw, this.acceptance, this.processing);
  final KnowledgeJson raw;
  final KnowledgeJson? acceptance, processing;
  static Future<KnowledgeBuildRead> parse(
    Object? value,
    KnowledgeOwner owner,
    String id, {
    required String keyHash,
    MemorySubmission? sent,
    bool mutation = false,
  }) async {
    privateActionId(id);
    memoryHash(keyHash);
    final row = privateActionObject(
      value,
      'contract scope documentId acceptance processing serviceReceipt${mutation ? ' replayed' : ''}',
    );
    memoryRequire(
      row['documentId'] == id &&
          (row['acceptance'] == null) == (row['processing'] == null),
    );
    if (mutation) {
      memoryRequire(
        sent != null && row['replayed'] is bool && row['acceptance'] != null,
      );
    }
    final accepted = row['acceptance'] == null
        ? null
        : privateActionObject(
            row['acceptance'],
            'contract id scope documentId keySha256 requestSha256 reviewSha256 sourcePlanSha256 operationJobId totalBatches reusedBatches acceptedAt acceptanceSha256',
          );
    KnowledgeJson? processing;
    if (accepted != null) {
      final scope = privateActionScope(owner);
      for (final field in [
        'keySha256',
        'requestSha256',
        'reviewSha256',
        'sourcePlanSha256',
        'acceptanceSha256',
      ]) {
        memoryHash(accepted[field]);
      }
      privateActionId(accepted['operationJobId']);
      privateActionInstant(accepted['acceptedAt']);
      memoryRequire(
        privateActionCount(accepted['reusedBatches'], 2048) <
            privateActionCount(accepted['totalBatches'], 2048, minimum: 1),
      );
      memoryRequire(
        accepted['contract'] ==
                'asael-knowledge-cognition-build-acceptance:1' &&
            privateActionSame(accepted['scope'], scope) &&
            accepted['documentId'] == id &&
            accepted['keySha256'] == keyHash &&
            accepted['id'] ==
                'cognition-build-acceptance:${await memorySha({'scope': scope, 'keySha256': keyHash})}' &&
            accepted['acceptanceSha256'] ==
                await memorySha({...accepted}..remove('acceptanceSha256')),
      );
      processing = privateActionObject(
        row['processing'],
        'phase totalBatches completedBatches reusedBatches reviewIds reason automaticRetryAllowed',
      );
      memoryRequire(
        const [
              'queued',
              'processing',
              'completed',
              'reconciliation_required',
              'blocked',
            ].contains(processing['phase']) &&
            (processing['reason'] == null ||
                const [
                  'source_changed',
                  'authority_changed',
                  'model_changed',
                  'provider_effect_unconfirmed',
                  'job_unavailable',
                ].contains(processing['reason'])) &&
            processing['automaticRetryAllowed'] == false,
      );
      final total = privateActionCount(
            processing['totalBatches'],
            2048,
            minimum: 1,
          ),
          completed = privateActionCount(processing['completedBatches'], 2048),
          reused = privateActionCount(processing['reusedBatches'], 2048);
      final reviews = processing['reviewIds'];
      memoryRequire(
        reviews is List &&
            reviews.length == completed &&
            reviews.toSet().length == reviews.length &&
            total == accepted['totalBatches'] &&
            completed <= total &&
            reused <= completed &&
            reused <= (accepted['reusedBatches'] as int) &&
            (processing['phase'] != 'completed' ||
                completed == total && processing['reason'] == null),
      );
      for (final review in reviews as List) {
        sourceMapId(review);
      }
      if (sent != null) {
        await verifyBuildPin(sent.body['review']);
        final pin = sent.body['review'] as Map;
        memoryRequire(
          sent.id == id &&
              keyHash == await privateActionKey(sent) &&
              accepted['requestSha256'] ==
                  await memorySha(await cognitionBuildIntent(sent)) &&
              accepted['reviewSha256'] == pin['reviewSha256'] &&
              accepted['sourcePlanSha256'] == pin['sourcePlanSha256'] &&
              accepted['totalBatches'] == pin['batchCount'] &&
              accepted['reusedBatches'] == pin['existingReviewCount'],
        );
      }
    }
    await privateActionReceipt(
      row,
      owner,
      contract: cognitionBuildReadContract,
      service:
          'app.knowledge.cognification.native.${mutation ? 'build' : 'build.get'}',
      resourceType: 'knowledge_cognition',
      count: accepted == null ? 0 : 1,
      sent: mutation ? sent : null,
      purpose: 'api.knowledge.cognification.build',
      eventContract: 'knowledge-cognification-build-native-events.v1',
    );
    return KnowledgeBuildRead(
      freezeKnowledgeJson(row) as KnowledgeJson,
      accepted == null ? null : freezeKnowledgeJson(accepted) as KnowledgeJson,
      processing == null
          ? null
          : freezeKnowledgeJson(processing) as KnowledgeJson,
    );
  }
}

abstract interface class KnowledgeBuildRepository {
  bool get supportsBuilds;
  Future<KnowledgeBuildReview> reviewBuild(String documentId);
  Future<KnowledgeBuildRead> readBuild(String documentId, String keySha256);
}
