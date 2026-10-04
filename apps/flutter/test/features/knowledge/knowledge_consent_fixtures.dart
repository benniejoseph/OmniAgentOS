import 'dart:async';
import 'dart:convert';

import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_consent_contracts.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'knowledge_review_fixtures.dart' show reviewOwner, reviewAt;

const consentText =
    'Allow Asael to automatically select relevant saved personal memory only for requests where you choose Personal automatic context. This does not share memory with other users or agents, authorize tools, or change memory. You can turn it off at any time.';
Json consentNotice() => {
  'contractId': 'notice:personal-context-automatic',
  'version': 1,
  'text': consentText,
  'sha256': memoryConsentNoticeSha256,
};
Future<Json> consentCurrent({
  KnowledgeOwner owner = reviewOwner,
  bool active = false,
  int? generation,
  bool writable = true,
}) async {
  final selectedGeneration = generation ?? (active ? 1 : 0);
  Json? authority;
  if (active) {
    authority = {
      'schemaVersion': 1,
      'contractId': 'personal-context-consent:1',
      'tenantId': owner.tenantId,
      'actorId': owner.canonicalActorId,
      'consentGeneration': selectedGeneration,
      'lifecycleRevision': 1,
      'noticeContractId': 'notice:personal-context-automatic',
      'noticeContractVersion': 1,
      'noticeSha256': memoryConsentNoticeSha256,
      'activatedAt': reviewAt,
    };
    authority['authoritySha256'] = await memoryShaText(jsonEncode(authority));
  }
  return {
    'contract': memoryConsentReadContract,
    'tenantId': owner.tenantId,
    'ownerActorId': owner.canonicalActorId,
    'state': active ? 'active' : 'inactive',
    'consentGeneration': selectedGeneration,
    'lifecycleRevision': active
        ? 1
        : selectedGeneration == 0
        ? 0
        : 2,
    'notice': consentNotice(),
    'authority': authority,
    'decisionToken': writable ? 'a' * 64 : null,
  };
}

MemorySubmission consentSubmission(
  Json current, {
  String action = 'activate',
  String key = 'consent-fixed-key',
  KnowledgeOwner owner = reviewOwner,
}) => MemorySubmission(
  kind: MemoryChange.consent,
  owner: owner,
  id: owner.canonicalActorId,
  key: key,
  consentNotice: consentNotice(),
  body: {
    'contract': memoryConsentDecisionContract,
    'action': action,
    'noticeSha256': memoryConsentNoticeSha256,
    'expectedState': current['state'],
    'expectedConsentGeneration': current['consentGeneration'],
    'expectedLifecycleRevision': current['lifecycleRevision'],
    'expectedDecisionToken': current['decisionToken'],
  },
);

Future<Json> consentAcceptance(MemorySubmission sent) async {
  final hash = await memoryShaText(sent.key),
      active = sent.body['expectedState'] == 'active',
      activate = sent.body['action'] == 'activate';
  final changed = active != activate;
  final before = {
    'state': sent.body['expectedState'],
    'consentGeneration': sent.body['expectedConsentGeneration'],
    'lifecycleRevision': sent.body['expectedLifecycleRevision'],
  };
  return {
    'contract': 'asael-personal-context-consent-acceptance:1',
    'id':
        'personal-context-consent-acceptance:${await memorySha(['personal-context-consent-acceptance:1', sent.owner.tenantId, sent.owner.canonicalActorId, hash])}',
    'tenantId': sent.owner.tenantId,
    'ownerActorId': sent.owner.canonicalActorId,
    'action': sent.body['action'],
    'idempotencyKeySha256': hash,
    'requestSha256': 'b' * 64,
    'noticeSha256': memoryConsentNoticeSha256,
    'expectedDecisionToken': sent.body['expectedDecisionToken'],
    'before': before,
    'after': changed
        ? {
            'state': activate ? 'active' : 'inactive',
            'consentGeneration':
                (sent.body['expectedConsentGeneration'] as int) +
                (activate ? 1 : 0),
            'lifecycleRevision': activate ? 1 : 2,
          }
        : before,
    'acceptedAt': reviewAt,
    'changed': changed,
  };
}

