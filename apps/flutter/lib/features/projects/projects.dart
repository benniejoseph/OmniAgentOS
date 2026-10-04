import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'project_contracts.dart';

typedef Json = Map<String, dynamic>;

class ProjectTask {
  const ProjectTask({
    required this.id,
    required this.title,
    required this.detail,
    required this.status,
    required this.priority,
    required this.agentId,
    required this.origin,
    required this.position,
    required this.dependsOn,
    required this.dispatchAttempt,
    this.tenantId = '',
    this.projectId = '',
    this.dueAt,
    this.workflowRunId,
    this.workflowStatus,
    this.executionError,
    this.updatedAt,
    this.surface,
  });
  final String id,
      title,
      detail,
      status,
      priority,
      agentId,
      origin,
      tenantId,
      projectId;
  final int position, dispatchAttempt;
  final List<String> dependsOn;
  final DateTime? dueAt, updatedAt;
  final String? workflowRunId, workflowStatus, executionError;
  final ProjectWorkSurface? surface;
  bool get done => status == 'done';
  String? get currentWorkflowStatus =>
      surface == null ? workflowStatus : surface!.workflowStatus;
  bool get awaitingApproval => currentWorkflowStatus == 'waiting_approval';
  bool get retryable =>
      const {'failed', 'canceled'}.contains(currentWorkflowStatus);
  bool get movementBlocked =>
      workflowRunId != null &&
          !const {
            'completed',
            'failed',
            'canceled',
          }.contains(currentWorkflowStatus) ||
      const {
        'dispatching',
        'queued',
        'running',
        'paused',
        'waiting_approval',
      }.contains(currentWorkflowStatus);
  String get group => done
      ? 'Closed'
      : awaitingApproval ||
            retryable ||
            const {'blocked', 'partial'}.contains(surface?.canonicalStatus)
      ? 'Needs you'
      : status == 'doing' ||
            const {
              'dispatching',
              'queued',
              'running',
              'paused',
            }.contains(currentWorkflowStatus)
      ? 'Working'
      : 'Ready';
  String get outcomeLabel =>
      surface?.statusLabel ??
      (done ? 'Closed · outcome unverified' : 'Canonical status unavailable');
  String get executionLabel =>
      surface?.availability == 'unavailable' ||
          workflowRunId != null && currentWorkflowStatus == null
      ? 'Workflow status unavailable'
      : currentWorkflowStatus ?? 'Not started';
  factory ProjectTask.fromJson(Json j) {
    final id = projectText(j['id']), parent = projectText(j['projectId']);
    final surface = j['workItem'] == null
        ? null
        : ProjectWorkSurface.fromJson(
            projectRecord(j['workItem']),
            projectId: parent,
            taskId: id,
          );
    if (j['workItemStatus'] != null) {
      projectRequire(
        surface != null &&
            projectCanonical(j['workItemStatus']) ==
                projectCanonical(surface.raw['status']),
      );
    }
    final run = projectOptionalText(j['workflowRunId']);
    if (surface != null) projectRequire(surface.workflowRunId == run);
    return ProjectTask(
      id: id,
      projectId: parent,
      tenantId: projectText(j['tenantId']),
      title: projectText(j['title']),
      detail: projectText(j['detail'], empty: true),
      status: projectMember(j['status'], ['open', 'doing', 'done']),
      priority: projectMember(j['priority'], ['low', 'medium', 'high']),
      agentId: projectText(j['agentId']),
      origin: projectMember(j['origin'], ['manual', 'agent']),
      position: projectCount(j['position']),
      dependsOn: projectStrings(j['dependsOn']),
      dispatchAttempt: projectCount(j['dispatchAttempt']),
      dueAt: projectOptionalDate(j['dueAt']),
      workflowRunId: run,
      workflowStatus: j['workflowStatus'] == null
          ? null
          : projectMember(j['workflowStatus'], [
              'dispatching',
              'queued',
              'running',
              'waiting_approval',
              'paused',
              'completed',
              'failed',
              'canceled',
            ]),
      executionError: projectOptionalText(j['executionError']),
      updatedAt: projectDate(j['updatedAt']),
      surface: surface,
    );
  }
}

