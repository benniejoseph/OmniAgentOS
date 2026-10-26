import 'package:asael/core/platform/desktop_host_bridge.dart';
import 'package:asael/core/update/native_update_handshake.dart';
import 'package:asael/core/update/native_update_protocol.dart';
import 'package:asael/core/update/native_update_startup_gate.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:dio/dio.dart';
import 'package:asael/features/self_improvement/self_improvement_controller.dart';
import 'package:asael/features/self_improvement/self_improvement_models.dart';
import 'package:asael/features/self_improvement/self_improvement_repository.dart';
import 'package:asael/features/self_improvement/self_improvement_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../features/self_improvement/self_improvement_test_support.dart';

class _Repository implements SelfImprovementRepositoryApi {
  _Repository(this.snapshot);
  final SelfImprovementSnapshot snapshot;
  @override
  bool current = true;
  @override
  bool canManage = true;
  @override
  Future<SelfImprovementSnapshot> load() async => snapshot;
  @override
  Future<SelfImprovementCycle?> loadCycle(String id) async => null;
  @override
  Future<List<SelfImprovementProject>> loadProjects() async => [];
  @override
  Future<List<SelfImprovementRepositoryOption>> loadRepositories() async => [];
  @override
  Future<SelfImprovementMutationResult> mutate(
    String action,
    ImprovementJson input,
    String key,
  ) async => throw StateError('No writes allowed in startup verification.');
}

Future<SelfImprovementController> _controller() async {
  final policy = await improvementPolicy();
  final snapshot = SelfImprovementSnapshot.fromJson(
    improvementSnapshot(improvementConfig(policy)),
  );
  final controller = SelfImprovementController(_Repository(snapshot));
  await controller.refresh();
  return controller;
}

Map<String, Object?> _request(
  String owner, {
  String action = 'status',
  String nonce = 'd',
  Map<String, Object?> patch = const {},
}) => {
  'protocol': 1,
  'action': action,
  'nonce': improvementHex(nonce),
  'expected': {
    'sourceRevision': improvementHex('a', 40),
    'sourceSnapshotSha256': improvementHex('b'),
    'version': '1.40.0',
    'build': 116,
    'ownerSha256': owner,
    ...patch,
  },
};
Future<Map<String, Object?>> _read(
  WidgetTester tester,
  DesktopHostBridge bridge,
  Map<String, Object?> request,
) async {
  final pending = bridge.handleNativeCall(
    MethodCall('nativeUpdateReadiness', request),
  );
  await tester.pump();
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 10));
  return Map<String, Object?>.from((await pending)! as Map);
}

