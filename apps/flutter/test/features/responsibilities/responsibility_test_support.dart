import 'dart:convert';

import 'package:asael/features/responsibilities/responsibility_contracts.dart';
import 'package:asael/features/responsibilities/responsibility_repository.dart';
import 'package:dio/dio.dart';

const testOwner = ResponsibilityOwner(
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-a',
  requestActorId: 'owner@example.test',
  role: 'operator',
  apiBaseUrl: 'https://example.test',
);
const now = '2026-10-04T00:00:00.000Z';
const expiry = '2026-10-11T00:00:00.000Z';
final hashA = List.filled(64, 'a').join();
final testId = 'responsibility:$hashA';
ResponsibilityJson cloneJson(Object? value) =>
    responsibilityMap(jsonDecode(jsonEncode(value)));
ResponsibilityJson get draftEnvelope => {
  'schemaVersion': 1,
  'contract': responsibilityDraftContract,
  'compatibility': {
    'schemaVersion': 1,
    'supportedActions': ['create', 'update', 'review'],
    'activationSupported': false,
    'executionAuthority': 'none',
    'observationSupported': false,
    'deliverySupported': false,
    'unknownVersionBehavior': 'reject_without_mutation',
  },
};
ResponsibilityJson get source => {
  'kind': 'meeting',
  'id': 'meeting:a',
  'workspaceId': 'workspace:owner',
};
ResponsibilityJson get counters => {
  for (final key in responsibilityBudgetDimensions) key: 0,
};
ResponsibilityJson get fullDraft => {
  ...emptyResponsibilityDraft(),
  'purpose': 'Prepare for the owner meeting',
  'desiredOutcome': 'Keep the owner informed of material changes',
  'sources': [source],
  'cadence': {
    'frequency': 'daily',
    'interval': 1,
    'timezone': 'Asia/Kolkata',
    'startsAt': now,
    'expiresAt': expiry,
    'missedPolicy': 'skip',
  },
  'limits': {
    'maxChecks': 7,
    'maxNotifications': 3,
    'cumulative': {
      ...counters,
      'toolCalls': 7,
      'agents': 7,
      'wallTimeMs': 210000,
    },
  },
  'notificationRule': {
    'kind': 'material_change_only',
    'destination': 'owner_in_app',
    'quietOnNoChange': true,
  },
  'successCondition': 'The owner has current evidence',
  'stopConditions': ['The meeting starts'],
  'work': {
    'workspaceId': 'workspace:owner',
    'projectId': 'project-a',
    'workItemId': 'work-a',
  },
  'procedureId': 'meeting-brief',
  'agentId': 'atlas',
};
ResponsibilityJson get pins => {
  'sources': [
    {'source': source, 'revisionSha256': hashA},
  ],
  'work': {...responsibilityMap(fullDraft['work']), 'projectionSha256': hashA},
  'procedure': {
    'id': 'meeting-brief',
    'snapshotSha256': hashA,
    'toolBindingsSha256': hashA,
  },
  'agent': {
    'id': 'atlas',
    'definitionVersionId': 'atlas:v1',
    'principalVersionId': 'atlas-principal:v1',
    'identityPinSha256': hashA,
    'policySha256': hashA,
  },
};
Future<ResponsibilityJson> sealed(
  ResponsibilityJson body,
  String field,
) async => {...body, field: await responsibilityHash(body)};
Future<ResponsibilityJson> draftRecord({
  String? id,
  int revision = 1,
  ResponsibilityJson? draft,
  ResponsibilityOwner owner = testOwner,
}) async {
  final body = draft ?? fullDraft;
  return {
    'schemaVersion': 1,
    'id': id ?? testId,
    'tenantId': owner.tenantId,
    'actorId': owner.actorId,
    'revision': revision,
    'state': 'draft',
    'draft': body,
    'draftSha256': await responsibilityHash({
      'contract': 'responsibility-draft:1',
      'draft': body,
    }),
    'review': null,
    'createdAt': now,
    'updatedAt': now,
  };
}

