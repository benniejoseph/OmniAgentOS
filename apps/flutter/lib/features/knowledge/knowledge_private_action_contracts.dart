import 'knowledge_contracts.dart';
import 'knowledge_mutations.dart';

const sourceMapReadContract = 'asael-knowledge-cognition-read:1';
const sourceMapDecisionContract = 'asael-knowledge-cognition-decision:1';
const sourceMapStatuses = ['pending_review', 'confirmed', 'dismissed'];

KnowledgeJson privateActionObject(Object? value, String fields) {
  final row = knowledgeMap(value, 'Private Memory action'),
      keys = fields.split(' ');
  memoryRequire(row.length == keys.length && keys.every(row.containsKey));
  return row;
}

String privateActionText(Object? value, int maximum, {bool empty = false}) {
  memoryRequire(
    value is String && value.length <= maximum && (empty || value.isNotEmpty),
  );
  return value as String;
}

String privateActionId(Object? value) {
  final text = privateActionText(value, 320);
  memoryRequire(RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$').hasMatch(text));
  return text;
}

String sourceMapId(Object? value) {
  final id = privateActionId(value);
  memoryRequire(RegExp(r'^cognition_batch_[a-f0-9]{48}$').hasMatch(id));
  return id;
}

String privateActionInstant(Object? value) {
  final text = privateActionText(value, 80);
  memoryRequire(
    RegExp(
          r'^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$',
        ).hasMatch(text) &&
        DateTime.tryParse(text) != null,
  );
  final year = int.parse(text.substring(0, 4)),
      month = int.parse(text.substring(5, 7)),
      day = int.parse(text.substring(8, 10));
  final days = [
    31,
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  memoryRequire(
    month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1],
  );
  return text;
}

int privateActionCount(Object? value, int maximum, {int minimum = 0}) {
  memoryRequire(value is int && value >= minimum && value <= maximum);
  return value as int;
}

bool privateActionSame(Object? a, Object? b) =>
    memoryCanonical(a) == memoryCanonical(b);
KnowledgeJson privateActionScope(KnowledgeOwner owner) {
  memoryRequire(
    RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:-]*$').hasMatch(owner.tenantId) &&
        owner.tenantId.length <= 120 &&
        owner.actorId.isNotEmpty &&
        owner.actorId == owner.actorId.trim() &&
        owner.actorId.length <= 320 &&
        RegExp(
          r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
        ).hasMatch(owner.userId),
  );
  return {
    'tenantId': owner.tenantId,
    'ownerActorId': owner.actorId,
    'canonicalActorId': owner.canonicalActorId,
  };
}

Future<String> privateActionKey(MemorySubmission sent) =>
    memoryShaText('${sent.owner.tenantId}\u0000${sent.key}');
Future<KnowledgeJson> privateActionIntent(MemorySubmission sent) async => {
  'contract': 'asael-private-memory-action-intent:1',
  'operation': sent.kind == MemoryChange.sourceDelete
      ? 'knowledge.source.delete'
      : 'knowledge.cognition.decide',
  'scope': privateActionScope(sent.owner),
  'resourceId': sent.id,
  'keySha256': await privateActionKey(sent),
  'request': sent.body,
};

KnowledgeJson _sourceMapPin(Object? value) {
  final pin = privateActionObject(
    value,
    'candidateId candidateSha256 documentId sourceItemId sourceRevisionId sourcePolicySha256 retentionExpiresAt reviewStateSha256 policySha256 reviewSha256',
  );
  sourceMapId(pin['candidateId']);
  for (final field in ['documentId', 'sourceItemId', 'sourceRevisionId']) {
    privateActionId(pin[field]);
  }
  for (final field in [
    'candidateSha256',
    'sourcePolicySha256',
    'reviewStateSha256',
    'policySha256',
    'reviewSha256',
  ]) {
    memoryHash(pin[field]);
  }
  if (pin['retentionExpiresAt'] != null) {
    privateActionInstant(pin['retentionExpiresAt']);
  }
  return pin;
}

