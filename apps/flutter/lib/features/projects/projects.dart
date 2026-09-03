import 'package:flutter/foundation.dart';

typedef Json = Map<String, dynamic>;

String _text(Object? value, [String fallback = '']) =>
    value == null ? fallback : value.toString();
DateTime? _date(Object? value) => DateTime.tryParse(_text(value));
List<String> _strings(Object? value) =>
    value is List ? value.map((e) => e.toString()).toList() : const [];

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
    this.dueAt,
    this.workflowRunId,
    this.workflowStatus,
    this.executionError,
  });
  final String id, title, detail, status, priority, agentId, origin;
  final int position, dispatchAttempt;
  final List<String> dependsOn;
  final DateTime? dueAt;
  final String? workflowRunId, workflowStatus, executionError;
  bool get done => status == 'done';
  bool get awaitingApproval => workflowStatus == 'waiting_approval';
  factory ProjectTask.fromJson(Json j) => ProjectTask(
    id: _text(j['id']),
    title: _text(j['title'], 'Untitled task'),
    detail: _text(j['detail']),
    status: _text(j['status'], 'open'),
    priority: _text(j['priority'], 'medium'),
    agentId: _text(j['agentId'], 'atlas'),
    origin: _text(j['origin'], 'manual'),
    position: (j['position'] as num?)?.toInt() ?? 0,
    dependsOn: _strings(j['dependsOn']),
    dispatchAttempt: (j['dispatchAttempt'] as num?)?.toInt() ?? 0,
    dueAt: _date(j['dueAt']),
    workflowRunId: j['workflowRunId']?.toString(),
    workflowStatus: j['workflowStatus']?.toString(),
    executionError: j['executionError']?.toString(),
  );
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
    this.verdict,
    this.lesson,
    this.memoryId,
  });
  final String id, taskId, workflowRunId, agentId, status, title, content;
  final List<String> evidenceRefs;
  final DateTime? createdAt;
  final String? verdict, lesson, memoryId;
  bool get verified => status == 'verified';
  factory ProjectArtifact.fromJson(Json j) => ProjectArtifact(
    id: _text(j['id']),
    taskId: _text(j['taskId']),
    workflowRunId: _text(j['workflowRunId']),
    agentId: _text(j['agentId'], 'atlas'),
    status: _text(j['status'], 'failed'),
    title: _text(j['title'], 'Artifact'),
    content: _text(j['content']),
    evidenceRefs: _strings(j['evidenceRefs']),
    createdAt: _date(j['createdAt']),
    verdict: j['verdict']?.toString(),
    lesson: j['lesson']?.toString(),
    memoryId: j['memoryId']?.toString(),
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
    this.targetDate,
    this.updatedAt,
  });
  final String id, title, objective, status, autonomyMode, executionStatus;
  final int taskBudget, tasksDispatched, maxParallelTasks;
  final bool requireApproval;
  final DateTime? targetDate, updatedAt;
  final List<ProjectTask> tasks;
  final List<ProjectArtifact> artifacts;
  int get completedTasks => tasks.where((t) => t.done).length;
  double get progress => tasks.isEmpty ? 0 : completedTasks / tasks.length;
  bool get activeExecution =>
      const {'running', 'waiting_approval'}.contains(executionStatus);
  factory Project.fromJson(Json j) => Project(
    id: _text(j['id']),
    title: _text(j['title'], 'Project'),
    objective: _text(j['objective']),
    status: _text(j['status'], 'draft'),
    autonomyMode: _text(j['autonomyMode'], 'manual'),
    executionStatus: _text(j['executionStatus'], 'idle'),
    taskBudget: (j['taskBudget'] as num?)?.toInt() ?? 12,
    tasksDispatched: (j['tasksDispatched'] as num?)?.toInt() ?? 0,
    maxParallelTasks: (j['maxParallelTasks'] as num?)?.toInt() ?? 1,
    requireApproval: j['requireApproval'] as bool? ?? true,
    targetDate: _date(j['targetDate']),
    updatedAt: _date(j['updatedAt']),
    tasks: ((j['tasks'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => ProjectTask.fromJson(Map<String, dynamic>.from(e)))
        .toList(),
    artifacts: ((j['artifacts'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => ProjectArtifact.fromJson(Map<String, dynamic>.from(e)))
        .toList(),
  );
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

class ProjectsController extends ChangeNotifier {
  ProjectsController(this.repository);
  final ProjectsRepository repository;
  List<Project> projects = const [];
  bool loading = false, acting = false;
  Object? error;
  Future<void> refresh() async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      projects = await repository.list();
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  void replace(Project project) {
    projects = projects.map((p) => p.id == project.id ? project : p).toList();
    notifyListeners();
  }

  Future<Project?> act(Future<Project> Function() action) async {
    acting = true;
    error = null;
    notifyListeners();
    try {
      final value = await action();
      replace(value);
      return value;
    } catch (e) {
      error = e;
      return null;
    } finally {
      acting = false;
      notifyListeners();
    }
  }

  Future<Project?> create({
    required String title,
    required String objective,
    DateTime? targetDate,
  }) async {
    acting = true;
    error = null;
    notifyListeners();
    try {
      final value = await repository.create(
        title: title,
        objective: objective,
        targetDate: targetDate,
      );
      projects = [value, ...projects];
      return value;
    } catch (e) {
      error = e;
      return null;
    } finally {
      acting = false;
      notifyListeners();
    }
  }
}
