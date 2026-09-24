import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../app/brand/asael_mascot.dart';
import '../../app/brand/asael_mark.dart';

enum AmbientVoicePhase {
  asleep,
  starting,
  listening,
  transcribing,
  review,
  running,
  speaking,
  approval,
  completed,
  offline,
  error,
}

class AmbientVoiceSurface extends StatelessWidget {
  const AmbientVoiceSurface({
    super.key,
    required this.phase,
    required this.level,
    required this.transcript,
    required this.focusNode,
    required this.useThisMac,
    required this.thisMacAvailable,
    required this.detail,
    required this.onDestinationChanged,
    required this.onMicrophonePressed,
    required this.onSend,
    required this.onStop,
    required this.onReviewApproval,
    required this.onClose,
    this.error,
    this.lastResult,
  });

  final AmbientVoicePhase phase;
  final double level;
  final TextEditingController transcript;
  final FocusNode focusNode;
  final bool useThisMac;
  final bool thisMacAvailable;
  final String detail;
  final ValueChanged<bool> onDestinationChanged;
  final VoidCallback? onMicrophonePressed;
  final VoidCallback? onSend;
  final VoidCallback? onStop;
  final VoidCallback? onReviewApproval;
  final VoidCallback onClose;
  final String? error;
  final String? lastResult;

  bool get _capturing =>
      phase == AmbientVoicePhase.starting ||
      phase == AmbientVoicePhase.listening ||
      phase == AmbientVoicePhase.transcribing;