Future<void> _verifySourceMapPin(Object? value) async {
  final pin = _sourceMapPin(value), body = {...pin}..remove('reviewSha256');
  memoryRequire(
    pin['reviewSha256'] == await memorySha(body) &&
        pin['policySha256'] ==
            await memorySha({
              'version': 1,
              'operation': 'knowledge.cognition.decide',
              'scope': 'current-owner-private',
              'review': 'exact-source-policy-and-candidate',
              'formation': 'reviewed_source_cognition',
              'projections': 'new-commit-only',
            }),
  );
}

void validateSourceMapRequest(KnowledgeJson value, String? id) {
  privateActionObject(value, 'contract decision review');
  memoryRequire(
    value['contract'] == sourceMapDecisionContract &&
        const ['confirm', 'dismiss'].contains(value['decision']),
  );
  final pin = _sourceMapPin(value['review']);
  memoryRequire(sourceMapId(id) == pin['candidateId']);
}

class KnowledgeSourceMap {
  const KnowledgeSourceMap(this.raw);
  final KnowledgeJson raw;
  String get id => raw['id'] as String;
  String get title => raw['sourceTitle'] as String;
  String get status => raw['status'] as String;
  String get summary => (raw['summary'] as Map)['text'] as String;
  List<String> get allowed =>
      List<String>.from(raw['allowedDecisions'] as List);
  KnowledgeJson? get pin => raw['review'] == null
      ? null
      : knowledgeMap(raw['review'], 'Exact source map');
  KnowledgeJson decisionBody(String decision) => {
    'contract': sourceMapDecisionContract,
    'decision': decision,
    'review': pin,
  };
  static Future<KnowledgeSourceMap> parse(Object? value) async {
    final row = privateActionObject(
      value,
      'id documentId sourceTitle status decision createdAt updatedAt reviewedAt batchIndex batchCount summary topics claims entities relations allowedDecisions review projection',
    );
    final id = sourceMapId(row['id']),
        document = privateActionId(row['documentId']);
    privateActionText(row['sourceTitle'], 500);
    memoryRequire(sourceMapStatuses.contains(row['status']));
    privateActionInstant(row['createdAt']);
    privateActionInstant(row['updatedAt']);
    memoryRequire(
      privateActionCount(row['batchIndex'], 9999) <
          privateActionCount(row['batchCount'], 10000, minimum: 1),
    );
    final summary = privateActionObject(
      row['summary'],
      'text confidenceBasisPoints evidence',
    );
    privateActionText(summary['text'], 4000);
    privateActionCount(summary['confidenceBasisPoints'], 10000);
    void texts(
      Object? value,
      int maximum,
      String field,
      int length, {
      int minimum = 0,
    }) {
      memoryRequire(
        value is List && value.length >= minimum && value.length <= maximum,
      );
      for (final item in value as List) {
        privateActionText(privateActionObject(item, field)[field], length);
      }
    }

    texts(summary['evidence'], 8, 'quote', 1200, minimum: 1);
    texts(row['topics'], 24, 'label', 160);
    texts(row['claims'], 48, 'statement', 1200);
    texts(row['entities'], 48, 'canonicalLabel', 320);
    texts(row['relations'], 64, 'statement', 1200);
    final allowed = row['allowedDecisions'];
    memoryRequire(
      allowed is List &&
          allowed.length <= 2 &&
          allowed.toSet().length == allowed.length &&
          allowed.every(const ['confirm', 'dismiss'].contains),
    );
    memoryRequire((row['review'] != null) == (allowed as List).isNotEmpty);
    if (row['review'] != null) {
      final pin = _sourceMapPin(row['review']);
      await _verifySourceMapPin(pin);
      memoryRequire(pin['candidateId'] == id && pin['documentId'] == document);
    }
    if (row['status'] == 'pending_review') {
      memoryRequire(row['decision'] == null && row['reviewedAt'] == null);
    } else {
      memoryRequire(
        allowed.isEmpty &&
            row['decision'] ==
                (row['status'] == 'confirmed' ? 'confirm' : 'dismiss'),
      );
      privateActionInstant(row['reviewedAt']);
    }
    memoryRequire(
      const [
        'not_requested',
        'unconfirmed',
        'completed',
      ].contains(row['projection']),
    );
    return KnowledgeSourceMap(freezeKnowledgeJson(row) as KnowledgeJson);
  }
}

