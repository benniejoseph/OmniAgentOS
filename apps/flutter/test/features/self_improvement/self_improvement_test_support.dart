import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:asael/features/agents/specialist_contracts.dart';
import 'package:asael/features/self_improvement/self_improvement_models.dart';

const improvementUser = '11111111-1111-4111-8111-111111111111';
const improvementActor = 'actor:$improvementUser';
const improvementStamp = '2026-10-26T10:00:00.000Z';
String improvementHex(String c, [int length = 64]) =>
    List.filled(length, c).join();
String get improvementCycleId => 'self_cycle_${improvementHex('1')}';
ImprovementJson improvementCopy(ImprovementJson value) =>
    improvementObject(jsonDecode(jsonEncode(value)));
Future<ImprovementJson> sealImprovement(
  String kind,
  ImprovementJson value,
  String field,
) async => {
  ...value,
  field: await specialistSha({
    'contract': 'asael-self-improvement',
    'version': 1,
    'kind': kind,
    'value': value,
  }),
};
Future<ImprovementJson> improvementPolicy({
  bool legacy = false,
  bool notify = false,
}) => sealImprovement('policy', {
  'version': 1,
  'dailyBudgetUsd': 100,
  if (!legacy) 'maxCycleBudgetUsd': 10,
  'maxActiveCycles': 1,
  'maxCandidatesPerCycle': 1,
  'maxCorrections': 1,
  'maxCycleDurationMs': 3600000,
  'maxChangedFiles': 12,
  'maxChangedLines': 1200,
  'autoReleaseRoutineChanges': true,
  'notifyOutcomes': notify,
  'protectedPathsVersion': 1,
}, 'policySha256');
ImprovementJson improvementConfig(ImprovementJson policy) => {
  'id': 'configuration-one',
  'tenantId': 'default',
  'ownerActorId': improvementActor,
  'projectId': 'project-one',
  'repositoryId': '1260961340',
  'repository': {
    'owner': 'benniejoseph',
    'name': 'OmniAgentOS',
    'defaultBranch': 'main',
  },
  'policy': policy,
  'generation': 1,
  'nextDueAt': '2026-10-27T01:30:00.000Z',
  'paused': false,
  'timeZone': 'Asia/Kolkata',
  'dailyHour': 7,
  'createdAt': improvementStamp,
  'updatedAt': improvementStamp,
};
Future<ImprovementJson> improvementCycle(
  ImprovementJson policy, {
  String stage = 'observing',
}) async {
  final scope = {
    'tenantId': 'default',
    'ownerActorId': improvementActor,
    'repository': {
      'owner': 'benniejoseph',
      'name': 'OmniAgentOS',
      'defaultBranch': 'main',
    },
    'baseRevision': improvementHex('a', 40),
  };
  final candidate = await sealImprovement('candidate', {
    'revision': improvementHex('b', 40),
    'workspaceSha256': improvementHex('2'),
    'diffSha256': improvementHex('3'),
    'changedFiles': [
      {
        'path': 'src/components/example.tsx',
        'beforeSha256': improvementHex('4'),
        'afterSha256': improvementHex('5'),
      },
    ],
    'changedLines': 4,
    'architectureImpact': 'minor',
  }, 'candidateSha256');
  final validation = await sealImprovement('validation', {
    'scope': scope,
    'policySha256': policy['policySha256'],
    'signalSha256': improvementHex('6'),
    'candidateSha256': candidate['candidateSha256'],
    'candidateRevision': candidate['revision'],
    'workspaceSha256': candidate['workspaceSha256'],
    'checks': [
      {
        'id': 'focused-one',
        'kind': 'focused_regression',
        'outcome': 'passed',
        'producerKind': 'command',
        'producerId': 'receipt-one',
        'candidateRevision': candidate['revision'],
        'workspaceSha256': candidate['workspaceSha256'],
        'evidenceSha256': improvementHex('7'),
        'declaredCases': 2,
        'executedCases': 2,
        'failedCases': 0,
        'completedAt': improvementStamp,
      },
    ],
    'baselineReproduction': {
      'revision': scope['baseRevision'],
      'producerId': 'baseline-receipt',
      'evidenceSha256': improvementHex('8'),
      'executedCases': 2,
      'failedCases': 1,
      'completedAt': improvementStamp,
    },
  }, 'validationSha256');
  final reviewed = {'review_required', 'ready_for_release'}.contains(stage);
  return {
    'id': improvementCycleId,
    'scope': scope,
    'policy': policy,
    'stage': stage,
    'revision': 2,
    'signal': null,
    'candidate': reviewed ? candidate : null,
    'validation': reviewed ? validation : null,
    'approval': null,
    'release': null,
    'releaseReceipt': null,
    'correctionsUsed': 0,
    'dailyReservationUsd': 10,
    'createdAt': improvementStamp,
    'updatedAt': improvementStamp,
    'configurationId': 'configuration-one',
    'projectId': 'project-one',
    'executionLeaseExpiresAt': improvementStamp,
    'spendUsd': 0,
    'usageState': 'known',
    'controllerHold': null,
    'phase': 'setup',
    'summary': 'Inspecting the application source.',
    'agentRuns': [],
    'classification': null,
    'approvalExpired': false,
    'approvalRenewalAvailable': false,
    'discardAvailable': false,
    'setupRetryAvailable': false,
    'releaseEligibility': 'automatic',
    'pullRequestUrl': reviewed
        ? 'https://github.com/benniejoseph/OmniAgentOS/pull/200'
        : null,
  };
}

ImprovementJson improvementSnapshot(
  ImprovementJson config, [
  List<ImprovementJson> cycles = const [],
]) => {
  'configurations': [config],
  'cycles': cycles,
  'github': {'configured': true, 'missing': []},
  'controller': {'status': 'not_connected'},
};
Future<ImprovementJson> improvementResponse(
  ImprovementJson data,
  String action,
  String key,
) async {
  final keyHash = (await Sha256().hash(utf8.encode('default\u0000$key'))).bytes
      .map((b) => b.toRadixString(16).padLeft(2, '0'))
      .join();
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': 'app.self_improvement.$action',
    'accessMode': 'mutation',
    'action': 'manage.workflow',
    'resourceType': 'self_improvement',
    'eventContract': 'self-improvement-events.v1',
    'authoritySha256': improvementHex('a'),
    'idempotencyKeySha256': keyHash,
    'outcomeSha256': await specialistSha(data),
    'resourceCount': 1,
    'occurredAt': improvementStamp,
  };
  return {
    ...data,
    'serviceReceipt': {
      ...receipt,
      'receiptSha256': await specialistSha(receipt),
    },
  };
}