class ProjectArtifact {
  const ProjectArtifact({
    required this.id,
    required this.taskId,
    required this.workflowRunId,
    required this.agentId,
    required this.status,
    required this.title,
    required this.content,
    required this.evidenceRefs,
    required this.createdAt,
    this.tenantId = '',
    this.projectId = '',
    this.updatedAt,
    this.verdict,
    this.lesson,
    this.memoryId,
    this.sourceMemoryId,
    this.reflectionMemoryId,
  });
  final String id,
      taskId,
      workflowRunId,
      agentId,
      status,
      title,
      content,
      tenantId,
      projectId;
  final List<String> evidenceRefs;
  final DateTime? createdAt, updatedAt;
  final String? verdict, lesson, memoryId, sourceMemoryId, reflectionMemoryId;
  // This is the legacy artifact status, not proof of a verified run outcome.
  bool get verified => status == 'verified';
  String get statusLabel =>
      verified ? 'Stored artifact · outcome unverified' : 'Failed artifact';
  factory ProjectArtifact.fromJson(Json j) => ProjectArtifact(
    id: projectText(j['id']),
    tenantId: projectText(j['tenantId']),
    projectId: projectText(j['projectId']),
    taskId: projectText(j['taskId']),
    workflowRunId: projectText(j['workflowRunId']),
    agentId: projectText(j['agentId']),
    status: projectMember(j['status'], ['verified', 'failed']),
    title: projectText(j['title']),
    content: projectText(j['content'], empty: true),
    evidenceRefs: projectStrings(j['evidenceRefs']),
    createdAt: projectDate(j['createdAt']),
    updatedAt: projectDate(j['updatedAt']),
    verdict: j['verdict'] == null
        ? null
        : projectMember(j['verdict'], ['useful', 'needs_work']),
    lesson: projectOptionalText(j['lesson']),
    memoryId: projectOptionalText(j['memoryId']),
    sourceMemoryId: projectOptionalText(j['sourceMemoryId']),
    reflectionMemoryId: projectOptionalText(j['reflectionMemoryId']),
  );
}

class Project {
  const Project({
    required this.id,
    required this.title,
    required this.objective,
    required this.status,
    required this.autonomyMode,
    required this.executionStatus,
    required this.taskBudget,
    required this.tasksDispatched,
    required this.maxParallelTasks,
    required this.requireApproval,
    required this.tasks,
    required this.artifacts,
    this.tenantId = '',
    this.actorId = '',
    this.collectionsLoaded = true,
    this.targetDate,
    this.createdAt,
    this.updatedAt,
  });
  final String id,
      title,
      objective,
      status,
      autonomyMode,
      executionStatus,
      tenantId,
      actorId;
  final int taskBudget, tasksDispatched, maxParallelTasks;
  final bool requireApproval, collectionsLoaded;
  final DateTime? targetDate, createdAt, updatedAt;
  final List<ProjectTask> tasks;
  final List<ProjectArtifact> artifacts;
  int get completedTasks => tasks.where((t) => t.done).length;
  double get progress => tasks.isEmpty ? 0 : completedTasks / tasks.length;
  bool get activeExecution =>
      const {'running', 'waiting_approval'}.contains(executionStatus);
  String get version => projectCanonical([
    id,
    tenantId,
    actorId,
    updatedAt?.toIso8601String(),
    status,
    autonomyMode,
    executionStatus,
    taskBudget,
    tasksDispatched,
    maxParallelTasks,
    requireApproval,
    tasks
        .map(
          (t) => [
            t.id,
            t.updatedAt?.toIso8601String(),
            t.status,
            t.currentWorkflowStatus,
          ],
        )
        .toList(),
    artifacts
        .map((a) => [a.id, a.updatedAt?.toIso8601String(), a.verdict, a.lesson])
        .toList(),
  ]);
  factory Project.fromJson(Json j, {bool requireCollections = false}) {
    final id = projectText(j['id']), tenant = projectText(j['tenantId']);
    final loaded = j['tasks'] is List && j['artifacts'] is List;
    projectRequire(!requireCollections || loaded);
    final tasks = j['tasks'] == null
        ? <ProjectTask>[]
        : projectRows(j['tasks'], ProjectTask.fromJson);
    final artifacts = j['artifacts'] == null
        ? <ProjectArtifact>[]
        : projectRows(j['artifacts'], ProjectArtifact.fromJson);
    projectUnique(tasks.map((t) => t.id));
    projectUnique(artifacts.map((a) => a.id));
    projectRequire(
      tasks.every((t) => t.projectId == id && t.tenantId == tenant) &&
          artifacts.every((a) => a.projectId == id && a.tenantId == tenant),
    );
    return Project(
      id: id,
      tenantId: tenant,
      actorId: projectText(j['actorId']),
      title: projectText(j['title']),
      objective: projectText(j['objective']),
      status: projectMember(j['status'], [
        'draft',
        'active',
        'completed',
        'archived',
      ]),
      autonomyMode: projectMember(j['autonomyMode'], [
        'manual',
        'supervised',
        'autonomous',
      ]),
      executionStatus: projectMember(j['executionStatus'], [
        'idle',
        'running',
        'paused',
        'waiting_approval',
        'completed',
        'failed',
      ]),
      taskBudget: projectCount(j['taskBudget'], min: 1, max: 50),
      tasksDispatched: projectCount(j['tasksDispatched']),
      maxParallelTasks: projectCount(j['maxParallelTasks'], min: 1, max: 3),
      requireApproval: projectBool(j['requireApproval']),
      tasks: List.unmodifiable(tasks),
      artifacts: List.unmodifiable(artifacts),
      collectionsLoaded: loaded,
      targetDate: projectOptionalDate(j['targetDate']),
      createdAt: projectDate(j['createdAt']),
      updatedAt: projectDate(j['updatedAt']),
    );
  }
}

