import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/platform/desktop_host_bridge.dart';
import '../companion/atlas_player.dart';
import '../companion/companion_models.dart';
import '../companion/voice_appearance.dart';
import 'voice_conversation_controller.dart';

class VoiceConversationSurface extends ConsumerStatefulWidget {
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
  ConsumerState<VoiceConversationSurface> createState() =>
      _VoiceConversationSurfaceState();
}

class _VoiceConversationSurfaceState
    extends ConsumerState<VoiceConversationSurface> {
  final _portraitKey = GlobalKey(debugLabel: 'voice-atlas');
  bool _expanded = false;
  String? _lastPortrait;
  bool _wasUserSpeaking = false;
  Object? _reaction;
  Object? _windowConfiguration;

  VoiceConversationController get voice => widget.controller;
  bool get _connecting =>
      widget.starting || voice.phase == VoiceConversationPhase.connecting;
  bool get _speaking =>
      voice.active && voice.phase == VoiceConversationPhase.speaking;
  String? get _error => widget.startError ?? voice.errorMessage;
  String get _agent =>
      voice.active ? voice.agentName : widget.selectedAgentName;
  String get _portraitState => _error != null
      ? 'blocked'
      : _speaking
      ? 'responding'
      : voice.phase == VoiceConversationPhase.working || _connecting
      ? 'working'
      : voice.muted && voice.active
      ? 'paused'
      : voice.active
      ? 'listening'
      : 'available';
  String get _status => _error != null
      ? 'Needs attention'
      : _connecting
      ? 'Connecting…'
      : !voice.active
      ? 'Ready to talk'
      : _speaking
      ? 'Speaking'
      : voice.phase == VoiceConversationPhase.working
      ? 'Working'
      : voice.muted
      ? 'Microphone muted'
      : voice.userSpeaking
      ? 'I’m listening'
      : 'Listening';
  String get _microphoneStatus => !voice.active || _connecting
      ? 'Microphone not connected'
      : voice.muted
      ? 'Microphone off'
      : voice.microphoneActive
      ? 'Microphone on'
      : 'Microphone unavailable';
  bool get _reduceMotion =>
      MediaQuery.disableAnimationsOf(context) ||
      MediaQuery.accessibleNavigationOf(context) ||
      widget.companionPreferences?.motion != 'full';
  String get _detail =>
      _error ??
      (!voice.active && !_connecting
          ? widget.consentRequired
                ? 'Start agrees to OpenAI processing live audio and your selected context. Captions are saved in History; Asael does not store the audio.'
                : 'Speak naturally. Pause for a reply, or speak over it to interrupt. Requests use $_agent and your selected context.'
          : _connecting
          ? 'Opening your private audio connection.'
          : voice.caption.isNotEmpty
          ? voice.caption
          : voice.muted
          ? 'Unmute whenever you’re ready. Replies can still play.'
          : 'Speak naturally. You can interrupt me.');

  @override
  void initState() {
    super.initState();
    _lastPortrait = _portraitState;
    _wasUserSpeaking = voice.userSpeaking;
  }

  @override
  void didUpdateWidget(covariant VoiceConversationSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, voice)) {
      _reaction = null;
      _expanded = false;
      _lastPortrait = _portraitState;
      _wasUserSpeaking = voice.userSpeaking;
      return;
    }
    // Caption refreshes and appearance changes do not replay a gesture.
    if (_lastPortrait != _portraitState ||
        voice.userSpeaking && !_wasUserSpeaking) {
      _reaction = Object();
    }
    _lastPortrait = _portraitState;
    _wasUserSpeaking = voice.userSpeaking;
  }

  void _presentWindow(VoiceAppearance appearance, bool details, double scale) {
    final width =
        (appearance == VoiceAppearance.perch
            ? (details ? 360.0 : 300.0)
            : details
            ? 400.0
            : 360.0) *
        math.min(scale, 1.45);
    final height =
        (appearance == VoiceAppearance.perch
            ? (details ? 380.0 : 256.0) -
                  (widget.companionPreferences?.visible == true ? 0 : 104)
            : details
            ? 280.0
            : 108.0) *
        math.min(scale, 2.0);
    final configuration = (appearance, width, height, _reduceMotion);
    if (_windowConfiguration == configuration) return;
    _windowConfiguration = configuration;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _windowConfiguration != configuration) return;
      unawaited(
        appDesktopHostBridge.showAmbientVoicePresentation(
          appearance: appearance.name,
          width: width,
          height: height,
          reduceMotion: configuration.$4,
        ),
      );
    });
  }

  Widget _portrait(double size) => AtlasPortrait(
    key: _portraitKey,
    size: size,
    state: _portraitState,
    visible: widget.companionPreferences?.visible == true,
    preferences: widget.companionPreferences,
    scopeKey: voice,
    reactionKey: _reaction,
    voiceExpression: true,
    playbackActive: _speaking,
    floatingPresence: true,
  );

  Widget _heading(VoiceAppearanceController appearance, {bool roomy = false}) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      children: [
        Expanded(
          child: Semantics(
            liveRegion: true,
            label: '$_agent. $_status. $_microphoneStatus.',
            child: ExcludeSemantics(
              child: Text(
                '$_agent · $_status',
                maxLines: roomy ? 2 : 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 14,
                  height: 1.25,
                  fontWeight: FontWeight.w600,
                  color: _error != null ? scheme.error : scheme.onSurface,
                ),
              ),
            ),
          ),
        ),
        PopupMenuButton<VoiceAppearance>(
          tooltip: 'Voice appearance',
          enabled: appearance.available,
          padding: EdgeInsets.zero,
          popUpAnimationStyle: _reduceMotion
              ? AnimationStyle.noAnimation
              : const AnimationStyle(duration: Duration(milliseconds: 180)),
          constraints: const BoxConstraints(minWidth: 180),
          iconSize: 17,
          style: IconButton.styleFrom(
            minimumSize: const Size(32, 32),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          icon: const Icon(Icons.more_horiz_rounded),
          onSelected: (value) => unawaited(appearance.setAppearance(value)),
          itemBuilder: (_) => [
            for (final option in VoiceAppearance.values)
              CheckedPopupMenuItem(
                value: option,
                checked: option == appearance.appearance,
                child: Text(option.label),
              ),
          ],
        ),
      ],
    );
  }

  Widget _caption({required bool expanded}) {
    final scheme = Theme.of(context).colorScheme;
    final content = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (expanded && voice.active) ...[
          Text(
            _microphoneStatus,
            style: TextStyle(
              fontSize: 12,
              height: 1.4,
              fontWeight: FontWeight.w600,
              color: scheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 8),
        ],
        Text(
          _detail,
          maxLines: expanded ? null : 1,
          overflow: expanded ? null : TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 13,
            height: 1.4,
            color: _error != null ? scheme.error : scheme.onSurfaceVariant,
          ),
        ),
        if (voice.historyNotice case final notice?) ...[
          const SizedBox(height: 8),
          Text(
            notice,
            style: TextStyle(
              fontSize: 13,
              height: 1.4,
              color: scheme.onSurfaceVariant,
            ),
          ),
        ],
      ],
    );
    return expanded ? SingleChildScrollView(child: content) : content;
  }

  Widget _controls({required bool canCollapse, required bool expanded}) {
    final scheme = Theme.of(context).colorScheme;
    final style = TextButton.styleFrom(
      minimumSize: const Size(32, 32),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
    );
    return Wrap(
      spacing: 4,
      runSpacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        if (voice.active || _connecting)
          Semantics(
            label: _microphoneStatus,
            child: TextButton.icon(
              style: style.copyWith(
                backgroundColor: WidgetStatePropertyAll(
                  scheme.surfaceContainerHigh,
                ),
              ),
              onPressed: voice.ready
                  ? () => voice.setMuted(!voice.muted)
                  : null,
              icon: Icon(
                voice.muted ? Icons.mic_off_rounded : Icons.mic_rounded,
                size: 15,
              ),
              label: Text(voice.muted ? 'Unmute' : 'Mute'),
            ),
          )
        else
          FilledButton.icon(
            style: style,
            onPressed: widget.onStart,
            icon: const Icon(Icons.mic_rounded, size: 15),
            label: const Text('Start'),
          ),
        TextButton.icon(
          style: style,
          onPressed: widget.onEnd,
          icon: Icon(
            voice.active || _connecting
                ? Icons.call_end_rounded
                : Icons.close_rounded,
            size: 15,
          ),
          label: Text(voice.active || _connecting ? 'End' : 'Close'),
        ),
        if (canCollapse)
          IconButton(
            tooltip: expanded ? 'Collapse captions' : 'Show captions',
            style: IconButton.styleFrom(
              minimumSize: const Size(32, 32),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            iconSize: 17,
            onPressed: () => setState(() => _expanded = !_expanded),
            icon: Icon(
              expanded
                  ? Icons.expand_less_rounded
                  : Icons.closed_caption_outlined,
            ),
          ),
      ],
    );
  }

  Widget _companion(
    VoiceAppearanceController appearance,
    bool details,
    bool canCollapse,
  ) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.surface,
      borderRadius: BorderRadius.circular(20),
      child: Padding(
        padding: EdgeInsets.all(details ? 16 : 8),
        child: details
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      _portrait(84),
                      const SizedBox(width: 12),
                      Expanded(child: _heading(appearance, roomy: true)),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Expanded(child: _caption(expanded: true)),
                  const SizedBox(height: 12),
                  _controls(canCollapse: canCollapse, expanded: details),
                ],
              )
            : Row(
                children: [
                  _portrait(84),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        _heading(appearance),
                        _caption(expanded: false),
                        const SizedBox(height: 4),
                        _controls(canCollapse: canCollapse, expanded: false),
                      ],
                    ),
                  ),
                ],
              ),
      ),
    );
  }

  Widget _perch(
    VoiceAppearanceController appearance,
    bool details,
    bool canCollapse,
  ) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.all(8),
      child: Column(
        children: [
          Expanded(
            child: Material(
              color: scheme.surface,
              elevation: 2,
              shadowColor: Colors.black.withValues(alpha: .16),
              borderRadius: const BorderRadius.only(
                topLeft: Radius.circular(16),
                topRight: Radius.circular(16),
                bottomLeft: Radius.circular(16),
                bottomRight: Radius.circular(5),
              ),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 4, 8, 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _heading(appearance, roomy: details),
                    Expanded(child: _caption(expanded: details)),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 4),
          _portrait(widget.companionPreferences?.visible == true ? 120 : 16),
          const SizedBox(height: 4),
          Material(
            color: scheme.surface,
            elevation: 2,
            shadowColor: Colors.black.withValues(alpha: .16),
            borderRadius: BorderRadius.circular(14),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
              child: _controls(canCollapse: canCollapse, expanded: details),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final appearance = ref.watch(voiceAppearanceProvider);
    final scale = math.max(
      1.0,
      MediaQuery.textScalerOf(context).scale(14) / 14,
    );
    final canCollapse =
        voice.active &&
        _error == null &&
        voice.historyNotice == null &&
        scale <= 1.15;
    final details = _expanded || !canCollapse;
    _presentWindow(appearance.appearance, details, scale);
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Focus(
        autofocus: true,
        child: appearance.appearance == VoiceAppearance.perch
            ? _perch(appearance, details, canCollapse)
            : _companion(appearance, details, canCollapse),
      ),
    );
  }
}