  bool get _working =>
      phase == AmbientVoicePhase.running ||
      phase == AmbientVoicePhase.speaking ||
      phase == AmbientVoicePhase.approval;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final reducedMotion = MediaQuery.disableAnimationsOf(context);
    final presentation = _presentation(phase, scheme);
    return Scaffold(
      backgroundColor: scheme.surface,
      body: SafeArea(
        child: Semantics(
          liveRegion: true,
          label: '${presentation.title}. $detail',
          child: Padding(
            padding: const EdgeInsets.fromLTRB(22, 16, 18, 18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    const AsaelMark(size: 28),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Ambient Command',
                            style: Theme.of(context).textTheme.titleMedium
                                ?.copyWith(fontWeight: FontWeight.w700),
                          ),
                          Text(
                            useThisMac
                                ? 'Using this Mac'
                                : 'Talking with Asael',
                            style: Theme.of(context).textTheme.bodySmall
                                ?.copyWith(color: scheme.onSurfaceVariant),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: 'Close Ambient Command (Esc)',
                      onPressed: onClose,
                      icon: const Icon(Icons.close_rounded, size: 19),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SizedBox(
                        width: 176,
                        child: _AmbientPresence(
                          phase: phase,
                          level: level,
                          color: presentation.color,
                          reducedMotion: reducedMotion,
                        ),
                      ),
                      const SizedBox(width: 20),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            AnimatedSwitcher(
                              duration: reducedMotion
                                  ? Duration.zero
                                  : const Duration(milliseconds: 180),
                              transitionBuilder: (child, animation) =>
                                  FadeTransition(
                                    opacity: animation,
                                    child: SlideTransition(
                                      position: Tween<Offset>(
                                        begin: const Offset(0, .08),
                                        end: Offset.zero,
                                      ).animate(animation),
                                      child: child,
                                    ),
                                  ),
                              child: Column(
                                key: ValueKey(phase),
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    presentation.title,
                                    style: Theme.of(context)
                                        .textTheme
                                        .headlineSmall
                                        ?.copyWith(
                                          fontWeight: FontWeight.w700,
                                          letterSpacing: -.35,
                                        ),
                                  ),
                                  const SizedBox(height: 3),
                                  Text(
                                    detail,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: Theme.of(context)
                                        .textTheme
                                        .bodyMedium
                                        ?.copyWith(
                                          color: scheme.onSurfaceVariant,
                                        ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 14),
                            Expanded(
                              child: TextField(
                                controller: transcript,
                                focusNode: focusNode,
                                readOnly: _capturing || _working,
                                minLines: null,
                                maxLines: null,
                                expands: true,
                                textAlignVertical: TextAlignVertical.top,
                                style: Theme.of(context).textTheme.bodyLarge
                                    ?.copyWith(height: 1.42),
                                decoration: InputDecoration(
                                  hintText: phase == AmbientVoicePhase.listening
                                      ? 'Your words will appear here…'
                                      : 'Speak naturally or type your request…',
                                  filled: true,
                                  fillColor: scheme.surfaceContainerLow,
                                  contentPadding: const EdgeInsets.all(14),
                                  border: OutlineInputBorder(
                                    borderRadius: BorderRadius.circular(11),
                                    borderSide: BorderSide(
                                      color: scheme.outlineVariant,
                                    ),
                                  ),
                                  enabledBorder: OutlineInputBorder(
                                    borderRadius: BorderRadius.circular(11),
                                    borderSide: BorderSide(
                                      color: scheme.outlineVariant,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                            if (error case final message?) ...[
                              const SizedBox(height: 7),
                              Text(
                                message,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: Theme.of(context).textTheme.bodySmall
                                    ?.copyWith(color: scheme.error),
                              ),
                            ] else if (lastResult case final result?) ...[
                              const SizedBox(height: 7),
                              Text(
                                result,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: Theme.of(context).textTheme.bodySmall
                                    ?.copyWith(color: scheme.onSurfaceVariant),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                Row(
                  children: [
                    _DestinationSwitch(
                      useThisMac: useThisMac,
                      thisMacAvailable: thisMacAvailable,
                      enabled: !_working && !_capturing,
                      onChanged: onDestinationChanged,
                    ),
                    const Spacer(),
                    if (phase == AmbientVoicePhase.speaking)
                      OutlinedButton.icon(
                        onPressed: onMicrophonePressed,
                        icon: const Icon(Icons.mic_rounded, size: 17),
                        label: const Text('Interrupt & speak'),
                      )
                    else if (_working)
                      OutlinedButton.icon(
                        onPressed: onStop,
                        icon: const Icon(Icons.stop_rounded, size: 17),
                        label: const Text('Stop'),
                      )
                    else
                      OutlinedButton.icon(
                        onPressed: onMicrophonePressed,
                        icon: Icon(
                          phase == AmbientVoicePhase.listening
                              ? Icons.stop_rounded
                              : Icons.mic_none_rounded,
                          size: 17,
                        ),
                        label: Text(
                          phase == AmbientVoicePhase.listening
                              ? 'Finish speaking'
                              : 'Speak again',
                        ),
                      ),
                    const SizedBox(width: 8),
                    if (phase == AmbientVoicePhase.approval)
                      FilledButton.icon(
                        onPressed: onReviewApproval,
                        icon: const Icon(Icons.open_in_new_rounded, size: 17),
                        label: const Text('Review action'),
                      )
                    else
                      FilledButton.icon(
                        onPressed: onSend,
                        icon: Icon(
                          useThisMac
                              ? Icons.arrow_forward_rounded
                              : Icons.arrow_upward_rounded,
                          size: 17,
                        ),
                        label: Text(useThisMac ? 'Use this Mac' : 'Ask Asael'),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _AmbientPresence extends StatefulWidget {
  const _AmbientPresence({
    required this.phase,
    required this.level,
    required this.color,
    required this.reducedMotion,
  });

  final AmbientVoicePhase phase;
  final double level;
  final Color color;
  final bool reducedMotion;

  @override
  State<_AmbientPresence> createState() => _AmbientPresenceState();
}

class _AmbientPresenceState extends State<_AmbientPresence>
    with SingleTickerProviderStateMixin {
  late final AnimationController animation = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1700),
  );

  @override
  void initState() {
    super.initState();
    if (!widget.reducedMotion) animation.repeat();
  }

  @override
  void didUpdateWidget(covariant _AmbientPresence oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.reducedMotion) {
      animation
        ..stop()
        ..value = .35;
    } else if (!animation.isAnimating) {
      animation.repeat();
    }
  }

  @override
  void dispose() {
    animation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final active =
        widget.phase != AmbientVoicePhase.review &&
        widget.phase != AmbientVoicePhase.asleep &&
        widget.phase != AmbientVoicePhase.completed;
    final mascotState = switch (widget.phase) {
      AmbientVoicePhase.listening => AsaelMascotState.listening,
      AmbientVoicePhase.starting ||
      AmbientVoicePhase.transcribing => AsaelMascotState.transcribing,
      AmbientVoicePhase.running ||
      AmbientVoicePhase.speaking => AsaelMascotState.working,
      AmbientVoicePhase.completed => AsaelMascotState.success,
      AmbientVoicePhase.approval ||
      AmbientVoicePhase.error ||
      AmbientVoicePhase.offline => AsaelMascotState.attention,
      _ => AsaelMascotState.ready,
    };
    return AnimatedBuilder(
      animation: animation,
      builder: (context, _) {
        final wave = (math.sin(animation.value * math.pi * 2) + 1) / 2;
        final microphoneResponse = widget.phase == AmbientVoicePhase.listening
            ? widget.level.clamp(.08, 1.0)
            : .15 + wave * .15;
        return Center(
          child: Stack(
            alignment: Alignment.center,
            children: [
              AnimatedContainer(
                duration: const Duration(milliseconds: 130),
                width: active ? 126 + microphoneResponse * 18 : 122,
                height: active ? 126 + microphoneResponse * 18 : 122,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: widget.color.withValues(alpha: .045),
                  border: Border.all(
                    color: widget.color.withValues(
                      alpha: active ? .18 + microphoneResponse * .12 : .12,
                    ),
                  ),
                ),
              ),
              Container(
                width: 104,
                height: 104,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: Theme.of(context).colorScheme.surfaceContainerLow,
                  boxShadow: [
                    BoxShadow(
                      color: widget.color.withValues(alpha: .12),
                      blurRadius: 28,
                      spreadRadius: 2,
                    ),
                  ],
                ),
                alignment: Alignment.center,
                child: AsaelMascot(state: mascotState, size: 78),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _DestinationSwitch extends StatelessWidget {
  const _DestinationSwitch({
    required this.useThisMac,
    required this.thisMacAvailable,
    required this.enabled,
    required this.onChanged,
  });

  final bool useThisMac;
  final bool thisMacAvailable;
  final bool enabled;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) => SegmentedButton<bool>(
    segments: [
      const ButtonSegment<bool>(
        value: false,
        icon: Icon(Icons.auto_awesome_outlined, size: 16),
        label: Text('Ask Asael'),
      ),
      ButtonSegment<bool>(
        value: true,
        enabled: thisMacAvailable,
        icon: const Icon(Icons.laptop_mac_rounded, size: 16),
        label: const Text('Use this Mac'),
      ),
    ],
    selected: {useThisMac},
    showSelectedIcon: false,
    onSelectionChanged: !enabled
        ? null
        : (selection) => onChanged(selection.first),
    style: ButtonStyle(
      visualDensity: VisualDensity.compact,
      padding: const WidgetStatePropertyAll(
        EdgeInsets.symmetric(horizontal: 11, vertical: 8),
      ),
    ),
  );
}

({String title, Color color}) _presentation(
  AmbientVoicePhase phase,
  ColorScheme scheme,
) => switch (phase) {
  AmbientVoicePhase.asleep => (
    title: 'Ready when you are',
    color: scheme.primary,
  ),
  AmbientVoicePhase.starting => (
    title: 'Opening the microphone…',
    color: scheme.primary,
  ),
  AmbientVoicePhase.listening => (
    title: 'I’m listening',
    color: scheme.primary,
  ),
  AmbientVoicePhase.transcribing => (
    title: 'Turning that into words…',
    color: scheme.secondary,
  ),
  AmbientVoicePhase.review => (
    title: 'Does this look right?',
    color: scheme.primary,
  ),
  AmbientVoicePhase.running => (title: 'Working on it', color: scheme.primary),
  AmbientVoicePhase.speaking => (
    title: 'Here’s what I found',
    color: scheme.primary,
  ),
  AmbientVoicePhase.approval => (
    title: 'Your approval is needed',
    color: scheme.tertiary,
  ),
  AmbientVoicePhase.completed => (title: 'Done', color: scheme.tertiary),
  AmbientVoicePhase.offline => (
    title: 'Connection unavailable',
    color: scheme.tertiary,
  ),
  AmbientVoicePhase.error => (title: 'I need your help', color: scheme.error),
};