Future<ResponsibilityJson> draftResult(
  ResponsibilityJson input,
  String key, {
  String? id,
  ResponsibilityOwner owner = testOwner,
}) async {
  final keySha = await responsibilityHash([
        'responsibility-idempotency:1',
        key,
      ]),
      target =
          id ??
          'responsibility:${await responsibilityHash([
            owner.tenantId,
            owner.actorId,
            await responsibilityHash(['responsibility-idempotency:1', key]),
          ])}';
  final snapshot = await draftRecord(
    id: target,
    revision: (input['expectedRevision'] as int) + 1,
    draft: responsibilityMap(input['draft']),
    owner: owner,
  );
  return {
    ...draftEnvelope,
    'current': snapshot,
    'receipt': {
      'schemaVersion': 1,
      'id':
          'responsibility-mutation:${await responsibilityHash([owner.tenantId, owner.actorId, keySha])}',
      'idempotencySha256': keySha,
      'requestSha256': await responsibilityHash([
        'responsibility-request:1',
        target,
        input,
      ]),
      'action': input['action'] == 'create' ? 'created' : 'updated',
      'expectedRevision': input['expectedRevision'],
      'snapshot': snapshot,
      'savedAt': now,
      'authorityEffect': 'none',
      'activationSupported': false,
    },
    'replayed': false,
  };
}

Future<ResponsibilityJson> runtimeConfiguration() => sealed({
  'schemaVersion': 1,
  'pilot': responsibilityPilot,
  'responsibilityRevision': 2,
  'reviewSha256': hashA,
  'draftSha256': hashA,
  'pins': pins,
  'source': source,
  'tool': {
    'id': 'app.meetings.show',
    'input': {'workspaceId': 'workspace:owner', 'meetingId': 'meeting:a'},
    'contractSha256': hashA,
  },
  'cadence': fullDraft['cadence'],
  'maximumChecks': 7,
  'cumulativeLimits': responsibilityMap(fullDraft['limits'])['cumulative'],
  'checkReservation': {
    ...counters,
    'toolCalls': 1,
    'agents': 1,
    'wallTimeMs': 30000,
  },
  'comparisonPolicySha256': hashA,
  'stops': ['expiry', 'meeting_started', 'meeting_canceled'],
  'notificationAuthority': 'none',
  'approvalAuthority': 'none',
  'mutationAuthority': 'none',
}, 'configurationSha256');
Future<ResponsibilityJson> runtimeHead({
  int revision = 1,
  int generation = 1,
  String state = 'active',
  String reason = 'owner_activated',
}) async {
  final configuration = await runtimeConfiguration();
  return {
    'schemaVersion': 1,
    'contract': responsibilityRuntimeContract,
    'tenantId': testOwner.tenantId,
    'actorId': testOwner.actorId,
    'responsibilityId': testId,
    'revision': revision,
    'generation': generation,
    'state': state,
    'reason': reason,
    'configuration': configuration,
    'nextDueAt': state == 'active' ? now : null,
    'budget': {
      'limits': configuration['cumulativeLimits'],
      'used': counters,
      'reserved': counters,
      'maximumChecks': 7,
      'usedChecks': 0,
      'reservedChecks': 0,
    },
    'activatedAt': now,
    'updatedAt': now,
  };
}

