import 'dart:convert';

import 'knowledge_contracts.dart';
import 'knowledge_mutations.dart';

const memoryConsentReadContract = 'asael-personal-context-consent-read:1';
const memoryConsentDecisionContract =
    'asael-personal-context-consent-decision:1';
const memoryConsentNoticeSha256 =
    '443267b19d744dc16298e950b4c5c0f8543124a526488fa018668193e61f1e75';
const memoryConsentActions = {'activate', 'revoke'};

KnowledgeJson _object(Object? value, String fields) {
  final row = knowledgeMap(value, 'Personal recall consent');
  final keys = fields.split(' ').toSet();
  memoryRequire(row.length == keys.length && row.keys.every(keys.contains));
  return row;
}

String _instant(Object? value) {
  memoryRequire(
    value is String &&
        RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
            .hasMatch(value),
  );
  final text = value as String;
  memoryRequire(DateTime.tryParse(text)?.toUtc().toIso8601String() == text);
  return text;
}

KnowledgeJson memoryConsentSnapshot(Object? value) {
  final row = _object(value, 'state consentGeneration lifecycleRevision');
  final generation = row['consentGeneration'],
      revision = row['lifecycleRevision'];
  memoryRequire(
    generation is int &&
        generation >= 0 &&
        generation <= 9007199254740991 &&
        revision is int &&
        (row['state'] == 'active' && generation >= 1 && revision == 1 ||
            row['state'] == 'inactive' &&
                (generation == 0 && revision == 0 ||
                    generation >= 1 && revision == 2)),
  );
  return row;
}

KnowledgeJson memoryConsentNoticeShape(Object? value) {
  final row = _object(value, 'contractId version text sha256');
  memoryRequire(
    row['contractId'] == 'notice:personal-context-automatic' &&
        row['version'] == 1 &&
        row['text'] is String &&
        (row['text'] as String).isNotEmpty &&
        (row['text'] as String).length <= 4000 &&
        row['sha256'] == memoryConsentNoticeSha256,
  );
  return row;
}

Future<KnowledgeJson> _notice(Object? value) async {
  final row = memoryConsentNoticeShape(value);
  memoryRequire(
    await memoryShaText(row['text'] as String) == row['sha256'],
    'The personal recall notice could not be verified. Refresh before deciding.',
  );
  return row;
}

void validateMemoryConsentRequest(
  KnowledgeJson body,
  KnowledgeOwner owner,
  String? id,
  Object? notice,
) {
  final row = _object(
    body,
    'contract action noticeSha256 expectedState expectedConsentGeneration expectedLifecycleRevision expectedDecisionToken',
  );
  memoryRequire(
    row['contract'] == memoryConsentDecisionContract &&
        memoryConsentActions.contains(row['action']) &&
        row['noticeSha256'] == memoryConsentNoticeSha256 &&
        id == owner.canonicalActorId,
  );
  memoryHash(row['expectedDecisionToken']);
  memoryConsentSnapshot({
    'state': row['expectedState'],
    'consentGeneration': row['expectedConsentGeneration'],
    'lifecycleRevision': row['expectedLifecycleRevision'],
  });
  memoryRequire(
    memoryConsentNoticeShape(notice)['sha256'] == row['noticeSha256'],
  );
}

