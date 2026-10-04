import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/projects/project_lifecycle.dart';
import 'package:asael/features/projects/projects.dart';
import 'package:flutter_test/flutter_test.dart';

import 'projects_fixture.dart';

Future<void> flush() => Future<void>.delayed(Duration.zero);
void main() {
  test(
    'latest collection read wins and failure retains its known snapshot',
    () async {
      final repository = WorkFixtureRepository(),
          older = Completer<List<Project>>();
      repository.lists.add(older.future);
      final c = ProjectsController(repository);
      addTearDown(c.dispose);
      final first = c.refresh();
      repository.lists.add(
        Future.value([fixtureProject(title: 'Newer current window')]),
      );
      await c.refresh();
      older.complete([fixtureProject(title: 'Old window')]);
      await first;
      expect(c.projects.single.title, 'Newer current window');
      repository.lists.add(
        Future.error(const ApiException('Synthetic read failure')),
      );
      await c.refresh();
      expect(c.loaded, isTrue);
      expect(c.fresh, isFalse);
      expect(c.projects.single.title, 'Newer current window');
      expect(c.readLabel, contains('Last-loaded'));
    },
  );
  test('disposed collection read does not publish or notify', () async {
    final repository = WorkFixtureRepository(),
        pending = Completer<List<Project>>();
    repository.lists.add(pending.future);
    final c = ProjectsController(repository);
    var notices = 0;
    c.addListener(() => notices++);
    final read = c.refresh();
    final before = notices;
    c.dispose();
    pending.complete([fixtureProject()]);
    await read;
    expect(notices, before);
    expect(c.projects, isEmpty);
  });
  test(
    'detail rejects another ID while retaining the current exact project',
    () async {
      final repository = WorkFixtureRepository();
      final detail = ProjectDetailController(repository, projectId);
      addTearDown(detail.dispose);
      await detail.refresh();
      repository.details.add(Future.value(fixtureProject(id: 'other-project')));
      await detail.refresh();
      expect(detail.project!.id, projectId);
      expect(detail.fresh, isFalse);
      expect(detail.readError, contains('selected project'));
    },
  );
  test(
    'accepted project update releases the action slot before failed follow-up',
    () async {
      final repository = WorkFixtureRepository();
      final detail = ProjectDetailController(repository, projectId);
      addTearDown(detail.dispose);
      await detail.refresh();
      final followup = Completer<Project>();
      repository.details.add(followup.future);
      final accepted = await detail.perform(
        'Complete project',
        () => repository.update(projectId, {'status': 'completed'}),
      );
      expect(accepted, isTrue);
      expect(detail.acting, isFalse);
      expect(detail.loading, isTrue);
      expect(detail.receipt!.resourceId, projectId);
      followup.completeError(
        const ApiException('Synthetic follow-up unavailable'),
      );
      await flush();
      expect(detail.receipt!.label, 'Complete project');
      expect(detail.readError, contains('Synthetic follow-up'));
      expect(detail.actionError, isNull);
      expect(detail.fresh, isFalse);
    },
  );
  test('one synchronous action slot prevents duplicate effects', () async {
    final repository = WorkFixtureRepository(), pending = Completer<Project>();
    repository.nextWrite = pending.future;
    final c = ProjectDetailController(repository, projectId);
    addTearDown(c.dispose);
    await c.refresh();
    final first = c.updateStatus('completed');
    expect(await c.updateStatus('completed'), isFalse);
    expect(repository.writes, 1);
    pending.complete(repository.current);
    expect(await first, isTrue);
    await flush();
  });
  test('same-owner session pause retains drafts; role replacement clears private state', () async {
    final repository = WorkFixtureRepository();
    final detail = ProjectDetailController(repository, projectId);
    addTearDown(detail.dispose);
    await detail.refresh();
    detail.edit(() {
      detail.planningContext = 'Unsaved planning context';
      detail.execution.budget = '17';
    });
    repository.access.update(available: false);
    expect(detail.planningContext, 'Unsaved planning context');
    expect(detail.execution.budget, '17');
    expect(detail.writable, isFalse);
    repository.access.update(
      tenant: 'tenant-one',
      actor: 'actor-one',
      nextRole: 'operator',
      available: true,
    );
    await flush();
    expect(detail.planningContext, 'Unsaved planning context');
    expect(detail.execution.budget, '17');
    final next = Completer<Project>();
    repository.details.add(next.future);
    repository.access.update(
      tenant: 'tenant-one',
      actor: 'actor-one',
      nextRole: 'viewer',
      available: true,
    );
    expect(detail.project, isNull);
    expect(detail.planningContext, isEmpty);
    expect(detail.receipt, isNull);
    next.complete(repository.current);
    await flush();
    expect(detail.writable, isFalse);
    expect(repository.writes, 0);
  });
  test(
    'old effect cannot publish into a new owner or begin its follow-up read',
    () async {
      final repository = WorkFixtureRepository(),
          pending = Completer<Project>();
      repository.nextWrite = pending.future;
      final c = ProjectDetailController(repository, projectId);
      addTearDown(c.dispose);
      await c.refresh();
      final first = c.updateStatus('completed');
      final next = Completer<Project>();
      repository.details.add(next.future);
      repository.access.update(
        tenant: 'tenant-two',
        actor: 'actor-two',
        nextRole: 'operator',
        available: true,
      );
      pending.complete(repository.current);
      expect(await first, isFalse);
      expect(c.receipt, isNull);
      expect(c.project, isNull);
      next.complete(repository.current);
      await flush();
      expect(c.project, isNull);
      expect(c.readError, isNotNull);
    },
  );
  test('execution source conflicts retain drafts and explicit review resolves only their binding', () {
    final draft = ProjectExecutionDraft();
    final p = fixtureProject();
    draft.observe(p);
    draft.budget = '17';
    final changed = projectJson()..['taskBudget'] = 20;
    draft.observe(Project.fromJson(changed));
    expect(draft.budget, '17');
    expect(draft.conflict, isTrue);
    draft.review();
    expect(draft.conflict, isFalse);
    expect(draft.dirty, isTrue);
    draft.budget = '51';
    expect(draft.config, isNull);
    draft.budget = '0';
    expect(draft.config, isNull);
    draft.budget = '2.5';
    expect(draft.config, isNull);
    draft.reset(p);
    expect(draft.config!.taskBudget, 12);
    expect(draft.dirty, isFalse);
  });
  test('reviewed version drift blocks a dialog submission without dropping its draft', () async {
    final repository = WorkFixtureRepository();
    final detail = ProjectDetailController(repository, projectId);
    addTearDown(detail.dispose);
    await detail.refresh();
    final reviewed = detail.project!.version;
    detail.taskTitle = 'Retained task';
    final changed = projectJson()..['updatedAt'] = '2026-10-04T13:00:00.000Z';
    repository.current = Project.fromJson(changed);
    await detail.refresh();
    expect(
      await detail.perform(
        'Create reviewed task',
        () => repository.createTask(projectId, title: detail.taskTitle),
        expectedVersion: reviewed,
      ),
      isFalse,
    );
    expect(detail.taskTitle, 'Retained task');
    expect(repository.writes, 0);
  });
}
