import 'dart:collection';

import 'package:asael/features/projects/projects.dart';

const workStamp = '2026-10-04T12:00:00.000Z';
const projectId = 'project:synthetic/exact+identity';
const taskId = 'task:synthetic/exact+identity';
const artifactId = 'artifact:synthetic/exact+identity';

Json taskJson({
  String id = taskId,
  String parent = projectId,
  String status = 'open',
  String? workflowStatus,
  String? run,
}) => {
  'id': id,
  'tenantId': 'tenant-one',
  'projectId': parent,
  'title': 'Inspect exact evidence',
  'detail': 'Full task context <script> stays plain text.',
  'status': status,
  'priority': 'high',
  'agentId': 'sentinel',
  'origin': 'manual',
  'position': 0,
  'dependsOn': <String>[],
  'dispatchAttempt': 0,
  'createdAt': workStamp,
  'updatedAt': workStamp,
  'workflowRunId': ?run,
  'workflowStatus': ?workflowStatus,
};
Json artifactJson({String id = artifactId, String parent = projectId}) => {
  'id': id,
  'tenantId': 'tenant-one',
  'projectId': parent,
  'taskId': taskId,
  'workflowRunId': 'workflow:synthetic/exact+identity',
  'agentId': 'sentinel',
  'status': 'verified',
  'title': 'Exact native evidence',
  'content': 'The full source output remains available.',
  'evidenceRefs': ['evidence:full/source+identity'],
  'createdAt': workStamp,
  'updatedAt': workStamp,
};
Json projectJson({
  String id = projectId,
  String title = 'Synthetic native project',
}) => {
  'id': id,
  'tenantId': 'tenant-one',
  'actorId': 'actor-one',
  'title': title,
  'objective': 'Preserve exact work identity and evidence.',
  'status': 'active',
  'autonomyMode': 'supervised',
  'executionStatus': 'idle',
  'taskBudget': 12,
  'tasksDispatched': 0,
  'maxParallelTasks': 1,
  'requireApproval': true,
  'createdAt': workStamp,
  'updatedAt': workStamp,
  'tasks': [taskJson(parent: id)],
  'artifacts': [artifactJson(parent: id)],
};
Project fixtureProject({
  String id = projectId,
  String title = 'Synthetic native project',
}) => Project.fromJson(
  projectJson(id: id, title: title),
  requireCollections: true,
);
Json surfaceJson({
  String id = taskId,
  String parent = projectId,
  String? run,
  String? workflowStatus,
}) => {
  'version': 'p11.4-work-item-surface:1',
  'projection': {
    'authority': 'canonical_work_item_v1',
    'sha256': List.filled(64, 'a').join(),
    'sourceRevisionSha256': List.filled(64, 'b').join(),
  },
  'status': {
    'schemaVersion': 1,
    'authority': 'canonical_work_item_v1',
    'persistence': 'postgres',
    'workspaceId': 'workspace:exact',
    'projectId': parent,
    'workItemId': id,
    'kind': 'task',
    'sourceAuthority': 'legacy_project_task',
    'sourceId': id,
    'status': 'unverified',
    'sourceStatus': 'done',
    'statusRevision': 3,
    'updatedAt': workStamp,
  },
  'assignment': {
    'authority': 'canonical_work_item_v1',
    'agents': [
      {
        'agentId': 'sentinel',
        'principalId': 'principal:exact',
        'principalGeneration': 2,
      },
    ],
  },
  'artifacts': {
    'authority': 'canonical_work_item_v1',
    'count': 1,
    'items': [
      {
        'artifactId': artifactId,
        'kind': 'project_artifact',
        'evidenceCount': 1,
      },
    ],
  },
  'execution': {
    'authority': 'governed_workflow_v1',
    'availability': run == null
        ? 'not_started'
        : workflowStatus == null
        ? 'unavailable'
        : 'current',
    'workflowRunId': run,
    'sourceStatus': workflowStatus,
    'currentStep': null,
    'completedSteps': 0,
    'totalSteps': 0,
    'progressPercent': null,
    'updatedAt': null,
  },
  'cost': {
    'authority': 'ai_usage_ledger_v1',
    'state': 'partial',
    'usageReceiptCount': 2,
    'unknownCostReceiptCount': 1,
    'totalTokens': 1300,
    'knownEstimatedCostMicrousd': 12500,
  },
};

class WorkFixtureRepository
    implements ProjectsRepository, ScopedProjectsRepository {
  WorkFixtureRepository({ProjectAccess? authority})
    : access =
          authority ??
          ProjectAccess(
            tenantId: 'tenant-one',
            actorId: 'actor-one',
            role: 'operator',
          );
  @override
  final ProjectAccess access;
  final lists = Queue<Future<List<Project>>>(),
      details = Queue<Future<Project>>();
  // Create failures only when a read has attached its error handler.
  final detailErrors = Queue<Object>();
  Project current = fixtureProject();
  int writes = 0;
  Future<Project>? nextWrite;
  @override
  Future<List<Project>> list() =>
      lists.isEmpty ? Future.value([current]) : lists.removeFirst();
  @override
  Future<Project> detail(String id) {
    if (detailErrors.isNotEmpty) {
      return Future.error(detailErrors.removeFirst());
    }
    return details.isEmpty ? Future.value(current) : details.removeFirst();
  }

  @override
  Future<Project> create({
    required String title,
    required String objective,
    DateTime? targetDate,
  }) async {
    writes++;
    if (nextWrite != null) return await nextWrite!;
    return current;
  }

  @override
  Future<Project> update(String id, Json changes) async {
    writes++;
    if (nextWrite != null) return await nextWrite!;
    return current;
  }

  @override
  Future<ProjectPlan> plan(String id, {String? context}) async {
    writes++;
    return ProjectPlan(context ?? '', current.tasks);
  }

  @override
  Future<ProjectTask> createTask(
    String id, {
    required String title,
    String detail = '',
    String priority = 'medium',
    String agentId = 'atlas',
  }) async {
    writes++;
    return current.tasks.first;
  }

  @override
  Future<ProjectTask> updateTask(String id, String taskId, Json changes) async {
    writes++;
    return current.tasks.first;
  }

  @override
  Future<Project> execute(
    String id,
    String action, {
    ExecutionConfig? config,
    String? taskId,
  }) async {
    writes++;
    if (nextWrite != null) return await nextWrite!;
    return current;
  }

  @override
  Future<ProjectArtifact> reflect(
    String id,
    String artifactId, {
    required String verdict,
    required String lesson,
  }) async {
    writes++;
    return current.artifacts.first;
  }
}
