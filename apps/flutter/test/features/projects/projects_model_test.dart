import 'package:asael/features/projects/projects.dart';
import 'package:flutter_test/flutter_test.dart';

import 'projects_fixture.dart';

void main() {
  test(
    'projects preserve execution, full tasks, artifact identity and evidence',
    () {
      final json = projectJson();
      json['executionStatus'] = 'waiting_approval';
      json['tasks'] = [
        taskJson(status: 'done'),
        taskJson(id: 'task:second', status: 'doing'),
      ];
      final project = Project.fromJson(json, requireCollections: true);
      expect(project.activeExecution, isTrue);
      expect(project.completedTasks, 1);
      expect(project.progress, .5);
      expect(project.artifacts.single.verified, isTrue);
      expect(
        project.artifacts.single.statusLabel,
        contains('outcome unverified'),
      );
      expect(project.artifacts.single.evidenceRefs, [
        'evidence:full/source+identity',
      ]);
    },
  );
  test('missing status, counts, identity and collections never become healthy defaults', () {
    for (final key in [
      'id',
      'tenantId',
      'status',
      'executionStatus',
      'taskBudget',
      'requireApproval',
      'tasks',
      'artifacts',
    ]) {
      final json = projectJson()..remove(key);
      expect(
        () => Project.fromJson(json, requireCollections: true),
        throwsFormatException,
        reason: key,
      );
    }
    final baseReceipt = projectJson()
      ..remove('tasks')
      ..remove('artifacts');
    expect(Project.fromJson(baseReceipt).collectionsLoaded, isFalse);
  });
  test(
    'wrong parent or tenant and duplicate child identities are rejected',
    () {
      final wrong = projectJson();
      wrong['tasks'] = [taskJson(parent: 'other-project')];
      expect(() => Project.fromJson(wrong), throwsFormatException);
      final duplicate = projectJson();
      duplicate['tasks'] = [taskJson(), taskJson()];
      expect(() => Project.fromJson(duplicate), throwsFormatException);
      final foreign = projectJson();
      foreign['artifacts'] = [
        {...artifactJson(), 'tenantId': 'other-tenant'},
      ];
      expect(() => Project.fromJson(foreign), throwsFormatException);
    },
  );
  test(
    'canonical cost and identity survive without upgrading legacy completion',
    () {
      final surface = surfaceJson();
      final task = ProjectTask.fromJson({
        ...taskJson(status: 'done'),
        'workItem': surface,
        'workItemStatus': surface['status'],
      });
      expect(task.outcomeLabel, 'Closed · unverified');
      expect(task.surface!.revision, 3);
      expect(task.surface!.agents.single['principalId'], 'principal:exact');
      expect(task.surface!.costLabel, r'$0.0125 known · partial');
      expect(task.group, 'Closed');
    },
  );
  test(
    'unknown live workflow cannot be manually advanced or described as idle',
    () {
      final task = ProjectTask.fromJson({
        ...taskJson(run: 'workflow:pending', workflowStatus: 'running'),
        'workItem': surfaceJson(run: 'workflow:pending'),
      });
      expect(task.currentWorkflowStatus, isNull);
      expect(task.executionLabel, 'Workflow status unavailable');
      expect(task.movementBlocked, isTrue);
    },
  );
  test(
    'malformed canonical identities and inconsistent counts fail closed',
    () {
      final wrong = surfaceJson();
      (wrong['status'] as Map)['workItemId'] = 'other-task';
      expect(
        () => ProjectTask.fromJson({...taskJson(), 'workItem': wrong}),
        throwsFormatException,
      );
      final badCost = surfaceJson();
      (badCost['cost'] as Map)['unknownCostReceiptCount'] = 3;
      expect(
        () => ProjectTask.fromJson({...taskJson(), 'workItem': badCost}),
        throwsFormatException,
      );
      final badState = surfaceJson();
      (badState['status'] as Map)['status'] = ['unverified'];
      expect(
        () => ProjectTask.fromJson({...taskJson(), 'workItem': badState}),
        throwsFormatException,
      );
    },
  );
}