ResponsibilityJson runtimeView([ResponsibilityJson? head]) => {
  'schemaVersion': 1,
  'contract': responsibilityRuntimeContract,
  'current': head,
  'disclosure': {
    'pilot': responsibilityPilot,
    'source': 'One current owner-private Meeting.',
    'comparison': 'Deterministic structured metadata.',
    'cadence': 'Daily or weekly, skipped missed instants.',
    'stops': 'Expiry, meeting start or cancellation.',
    'execution': 'The exact read-only app.meetings.show binding.',
  },
  'wakes': <Object?>[],
  'receipts': <Object?>[],
  'coverage': {
    'limit': 40,
    'total': null,
    'hasMoreWakes': false,
    'hasMoreReceipts': false,
  },
  'dispatchReadiness': 'not_observed',
  'deliverySupported': false,
};
Future<ResponsibilityJson> runtimeResult(
  ResponsibilityJson input,
  String key,
) async {
  final action = input['action'],
      snapshot = await runtimeHead(
        revision: (input['expectedRevision'] as int) + 1,
        generation: (input['expectedGeneration'] as int) + 1,
        state: action == 'pause'
            ? 'paused'
            : action == 'end'
            ? 'ended'
            : 'active',
        reason: action == 'pause'
            ? 'owner_paused'
            : action == 'end'
            ? 'owner_ended'
            : action == 'resume'
            ? 'owner_resumed'
            : 'owner_activated',
      );
  final keySha = await responsibilityHash([
    'responsibility-idempotency:1',
    key,
  ]);
  final receipt = await sealed({
    'schemaVersion': 1,
    'id':
        'responsibility-runtime-receipt:${await responsibilityHash([testOwner.tenantId, testOwner.actorId, keySha])}',
    'idempotencySha256': keySha,
    'requestSha256': await responsibilityHash({
      'responsibilityId': testId,
      ...input,
    }),
    'action': action,
    'previousRevision': input['expectedRevision'],
    'snapshot': snapshot,
    'wake': null,
    'savedAt': now,
  }, 'receiptSha256');
  return {
    'schemaVersion': 1,
    'contract': responsibilityRuntimeContract,
    'current': snapshot,
    'receipt': receipt,
    'replayed': false,
  };
}

Future<ResponsibilityJson> notificationConfiguration() async => sealed({
  'schemaVersion': 1,
  'tenantId': testOwner.tenantId,
  'actorId': testOwner.actorId,
  'responsibilityId': testId,
  'policy': 'owner_in_app_material_change_v1',
  'runtimeConfigurationSha256':
      (await runtimeConfiguration())['configurationSha256'],
  'responsibilityRevision': 2,
  'reviewSha256': hashA,
  'draftSha256': hashA,
  'source': source,
  'destination': 'owner_in_app',
  'quietOnNoChange': true,
  'maximumNotifications': 3,
  'expiresAt': expiry,
}, 'configurationSha256');
Future<ResponsibilityJson> notificationHead({
  int revision = 1,
  int generation = 1,
  String state = 'enabled',
  String reason = 'owner_enabled',
  int used = 0,
  int reserved = 0,
}) async => {
  'schemaVersion': 1,
  'contract': responsibilityNotificationContract,
  'tenantId': testOwner.tenantId,
  'actorId': testOwner.actorId,
  'responsibilityId': testId,
  'revision': revision,
  'generation': generation,
  'state': state,
  'reason': reason,
  'configuration': await notificationConfiguration(),
  'used': used,
  'reserved': reserved,
  'enabledAt': now,
  'updatedAt': now,
};
ResponsibilityJson notificationView([ResponsibilityJson? head]) => {
  'schemaVersion': 1,
  'contract': responsibilityNotificationContract,
  'disclosure': 'Owner in-app notices only; explicit separate admission, no external delivery.',
  'externalDelivery': false,
  'current': head,
  'candidates': <Object?>[],
  'receipts': <Object?>[],
  'coverage': {
    'limit': 40,
    'total': null,
    'hasMoreCandidates': false,
    'hasMoreReceipts': false,
  },
};
Future<ResponsibilityJson> notificationCandidate({
  String state = 'held',
  int generation = 1,
}) async {
  final changeId = 'responsibility-change:$hashA';
  return {
    'schemaVersion': 1,
    'tenantId': testOwner.tenantId,
    'actorId': testOwner.actorId,
    'responsibilityId': testId,
    'id':
        'responsibility-notification:${await responsibilityHash([testOwner.tenantId, testOwner.actorId, testId, changeId, hashA, 'owner_in_app'])}',
    'changeId': changeId,
    'changeSha256': hashA,
    'configurationSha256':
        (await notificationConfiguration())['configurationSha256'],
    'generation': generation,
    'revision': 1,
    'state': state,
    'reason': state == 'held'
        ? 'quiet_hours'
        : state == 'delivered'
        ? 'in_app_recorded'
        : 'material_change',
    'attempts': 1,
    'expiresAt': expiry,
    'nextAttemptAt': state == 'delivered' ? null : now,
    'notificationId': state == 'delivered'
        ? 'notification_${List.filled(48, 'a').join()}'
        : null,
    'dispositionId': 'notification_disposition_${List.filled(48, 'b').join()}',
    'deliveryBindingSha256': state == 'delivered' ? hashA : null,
    'createdAt': now,
    'updatedAt': now,
    'terminalAt': state == 'delivered' ? now : null,
  };
}