Future<void> _mount(
  WidgetTester tester,
  DesktopHostBridge bridge,
  SelfImprovementController controller, {
  String route = '/improvement',
  bool unlocked = true,
  bool signedIn = true,
  Set<String> busy = const {},
  Widget? extra,
}) async {
  tester.view.physicalSize = const Size(1280, 960);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      home: NativeUpdateHandshake(
        enabled: true,
        bridge: bridge,
        runtime: () => NativeUpdateRuntime(
          tenantId: signedIn ? 'default' : null,
          userId: signedIn ? improvementUser : null,
          route: route,
          unlocked: unlocked,
          busyReasons: busy,
        ),
        child: Scaffold(
          body: Stack(
            children: [
              SelfImprovementView(controller: controller),
              ?extra,
            ],
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('closed request rejects paths, invalid provenance and actions', () {
    final valid = _request(improvementHex('c'));
    expect(NativeUpdateRequest.parse(valid).action, 'status');
    for (final value in [
      {...valid, 'path': '/tmp/unsafe'},
      {...valid, 'action': 'execute'},
      {...valid, 'nonce': 'bad'},
      _request(improvementHex('c'), patch: {'build': true}),
      {
        ...valid,
        'nativeBusyReasons': ['private arbitrary text'],
      },
    ]) {
      expect(() => NativeUpdateRequest.parse(value), throwsFormatException);
    }
  });
  test('owner digest binds canonical current tenant and user', () async {
    expect(
      await nativeUpdateOwnerDigest('default', improvementUser.toUpperCase()),
      await nativeUpdateOwnerDigest('default', improvementUser),
    );
    expect(
      await nativeUpdateOwnerDigest('other', improvementUser),
      isNot(await nativeUpdateOwnerDigest('default', improvementUser)),
    );
  });
  testWidgets('real frame and fresh native owner workspace are required', (
    tester,
  ) async {
    final bridge = DesktopHostBridge(enabled: true),
        controller = await _controller();
    final owner = await nativeUpdateOwnerDigest('default', improvementUser);
    await _mount(tester, bridge, controller);
    final ready = await _read(tester, bridge, _request(owner));
    expect(ready['status'], 'ready');
    expect(ready['improvementRendered'], true);
    final wrong = await _read(tester, bridge, _request(improvementHex('e')));
    expect(wrong['status'], 'held');
    expect(wrong['busyReasons'], contains('owner_mismatch'));
    final build = await _read(
      tester,
      bridge,
      _request(owner, patch: {'sourceSnapshotSha256': improvementHex('f')}),
    );
    expect(build['status'], 'held');
    expect(build['busyReasons'], contains('build_mismatch'));
    controller.refreshRequired = true;
    expect((await _read(tester, bridge, _request(owner)))['status'], 'held');
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
  });
  testWidgets(
    'supported cycle deep link acknowledges the rendered improvement workspace',
    (tester) async {
      final cycle = 'self_cycle_${improvementHex('a')}';
      for (final route in [
        '/improvement?unknown=value',
        '/improvement?cycle=wrong',
        '/improvement?cycle=$cycle&cycle=$cycle',
        '/improvement?cycle=$cycle#fragment',
        'https://example.com/improvement',
        '/talk?cycle=$cycle',
      ]) {
        expect(nativeUpdateImprovementRoute(route), false, reason: route);
      }
      final bridge = DesktopHostBridge(enabled: true),
          controller = await _controller();
      final owner = await nativeUpdateOwnerDigest('default', improvementUser);
      await _mount(
        tester,
        bridge,
        controller,
        route: '/improvement?cycle=$cycle',
      );
      final result = await _read(tester, bridge, _request(owner));
      expect(result['status'], 'ready');
      expect(result['improvementRendered'], true);
      expect(result['busyReasons'], isNot(contains('route_not_rendered')));
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );
  testWidgets(
    'wrong route or locked workspace never acknowledges feature readiness',
    (tester) async {
      final owner = await nativeUpdateOwnerDigest('default', improvementUser);
      for (final tuple in [('/talk', true), ('/improvement', false)]) {
        final bridge = DesktopHostBridge(enabled: true),
            controller = await _controller();
        await _mount(
          tester,
          bridge,
          controller,
          route: tuple.$1,
          unlocked: tuple.$2,
        );
        expect(
          (await _read(tester, bridge, _request(owner)))['status'],
          'held',
        );
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      }
    },
  );
  testWidgets(
    'retained draft and active native work hold without clearing content',
    (tester) async {
      final bridge = DesktopHostBridge(enabled: true),
          controller = await _controller();
      final draft = TextEditingController(text: 'unsent private draft');
      final owner = await nativeUpdateOwnerDigest('default', improvementUser);
      await _mount(
        tester,
        bridge,
        controller,
        busy: {'desktop_busy'},
        extra: Offstage(child: TextField(controller: draft)),
      );
      final reply = await _read(
        tester,
        bridge,
        _request(owner, action: 'quiesce'),
      );
      expect(reply['status'], 'held');
      expect(
        reply['busyReasons'],
        containsAll(['desktop_busy', 'unsaved_draft']),
      );
      expect(reply.toString(), isNot(contains('unsent private draft')));
      expect(draft.text, 'unsent private draft');
      expect(
        find.text('Update waiting: stop This Mac control before installing.'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
      draft.dispose();
      controller.dispose();
    },
  );
  testWidgets(
    'history search allows lease; native navigation blocks until automatic expiry',
    (tester) async {
      final bridge = DesktopHostBridge(enabled: true),
          controller = await _controller();
      final owner = await nativeUpdateOwnerDigest('default', improvementUser);
      await _mount(tester, bridge, controller);
      await tester.enterText(
        find.byKey(nativeUpdateTransientSearchKey),
        'existing search',
      );
      final reply = await _read(
        tester,
        bridge,
        _request(owner, action: 'quiesce'),
      );
      expect(reply['status'], 'quiesced');
      expect(reply['quiescenceExpiresAt'], isA<String>());
      expect(
        find
            .byType(AbsorbPointer)
            .evaluate()
            .any((e) => (e.widget as AbsorbPointer).absorbing),
        true,
      );
      await expectLater(
        bridge.handleNativeCall(
          const MethodCall('openRoute', {'route': '/talk'}),
        ),
        throwsA(isA<PlatformException>()),
      );
      final replay = await _read(
        tester,
        bridge,
        _request(owner, action: 'quiesce'),
      );
      expect(replay['quiescenceExpiresAt'], reply['quiescenceExpiresAt']);
      final foreign = await _read(
        tester,
        bridge,
        _request(owner, action: 'quiesce', nonce: 'e'),
      );
      expect(foreign['status'], 'held');
      expect(foreign['busyReasons'], contains('request_in_progress'));
      await tester.pump(const Duration(seconds: 31));
      expect(find.textContaining('handoff expired'), findsOneWidget);
      await bridge.handleNativeCall(
        const MethodCall('openRoute', {'route': '/talk'}),
      );
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );
  testWidgets(
    'startup quarantine blocks business calls and permits safe rollback before owner restoration; commit needs actual ready owner',
    (tester) async {
      final nonce = improvementHex('d');
      final expiry = DateTime.now().toUtc().add(const Duration(seconds: 80));
      nativeUpdateStartupGate.initialize([
        '--asael-update-quarantine=$nonce:${expiry.millisecondsSinceEpoch}',
      ]);
      expect(nativeUpdateStartupGate.active, true);
      final store = SecureSessionStore.withStorage(_NoValues());
      final dio = Dio(BaseOptions(baseUrl: 'https://invalid.example'));
      createApiClient(store, dio: dio);
      await tester.runAsync(() async {
        await expectLater(
          dio.post<Object?>('/api/self-improvement', data: {'action': 'run'}),
          throwsA(
            isA<DioException>().having(
              (e) => e.type,
              'type',
              DioExceptionType.cancel,
            ),
          ),
        );
      });
      final bridge = DesktopHostBridge(enabled: true),
          controller = await _controller();
      final owner = await nativeUpdateOwnerDigest('default', improvementUser);
      final savedField = TextEditingController(
        text: 'Previously saved sign-in address',
      );
      await _mount(
        tester,
        bridge,
        controller,
        route: '/login',
        signedIn: false,
        unlocked: false,
        extra: Offstage(child: TextField(controller: savedField)),
      );
      final held = await _read(
        tester,
        bridge,
        _request(owner, action: 'commit'),
      );
      expect(held['status'], 'held');
      expect(nativeUpdateStartupGate.active, true);
      final rollback = await _read(
        tester,
        bridge,
        _request(owner, action: 'quiesce'),
      );
      expect(rollback['status'], 'quiesced');
      expect(rollback['ownerSha256'], null);
      expect(rollback['authenticatedWorkspaceReady'], false);
      expect(rollback['startupQuarantined'], true);
      await tester.pumpWidget(const SizedBox());
      savedField.dispose();
      final restored = DesktopHostBridge(enabled: true);
      await _mount(tester, restored, controller);
      final committed = await _read(
        tester,
        restored,
        _request(owner, action: 'commit'),
      );
      expect(committed['status'], 'ready');
      expect(committed['startupDecision'], 'committed');
      expect(nativeUpdateStartupGate.active, false);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      dio.close(force: true);
      store.dispose();
    },
  );
  testWidgets(
    'abandoned startup gate expires and cannot be confused with commit',
    (tester) async {
      final gate = NativeUpdateStartupGate();
      final expiry = DateTime.now().toUtc().add(const Duration(seconds: 2));
      gate.initialize([
        '--asael-update-quarantine=${improvementHex('d')}:${expiry.millisecondsSinceEpoch}',
      ]);
      expect(gate.active, true);
      expect(gate.commit(improvementHex('e')), false);
      await tester.pump(const Duration(seconds: 3));
      expect(gate.active, false);
      expect(gate.decision, 'expired');
      expect(gate.commit(improvementHex('d')), false);
      gate.dispose();
    },
  );
}

class _NoValues extends Fake implements AsaelSecureValueStore {
  @override
  Future<String?> read({required String key}) => throw StateError(
    'Quarantined business request reached credential storage.',
  );
}
