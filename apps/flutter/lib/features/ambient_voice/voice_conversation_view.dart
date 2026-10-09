import 'package:flutter/material.dart';

import '../companion/companion_models.dart';
import '../companion/companion_presence.dart';
import 'voice_conversation_controller.dart';

class VoiceConversationSurface extends StatelessWidget {
  const VoiceConversationSurface({
    super.key,
    required this.controller,
    required this.consentRequired,
    required this.onStart,
    required this.onEnd,
    this.starting = false,
    this.startError,
    this.selectedAgentName = 'ATLAS',
    this.companionPreferences,
  });

  final VoiceConversationController controller;
  final bool consentRequired;
  final bool starting;
  final String? startError;
  final String selectedAgentName;
  final VoidCallback onStart;
  final VoidCallback onEnd;
  final CompanionPreferences? companionPreferences;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final active = controller.active;
    final connecting =
        starting || controller.phase == VoiceConversationPhase.connecting;
    final speaking = controller.phase == VoiceConversationPhase.speaking;
    final error = startError ?? controller.errorMessage;
    final agent = active ? controller.agentName : selectedAgentName;
    final status = connecting
        ? 'Connecting…'
        : !active
        ? error == null
              ? 'Ready to talk'
              : 'Needs attention'
        : controller.muted
        ? 'Microphone muted'
        : speaking
        ? 'Speaking'
        : controller.phase == VoiceConversationPhase.working
        ? 'Working · still listening'
        : 'Listening';
    final detail =
        error ??
        (!active
            ? consentRequired
                  ? 'Start agrees to OpenAI processing live audio and your selected context. Captions are saved in History; Asael does not store the audio.'
                  : 'Speak naturally. Pause for a reply, or speak over it to interrupt. Requests use $agent and your selected context.'
            : connecting
            ? 'Opening your private audio connection.'
            : controller.caption.isNotEmpty
            ? controller.caption
            : 'Pause for a reply. Speak at any time to interrupt.');
    final tone = error != null
        ? scheme.error
        : speaking
        ? scheme.tertiary
        : scheme.primary;
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Material(
        color: scheme.surfaceContainerLow,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(30),
          side: BorderSide(color: tone.withValues(alpha: .2)),
        ),
        clipBehavior: Clip.antiAlias,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 14, 16, 14),
          child: Row(
            children: [
              CompanionPortrait(
                visible: companionPreferences?.visible == true,
                preferences: companionPreferences,
                state: error != null
                    ? 'blocked'
                    : speaking
                    ? 'responding'
                    : active && !controller.muted
                    ? 'listening'
                    : 'available',
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          width: 7,
                          height: 7,
                          decoration: BoxDecoration(
                            color: tone,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            '$agent · $status',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      detail,
                      maxLines: active ? 3 : 4,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: error != null
                            ? scheme.error
                            : scheme.onSurfaceVariant,
                        height: 1.4,
                      ),
                    ),
                    if (controller.historyNotice != null) ...[
                      const SizedBox(height: 5),
                      Text(
                        controller.historyNotice!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: scheme.tertiary,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 14),
              Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  if (active || connecting)
                    IconButton.filledTonal(
                      tooltip: controller.muted
                          ? 'Unmute microphone'
                          : 'Mute microphone',
                      onPressed: controller.ready
                          ? () => controller.setMuted(!controller.muted)
                          : null,
                      icon: Icon(
                        controller.muted
                            ? Icons.mic_off_rounded
                            : Icons.mic_rounded,
                      ),
                    )
                  else
                    FilledButton.icon(
                      onPressed: onStart,
                      icon: const Icon(Icons.mic_rounded, size: 18),
                      label: const Text('Start'),
                    ),
                  const SizedBox(height: 6),
                  TextButton.icon(
                    onPressed: onEnd,
                    icon: Icon(
                      active || connecting
                          ? Icons.call_end_rounded
                          : Icons.close_rounded,
                      size: 16,
                    ),
                    label: Text(active || connecting ? 'End' : 'Close'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
