import 'dart:convert';

typedef ProjectJson = Map<String, dynamic>;

void projectRequire(
  bool condition, [
  String message = 'Work returned incomplete or conflicting metadata.',
]) {
  if (!condition) throw FormatException(message);
}

ProjectJson projectRecord(Object? value) {
  projectRequire(value is Map<String, dynamic>);
  return value as ProjectJson;
}

String projectText(Object? value, {bool empty = false}) {
  projectRequire(value is String && (empty || value.isNotEmpty));
  return value as String;
}

String? projectOptionalText(Object? value) =>
    value == null ? null : projectText(value);
String projectMember(Object? value, Iterable<String> choices) {
  projectRequire(value is String && choices.contains(value));
  return value as String;
}

int projectCount(Object? value, {int min = 0, int max = 9007199254740991}) {
  projectRequire(value is int && value >= min && value <= max);
  return value as int;
}

bool projectBool(Object? value) {
  projectRequire(value is bool);
  return value as bool;
}

DateTime projectDate(Object? value) {
  final date = DateTime.tryParse(projectText(value));
  projectRequire(date != null);
  return date!.toUtc();
}

DateTime? projectOptionalDate(Object? value) =>
    value == null ? null : projectDate(value);
List<T> projectRows<T>(
  Object? value,
  T Function(ProjectJson) parse, {
  int limit = 10000,
}) {
  projectRequire(value is List && value.length <= limit);
  return List.unmodifiable(
    (value as List).map((row) => parse(projectRecord(row))),
  );
}

List<String> projectStrings(Object? value, {int limit = 10000}) {
  projectRequire(value is List && value.length <= limit);
  return List.unmodifiable((value as List).map((item) => projectText(item)));
}

void projectUnique(Iterable<String> ids) =>
    projectRequire(ids.toSet().length == ids.length);
String projectCanonical(Object? value) {
  Object? sorted(Object? item) => item is Map
      ? {
          for (final key in (item.keys.cast<String>().toList()..sort()))
            key: sorted(item[key]),
        }
      : item is List
      ? item.map(sorted).toList()
      : item;
  return jsonEncode(sorted(value));
}

