import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import 'project_contracts.dart';
import 'projects.dart';

class ProjectExecutionDraft {
  String mode = 'supervised', budget = '12', parallel = '1';
  bool approval = true;
  String? _basis, _observed;
  String get value => projectCanonical([mode, budget, parallel, approval]);
  bool get dirty => _basis != null && value != _basis;
  bool get conflict => _basis != null && _observed != _basis;
  String source(Project project) => projectCanonical([
    project.autonomyMode,
    '${project.taskBudget}',
    '${project.maxParallelTasks}',
    project.requireApproval,
  ]);
  void observe(Project project) {
    final next = source(project);
    if (_basis == null || !dirty) {
      reset(project);
      return;
    }
    _observed = next;
  }

  void reset(Project project) {
    mode = project.autonomyMode;
    budget = '${project.taskBudget}';
    parallel = '${project.maxParallelTasks}';
    approval = project.requireApproval;
    _basis = _observed = value;
  }

  void review() {
    _basis = _observed;
  }

  ExecutionConfig? get config {
    final count = int.tryParse(budget), lanes = int.tryParse(parallel);
    if (!const {'manual', 'supervised', 'autonomous'}.contains(mode) ||
        count == null ||
        lanes == null ||
        count < 1 ||
        count > 50 ||
        lanes < 1 ||
        lanes > 3) {
      return null;
    }
    return ExecutionConfig(
      autonomyMode: mode,
      taskBudget: count,
      maxParallelTasks: lanes,
      requireApproval: approval,
    );
  }
}

class ProjectResponse {
  const ProjectResponse(
    this.label,
    this.projectId,
    this.resourceId,
    this.detail,
    this.confirmedAt,
  );
  final String label, projectId, resourceId, detail;
  final DateTime confirmedAt;
}

class ProjectFeedbackDraft {
  ProjectFeedbackDraft({this.verdict = 'useful', this.lesson = ''});
  String verdict, lesson;
}

class ProjectDetailController extends ChangeNotifier {
  ProjectDetailController(this.repository, this.id) {
    _scope = access?.scope;
    access?.addListener(_authorityChanged);
  }
  final ProjectsRepository repository;
  final String id;
  ProjectAccess? get access => projectAccess(repository);
  Project? project;
  bool loading = false, fresh = false;
  String? action, readError, actionError;
  ProjectResponse? receipt;
  String planningContext = '',
      taskTitle = '',
      taskDetail = '',
      taskPriority = 'medium',
      taskAgent = 'atlas';
  final feedback = <String, ProjectFeedbackDraft>{};
  ProjectExecutionDraft execution = ProjectExecutionDraft();
  String? _scope;
  int _generation = 0;
  bool _disposed = false;
  CancelToken? _read;
  bool get readable => !_disposed && (access?.readable ?? true);
  bool get acting => action != null;
  bool get writable =>
      readable &&
      fresh &&
      !loading &&
      !acting &&
      (access == null ||
          access!.writable && project != null && access!.owns(project!));
  String? get blocked => !readable
      ? 'Work access is unavailable. Check your session.'
      : access != null && !access!.writable
      ? 'Operator permission and the current native Work capability are required.'
      : project != null && access != null && !access!.owns(project!)
      ? 'Retained-owner project · read only.'
      : acting
      ? 'A Work request is pending.'
      : !fresh || loading
      ? 'Refresh this project before changing last-loaded details.'
      : null;
  String get readLabel => loading
      ? project == null
            ? 'Loading project…'
            : 'Refreshing project. Last-loaded details and drafts are retained.'
      : !readable
      ? 'Project access is unavailable.'
      : readError != null
      ? project == null
            ? 'Project unavailable. Counts and outcomes are unknown.'
            : 'Project refresh unavailable. Last-loaded details are shown.'
      : fresh
      ? 'Current detail snapshot · up to 200 tasks and 200 artifacts.'
      : 'Project details have not been verified.';
  void edit(VoidCallback change) {
    if (_disposed || acting) return;
    change();
    notifyListeners();
  }

  void _authorityChanged() {
    _generation++;
    _read?.cancel('Project authority changed');
    loading = fresh = false;
    action = null;
    if (_scope != access?.scope || access?.closed == true) {
      _scope = access?.scope;
      project = null;
      receipt = null;
      readError = actionError = null;
      planningContext = taskTitle = taskDetail = '';
      taskPriority = 'medium';
      taskAgent = 'atlas';
      feedback.clear();
      execution = ProjectExecutionDraft();
    }
    if (!_disposed) notifyListeners();
    if (readable) unawaited(refresh());
  }

  Future<void> refresh() async {
    if (!readable || acting) return;
    final generation = ++_generation;
    _read?.cancel('Project read replaced');
    final cancel = _read = CancelToken();
    loading = true;
    fresh = false;
    readError = null;
    notifyListeners();
    bool current() =>
        readable && generation == _generation && !cancel.isCancelled;
    try {
      final source = repository;
      final value = source is FreshProjectsRepository
          ? await (source as FreshProjectsRepository).detailFresh(id, cancel)
          : await source.detail(id);
      projectRequire(
        value.id == id &&
            value.collectionsLoaded &&
            value.tasks.length <= 200 &&
            value.artifacts.length <= 200 &&
            (access == null || value.tenantId == access!.tenantId),
        'The project response did not match the selected project.',
      );
      if (current()) {
        project = value;
        execution.observe(value);
        fresh = true;
      }
    } catch (failure) {
      if (current()) {
        readError = projectFailure(failure);
        if (projectDenied(failure)) {
          project = null;
          receipt = null;
        }
      }
    } finally {
      if (current()) {
        loading = false;
        notifyListeners();
      }
    }
  }

