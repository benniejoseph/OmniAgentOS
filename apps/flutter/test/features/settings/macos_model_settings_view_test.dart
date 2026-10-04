import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/platform/local_computer_bridge.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/computer_use/local_computer.dart';
import 'package:asael/features/companion/companion_providers.dart';
import 'package:asael/features/results/created_file_export.dart';
import 'package:asael/features/settings/model_settings_view.dart';
import 'package:asael/features/settings/portable_archive_controller.dart';
import 'package:asael/features/settings/portable_archive_panel.dart';
import 'package:asael/features/settings/portable_archive_providers.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../native_workspace_fixture.dart';
import '../companion/companion_fixtures.dart';
import '../portable_archive/portable_archive_test_support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Settings uses Mac categories and configuration inspector', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    FlutterSecureStorage.setMockInitialValues({});
    tester.view.physicalSize = const Size(1440, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final coordinator = LocalComputerCoordinator(
      repository: _ComputerRepository(),
      host: _ComputerHost(),
      windowContext: const LocalComputerWindowContext(
        role: LocalComputerWindowRole.primary,
      ),
      authenticated: false,
    );
    addTearDown(coordinator.dispose);
    final api = _SettingsApi();

    await tester.pumpWidget(
      nativeWorkspaceFixture(
        api: api,
        child: ProviderScope(
          overrides: [
            companionScopeProvider.overrideWithValue((
              deployment: nativeWorkspaceFixtureOrigin,
              tenantId: 'tenant-test',
              actorId: 'owner@example.com',
              role: 'admin',
            )),
            companionRepositoryProvider.overrideWith(
              (_) => FakeCompanionRepository(),
            ),
            localComputerCoordinatorProvider.overrideWith((ref) => coordinator),
          ],
          child: MaterialApp(
            theme: MacosAppTheme.light(),
            home: ModelSettingsView(api: api),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Settings'), findsOneWidget);
    expect(find.byKey(const ValueKey('companion-settings')), findsOneWidget);
    expect(find.text('Models & roles'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('macos-settings-inspector')),
      findsOneWidget,
    );

    await tester.tap(find.text('Models & roles'));
    await tester.pumpAndSettle();
    expect(find.text('Model routes'), findsOneWidget);
    expect(find.text('Main Agent'), findsOneWidget);

    await tester.tap(find.text('This Mac'));
    await tester.pumpAndSettle();
    expect(find.text('Computer use on this Mac'), findsOneWidget);
    expect(tester.takeException(), isNull);
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets(
    'switching Settings category fences an open archive chooser in the first transition frame',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({});
      // Keep the archive mounted below Companion without dragging the lazy
      // General list through unrelated panel lifetimes.
      tester.view.physicalSize = const Size(1440, 1800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final coordinator = LocalComputerCoordinator(
        repository: _ComputerRepository(),
        host: _ComputerHost(),
        windowContext: const LocalComputerWindowContext(
          role: LocalComputerWindowRole.primary,
        ),
        authenticated: false,
      );
      addTearDown(coordinator.dispose);
      final api = _SettingsApi(), adapter = PortableArchiveTestAdapter();
      final container = ProviderContainer(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          sessionControllerProvider.overrideWith(
            PortableArchiveTestSessions.new,
          ),
          biometricSessionLockControllerProvider.overrideWith(
            (_) => PortableArchiveTestLock(),
          ),
          companionScopeProvider.overrideWithValue((
            deployment: nativeWorkspaceFixtureOrigin,
            tenantId: portableArchiveTenant,
            actorId: portableArchiveActor,
            role: 'admin',
          )),
          companionRepositoryProvider.overrideWith(
            (_) => FakeCompanionRepository(),
          ),
          localComputerCoordinatorProvider.overrideWith((ref) => coordinator),
          portableArchiveControllerProvider.overrideWith((ref, visibility) {
            final controller = PortableArchiveController(
              PortableArchiveTestRepository(),
              exporter: ScopedCreatedFileExporter(adapter: adapter),
              verifier: PortableArchiveTestVerifier(),
            );
            ref.onDispose(controller.dispose);
            return controller;
          }),
        ],
      );
      addTearDown(container.dispose);
      await container.read(sessionControllerProvider.future);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: MacosAppTheme.light(),
            home: ModelSettingsView(api: api),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final general = find.byKey(const ValueKey('macos-settings-general'));
      final panel = find.descendant(
        of: general,
        matching: find.byType(PortableArchivePanel),
      );
      expect(general, findsOneWidget);
      expect(panel, findsOneWidget);
      final generalElement = tester.element(general),
          panelElement = tester.element(panel);
      final mountedView = tester.widget<PortableArchivePanelView>(
        find.descendant(
          of: panel,
          matching: find.byType(PortableArchivePanelView),
        ),
      );
      final controller = mountedView.controller,
          repository = controller.repository as PortableArchiveTestRepository,
          verifier = controller.verifier as PortableArchiveTestVerifier;
      expect(controller.available, isTrue);
      expect(controller.phase, PortableArchivePhase.idle);
      expect(TickerMode.valuesOf(panelElement).enabled, isTrue);
      expect(adapter.destinations, isEmpty);
      expect(repository.requests, isEmpty);
      // Button interaction is covered by the panel tests. Start only after the
      // actual Settings panel has attached this controller to its lifetime.
      final pending = controller.verifyAndSave();
      await tester.pump();
      expect(controller.phase, PortableArchivePhase.choosingDestination);
      expect(adapter.destinations, hasLength(1));
      expect(repository.requests, isEmpty);

      await tester.tap(find.text('Models & roles'));
      // No elapsed duration: the outgoing General child is still mounted in
      // the 140 ms transition, but it must already have lost export authority.
      await tester.pump();
      expect(general, findsOneWidget);
      expect(tester.element(general), same(generalElement));
      expect(panelElement.mounted, isTrue);
      expect(TickerMode.valuesOf(panelElement).enabled, isFalse);
      expect(find.text('Model routes'), findsOneWidget);
      expect(controller.available, isFalse);
      expect(controller.receipt, isNull);
      expect(controller.busy, isFalse);

      adapter.destinations.single.complete('/chosen/archive.json');
      await tester.pump();
      await pending;
      expect(repository.requests, isEmpty);
      expect(verifier.calls, isEmpty);
      expect(adapter.writeCalls, 0);
      expect(adapter.writes, isEmpty);
      expect(controller.receipt, isNull);
      expect(find.text('Verification receipt'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );
}

class _SettingsApi extends ApiClient {
  _SettingsApi()
    : super(
        Dio(BaseOptions(baseUrl: nativeWorkspaceFixtureOrigin)),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );

  @override
  Future<Map<String, dynamic>> getJsonFresh(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    if (path != NativePaths.settingsGet) return const {};
    return {
      'platform': {
        'authEnforced': true,
        'databaseConfigured': true,
        'storageBackend': 'postgres',
      },
      'vault': {'configured': true, 'activeKeyId': 'workspace-key'},
      'providers': [
        {
          'provider': 'openai',
          'status': 'connected',
          'enabled': true,
          'source': 'tenant_vault',
          'manageable': true,
        },
      ],
      'models': [
        {'id': 'configured-model', 'selectable': true},
      ],
      'assignments': [
        {
          'scope': 'main_agent',
          'manageable': true,
          'provider': 'openai',
          'modelId': 'configured-model',
          'displayModelId': 'Configured model',
        },
      ],
    };
  }
}

class _ComputerRepository implements LocalComputerRepository {
  @override
  Future<LocalComputerClaimResponse> claim() async =>
      const LocalComputerClaimResponse(command: null, pollAfter: Duration.zero);

  @override
  Future<void> complete(LocalComputerCompletion completion) async {}

  @override
  Future<void> stop(String reason) async {}

  @override
  Future<LocalComputerDeviceSnapshot> updateDevice(
    LocalComputerStatus status,
  ) async => LocalComputerDeviceSnapshot(
    enabled: false,
    online: false,
    activityState: 'offline',
    lastSeenAt: DateTime.utc(2026, 9, 17),
  );
}

class _ComputerHost implements LocalComputerNativeHost {
  static const status = LocalComputerStatus(
    supported: false,
    helperInstalled: false,
    enabled: false,
    active: false,
    accessibility: LocalComputerPermission.unknown,
    screenRecording: LocalComputerPermission.unknown,
    helperVersion: 'unavailable',
  );

  @override
  bool get supported => false;

  @override
  void attachStoppedHandler(LocalComputerStoppedHandler? handler) {}

  @override
  Future<void> dispose() async {}

  @override
  Future<LocalComputerCommandResult> execute(LocalComputerCommand command) =>
      throw UnimplementedError();

  @override
  Future<LocalComputerStatus> getStatus() async => status;

  @override
  Future<void> initialize() async {}

  @override
  Future<LocalComputerStatus> requestPermissions() async => status;

  @override
  Future<LocalComputerStatus> setEnabled(bool enabled) async => status;

  @override
  Future<LocalComputerStatus> stop() async => status;
}
