import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'companion_personality.dart';

class CompanionPersonalitySettings extends ConsumerWidget {
  const CompanionPersonalitySettings({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.watch(companionPersonalityProvider);
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Personality', style: theme.textTheme.titleMedium),
        const SizedBox(height: 6),
        Text(
          'Give ATLAS a tone that suits you. Saved on this device; applies to your next message or new voice conversation.',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 12),
        LayoutBuilder(
          builder: (context, constraints) => Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              for (final personality in CompanionPersonality.values)
                SizedBox(
                  width: constraints.maxWidth < 480
                      ? constraints.maxWidth
                      : (constraints.maxWidth - 12) / 2,
                  child: _PersonalityChoice(
                    personality: personality,
                    selected: controller.personality == personality,
                    onTap: controller.available
                        ? () => controller.setPersonality(personality)
                        : null,
                  ),
                ),
            ],
          ),
        ),
        if (controller.persistenceNotice != null) ...[
          const SizedBox(height: 8),
          Text(
            controller.persistenceNotice!,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.error,
            ),
          ),
        ],
      ],
    );
  }
}

class _PersonalityChoice extends StatelessWidget {
  const _PersonalityChoice({
    required this.personality,
    required this.selected,
    this.onTap,
  });

  final CompanionPersonality personality;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final playful = personality == CompanionPersonality.playful;
    return Semantics(
      button: true,
      selected: selected,
      label: '${personality.label}. ${personality.description}.',
      child: Material(
        color: selected
            ? scheme.primaryContainer.withValues(alpha: .25)
            : scheme.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(
            color: selected ? scheme.primary : scheme.outlineVariant,
            width: selected ? 1.5 : 1,
          ),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      playful
                          ? Icons.celebration_outlined
                          : Icons.local_cafe_outlined,
                      size: 22,
                      color: scheme.primary,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        personality.label,
                        style: theme.textTheme.titleSmall,
                      ),
                    ),
                    Icon(
                      selected ? Icons.check_circle : Icons.circle_outlined,
                      size: 20,
                      color: selected ? scheme.primary : scheme.outline,
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  personality.description,
                  style: theme.textTheme.bodyMedium,
                ),
                const SizedBox(height: 8),
                Text(
                  playful
                      ? '“Right, that to-do list has had its fun. Our turn.”'
                      : '“Certainly. Let’s put the chaos in order.”',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                    fontStyle: FontStyle.italic,
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