class MemoryConsentCurrent {
  const MemoryConsentCurrent(this.raw);
  final KnowledgeJson raw;
  bool get active => raw['state'] == 'active';
  int get generation => raw['consentGeneration'] as int;
  String? get token => raw['decisionToken'] as String?;
  KnowledgeJson get notice =>
      knowledgeMap(raw['notice'], 'Personal recall notice');
  KnowledgeJson get snapshot => {
    'state': raw['state'],
    'consentGeneration': raw['consentGeneration'],
    'lifecycleRevision': raw['lifecycleRevision'],
  };
  KnowledgeJson decision(String action) => {
    'contract': memoryConsentDecisionContract,
    'action': action,
    'noticeSha256': notice['sha256'],
    'expectedState': raw['state'],
    'expectedConsentGeneration': raw['consentGeneration'],
    'expectedLifecycleRevision': raw['lifecycleRevision'],
    'expectedDecisionToken': token,
  };
  static Future<MemoryConsentCurrent> parse(
    Object? value,
    KnowledgeOwner owner,
  ) async {
    final row = _object(
      value,
      'contract tenantId ownerActorId state consentGeneration lifecycleRevision notice authority decisionToken',
    );
    memoryRequire(
      row['contract'] == memoryConsentReadContract &&
          row['tenantId'] == owner.tenantId &&
          row['ownerActorId'] == owner.canonicalActorId,
    );
    final snapshot = memoryConsentSnapshot({
      'state': row['state'],
      'consentGeneration': row['consentGeneration'],
      'lifecycleRevision': row['lifecycleRevision'],
    });
    final notice = await _notice(row['notice']);
    if (row['decisionToken'] != null) {
      memoryHash(row['decisionToken']);
    }
    if (snapshot['state'] == 'active') {
      final authority = _object(
        row['authority'],
        'schemaVersion contractId tenantId actorId consentGeneration lifecycleRevision noticeContractId noticeContractVersion noticeSha256 activatedAt authoritySha256',
      );
      memoryRequire(
        authority['schemaVersion'] == 1 &&
            authority['contractId'] == 'personal-context-consent:1' &&
            authority['tenantId'] == owner.tenantId &&
            authority['actorId'] == owner.canonicalActorId &&
            authority['consentGeneration'] == snapshot['consentGeneration'] &&
            authority['lifecycleRevision'] == 1 &&
            authority['noticeContractId'] == notice['contractId'] &&
            authority['noticeContractVersion'] == notice['version'] &&
            authority['noticeSha256'] == notice['sha256'],
      );
      _instant(authority['activatedAt']);
      // This existing authority uses schema insertion order, unlike service receipts.
      final ordered = {
        for (final key in [
          'schemaVersion',
          'contractId',
          'tenantId',
          'actorId',
          'consentGeneration',
          'lifecycleRevision',
          'noticeContractId',
          'noticeContractVersion',
          'noticeSha256',
          'activatedAt',
        ])
          key: authority[key],
      };
      memoryRequire(
        authority['authoritySha256'] ==
            await memoryShaText(jsonEncode(ordered)),
      );
    } else {
      memoryRequire(row['authority'] == null);
    }
    return MemoryConsentCurrent(freezeKnowledgeJson(row) as KnowledgeJson);
  }
}

Future<KnowledgeJson> _acceptance(
  Object? value,
  KnowledgeOwner owner, {
  String? keyHash,
  MemorySubmission? sent,
}) async {
  final row = _object(
    value,
    'contract id tenantId ownerActorId action idempotencyKeySha256 requestSha256 noticeSha256 expectedDecisionToken before after acceptedAt changed',
  );
  final hash = memoryHash(row['idempotencyKeySha256']);
  memoryHash(
    row['requestSha256'],
  ); // Tenant-keyed HMAC, not reproducible by a client.
  memoryHash(row['expectedDecisionToken']);
  _instant(row['acceptedAt']);
  memoryRequire(
    row['contract'] == 'asael-personal-context-consent-acceptance:1' &&
        row['tenantId'] == owner.tenantId &&
        row['ownerActorId'] == owner.canonicalActorId &&
        row['noticeSha256'] == memoryConsentNoticeSha256 &&
        memoryConsentActions.contains(row['action']) &&
        row['changed'] is bool &&
        (keyHash == null || hash == keyHash),
  );
  memoryRequire(
    row['id'] ==
        'personal-context-consent-acceptance:${await memorySha(['personal-context-consent-acceptance:1', owner.tenantId, owner.canonicalActorId, hash])}',
  );
  final before = memoryConsentSnapshot(row['before']),
      after = memoryConsentSnapshot(row['after']);
  final changed = row['action'] == 'activate'
      ? before['state'] == 'inactive'
      : before['state'] == 'active';
  memoryRequire(row['changed'] == changed);
  final expectedAfter = changed
      ? {
          'state': row['action'] == 'activate' ? 'active' : 'inactive',
          'consentGeneration':
              (before['consentGeneration'] as int) +
              (row['action'] == 'activate' ? 1 : 0),
          'lifecycleRevision': row['action'] == 'activate' ? 1 : 2,
        }
      : before;
  memoryRequire(memoryCanonical(after) == memoryCanonical(expectedAfter));
  if (sent != null) {
    memoryRequire(
      sent.kind == MemoryChange.consent &&
          sent.owner.tenantId == owner.tenantId &&
          sent.owner.userId == owner.userId &&
          sent.owner.apiBaseUrl == owner.apiBaseUrl &&
          sent.id == owner.canonicalActorId &&
          hash == await memoryShaText(sent.key) &&
          row['action'] == sent.body['action'] &&
          row['noticeSha256'] == sent.body['noticeSha256'] &&
          row['expectedDecisionToken'] == sent.body['expectedDecisionToken'] &&
          before['state'] == sent.body['expectedState'] &&
          before['consentGeneration'] ==
              sent.body['expectedConsentGeneration'] &&
          before['lifecycleRevision'] == sent.body['expectedLifecycleRevision'],
    );
    await _notice(sent.consentNotice);
  }
  return freezeKnowledgeJson(row) as KnowledgeJson;
}

