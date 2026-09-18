import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/brand/asael_mark.dart';
import '../../../app/macos/macos_page_scaffold.dart';
import '../../../app/platform/macos_presentation.dart';
import '../../../app/theme/macos_workspace_backdrop.dart';
import '../../../core/auth/biometric_gate.dart';
import '../../../core/storage/secure_session_store.dart';
import '../application/session_controller.dart';

class SessionBootstrapScreen extends ConsumerWidget {
  const SessionBootstrapScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionControllerProvider);
    final biometricLocked = session.error is BiometricGateException;
    final migrationRequired =
        session.error is SecureStoreMigrationRequiredException;
    if (usesMacosPresentation()) {
      return _MacosSessionBootstrap(
        session: session,
        biometricLocked: biometricLocked,
        migrationRequired: migrationRequired,
        onPrimary: () {
          final controller = ref.read(sessionControllerProvider.notifier);
          if (migrationRequired) {
            controller.migrateLegacyCredentials();
          } else {
            controller.retry();
          }
        },
        onClear: migrationRequired
            ? null
            : () => ref.read(sessionControllerProvider.notifier).signOut(),
      );
    }
    return Scaffold(
      body: Center(
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 240),
          child: session.hasError
              ? ConstrainedBox(
                  key: const ValueKey('error'),
                  constraints: const BoxConstraints(maxWidth: 360),
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          migrationRequired
                              ? Icons.key_rounded
                              : biometricLocked
                              ? Icons.fingerprint_rounded
                              : Icons.cloud_off_rounded,
                          size: 38,
                          color: Theme.of(context).colorScheme.error,
                        ),
                        const SizedBox(height: 18),
                        Text(
                          migrationRequired
                              ? 'Upgrade your protected session'
                              : biometricLocked
                              ? 'Unlock Asael'
                              : 'Unable to verify this session',
                          style: Theme.of(context).textTheme.titleLarge,
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          session.error.toString(),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 22),
                        FilledButton.icon(
                          onPressed: () {
                            final controller = ref.read(
                              sessionControllerProvider.notifier,
                            );
                            if (migrationRequired) {
                              controller.migrateLegacyCredentials();
                            } else {
                              controller.retry();
                            }
                          },
                          icon: Icon(
                            migrationRequired
                                ? Icons.upgrade_rounded
                                : biometricLocked
                                ? Icons.fingerprint_rounded
                                : Icons.refresh_rounded,
                          ),
                          label: Text(
                            migrationRequired
                                ? 'Upgrade securely'
                                : biometricLocked
                                ? 'Unlock'
                                : 'Try again',
                          ),
                        ),
                        if (!migrationRequired)
                          TextButton(
                            onPressed: () => ref
                                .read(sessionControllerProvider.notifier)
                                .signOut(),
                            child: const Text('Clear session'),
                          ),
                      ],
                    ),
                  ),
                )
              : Column(
                  key: const ValueKey('loading'),
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 52,
                      height: 52,
                      decoration: BoxDecoration(
                        color: Theme.of(context).colorScheme.primary,
                        borderRadius: BorderRadius.circular(16),
                      ),
                      child: const Icon(Icons.hub_rounded, color: Colors.white),
                    ),
                    const SizedBox(height: 24),
                    const SizedBox.square(
                      dimension: 24,
                      child: CircularProgressIndicator(strokeWidth: 2.5),
                    ),
                    const SizedBox(height: 16),
                    Text(
                      'Securing your private workspace…',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'Checking this device without exposing your credentials.',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

class _MacosSessionBootstrap extends StatefulWidget {
  const _MacosSessionBootstrap({
    required this.session,
    required this.biometricLocked,
    required this.migrationRequired,
    required this.onPrimary,
    required this.onClear,
  });

  final AsyncValue<Object?> session;
  final bool biometricLocked;
  final bool migrationRequired;
  final VoidCallback onPrimary;
  final VoidCallback? onClear;

  @override
  State<_MacosSessionBootstrap> createState() => _MacosSessionBootstrapState();
}

class _MacosSessionBootstrapState extends State<_MacosSessionBootstrap> {
  static const _longRestoreThreshold = Duration(seconds: 12);

  Timer? _longRestoreTimer;
  bool _isTakingLonger = false;

  @override
  void initState() {
    super.initState();
    _scheduleLongRestoreMessage();
  }

  @override
  void didUpdateWidget(covariant _MacosSessionBootstrap oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.session.hasError != widget.session.hasError) {
      _scheduleLongRestoreMessage();
    }
  }

  @override
  void dispose() {
    _longRestoreTimer?.cancel();
    super.dispose();
  }

  void _scheduleLongRestoreMessage() {
    _longRestoreTimer?.cancel();
    _isTakingLonger = false;
    if (widget.session.hasError) {
      return;
    }
    _longRestoreTimer = Timer(_longRestoreThreshold, () {
      if (!mounted || widget.session.hasError) {
        return;
      }
      setState(() => _isTakingLonger = true);
    });
  }

  @override
  Widget build(BuildContext context) {
    final failed = widget.session.hasError;
    final title = widget.migrationRequired
        ? 'Upgrade your protected session'
        : widget.biometricLocked
        ? 'Unlock Asael'
        : 'This session needs attention';
    final detail = widget.migrationRequired
        ? 'Move the previous credential into this Mac’s protected storage before continuing.'
        : widget.biometricLocked
        ? 'Use the enrolled biometric on this Mac to release your workspace credential.'
        : 'Asael could not confirm the saved session. Retry the secure check or clear it and sign in again.';
    return Scaffold(
      body: MacosWorkspaceBackdrop(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: MacosPane(
              padding: const EdgeInsets.all(24),
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 140),
                child: failed
                    ? Column(
                        key: const ValueKey('macos-bootstrap-error'),
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              const AsaelMark(size: 34),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Text(
                                  title,
                                  style: Theme.of(context).textTheme.titleLarge,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 16),
                          Text(detail),
                          const SizedBox(height: 20),
                          Row(
                            mainAxisAlignment: MainAxisAlignment.end,
                            children: [
                              if (widget.onClear != null)
                                TextButton(
                                  onPressed: widget.onClear,
                                  child: const Text('Sign in again'),
                                ),
                              const SizedBox(width: 8),
                              FilledButton.icon(
                                onPressed: widget.onPrimary,
                                icon: Icon(
                                  widget.migrationRequired
                                      ? Icons.upgrade_rounded
                                      : widget.biometricLocked
                                      ? Icons.fingerprint_rounded
                                      : Icons.refresh_rounded,
                                ),
                                label: Text(
                                  widget.migrationRequired
                                      ? 'Upgrade securely'
                                      : widget.biometricLocked
                                      ? 'Unlock'
                                      : 'Retry session',
                                ),
                              ),
                            ],
                          ),
                        ],
                      )
                    : Column(
                        key: const ValueKey('macos-bootstrap-loading'),
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const AsaelMark(size: 42),
                          const SizedBox(height: 20),
                          Text(
                            'Opening your private workspace',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 8),
                          Semantics(
                            liveRegion: true,
                            child: AnimatedSwitcher(
                              duration: const Duration(milliseconds: 160),
                              child: Text(
                                _isTakingLonger
                                    ? 'Still checking this Mac. A one-time protected-storage upgrade can take a little longer on first launch.'
                                    : 'Verifying this Mac and restoring your protected session.',
                                key: ValueKey(_isTakingLonger),
                                textAlign: TextAlign.center,
                                style: Theme.of(context).textTheme.bodyMedium
                                    ?.copyWith(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurfaceVariant,
                                    ),
                              ),
                            ),
                          ),
                          const SizedBox(height: 10),
                          Text(
                            _isTakingLonger
                                ? 'Protected storage check · Taking longer than usual'
                                : 'Protected session check · Started just now',
                            key: const ValueKey('macos-bootstrap-phase'),
                            style: Theme.of(context).textTheme.labelMedium
                                ?.copyWith(
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
                            textAlign: TextAlign.center,
                          ),
                          const SizedBox(height: 20),
                          const LinearProgressIndicator(minHeight: 2),
                        ],
                      ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