  Future<bool> perform(
    String label,
    Future<Object> Function() request, {
    String? expectedVersion,
  }) async {
    if (!writable || project == null) {
      actionError = blocked;
      if (!_disposed) notifyListeners();
      return false;
    }
    if (expectedVersion != null && project!.version != expectedVersion) {
      actionError = 'This project changed while the form was open. Your draft is retained. Close and review the current project before submitting.';
      notifyListeners();
      return false;
    }
    final generation = ++_generation;
    _read?.cancel('Project action started');
    action = label;
    actionError = null;
    notifyListeners();
    bool current() => readable && generation == _generation;
    try {
      final result = await request();
      if (!current()) return false;
      String resourceId = id, detail;
      if (result is Project) {
        projectRequire(
          result.id == id && (access == null || access!.owns(result)),
        );
        detail = '${result.status} · ${result.executionStatus}';
        if (result.collectionsLoaded) {
          project = result;
          execution.observe(result);
        }
      } else if (result is ProjectTask) {
        projectRequire(
          (result.projectId.isEmpty || result.projectId == id) &&
              (access == null || result.tenantId == access!.tenantId),
        );
        resourceId = result.id;
        detail = '${result.title} · ${result.status}';
      } else if (result is ProjectArtifact) {
        projectRequire(
          (result.projectId.isEmpty || result.projectId == id) &&
              (access == null || result.tenantId == access!.tenantId),
        );
        resourceId = result.id;
        detail = '${result.title} · ${result.verdict ?? result.status}';
      } else if (result is ProjectPlan) {
        projectRequire(
          result.tasks.every(
            (task) =>
                (task.projectId.isEmpty || task.projectId == id) &&
                (access == null || task.tenantId == access!.tenantId),
          ),
        );
        detail = '${result.tasks.length} returned tasks. ${result.rationale}';
      } else {
        throw const FormatException('The Work response was incomplete.');
      }
      receipt = ProjectResponse(
        label,
        id,
        resourceId,
        detail,
        DateTime.now().toUtc(),
      );
      action = null;
      fresh = false;
      notifyListeners();
      // The accepted response stands independently of this later read.
      unawaited(refresh());
      return true;
    } catch (failure) {
      if (current()) {
        actionError =
            '${projectFailure(failure)} The requested outcome is unconfirmed. Refresh before repeating it.';
        fresh = false;
      }
      return false;
    } finally {
      if (!_disposed && generation == _generation) {
        action = null;
        notifyListeners();
      }
    }
  }

  Future<bool> updateStatus(String status) {
    final current = project;
    if (current == null) return Future.value(false);
    return perform(
      status == 'archived'
          ? 'Archive project'
          : status == 'active'
          ? 'Reopen project'
          : 'Complete project',
      () => repository.update(id, {'status': status}),
      expectedVersion: current.version,
    );
  }

  Future<bool> advance(ProjectTask task) {
    final current = project?.tasks
        .where((item) => item.id == task.id)
        .firstOrNull;
    if (project?.status != 'active' ||
        current == null ||
        current.status != task.status ||
        current.updatedAt != task.updatedAt ||
        current.movementBlocked) {
      return Future.value(false);
    }
    return perform(
      task.done ? 'Reopen ${task.title}' : 'Advance ${task.title}',
      () => repository.updateTask(id, task.id, {
        'status': task.done
            ? 'open'
            : task.status == 'open'
            ? 'doing'
            : 'done',
      }),
    );
  }

  Future<bool> control(
    String command, {
    ProjectTask? task,
    ExecutionConfig? config,
  }) {
    final p = project;
    if (p == null || p.status != 'active') return Future.value(false);
    if (task != null &&
        !p.tasks.any(
          (item) =>
              item.id == task.id &&
              item.updatedAt == task.updatedAt &&
              item.currentWorkflowStatus == task.currentWorkflowStatus,
        )) {
      return Future.value(false);
    }
    if (command == 'start' &&
            (p.activeExecution ||
                p.tasks.isEmpty ||
                config == null ||
                config.autonomyMode == 'manual' ||
                config.taskBudget <= p.tasksDispatched) ||
        command == 'pause' && p.executionStatus != 'running' ||
        command == 'resume' && p.executionStatus != 'paused' ||
        command == 'sync' && !p.activeExecution ||
        command == 'approve' && task?.awaitingApproval != true ||
        command == 'retry' && task?.retryable != true ||
        command == 'configure' && config == null) {
      return Future.value(false);
    }
    return perform(
      '${command[0].toUpperCase()}${command.substring(1)} ${task?.title ?? 'execution'}',
      () => repository.execute(id, command, taskId: task?.id, config: config),
    );
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _read?.cancel('Project closed');
    access?.removeListener(_authorityChanged);
    super.dispose();
  }
}
