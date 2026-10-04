import 'package:asael/app/router/app_router.dart';
import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/builder/builder_providers.dart';
import 'package:asael/features/builder/native_builder_view.dart';
import 'package:asael/features/projects/projects.dart';
import 'package:asael/features/projects/project_workspaces.dart';
import 'package:asael/features/projects/projects_providers.dart';
import 'package:asael/features/projects/projects_view.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'features/projects/projects_fixture.dart';
import 'features/builder/builder_test_support.dart';

void main() {
  testWidgets(
    'Build deep link and tab return retain exact Work and artifact context without effects',
    (tester) async {
      final repository = _Repository(), api = _NoEffectsApi();
      final builder = TestBuilderRepository()..data = snapshotJson(empty: true);
      final query = <String, String>{
        'view': 'build',
        'artifact': artifactId,
        'workItemId': taskId,
      };
      final route =
          '/projects/${Uri.encodeComponent(projectId)}?${Uri(queryParameters: query).query}';
      final container = ProviderContainer(
        overrides: [
          sessionControllerProvider.overrideWith(_Sessions.new),
          appInitialLocationProvider.overrideWithValue(route),
          projectsRepositoryProvider.overrideWithValue(repository),
          apiClientProvider.overrideWithValue(api),
          builderRepositoryProvider(projectId).overrideWithValue(builder),
          builderRecoveryStoreProvider.overrideWithValue(TestRecoveryStore()),
          reconnectCoordinatorProvider.overrideWithValue(
            ReconnectCoordinator(() async => const [], const Stream.empty()),
          ),
        ],
      );
      addTearDown(container.dispose);
      await container.read(sessionControllerProvider.future);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );
      await tester.pumpAndSettle();
      final router = container.read(appRouterProvider);
      final view = tester.widget<ProjectDetailView>(
        find.byType(ProjectDetailView),
      );
      expect(view.id, projectId);
      expect(view.focusWorkItemId, taskId);
      expect(view.focusArtifactId, artifactId);
      expect(view.initiallyBuild, isTrue);
      expect(
        tester.widget<NativeBuilderView>(find.byType(NativeBuilderView)).active,
        isTrue,
      );
      expect(router.routeInformationProvider.value.uri.queryParameters, query);
      final retainedWorkState = tester.state(
        find.byType(ProjectDocumentWorkspace),
      );
      final tabs = find.byKey(const Key('macos-project-detail-tabs'));
      await tester.tap(find.descendant(of: tabs, matching: find.text('Plan')));
      await tester.pumpAndSettle();
      expect(router.routeInformationProvider.value.uri.queryParameters, {
        'workItemId': taskId,
      });
      expect(
        tester
            .widget<NativeBuilderView>(
              find.byType(NativeBuilderView, skipOffstage: false),
            )
            .active,
        isFalse,
      );
      expect(
        tester.state(find.byType(ProjectDocumentWorkspace)),
        same(retainedWorkState),
      );
      final readsWhileHidden = builder.reads;
      await tester.pump(const Duration(seconds: 3));
      expect(builder.reads, readsWhileHidden);
      await tester.tap(find.descendant(of: tabs, matching: find.text('Build')));
      await tester.pumpAndSettle();
      expect(router.routeInformationProvider.value.uri.queryParameters, query);
      expect(
        tester.state(find.byType(ProjectDocumentWorkspace)),
        same(retainedWorkState),
      );
      expect(builder.submissions, isEmpty);
      expect(repository.writes + api.effects, 0);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );
  test('Builder handoff keeps exact project, artifact and work selection with bounded queries', () {
    final route =
        '/projects/${Uri.encodeComponent(projectId)}?view=build&artifact=artifact%3Aone&workItemId=${Uri.encodeQueryComponent(taskId)}';
    expect(isSafeInitialAppLocation(route), isTrue);
    expect(initialAppLocation(['--asael-route=$route']), route);
    for (final invalid in [
      '$route&view=build',
      '$route&token=private',
      '$route#other',
      '/projects/project?view=build&artifact=../other',
      '/projects/project?view=other',
    ]) {
      expect(isSafeInitialAppLocation(invalid), isFalse, reason: invalid);
    }
  });
  for (final detail in [false, true]) {
    testWidgets(
      'mounted Work ${detail ? 'detail' : 'list'} follows repository and API replacement',
      (tester) async {
        final first = _Repository()
          ..current = fixtureProject(title: 'First owner project');
        final next = _Repository()
          ..current = fixtureProject(title: 'Replacement owner project');
        var current = first;
        var api = _NoEffectsApi();
        final container = ProviderContainer(
          overrides: [
            projectsRepositoryProvider.overrideWith((ref) => current),
            apiClientProvider.overrideWith((ref) => api),
            reconnectCoordinatorProvider.overrideWithValue(
              ReconnectCoordinator(() async => const [], const Stream.empty()),
            ),
          ],
        );
        addTearDown(container.dispose);
        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: MaterialApp(
              theme: AppTheme.light(),
              home: detail
                  ? const ProviderBoundProjectRoute(id: projectId)
                  : const ProviderBoundProjectsRoute(),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('First owner project'), findsWidgets);
        current = next;
        api = _NoEffectsApi();
        container.invalidate(projectsRepositoryProvider);
        container.invalidate(apiClientProvider);
        await tester.pumpAndSettle();
        expect(find.text('First owner project'), findsNothing);
        expect(find.text('Replacement owner project'), findsWidgets);
        if (detail) {
          expect(
            tester
                .widget<ProjectDetailView>(find.byType(ProjectDetailView))
                .api,
            same(api),
          );
        }
        expect(first.writes + next.writes + api.effects, 0);
        expect(tester.takeException(), isNull);
      },
      variant: TargetPlatformVariant.only(TargetPlatform.android),
    );
  }
  testWidgets(
    'actual Work route preserves the full project and selected work item',
    (tester) async {
      final repository = _Repository(), api = _NoEffectsApi();
      final route =
          '/projects/${Uri.encodeComponent(projectId)}?workItemId=${Uri.encodeQueryComponent(taskId)}';
      expect(isSafeInitialAppLocation(route), true);
      final container = ProviderContainer(
        overrides: [
          sessionControllerProvider.overrideWith(_Sessions.new),
          appInitialLocationProvider.overrideWithValue(route),
          projectsRepositoryProvider.overrideWithValue(repository),
          apiClientProvider.overrideWithValue(api),
          reconnectCoordinatorProvider.overrideWithValue(
            ReconnectCoordinator(() async => const [], const Stream.empty()),
          ),
        ],
      );
      addTearDown(container.dispose);
      await container.read(sessionControllerProvider.future);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );
      await tester.pumpAndSettle();
      expect(repository.requested, [projectId]);
      final view = tester.widget<ProjectDetailView>(
        find.byType(ProjectDetailView),
      );
      expect(view.id, projectId);
      expect(view.focusWorkItemId, taskId);
      expect(repository.writes + api.effects, 0);
      expect(tester.takeException(), isNull);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );
}

