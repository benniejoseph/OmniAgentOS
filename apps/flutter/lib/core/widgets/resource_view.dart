import 'package:flutter/material.dart';

import '../state/resource_state.dart';

class ResourceView<T> extends StatelessWidget {
  const ResourceView({
    super.key,
    required this.state,
    required this.data,
    this.onRetry,
    this.empty,
  });

  final ResourceState<T> state;
  final Widget Function(T value) data;
  final VoidCallback? onRetry;
  final Widget? empty;

  @override
  Widget build(BuildContext context) => state.when(
    idle: () => empty ?? const SizedBox.shrink(),
    loading: () => const Center(child: CircularProgressIndicator()),
    ready: data,
    failed: (error) => Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.error_outline_rounded,
              size: 36,
              color: Theme.of(context).colorScheme.error,
            ),
            const SizedBox(height: 12),
            Text(error.toString(), textAlign: TextAlign.center),
            if (onRetry != null) ...[
              const SizedBox(height: 16),
              OutlinedButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh_rounded),
                label: const Text('Try again'),
              ),
            ],
          ],
        ),
      ),
    ),
  );
}
