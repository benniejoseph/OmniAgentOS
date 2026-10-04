import 'dart:async';

import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/builder/builder_providers.dart';
import 'package:asael/features/projects/project_workspaces.dart';
import 'package:asael/features/projects/projects.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'projects_fixture.dart';
import '../builder/builder_test_support.dart';

void main() {
  testWidgets(
    'failed initial detail reports unknown counts, then a successful empty snapshot',
    (tester) async {
      viewport(tester, const Size(390, 844));
      final repository = WorkFixtureRepository(), api = _NoEffectsApi();
      repository.detailErrors.add(
        const ApiException('Synthetic unavailable read'),
      );
      await mount(tester, document(repository, api));
      expect(
        find.text('Project unavailable. Counts and outcomes are unknown.'),
        findsOneWidget,
      );
      expect(find.textContaining('No tasks were returned'), findsNothing);
      expect(find.textContaining('tasks completed'), findsNothing);
      repository.current = Project.fromJson({
        ...projectJson(),
        'tasks': <Object>[],
        'artifacts': <Object>[],
      });
      await tap(tester, find.text('Retry project read'));
      expect(find.text('0 of 0 tasks completed'), findsOneWidget);
      expect(
        find.text(
          'No tasks were returned in this successful project snapshot.',
        ),
        findsOneWidget,
      );
      expect(api.effects, 0);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'execution drafts and selected artifact survive tabs and failed refresh',
    (tester) async {
      viewport(tester, const Size(1440, 1050));
      final repository = WorkFixtureRepository(), api = _NoEffectsApi();
      repository.current = Project.fromJson({
        ...projectJson(),
        'artifacts': [
          artifactJson(),
          {
            ...artifactJson(id: 'artifact:second/full+id'),
            'title': 'Second exact artifact',
            'content': 'Second complete result',
            'sourceMemoryId': 'source-memory:exact',
            'reflectionMemoryId': 'reflection-memory:exact',
          },
        ],
      });
      String? result;
      await mount(
        tester,
        document(repository, api, onInspect: (key) => result = key),
      );
      await tap(tester, find.text('Execution'));
      await tester.ensureVisible(field('Task budget'));
      await tester.enterText(field('Task budget'), '17');
      await tester.pump();
      await tap(tester, find.text('Artifacts'));
      await tap(
        tester,
        find.text('Second exact artifact\nartifact:second/full+id'),
      );
      expect(find.text('source-memory:exact'), findsOneWidget);
      expect(find.text('reflection-memory:exact'), findsOneWidget);
      await tap(tester, find.text('Inspect source workflow'));
      expect(result, 'workflow:workflow:synthetic/exact+identity');
      await tap(tester, find.text('Execution'));
      expect(
        tester.widget<TextField>(field('Task budget')).controller!.text,
        '17',
      );
      repository.detailErrors.add(
        const ApiException('Synthetic refresh unavailable'),
      );
      await tap(tester, find.byTooltip('Refresh project'));
      expect(
        tester.widget<TextField>(field('Task budget')).controller!.text,
        '17',
      );
      expect(
        find.text(
          'Project refresh unavailable. Last-loaded details are shown.',
        ),
        findsOneWidget,
      );
      expect(
        tester
            .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, 'Save execution settings'),
            )
            .onPressed,
        isNull,
      );
      await tap(tester, find.text('Artifacts'));
      expect(find.text('Second complete result'), findsOneWidget);
      expect(find.text('evidence:full/source+identity'), findsOneWidget);
      expect(api.effects, 0);
      expect(repository.writes, 0);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'closing retains task draft; owner-role replacement irreversibly hides an open form',
    (tester) async {
      viewport(tester, const Size(1440, 1050));
      final repository = WorkFixtureRepository(), api = _NoEffectsApi();
      await mount(tester, document(repository, api));
      await tap(tester, find.widgetWithText(OutlinedButton, 'Add task'));
      await tester.enterText(
        find.byKey(const Key('macos-project-task-title')),
        'Private retained task draft',
      );
      await tap(tester, find.text('Close'));
      await tap(tester, find.widgetWithText(OutlinedButton, 'Add task'));
      expect(
        tester
            .widget<TextField>(
              find.byKey(const Key('macos-project-task-title')),
            )
            .controller!
            .text,
        'Private retained task draft',
      );
      final held = Completer<Project>();
      repository.details.add(held.future);
      repository.access.update(
        tenant: 'tenant-one',
        actor: 'actor-one',
        nextRole: 'viewer',
        available: true,
      );
      // Both authority changes deliberately occur before a frame. A → B → A
      // must not revive a form bound to an earlier authority generation.
      repository.access.update(
        tenant: 'tenant-one',
        actor: 'actor-one',
        nextRole: 'operator',
        available: true,
      );
      held.complete(repository.current);
      await tester.pumpAndSettle();
      expect(find.text('Work access changed'), findsOneWidget);
      expect(find.byKey(const Key('macos-project-task-title')), findsNothing);
      expect(find.text('Private retained task draft'), findsNothing);
      await tap(tester, find.text('Close'));
      await tap(tester, find.widgetWithText(OutlinedButton, 'Add task'));
      expect(
        tester
            .widget<TextField>(
              find.byKey(const Key('macos-project-task-title')),
            )
            .controller!
            .text,
        isEmpty,
      );
      await tap(tester, find.text('Close'));
      expect(repository.writes, 0);
      expect(api.effects, 0);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'route identity replacement closes only its own old draft dialog',
    (tester) async {
      viewport(tester, const Size(1440, 1050));
      final repository = WorkFixtureRepository(), api = _NoEffectsApi();
      await mount(tester, document(repository, api));
      await tap(tester, find.widgetWithText(OutlinedButton, 'Add task'));
      await tester.enterText(
        find.byKey(const Key('macos-project-task-title')),
        'Old route draft',
      );
      repository.current = fixtureProject(
        id: 'project:second/identity',
        title: 'Second project',
      );
      await mount(
        tester,
        document(repository, api, id: 'project:second/identity'),
      );
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text('Second project'), findsOneWidget);
      expect(find.text('Old route draft'), findsNothing);
      expect(repository.writes, 0);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'an accepted update is shown separately while refresh fails and controls release',
    (tester) async {
      viewport(tester, const Size(1440, 1050));
      final repository = WorkFixtureRepository(), api = _NoEffectsApi();
      await mount(tester, document(repository, api));
      final write = Completer<Project>(), followup = Completer<Project>();
      repository.nextWrite = write.future;
      repository.details.add(followup.future);
      final complete = find.byKey(const Key('macos-project-toggle-complete'));
      await tester.ensureVisible(complete);
      await tester.tap(complete);
      await tester.pump();
      expect(tester.widget<OutlinedButton>(complete).onPressed, isNull);
      expect(repository.writes, 1);
      write.complete(
        Project.fromJson({...projectJson(), 'status': 'completed'}),
      );
      await tester.pump();
      expect(find.text('Complete project: response confirmed'), findsOneWidget);
      expect(find.textContaining('Complete project… Leaving'), findsNothing);
      followup.completeError(
        const ApiException('Follow-up failed after accepted response'),
      );
      await tester.pumpAndSettle();
      expect(find.text('Complete project: response confirmed'), findsOneWidget);
      expect(
        find.text('Follow-up failed after accepted response'),
        findsOneWidget,
      );
      expect(
        tester
            .widget<IconButton>(
              find.byKey(const Key('macos-project-detail-refresh')),
            )
            .onPressed,
        isNotNull,
      );
      expect(repository.writes, 1);
      expect(api.effects, 0);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'Build mounts its scoped controller and preserves the Work draft',
    (tester) async {
      viewport(tester, const Size(1440, 1050));
      final repository = WorkFixtureRepository(), api = _NoEffectsApi();
      final builder = TestBuilderRepository()..data = snapshotJson(empty: true);
      final container = ProviderContainer(
        overrides: [
          builderRepositoryProvider(projectId).overrideWithValue(builder),
          builderRecoveryStoreProvider.overrideWithValue(TestRecoveryStore()),
          reconnectCoordinatorProvider.overrideWithValue(
            ReconnectCoordinator(() async => const [], const Stream.empty()),
          ),
        ],
      );
      addTearDown(container.dispose);
      await mount(
        tester,
        UncontrolledProviderScope(
          container: container,
          child: document(repository, api),
        ),
      );
      await tester.ensureVisible(field('Planning context (optional)'));
      await tester.enterText(
        field('Planning context (optional)'),
        'Unsaved planning context',
      );
      await tap(tester, find.text('Build'));
      expect(builder.reads, 1);
      expect(builder.submissions, isEmpty);
      await tap(tester, find.text('Plan'));
      expect(
        tester
            .widget<TextField>(field('Planning context (optional)'))
            .controller!
            .text,
        'Unsaved planning context',
      );
      expect(api.effects, 0);
      expect(repository.writes, 0);
      expect(tester.takeException(), isNull);
    },
  );
  for (final dark in [false, true]) {
    testWidgets(
      '320px ${dark ? 'dark' : 'light'} Work reflows at 200% text with touch targets',
      (tester) async {
        viewport(tester, const Size(320, 900));
        final repository = WorkFixtureRepository(), api = _NoEffectsApi();
        final controller = ProjectsController(repository);
        addTearDown(controller.dispose);
        await controller.refresh();
        await mount(
          tester,
          ProjectCollectionWorkspace(controller: controller, onOpen: (_) {}),
          dark: dark,
          scale: 2,
        );
        expect(
          tester.getSize(find.byKey(const Key('macos-projects-create'))).height,
          greaterThanOrEqualTo(48),
        );
        expect(tester.takeException(), isNull);
        await mount(
          tester,
          document(repository, api, workItem: taskId),
          dark: dark,
          scale: 2,
        );
        await tester.scrollUntilVisible(
          find.text('Selected work item: $taskId'),
          300,
          scrollable: find
              .descendant(
                of: find.byType(ListView).first,
                matching: find.byType(Scrollable),
              )
              .first,
        );
        expect(find.text('Selected work item: $taskId'), findsOneWidget);
        await tap(tester, find.text('Execution'));
        await tester.scrollUntilVisible(
          field('Task budget'),
          300,
          scrollable: find
              .descendant(
                of: find.byType(ListView).first,
                matching: find.byType(Scrollable),
              )
              .first,
        );
        await tester.enterText(field('Task budget'), '51');
        await tester.pumpAndSettle();
        expect(
          find.text(
            'Enter a whole task budget from 1 to 50 and parallel-agent limit from 1 to 3.',
          ),
          findsOneWidget,
        );
        expect(
          tester
              .widget<FilledButton>(
                find.byKey(const Key('macos-project-execution-start')),
              )
              .onPressed,
          isNull,
        );
        expect(
          tester.getSize(field('Task budget')).height,
          greaterThanOrEqualTo(48),
        );
        expect(tester.takeException(), isNull);
        expect(api.effects, 0);
        expect(repository.writes, 0);
      },
    );
  }
}

Finder field(String label) => find.byWidgetPredicate(
  (widget) => widget is TextField && widget.decoration?.labelText == label,
);
ProjectDocumentWorkspace document(
  WorkFixtureRepository repository,
  ApiClient api, {
  String id = projectId,
  String? workItem,
  ValueChanged<String>? onInspect,
}) => ProjectDocumentWorkspace(
  id: id,
  repository: repository,
  api: api,
  focusWorkItemId: workItem,
  onInspectResult: onInspect,
);
void viewport(WidgetTester tester, Size size) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Future<void> mount(
  WidgetTester tester,
  Widget child, {
  bool dark = false,
  double scale = 1,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: dark
          ? AppTheme.dark(platform: TargetPlatform.android)
          : AppTheme.light(platform: TargetPlatform.android),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          textScaler: TextScaler.linear(scale),
          disableAnimations: true,
        ),
        child: child!,
      ),
      home: child,
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> tap(WidgetTester tester, Finder target) async {
  await tester.ensureVisible(target);
  await tester.tap(target);
  await tester.pumpAndSettle();
}

class _NoEffectsApi extends ApiClient {
  _NoEffectsApi()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));
  final reads = <String>[];
  int effects = 0;
  @override
  Future<Json> getJson(String path, {Map<String, dynamic>? query}) async {
    reads.add(path);
    if (path != '/api/projects/${Uri.encodeComponent(projectId)}/builder' ||
        query != null) {
      throw StateError('Unexpected private read: $path');
    }
    return {'session': null};
  }

  @override
  Future<Json> postJson(String path, {Json? data, Json? headers}) async {
    effects++;
    throw StateError('No effect is permitted in this widget fixture');
  }

  @override
  Future<Json> patchJson(String path, {Json? data, Json? headers}) =>
      postJson(path, data: data, headers: headers);
  @override
  Future<Json> putJson(String path, {Json? data, Json? headers}) =>
      postJson(path, data: data, headers: headers);
  @override
  Future<Json> deleteJson(
    String path, {
    Json? data,
    Json? query,
    Json? headers,
  }) => postJson(path, data: data, headers: headers);
}
