import 'dart:async';

import 'package:asael/app/asael_app.dart';
import 'package:asael/app/router/app_router.dart';
import 'package:asael/app/theme/app_theme_mode_controller.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/platform/android_device_bridge.dart';
import 'package:asael/core/platform/desktop_host_bridge.dart';
import 'package:asael/core/platform/local_computer_bridge.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/ambient_voice/android_voice_session.dart';
import 'package:asael/features/ambient_voice/voice_conversation_controller.dart';
import 'package:asael/features/capture/capture_controller.dart';
import 'package:asael/features/capture/capture_outbox.dart';
import 'package:asael/features/capture/capture_providers.dart';
import 'package:asael/features/computer_use/local_computer.dart';
import 'package:asael/features/computer_use/android_phone.dart';
import 'package:asael/features/listen/listen_controller.dart';
import 'package:asael/features/push/mobile_push.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  _testLifecycle('showing an inactive Mac restores the same mounted workspace '
      'when biometrics are disabled', (tester) async {
    final h = await _Harness.mount(tester);
    await tester.tap(find.text('Increment'));
    await tester.pump();
    final mountedPage = tester.state(find.byType(_Workspace));
    expect(find.text('Workspace counter: 1'), findsOneWidget);

    await h.lifecycle(AppLifecycleState.hidden);
    await h.lifecycle(AppLifecycleState.inactive);

    h.expectWorkspaceVisible();
    expect(tester.state(find.byType(_Workspace)), same(mountedPage));
    expect(find.text('Workspace counter: 1'), findsOneWidget);
    expect(h.sessions.lockCalls, 1);
    expect(h.reconnect.resumeReasons, [ReconnectReason.appResumed]);
    expect(h.durableReconciliations, 1);
    expect(h.freshnessReconciliations, 0);
    await h.lifecycle(AppLifecycleState.resumed);
    expect(h.reconnect.resumeReasons, hasLength(1));
  });

  _testLifecycle('showing an inactive Mac retains biometric protection until '
      'explicit unlock', (tester) async {
    final h = await _Harness.mount(tester, biometrics: true);
    final mountedPage = tester.state(find.byType(_Workspace));
    await h.lifecycle(AppLifecycleState.hidden);
    await h.lifecycle(AppLifecycleState.inactive);

    h.expectWorkspaceProtected();
    expect(find.text('Welcome back'), findsOneWidget);
    expect(h.capture.lockCalls, 1);
    expect(h.reconnect.resumeReasons, isEmpty);
    expect(h.sessions.unlockCalls, 0);
    await tester.tap(find.text('Unlock Asael'));
    await tester.pump();
    await tester.pump();

    h.expectWorkspaceVisible();
    expect(tester.state(find.byType(_Workspace)), same(mountedPage));
    expect(h.sessions.unlockCalls, 1);
    expect(h.reconnect.resumeReasons, [ReconnectReason.appResumed]);
  });

  _testLifecycle(
    'another engine lock protects this workspace and its unlock resumes once',
    (tester) async {
      final h = await _Harness.mount(tester, biometrics: true);
      final lock = h.container.read(biometricSessionLockControllerProvider);
      lock.applyProcessLock(true);
      await tester.pump();
      await tester.pump();
      h.expectWorkspaceProtected();
      expect(h.capture.lockCalls, 1);
      expect(h.reconnect.resumeReasons, isEmpty);
      lock.applyProcessLock(false);
      await tester.pump();
      await tester.pump();
      h.expectWorkspaceVisible();
      expect(h.sessions.unlockCalls, 0);
      expect(h.reconnect.resumeReasons, [ReconnectReason.appResumed]);
    },
  );

  _testLifecycle('ordinary focus changes never lock, reconnect or drain work', (
    tester,
  ) async {
    final h = await _Harness.mount(tester, biometrics: true);
    for (var i = 0; i < 3; i += 1) {
      await h.lifecycle(AppLifecycleState.inactive);
      await h.lifecycle(AppLifecycleState.resumed);
    }
    h.expectWorkspaceVisible();
    expect(h.sessions.lockCalls, 0);
    expect(h.reconnect.suspendCalls, 0);
    expect(h.reconnect.resumeReasons, isEmpty);
    expect(h.durableReconciliations, 0);
    expect(h.freshnessReconciliations, 0);
  });

  for (final unlockFirst in [true, false]) {
    _testLifecycle('native sleep and session lock remain independent when '
        '${unlockFirst ? 'unlock' : 'wake'} arrives first', (tester) async {
      final h = await _Harness.mount(tester);
      await h.native(DesktopSystemLifecycleEvent.sessionLocked);
      await h.native(DesktopSystemLifecycleEvent.systemWillSleep);
      await h.lifecycle(AppLifecycleState.hidden);
      await h.lifecycle(AppLifecycleState.inactive);
      await h.lifecycle(AppLifecycleState.resumed);

      h.expectWorkspaceProtected();
      final first = unlockFirst
          ? DesktopSystemLifecycleEvent.sessionUnlocked
          : DesktopSystemLifecycleEvent.systemDidWake;
      final last = unlockFirst
          ? DesktopSystemLifecycleEvent.systemDidWake
          : DesktopSystemLifecycleEvent.sessionUnlocked;
      await h.native(first);
      // Repeated and out-of-order restoration cannot clear another reason.
      await h.native(first);
      h.expectWorkspaceProtected();
      expect(h.reconnect.resumeReasons, isEmpty);
      await h.native(last);

      h.expectWorkspaceVisible();
      expect(h.sessions.lockCalls, 1);
      expect(h.reconnect.suspendCalls, 1);
      expect(h.reconnect.resumeReasons, [ReconnectReason.appResumed]);
    });
  }

  _testLifecycle('native unlock does not expose a still-hidden window', (
    tester,
  ) async {
    final h = await _Harness.mount(tester);
    await h.lifecycle(AppLifecycleState.hidden);
    await h.native(DesktopSystemLifecycleEvent.sessionLocked);
    await h.native(DesktopSystemLifecycleEvent.sessionUnlocked);
    expect(h.reconnect.resumeReasons, isEmpty);

    await h.lifecycle(AppLifecycleState.inactive);
    h.expectWorkspaceVisible();
    expect(h.reconnect.resumeReasons, [ReconnectReason.appResumed]);
  });

  _testLifecycle('system restoration does not release the biometric lock', (
    tester,
  ) async {
    final h = await _Harness.mount(tester, biometrics: true);
    await h.native(DesktopSystemLifecycleEvent.sessionLocked);
    await h.native(DesktopSystemLifecycleEvent.systemWillSleep);
    await h.lifecycle(AppLifecycleState.hidden);
    await h.lifecycle(AppLifecycleState.inactive);
    await h.native(DesktopSystemLifecycleEvent.sessionUnlocked);
    await tester.tap(find.text('Unlock Asael'));
    await tester.pump();
    expect(
      h.sessions.unlockCalls,
      0,
      reason: 'Biometrics cannot release access while native sleep remains.',
    );
    h.expectWorkspaceProtected();
    await h.native(DesktopSystemLifecycleEvent.systemDidWake);
    h.expectWorkspaceProtected();
    expect(h.reconnect.resumeReasons, isEmpty);
    await tester.tap(find.text('Unlock Asael'));
    await tester.pump();
    await tester.pump();
    h.expectWorkspaceVisible();
    expect(h.reconnect.resumeReasons, [ReconnectReason.appResumed]);
  });

  _testLifecycle(
    'a later native lock fences a pending visibility restoration',
    (tester) async {
      final h = await _Harness.mount(tester);
      final held = Completer<bool>();
      h.sessions.nextLock = held;
      await h.lifecycle(AppLifecycleState.hidden);
      await h.lifecycle(AppLifecycleState.inactive);
      await h.native(DesktopSystemLifecycleEvent.sessionLocked);
      held.complete(false);
      await tester.pump();
      await tester.pump();

      h.expectWorkspaceProtected();
      expect(h.reconnect.resumeReasons, isEmpty);
      await h.native(DesktopSystemLifecycleEvent.sessionUnlocked);
      h.expectWorkspaceVisible();
      expect(h.reconnect.resumeReasons, [ReconnectReason.appResumed]);
    },
  );

  _testLifecycle(
    'pending native unlock never holds a later lock behind storage',
    (tester) async {
      final h = await _Harness.mount(tester);
      final held = Completer<bool>();
      h.sessions.nextLock = held;
      await h.native(DesktopSystemLifecycleEvent.sessionLocked);
      // This must return while biometric storage is still pending, allowing the
      // same native FIFO to deliver the second lock before the first completes.
      await h.native(DesktopSystemLifecycleEvent.sessionUnlocked);
      await h.native(DesktopSystemLifecycleEvent.sessionLocked);
      held.complete(false);
      await tester.pump();
      await tester.pump();

      h.expectWorkspaceProtected();
      expect(h.reconnect.resumeReasons, isEmpty);
      await h.native(DesktopSystemLifecycleEvent.sessionUnlocked);
      h.expectWorkspaceVisible();
      expect(h.reconnect.resumeReasons, [ReconnectReason.appResumed]);
    },
  );

  _testLifecycle('owner replacement fences a pending biometric restore', (
    tester,
  ) async {
    final h = await _Harness.mount(tester);
    final held = Completer<bool>();
    h.sessions.nextLock = held;
    await h.lifecycle(AppLifecycleState.hidden);
    await h.lifecycle(AppLifecycleState.inactive);
    h.owner.replace(_session('replacement'));
    held.complete(false);
    await tester.pump();
    await tester.pump();
    expect(h.reconnect.resumeReasons, isEmpty);
    expect(h.capture.lockCalls, 0);
    expect(tester.takeException(), isNull);
  });

  _testLifecycle(
    'a lock arriving during explicit unlock prevents stale resume',
    (tester) async {
      final h = await _Harness.mount(tester, biometrics: true);
      await h.lifecycle(AppLifecycleState.hidden);
      await h.lifecycle(AppLifecycleState.inactive);
      final held = Completer<void>();
      h.sessions.nextUnlock = held;
      await tester.tap(find.text('Unlock Asael'));
      await tester.pump();
      await h.native(DesktopSystemLifecycleEvent.sessionLocked);
      held.complete();
      await tester.pump();
      await tester.pump();

      h.expectWorkspaceProtected();
      expect(h.reconnect.resumeReasons, isEmpty);
      await h.native(DesktopSystemLifecycleEvent.sessionUnlocked);
      h.expectWorkspaceProtected();
      await tester.tap(find.text('Unlock Asael'));
      await tester.pump();
      await tester.pump();
      h.expectWorkspaceVisible();
      expect(h.reconnect.resumeReasons, [ReconnectReason.appResumed]);
    },
  );

  _testLifecycle(
    'late protection completion after disposal cannot resume work',
    (tester) async {
      final h = await _Harness.mount(tester);
      final held = Completer<bool>();
      h.sessions.nextLock = held;
      await h.lifecycle(AppLifecycleState.hidden);
      await h.lifecycle(AppLifecycleState.inactive);
      await tester.pumpWidget(const SizedBox.shrink());
      held.complete(false);
      await tester.pump();
      // The harness retains an external ProviderContainer after the widget
      // unmounts; advance its zero-duration deferred disposal timer too.
      await tester.pump(Duration.zero);
      expect(h.reconnect.resumeReasons, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  _testLifecycle(
    'a phone foreground lease resumes after an earlier biometric unlock',
    (tester) async {
      final h = await _Harness.mount(tester, biometrics: true);
      await h.lifecycle(AppLifecycleState.hidden);
      await h.lifecycle(AppLifecycleState.inactive);
      h.expectWorkspaceProtected();
      await h.lifecycle(AppLifecycleState.resumed);
      await tester.tap(find.text('Unlock Asael'));
      await tester.pump();
      await tester.pump();
      h.expectWorkspaceVisible();
      expect(h.reconnect.resumeReasons, hasLength(1));

      h.phone.setLease(true);
      await tester.pump();
      await h.lifecycle(AppLifecycleState.hidden);
      await h.lifecycle(AppLifecycleState.inactive);
      h.expectWorkspaceProtected();
      expect(h.reconnect.resumeReasons, hasLength(1));
      await h.lifecycle(AppLifecycleState.resumed);

      h.expectWorkspaceVisible();
      expect(
        h.sessions.lockCalls,
        1,
        reason: 'The live foreground lease defers the second biometric lock.',
      );
      expect(h.sessions.unlockCalls, 1);
      expect(h.reconnect.resumeReasons, [
        ReconnectReason.appResumed,
        ReconnectReason.appResumed,
      ]);
    },
    platform: TargetPlatform.android,
  );

  _testLifecycle(
    'ending a phone foreground lease while hidden restores biometric protection',
    (tester) async {
      final h = await _Harness.mount(tester, biometrics: true);
      h.phone.setLease(true);
      await tester.pump();
      await h.lifecycle(AppLifecycleState.hidden);
      expect(h.sessions.lockCalls, 0);
      h.phone.setLease(false);
      await tester.pump();
      await h.lifecycle(AppLifecycleState.inactive);

      h.expectWorkspaceProtected();
      expect(h.sessions.lockCalls, 1);
      expect(h.reconnect.resumeReasons, isEmpty);
      await h.lifecycle(AppLifecycleState.resumed);
      h.expectWorkspaceProtected();
      await tester.tap(find.text('Unlock Asael'));
      await tester.pump();
      await tester.pump();
      h.expectWorkspaceVisible();
      expect(h.reconnect.resumeReasons, [ReconnectReason.appResumed]);
    },
    platform: TargetPlatform.android,
  );
}

void _testLifecycle(
  String description,
  WidgetTesterCallback callback, {
  TargetPlatform platform = TargetPlatform.macOS,
}) {
  testWidgets(
    description,
    callback,
    variant: TargetPlatformVariant.only(platform),
  );
}

class _Harness {
  _Harness(this.tester, {required bool biometrics})
    : sessions = _SessionEffects(biometrics);

  final WidgetTester tester;
  final _SessionEffects sessions;
  final reconnect = _RecordingReconnect();
  final capture = _RecordingCapture();
  late final phone = _LeasePhone();
  late _Owner owner;
  late ProviderContainer container;
  late GoRouter router;
  int durableReconciliations = 0;
  int freshnessReconciliations = 0;

  static Future<_Harness> mount(
    WidgetTester tester, {
    bool biometrics = false,
  }) async {
    final h = _Harness(tester, biometrics: biometrics);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1;
    h.router = GoRouter(
      routes: [GoRoute(path: '/', builder: (_, _) => const _Workspace())],
    );
    h.container = ProviderContainer(
      overrides: [
        sessionControllerProvider.overrideWith(() => h.owner = _Owner()),
        appRouterProvider.overrideWithValue(h.router),
        appThemeModeProvider.overrideWith((_) => AppThemeModeController()),
        reconnectCoordinatorProvider.overrideWithValue(h.reconnect),
        biometricSessionLockControllerProvider.overrideWith(
          (_) => BiometricSessionLockController(h.sessions),
        ),
        captureOutboxLifecycleProvider.overrideWith((_) {}),
        captureControllerProvider.overrideWith((_) => h.capture),
        mobilePushCoordinatorProvider.overrideWithValue(null),
        listenLifecycleProvider.overrideWith((_) {}),
        androidPhoneProvider.overrideWith((_) => h.phone),
        androidVoiceSessionProvider.overrideWith(
          (_) => VoiceConversationController(api: _NoApi()),
        ),
        localComputerCoordinatorProvider.overrideWith(
          (_) => LocalComputerCoordinator(
            repository: _NoComputerRepository(),
            host: _NoComputerHost(),
            windowContext: const LocalComputerWindowContext(
              role: LocalComputerWindowRole.primary,
            ),
            authenticated: false,
          ),
        ),
      ],
    );
    await h.container.read(sessionControllerProvider.future);
    await h.reconnect.start();
    h.reconnect.register('test-durable', () async {
      h.durableReconciliations += 1;
    }, classification: ReconciliationClass.durable);
    h.reconnect.register('test-freshness', () async {
      h.freshnessReconciliations += 1;
    });
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox.shrink());
      await appDesktopHostBridge.dispose();
      h.container.dispose();
      h.router.dispose();
      h.reconnect.dispose();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
      expect(tester.takeException(), isNull);
    });
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: h.container,
        child: const AsaelApp(),
      ),
    );
    await tester.pump();
    h.expectWorkspaceVisible();
    return h;
  }

  Future<void> lifecycle(AppLifecycleState state) async {
    tester.binding.handleAppLifecycleStateChanged(state);
    await tester.pump();
    await tester.pump();
  }

  Future<void> native(DesktopSystemLifecycleEvent event) async {
    await appDesktopHostBridge.handleNativeCall(MethodCall(event.name));
    await tester.pump();
    await tester.pump();
  }

  void expectWorkspaceVisible() {
    expect(find.text('Increment').hitTestable(), findsOneWidget);
    expect(
      find.semantics.byLabel(RegExp('Private workspace')).evaluate(),
      hasLength(1),
    );
    expect(tester.takeException(), isNull);
  }

  void expectWorkspaceProtected() {
    expect(find.text('Increment').hitTestable(), findsNothing);
    expect(
      find.semantics.byLabel(RegExp('Private workspace')).evaluate(),
      isEmpty,
    );
    expect(tester.takeException(), isNull);
  }
}

