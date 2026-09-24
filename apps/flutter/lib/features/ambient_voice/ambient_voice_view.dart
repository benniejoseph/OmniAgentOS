import 'dart:math' as math;

import 'package:flutter/material.dart';

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

/// Asael's compact, voice-only desktop presence.
///
/// Recognized words are deliberately read-only here. Ambient Command is a
/// voice surface, not a second Command composer. The ordinary governed command
/// path still owns review attestation, approvals, cancellation, and execution.
class AmbientVoiceSurface extends StatelessWidget {
  const AmbientVoiceSurface({
    super.key,
    required this.phase,
    required this.level,
    required this.transcript,
    required this.useThisMac,
    required this.thisMacAvailable,
    required this.thisMacUnavailableReason,
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
  final String transcript;
  final bool useThisMac;
  final bool thisMacAvailable;
  final String thisMacUnavailableReason;
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
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final reducedMotion = MediaQuery.disableAnimationsOf(context);
    final presentation = _presentation(phase, scheme);
    final recognized = transcript.trim();
    final reviewing =
        phase == AmbientVoicePhase.review && recognized.isNotEmpty;
    final supportingText = _supportingText(recognized);
    final liveStatus = reviewing
        ? '${presentation.title}. Recognized request: $recognized.'
        : '${presentation.title}. $supportingText.';
    final foreground = scheme.onSurface;
    final muted = scheme.onSurfaceVariant;
    final dark = scheme.brightness == Brightness.dark;
    final surface = Color.alphaBlend(
      presentation.color.withValues(alpha: dark ? .055 : .035),
      dark ? scheme.surfaceContainerHigh : scheme.surface,
    );

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Focus(
        autofocus: true,
        child: Semantics(
          liveRegion: true,
          label:
              '$liveStatus ${useThisMac ? 'This Mac destination.' : 'Asael destination.'}',
          child: Material(
            color: surface,
            elevation: 0,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(30),
              side: BorderSide(
                color: presentation.color.withValues(alpha: dark ? .22 : .16),
              ),
            ),
            clipBehavior: Clip.antiAlias,
            child: Stack(
              children: [
                Positioned.fill(
                  child: IgnorePointer(
                    child: _AmbientWash(
                      color: presentation.color,
                      reducedMotion: reducedMotion,
                      active: _capturing || _working,
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
                  child: Row(
                    children: [
                      _AmbientPresence(
                        phase: phase,
                        level: level,
                        color: presentation.color,
                        reducedMotion: reducedMotion,
                      ),
                      const SizedBox(width: 13),
                      Expanded(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                AnimatedContainer(
                                  duration: reducedMotion
                                      ? Duration.zero
                                      : const Duration(milliseconds: 180),
                                  width: 6,
                                  height: 6,
                                  decoration: BoxDecoration(
                                    color: presentation.color,
                                    shape: BoxShape.circle,
                                    boxShadow: [
                                      BoxShadow(
                                        color: presentation.color.withValues(
                                          alpha: .42,
                                        ),
                                        blurRadius: 8,
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(width: 7),
                                Expanded(
                                  child: AnimatedSwitcher(
                                    duration: reducedMotion
                                        ? Duration.zero
                                        : const Duration(milliseconds: 170),
                                    child: Text(
                                      presentation.title,
                                      key: ValueKey(presentation.title),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: theme.textTheme.titleSmall
                                          ?.copyWith(
                                            color: foreground,
                                            fontWeight: FontWeight.w700,
                                            letterSpacing: -.1,
                                          ),
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 4),
                            AnimatedSwitcher(
                              duration: reducedMotion
                                  ? Duration.zero
                                  : const Duration(milliseconds: 190),
                              transitionBuilder: (child, animation) =>
                                  FadeTransition(
                                    opacity: animation,
                                    child: SlideTransition(
                                      position: Tween<Offset>(
                                        begin: const Offset(0, .12),
                                        end: Offset.zero,
                                      ).animate(animation),
                                      child: child,
                                    ),
                                  ),
                              child: reviewing
                                  ? _ReviewTranscript(
                                      key: ValueKey('review:$recognized'),
                                      text: recognized,
                                      color: presentation.color,
                                      style: theme.textTheme.bodyMedium
                                          ?.copyWith(color: muted, height: 1.3),
                                    )
                                  : Text(
                                      supportingText,
                                      key: ValueKey('$phase:$supportingText'),
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                      style: theme.textTheme.bodyMedium
                                          ?.copyWith(
                                            color:
                                                phase == AmbientVoicePhase.error
                                                ? scheme.error
                                                : muted,
                                            height: 1.3,
                                          ),
                                    ),
                            ),
                            if (_capturing) ...[
                              const SizedBox(height: 8),
                              _VoiceTrace(
                                level: level,
                                phase: phase,
                                color: presentation.color,
                                reducedMotion: reducedMotion,
                              ),
                            ],
                          ],
                        ),
                      ),
                      if (phase == AmbientVoicePhase.review &&
                          (thisMacAvailable || useThisMac)) ...[
                        const SizedBox(width: 10),
                        _TargetButton(
                          useThisMac: useThisMac,
                          available: thisMacAvailable,
                          unavailableReason: thisMacUnavailableReason,
                          enabled: !_working && !_capturing,
                          onChanged: onDestinationChanged,
                        ),
                        const SizedBox(width: 6),
                      ],
                      _PrimaryAction(
                        phase: phase,
                        useThisMac: useThisMac,
                        color: presentation.color,
                        onMicrophonePressed: onMicrophonePressed,
                        onSend: onSend,
                        onStop: onStop,
                        onReviewApproval: onReviewApproval,
                      ),
                      const SizedBox(width: 2),
                      IconButton(
                        tooltip: 'Close Ambient Command (Esc)',
                        onPressed: onClose,
                        visualDensity: VisualDensity.compact,
                        iconSize: 17,
                        color: muted,
                        icon: const Icon(Icons.close_rounded),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _supportingText(String recognized) {
    final errorMessage = error;
    if (phase == AmbientVoicePhase.error && errorMessage != null) {
      return errorMessage;
    }
    final result = lastResult;
    if (phase == AmbientVoicePhase.completed && result != null) {
      return result;
    }
    if (phase == AmbientVoicePhase.running && result != null) {
      return result;
    }
    if (recognized.isNotEmpty && phase == AmbientVoicePhase.review) {
      return recognized;
    }
    return detail;
  }
}

class _ReviewTranscript extends StatefulWidget {
  const _ReviewTranscript({
    super.key,
    required this.text,
    required this.color,
    required this.style,
  });

  final String text;
  final Color color;
  final TextStyle? style;

  @override
  State<_ReviewTranscript> createState() => _ReviewTranscriptState();
}

class _ReviewTranscriptState extends State<_ReviewTranscript> {
  final ScrollController scrollController = ScrollController();

  @override
  void didUpdateWidget(covariant _ReviewTranscript oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.text != widget.text) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && scrollController.hasClients) {
          scrollController.jumpTo(0);
        }
      });
    }
  }

  @override
  void dispose() {
    scrollController.dispose();
    super.dispose();
  }

  Future<void> _showFullTranscript() => showDialog<void>(
    context: context,
    barrierLabel: 'Close recognized request review',
    builder: (context) =>
        _ExpandedReviewTranscript(text: widget.text, color: widget.color),
  );

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      label: 'Recognized request. ${widget.text}',
      hint: 'Scroll to read, or open the full review.',
      child: SizedBox(
        height: 48,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: widget.color.withValues(alpha: .045),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: Scrollbar(
                  controller: scrollController,
                  thumbVisibility: true,
                  child: SingleChildScrollView(
                    controller: scrollController,
                    primary: false,
                    padding: const EdgeInsets.fromLTRB(9, 6, 12, 6),
                    physics: const ClampingScrollPhysics(),
                    child: SelectableText(widget.text, style: widget.style),
                  ),
                ),
              ),
              IconButton(
                tooltip: 'Review the full recognized request',
                onPressed: _showFullTranscript,
                visualDensity: VisualDensity.compact,
                iconSize: 15,
                color: scheme.onSurfaceVariant,
                icon: const Icon(Icons.open_in_full_rounded),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ExpandedReviewTranscript extends StatefulWidget {
  const _ExpandedReviewTranscript({required this.text, required this.color});

  final String text;
  final Color color;

  @override
  State<_ExpandedReviewTranscript> createState() =>
      _ExpandedReviewTranscriptState();
}

class _ExpandedReviewTranscriptState extends State<_ExpandedReviewTranscript> {
  final ScrollController scrollController = ScrollController();

  @override
  void dispose() {
    scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final available = MediaQuery.sizeOf(context);
    final width = math
        .min(620.0, math.max(320.0, available.width - 16))
        .toDouble();
    final height = math
        .min(220.0, math.max(96.0, available.height - 16))
        .toDouble();
    return Dialog(
      insetPadding: const EdgeInsets.all(8),
      backgroundColor: scheme.surfaceContainerHigh,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      child: SizedBox(
        width: width,
        height: height,
        child: Semantics(
          label: 'Full recognized request. ${widget.text}',
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 9, 8, 9),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Icon(Icons.graphic_eq_rounded, size: 18, color: widget.color),
                const SizedBox(width: 9),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Recognized request',
                        style: theme.textTheme.labelLarge?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Expanded(
                        child: Scrollbar(
                          controller: scrollController,
                          thumbVisibility: true,
                          child: SingleChildScrollView(
                            controller: scrollController,
                            primary: false,
                            padding: const EdgeInsets.only(right: 12),
                            physics: const ClampingScrollPhysics(),
                            child: SelectableText(
                              widget.text,
                              style: theme.textTheme.bodyMedium?.copyWith(
                                height: 1.35,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: 'Close transcript review',
                  onPressed: () => Navigator.of(context).pop(),
                  visualDensity: VisualDensity.compact,
                  iconSize: 17,
                  icon: const Icon(Icons.close_rounded),
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
    duration: const Duration(milliseconds: 1500),
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
        ..value = .32;
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
    final active = switch (widget.phase) {
      AmbientVoicePhase.starting ||
      AmbientVoicePhase.listening ||
      AmbientVoicePhase.transcribing ||
      AmbientVoicePhase.running ||
      AmbientVoicePhase.speaking => true,
      _ => false,
    };
    return SizedBox.square(
      dimension: 58,
      child: AnimatedBuilder(
        animation: animation,
        builder: (context, _) {
          final wave = (math.sin(animation.value * math.pi * 2) + 1) / 2;
          final response = widget.phase == AmbientVoicePhase.listening
              ? widget.level.clamp(.08, 1.0)
              : .12 + wave * .16;
          return Stack(
            alignment: Alignment.center,
            children: [
              AnimatedContainer(
                duration: const Duration(milliseconds: 110),
                width: active ? 48 + response * 8 : 47,
                height: active ? 48 + response * 8 : 47,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: widget.color.withValues(alpha: .07),
                  border: Border.all(
                    color: widget.color.withValues(
                      alpha: active ? .28 + response * .18 : .18,
                    ),
                  ),
                ),
              ),
              Container(
                width: 39,
                height: 39,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: Theme.of(context).colorScheme.surfaceContainerLow,
                  boxShadow: [
                    BoxShadow(
                      color: widget.color.withValues(alpha: active ? .22 : .1),
                      blurRadius: active ? 18 : 10,
                      spreadRadius: active ? 1 : 0,
                    ),
                  ],
                ),
                alignment: Alignment.center,
                child: const AsaelMark(size: 25),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _VoiceTrace extends StatelessWidget {
  const _VoiceTrace({
    required this.level,
    required this.phase,
    required this.color,
    required this.reducedMotion,
  });

  final double level;
  final AmbientVoicePhase phase;
  final Color color;
  final bool reducedMotion;

  @override
  Widget build(BuildContext context) {
    final listening = phase == AmbientVoicePhase.listening;
    final energy = listening ? level.clamp(.06, 1.0) : .18;
    return Semantics(
      label: listening ? 'Microphone level' : 'Voice connection active',
      child: SizedBox(
        height: 9,
        child: Row(
          children: List.generate(18, (index) {
            final shape = .35 + .65 * math.sin((index + 1) * 1.7).abs();
            final lit = index / 18 <= energy;
            return Expanded(
              child: Padding(
                padding: const EdgeInsets.only(right: 2),
                child: AnimatedContainer(
                  duration: reducedMotion
                      ? Duration.zero
                      : const Duration(milliseconds: 90),
                  height: lit ? 3.5 + shape * 4.5 : 2,
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: lit ? .72 : .13),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
            );
          }),
        ),
      ),
    );
  }
}

class _AmbientWash extends StatefulWidget {
  const _AmbientWash({
    required this.color,
    required this.reducedMotion,
    required this.active,
  });

  final Color color;
  final bool reducedMotion;
  final bool active;

  @override
  State<_AmbientWash> createState() => _AmbientWashState();
}

class _AmbientWashState extends State<_AmbientWash>
    with SingleTickerProviderStateMixin {
  late final AnimationController animation = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2400),
  );

  @override
  void initState() {
    super.initState();
    if (!widget.reducedMotion) animation.repeat(reverse: true);
  }

  @override
  void didUpdateWidget(covariant _AmbientWash oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.reducedMotion) {
      animation
        ..stop()
        ..value = .4;
    } else if (!animation.isAnimating) {
      animation.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    animation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: animation,
    builder: (context, _) => DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment(-1 + animation.value * .18, -1),
          end: const Alignment(1, 1),
          colors: [
            widget.color.withValues(
              alpha: widget.active ? .075 + animation.value * .025 : .025,
            ),
            Colors.transparent,
            widget.color.withValues(alpha: widget.active ? .025 : .01),
          ],
          stops: const [0, .58, 1],
        ),
      ),
    ),
  );
}

class _TargetButton extends StatelessWidget {
  const _TargetButton({
    required this.useThisMac,
    required this.available,
    required this.unavailableReason,
    required this.enabled,
    required this.onChanged,
  });

  final bool useThisMac;
  final bool available;
  final String unavailableReason;
  final bool enabled;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final interactive = enabled && (available || useThisMac);
    final tooltip = useThisMac
        ? 'Send to Asael instead'
        : available
        ? 'Use this Mac'
        : unavailableReason;
    return Tooltip(
      message: tooltip,
      child: IconButton(
        onPressed: interactive ? () => onChanged(!useThisMac) : null,
        tooltip: tooltip,
        visualDensity: VisualDensity.compact,
        style: IconButton.styleFrom(
          fixedSize: const Size.square(38),
          backgroundColor: useThisMac ? scheme.primaryContainer : null,
          foregroundColor: useThisMac
              ? scheme.onPrimaryContainer
              : scheme.onSurfaceVariant,
          disabledForegroundColor: scheme.onSurfaceVariant.withValues(
            alpha: .32,
          ),
        ),
        icon: Icon(
          useThisMac ? Icons.laptop_mac_rounded : Icons.auto_awesome_outlined,
          size: 18,
        ),
      ),
    );
  }
}

class _PrimaryAction extends StatelessWidget {
  const _PrimaryAction({
    required this.phase,
    required this.useThisMac,
    required this.color,
    required this.onMicrophonePressed,
    required this.onSend,
    required this.onStop,
    required this.onReviewApproval,
  });

  final AmbientVoicePhase phase;
  final bool useThisMac;
  final Color color;
  final VoidCallback? onMicrophonePressed;
  final VoidCallback? onSend;
  final VoidCallback? onStop;
  final VoidCallback? onReviewApproval;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final action = switch (phase) {
      AmbientVoicePhase.starting || AmbientVoicePhase.transcribing => null,
      AmbientVoicePhase.listening => onMicrophonePressed,
      AmbientVoicePhase.review => onSend,
      AmbientVoicePhase.running => onStop,
      AmbientVoicePhase.speaking => onMicrophonePressed,
      AmbientVoicePhase.approval => onReviewApproval,
      AmbientVoicePhase.asleep ||
      AmbientVoicePhase.completed ||
      AmbientVoicePhase.offline ||
      AmbientVoicePhase.error => onMicrophonePressed,
    };
    final icon = switch (phase) {
      AmbientVoicePhase.listening => Icons.stop_rounded,
      AmbientVoicePhase.review =>
        useThisMac ? Icons.arrow_forward_rounded : Icons.arrow_upward_rounded,
      AmbientVoicePhase.running => Icons.stop_rounded,
      AmbientVoicePhase.speaking => Icons.mic_rounded,
      AmbientVoicePhase.approval => Icons.open_in_new_rounded,
      AmbientVoicePhase.starting ||
      AmbientVoicePhase.transcribing => Icons.more_horiz_rounded,
      _ => Icons.mic_rounded,
    };
    final tooltip = switch (phase) {
      AmbientVoicePhase.listening => 'Finish speaking',
      AmbientVoicePhase.review =>
        useThisMac ? 'Send to this Mac' : 'Send to Asael',
      AmbientVoicePhase.running => 'Stop',
      AmbientVoicePhase.speaking => 'Interrupt and speak',
      AmbientVoicePhase.approval => 'Review action',
      AmbientVoicePhase.starting => 'Opening microphone',
      AmbientVoicePhase.transcribing => 'Finishing transcript',
      _ => 'Speak to Asael',
    };
    return Semantics(
      button: true,
      label: tooltip,
      child: IconButton.filled(
        onPressed: action,
        tooltip: tooltip,
        visualDensity: VisualDensity.compact,
        style: IconButton.styleFrom(
          fixedSize: const Size.square(42),
          backgroundColor: color,
          foregroundColor: scheme.surface,
          disabledBackgroundColor: color.withValues(alpha: .32),
          disabledForegroundColor: scheme.surface.withValues(alpha: .72),
        ),
        icon: Icon(icon, size: 19),
      ),
    );
  }
}

({String title, Color color}) _presentation(
  AmbientVoicePhase phase,
  ColorScheme scheme,
) => switch (phase) {
  AmbientVoicePhase.asleep => (title: 'Ready', color: scheme.primary),
  AmbientVoicePhase.starting => (title: 'Connecting', color: scheme.primary),
  AmbientVoicePhase.listening => (title: 'Listening', color: scheme.primary),
  AmbientVoicePhase.transcribing => (
    title: 'One moment',
    color: scheme.secondary,
  ),
  AmbientVoicePhase.review => (title: 'Ready to send', color: scheme.primary),
  AmbientVoicePhase.running => (title: 'Working', color: scheme.secondary),
  AmbientVoicePhase.speaking => (title: 'Speaking', color: scheme.primary),
  AmbientVoicePhase.approval => (
    title: 'Approval needed',
    color: scheme.tertiary,
  ),
  AmbientVoicePhase.completed => (title: 'Done', color: scheme.tertiary),
  AmbientVoicePhase.offline => (title: 'Offline', color: scheme.tertiary),
  AmbientVoicePhase.error => (title: 'Needs attention', color: scheme.error),
};