Future<ResponsibilityJson> notificationResult(
  ResponsibilityJson input,
  String key,
) async {
  final stopping = input['action'] == 'stop',
      head = await notificationHead(
        revision: stopping ? (input['expectedRevision'] as int) + 1 : 1,
        generation: stopping ? (input['expectedGeneration'] as int) + 1 : 1,
        state: stopping ? 'ended' : 'enabled',
        reason: stopping ? 'owner_stopped' : 'owner_enabled',
      );
  final keySha = await responsibilityHash([
    'responsibility-idempotency:1',
    key,
  ]);
  final receipt = await sealed({
    'schemaVersion': 1,
    'id':
        'responsibility-notification-receipt:${await responsibilityHash([testOwner.tenantId, testOwner.actorId, keySha])}',
    'idempotencySha256': keySha,
    'requestSha256': await responsibilityHash({
      'responsibilityId': testId,
      ...input,
    }),
    'previousRevision': stopping ? input['expectedRevision'] : 0,
    'action': input['action'],
    'snapshot': head,
    'candidate': null,
    'savedAt': now,
    'contentIncluded': false,
  }, 'receiptSha256');
  return {
    'schemaVersion': 1,
    'contract': responsibilityNotificationContract,
    'disclosure': 'Owner in-app only.',
    'externalDelivery': false,
    'current': head,
    'receipt': receipt,
    'replayed': false,
  };
}