Future<Json> consentResponse(
  Json current, {
  KnowledgeOwner owner = reviewOwner,
  Json? acceptance,
  MemorySubmission? sent,
  String? keyHash,
  bool replayed = false,
}) async {
  final mutation = sent != null;
  final body = <String, dynamic>{
    'contract': memoryConsentReadContract,
    'scope': {
      'tenantId': owner.tenantId,
      'ownerActorId': owner.canonicalActorId,
      'visibility': 'user_private',
    },
    'current': current,
    'acceptance': acceptance,
    if (mutation) 'replayed': replayed,
  };
  Json? execution;
  if (mutation) {
    execution = {
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
      'causationId': owner.canonicalActorId,
      'contextGrantIds': <String>[],
      'capabilityGrantIds': <String>[],
      'purpose': 'api.memory.personal-context-consent.native.decide',
    };
  }
  final receipt = <String, dynamic>{
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': mutation
        ? 'memory.personal-context-consent.decide'
        : keyHash == null
        ? 'memory.personal-context-consent.get'
        : 'memory.personal-context-consent.decision.get',
    'action': mutation ? 'write.memory' : 'read',
    'resourceType': 'personal_context_consent',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? 'memory.personal_context_consent.atomic-events.v1'
        : 'read_only:no_domain_mutation',
    'authoritySha256': await memorySha({
      'boundaryVersion': 'p9.1-app-service-boundary:1',
      'tenantId': owner.tenantId,
      'actorId': owner.actorId,
      'role': owner.role,
      'executionScope': execution,
    }),
    'idempotencyKeySha256': mutation
        ? await memoryShaText('${owner.tenantId}\u0000${sent.key}')
        : null,
    'outcomeSha256': await memorySha(body),
    'resourceCount': 1,
    'occurredAt': reviewAt,
  };
  return {
    ...body,
    'serviceReceipt': {...receipt, 'receiptSha256': await memorySha(receipt)},
  };
}

class ConsentRepository extends Fake
    implements
        KnowledgeRepository,
        KnowledgeMutationRepository,
        KnowledgeConsentRepository {
  ConsentRepository(this.snapshot, {KnowledgeOwner owner = reviewOwner}) {
    access.update(owner, true);
  }
  Json snapshot;
  Json? accepted;
  Object? readFailure, submitFailure;
  bool failCatalogue = false;
  Completer<MemoryConsentRead>? heldRead;
  Completer<MemoryAcceptance>? heldSubmit;
  final reads = <String?>[], submissions = <MemorySubmission>[];
  Future<void> Function(MemorySubmission)? beforeSubmit;
  @override
  final access = KnowledgeAccess();
  @override
  bool authorityCurrent() => access.readable;
  @override
  bool supports(MemoryChange kind) => true;
  @override
  bool get supportsConsent => true;
  @override
  Future<MemoryConsentRead> readConsent({String? acceptanceKeySha256}) async {
    reads.add(acceptanceKeySha256);
    if (readFailure != null) {
      throw readFailure!;
    }
    if (heldRead != null) {
      return heldRead!.future;
    }
    return MemoryConsentRead.parse(
      await consentResponse(
        snapshot,
        owner: access.owner!,
        acceptance: acceptanceKeySha256 == null ? null : accepted,
        keyHash: acceptanceKeySha256,
      ),
      access.owner!,
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
    accepted = await consentAcceptance(sent);
    final after = accepted!['after'] as Map;
    snapshot = await consentCurrent(
      active: after['state'] == 'active',
      generation: after['consentGeneration'] as int,
    );
    return MemoryAcceptance.parse(
      await consentResponse(snapshot, acceptance: accepted, sent: sent),
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

KnowledgeController consentController(
  ConsentRepository repo,
  KnowledgeRecoveryStore store,
) => KnowledgeController(
  repo,
  canManage: repo.access.owner!.canWrite,
  mutationsAvailable: false,
  recoveryStore: store,
);
