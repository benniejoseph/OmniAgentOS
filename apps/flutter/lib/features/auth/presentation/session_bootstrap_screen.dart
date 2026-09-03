import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../application/session_controller.dart';

class SessionBootstrapScreen extends ConsumerWidget {
  const SessionBootstrapScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionControllerProvider);
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
                          Icons.cloud_off_rounded,
                          size: 38,
                          color: Theme.of(context).colorScheme.error,
                        ),
                        const SizedBox(height: 18),
                        Text(
                          'Unable to verify this session',
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
                          onPressed: () => ref
                              .read(sessionControllerProvider.notifier)
                              .retry(),
                          icon: const Icon(Icons.refresh_rounded),
                          label: const Text('Try again'),
                        ),
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
                  ],
                ),
        ),
      ),
    );
  }
}
