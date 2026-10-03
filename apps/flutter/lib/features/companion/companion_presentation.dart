import 'dart:convert';

import 'companion_models.dart';

class CompanionWork {
  const CompanionWork(
    this.state,
    this.label,
    this.detail, {
    this.runId,
    this.completionIdentity,
  });
  final String state;
  final String label;
  final String detail;
  final String? runId;
  final String? completionIdentity;
}

const availableCompanion = CompanionWork(
  'available',
  'Available',
  'Ready for your next message.',
);

/// Display-only. Legacy stream completion and HTTP success never verify work.
CompanionWork companionWork({
  String? status,
  String? runId,
  Object? terminalReceipt,
}) {
  CompanionWork result(String state, String label, String detail) =>
      CompanionWork(state, label, detail, runId: runId);
  if (status == 'completed') {
    final identity = verifiedCompanionCompletion(terminalReceipt, runId);
    return identity == null
        ? result(
            'available',
            'Outcome unverified',
            'Work ended without a confirmed verified outcome.',
          )
        : CompanionWork(
            'completed',
            'Completed',
            'The recorded outcome is verified.',
            runId: runId,
            completionIdentity: identity,
          );
  }
  return switch (status) {
    'waiting_approval' => result(
      'needs_you',
      'Needs approval',
      'Review the exact governed action.',
    ),
    'waiting_clarification' || 'review' => result(
      'needs_you',
      'Needs your review',
      'Review the draft or requested clarification.',
    ),
    'queued' => result('working', 'Queued', 'Waiting to start.'),
    'running' ||
    'resuming' => result('working', 'Working', 'Work is in progress.'),
    'paused' => result('paused', 'Paused', 'Work is paused.'),
    'canceled' => result('paused', 'Canceled', 'The run was canceled.'),
    'failed' || 'blocked' => result(
      'blocked',
      'Needs attention',
      'Review the recorded failure and recovery controls.',
    ),
    'reconnecting' => result(
      'blocked',
      'Reconnecting',
      'The connection is recovering.',
    ),
    null =>
      runId == null
          ? availableCompanion
          : result(
              'blocked',
              'Status unavailable',
              'Current run status is unavailable.',
            ),
    _ => result(
      'blocked',
      'Status unavailable',
      'This status does not confirm a completed outcome.',
    ),
  };
}

CompanionWork companionForeground({
  required CompanionWork work,
  bool microphoneActive = false,
  bool playbackActive = false,
  bool speechPreparing = false,
}) => playbackActive
    ? const CompanionWork(
        'responding',
        'Responding',
        'Reply audio is playing. Use the playback controls to interrupt.',
      )
    : microphoneActive
    ? const CompanionWork(
        'listening',
        'Listening',
        'The microphone is open. Use the voice controls to stop or review.',
      )
    : speechPreparing
    ? const CompanionWork(
        'working',
        'Preparing reply audio',
        'Playback has not started.',
      )
    : work;

String companionEffectiveMotion(
  CompanionPreferences preferences,
  bool osReduced,
) => preferences.motion == 'off'
    ? 'off'
    : osReduced || preferences.motion == 'reduced'
    ? 'reduced'
    : 'full';