Future<ResponsibilityJson> observationView() async => {
  'schemaVersion': 1,
  'contract': responsibilityObservationContract,
  'policy': await sealed({
    'schemaVersion': 1,
    'id': 'responsibility-meeting-comparison:1',
    'maximumSourceAgeSeconds': 3600,
    'firstObservation': 'establish_baseline_without_notification',
    'advancement': 'complete_current_authorized_evidence_only',
    'uncertainComparison': 'insufficient_evidence',
    'adapterCoverage': 'Native owner-private Meeting metadata only.',
    'materialExamples': ['Meeting time changes.'],
    'cosmeticExamples': ['Equivalent display formatting.'],
    'unsupportedExamples': ['Changed unstructured prose.'],
  }, 'policySha256'),
  'authorityEffect': 'none',
  'activationSupported': false,
  'deliverySupported': false,
  'receipts': <Object?>[],
  'baseline': null,
  'hasMore': false,
  'coverage': {
    'kind': 'bounded_recent',
    'limit': 25,
    'returned': 0,
    'total': null,
  },
};
Future<ResponsibilityJson> observationOutcome(String outcome) async {
  final view = await observationView(),
      policySha = responsibilityMap(
        (await observationView())['policy'],
      )['policySha256'];
  final target = {
    'tenantId': testOwner.tenantId,
    'actorId': testOwner.actorId,
    'responsibilityId': testId,
    'responsibilityRevision': 2,
    'reviewSha256': hashA,
  };
  final complete = outcome != 'insufficient_evidence',
      expected = outcome == 'baseline_established' ? 0 : 1;
  final semantic = await sealed({
    for (final field in [
      'meeting_time',
      'meeting_state',
      'agenda',
      'participants',
      'facts',
      'commitments',
      'uninterpretedText',
    ])
      field: hashA,
  }, 'semanticSha256');
  final evidence = {
    'kind': 'meeting_revision',
    'id': 'evidence:one',
    'revisionId': 'revision:one',
    'revisionSha256': hashA,
    'contentSha256': hashA,
  };
  final observation = await sealed({
    'schemaVersion': 1,
    'contract': responsibilityObservationContract,
    'id':
        'responsibility-observation:${await responsibilityHash([target, hashA])}',
    'target': target,
    'policySha256': policySha,
    'observationKeySha256': hashA,
    'observedAt': now,
    'sources': [
      {
        'source': source,
        'state': complete ? 'accepted' : 'unavailable',
        'reason': complete ? null : 'missing',
        'revisionId': complete ? 'revision:one' : null,
        'revisionSha256': complete ? hashA : null,
        'authoritySha256': complete ? hashA : null,
        'observedAt': complete ? now : null,
        'sourceUpdatedAt': complete ? now : null,
        'freshUntil': complete ? '2026-10-04T01:00:00.000Z' : null,
        'evidence': complete ? [evidence] : <Object?>[],
      },
    ],
    'state': complete ? 'complete' : 'insufficient_evidence',
    'semantic': complete ? semantic : null,
    'failureReasons': complete ? <String>[] : ['missing'],
    'authorityEffect': 'none',
    'activationSupported': false,
  }, 'observationSha256');
  final baseline = complete
      ? await sealed({
          'schemaVersion': 1,
          'revision': expected + 1,
          'target': target,
          'policySha256': policySha,
          'observationId': observation['id'],
          'observationSha256': observation['observationSha256'],
          'semantic': semantic,
          'acceptedAt': now,
        }, 'baselineSha256')
      : null;
  final change = outcome == 'material_change'
      ? await sealed({
          'schemaVersion': 1,
          'id':
              'responsibility-change:${await responsibilityHash([target, policySha, hashA, semantic['semanticSha256']])}',
          'target': target,
          'policySha256': policySha,
          'previousBaselineSha256': hashA,
          'observationId': observation['id'],
          'categories': ['meeting_time'],
          'evidence': [evidence],
          'previousSemanticSha256': hashA,
          'semanticSha256': semantic['semanticSha256'],
          'deliveryState': 'not_requested',
        }, 'changeSha256')
      : null;
  final request = {
    'responsibilityId': testId,
    'expectedResponsibilityRevision': 2,
    'expectedReviewSha256': hashA,
    'expectedBaselineRevision': expected,
    'policySha256': policySha,
  };
  final receipt = await sealed({
    'schemaVersion': 1,
    'request': request,
    'requestSha256': await responsibilityHash({
      'owner': {'tenantId': testOwner.tenantId, 'actorId': testOwner.actorId},
      'request': request,
    }),
    'plan': {
      'expectedBaselineRevision': expected,
      'observation': observation,
      'outcome': outcome,
      'reasons': [
        outcome == 'baseline_established'
            ? 'first_complete_observation'
            : outcome == 'no_change'
            ? 'equivalent_evidence'
            : outcome == 'material_change'
            ? 'meeting_time'
            : 'missing',
      ],
      'nextBaseline': baseline,
      'change': change,
      'authorityEffect': 'none',
      'activationSupported': false,
    },
    'savedAt': now,
  }, 'receiptSha256');
  return {
    ...view,
    'receipts': [receipt],
    'baseline': baseline,
    'coverage': {
      'kind': 'bounded_recent',
      'limit': 25,
      'returned': 1,
      'total': null,
    },
  };
}

