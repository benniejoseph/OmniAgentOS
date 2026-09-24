import 'package:flutter/foundation.dart';

typedef AgentLearningJson = Map<String, dynamic>;

/// Content-free projection of one Agent's most recent daily evidence review.
///
/// This deliberately contains lifecycle coordinates and counts only. Prompt,
/// response, correction, and private-reasoning content are not part of the
/// native contract.
@immutable
class AgentDailyLearningStatus {
  const AgentDailyLearningStatus({
    required this.agentId,
    required this.definitionVersion,
    required this.projectedAt,
    required this.availability,
    required this.latestCompletedDay,
    required this.pendingReviewedAdaptationCount,
  });

  final String agentId, projectedAt, availability;
  final int definitionVersion, pendingReviewedAdaptationCount;
  final AgentDailyLearningDay? latestCompletedDay;

  bool get available => availability == 'ready';

  factory AgentDailyLearningStatus.fromResponse(
    AgentLearningJson response, {
    required String expectedAgentId,
  }) {
    final raw = response['learning'];
    if (raw is! Map) {
      throw const FormatException(
        'The Daily learning service returned no verified projection.',
      );
    }
    final value = Map<String, dynamic>.from(raw);
    final schemaVersion = _requiredInt(value, 'schemaVersion');
    final version = _requiredText(value, 'version');
    final agentId = _requiredText(value, 'agentId');
    final definitionVersion = _requiredInt(value, 'definitionVersion');
    final projectedAt = _requiredTimestamp(value, 'projectedAt');
    final availability = _requiredText(value, 'availability');
    final pending = _requiredCount(value, 'pendingReviewedAdaptationCount');
    final contentIncluded = value['contentIncluded'];
    final privateReasoningIncluded = value['privateReasoningIncluded'];
    final authorityImpact = value['authorityImpact'];
    final day = value['latestCompletedDay'] == null
        ? null
        : AgentDailyLearningDay.fromJson(
            _requiredRecord(value, 'latestCompletedDay'),
          );

    if (schemaVersion != 1 ||
        version != 'agent-daily-learning-status:1' ||
        agentId != expectedAgentId ||
        definitionVersion < 1 ||
        !const {
          'ready',
          'canonical_store_unavailable',
        }.contains(availability) ||
        contentIncluded != false ||
        privateReasoningIncluded != false ||
        authorityImpact != 'none' ||
        (availability == 'canonical_store_unavailable' &&
            (day != null || pending != 0))) {
      throw const FormatException(
        'The Daily learning projection failed its content-free authority boundary.',
      );
    }
    return AgentDailyLearningStatus(
      agentId: agentId,
      definitionVersion: definitionVersion,
      projectedAt: projectedAt,
      availability: availability,
      latestCompletedDay: day,
      pendingReviewedAdaptationCount: pending,
    );
  }
}

@immutable
class AgentDailyLearningDay {
  const AgentDailyLearningDay({
    required this.localDate,
    required this.timezone,
    required this.completedAt,
    required this.observationsReviewed,
    required this.explicitCorrectionCount,
    required this.actionableEvidenceCount,
    required this.outcome,
  });

  final String localDate, timezone, completedAt, outcome;
  final int observationsReviewed,
      explicitCorrectionCount,
      actionableEvidenceCount;

  factory AgentDailyLearningDay.fromJson(AgentLearningJson value) {
    final localDate = _requiredText(value, 'localDate');
    final timezone = _requiredText(value, 'timezone');
    final outcome = _requiredText(value, 'outcome');
    final observations = _requiredCount(value, 'observationsReviewed');
    final corrections = _requiredCount(value, 'explicitCorrectionCount');
    final actionable = _requiredCount(value, 'actionableEvidenceCount');
    if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(localDate) ||
        timezone.length > 120 ||
        !const {
          'actionable_evidence_recorded',
          'no_actionable_evidence',
        }.contains(outcome) ||
        actionable > corrections ||
        corrections > observations ||
        (outcome == 'actionable_evidence_recorded') != (actionable > 0)) {
      throw const FormatException(
        'The Daily learning day contains inconsistent review evidence.',
      );
    }
    return AgentDailyLearningDay(
      localDate: localDate,
      timezone: timezone,
      completedAt: _requiredTimestamp(value, 'completedAt'),
      observationsReviewed: observations,
      explicitCorrectionCount: corrections,
      actionableEvidenceCount: actionable,
      outcome: outcome,
    );
  }
}

AgentLearningJson _requiredRecord(AgentLearningJson value, String key) {
  final raw = value[key];
  if (raw is! Map) {
    throw FormatException('Daily learning field $key is not an object.');
  }
  return Map<String, dynamic>.from(raw);
}

String _requiredText(AgentLearningJson value, String key) {
  final raw = value[key];
  if (raw is! String || raw.trim().isEmpty) {
    throw FormatException('Daily learning field $key is missing.');
  }
  return raw.trim();
}

String _requiredTimestamp(AgentLearningJson value, String key) {
  final raw = _requiredText(value, key);
  if (DateTime.tryParse(raw) == null) {
    throw FormatException('Daily learning field $key is not a timestamp.');
  }
  return raw;
}

int _requiredInt(AgentLearningJson value, String key) {
  final raw = value[key];
  if (raw is! int) {
    throw FormatException('Daily learning field $key is not an integer.');
  }
  return raw;
}

int _requiredCount(AgentLearningJson value, String key) {
  final count = _requiredInt(value, key);
  if (count < 0 || count > 10000) {
    throw FormatException('Daily learning field $key is out of bounds.');
  }
  return count;
}