Future<void> privateActionReceipt(
  KnowledgeJson value,
  KnowledgeOwner owner, {
  required String contract,
  required String service,
  required String resourceType,
  required int count,
  MemorySubmission? sent,
  String? purpose,
  String? eventContract,
}) async {
  memoryRequire(
    value['contract'] == contract &&
        privateActionSame(value['scope'], privateActionScope(owner)),
  );
  final proof = privateActionObject(
    value['serviceReceipt'],
    'schemaVersion receiptKind boundaryVersion operation action resourceType accessMode eventContract authoritySha256 idempotencyKeySha256 outcomeSha256 resourceCount occurredAt receiptSha256',
  );
  final mutation = sent != null;
  memoryRequire(
    proof['schemaVersion'] == 1 &&
        proof['receiptKind'] == 'app_service_receipt' &&
        proof['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
        proof['operation'] == service &&
        proof['resourceType'] == resourceType &&
        proof['resourceCount'] == count &&
        proof['action'] == (mutation ? 'write.memory' : 'read') &&
        proof['accessMode'] == (mutation ? 'mutation' : 'read') &&
        proof['eventContract'] ==
            (mutation ? eventContract : 'read_only:no_domain_mutation') &&
        proof['idempotencyKeySha256'] ==
            (mutation ? await privateActionKey(sent) : null),
  );
  privateActionInstant(proof['occurredAt']);
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
          'purpose': purpose,
        }
      : null;
  memoryRequire(
    proof['authoritySha256'] ==
        await memorySha({
          'boundaryVersion': 'p9.1-app-service-boundary:1',
          'tenantId': owner.tenantId,
          'actorId': owner.actorId,
          'role': owner.role,
          'executionScope': execution,
        }),
  );
  memoryRequire(
    proof['outcomeSha256'] ==
            await memorySha({...value}..remove('serviceReceipt')) &&
        proof['receiptSha256'] ==
            await memorySha({...proof}..remove('receiptSha256')),
  );
}

Future<List<KnowledgeSourceMap>> parseSourceMaps(
  Object? value,
  KnowledgeOwner owner, {
  required String status,
  required int limit,
}) async {
  final row = privateActionObject(
        value,
        'contract scope reviews serviceReceipt',
      ),
      values = row['reviews'];
  memoryRequire(
    sourceMapStatuses.contains(status) &&
        limit >= 1 &&
        limit <= 50 &&
        values is List &&
        values.length <= limit,
  );
  final result = <KnowledgeSourceMap>[];
  for (final value in values as List) {
    final record = await KnowledgeSourceMap.parse(value);
    memoryRequire(
      record.status == status &&
          !result.any((previous) => previous.id == record.id),
    );
    result.add(record);
  }
  await privateActionReceipt(
    row,
    owner,
    contract: sourceMapReadContract,
    service: 'app.knowledge.cognification.native.list',
    resourceType: 'knowledge_cognition',
    count: result.length,
  );
  return List.unmodifiable(result);
}