class _Repository extends WorkFixtureRepository {
  final requested = <String>[];
  @override
  Future<Project> detail(String id) {
    requested.add(id);
    return super.detail(id);
  }
}

class _RouterHarness extends ConsumerWidget {
  const _RouterHarness();
  @override
  Widget build(BuildContext context, WidgetRef ref) => MaterialApp.router(
    theme: AppTheme.light(),
    routerConfig: ref.watch(appRouterProvider),
  );
}

class _Sessions extends SessionController {
  @override
  Future<AppSession?> build() async => const AppSession(
    tenantId: 'tenant-one',
    actorId: 'actor-one',
    userId: 'user-one',
    email: 'one@example.test',
    displayName: 'One',
    workspaceName: 'Synthetic',
  );
}

class _NoEffectsApi extends ApiClient {
  _NoEffectsApi()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));
  int effects = 0;
  @override
  Future<Json> getJson(String path, {Map<String, dynamic>? query}) async {
    if (path == '/api/projects/${Uri.encodeComponent(projectId)}/builder' &&
        query == null) {
      return {'session': null};
    }
    throw StateError('Unexpected private read: $path');
  }

  @override
  Future<Json> postJson(String path, {Json? data, Json? headers}) async {
    effects++;
    throw StateError('No effect is permitted in this fixture');
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
