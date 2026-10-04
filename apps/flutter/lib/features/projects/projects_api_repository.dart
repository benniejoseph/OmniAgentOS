import 'dart:math';

import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'project_contracts.dart';
import 'projects.dart';

class ApiProjectsRepository
    implements
        ProjectsRepository,
        FreshProjectsRepository,
        ScopedProjectsRepository {
  ApiProjectsRepository(this.api, {ProjectAccess? access})
    : access = access ?? ProjectAccess(ready: false) {
    _scope = this.access.scope;
    _owner = projectCanonical([this.access.tenantId, this.access.actorId]);
    this.access.addListener(_changed);
  }
  final ApiClient api;
  @override
  final ProjectAccess access;
  final Map<String, Project> _seen = {};
  final Map<String, String> _uncertain = {};
  final Map<String, DateTime> _confirmedFloor = {};
  String? _scope, _owner;
  bool _acting = false;
  bool _disposed = false;
  void _changed() {
    final owner = projectCanonical([access.tenantId, access.actorId]);
    if (_owner != owner || access.closed) {
      _owner = owner;
      _uncertain.clear();
    }
    // Role changes invalidate visible/read authority, but a later exact retry
    // by this same owner must retain its existing uncertainty key.
    if (_scope != access.scope || access.closed) {
      _scope = access.scope;
      _seen.clear();
      _confirmedFloor.clear();
    }
  }

  void dispose() {
    _disposed = true;
    access.removeListener(_changed);
    _seen.clear();
    _uncertain.clear();
    _confirmedFloor.clear();
  }

  void _floor(String key, DateTime? at, {bool confirming = false}) {
    if (at == null) return;
    final before = _confirmedFloor[key];
    projectRequire(
      before == null || !at.isBefore(before),
      'This read predates a confirmed Work response. Last-loaded details are retained.',
    );
    if (confirming) _confirmedFloor[key] = at;
  }

  void _fresh(Project project) {
    _floor('project:${project.id}', project.updatedAt);
    for (final task in project.tasks) {
      _floor('task:${task.id}', task.updatedAt);
    }
    for (final artifact in project.artifacts) {
      _floor('artifact:${artifact.id}', artifact.updatedAt);
    }
  }

  void _readable() {
    if (_disposed || !access.readable) {
      throw StateError('Work access is unavailable. Reopen after signing in.');
    }
  }

  void _writable([String? id]) {
    _readable();
    if (!access.writable ||
        !NativeContract.supportsOperation('workspaces.update')) {
      throw StateError(
        'This session cannot change Work. The current native capability and operator permission are required.',
      );
    }
    if (id != null) {
      final project = _seen[id];
      if (project == null || !access.owns(project)) {
        throw StateError(
          'Refresh this exact project before changing it. Retained-owner projects are read only.',
        );
      }
    }
  }

  Project _project(
    Object? value, {
    String? id,
    bool collections = false,
    bool exactOwner = false,
  }) {
    final project = Project.fromJson(
      projectRecord(value),
      requireCollections: collections,
    );
    projectRequire(
      (id == null || project.id == id) &&
          project.tenantId == access.tenantId &&
          (!exactOwner || project.actorId == access.actorId),
      'The project response did not match the requested workspace and identity.',
    );
    return project;
  }

  Future<Json> _get(String path, CancelToken cancel) async {
    _readable();
    final generation = access.generation;
    final value = await api.getJsonFreshCancelable(path, cancelToken: cancel);
    projectRequire(
      !_disposed &&
          !cancel.isCancelled &&
          access.readable &&
          generation == access.generation,
      'The Work read belongs to a previous session or request.',
    );
    return value;
  }

  @override
  Future<List<Project>> list() => listFresh(CancelToken());
  @override
  Future<List<Project>> listFresh(CancelToken cancel) async {
    final json = await _get(NativePaths.workspacesList, cancel);
    final projects = projectRows(
      json['projects'],
      (row) => _project(row, collections: true),
      limit: 80,
    );
    projectUnique(projects.map((p) => p.id));
    for (final project in projects) {
      _fresh(project);
    }
    _seen
      ..clear()
      ..addEntries(projects.map((p) => MapEntry(p.id, p)));
    return projects;
  }

  @override
  Future<Project> detail(String id) => detailFresh(id, CancelToken());
  @override
  Future<Project> detailFresh(String id, CancelToken cancel) async {
    final json = await _get(NativePaths.workspacesGet(id), cancel);
    final project = _project(json['project'], id: id, collections: true);
    projectRequire(
      project.tasks.length <= 200 && project.artifacts.length <= 200,
    );
    _fresh(project);
    _seen[id] = project;
    return project;
  }

  Future<T> _write<T>(
    String path,
    String method,
    Json body,
    T Function(Json) parse, {
    String? projectId,
  }) async {
    _writable(projectId);
    if (_acting) {
      throw StateError(
        'Another Work request is pending. Wait for its response.',
      );
    }
    final frozen = projectRecord(_freeze(body));
    final fingerprint = projectCanonical([method, path, frozen]);
    if (!_uncertain.containsKey(fingerprint) && _uncertain.length >= 30) {
      throw StateError(
        'Too many Work outcomes are unconfirmed. Retry an exact existing request or verify its server result before starting another.',
      );
    }
    final key = _uncertain.putIfAbsent(
      fingerprint,
      () =>
          'native-work-${List.generate(24, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}',
    );
    final generation = access.generation;
    _acting = true;
    try {
      final headers = {'idempotency-key': key};
      final Json result = method == 'PATCH'
          ? await api.patchJson(path, data: frozen, headers: headers)
          : await api.postJson(path, data: frozen, headers: headers);
      projectRequire(
        !_disposed && access.readable && generation == access.generation,
        'This response belongs to a previous Work session. Its outcome must be checked from the current session.',
      );
      final parsed = parse(result);
      if (parsed is Project) {
        _floor('project:${parsed.id}', parsed.updatedAt, confirming: true);
        for (final task in parsed.tasks) {
          _floor('task:${task.id}', task.updatedAt, confirming: true);
        }
        for (final artifact in parsed.artifacts) {
          _floor(
            'artifact:${artifact.id}',
            artifact.updatedAt,
            confirming: true,
          );
        }
      }
      if (parsed is ProjectTask) {
        _floor('task:${parsed.id}', parsed.updatedAt, confirming: true);
      }
      if (parsed is ProjectArtifact) {
        _floor('artifact:${parsed.id}', parsed.updatedAt, confirming: true);
      }
      if (parsed is ProjectPlan) {
        for (final task in parsed.tasks) {
          _floor('task:${task.id}', task.updatedAt, confirming: true);
        }
      }
      _uncertain.remove(fingerprint);
      return parsed;
    } finally {
      _acting = false;
    }
  }

  static Object? _freeze(Object? value) => value is Map<String, dynamic>
      ? Map<String, dynamic>.unmodifiable(
          value.map((key, item) => MapEntry(key, _freeze(item))),
        )
      : value is List
      ? List.unmodifiable(value.map(_freeze))
      : value;
  @override
  Future<Project> create({
    required String title,
    required String objective,
    DateTime? targetDate,
  }) {
    final body = <String, dynamic>{
      'title': title,
      'objective': objective,
      'status': 'active',
      if (targetDate != null)
        'targetDate': targetDate.toUtc().toIso8601String(),
    };
    return _write(NativePaths.workspacesCreate, 'POST', body, (json) {
      final project = _project(
        json['project'],
        collections: true,
        exactOwner: true,
      );
      projectRequire(
        project.title == title &&
            project.objective == objective &&
            project.status == 'active' &&
            project.targetDate == targetDate?.toUtc(),
      );
      _seen[project.id] = project;
      return project;
    });
  }

  @override
  Future<Project> update(String id, Json changes) {
    final submitted = Map<String, dynamic>.unmodifiable(changes);
    return _write(NativePaths.workspacesUpdate(id), 'PATCH', submitted, (json) {
      final record = projectRecord(json['project']);
      final project = _project(record, id: id, exactOwner: true);
      projectRequire(
        submitted.entries.every(
          (entry) => entry.key == 'targetDate'
              ? project.targetDate ==
                    (entry.value == null ? null : projectDate(entry.value))
              : record[entry.key] == entry.value,
        ),
      );
      return project;
    }, projectId: id);
  }

  ProjectTask _task(Object? value, String id, {String? taskId}) {
    final task = ProjectTask.fromJson(projectRecord(value));
    projectRequire(
      task.tenantId == access.tenantId &&
          task.projectId == id &&
          (taskId == null || task.id == taskId),
    );
    return task;
  }

  @override
  Future<ProjectPlan> plan(String id, {String? context}) => _write(
    NativePaths.workspacesPlan(id),
    'POST',
    {if (context?.trim().isNotEmpty ?? false) 'context': context!.trim()},
    (json) {
      final plan = projectRecord(json['plan']);
      final tasks = projectRows(
        plan['tasks'],
        (task) => _task(task, id),
        limit: 200,
      );
      projectUnique(tasks.map((task) => task.id));
      return ProjectPlan(projectText(plan['rationale'], empty: true), tasks);
    },
    projectId: id,
  );
  @override
  Future<ProjectTask> createTask(
    String id, {
    required String title,
    String detail = '',
    String priority = 'medium',
    String agentId = 'atlas',
  }) => _write(
    NativePaths.workspacesTasksCreate(id),
    'POST',
    {
      'title': title,
      'detail': detail,
      'priority': priority,
      'agentId': agentId,
    },
    (json) {
      final task = _task(json['task'], id);
      projectRequire(
        task.title == title &&
            task.detail == detail &&
            task.priority == priority &&
            task.agentId == agentId,
      );
      return task;
    },
    projectId: id,
  );
  @override
  Future<ProjectTask> updateTask(String id, String taskId, Json changes) {
    final submitted = Map<String, dynamic>.unmodifiable(changes);
    return _write(
      NativePaths.workspacesTasksUpdate(id, taskId),
      'PATCH',
      submitted,
      (json) {
        final record = projectRecord(json['task']);
        final task = _task(record, id, taskId: taskId);
        projectRequire(
          submitted.entries.every(
            (entry) => entry.key == 'dueAt'
                ? task.dueAt ==
                      (entry.value == null ? null : projectDate(entry.value))
                : record[entry.key] == entry.value,
          ),
        );
        return task;
      },
      projectId: id,
    );
  }

  @override
  Future<Project> execute(
    String id,
    String action, {
    ExecutionConfig? config,
    String? taskId,
  }) {
    final body = <String, dynamic>{'action': action};
    if (action == 'start' || action == 'configure') {
      final c = config ?? const ExecutionConfig();
      body.addAll({
        'autonomyMode': c.autonomyMode,
        'taskBudget': c.taskBudget,
        'maxParallelTasks': c.maxParallelTasks,
        'requireApproval': c.requireApproval,
      });
    }
    if (taskId != null) body['taskId'] = taskId;
    return _write(NativePaths.workspacesExecute(id), 'POST', body, (json) {
      // Never turn a missing effect receipt into a successful follow-up GET.
      final project = _project(
        {
          ...projectRecord(json['project']),
          'tasks': json['tasks'],
          'artifacts': json['artifacts'],
        },
        id: id,
        collections: true,
        exactOwner: true,
      );
      if (action == 'start' || action == 'configure') {
        projectRequire(
          project.autonomyMode == body['autonomyMode'] &&
              project.taskBudget == body['taskBudget'] &&
              project.maxParallelTasks == body['maxParallelTasks'] &&
              project.requireApproval == body['requireApproval'],
        );
      }
      if (taskId != null) {
        projectRequire(project.tasks.any((task) => task.id == taskId));
      }
      return project;
    }, projectId: id);
  }

  @override
  Future<ProjectArtifact> reflect(
    String id,
    String artifactId, {
    required String verdict,
    required String lesson,
  }) => _write(
    NativePaths.workspacesArtifactsFeedback(id, artifactId),
    'POST',
    {'verdict': verdict, 'lesson': lesson},
    (json) {
      final artifact = ProjectArtifact.fromJson(
        projectRecord(json['artifact']),
      );
      projectRequire(
        artifact.id == artifactId &&
            artifact.projectId == id &&
            artifact.tenantId == access.tenantId &&
            artifact.verdict == verdict &&
            artifact.lesson == lesson,
      );
      return artifact;
    },
    projectId: id,
  );
}