Future<void> _receipt(
  KnowledgeJson raw,
  KnowledgeOwner owner,
  String operation, {
  MemorySubmission? sent,
}) async {
  final receipt = _object(
    raw['serviceReceipt'],
    'schemaVersion receiptKind boundaryVersion operation action resourceType accessMode eventContract authoritySha256 idempotencyKeySha256 outcomeSha256 resourceCount occurredAt receiptSha256',
  );
  final mutation = operation == 'memory.personal-context-consent.decide';
  memoryRequire(!mutation || sent != null);
  final authorityOwner = mutation ? sent!.owner : owner;
  KnowledgeJson? executionScope;
  if (mutation) {
    final submission = sent!;
    executionScope = {
      'version': 1,
      'tenantId': authorityOwner.tenantId,
      'initiatingActorId': authorityOwner.actorId,
      'executingPrincipalType': 'user',
      'executingPrincipalId': authorityOwner.actorId,
      'workspaceId': null,
      'projectId': null,
      'missionId': null,
      'delegationId': null,
      'correlationId': submission.key.length <= 256
          ? submission.key
          : 'idempotency-key:${await memorySha(submission.key)}',
      'causationId': authorityOwner.canonicalActorId,
      'contextGrantIds': <String>[],
      'capabilityGrantIds': <String>[],
      'purpose': 'api.memory.personal-context-consent.native.decide',
    };
  }
  memoryRequire(
    receipt['schemaVersion'] == 1 &&
        receipt['receiptKind'] == 'app_service_receipt' &&
        receipt['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
        receipt['operation'] == operation &&
        receipt['action'] == (mutation ? 'write.memory' : 'read') &&
        receipt['resourceType'] == 'personal_context_consent' &&
        receipt['accessMode'] == (mutation ? 'mutation' : 'read') &&
        receipt['eventContract'] ==
            (mutation
                ? 'memory.personal_context_consent.atomic-events.v1'
                : 'read_only:no_domain_mutation') &&
        receipt['resourceCount'] == 1 &&
        receipt['idempotencyKeySha256'] ==
            (mutation
                ? await memoryShaText(
                    '${sent!.owner.tenantId}\u0000${sent.key}',
                  )
                : null),
  );
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
  final body = {...raw}..remove('serviceReceipt'),
      proof = {...receipt}..remove('receiptSha256');
  memoryRequire(
    receipt['outcomeSha256'] == await memorySha(body) &&
        receipt['receiptSha256'] == await memorySha(proof),
  );
}

class MemoryConsentRead {
  const MemoryConsentRead(this.raw, this.current, this.acceptance);
  final KnowledgeJson raw;
  final MemoryConsentCurrent current;
  final KnowledgeJson? acceptance;
  static Future<MemoryConsentRead> parse(
    Object? value,
    KnowledgeOwner owner, {
    String? keyHash,
    MemorySubmission? sent,
    bool mutation = false,
  }) async {
    final raw = _object(
      value,
      'contract scope current acceptance serviceReceipt${mutation ? ' replayed' : ''}',
    );
    final scope = _object(raw['scope'], 'tenantId ownerActorId visibility');
    memoryRequire(
      raw['contract'] == memoryConsentReadContract &&
          scope['tenantId'] == owner.tenantId &&
          scope['ownerActorId'] == owner.canonicalActorId &&
          scope['visibility'] == 'user_private',
    );
    if (keyHash != null) {
      memoryHash(keyHash);
    }
    final current = await MemoryConsentCurrent.parse(raw['current'], owner);
    final accepted = raw['acceptance'] == null
        ? null
        : await _acceptance(
            raw['acceptance'],
            owner,
            keyHash: keyHash,
            sent: sent,
          );
    if (mutation) {
      memoryRequire(
        accepted != null && raw['replayed'] is bool && sent != null,
      );
    } else if (keyHash == null) {
      memoryRequire(accepted == null);
    }
    if (accepted != null) {
      final after = knowledgeMap(
            accepted['after'],
            'Accepted personal recall state',
          ),
          acceptedGeneration = after['consentGeneration'] as int;
      memoryRequire(
        current.generation >= acceptedGeneration &&
            (current.generation != acceptedGeneration ||
                (current.raw['lifecycleRevision'] as int) >=
                    (after['lifecycleRevision'] as int)),
      );
      if (mutation && raw['replayed'] == false) {
        memoryRequire(
          memoryCanonical(current.snapshot) == memoryCanonical(after),
        );
      }
    }
    // Exact reads and replays may observe a later state than the saved decision.
    await _receipt(
      raw,
      owner,
      mutation
          ? 'memory.personal-context-consent.decide'
          : keyHash == null
          ? 'memory.personal-context-consent.get'
          : 'memory.personal-context-consent.decision.get',
      sent: sent,
    );
    return MemoryConsentRead(
      freezeKnowledgeJson(raw) as KnowledgeJson,
      current,
      accepted,
    );
  }
}

abstract interface class KnowledgeConsentRepository {
  bool get supportsConsent;
  Future<MemoryConsentRead> readConsent({String? acceptanceKeySha256});
}