class ProjectPlan {
  const ProjectPlan(this.rationale, this.tasks);
  final String rationale;
  final List<ProjectTask> tasks;
}

class ExecutionConfig {
  const ExecutionConfig({
    this.autonomyMode = 'supervised',
    this.taskBudget = 12,
    this.maxParallelTasks = 1,
    this.requireApproval = true,
  });
  final String autonomyMode;
  final int taskBudget, maxParallelTasks;
  final bool requireApproval;
}

abstract interface class ProjectsRepository {
  Future<List<Project>> list();
  Future<Project> detail(String id);
  Future<Project> create({
    required String title,
    required String objective,
    DateTime? targetDate,
  });
  Future<Project> update(String id, Json changes);
  Future<ProjectPlan> plan(String id, {String? context});
  Future<ProjectTask> createTask(
    String id, {
    required String title,
    String detail,
    String priority,
    String agentId,
  });
  Future<ProjectTask> updateTask(String id, String taskId, Json changes);
  Future<Project> execute(
    String id,
    String action, {
    ExecutionConfig? config,
    String? taskId,
  });
  Future<ProjectArtifact> reflect(
    String id,
    String artifactId, {
    required String verdict,
    required String lesson,
  });
}

abstract interface class FreshProjectsRepository {
  Future<List<Project>> listFresh(CancelToken cancel);
  Future<Project> detailFresh(String id, CancelToken cancel);
}

abstract interface class ScopedProjectsRepository {
  ProjectAccess get access;
}

/// Session refresh pauses authority without inventing a new owner or dropping drafts.
class ProjectAccess extends ChangeNotifier {
  ProjectAccess({
    this.tenantId,
    this.actorId,
    this.role,
    this.ready = true,
    this.mutationsAvailable = true,
  });
  String? tenantId, actorId, role;
  bool ready, mutationsAvailable;
  bool closed = false;
  int generation = 0;
  String get scope => projectCanonical([tenantId, actorId, role]);
  bool get readable => ready && !closed;
  bool get writable =>
      readable &&
      mutationsAvailable &&
      const {'operator', 'admin', 'system', 'owner'}.contains(role);
  void update({
    String? tenant,
    String? actor,
    String? nextRole,
    required bool available,
    bool clear = false,
  }) {
    final previous = scope, wasReady = readable;
    if (available || clear) {
      tenantId = tenant;
      actorId = actor;
      role = nextRole;
    }
    ready = available;
    if (previous != scope || wasReady != readable) {
      generation++;
      notifyListeners();
    }
  }

  void close() {
    if (!closed) {
      closed = true;
      generation++;
      notifyListeners();
    }
  }

  bool owns(Project project) =>
      project.tenantId == tenantId && project.actorId == actorId;
}

ProjectAccess? projectAccess(ProjectsRepository repository) =>
    repository is ScopedProjectsRepository
    ? (repository as ScopedProjectsRepository).access
    : null;