class KnowledgeSourceMapRead {
  const KnowledgeSourceMapRead(this.raw, this.review, this.acceptance);
  final KnowledgeJson raw;
  final KnowledgeSourceMap review;
  final KnowledgeJson? acceptance;
  static Future<KnowledgeSourceMapRead> parse(
    Object? value,
    KnowledgeOwner owner,
    String id, {
    String? keyHash,
    MemorySubmission? sent,
    bool mutation = false,
  }) async {
    final exact = keyHash != null || mutation;
    final row = privateActionObject(
      value,
      'contract scope review serviceReceipt${exact ? ' acceptance' : ''}${mutation ? ' replayed' : ''}',
    );
    final review = await KnowledgeSourceMap.parse(row['review']);
    memoryRequire(review.id == sourceMapId(id));
    if (mutation) {
      memoryRequire(
        sent != null && row['replayed'] is bool && row['acceptance'] != null,
      );
    }
    final accepted = row['acceptance'] == null
        ? null
        : privateActionObject(
            row['acceptance'],
            'contract id operation scope resourceId keySha256 requestSha256 reviewSha256 acceptedAt result acceptanceSha256',
          );
    if (accepted != null) {
      final scope = privateActionScope(owner),
          key = memoryHash(accepted['keySha256']);
      final result = privateActionObject(
        accepted['result'],
        'decision status memoryId memoryTargetRevision',
      );
      final confirm = result['decision'] == 'confirm';
      memoryRequire(
        accepted['contract'] == 'asael-knowledge-cognition-acceptance:1' &&
            accepted['operation'] == 'knowledge.cognition.decide' &&
            privateActionSame(accepted['scope'], scope) &&
            accepted['resourceId'] == id &&
            (keyHash == null || key == keyHash),
      );
      memoryRequire(
        accepted['id'] ==
                'private-action-acceptance:${await memorySha({'scope': scope, 'keySha256': key})}' &&
            accepted['acceptanceSha256'] ==
                await memorySha({...accepted}..remove('acceptanceSha256')),
      );
      memoryHash(accepted['requestSha256']);
      memoryHash(accepted['reviewSha256']);
      privateActionInstant(accepted['acceptedAt']);
      memoryRequire(
        const ['confirm', 'dismiss'].contains(result['decision']) &&
            result['status'] == (confirm ? 'confirmed' : 'dismissed') &&
            result['memoryId'] == (confirm ? 'memory:$id' : null) &&
            result['memoryTargetRevision'] == (confirm ? 1 : null),
      );
      memoryRequire(
        result['decision'] == review.raw['decision'] &&
            result['status'] == review.status &&
            accepted['acceptedAt'] == review.raw['reviewedAt'],
      );
      if (sent != null) {
        validateSourceMapRequest(sent.body, sent.id);
        await _verifySourceMapPin(sent.body['review']);
        memoryRequire(
          sent.kind == MemoryChange.sourceMap &&
              privateActionSame(privateActionScope(sent.owner), scope) &&
              key == await privateActionKey(sent) &&
              accepted['requestSha256'] ==
                  await memorySha(await privateActionIntent(sent)) &&
              accepted['reviewSha256'] ==
                  (sent.body['review'] as Map)['reviewSha256'] &&
              result['decision'] == sent.body['decision'],
        );
      }
    }
    await privateActionReceipt(
      row,
      owner,
      contract: sourceMapReadContract,
      service:
          'app.knowledge.cognification.native.${mutation
              ? 'decide'
              : exact
              ? 'decision.get'
              : 'read'}',
      resourceType: 'knowledge_cognition',
      count: 1,
      sent: mutation ? sent : null,
      purpose: 'api.knowledge.cognification.decide',
      eventContract: 'knowledge-cognification-native-events.v1',
    );
    return KnowledgeSourceMapRead(
      freezeKnowledgeJson(row) as KnowledgeJson,
      review,
      accepted == null ? null : freezeKnowledgeJson(accepted) as KnowledgeJson,
    );
  }
}

abstract interface class KnowledgePrivateActionRepository {
  bool get supportsSourceMaps;
  Future<List<KnowledgeSourceMap>> listSourceMaps({
    String status = 'pending_review',
    int limit = 25,
  });
  Future<KnowledgeSourceMapRead> readSourceMap(String id, {String? keySha256});
  bool get supportsSourceDeletion;
  Future<KnowledgeSourceDeletionReview> reviewSourceDeletion(String kind);
  Future<KnowledgeSourceDeletionRead> readSourceDeletion(
    String kind,
    String keySha256,
  );
}

const sourceDeletionReadContract = 'asael-knowledge-source-deletion-read:1';
const sourceKindPrefixes = {
  'google': 'google:',
  'mail': 'google:mail:',
  'calendar': 'google:calendar:',
  'drive': 'google:drive:',
};
String privateSourceKind(Object? value) {
  memoryRequire(value is String && sourceKindPrefixes.containsKey(value));
  return value as String;
}

Future<String> sourceDeletionTarget(String kind) async =>
    'knowledge_source_${await memorySha(sourceKindPrefixes[privateSourceKind(kind)])}';