class _Workspace extends StatefulWidget {
  const _Workspace();
  @override
  State<_Workspace> createState() => _WorkspaceState();
}

class _WorkspaceState extends State<_Workspace> {
  int count = 0;
  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Private workspace',
    child: Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Workspace counter: $count'),
            FilledButton(
              onPressed: () => setState(() => count += 1),
              child: const Text('Increment'),
            ),
          ],
        ),
      ),
    ),
  );
}

AppSession _session(String owner) => AppSession(
  tenantId: 'tenant',
  actorId: owner,
  userId: owner,
  email: '$owner@example.test',
  displayName: 'Synthetic owner',
  workspaceName: 'Synthetic workspace',
);

class _Owner extends SessionController {
  @override
  Future<AppSession?> build() async => _session('owner');
  void replace(AppSession session) => state = AsyncData(session);
}

class _SessionEffects extends Fake implements SessionRepository {
  _SessionEffects(this.biometrics);
  final bool biometrics;
  int lockCalls = 0, unlockCalls = 0;
  Completer<bool>? nextLock;
  Completer<void>? nextUnlock;

  @override
  Future<bool> lockBiometricRelease() async {
    lockCalls += 1;
    final held = nextLock;
    nextLock = null;
    return held == null ? biometrics : held.future;
  }

