import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'brand/asael_mark.dart';
import 'platform/mobile_presentation.dart';
import 'router/app_router.dart';
import 'theme/app_theme.dart';
import 'theme/app_theme_mode_controller.dart';
import 'theme/macos_app_theme.dart';
import 'theme/mobile_app_theme.dart';
import '../core/platform/desktop_host_bridge.dart';
import '../core/platform/android_device_bridge.dart';
import '../core/sync/reconnect_coordinator.dart';
import '../features/auth/application/biometric_session_lock_controller.dart';
import '../features/auth/application/session_controller.dart';
import '../features/capture/capture_providers.dart';
import '../features/capture/capture_drop_intake.dart';
import '../features/listen/listen_controller.dart';
import '../features/computer_use/local_computer.dart';
import '../features/computer_use/android_phone.dart';
import '../features/ambient_voice/android_voice_session.dart';
import '../features/push/mobile_push.dart';
import '../features/availability_watches/watch_desktop_alerts.dart';

class AsaelApp extends ConsumerStatefulWidget {
  const AsaelApp({super.key});

  @override
  ConsumerState<AsaelApp> createState() => _AsaelAppState();
}

enum _WorkspaceSuspensionReason { visibility, sessionLock, systemSleep }

class _AsaelAppState extends ConsumerState<AsaelApp>
    with WidgetsBindingObserver {
  final _desktopHostBridge = appDesktopHostBridge;
  DesktopAmbientVoiceRequest? _pendingAmbientVoiceRequest;
  Future<bool>? _biometricLockTransition;
  final _suspensionReasons = <_WorkspaceSuspensionReason>{};
  AppLifecycleState? _lastLifecycleState;
  int _suspensionGeneration = 0;
  bool _captureLocked = false;
  bool _phoneLeaseDeferredLock = false;

  bool get _suspended => _suspensionReasons.isNotEmpty;

  bool get _hasPhoneSessionLease =>
      appAndroidDeviceBridge.supported &&
      ref.read(sessionOwnerKeyProvider) != null &&
      !ref
          .read(biometricSessionLockControllerProvider)
          .state
          .blocksInteraction &&
      (ref.read(androidVoiceSessionProvider).backgroundCallActive ||
          ref.read(androidPhoneProvider).backgroundSessionActive);

  void _phoneSessionChanged() {
    if (!mounted ||
        !_suspended ||
        !_phoneLeaseDeferredLock ||
        _hasPhoneSessionLease) {
      return;
    }
    _phoneLeaseDeferredLock = false;
    final transition = _protectSuspendedWorkspace();
    _biometricLockTransition = transition;
    unawaited(transition);
  }

  Future<void> _handleAmbientVoiceRequest(
    DesktopAmbientVoiceRequest request,
  ) async {
    if (!mounted) return;
    if (ref.read(sessionOwnerKeyProvider) == null) {
      _pendingAmbientVoiceRequest = request;
      return;
    }
    _openAmbientVoice();
  }

  void _openAmbientVoice() {
    if (!mounted) return;
    final router = ref.read(appRouterProvider);
    if (router.routerDelegate.currentConfiguration.uri.path ==
        '/ambient-voice') {
      return;
    }
    unawaited(router.push<void>('/ambient-voice'));
  }

  void _suspendProtectedWorkspace(_WorkspaceSuspensionReason reason) {
    if (!mounted ||
        ref.read(sessionOwnerKeyProvider) == null ||
        _suspensionReasons.contains(reason)) {
      return;
    }
    final wasSuspended = _suspended;
    setState(() {
      _suspensionReasons.add(reason);
      _suspensionGeneration += 1;
    });
    if (!wasSuspended) ref.read(reconnectCoordinatorProvider).suspend();
    if (wasSuspended && !_phoneLeaseDeferredLock) return;
    // Only an explicitly started, expiring native foreground session retains
    // the current owner credentials while it works in another app. Screens
    // stay hidden; manual/device lock and service loss keep the normal path.
    if (reason == _WorkspaceSuspensionReason.visibility &&
        _hasPhoneSessionLease) {
      _phoneLeaseDeferredLock = true;
      return;
    }
    _phoneLeaseDeferredLock = false;
    final transition = _protectSuspendedWorkspace();
    _biometricLockTransition = transition;
    unawaited(transition);
  }

  Future<void> _restoreProtectedWorkspace(
    _WorkspaceSuspensionReason reason,
  ) async {
    if (!mounted || !_suspensionReasons.contains(reason)) return;
    setState(() {
      _suspensionReasons.remove(reason);
      _suspensionGeneration += 1;
    });
    if (_suspended) return;
    _phoneLeaseDeferredLock = false;
    await _resumeSuspendedWorkspace();
  }

  Future<void> _handleDesktopSystemLifecycle(
    DesktopSystemLifecycleEvent event,
  ) async {
    switch (event) {
      case DesktopSystemLifecycleEvent.sessionLocked:
        _suspendProtectedWorkspace(_WorkspaceSuspensionReason.sessionLock);
      case DesktopSystemLifecycleEvent.systemWillSleep:
        _suspendProtectedWorkspace(_WorkspaceSuspensionReason.systemSleep);
      case DesktopSystemLifecycleEvent.sessionUnlocked:
        unawaited(
          _restoreProtectedWorkspace(_WorkspaceSuspensionReason.sessionLock),
        );
      case DesktopSystemLifecycleEvent.systemDidWake:
        unawaited(
          _restoreProtectedWorkspace(_WorkspaceSuspensionReason.systemSleep),
        );
    }
    // Do not hold the native event queue behind biometric storage or recovery.
    // A subsequent lock/sleep must synchronously fence any pending resume.
  }

  Future<bool> _protectSuspendedWorkspace() async {
    final owner = ref.read(sessionOwnerKeyProvider);
    final lockController = ref.read(biometricSessionLockControllerProvider);
    final locked = await lockController.lock();
    if (!mounted ||
        owner != ref.read(sessionOwnerKeyProvider) ||
        !identical(
          lockController,
          ref.read(biometricSessionLockControllerProvider),
        )) {
      return locked;
    }
    if (locked && ref.read(primaryNativeRuntimeProvider) && !_captureLocked) {
      ref.read(captureControllerProvider).lock();
      _captureLocked = true;
    }
    return locked;
  }

  Future<void> _resumeSuspendedWorkspace() async {
    final generation = _suspensionGeneration;
    final owner = ref.read(sessionOwnerKeyProvider);
    final transition = _biometricLockTransition;
    final lockController = ref.read(biometricSessionLockControllerProvider);
    final locked = transition == null
        ? lockController.state.blocksInteraction
        : await transition;
    if (!_isCurrentWorkspace(generation, owner, lockController)) return;
    if (identical(_biometricLockTransition, transition)) {
      _biometricLockTransition = null;
    }
    if (locked || lockController.state.blocksInteraction) return;
    await _completeWorkspaceResume(generation, owner, lockController);
  }

  Future<void> _unlockWorkspace() async {
    if (_suspended) return;
    final generation = _suspensionGeneration;
    final owner = ref.read(sessionOwnerKeyProvider);
    final lockController = ref.read(biometricSessionLockControllerProvider);
    final unlocked = await lockController.unlock();
    if (!unlocked) return;
    await _completeWorkspaceResume(generation, owner, lockController);
  }

  bool _isCurrentWorkspace(
    int generation,
    SessionOwnerKey? owner,
    BiometricSessionLockController lockController,
  ) =>
      mounted &&
      !_suspended &&
      generation == _suspensionGeneration &&
      owner != null &&
      owner == ref.read(sessionOwnerKeyProvider) &&
      identical(
        lockController,
        ref.read(biometricSessionLockControllerProvider),
      );

  Future<void> _completeWorkspaceResume(
    int generation,
    SessionOwnerKey? owner,
    BiometricSessionLockController lockController,
  ) async {
    if (!_isCurrentWorkspace(generation, owner, lockController) ||
        lockController.state.blocksInteraction) {
      return;
    }
    final coordinator = ref.read(reconnectCoordinatorProvider);
    if (ref.read(primaryNativeRuntimeProvider)) {
      await coordinator.resume(reason: ReconnectReason.appResumed);
    } else {
      await coordinator.resume();
    }
    if (_isCurrentWorkspace(generation, owner, lockController) &&
        !lockController.state.blocksInteraction) {
      _captureLocked = false;
    }
  }

  Future<void> _handleSharedCapture(DesktopSharedCapture capture) async {
    final router = ref.read(appRouterProvider);
    final controller = ref.read(captureControllerProvider);
    router.go('/capture');
    final summary = await CaptureDropIntake(controller).submit(
      capture.paths.map(AppGroupCaptureDropSource.new).toList(growable: false),
    );
    final retryable =
        summary.busy ||
        summary.changed > 0 ||
        summary.unreadable > 0 ||
        summary.cleanupFailed > 0;
    if (retryable) {
      await _desktopHostBridge.retrySharedCapture(capture.requestId);
    } else {
      // Accepted files are encrypted in the actor-scoped outbox before the
      // App Group staging copy is removed. Terminal invalid files are also
      // cleared so an unsafe share cannot create an infinite retry loop.
      await _desktopHostBridge.completeSharedCapture(capture.requestId);
    }
  }

  @override
  void initState() {
    super.initState();
    _lastLifecycleState = WidgetsBinding.instance.lifecycleState;
    WidgetsBinding.instance.addObserver(this);
    unawaited(_desktopHostBridge.initialize());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_desktopHostBridge.dispose());
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final previous = _lastLifecycleState;
    _lastLifecycleState = state;
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      // The biometric preference intentionally survives sign-out, but the
      // login/bootstrap surface has no protected owner workspace to suspend.
      _suspendProtectedWorkspace(_WorkspaceSuspensionReason.visibility);
    } else if (state == AppLifecycleState.resumed ||
        (MacosAppTheme.shouldUse() &&
            state == AppLifecycleState.inactive &&
            previous == AppLifecycleState.hidden)) {
      // A visible macOS window can remain inactive (for example after an AX
      // zoom). onShow is hidden -> inactive, before any eventual resumed event.
      // Phones keep their app-switcher privacy cover until fully resumed.
      // Restore only visibility; native sleep/session lock and biometrics each
      // retain their own protection until their corresponding restore/unlock.
      // Cmd-Tab is an inactive -> resumed focus transition on macOS. It never
      // enters the suspended branch above, so it deliberately performs no
      // server reads, queue drains, or visible reconciliation.
      unawaited(
        _restoreProtectedWorkspace(_WorkspaceSuspensionReason.visibility),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (appAndroidDeviceBridge.supported) {
      ref.watch(listenLifecycleProvider);
      ref.watch(androidPhoneProvider);
      ref.watch(androidVoiceSessionProvider);
      ref.listen(androidPhoneProvider, (_, _) => _phoneSessionChanged());
      ref.listen(androidVoiceSessionProvider, (_, _) => _phoneSessionChanged());
    }
    final primaryRuntime = ref.watch(primaryNativeRuntimeProvider);
    if (primaryRuntime) ref.watch(captureOutboxLifecycleProvider);
    ref.watch(reconnectCoordinatorProvider);
    final router = ref.watch(appRouterProvider);
    final owner = ref.watch(sessionOwnerKeyProvider);
    if (owner != null && _pendingAmbientVoiceRequest != null) {
      _pendingAmbientVoiceRequest = null;
      WidgetsBinding.instance.addPostFrameCallback((_) => _openAmbientVoice());
    }
    final themeMode = ref.watch(appThemeModeProvider).mode;
    final reconnect = ref.watch(reconnectCoordinatorProvider);
    final biometricLock = ref.watch(biometricSessionLockControllerProvider);
    final localComputer = ref.watch(localComputerCoordinatorProvider);
    final workspaceLocked = biometricLock.state.blocksInteraction;
    _desktopHostBridge.attachRouter(router);
    _desktopHostBridge.attachAmbientVoiceRequestHandler(
      workspaceLocked ? null : _handleAmbientVoiceRequest,
    );
    _desktopHostBridge.attachSystemLifecycleHandler(
      primaryRuntime ? _handleDesktopSystemLifecycle : null,
    );
    final watchAlerts = ref.watch(watchDesktopAlertsProvider);
    watchAlerts?.router = router;
    _desktopHostBridge.attachWatchNotificationHandler(
      workspaceLocked ? null : watchAlerts?.open,
    );
    final push = ref.watch(mobilePushCoordinatorProvider);
    push?.attachRouter(router);
    _desktopHostBridge.attachNotificationHandler(
      workspaceLocked ? null : push?.handleDesktopNotificationAction,
    );
    _desktopHostBridge.attachNotificationReceivedHandler(
      workspaceLocked ? null : push?.handleDesktopNotificationReceived,
    );
    _desktopHostBridge.attachApnsRegistrationHandler(
      workspaceLocked ? null : push?.handleDesktopApnsRegistration,
    );
    final captureController = primaryRuntime
        ? ref.watch(captureControllerProvider)
        : null;
    _desktopHostBridge.attachSharedCaptureHandler(
      workspaceLocked || captureController?.owner == null
          ? null
          : _handleSharedCapture,
    );
    final useMacosTheme = MacosAppTheme.shouldUse();
    final useMobileTheme = usesMobilePresentation();
    return MaterialApp.router(
      title: 'Asael',
      debugShowCheckedModeBanner: false,
      theme: useMacosTheme
          ? MacosAppTheme.light()
          : useMobileTheme
          ? MobileAppTheme.light()
          : AppTheme.light(),
      darkTheme: useMacosTheme
          ? MacosAppTheme.dark()
          : useMobileTheme
          ? MobileAppTheme.dark()
          : AppTheme.dark(),
      highContrastTheme: useMacosTheme
          ? MacosAppTheme.light(highContrast: true)
          : useMobileTheme
          ? MobileAppTheme.light(highContrast: true)
          : AppTheme.light(highContrast: true),
      highContrastDarkTheme: useMacosTheme
          ? MacosAppTheme.dark(highContrast: true)
          : useMobileTheme
          ? MobileAppTheme.dark(highContrast: true)
          : AppTheme.dark(highContrast: true),
      themeMode: themeMode,
      routerConfig: router,
      builder: (context, child) => _BiometricSessionLockLayer(
        controller: biometricLock,
        onUnlock: _unlockWorkspace,
        child: _LocalComputerStatusLayer(
          coordinator: localComputer,
          child: _ReconnectStatusLayer(
            coordinator: reconnect,
            child: Stack(
              children: [
                Positioned.fill(
                  child: ExcludeSemantics(
                    excluding: _suspended,
                    child: IgnorePointer(
                      ignoring: _suspended,
                      child: TickerMode(
                        enabled: !_suspended,
                        child: child ?? const SizedBox.shrink(),
                      ),
                    ),
                  ),
                ),
                if (_suspended)
                  Positioned.fill(
                    child: ColoredBox(
                      color: Theme.of(context).colorScheme.surface,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _BiometricSessionLockLayer extends StatelessWidget {
  const _BiometricSessionLockLayer({
    required this.controller,
    required this.onUnlock,
    required this.child,
  });

  final BiometricSessionLockController controller;
  final Future<void> Function() onUnlock;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final state = controller.state;
    final locked = state.blocksInteraction;
    final scheme = Theme.of(context).colorScheme;
    return Stack(
      children: [
        Positioned.fill(
          child: ExcludeSemantics(
            excluding: locked,
            child: IgnorePointer(
              ignoring: locked,
              child: TickerMode(enabled: !locked, child: child),
            ),
          ),
        ),
        if (locked)
          Positioned.fill(
            child: Material(
              color: scheme.surface,
              child: usesMobilePresentation()
                  ? _MobileWorkspaceLock(state: state, onUnlock: onUnlock)
                  : DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: RadialGradient(
                          center: const Alignment(0, -0.35),
                          radius: 1.15,
                          colors: [
                            scheme.primaryContainer.withValues(alpha: 0.34),
                            scheme.surface,
                          ],
                        ),
                      ),
                      child: Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 420),
                          child: Padding(
                            padding: const EdgeInsets.all(28),
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const AsaelMark(size: 48),
                                const SizedBox(height: 22),
                                Text(
                                  state.busy &&
                                          state.phase ==
                                              BiometricSessionLockPhase.locking
                                      ? 'Securing Asael'
                                      : 'Welcome back',
                                  style: Theme.of(context)
                                      .textTheme
                                      .headlineSmall,
                                  textAlign: TextAlign.center,
                                ),
                                const SizedBox(height: 10),
                                Text(
                                  state.busy
                                      ? 'Keeping your workspace mounted while protected access changes.'
                                      : 'Your workspace is still exactly where you left it. Use Touch ID to release protected access.',
                                  style: Theme.of(context).textTheme.bodyMedium
                                      ?.copyWith(
                                        color: scheme.onSurfaceVariant,
                                      ),
                                  textAlign: TextAlign.center,
                                ),
                                if (state.recoveryMessage
                                    case final message?) ...[
                                  const SizedBox(height: 14),
                                  Text(
                                    message,
                                    style: Theme.of(context).textTheme.bodySmall
                                        ?.copyWith(color: scheme.error),
                                    textAlign: TextAlign.center,
                                  ),
                                ],
                                const SizedBox(height: 22),
                                FilledButton.icon(
                                  onPressed: state.canUnlock
                                      ? () => unawaited(onUnlock())
                                      : null,
                                  icon: state.busy
                                      ? const SizedBox.square(
                                          dimension: 16,
                                          child: CircularProgressIndicator(
                                            strokeWidth: 2,
                                          ),
                                        )
                                      : const Icon(Icons.fingerprint_rounded),
                                  label: Text(
                                    state.phase ==
                                            BiometricSessionLockPhase.unlocking
                                        ? 'Unlocking…'
                                        : state.phase ==
                                              BiometricSessionLockPhase.locking
                                        ? 'Securing…'
                                        : 'Unlock Asael',
                                  ),
                                ),
                                const SizedBox(height: 12),
                                Text(
                                  'No page reload or server reconnect is required.',
                                  style: Theme.of(context).textTheme.labelMedium
                                      ?.copyWith(
                                        color: scheme.onSurfaceVariant,
                                      ),
                                  textAlign: TextAlign.center,
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
            ),
          ),
      ],
    );
  }
}

class _MobileWorkspaceLock extends StatelessWidget {
  const _MobileWorkspaceLock({required this.state, required this.onUnlock});
  final BiometricSessionLockState state;
  final Future<void> Function() onUnlock;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final message = switch (state.failure) {
      BiometricSessionLockFailure.unavailable => 'Device authentication is unavailable. Check your phone’s security settings and try again.',
      BiometricSessionLockFailure.notRecognized =>
        'Asael stayed locked. Try unlocking again when you’re ready.',
      BiometricSessionLockFailure.protectedStorageUnavailable => 'Protected storage didn’t respond. Your workspace is still locked; try again.',
      null => null,
    };
    return SafeArea(
      child: CustomScrollView(
        slivers: [
          SliverFillRemaining(
            hasScrollBody: false,
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 440),
                child: Padding(
                  padding: const EdgeInsets.all(28),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Center(child: AsaelMark(size: 56)),
                      const SizedBox(height: 28),
                      Text(
                        state.busy ? 'Securing your workspace' : 'Welcome back',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        state.busy
                            ? 'Your private workspace is protected.'
                            : 'Unlock Asael to pick up where you left off.',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodyLarge,
                      ),
                      if (message != null) ...[
                        const SizedBox(height: 16),
                        Semantics(
                          liveRegion: true,
                          child: Text(
                            message,
                            textAlign: TextAlign.center,
                            style: TextStyle(color: theme.colorScheme.error),
                          ),
                        ),
                      ],
                      const SizedBox(height: 28),
                      FilledButton.icon(
                        style: FilledButton.styleFrom(
                          minimumSize: const Size.fromHeight(54),
                        ),
                        onPressed: state.canUnlock
                            ? () => unawaited(onUnlock())
                            : null,
                        icon: const Icon(Icons.fingerprint_rounded),
                        label: Text(
                          state.phase == BiometricSessionLockPhase.unlocking
                              ? 'Unlocking…'
                              : state.busy
                              ? 'Securing…'
                              : 'Unlock Asael',
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _LocalComputerStatusLayer extends StatelessWidget {
  const _LocalComputerStatusLayer({
    required this.coordinator,
    required this.child,
  });

  final LocalComputerCoordinator coordinator;
  final Widget child;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: coordinator,
    child: child,
    builder: (context, child) {
      final visible = coordinator.active;
      final scheme = Theme.of(context).colorScheme;
      return Stack(
        children: [
          Positioned.fill(child: child!),
          Positioned(
            top: 10,
            right: 14,
            child: IgnorePointer(
              ignoring: !visible,
              child: AnimatedSlide(
                offset: visible ? Offset.zero : const Offset(0, -1.4),
                duration: const Duration(milliseconds: 180),
                curve: Curves.easeOutCubic,
                child: AnimatedOpacity(
                  opacity: visible ? 1 : 0,
                  duration: const Duration(milliseconds: 140),
                  child: Material(
                    color: scheme.errorContainer,
                    elevation: 5,
                    shadowColor: scheme.shadow.withValues(alpha: .15),
                    borderRadius: BorderRadius.circular(999),
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(12, 6, 6, 6),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.radio_button_checked_rounded,
                            size: 15,
                            color: scheme.error,
                          ),
                          const SizedBox(width: 7),
                          Text(
                            'Asael is controlling this Mac',
                            style: Theme.of(context).textTheme.labelLarge,
                          ),
                          const SizedBox(width: 7),
                          TextButton(
                            onPressed: coordinator.changing
                                ? null
                                : () => unawaited(coordinator.stopNow()),
                            style: TextButton.styleFrom(
                              foregroundColor: scheme.error,
                              visualDensity: VisualDensity.compact,
                            ),
                            child: const Text('Stop now'),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      );
    },
  );
}

class _ReconnectStatusLayer extends StatelessWidget {
  const _ReconnectStatusLayer({required this.coordinator, required this.child});

  final ReconnectCoordinator coordinator;
  final Widget child;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: coordinator,
    child: child,
    builder: (context, child) {
      final phase = coordinator.phase;
      final visible =
          const {
            ReconnectPhase.offline,
            ReconnectPhase.degraded,
          }.contains(phase) ||
          coordinator.shouldAnnounceRecovery;
      final scheme = Theme.of(context).colorScheme;
      final (icon, message, color) = switch (phase) {
        ReconnectPhase.offline => (
          Icons.cloud_off_rounded,
          'Offline · showing encrypted local projections',
          scheme.tertiaryContainer,
        ),
        ReconnectPhase.reconciling => (
          Icons.sync_rounded,
          coordinator.activeReason == ReconnectReason.networkRestored
              ? 'Back online · syncing pending changes'
              : 'Syncing updated workspace state',
          scheme.primaryContainer,
        ),
        ReconnectPhase.degraded => (
          Icons.sync_problem_rounded,
          'Some views could not reconcile · retrying remains safe',
          scheme.errorContainer,
        ),
        _ => (Icons.cloud_done_rounded, '', scheme.surface),
      };
      if (usesMobilePresentation()) {
        final phoneMessage = switch (phase) {
          ReconnectPhase.offline =>
            'You’re offline. Some information may be out of date.',
          ReconnectPhase.reconciling => 'Back online. Syncing your changes…',
          ReconnectPhase.degraded => 'Some information couldn’t refresh.',
          _ => message,
        };
        return Stack(
          children: [
            Positioned.fill(child: child!),
            if (visible)
              Positioned(
                top: MediaQuery.paddingOf(context).top + 8,
                left: 12,
                right: 12,
                child: Semantics(
                  liveRegion: true,
                  child: Material(
                    color: color,
                    borderRadius: BorderRadius.circular(12),
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Row(
                        children: [
                          Icon(icon, size: 20),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              phoneMessage,
                              style: Theme.of(context).textTheme.bodyMedium,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        );
      }
      return Stack(
        children: [
          Positioned.fill(child: child!),
          Positioned(
            top: 10,
            left: 0,
            right: 0,
            child: IgnorePointer(
              ignoring: !visible,
              child: AnimatedSlide(
                offset: visible ? Offset.zero : const Offset(0, -1.4),
                duration: const Duration(milliseconds: 220),
                curve: Curves.easeOutCubic,
                child: AnimatedOpacity(
                  opacity: visible ? 1 : 0,
                  duration: const Duration(milliseconds: 160),
                  child: Center(
                    child: Semantics(
                      liveRegion: true,
                      label: message,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: color,
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(color: scheme.outlineVariant),
                          boxShadow: [
                            BoxShadow(
                              color: scheme.shadow.withValues(alpha: 0.12),
                              blurRadius: 18,
                              offset: const Offset(0, 6),
                            ),
                          ],
                        ),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 14,
                            vertical: 8,
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if (phase == ReconnectPhase.reconciling)
                                const SizedBox.square(
                                  dimension: 14,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              else
                                Icon(icon, size: 16),
                              const SizedBox(width: 8),
                              Text(
                                message,
                                style: Theme.of(context).textTheme.labelLarge,
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      );
    },
  );
}
