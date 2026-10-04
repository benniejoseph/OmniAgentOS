import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_client.dart';
import '../auth/domain/app_session.dart';
import 'knowledge_contracts.dart';
import 'knowledge_consent_contracts.dart';
import 'knowledge_review_contracts.dart';

void memoryRequire(
  bool condition, [
  String message = 'The exact Memory response could not be verified.',
]) {
  if (!condition) throw FormatException(message);
}

String memoryHash(Object? value) {
  memoryRequire(value is String && RegExp(r'^[a-f0-9]{64}$').hasMatch(value));
  return value as String;
}

String memoryInstant(Object? value) {
  memoryRequire(value is String && DateTime.tryParse(value) != null);
  return value as String;
}

String memoryCanonical(Object? value) {
  if (value is Map) {
    final map = knowledgeMap(value, 'Memory JSON'),
        keys = map.keys.toList()..sort();
    return '{${keys.map((key) => '${jsonEncode(key)}:${memoryCanonical(map[key])}').join(',')}}';
  }
  if (value is List) return '[${value.map(memoryCanonical).join(',')}]';
  if (value is num) return _memoryNumber(value);
  return jsonEncode(value);
}

String _memoryNumber(num value) {
  memoryRequire(value.isFinite);
  if (value == 0) return '0';
  if (value is int) return value.toString();
  final sign = value < 0 ? '-' : '',
      text = value.abs().toString().toLowerCase(),
      parts = text.split('e');
  if (parts.length == 1) {
    return '$sign${text.endsWith('.0') ? text.substring(0, text.length - 2) : text}';
  }
  final exponent = int.parse(parts[1]),
      mantissa = parts[0].endsWith('.0')
          ? parts[0].substring(0, parts[0].length - 2)
          : parts[0];
  if (exponent < -6 || exponent >= 21) {
    return '$sign${mantissa}e${exponent >= 0 ? '+' : ''}$exponent';
  }
  final digits = mantissa.replaceAll('.', ''),
      point =
          (mantissa.contains('.') ? mantissa.indexOf('.') : mantissa.length) +
          exponent;
  if (point <= 0) return '${sign}0.${'0' * -point}$digits';
  if (point >= digits.length) {
    return '$sign$digits${'0' * (point - digits.length)}';
  }
  return '$sign${digits.substring(0, point)}.${digits.substring(point)}';
}

Future<String> memoryShaText(String value) async =>
    (await Sha256().hash(utf8.encode(value))).bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
Future<String> memorySha(Object? value) =>
    memoryShaText(memoryCanonical(value));

class KnowledgeOwner {
  const KnowledgeOwner(
    this.tenantId,
    this.actorId,
    this.userId,
    this.role,
    this.apiBaseUrl,
  );
  final String tenantId, actorId, userId, role, apiBaseUrl;
  String get key =>
      [tenantId, actorId, userId, role, apiBaseUrl].join('\u0000');
  String get canonicalActorId => 'actor:$userId';
  bool get canWrite => const {'operator', 'admin', 'system'}.contains(role);
  static KnowledgeOwner? fromSession(AppSession? session, String api) {
    if (session == null ||
        !RegExp(
          r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
        ).hasMatch(session.userId)) {
      return null;
    }
    return KnowledgeOwner(
      session.tenantId,
      session.actorId,
      session.userId,
      session.role,
      NativeRequestAuthority.normalizeApiBaseUrl(api),
    );
  }
}

/// This is a live observation of authority, never a persisted grant.
class KnowledgeAccess extends ChangeNotifier {
  KnowledgeOwner? owner;
  bool ready = false, closed = false;
  int generation = 0;
  final Set<VoidCallback> _silent = {};
  bool get readable => !closed && ready && owner != null;
  void addSilentListener(VoidCallback listener) => _silent.add(listener);
  void removeSilentListener(VoidCallback listener) => _silent.remove(listener);
  void update(KnowledgeOwner? next, bool available) {
    if (closed || owner?.key == next?.key && ready == available) return;
    owner = next;
    ready = available;
    generation++;
    notifyListeners();
  }

  void close({bool notify = true}) {
    if (closed) return;
    closed = true;
    ready = false;
    generation++;
    if (notify) {
      notifyListeners();
    } else {
      for (final callback in _silent.toList()) {
        callback();
      }
    }
  }

