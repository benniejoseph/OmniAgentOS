import '../../core/network/api_client.dart';
import 'projects.dart';

class ApiProjectsRepository implements ProjectsRepository {
  const ApiProjectsRepository(this.api);
  final ApiClient api;
  String _id(String value) => Uri.encodeComponent(value);
  Project _project(Json json) =>
      Project.fromJson(Map<String, dynamic>.from(json['project'] as Map));
  @override
  Future<List<Project>> list() async {
    final j = await api.getJson('/api/projects');
    return ((j['projects'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => Project.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  @override
  Future<Project> detail(String id) async =>
      _project(await api.getJson('/api/projects/${_id(id)}'));
  @override
  Future<Project> create({
    required String title,
    required String objective,
    DateTime? targetDate,
  }) async => _project(
    await api.postJson(
      '/api/projects',
      data: {
        'title': title,
        'objective': objective,
        'status': 'active',
        if (targetDate != null)
          'targetDate': targetDate.toUtc().toIso8601String(),
      },
    ),
  );
  @override
  Future<Project> update(String id, Json changes) async =>
      _project(await api.patchJson('/api/projects/${_id(id)}', data: changes));
  @override
  Future<ProjectPlan> plan(String id, {String? context}) async {
    final j = await api.postJson(
      '/api/projects/${_id(id)}/plan',
      data: {
        if (context?.trim().isNotEmpty ?? false) 'context': context!.trim(),
      },
    );
    final p = Map<String, dynamic>.from(j['plan'] as Map);
    return ProjectPlan(
      p['rationale']?.toString() ?? '',
      ((p['tasks'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => ProjectTask.fromJson(Map<String, dynamic>.from(e)))
          .toList(),
    );
  }

  @override
  Future<ProjectTask> createTask(
    String id, {
    required String title,
    String detail = '',
    String priority = 'medium',
    String agentId = 'atlas',
  }) async {
    final j = await api.postJson(
      '/api/projects/${_id(id)}/tasks',
      data: {
        'title': title,
        'detail': detail,
        'priority': priority,
        'agentId': agentId,
      },
    );
    return ProjectTask.fromJson(Map<String, dynamic>.from(j['task'] as Map));
  }

  @override
  Future<ProjectTask> updateTask(String id, String taskId, Json changes) async {
    final j = await api.patchJson(
      '/api/projects/${_id(id)}/tasks/${_id(taskId)}',
      data: changes,
    );
    return ProjectTask.fromJson(Map<String, dynamic>.from(j['task'] as Map));
  }

  @override
  Future<Project> execute(
    String id,
    String action, {
    ExecutionConfig? config,
    String? taskId,
  }) async {
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
    final j = await api.postJson(
      '/api/projects/${_id(id)}/execution',
      data: body,
    );
    if (j['tasks'] is! List || j['artifacts'] is! List) return detail(id);
    return Project.fromJson({
      ...Map<String, dynamic>.from(j['project'] as Map),
      'tasks': j['tasks'],
      'artifacts': j['artifacts'],
    });
  }

  @override
  Future<ProjectArtifact> reflect(
    String id,
    String artifactId, {
    required String verdict,
    required String lesson,
  }) async {
    final j = await api.postJson(
      '/api/projects/${_id(id)}/artifacts/${_id(artifactId)}/feedback',
      data: {'verdict': verdict, 'lesson': lesson},
    );
    return ProjectArtifact.fromJson(
      Map<String, dynamic>.from(j['artifact'] as Map),
    );
  }
}
