import 'dart:async';

import 'package:asael/features/companion/companion_controller.dart';
import 'package:asael/features/companion/companion_models.dart';
import 'package:dio/dio.dart';

const homeThread = '11111111-1111-4111-8111-111111111111';
const otherThread = '22222222-2222-4222-8222-222222222222';
const savedAt = '2026-10-04T12:00:00.000Z';

CompanionJson companionFixture({
  int revision = 0,
  CompanionPreferences preferences = const CompanionPreferences(),
  String? homeState,
  CompanionSubmission? submission,
  String outcome = 'saved',
}) {
  final state =
      homeState ??
      (preferences.preferredThreadId == null ? 'not_set' : 'available');
  final href = state == 'available'
      ? '/app/command?thread=${preferences.preferredThreadId}'
      : null;
  return {
    'schemaVersion': 1,
    'contract': companionContract,
    'snapshot': {
      'revision': revision,
      'persisted': revision > 0,
      'updatedAt': revision == 0 ? null : savedAt,
      'preferences': preferences.toJson(),
    },
    'home': {
      'state': state,
      'preferredThreadId': preferences.preferredThreadId,
      'href': href,
      'fallbackHref': '/app/command',
    },
    'destination': {
      'href': switch (preferences.defaultDestination) {
        'today' => '/app',
        'activity' => '/app/activity',
        'work' => '/app/projects',
        _ => href ?? '/app/command',
      },
      'state':
          preferences.defaultDestination == 'assistant' &&
              preferences.preferredThreadId != null &&
              href == null
          ? 'fallback'
          : 'configured',
    },
    if (submission != null)
      'mutation': {
        'outcome': outcome,
        'receiptId': 'companion:${'a' * 64}',
        'revision': submission.expectedRevision + 1,
        'savedAt': savedAt,
        'preferences': submission.submitted.toJson(),
      },
  };
}

class FakeCompanionRepository implements CompanionRepository {
  CompanionResponse response = CompanionResponse.fromJson(companionFixture());
  CompanionWritePolicy policy = const CompanionWritePolicy(
    active: true,
    reason: 'Enrolled fixture',
  );
  Completer<CompanionResponse>? heldRead;
  Completer<CompanionResponse>? heldSave;
  Object? readFailure;
  Object? saveFailure;
  int reads = 0;
  final submissions = <CompanionSubmission>[];
  final readCancels = <CancelToken>[];
  @override
  Future<CompanionResponse> read(CancelToken cancelToken) async {
    reads++;
    readCancels.add(cancelToken);
    if (readFailure != null) throw readFailure!;
    return heldRead == null ? response : heldRead!.future;
  }

  @override
  Future<CompanionWritePolicy> readPolicy(CancelToken cancelToken) async =>
      policy;
  @override
  Future<CompanionResponse> submit(CompanionSubmission submission) async {
    submissions.add(submission);
    if (saveFailure != null) throw saveFailure!;
    if (heldSave != null) return heldSave!.future;
    return CompanionResponse.fromJson(
      companionFixture(
        revision: submission.expectedRevision + 1,
        preferences: submission.submitted,
        submission: submission,
      ),
      submission: submission,
    );
  }

  @override
  Future<({List<CompanionConversation> threads, int omitted})> conversations(
    CancelToken cancelToken,
  ) async => (
    threads: const [
      CompanionConversation(
        homeThread,
        'Owned conversation',
        savedAt,
        'orchestrate',
      ),
    ],
    omitted: 0,
  );
}

Map<String, Object?> verifiedTerminalFixture({String runId = 'run:1'}) => {
  'schemaVersion': 1,
  'terminalReceiptId': 'receipt:1',
  'runId': runId,
  'outcomeContractId': 'outcome:1',
  'source': 'outcome_evaluator',
  'legacyStatus': null,
  'disposition': 'succeeded',
  'executionMode': 'live',
  'verificationState': 'verified',
  'reasonCode': 'all_requirements_verified',
  'requirementResults': [
    {
      'requirementId': 'requirement:1',
      'requirementKind': 'criterion',
      'requirementLevel': 'required',
      'state': 'verified',
      'verificationMethod': 'deterministic',
      'verifierId': 'verifier:1',
      'verificationReceiptId': 'verification:1',
    },
  ],
  'requiredRequirementCount': 1,
  'verifiedRequirementCount': 1,
  'failedRequirementCount': 0,
  'unverifiedRequirementCount': 0,
  'usefulWorkUnitCount': 1,
  'artifactReceiptIds': <String>[],
  'effectReceiptIds': <String>[],
  'verifierReceiptIds': ['verification:1'],
  'pendingApprovalIds': <String>[],
  'blockingDependencyIds': <String>[],
  'outputSha256': null,
};