  @override
  Future<void> unlockBiometricRelease() async {
    unlockCalls += 1;
    final held = nextUnlock;
    nextUnlock = null;
    await held?.future;
  }
}

class _RecordingReconnect extends ReconnectCoordinator {
  _RecordingReconnect()
    : super(() async => [ConnectivityResult.wifi], const Stream.empty());
  int suspendCalls = 0;
  final resumeReasons = <ReconnectReason?>[];
  @override
  void suspend() {
    suspendCalls += 1;
    super.suspend();
  }

  @override
  Future<void> resume({ReconnectReason? reason}) {
    resumeReasons.add(reason);
    return super.resume(reason: reason);
  }
}

class _RecordingCapture extends CaptureController {
  _RecordingCapture() : super(_NoCaptureRepository(), _NoCaptureOutbox(), null);
  int lockCalls = 0;
  @override
  void lock({bool notify = true}) {
    lockCalls += 1;
    super.lock(notify: notify);
  }
}

class _NoCaptureRepository extends Fake implements CaptureRepository {}

class _NoCaptureOutbox extends Fake implements CaptureOutbox {}

class _NoComputerRepository extends Fake implements LocalComputerRepository {}

class _NoApi extends Fake implements ApiClient {}

class _NoAndroidHost extends AndroidDeviceBridge {
  @override
  bool get supported => false;
}

class _LeasePhone extends AndroidPhoneCoordinator {
  _LeasePhone() : super(_NoApi(), _NoAndroidHost(), () => true);
  bool _lease = false;
  @override
  bool get backgroundSessionActive => _lease;
  void setLease(bool active) {
    _lease = active;
    notifyListeners();
  }
}

class _NoComputerHost extends Fake implements LocalComputerNativeHost {
  @override
  bool get supported => false;
  @override
  void attachStoppedHandler(LocalComputerStoppedHandler? handler) {}
}
