import 'package:flutter_test/flutter_test.dart';
import 'package:omniagent/features/projects/projects.dart';

void main() {
  test('project parses execution, tasks, artifacts, and progress', () {
    final project = Project.fromJson({
      'id': 'p1',
      'title': 'Ship mobile',
      'objective': 'Release it',
      'status': 'active',
      'autonomyMode': 'supervised',
      'executionStatus': 'waiting_approval',
      'taskBudget': 8,
      'tasksDispatched': 2,
      'maxParallelTasks': 2,
      'requireApproval': true,
      'tasks': [
        {'id': 't1', 'title': 'Build', 'status': 'done'},
        {'id': 't2', 'title': 'Verify', 'status': 'doing'},
      ],
      'artifacts': [
        {
          'id': 'a1',
          'taskId': 't1',
          'workflowRunId': 'w1',
          'status': 'verified',
          'evidenceRefs': ['source:1'],
        },
      ],
    });
    expect(project.activeExecution, isTrue);
    expect(project.completedTasks, 1);
    expect(project.progress, .5);
    expect(project.artifacts.single.verified, isTrue);
  });
}
