import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'router/app_router.dart';
import 'theme/app_theme.dart';
import 'theme/macos_app_theme.dart';
import '../core/platform/desktop_host_bridge.dart';
import '../core/sync/reconnect_coordinator.dart';
import '../features/auth/application/session_controller.dart';
import '../features/capture/capture_providers.dart';
import '../features/capture/capture_drop_intake.dart';
import '../features/computer_use/local_computer.dart';
import '../features/push/mobile_push.dart';

class AsaelApp extends ConsumerStatefulWidget {
  const AsaelApp({super.key});

  @override
  ConsumerState<AsaelApp> createState() => _AsaelAppState();
}

class _AsaelAppState extends ConsumerState<AsaelApp>
    with WidgetsBindingObserver {
  final _desktopHostBridge = appDesktopHostBridge;

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
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      unawaited(
        ref.read(sessionControllerProvider.notifier).lockForBiometrics(),
      );
      ref.read(captureControllerProvider).lock();
    } else if (state == AppLifecycleState.resumed) {
      unawaited(
        ref
            .read(reconnectCoordinatorProvider)
            .reconcile(ReconnectReason.appResumed),
      );
      unawaited(ref.read(mobilePushCoordinatorProvider)?.initialize());
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(captureOutboxLifecycleProvider);
    ref.watch(reconnectCoordinatorProvider);
    final router = ref.watch(appRouterProvider);
    final reconnect = ref.watch(reconnectCoordinatorProvider);
    final localComputer = ref.watch(localComputerCoordinatorProvider);
    _desktopHostBridge.attachRouter(router);
    final push = ref.watch(mobilePushCoordinatorProvider);
    push?.attachRouter(router);
    _desktopHostBridge.attachNotificationHandler(
      push?.handleDesktopNotificationAction,
    );
    _desktopHostBridge.attachNotificationReceivedHandler(
      push?.handleDesktopNotificationReceived,
    );
    _desktopHostBridge.attachApnsRegistrationHandler(
      push?.handleDesktopApnsRegistration,
    );
    final captureController = ref.watch(captureControllerProvider);
    _desktopHostBridge.attachSharedCaptureHandler(
      captureController.owner == null ? null : _handleSharedCapture,
    );
    final useMacosTheme = MacosAppTheme.shouldUse();
    return MaterialApp.router(
      title: 'Asael',
      debugShowCheckedModeBanner: false,
      theme: useMacosTheme ? MacosAppTheme.light() : AppTheme.light(),
      darkTheme: useMacosTheme ? MacosAppTheme.dark() : AppTheme.dark(),
      highContrastTheme: useMacosTheme
          ? MacosAppTheme.light(highContrast: true)
          : AppTheme.light(highContrast: true),
      highContrastDarkTheme: useMacosTheme
          ? MacosAppTheme.dark(highContrast: true)
          : AppTheme.dark(highContrast: true),
      themeMode: ThemeMode.system,
      routerConfig: router,
      builder: (context, child) => _LocalComputerStatusLayer(
        coordinator: localComputer,
        child: _ReconnectStatusLayer(
          coordinator: reconnect,
          child: child ?? const SizedBox.shrink(),
        ),
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
      final visible = const {
        ReconnectPhase.offline,
        ReconnectPhase.reconciling,
        ReconnectPhase.degraded,
      }.contains(phase);
      final scheme = Theme.of(context).colorScheme;
      final (icon, message, color) = switch (phase) {
        ReconnectPhase.offline => (
          Icons.cloud_off_rounded,
          'Offline · showing encrypted local projections',
          scheme.tertiaryContainer,
        ),
        ReconnectPhase.reconciling => (
          Icons.sync_rounded,
          'Reconnected · reconciling local and server state',
          scheme.primaryContainer,
        ),
        ReconnectPhase.degraded => (
          Icons.sync_problem_rounded,
          'Some views could not reconcile · retrying remains safe',
          scheme.errorContainer,
        ),
        _ => (Icons.cloud_done_rounded, '', scheme.surface),
      };
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