Future<ResponsibilityJson> settledWake({int generation = 1}) async => {
  'schemaVersion': 1,
  'id':
      'responsibility-wake:${await responsibilityHash([testOwner.tenantId, testOwner.actorId, testId, generation, now])}',
  'tenantId': testOwner.tenantId,
  'actorId': testOwner.actorId,
  'responsibilityId': testId,
  'generation': generation,
  'configurationSha256': (await runtimeConfiguration())['configurationSha256'],
  'scheduledFor': now,
  'revision': 2,
  'state': 'canceled',
  'reservation': {
    ...counters,
    'toolCalls': 1,
    'agents': 1,
    'wallTimeMs': 30000,
  },
  'charged': counters,
  'workflowRunId': null,
  'operationJobId': null,
  'leaseGeneration': 0,
  'leaseTokenSha256': null,
  'leaseExpiresAt': null,
  'startedAt': null,
  'settledAt': now,
  'observationId': null,
  'observationReceiptSha256': null,
  'createdAt': now,
  'updatedAt': now,
};
ResponsibilityJson references(ResponsibilityOwner owner) => {
  'schemaVersion': 1,
  'contract': 'asael-responsibility-references:1',
  'owner': {'tenantId': owner.tenantId, 'actorId': owner.actorId},
  'groups': {
    for (final key in ['sources', 'work', 'procedures', 'agents'])
      key: {'state': 'available', 'items': <Object?>[], 'hasMore': false},
  },
  'coverage': {'perGroupLimit': 40, 'totals': 'unavailable'},
  'authorityEffect': 'none',
};

typedef TestRead = Future<ResponsibilityJson> Function(
  ResponsibilityRead kind,
  String? id,
  bool preview,
);
typedef TestMutation = Future<ResponsibilityJson> Function(
  ResponsibilityLane lane,
  ResponsibilityJson body,
  String key,
  String? id,
);

class TestResponsibilityRepository implements ResponsibilityRepository {
  TestResponsibilityRepository({ResponsibilityOwner owner = testOwner})
    : access = ResponsibilityAccess(owner: owner, ready: true);
  @override
  final ResponsibilityAccess access;
  bool probe = true, failReads = false;
  int reads = 0;
  final List<(ResponsibilityLane, ResponsibilityJson, String, String?)> writes =
      [];
  TestRead? onRead;
  TestMutation? onMutation;
  @override
  bool authorityCurrent() => probe && access.readable;
  @override
  bool supportsMutation(ResponsibilityLane lane) => true;
  @override
  Future<ResponsibilityJson> read(
    ResponsibilityRead kind,
    CancelToken cancel, {
    String? id,
    bool preview = false,
  }) async {
    reads++;
    if (failReads) throw StateError('Read failed.');
    final owner = access.owner!;
    if (onRead != null) return onRead!(kind, id, preview);
    return defaultRead(kind, id, owner: owner);
  }

  Future<ResponsibilityJson> defaultRead(
    ResponsibilityRead kind,
    String? id, {
    ResponsibilityOwner? owner,
  }) async {
    owner ??= access.owner!;
    return switch (kind) {
      ResponsibilityRead.list => {
        ...draftEnvelope,
        'records': <Object?>[],
        'hasMore': false,
        'coverage': {
          'kind': 'bounded_recent',
          'limit': 40,
          'returned': 0,
          'total': null,
        },
      },
      ResponsibilityRead.references => references(owner),
      ResponsibilityRead.detail => {
        ...draftEnvelope,
        'record': await draftRecord(id: id, owner: owner),
        'readiness': {'state': 'not_checked', 'issues': <String>[]},
      },
      ResponsibilityRead.runtime => runtimeView(),
      ResponsibilityRead.notifications => notificationView(),
      ResponsibilityRead.observations => await observationView(),
    };
  }

  @override
  Future<ResponsibilityJson> mutate(
    ResponsibilityLane lane,
    ResponsibilityJson input,
    String key, {
    String? id,
    bool Function()? isCurrent,
  }) async {
    responsibilityRequire(isCurrent?.call() ?? true);
    final owner = access.owner!;
    writes.add((lane, cloneJson(input), key, id));
    final raw = onMutation == null
        ? lane == ResponsibilityLane.draft
              ? await draftResult(input, key, id: id, owner: owner)
              : lane == ResponsibilityLane.runtime
              ? await runtimeResult(input, key)
              : await notificationResult(input, key)
        : await onMutation!(lane, input, key, id);
    return ResponsibilityVerifier(owner).mutation(raw, lane, input, key, id);
  }
}