KnowledgeJson _sourceDeletionPin(Object? value) {
  final pin = privateActionObject(
    value,
    'sourceKind documentCount derivedMemoryCount retrievalTraceCount graphNodeCount graphEdgeCount manifestSha256 policySha256 reviewSha256',
  );
  privateSourceKind(pin['sourceKind']);
  privateActionCount(pin['documentCount'], 500);
  privateActionCount(pin['derivedMemoryCount'], 2000);
  for (final field in [
    'retrievalTraceCount',
    'graphNodeCount',
    'graphEdgeCount',
  ]) {
    privateActionCount(pin[field], 5000);
  }
  for (final field in ['manifestSha256', 'policySha256', 'reviewSha256']) {
    memoryHash(pin[field]);
  }
  return pin;
}

Future<void> _verifySourceDeletionPin(Object? value) async {
  final pin = _sourceDeletionPin(value);
  memoryRequire(
    pin['reviewSha256'] == await memorySha({...pin}..remove('reviewSha256')) &&
        pin['policySha256'] ==
            await memorySha({
              'version': 1,
              'scope': 'owned-private-connected-source',
              'maximumDocuments': 500,
              'maximumMemories': 2000,
              'maximumGraphItemsPerKind': 5000,
              'localOnly': true,
              'exactReviewedLineage': true,
            }),
  );
}

void validateSourceDeletionRequest(KnowledgeJson body, String? id) {
  privateActionObject(body, 'contract review');
  memoryRequire(
    body['contract'] == 'asael-knowledge-source-delete:1' &&
        id != null &&
        RegExp(r'^knowledge_source_[a-f0-9]{64}$').hasMatch(id),
  );
  _sourceDeletionPin(body['review']);
}

class KnowledgeSourceDeletionReview {
  const KnowledgeSourceDeletionReview(this.raw, this.review);
  final KnowledgeJson raw, review;
  String get kind => review['sourceKind'] as String;
  bool get eligible => review['eligible'] == true;
  KnowledgeJson? get pin => review['pin'] == null
      ? null
      : knowledgeMap(review['pin'], 'Reviewed local sources');
  KnowledgeJson get decisionBody => {
    'contract': 'asael-knowledge-source-delete:1',
    'review': pin,
  };
  static Future<KnowledgeSourceDeletionReview> parse(
    Object? value,
    KnowledgeOwner owner,
    String kind,
  ) async {
    privateSourceKind(kind);
    final row = privateActionObject(
      value,
      'contract scope sourceKind review serviceReceipt',
    );
    final review = privateActionObject(
      row['review'],
      'sourceKind localOnly futureImportsMayReappear eligible reason pin documents',
    );
    memoryRequire(
      row['sourceKind'] == kind &&
          review['sourceKind'] == kind &&
          review['localOnly'] == true &&
          review['futureImportsMayReappear'] == true &&
          review['eligible'] is bool &&
          (review['reason'] == null ||
              const [
                'scope_too_large',
                'unsupported_memory_lineage',
                'write_permission_required',
              ].contains(review['reason'])),
    );
    final docs = review['documents'];
    memoryRequire(docs is List && docs.length <= 500);
    final ids = <String>{};
    for (final item in docs as List) {
      final doc = privateActionObject(item, 'id title expired');
      memoryRequire(
        ids.add(privateActionText(doc['id'], 320)) && doc['expired'] is bool,
      );
      privateActionText(doc['title'], 500, empty: true);
    }
    memoryRequire(
      review['eligible'] == (review['reason'] == null && review['pin'] != null),
    );
    if (review['pin'] != null) {
      final pin = _sourceDeletionPin(review['pin']);
      await _verifySourceDeletionPin(pin);
      memoryRequire(
        pin['sourceKind'] == kind && pin['documentCount'] == docs.length,
      );
    }
    await privateActionReceipt(
      row,
      owner,
      contract: sourceDeletionReadContract,
      service: 'app.knowledge.sources.native.deletion.review',
      resourceType: 'knowledge',
      count: 1,
    );
    return KnowledgeSourceDeletionReview(
      freezeKnowledgeJson(row) as KnowledgeJson,
      freezeKnowledgeJson(review) as KnowledgeJson,
    );
  }
}

