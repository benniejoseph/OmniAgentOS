import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../companion/companion_models.dart';
import '../companion/companion_presence.dart';
import '../companion/companion_presentation.dart';
import 'realtime_voice_controller.dart' show AmbientVoiceConfidenceBand;

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
/// voice surface, not a second Command composer. A transcript under review
/// shows how confidently it was recognized; one that needs review keeps Send
/// off until its review checkbox is ticked. The ordinary governed command path
/// still owns approvals, cancellation, and execution.
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
    this.speechNotice,
    this.confidenceBand,
    this.reviewRequired = false,
    this.reviewAttested = false,
    this.onReviewAttested,
    this.consentRequired = false,
    this.companionPreferences,
    this.replyReady = false,
    this.microphoneActive = false,
    this.playbackActive = false,
    this.work = availableCompanion,
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

  /// Why the finished answer was not played aloud, if it was not.
  final String? speechNotice;

  /// How confidently the transcript under review was recognized.
  final AmbientVoiceConfidenceBand? confidenceBand;

  /// Whether the transcript needs its review checkbox, not Send alone.
  final bool reviewRequired;
  final bool reviewAttested;
  final ValueChanged<bool>? onReviewAttested;

  /// Whether the next microphone press also agrees to the provider notice.
  final bool consentRequired;
  final CompanionPreferences? companionPreferences;
  final bool replyReady;
  final bool microphoneActive;
  final bool playbackActive;
  final CompanionWork work;

  String get _portraitState {
    if (playbackActive) {
      return 'responding';
    }
    if (microphoneActive) {
      return 'listening';
    }
    return switch (phase) {
      AmbientVoicePhase.offline || AmbientVoicePhase.error => 'blocked',
      AmbientVoicePhase.transcribing || AmbientVoicePhase.speaking => 'working',
      AmbientVoicePhase.approval => 'needs_you',
      AmbientVoicePhase.review
          when !replyReady && transcript.trim().isNotEmpty =>
        'needs_you',
      // Only the existing receipt-verified work projection supplies completed.
      _ => work.state,
    };
  }

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
    // This presence is static. Existing controls retain their own semantics.
    const reducedMotion = true;
    final presentation = _presentation(phase, scheme);
    final recognized = transcript.trim();
    final reviewing =
        !replyReady &&
        phase == AmbientVoicePhase.review &&
        recognized.isNotEmpty;
    final attestationNeeded = reviewing && reviewRequired;
    final title = attestationNeeded
        ? 'Check the transcript'
        : playbackActive
        ? 'Responding'
        : microphoneActive
        ? 'Listening'
        : replyReady
        ? 'Reply ready'
        : phase == AmbientVoicePhase.listening && !microphoneActive
        ? 'Voice connection'
        : phase == AmbientVoicePhase.speaking && !playbackActive
        ? 'Preparing reply audio'
        : presentation.title;
    final band = reviewing ? confidenceBand : null;
    final bandLabel = band == null ? null : _confidenceLabel(band);
    final supportingText = _supportingText(recognized);
    final liveStatus = reviewing
        ? '${[title, ?bandLabel].join('. ')}. Recognized request: $recognized.'
        : ['$title. $supportingText.', ?speechNotice].join(' ');
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
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
                  child: Row(
                    children: [
                      CompanionPortrait(
                        visible: companionPreferences?.visible == true,
                        preferences: companionPreferences,
                        state: _portraitState,
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
                                  duration: Duration.zero,
                                  width: 6,
                                  height: 6,
                                  decoration: BoxDecoration(
                                    color: presentation.color,
                                    shape: BoxShape.circle,
                                  ),
                                ),
                                const SizedBox(width: 7),
                                Expanded(
                                  child: AnimatedSwitcher(
                                    duration: Duration.zero,
                                    child: Text(
                                      title,
                                      key: ValueKey(title),
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
                                if (bandLabel != null) ...[
                                  const SizedBox(width: 8),
                                  Text(
                                    bandLabel,
                                    maxLines: 1,
                                    style: theme.textTheme.labelSmall?.copyWith(
                                      color: attestationNeeded
                                          ? scheme.tertiary
                                          : muted,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ] else if (speechNotice case final notice?) ...[
                                  const SizedBox(width: 8),
                                  Tooltip(
                                    message: notice,
                                    child: Text(
                                      'Not spoken',
                                      maxLines: 1,
                                      style: theme.textTheme.labelSmall
                                          ?.copyWith(
                                            color: muted,
                                            fontWeight: FontWeight.w600,
                                          ),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                            const SizedBox(height: 4),
                            if (microphoneActive || playbackActive)
                              Text(
                                'Work: ${work.label}',
                                style: const TextStyle(fontSize: 13),
                              ),
                            AnimatedSwitcher(
                              duration: Duration.zero,
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
                            if (microphoneActive) ...[
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
                      if (!replyReady &&
                          phase == AmbientVoicePhase.review &&
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
                      if (attestationNeeded) ...[
                        _ReviewAttestation(
                          attested: reviewAttested,
                          onChanged: onReviewAttested,
                        ),
                        const SizedBox(width: 2),
                      ],
                      _PrimaryAction(
                        phase: replyReady ? AmbientVoicePhase.asleep : phase,
                        consentRequired: consentRequired,
                        useThisMac: useThisMac,
                        color: presentation.color,
                        onMicrophonePressed: onMicrophonePressed,
                        onSend: attestationNeeded && !reviewAttested
                            ? null
                            : onSend,
                        onStop: onStop,
                        onReviewApproval: onReviewApproval,
                      ),
                      const SizedBox(width: 2),
                      IconButton(
                        tooltip: 'Close Ambient Command (Esc)',
                        onPressed: onClose,
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
    if ((phase == AmbientVoicePhase.completed || replyReady) &&
        result != null) {
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

String _confidenceLabel(AmbientVoiceConfidenceBand band) => switch (band) {
  AmbientVoiceConfidenceBand.high => 'High confidence',
  AmbientVoiceConfidenceBand.low => 'Low confidence',
  AmbientVoiceConfidenceBand.unavailable => 'Confidence unavailable',
  AmbientVoiceConfidenceBand.edited => 'Edited',
};

/// The visible review a transcript needs when it was not confidently
/// recognized. Send stays off until it is ticked.
class _ReviewAttestation extends StatelessWidget {
  const _ReviewAttestation({required this.attested, required this.onChanged});

  static const statement =
      'I checked the transcript and it is the exact command I mean to send. '
      'Risk-bearing actions still need their own approval.';

  final bool attested;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final change = onChanged;
    return Tooltip(
      message: statement,
      child: Checkbox(
        value: attested,
        semanticLabel: statement,
        onChanged: change == null ? null : (value) => change(value == true),
      ),
    );
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
        style: IconButton.styleFrom(
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
    required this.consentRequired,
    required this.useThisMac,
    required this.color,
    required this.onMicrophonePressed,
    required this.onSend,
    required this.onStop,
    required this.onReviewApproval,
  });

  final AmbientVoicePhase phase;
  final bool consentRequired;
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
      AmbientVoicePhase.asleep when consentRequired =>
        'Agree and start listening',
      _ => 'Speak to Asael',
    };
    return Semantics(
      button: true,
      label: tooltip,
      child: IconButton.filled(
        onPressed: action,
        tooltip: tooltip,
        style: IconButton.styleFrom(
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
  AmbientVoicePhase.completed => (title: 'Completed', color: scheme.tertiary),
  AmbientVoicePhase.offline => (title: 'Offline', color: scheme.tertiary),
  AmbientVoicePhase.error => (title: 'Needs attention', color: scheme.error),
};