  @override
  void dispose() {
    _silent.clear();
    super.dispose();
  }
}

enum MemoryChange { create, correct, lifecycle, forget, review, consent }

extension MemoryChangeOperation on MemoryChange {
  String get operation => switch (this) {
    MemoryChange.create => 'memory.create',
    MemoryChange.correct => 'memory.update',
    MemoryChange.lifecycle => 'memory.lifecycle.change',
    MemoryChange.forget => 'memory.delete',
    MemoryChange.review => 'memory.reconciliation.resolve',
    MemoryChange.consent => 'memory.personal-context-consent.decide',
  };
  String get service => switch (this) {
    MemoryChange.create => 'memory.write',
    MemoryChange.correct => 'memory.correct',
    MemoryChange.lifecycle => 'memory.lifecycle',
    MemoryChange.forget => 'memory.forget',
    MemoryChange.review => 'memory.reconciliation.resolve',
    MemoryChange.consent => 'memory.personal-context-consent.decide',
  };
}

class MemorySubmission {
  MemorySubmission({
    required this.kind,
    required this.owner,
    required KnowledgeJson body,
    this.id,
    this.previewDigest,
    KnowledgeJson? reviewEvidence,
    KnowledgeJson? consentNotice,
    String? key,
  }) : body = freezeKnowledgeJson(body) as KnowledgeJson,
       reviewEvidence = reviewEvidence == null
           ? null
           : freezeKnowledgeJson(reviewEvidence) as KnowledgeJson,
       consentNotice = consentNotice == null
           ? null
           : freezeKnowledgeJson(consentNotice) as KnowledgeJson,
       key =
           key ??
           'native-memory-${List.generate(24, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}' {
    if (id != null) knowledgeIdentity(id, 'Exact memory', maximum: 200);
    memoryRequire(kind == MemoryChange.create || id != null);
    if (kind == MemoryChange.create || kind == MemoryChange.correct) {
      for (final field in ['title', 'content']) {
        final value = body[field];
        if (kind == MemoryChange.create || value != null) {
          memoryRequire(
            value is String &&
                value.isNotEmpty &&
                value.length <= (field == 'title' ? 240 : 200000),
          );
        }
      }
      final allowed = kind == MemoryChange.create
          ? {
              'title',
              'content',
              'type',
              'tier',
              'tags',
              'importance',
              'confidence',
              'evidenceRefs',
              'validFrom',
              'validTo',
            }
          : {'title', 'content', 'confidence', 'validTo', 'contradiction'};
      memoryRequire(body.isNotEmpty && body.keys.every(allowed.contains));
    }
    if (kind == MemoryChange.lifecycle) {
      memoryRequire(
        body.length == 3 &&
            body['contract'] == 'asael-memory-lifecycle-mutation:1' &&
            const {
              'pin',
              'unpin',
              'archive',
              'restore',
            }.contains(body['action']),
      );
      memoryHash(body['expectedTargetToken']);
    }
    if (kind == MemoryChange.forget) {
      memoryRequire(body.isEmpty);
      memoryHash(previewDigest);
    }
    if (kind == MemoryChange.review) {
      memoryRequire(
        body.length == 4 &&
            body['contract'] == memoryReviewDecisionContract &&
            memoryReviewId(body['reviewId']) == id &&
            memoryReviewDecisions.contains(body['decision']),
      );
      memoryHash(body['expectedReviewToken']);
      final evidence = this.reviewEvidence;
      memoryRequire(
        evidence != null &&
            evidence.length == 3 &&
            evidence.keys.every(
              const {'kind', 'candidateMemoryId', 'existingMemoryId'}.contains,
            ) &&
            const {'confirmation', 'contradiction'}.contains(evidence['kind']),
      );
      memoryReviewId(evidence!['candidateMemoryId']);
      if (evidence['existingMemoryId'] != null) {
        memoryReviewId(evidence['existingMemoryId']);
      }
      memoryRequire(
        (evidence['kind'] == 'contradiction') ==
                (evidence['existingMemoryId'] != null) &&
            evidence['candidateMemoryId'] != evidence['existingMemoryId'] &&
            (evidence['kind'] == 'contradiction' ||
                body['decision'] != 'keep_both'),
      );
    } else {
      memoryRequire(reviewEvidence == null);
    }
    if (kind == MemoryChange.consent) {
      validateMemoryConsentRequest(this.body, owner, id, this.consentNotice);
    } else {
      memoryRequire(consentNotice == null);
    }
  }
  final MemoryChange kind;
  final KnowledgeOwner owner;
  final KnowledgeJson body;
  final KnowledgeJson? reviewEvidence;
  final KnowledgeJson? consentNotice;
  final String? id, previewDigest;
  final String key;
  bool get replayable =>
      kind == MemoryChange.lifecycle || kind == MemoryChange.forget;
  KnowledgeJson get recovery => {
    'kind': kind.name,
    'body': body,
    'key': key,
    'id': id,
    'previewDigest': previewDigest,
    if (reviewEvidence != null) 'reviewEvidence': reviewEvidence,
    if (consentNotice != null) 'consentNotice': consentNotice,
    'owner': {
      'tenantId': owner.tenantId,
      'actorId': owner.actorId,
      'userId': owner.userId,
      'role': owner.role,
      'apiBaseUrl': owner.apiBaseUrl,
    },
  };
  static MemorySubmission restore(Object? value, KnowledgeOwner current) {
    final raw = knowledgeMap(value, 'Saved Memory submission'),
        saved = knowledgeMap(raw['owner'], 'Saved owner');
    memoryRequire(
      saved['tenantId'] == current.tenantId &&
          saved['userId'] == current.userId &&
          saved['apiBaseUrl'] == current.apiBaseUrl,
    );
    final owner = KnowledgeOwner(
      current.tenantId,
      knowledgeIdentity(saved['actorId'], 'Saved actor'),
      current.userId,
      knowledgeIdentity(saved['role'], 'Saved role'),
      current.apiBaseUrl,
    );
    final key = knowledgeIdentity(
      raw['key'],
      'Saved request key',
      maximum: 512,
    );
    memoryRequire(
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    final kinds = MemoryChange.values.where((kind) => kind.name == raw['kind']);
    memoryRequire(kinds.length == 1);
    return MemorySubmission(
      kind: kinds.single,
      owner: owner,
      body: knowledgeMap(raw['body'], 'Saved request body'),
      key: key,
      id: raw['id'] as String?,
      previewDigest: raw['previewDigest'] as String?,
      reviewEvidence: raw['reviewEvidence'] == null
          ? null
          : knowledgeMap(raw['reviewEvidence'], 'Saved review targets'),
      consentNotice: raw['consentNotice'] == null
          ? null
          : knowledgeMap(raw['consentNotice'], 'Saved personal recall notice'),
    );
  }
}

abstract interface class KnowledgeMutationRepository {
  KnowledgeAccess get access;
  bool authorityCurrent();
  bool supports(MemoryChange kind);
  Future<KnowledgeJson> readLifecycle(String id);
  Future<MemoryAcceptance> submit(
    MemorySubmission submission,
    bool Function() current,
  );
}

KnowledgeJson parseMemoryLifecycle(
  Object? value,
  KnowledgeOwner owner,
  String id,
) {
  final read = knowledgeMap(value, 'Lifecycle review'),
      target = knowledgeMap(read['target'], 'Lifecycle target');
  memoryRequire(
    read['contract'] == 'asael-memory-lifecycle-read:1' &&
        target['tenantId'] == owner.tenantId &&
        target['ownerActorId'] == owner.canonicalActorId &&
        target['memoryId'] == id &&
        target['visibility'] == 'user_private',
  );
  memoryHash(target['token']);
  memoryRequire(
    knowledgeCount(target['targetRevision'], 'Target revision') > 0,
  );
  knowledgeCount(target['lifecycleRevision'], 'Lifecycle revision');
  _lifecycle(read['lifecycle']);
  return freezeKnowledgeJson(read) as KnowledgeJson;
}

Future<KnowledgeJson> parseMemoryLifecycleResponse(
  KnowledgeJson raw,
  KnowledgeOwner owner,
  String id,
) async {
  final current = parseMemoryLifecycle(raw['current'], owner, id),
      receipt = knowledgeMap(raw['serviceReceipt'], 'Lifecycle read receipt');
  memoryRequire(
    raw.length == 2 &&
        receipt['schemaVersion'] == 1 &&
        receipt['receiptKind'] == 'app_service_receipt' &&
        receipt['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
        receipt['operation'] == 'memory.inspect' &&
        receipt['action'] == 'read' &&
        receipt['accessMode'] == 'read' &&
        receipt['resourceType'] == 'memory' &&
        receipt['eventContract'] == 'read_only:no_domain_mutation' &&
        receipt['idempotencyKeySha256'] == null &&
        receipt['resourceCount'] == 1,
  );
  memoryHash(receipt['authoritySha256']);
  memoryInstant(receipt['occurredAt']);
  final body = {...receipt}..remove('receiptSha256');
  memoryRequire(
    receipt['receiptSha256'] == await memorySha(body) &&
        receipt['outcomeSha256'] == await memorySha({'current': current}),
  );
  return current;
}

void _lifecycle(Object? value) {
  final row = knowledgeMap(value, 'Lifecycle');
  memoryRequire(
    row['policyVersion'] == 1 &&
        row.length == 6 &&
        [
          'policyVersion',
          'pinnedAt',
          'archivedAt',
          'archiveReason',
          'duplicateOfMemoryId',
          'updatedAt',
        ].every(row.containsKey),
  );
  for (final field in ['pinnedAt', 'archivedAt', 'updatedAt']) {
    if (row[field] != null) memoryInstant(row[field]);
  }
  memoryRequire(
    !(row['pinnedAt'] != null && row['archivedAt'] != null) &&
        (row['archivedAt'] == null) == (row['archiveReason'] == null) &&
        (row['archiveReason'] == null ||
            const {
              'manual',
              'exact_duplicate',
              'retention_expired',
            }.contains(row['archiveReason'])) &&
        (row['archiveReason'] == 'exact_duplicate') ==
            (row['duplicateOfMemoryId'] != null),
  );
}

class MemoryAcceptance {
  const MemoryAcceptance(
    this.submission,
    this.raw,
    this.memoryId,
    this.description, {
    this.reviewReadOwner,
  });
  final MemorySubmission submission;
  final KnowledgeJson raw;
  final String memoryId, description;
  // Historical evidence for a GET receipt, never a current permission grant.
  final KnowledgeOwner? reviewReadOwner;
  KnowledgeJson get recoveryReceipt => {
    'receipt': raw,
    if (reviewReadOwner != null)
      'receiptReadScope': {
        'actorId': reviewReadOwner!.actorId,
        'role': reviewReadOwner!.role,
      },
  };
  static KnowledgeOwner? restoredReadOwner(
    KnowledgeJson envelope,
    MemorySubmission sent,
  ) {
    if (!envelope.containsKey('receiptReadScope')) {
      return null;
    }
    final scope = knowledgeMap(
      envelope['receiptReadScope'],
      'Saved review receipt scope',
    );
    memoryRequire(
      const {MemoryChange.review, MemoryChange.consent}.contains(sent.kind) &&
          scope.length == 2 &&
          scope.keys.every(const {'actorId', 'role'}.contains) &&
          scope['actorId'] is String &&
          (scope['actorId'] as String).isNotEmpty &&
          (scope['actorId'] as String).length <= 256 &&
          const {
            'viewer',
            'operator',
            'admin',
            'system',
          }.contains(scope['role']),
    );
    return KnowledgeOwner(
      sent.owner.tenantId,
      scope['actorId'] as String,
      sent.owner.userId,
      scope['role'] as String,
      sent.owner.apiBaseUrl,
    );
  }

  static Future<MemoryAcceptance> parse(
    KnowledgeJson raw,
    MemorySubmission sent, {
    KnowledgeOwner? reviewReadOwner,
  }) async {
    if (sent.kind == MemoryChange.consent) {
      final mutation = raw.containsKey('replayed');
      final owner = reviewReadOwner ?? sent.owner;
      memoryRequire(
        (!mutation || reviewReadOwner == null) &&
            owner.tenantId == sent.owner.tenantId &&
            owner.userId == sent.owner.userId &&
            owner.apiBaseUrl == sent.owner.apiBaseUrl,
      );
      final read = await MemoryConsentRead.parse(
        raw,
        owner,
        keyHash: await memoryShaText(sent.key),
        sent: sent,
        mutation: mutation,
      );
      memoryRequire(
        read.acceptance != null,
        'No matching receipt has confirmed this personal recall decision.',
      );
      return MemoryAcceptance(
        sent,
        read.raw,
        read.acceptance!['id'] as String,
        sent.body['action'] == 'activate'
            ? 'Your decision to enable personal automatic recall was recorded. Current consent is shown separately.'
            : 'Your decision to disable personal automatic recall was recorded. Current consent is shown separately.',
        reviewReadOwner: mutation ? null : owner,
      );
    }
    if (sent.kind == MemoryChange.review) {
      final mutation = raw.containsKey('projections');
      final owner = reviewReadOwner ?? sent.owner;
      memoryRequire(
        (!mutation || reviewReadOwner == null) &&
            owner.tenantId == sent.owner.tenantId &&
            owner.userId == sent.owner.userId &&
            owner.apiBaseUrl == sent.owner.apiBaseUrl,
      );
      final read = await MemoryReviewRead.parse(
        raw,
        owner,
        sent.id!,
        keyHash: await memoryShaText(sent.key),
        sent: sent,
        mutation: mutation,
      );
      memoryRequire(
        read.acceptance != null,
        'No matching native acceptance has confirmed this review decision.',
      );
      return MemoryAcceptance(
        sent,
        read.raw,
        read.review.candidate.id,
        'Review decision recorded: ${sent.body['decision']}. Downstream projection status is separate from this saved decision.',
        reviewReadOwner: mutation ? null : owner,
      );
    }
    final service = knowledgeMap(raw['serviceReceipt'], 'Application receipt');
    memoryRequire(
      service['schemaVersion'] == 1 &&
          service['receiptKind'] == 'app_service_receipt' &&
          service['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
          service['operation'] == sent.kind.service &&
          service['action'] == 'write.memory' &&
          service['resourceType'] == 'memory' &&
          service['accessMode'] == 'mutation' &&
          service['eventContract'] == 'memory.atomic-events.v1',
    );
    memoryHash(service['authoritySha256']);
    memoryInstant(service['occurredAt']);
    knowledgeCount(service['resourceCount'], 'Receipt resource count');
    memoryRequire(
      service['idempotencyKeySha256'] ==
          await memoryShaText('${sent.owner.tenantId}\u0000${sent.key}'),
    );
    final serviceBody = {...service}..remove('receiptSha256');
    memoryRequire(service['receiptSha256'] == await memorySha(serviceBody));
    final response = {...raw}..remove('serviceReceipt');
    Object? outcome = response;
    String memoryId = sent.id ?? '', description;
    if (sent.kind == MemoryChange.create) {
      final record = _record(raw['record'], sent.owner);
      memoryId = record['id'] as String;
      // Server redaction may change text; the accepted record is shown separately.
      description =
          'Memory recorded. The returned record may contain server redactions.';
    } else if (sent.kind == MemoryChange.correct) {
      final previous = _record(raw['previous'], sent.owner),
          corrected = _record(raw['corrected'], sent.owner),
          receipt = knowledgeMap(raw['operationReceipt'], 'Correction receipt');
      memoryId = corrected['id'] as String;
      final candidate = sent.body['contradiction'] == true;
      memoryRequire(
        previous['id'] == sent.id &&
            memoryId != sent.id &&
            receipt['previousMemoryId'] == sent.id &&
            receipt['correctedMemoryId'] == memoryId &&
            receipt['operation'] ==
                (candidate ? 'propose_contradiction' : 'correct') &&
            corrected[candidate ? 'contradictionOfId' : 'supersedesId'] ==
                sent.id &&
            (!candidate ||
                corrected['claimStatus'] == 'candidate' &&
                    receipt['reviewRequired'] == true),
      );
      outcome = {
        'correction': {
          'previous': previous,
          'corrected': corrected,
          if (raw.containsKey('review')) 'review': raw['review'],
        },
        'operationReceipt': receipt,
      };
      description = candidate
          ? 'Candidate recorded for review. It is not accepted memory.'
          : 'Correction recorded as a separate memory. Earlier history is preserved.';
    } else if (sent.kind == MemoryChange.lifecycle) {
      final acceptance = knowledgeMap(
        raw['acceptance'],
        'Lifecycle acceptance',
      );
      memoryRequire(
        acceptance['contract'] == 'asael-memory-lifecycle-acceptance:1' &&
            acceptance['tenantId'] == sent.owner.tenantId &&
            acceptance['ownerActorId'] == sent.owner.canonicalActorId &&
            acceptance['memoryId'] == sent.id &&
            acceptance['action'] == sent.body['action'] &&
            acceptance['expectedTargetToken'] ==
                sent.body['expectedTargetToken'] &&
            acceptance['idempotencyKeySha256'] ==
                await memoryShaText(sent.key) &&
            acceptance['historicalTruthChanged'] == false &&
            acceptance['permanentDeletion'] == false &&
            raw['replayed'] is bool,
      );
      memoryHash(acceptance['requestSha256']);
      memoryInstant(acceptance['acceptedAt']);
      memoryRequire(
        acceptance['id'] ==
            'memory-lifecycle-acceptance:${await memorySha(['memory-lifecycle-acceptance:1', sent.owner.tenantId, sent.owner.canonicalActorId, await memoryShaText(sent.key)])}',
      );
      memoryRequire(
        knowledgeCount(
              acceptance['targetRevision'],
              'Accepted target revision',
            ) >
            0,
      );
      final before = knowledgeCount(
        acceptance['beforeLifecycleRevision'],
        'Before revision',
      );
      memoryRequire(acceptance['afterLifecycleRevision'] == before + 1);
      _lifecycle(acceptance['lifecycle']);
      final life = knowledgeMap(acceptance['lifecycle'], 'Accepted lifecycle');
      memoryRequire(switch (sent.body['action']) {
        'pin' => life['pinnedAt'] != null && life['archivedAt'] == null,
        'archive' =>
          life['archivedAt'] != null &&
              life['archiveReason'] == 'manual' &&
              life['pinnedAt'] == null,
        _ => life['pinnedAt'] == null && life['archivedAt'] == null,
      });
      parseMemoryLifecycle(raw['current'], sent.owner, sent.id!);
      description =
          '${sent.body['action']} recorded${raw['replayed'] == true ? ' · matching earlier acceptance' : ''}. Historical truth is unchanged.';
    } else {
      final receipt = knowledgeMap(
        raw['operationReceipt'],
        'Forgetting receipt',
      );
      memoryRequire(
        raw['forgotten'] == true &&
            raw['id'] == sent.id &&
            receipt['operation'] == 'forget' &&
            receipt['memoryId'] == sent.id &&
            receipt['expectedReceiptManifestSha256'] == sent.previewDigest &&
            receipt['irreversible'] == true &&
            const {
              'committed',
              'already_deleted',
            }.contains(raw['deletionDisposition']),
      );
      memoryRequire(raw['deletionGuarantee'] == 'scope_bound_receipt');
      final deletion = knowledgeMap(raw['deletionReceipt'], 'Deletion receipt');
      memoryRequire(
        deletion['contractKind'] == 'memory_deletion' &&
            deletion['schemaVersion'] == 1 &&
            deletion['descendantManifestSha256'] == sent.previewDigest &&
            deletion['receiptSha256'] == receipt['deletionReceiptSha256'],
      );
      memoryHash(deletion['receiptSha256']);
      // A covered descendant can refer to the original root's receipt.
      knowledgeIdentity(deletion['memoryId'], 'Deletion receipt root');
      final forgotten = {...response}
        ..remove('forgotten')
        ..remove('operationReceipt');
      outcome = {'forgotten': forgotten, 'operationReceipt': receipt};
      description =
          'Forgetting confirmed for the reviewed impact. ${raw['deletionDisposition'] == 'already_deleted' ? 'The earlier deletion receipt was recovered.' : 'The deletion barrier is committed.'}';
    }
    memoryRequire(service['outcomeSha256'] == await memorySha(outcome));
    return MemoryAcceptance(
      sent,
      freezeKnowledgeJson(raw) as KnowledgeJson,
      memoryId,
      description,
    );
  }

  static KnowledgeJson _record(Object? raw, KnowledgeOwner owner) {
    final record = knowledgeMap(raw, 'Accepted memory'),
        access = knowledgeMap(record['access'], 'Memory access');
    knowledgeIdentity(record['id'], 'Memory identity', maximum: 200);
    memoryRequire(
      record['tenantId'] == owner.tenantId &&
          access['visibility'] == 'user_private' &&
          access['owner'] == 'current_user' &&
          record['title'] is String &&
          record['content'] is String,
    );
    return record;
  }
}
