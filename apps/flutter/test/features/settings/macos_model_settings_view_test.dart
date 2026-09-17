import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/platform/local_computer_bridge.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/computer_use/local_computer.dart';
import 'package:asael/features/settings/model_settings_view.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

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

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          localComputerCoordinatorProvider.overrideWith((ref) => coordinator),
        ],
        child: MaterialApp(
          theme: MacosAppTheme.light(),
          home: ModelSettingsView(api: _SettingsApi()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Settings'), findsOneWidget);
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
}

class _SettingsApi extends ApiClient {
  _SettingsApi()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  @override
  Future<Map<String, dynamic>> getJson(
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
