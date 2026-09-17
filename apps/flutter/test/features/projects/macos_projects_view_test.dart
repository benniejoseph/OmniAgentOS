import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/projects/macos_projects_view.dart';
import 'package:asael/features/projects/projects.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _ProjectsRepository implements ProjectsRepository {
  _ProjectsRepository() : projects = [_borealis, _apollo];

  List<Project> projects;

  @override
  Future<List<Project>> list() async => projects;

  @override
  Future<Project> detail(String id) async =>
      projects.firstWhere((project) => project.id == id);

  @override
  Future<Project> create({
    required String title,
    required String objective,
    DateTime? targetDate,
  }) async {
    final project = Project(
      id: 'created',
      title: title,
      objective: objective,
      status: 'active',
      autonomyMode: 'supervised',
      executionStatus: 'idle',
      taskBudget: 12,
      tasksDispatched: 0,
      maxParallelTasks: 1,
      requireApproval: true,
      tasks: const [],
      artifacts: const [],
      targetDate: targetDate,
      updatedAt: DateTime.now(),
    );
    projects = [project, ...projects];
    return project;
  }

  @override
  Future<Project> update(String id, Json changes) async => detail(id);

  @override
  Future<ProjectPlan> plan(String id, {String? context}) async =>
      const ProjectPlan('', []);

  @override
  Future<ProjectTask> createTask(
    String id, {
    required String title,
    String detail = '',
    String priority = 'medium',
    String agentId = 'atlas',
  }) => throw UnimplementedError();

  @override
  Future<ProjectTask> updateTask(String id, String taskId, Json changes) =>
      throw UnimplementedError();

  @override
  Future<Project> execute(
    String id,
    String action, {
    ExecutionConfig? config,
    String? taskId,
  }) async => detail(id);

  @override
  Future<ProjectArtifact> reflect(
    String id,
    String artifactId, {
    required String verdict,
    required String lesson,
  }) => throw UnimplementedError();
}

final _borealis = Project(
  id: 'borealis',
  title: 'Borealis migration',
  objective: 'Move the owner workspace without losing durable state.',
  status: 'active',
  autonomyMode: 'supervised',
  executionStatus: 'waiting_approval',
  taskBudget: 12,
  tasksDispatched: 3,
  maxParallelTasks: 2,
  requireApproval: true,
  tasks: const [
    ProjectTask(
      id: 'task-b1',
      title: 'Review migration evidence',
      detail: '',
      status: 'doing',
      priority: 'high',
      agentId: 'sentinel',
      origin: 'plan',
      position: 0,
      dependsOn: [],
      dispatchAttempt: 1,
    ),
  ],
  artifacts: const [],
  updatedAt: DateTime(2026, 9, 17, 8),
);

final _apollo = Project(
  id: 'apollo',
  title: 'Apollo archive',
  objective: 'Index the accepted research and preserve its evidence.',
  status: 'active',
  autonomyMode: 'manual',
  executionStatus: 'idle',
  taskBudget: 8,
  tasksDispatched: 2,
  maxParallelTasks: 1,
  requireApproval: true,
  tasks: const [
    ProjectTask(
      id: 'task-a1',
      title: 'Index the research',
      detail: '',
      status: 'done',
      priority: 'medium',
      agentId: 'mnemosyne',
      origin: 'plan',
      position: 0,
      dependsOn: [],
      dispatchAttempt: 1,
    ),
  ],
  artifacts: const [],
  updatedAt: DateTime(2026, 9, 16, 8),
);

void main() {
  testWidgets('uses a searchable master-detail project workspace', (
    tester,
  ) async {
    await _useDesktopViewport(tester);
    final repository = _ProjectsRepository();
    final controller = ProjectsController(repository);
    await controller.refresh();
    Project? opened;

    await tester.pumpWidget(
      _app(
        MacosProjectsView(
          controller: controller,
          onOpen: (project) => opened = project,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Project and objective'), findsOneWidget);
    expect(find.byKey(const Key('macos-projects-inspector')), findsOneWidget);
    expect(find.byType(FloatingActionButton), findsNothing);
    expect(find.text(_borealis.objective), findsWidgets);

    await tester.tap(find.byKey(const Key('macos-project-row-apollo')));
    await tester.pump();
    expect(find.text(_apollo.objective), findsWidgets);
    await tester.tap(find.byKey(const Key('macos-project-open-apollo')));
    expect(opened?.id, 'apollo');

    await tester.enterText(
      find.byKey(const Key('macos-projects-search')),
      'Borealis',
    );
    await tester.pump();
    expect(find.byKey(const Key('macos-project-row-borealis')), findsOneWidget);
    expect(find.byKey(const Key('macos-project-row-apollo')), findsNothing);
  });

  testWidgets('exposes state filtering without replacing server truth', (
    tester,
  ) async {
    await _useDesktopViewport(tester);
    final repository = _ProjectsRepository();
    final controller = ProjectsController(repository);
    await controller.refresh();
    await tester.pumpWidget(
      _app(MacosProjectsView(controller: controller, onOpen: (_) {})),
    );

    await tester.tap(find.byKey(const Key('macos-projects-filter')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Needs attention').last);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('macos-project-row-borealis')), findsOneWidget);
    expect(find.byKey(const Key('macos-project-row-apollo')), findsNothing);
    expect(controller.projects, hasLength(2));
  });
}

Widget _app(Widget child) =>
    MaterialApp(theme: MacosAppTheme.light(), home: child);

Future<void> _useDesktopViewport(WidgetTester tester) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1440, 900);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
}
