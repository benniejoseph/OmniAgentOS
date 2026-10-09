import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'atlas_player.dart';
import 'companion_models.dart';
import 'voice_appearance.dart';

class VoiceAppearanceSettings extends ConsumerWidget {
  const VoiceAppearanceSettings({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.watch(voiceAppearanceProvider);
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Voice appearance', style: theme.textTheme.titleMedium),
        const SizedBox(height: 6),
        Text(
          'Choose how ATLAS stays beside you. Saved on this device; switching keeps your conversation connected.',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 12),
        LayoutBuilder(
          builder: (context, constraints) {
            final stacked = constraints.maxWidth < 480;
            final cards = [
              for (final appearance in VoiceAppearance.values)
                SizedBox(
                  width: stacked
                      ? constraints.maxWidth
                      : (constraints.maxWidth - 12) / 2,
                  child: _AppearanceChoice(
                    appearance: appearance,
                    selected: controller.appearance == appearance,
                    onTap: controller.available
                        ? () => controller.setAppearance(appearance)
                        : null,
                  ),
                ),
            ];
            return Wrap(spacing: 12, runSpacing: 12, children: cards);
          },
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

class _AppearanceChoice extends StatelessWidget {
  const _AppearanceChoice({
    required this.appearance,
    required this.selected,
    this.onTap,
  });

  final VoiceAppearance appearance;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final perch = appearance == VoiceAppearance.perch;
    return Semantics(
      button: true,
      selected: selected,
      label:
          '${appearance.label}. ${perch ? 'A free-standing character with floating captions.' : 'A compact dock with ATLAS and your captions together.'}',
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
                ExcludeSemantics(
                  child: SizedBox(
                    height: 124,
                    width: double.infinity,
                    child: Center(
                      child: perch
                          ? const AtlasPortrait(
                              state: 'listening',
                              size: 120,
                              preferences: CompanionPreferences(
                                intensity: 'quiet',
                                motion: 'off',
                              ),
                            )
                          : Container(
                              constraints: const BoxConstraints(maxWidth: 272),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 10,
                                vertical: 8,
                              ),
                              decoration: BoxDecoration(
                                color: scheme.surfaceContainerLow,
                                borderRadius: BorderRadius.circular(16),
                              ),
                              child: Row(
                                children: [
                                  const AtlasPortrait(
                                    size: 72,
                                    preferences: CompanionPreferences(
                                      intensity: 'quiet',
                                      motion: 'off',
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  Expanded(
                                    child: Column(
                                      mainAxisSize: MainAxisSize.min,
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          'ATLAS',
                                          style: theme.textTheme.labelMedium,
                                        ),
                                        const SizedBox(height: 7),
                                        Container(
                                          height: 5,
                                          width: 66,
                                          decoration: BoxDecoration(
                                            color: scheme.onSurfaceVariant
                                                .withValues(alpha: .35),
                                            borderRadius: BorderRadius.circular(
                                              3,
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                  Icon(
                                    Icons.mic_none_rounded,
                                    size: 16,
                                    color: scheme.onSurfaceVariant,
                                  ),
                                ],
                              ),
                            ),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        appearance.label,
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    if (selected)
                      Icon(
                        Icons.check_circle_rounded,
                        size: 19,
                        color: scheme.primary,
                      ),
                  ],
                ),
                const SizedBox(height: 5),
                Text(
                  perch
                      ? 'More character. ATLAS sits beside a floating caption.'
                      : 'Close at hand. A small dock keeps everything together.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                    height: 1.4,
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
