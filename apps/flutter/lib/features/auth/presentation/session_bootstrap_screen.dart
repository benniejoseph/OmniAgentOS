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

class _MacosSessionBootstrap extends StatelessWidget {
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
  Widget build(BuildContext context) {
    final failed = session.hasError;
    final title = migrationRequired
        ? 'Upgrade your protected session'
        : biometricLocked
        ? 'Unlock Asael'
        : 'This session needs attention';
    final detail = migrationRequired
        ? 'Move the previous credential into this Mac’s protected storage before continuing.'
        : biometricLocked
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
                              if (onClear != null)
                                TextButton(
                                  onPressed: onClear,
                                  child: const Text('Sign in again'),
                                ),
                              const SizedBox(width: 8),
                              FilledButton.icon(
                                onPressed: onPrimary,
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
                          Text(
                            'Verifying this Mac and reconciling protected session state.',
                            textAlign: TextAlign.center,
                            style: Theme.of(context).textTheme.bodyMedium
                                ?.copyWith(
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
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