/// A strict success-only projection of TerminalReceiptV1. Other outcomes remain
/// unverified here; this presentation neither replaces nor grants run authority.
String? verifiedCompanionCompletion(Object? value, String? runId) {
  if (value is! Map || runId == null) return null;
  const fields = {
    'schemaVersion',
    'terminalReceiptId',
    'runId',
    'outcomeContractId',
    'source',
    'legacyStatus',
    'disposition',
    'executionMode',
    'verificationState',
    'reasonCode',
    'requirementResults',
    'requiredRequirementCount',
    'verifiedRequirementCount',
    'failedRequirementCount',
    'unverifiedRequirementCount',
    'usefulWorkUnitCount',
    'artifactReceiptIds',
    'effectReceiptIds',
    'verifierReceiptIds',
    'pendingApprovalIds',
    'blockingDependencyIds',
    'outputSha256',
  };
  bool id(Object? value) =>
      value is String &&
      value.length <= 240 &&
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$').hasMatch(value);
  bool ids(Object? value, int maximum) =>
      value is List &&
      value.length <= maximum &&
      value.every(id) &&
      value.toSet().length == value.length;
  if (value.length != fields.length ||
      !value.keys.every(fields.contains) ||
      value['schemaVersion'] != 1 ||
      value['runId'] != runId ||
      !id(runId) ||
      !id(value['terminalReceiptId']) ||
      !id(value['outcomeContractId']) ||
      value['source'] != 'outcome_evaluator' ||
      (value['legacyStatus'] != null &&
          !const {
            'waiting_approval',
            'completed',
            'failed',
            'canceled',
          }.contains(value['legacyStatus'])) ||
      value['disposition'] != 'succeeded' ||
      value['executionMode'] != 'live' ||
      value['verificationState'] != 'verified' ||
      value['reasonCode'] != 'all_requirements_verified') {
    return null;
  }
  for (final field in [
    'requiredRequirementCount',
    'verifiedRequirementCount',
    'failedRequirementCount',
    'unverifiedRequirementCount',
    'usefulWorkUnitCount',
  ]) {
    final count = value[field];
    if (count is! int || count < 0 || count > 1000000000) return null;
  }
  for (final field in [
    'artifactReceiptIds',
    'effectReceiptIds',
    'pendingApprovalIds',
    'blockingDependencyIds',
  ]) {
    if (!ids(value[field], 128)) return null;
  }
  if (!ids(value['verifierReceiptIds'], 384) ||
      (value['pendingApprovalIds'] as List).isNotEmpty ||
      (value['blockingDependencyIds'] as List).isNotEmpty) {
    return null;
  }
  final hash = value['outputSha256'];
  if (hash != null &&
      (hash is! String || !RegExp(r'^[a-f0-9]{64}$').hasMatch(hash))) {
    return null;
  }
  final rows = value['requirementResults'];
  if (rows is! List || rows.length > 384) return null;
  final seen = <String>{};
  var requiredCount = 0;
  const methods = {
    'deterministic',
    'provider_receipt',
    'read_after_write',
    'signed_evidence',
    'human_attestation',
  };
  const allMethods = {
    ...methods,
    'model_assertion',
    'generated_summary',
    'citation_id_match',
    'none',
    'unassessed',
  };
  const rowFields = {
    'requirementId',
    'requirementKind',
    'requirementLevel',
    'state',
    'verificationMethod',
    'verifierId',
    'verificationReceiptId',
  };
  for (final row in rows) {
    if (row is! Map ||
        row.length != rowFields.length ||
        !row.keys.every(rowFields.contains) ||
        !id(row['requirementId']) ||
        !seen.add(row['requirementId'] as String) ||
        !const {
          'criterion',
          'artifact',
          'effect',
        }.contains(row['requirementKind']) ||
        !const {'required', 'optional'}.contains(row['requirementLevel']) ||
        !const {
          'verified',
          'failed',
          'unverified',
          'not_assessed',
        }.contains(row['state']) ||
        !allMethods.contains(row['verificationMethod'])) {
      return null;
    }
    final verifier = row['verifierId'];
    final receipt = row['verificationReceiptId'];
    if ((verifier != null && !id(verifier)) ||
        (receipt != null && !id(receipt)) ||
        (receipt != null &&
            !(value['verifierReceiptIds'] as List).contains(receipt)) ||
        (row['state'] == 'verified' && (verifier == null || receipt == null))) {
      return null;
    }
    if (row['requirementLevel'] == 'required') {
      requiredCount++;
      if (row['state'] != 'verified' ||
          !methods.contains(row['verificationMethod'])) {
        return null;
      }
    }
  }
  if (requiredCount == 0 ||
      value['requiredRequirementCount'] != requiredCount ||
      value['verifiedRequirementCount'] != requiredCount ||
      value['failedRequirementCount'] != 0 ||
      value['unverifiedRequirementCount'] != 0) {
    return null;
  }
  return jsonEncode([runId, value['terminalReceiptId']]);
}

class CompanionReactionLedger {
  final _seen = <String>{};
  bool accept(CompanionWork work) =>
      work.state == 'completed' &&
      work.completionIdentity != null &&
      _seen.length < 128 &&
      _seen.add(work.completionIdentity!);
}

class CompanionHomeGate {
  int _epoch = 0;
  int capture() => _epoch;
  void invalidate() => _epoch++;
  bool current(int captured) => captured == _epoch;
}
