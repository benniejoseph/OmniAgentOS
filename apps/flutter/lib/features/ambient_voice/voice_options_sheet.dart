import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/mobile/mobile_page_scaffold.dart';
import '../companion/companion_personality_settings.dart';
import '../companion/companion_providers.dart';
import '../companion/companion_settings.dart';
import '../companion/voice_appearance_settings.dart';
import 'voice_conversation_controller.dart';

/// The call remains mounted while its presentation and next-call settings open.
class MobileVoiceOptions extends ConsumerStatefulWidget {
  const MobileVoiceOptions({
    super.key,
    required this.voice,
    required this.contextSummary,
    required this.current,
    this.onEditContext,
    this.onModels,
  });
  final VoiceConversationController voice;
  final String Function() contextSummary;
  final bool Function() current;
  final Future<void> Function()? onEditContext;
  final VoidCallback? onModels;
  @override
  ConsumerState<MobileVoiceOptions> createState() => _MobileVoiceOptionsState();
}

class _MobileVoiceOptionsState extends ConsumerState<MobileVoiceOptions> {
  int _section = 0;
  late final _scope = ref.read(companionScopeProvider);

  @override
  Widget build(BuildContext context) {
    final scope = ref.watch(companionScopeProvider);
    if (_scope == null || scope != _scope || !widget.current()) {
      return const Padding(
        padding: EdgeInsets.all(20),
        child: Text('Unlock your workspace to change voice options.'),
      );
    }
    final companion = ref.watch(companionControllerProvider);
    return ListenableBuilder(
      listenable: widget.voice,
      builder: (context, _) {
        if (!widget.current()) return const SizedBox.shrink();
        final theme = Theme.of(context);
        final call = widget.voice;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            MobileSegmentBar<int>(
              items: const [
                (value: 0, label: 'This call', icon: Icons.graphic_eq_rounded),
                (
                  value: 1,
                  label: 'Appearance',
                  icon: Icons.face_retouching_natural_outlined,
                ),
                (
                  value: 2,
                  label: 'Personality',
                  icon: Icons.chat_bubble_outline_rounded,
                ),
                (value: 3, label: 'Behaviour', icon: Icons.tune_rounded),
              ],
              value: _section,
              onChanged: (value) => setState(() => _section = value),
            ),
            const SizedBox(height: 24),
            if (_section == 0) ...[
              MobileSurface(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(call.agentName, style: theme.textTheme.titleLarge),
                    const SizedBox(height: 8),
                    Text(
                      call.active
                          ? 'Connected · live conversation'
                          : 'Ready for your next conversation',
                      style: theme.textTheme.bodySmall,
                    ),
                    const SizedBox(height: 20),
                    Text(
                      call.active ? 'VOICE MODEL' : 'VOICE MODEL · NEXT CALL',
                      style: theme.textTheme.labelSmall?.copyWith(
                        letterSpacing: 1.2,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      call.active && call.modelName != null
                          ? _modelLabel(call.modelName!)
                          : 'Your configured voice model',
                      style: theme.textTheme.titleMedium,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'OpenAI · Cedar voice',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    if (widget.onModels != null) ...[
                      const SizedBox(height: 12),
                      TextButton.icon(
                        onPressed: () {
                          if (widget.current()) widget.onModels!();
                        },
                        icon: const Icon(Icons.tune_rounded, size: 18),
                        label: const Text('AI model settings'),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 12),
              MobileSurface(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Context', style: theme.textTheme.titleMedium),
                    const SizedBox(height: 8),
                    Text(widget.contextSummary()),
                    const SizedBox(height: 12),
                    Text(
                      call.active
                          ? 'This context stays with your current call. End the call before choosing different sources or a different workspace.'
                          : 'Choose which saved sources and workspace to bring into your next call.',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    if (widget.onEditContext != null) ...[
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                        onPressed: call.active
                            ? null
                            : () async {
                                if (!widget.current()) return;
                                await widget.onEditContext!();
                                if (mounted && widget.current())
                                  setState(() {});
                              },
                        icon: const Icon(Icons.layers_outlined, size: 19),
                        label: const Text('Choose context'),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 16),
              Text(
                'Voice captions are saved in History. Asael does not store the live audio.',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            if (_section == 1) const VoiceAppearanceSettings(),
            if (_section == 2) const CompanionPersonalitySettings(),
            if (_section == 3)
              CompanionSettingsEditor(
                key: ValueKey(companion),
                controller: companion,
                initialMobileTab: 2,
                showMobileTabs: false,
              ),
          ],
        );
      },
    );
  }
}

String _modelLabel(String value) => value
    .replaceAll('gpt-', 'GPT ')
    .replaceAll('realtime', 'Realtime')
    .replaceAll('_', ' ');
