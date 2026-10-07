import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// Keeps the existing Results and Activity routes and their owner-scoped
/// controllers, while presenting them as two views of the same work history.
class HistoryWorkspace extends StatelessWidget {
  const HistoryWorkspace({
    super.key,
    required this.timeline,
    required this.child,
  });
  final bool timeline;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final motion = MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : const Duration(milliseconds: 200);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
          child: Align(
            alignment: Alignment.centerLeft,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Container(
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(10),
                ),
                padding: const EdgeInsets.all(4),
                child: Stack(
                  children: [
                    Positioned.fill(
                      child: AnimatedAlign(
                        alignment: timeline
                            ? Alignment.centerRight
                            : Alignment.centerLeft,
                        duration: motion,
                        curve: Curves.easeOutCubic,
                        child: FractionallySizedBox(
                          widthFactor: 0.5,
                          heightFactor: 1,
                          child: DecoratedBox(
                            decoration: BoxDecoration(
                              color: scheme.surface,
                              border: Border.all(color: scheme.outlineVariant),
                              borderRadius: BorderRadius.circular(8),
                            ),
                          ),
                        ),
                      ),
                    ),
                    Row(
                      children: [
                        _HistoryTab(
                          label: 'Results',
                          icon: Icons.description_outlined,
                          selected: !timeline,
                          onTap: () => context.go('/results'),
                        ),
                        _HistoryTab(
                          label: 'Timeline',
                          icon: Icons.history_rounded,
                          selected: timeline,
                          onTap: () => context.go('/activity'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        Expanded(child: child),
      ],
    );
  }
}

class _HistoryTab extends StatelessWidget {
  const _HistoryTab({
    required this.label,
    required this.icon,
    required this.selected,
    required this.onTap,
  });
  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Expanded(
    child: Semantics(
      selected: selected,
      child: TextButton.icon(
        style: TextButton.styleFrom(
          minimumSize: const Size(48, 48),
          foregroundColor: selected
              ? Theme.of(context).colorScheme.onSurface
              : Theme.of(context).colorScheme.onSurfaceVariant,
          textStyle: TextStyle(
            fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
          ),
        ),
        onPressed: selected ? () {} : onTap,
        icon: Icon(icon, size: 18),
        label: Text(label),
      ),
    ),
  );
}