String projectFailure(Object error) => error is ApiException
    ? error.message
    : error is FormatException
    ? error.message
    : error is StateError
    ? error.message.toString()
    : 'Work could not be checked. Refresh and try again.';
bool projectDenied(Object error) =>
    error is ApiException && const [401, 403].contains(error.statusCode);

class ProjectsController extends ChangeNotifier {
  ProjectsController(this.repository) {
    _scope = access?.scope;
    access?.addListener(_authorityChanged);
  }
  final ProjectsRepository repository;
  ProjectAccess? get access => projectAccess(repository);
  List<Project> projects = const [];
  bool loading = false, acting = false, loaded = false, fresh = false;
  Object? error;
  String? receipt;
  String createTitle = '', createObjective = '';
  String? _scope;
  bool _disposed = false;
  int _generation = 0;
  CancelToken? _read;
  bool get canRead => !_disposed && (access?.readable ?? true);
  bool get canCreate => canRead && !acting && (access?.writable ?? true);
  String get readLabel => loading
      ? loaded
            ? 'Refreshing Work. Last-loaded projects are retained.'
            : 'Loading Work…'
      : !canRead
      ? 'Work access is unavailable.'
      : error != null
      ? loaded
            ? 'Work refresh unavailable. Last-loaded projects are shown.'
            : 'Work is unavailable. Project counts are unknown.'
      : loaded
      ? 'Current bounded project snapshot · up to 80 projects.'
      : 'Work has not been checked.';
  void _authorityChanged() {
    _generation++;
    _read?.cancel('Work authority changed');
    loading = acting = fresh = false;
    if (_scope != access?.scope || access?.closed == true) {
      _scope = access?.scope;
      projects = const [];
      loaded = false;
      error = receipt = null;
      createTitle = createObjective = '';
    }
    if (!_disposed) notifyListeners();
    if (canRead) unawaited(refresh());
  }

  Future<void> refresh() async {
    if (!canRead || acting) return;
    final generation = ++_generation;
    _read?.cancel('Work read replaced');
    final cancel = _read = CancelToken();
    loading = true;
    fresh = false;
    error = null;
    notifyListeners();
    bool current() =>
        canRead && generation == _generation && !cancel.isCancelled;
    try {
      final source = repository;
      final value = source is FreshProjectsRepository
          ? await (source as FreshProjectsRepository).listFresh(cancel)
          : await source.list();
      projectRequire(
        value.length <= 80 &&
            value.every(
              (p) => access == null || p.tenantId == access!.tenantId,
            ),
      );
      projectUnique(value.map((p) => p.id));
      if (current()) {
        projects = List.unmodifiable(value);
        loaded = fresh = true;
      }
    } catch (failure) {
      if (current()) {
        error = failure;
        if (projectDenied(failure)) {
          projects = const [];
          loaded = false;
        }
      }
    } finally {
      if (current()) {
        loading = false;
        notifyListeners();
      }
    }
  }

  void replace(Project project) {
    if (!_disposed) {
      projects = projects.map((p) => p.id == project.id ? project : p).toList();
      notifyListeners();
    }
  }

  Future<Project?> act(Future<Project> Function() action) async {
    if (!canCreate) return null;
    final generation = ++_generation;
    _read?.cancel('Work action started');
    loading = false;
    acting = true;
    error = null;
    notifyListeners();
    try {
      final value = await action();
      if (!canRead || generation != _generation) return null;
      projectRequire(access == null || access!.owns(value));
      replace(value);
      receipt =
          'Response confirmed for ${value.id}. Current details require a fresh read.';
      fresh = false;
      return value;
    } catch (failure) {
      if (canRead && generation == _generation) error = failure;
      return null;
    } finally {
      if (!_disposed && generation == _generation) {
        acting = false;
        notifyListeners();
      }
    }
  }

  Future<Project?> create({
    required String title,
    required String objective,
    DateTime? targetDate,
  }) async {
    final value = await act(
      () => repository.create(
        title: title,
        objective: objective,
        targetDate: targetDate,
      ),
    );
    if (value != null && !_disposed) {
      projects = [
        value,
        ...projects.where((p) => p.id != value.id),
      ].take(80).toList();
      loaded = true;
      createTitle = createObjective = '';
      notifyListeners();
    }
    return value;
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _read?.cancel('Work closed');
    access?.removeListener(_authorityChanged);
    super.dispose();
  }
}