/// Display-only canonical WorkItem facts. These never authorize transitions.
class ProjectWorkSurface {
  ProjectWorkSurface.fromJson(
    ProjectJson value, {
    required String projectId,
    required String taskId,
  }) {
    projectRequire(value['version'] == 'p11.4-work-item-surface:1');
    final projection = projectRecord(value['projection']);
    final status = projectRecord(value['status']);
    final assignment = projectRecord(value['assignment']);
    final artifacts = projectRecord(value['artifacts']);
    final execution = projectRecord(value['execution']);
    final cost = projectRecord(value['cost']);
    for (final source in [projection, status, assignment, artifacts]) {
      projectRequire(source['authority'] == 'canonical_work_item_v1');
    }
    projectRequire(
      status['schemaVersion'] == 1 &&
          status['projectId'] == projectId &&
          status['workItemId'] == taskId &&
          status['sourceId'] == taskId &&
          status['sourceAuthority'] == 'legacy_project_task' &&
          status['kind'] == 'task',
    );
    persistence = projectMember(status['persistence'], [
      'postgres',
      'local_projection',
    ]);
    workspaceId = projectOptionalText(status['workspaceId']);
    canonicalStatus = projectMember(status['status'], [
      'preview',
      'running',
      'waiting',
      'blocked',
      'partial',
      'unverified',
      'failed',
      'canceled',
      'succeeded',
    ]);
    sourceStatus = projectText(status['sourceStatus']);
    revision = projectCount(status['statusRevision'], min: 1);
    updatedAt = projectDate(status['updatedAt']);
    projectionSha256 = _digest(projection['sha256']);
    sourceRevisionSha256 = _digest(projection['sourceRevisionSha256']);
    if (persistence == 'postgres') {
      projectRequire(
        workspaceId != null &&
            projectionSha256 != null &&
            sourceRevisionSha256 != null,
      );
    }
    agents = projectRows(assignment['agents'], (row) {
      projectText(row['agentId']);
      projectOptionalText(row['principalId']);
      if (row['principalGeneration'] != null) {
        projectCount(row['principalGeneration'], min: 1);
      }
      return Map<String, dynamic>.unmodifiable(row);
    }, limit: 32);
    artifactMetadata = projectRows(artifacts['items'], (row) {
      projectText(row['artifactId']);
      projectText(row['kind']);
      projectCount(row['evidenceCount'], max: 128);
      return Map<String, dynamic>.unmodifiable(row);
    }, limit: 256);
    projectRequire(
      projectCount(artifacts['count'], max: 256) == artifactMetadata.length,
    );
    projectUnique(artifactMetadata.map((row) => row['artifactId'] as String));
    projectRequire(execution['authority'] == 'governed_workflow_v1');
    availability = projectMember(execution['availability'], [
      'not_started',
      'current',
      'unavailable',
    ]);
    workflowRunId = projectOptionalText(execution['workflowRunId']);
    workflowStatus = execution['sourceStatus'] == null
        ? null
        : projectMember(execution['sourceStatus'], [
            'queued',
            'running',
            'waiting_approval',
            'paused',
            'completed',
            'failed',
            'canceled',
          ]);
    currentStep = projectOptionalText(execution['currentStep']);
    completedSteps = projectCount(execution['completedSteps']);
    totalSteps = projectCount(execution['totalSteps']);
    progressPercent = execution['progressPercent'] == null
        ? null
        : projectCount(execution['progressPercent'], max: 100);
    executionUpdatedAt = projectOptionalDate(execution['updatedAt']);
    projectRequire(
      completedSteps <= totalSteps &&
          (availability != 'not_started' || workflowRunId == null),
    );
    projectRequire(cost['authority'] == 'ai_usage_ledger_v1');
    costState = projectMember(cost['state'], [
      'not_recorded',
      'known',
      'partial',
      'unknown',
    ]);
    usageReceiptCount = projectCount(cost['usageReceiptCount']);
    unknownCostReceiptCount = projectCount(cost['unknownCostReceiptCount']);
    totalTokens = projectCount(cost['totalTokens']);
    knownEstimatedCostMicrousd = projectCount(
      cost['knownEstimatedCostMicrousd'],
    );
    projectRequire(
      unknownCostReceiptCount <= usageReceiptCount &&
          (costState != 'not_recorded' || usageReceiptCount == 0),
    );
    raw = Map<String, dynamic>.unmodifiable(value);
  }
  late final String persistence,
      canonicalStatus,
      sourceStatus,
      availability,
      costState;
  late final String? workspaceId,
      projectionSha256,
      sourceRevisionSha256,
      workflowRunId,
      workflowStatus,
      currentStep;
  late final int revision,
      completedSteps,
      totalSteps,
      usageReceiptCount,
      unknownCostReceiptCount,
      totalTokens,
      knownEstimatedCostMicrousd;
  late final int? progressPercent;
  late final DateTime updatedAt;
  late final DateTime? executionUpdatedAt;
  late final List<ProjectJson> agents, artifactMetadata;
  late final ProjectJson raw;
  String get statusLabel => switch (canonicalStatus) {
    'preview' => 'Draft',
    'waiting' => 'Waiting',
    'running' => 'Running',
    'blocked' => 'Blocked',
    'partial' => 'Partial',
    'unverified' => 'Closed · unverified',
    'failed' => 'Failed',
    'canceled' => 'Canceled',
    'succeeded' => 'Verified success',
    _ => 'Unavailable',
  };
  String get costLabel {
    if (costState == 'not_recorded') return 'No recorded AI cost';
    if (costState == 'unknown') return 'Cost unavailable';
    final amount = (knownEstimatedCostMicrousd / 1000000).toStringAsFixed(4);
    return '\$$amount ${costState == 'partial' ? 'known · partial' : 'estimated'}';
  }

  static String? _digest(Object? value) {
    if (value == null) return null;
    projectRequire(
      value is String && RegExp(r'^[a-f0-9]{64}$').hasMatch(value),
    );
    return value as String;
  }
}