class KnowledgeSourceDeletionRead {
  const KnowledgeSourceDeletionRead(this.raw, this.acceptance);
  final KnowledgeJson raw;
  final KnowledgeJson? acceptance;
  static Future<KnowledgeSourceDeletionRead> parse(
    Object? value,
    KnowledgeOwner owner,
    String kind, {
    required String keyHash,
    MemorySubmission? sent,
    bool mutation = false,
  }) async {
    privateSourceKind(kind);
    memoryHash(keyHash);
    final row = privateActionObject(
      value,
      'contract scope sourceKind acceptance serviceReceipt${mutation ? ' replayed' : ''}',
    );
    memoryRequire(row['sourceKind'] == kind);
    if (mutation) {
      memoryRequire(
        sent != null && row['replayed'] is bool && row['acceptance'] != null,
      );
    }
    final acceptance = row['acceptance'] == null
        ? null
        : privateActionObject(
            row['acceptance'],
            'contract id operation scope resourceId keySha256 requestSha256 reviewSha256 acceptedAt result acceptanceSha256',
          );
    if (acceptance != null) {
      final scope = privateActionScope(owner),
          target = await sourceDeletionTarget(kind);
      final result = privateActionObject(
        acceptance['result'],
        'sourceKind localOnly manifestSha256 documents memories retrievalTraces graphNodes graphEdges',
      );
      memoryRequire(
        acceptance['contract'] ==
                'asael-knowledge-source-deletion-acceptance:1' &&
            acceptance['operation'] == 'knowledge.source.delete' &&
            privateActionSame(acceptance['scope'], scope) &&
            acceptance['resourceId'] == target &&
            acceptance['keySha256'] == keyHash &&
            result['sourceKind'] == kind &&
            result['localOnly'] == true,
      );
      memoryRequire(
        acceptance['id'] ==
                'private-action-acceptance:${await memorySha({'scope': scope, 'keySha256': keyHash})}' &&
            acceptance['acceptanceSha256'] ==
                await memorySha({...acceptance}..remove('acceptanceSha256')),
      );
      memoryHash(acceptance['requestSha256']);
      memoryHash(acceptance['reviewSha256']);
      memoryHash(result['manifestSha256']);
      privateActionInstant(acceptance['acceptedAt']);
      privateActionCount(result['documents'], 500);
      privateActionCount(result['memories'], 2000);
      for (final field in ['retrievalTraces', 'graphNodes', 'graphEdges']) {
        privateActionCount(result[field], 5000);
      }
      if (sent != null) {
        validateSourceDeletionRequest(sent.body, sent.id);
        final pin = _sourceDeletionPin(sent.body['review']);
        await _verifySourceDeletionPin(pin);
        memoryRequire(
          sent.kind == MemoryChange.sourceDelete &&
              sent.id == target &&
              privateActionSame(privateActionScope(sent.owner), scope) &&
              keyHash == await privateActionKey(sent) &&
              acceptance['requestSha256'] ==
                  await memorySha(await privateActionIntent(sent)) &&
              acceptance['reviewSha256'] == pin['reviewSha256'] &&
              result['manifestSha256'] == pin['manifestSha256'],
        );
        for (final pair in const {
          'documents': 'documentCount',
          'memories': 'derivedMemoryCount',
          'retrievalTraces': 'retrievalTraceCount',
          'graphNodes': 'graphNodeCount',
          'graphEdges': 'graphEdgeCount',
        }.entries) {
          memoryRequire(result[pair.key] == pin[pair.value]);
        }
      }
    }
    await privateActionReceipt(
      row,
      owner,
      contract: sourceDeletionReadContract,
      service:
          'app.knowledge.sources.native.${mutation ? 'delete' : 'deletion.get'}',
      resourceType: 'knowledge',
      count: acceptance == null ? 0 : 1,
      sent: mutation ? sent : null,
      purpose: 'api.knowledge.sources.delete',
      eventContract: 'knowledge-source-deletion-native-events.v1',
    );
    return KnowledgeSourceDeletionRead(
      freezeKnowledgeJson(row) as KnowledgeJson,
      acceptance == null
          ? null
          : freezeKnowledgeJson(acceptance) as KnowledgeJson,
    );
  }
}
