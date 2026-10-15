import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/platform/mobile_presentation.dart';
import '../../app/mobile/mobile_page_scaffold.dart';
import '../../app/mobile/mobile_flow_scaffold.dart';
import '../../app/theme/mobile_app_theme.dart';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/platform/desktop_host_bridge.dart';
import '../companion/atlas_player.dart';
import '../companion/companion_models.dart';
import '../companion/voice_appearance.dart';
import '../inbox/inbox.dart' as approvals;
import '../inbox/inbox_providers.dart';
import 'voice_conversation_controller.dart';
import 'voice_options_sheet.dart';

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
    this.contextSummary,
    this.current,
    this.onEditContext,
    this.onModels,
    this.desktopHost,
  });

  final VoiceConversationController controller;
  final bool consentRequired;
  final bool starting;
  final String? startError;
  final String selectedAgentName;
  final VoidCallback onStart;
  final VoidCallback onEnd;
  final CompanionPreferences? companionPreferences;
  final String Function()? contextSummary;
  final bool Function()? current;
  final Future<void> Function()? onEditContext;
  final VoidCallback? onModels;
  final DesktopHostBridge? desktopHost;

  @override
  ConsumerState<VoiceConversationSurface> createState() =>
      _VoiceConversationSurfaceState();
}

class _VoiceConversationSurfaceState
    extends ConsumerState<VoiceConversationSurface> {
  final _portraitKey = GlobalKey(debugLabel: 'voice-atlas');
  bool _expanded = false;
  bool _reviewingApproval = false;
  bool _editingContext = false;
  String? _lastPortrait;
  bool _wasUserSpeaking = false;
  Object? _reaction;
  Object? _windowConfiguration;
  late DesktopVoiceWindowPresentation _windowPresentation;

  DesktopHostBridge get _desktopHost =>
      widget.desktopHost ?? appDesktopHostBridge;

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
      : voice.waitingForApproval
      ? 'needs_you'
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
      : voice.waitingForApproval
      ? 'Needs your review'
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
    _windowPresentation = _desktopHost.beginVoiceWindowPresentation();
    _lastPortrait = _portraitState;
    _wasUserSpeaking = voice.userSpeaking;
  }

  @override
  void didUpdateWidget(covariant VoiceConversationSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.desktopHost != widget.desktopHost) {
      unawaited(_windowPresentation.close());
      _windowPresentation = _desktopHost.beginVoiceWindowPresentation();
      _windowConfiguration = null;
    }
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

  @override
  void dispose() {
    // Covers back navigation, sign-out, account replacement and route errors,
    // including paths that never call the visible End button.
    unawaited(_windowPresentation.close());
    super.dispose();
  }

  void _end() {
    // Invalidate before ending audio or changing routes. Both can schedule a
    // final rebuild while this surface is still mounted.
    unawaited(_windowPresentation.close());
    widget.onEnd();
  }

  void _presentWindow(VoiceAppearance appearance, bool details, double scale) {
    if (!_desktopHost.supported || !_windowPresentation.current) return;
    final width = _editingContext
        ? 760.0
        : _reviewingApproval || voice.voiceApprovalReview != null
        ? 560.0
        : (appearance == VoiceAppearance.perch
                  ? (details ? 360.0 : 300.0)
                  : details
                  ? 400.0
                  : 360.0) *
              math.min(scale, 1.45);
    final height = _editingContext
        ? 640.0
        : _reviewingApproval || voice.voiceApprovalReview != null
        ? 680.0
        : (appearance == VoiceAppearance.perch
                  ? (details ? 380.0 : 256.0) -
                        (widget.companionPreferences?.visible == true ? 0 : 104)
                  : details
                  ? 280.0
                  : 108.0) *
              math.min(scale, 2.0);
    final windowAppearance =
        _editingContext ||
            _reviewingApproval ||
            voice.voiceApprovalReview != null
        ? VoiceAppearance.companion
        : appearance;
    final configuration = (windowAppearance, width, height, _reduceMotion);
    if (_windowConfiguration == configuration) return;
    _windowConfiguration = configuration;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _windowConfiguration != configuration) return;
      unawaited(
        _windowPresentation.show(
          appearance: windowAppearance.name,
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
            minimumSize: usesMobilePresentation()
                ? const Size(48, 48)
                : const Size(32, 32),
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
        if (voice.workNotice case final notice? when expanded) ...[
          const SizedBox(height: 8),
          Text(
            notice,
            style: TextStyle(
              fontSize: 12,
              height: 1.4,
              color: scheme.onSurfaceVariant,
            ),
          ),
        ],
        if (voice.voiceApprovalReview case final review? when expanded) ...[
          const SizedBox(height: 12),
          _spokenApprovalReview(review),
        ],
        if (expanded && widget.contextSummary != null) ...[
          const SizedBox(height: 8),
          Text(
            widget.contextSummary!(),
            style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
          ),
        ],
        if (expanded &&
            const {
              'local_macos',
              'local_android',
            }.contains(voice.commandContext?['computerUseTarget'])) ...[
          const SizedBox(height: 8),
          Text(
            voice.commandContext?['computerUseTarget'] == 'local_android'
                ? 'Asael + This phone · Stop is always available in your notification'
                : 'Asael + This Mac · device actions remain reviewed',
            style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant),
          ),
        ],
      ],
    );
    return expanded ? SingleChildScrollView(child: content) : content;
  }

  Widget _spokenApprovalReview(Map<String, dynamic> review) {
    final action = review['approval'] as Map;
    // Arming follows a completed frame containing the exact server evidence.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && (widget.current?.call() ?? true)) {
        unawaited(voice.markVoiceApprovalPresented(review));
      }
    });
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          action['title'] as String,
          style: Theme.of(context).textTheme.titleSmall,
        ),
        const SizedBox(height: 8),
        if (action['reason'] is String) Text(action['reason'] as String),
        const SizedBox(height: 8),
        SelectableText(
          const JsonEncoder.withIndent('  ').convert(action['input']),
        ),
        const SizedBox(height: 8),
        Text(
          voice.verbalApprovalNotice ?? 'Review this action before deciding.',
        ),
        TextButton(
          onPressed: voice.refreshSpokenApprovalReview,
          child: const Text('Review again for a spoken decision'),
        ),
        if (action['blockReason'] is String)
          Text(action['blockReason'] as String),
      ],
    );
  }

  Widget _controls({required bool canCollapse, required bool expanded}) {
    final scheme = Theme.of(context).colorScheme;
    final style = TextButton.styleFrom(
      minimumSize: usesMobilePresentation()
          ? const Size(48, 48)
          : const Size(32, 32),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      textStyle: TextStyle(
        fontSize: usesMobilePresentation() ? 15 : 12,
        fontWeight: FontWeight.w600,
      ),
    );
    return Wrap(
      spacing: 4,
      runSpacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        if (_desktopHost.supported &&
            !voice.active &&
            !_connecting &&
            widget.onEditContext != null)
          TextButton.icon(
            style: style,
            onPressed: _editingContext ? null : () => unawaited(_editContext()),
            icon: const Icon(Icons.tune_rounded, size: 15),
            label: const Text('Control and context'),
          ),
        if (voice.waitingForApproval)
          TextButton.icon(
            style: style,
            onPressed: _reviewingApproval
                ? null
                : () => unawaited(_reviewApproval()),
            icon: const Icon(Icons.fact_check_outlined, size: 15),
            label: const Text('Review action'),
          ),
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
          onPressed: _end,
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
              minimumSize: usesMobilePresentation()
                  ? const Size(48, 48)
                  : const Size(32, 32),
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

  Future<void> _editContext() async {
    if (_editingContext ||
        voice.active ||
        _connecting ||
        !_windowPresentation.current ||
        widget.onEditContext == null) {
      return;
    }
    final presentation = _windowPresentation;
    setState(() => _editingContext = true);
    try {
      await presentation.show(
        appearance: 'companion',
        width: 760,
        height: 640,
        reduceMotion: _reduceMotion,
      );
      if (!mounted ||
          !presentation.current ||
          widget.current?.call() == false) {
        return;
      }
      await widget.onEditContext!();
    } finally {
      if (mounted && identical(presentation, _windowPresentation)) {
        setState(() {
          _editingContext = false;
          _windowConfiguration = null;
        });
      }
    }
  }

  Future<void> _reviewApproval() async {
    if (!voice.active || !voice.waitingForApproval || _reviewingApproval) {
      return;
    }
    final call = voice;
    final session = call.sessionId;
    final repository = ref.read(inboxRepositoryProvider);
    setState(() {
      _reviewingApproval = true;
      _expanded = true;
    });
    await _windowPresentation.show(
      appearance: 'companion',
      width: 560,
      height: 680,
      reduceMotion: _reduceMotion,
    );
    if (!mounted || !call.active || call.sessionId != session) {
      if (mounted) setState(() => _reviewingApproval = false);
      return;
    }
    try {
      await showDialog<void>(
        context: context,
        builder: (_) => _VoiceApprovalDialog(
          repository: repository,
          voice: call,
          sessionId: session!,
          approvalId: call.approvalId,
          workflowId: call.workWorkflowId,
        ),
      );
    } finally {
      if (mounted) {
        setState(() {
          _reviewingApproval = false;
          _windowConfiguration = null;
        });
      }
    }
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

  Widget _mobileConversation(VoiceAppearanceController appearance) {
    final dark = MobileAppTheme.dark(
      highContrast: MediaQuery.highContrastOf(context),
    );
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Theme(
        data: dark,
        child: Builder(
          builder: (context) {
            final scheme = Theme.of(context).colorScheme;
            return ColoredBox(
              color: dark.scaffoldBackgroundColor,
              child: SafeArea(
                child: Column(
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                      child: Row(
                        children: [
                          IconButton(
                            tooltip: 'Back to Asael',
                            onPressed: () => Navigator.of(context).maybePop(),
                            icon: const Icon(Icons.arrow_back_rounded),
                          ),
                          Expanded(
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  'ATLAS',
                                  style: dark.textTheme.titleMedium?.copyWith(
                                    letterSpacing: 1.5,
                                  ),
                                ),
                                const SizedBox(height: 3),
                                Text(
                                  'Voice conversation',
                                  style: dark.textTheme.bodySmall?.copyWith(
                                    color: scheme.onSurfaceVariant,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          IconButton(
                            tooltip: 'Voice options',
                            icon: const Icon(Icons.tune_rounded),
                            onPressed: () => showMobileSheet<void>(
                              context: context,
                              title: 'Voice options',
                              builder: (sheetContext) => MobileVoiceOptions(
                                voice: voice,
                                contextSummary:
                                    widget.contextSummary ??
                                    () => 'This conversation',
                                current: () =>
                                    mounted && (widget.current?.call() ?? true),
                                onEditContext: widget.onEditContext,
                                onModels: widget.onModels == null
                                    ? null
                                    : () {
                                        Navigator.of(sheetContext).pop();
                                        widget.onModels!();
                                      },
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    Expanded(
                      child: LayoutBuilder(
                        builder: (context, constraints) => SingleChildScrollView(
                          padding: const EdgeInsets.fromLTRB(28, 24, 28, 20),
                          child: ConstrainedBox(
                            constraints: BoxConstraints(
                              minHeight: math.max(
                                0,
                                constraints.maxHeight - 44,
                              ),
                            ),
                            child: Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Container(
                                  padding: const EdgeInsets.all(22),
                                  decoration: BoxDecoration(
                                    shape: BoxShape.circle,
                                    color: scheme.primary.withValues(
                                      alpha: .05,
                                    ),
                                    border: Border.all(
                                      color: scheme.primary.withValues(
                                        alpha: .15,
                                      ),
                                    ),
                                  ),
                                  child: _portrait(
                                    appearance.appearance ==
                                            VoiceAppearance.perch
                                        ? 200
                                        : 160,
                                  ),
                                ),
                                const SizedBox(height: 30),
                                Semantics(
                                  liveRegion: true,
                                  child: Text(
                                    _status,
                                    textAlign: TextAlign.center,
                                    style: dark.textTheme.headlineMedium
                                        ?.copyWith(
                                          color: _error != null
                                              ? scheme.error
                                              : scheme.onSurface,
                                        ),
                                  ),
                                ),
                                const SizedBox(height: 12),
                                MobileStatusPill(
                                  label: _microphoneStatus,
                                  icon: voice.muted
                                      ? Icons.mic_off_rounded
                                      : Icons.mic_none_rounded,
                                  color: scheme.primary,
                                ),
                                const SizedBox(height: 28),
                                Text(
                                  _detail,
                                  textAlign: TextAlign.center,
                                  style: dark.textTheme.bodyLarge?.copyWith(
                                    height: 1.65,
                                    color: scheme.onSurfaceVariant,
                                  ),
                                ),
                                if (voice.historyNotice case final notice?)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 16),
                                    child: Text(
                                      notice,
                                      textAlign: TextAlign.center,
                                      style: dark.textTheme.bodySmall,
                                    ),
                                  ),
                                if (voice.workNotice case final notice?)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 16),
                                    child: Text(
                                      notice,
                                      textAlign: TextAlign.center,
                                      style: dark.textTheme.bodySmall,
                                    ),
                                  ),
                                if (voice
                                        .commandContext?['computerUseTarget'] ==
                                    'local_android')
                                  Padding(
                                    padding: const EdgeInsets.only(top: 16),
                                    child: Text(
                                      'Working with Asael and this phone. Stop is always available in your notification.',
                                      textAlign: TextAlign.center,
                                      style: dark.textTheme.bodySmall,
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(24, 16, 24, 12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (voice.waitingForApproval) ...[
                            if (voice.voiceApprovalReview case final review?)
                              ConstrainedBox(
                                constraints: const BoxConstraints(
                                  maxHeight: 240,
                                ),
                                child: SingleChildScrollView(
                                  child: _spokenApprovalReview(review),
                                ),
                              ),
                            OutlinedButton.icon(
                              onPressed: _reviewingApproval
                                  ? null
                                  : () => unawaited(_reviewApproval()),
                              icon: const Icon(Icons.fact_check_outlined),
                              label: const Text('Review action'),
                            ),
                            const SizedBox(height: 12),
                          ],
                          Row(
                            children: [
                              Expanded(
                                child: Semantics(
                                  label: _microphoneStatus,
                                  child: FilledButton.tonalIcon(
                                    style: FilledButton.styleFrom(
                                      minimumSize: const Size(48, 64),
                                    ),
                                    onPressed: voice.active || _connecting
                                        ? voice.ready
                                              ? () =>
                                                    voice.setMuted(!voice.muted)
                                              : null
                                        : widget.onStart,
                                    icon: Icon(
                                      voice.active || _connecting
                                          ? voice.muted
                                                ? Icons.mic_off_rounded
                                                : Icons.mic_rounded
                                          : Icons.mic_none_rounded,
                                      size: 25,
                                    ),
                                    label: Text(
                                      voice.active || _connecting
                                          ? voice.muted
                                                ? 'Unmute'
                                                : 'Mute'
                                          : 'Start',
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 14),
                              Expanded(
                                child: FilledButton.icon(
                                  style: FilledButton.styleFrom(
                                    minimumSize: const Size(48, 64),
                                    backgroundColor: scheme.errorContainer,
                                    foregroundColor: scheme.onErrorContainer,
                                  ),
                                  onPressed: _end,
                                  icon: Icon(
                                    voice.active || _connecting
                                        ? Icons.call_end_rounded
                                        : Icons.close_rounded,
                                    size: 25,
                                  ),
                                  label: Text(
                                    voice.active || _connecting
                                        ? 'End'
                                        : 'Close',
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(32, 0, 32, 24),
                      child: Text(
                        'Mute or end from here or your notification.',
                        textAlign: TextAlign.center,
                        style: dark.textTheme.bodySmall?.copyWith(
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        ),
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
        voice.voiceApprovalReview == null &&
        scale <= 1.15;
    final details = _expanded || !canCollapse;
    _presentWindow(appearance.appearance, details, scale);
    if (usesMobilePresentation()) {
      return Scaffold(body: _mobileConversation(appearance));
    }
    final presentation =
        appearance.appearance == VoiceAppearance.perch &&
            voice.voiceApprovalReview == null
        ? _perch(appearance, details, canCollapse)
        : _companion(appearance, details, canCollapse);
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Focus(
        autofocus: true,
        child: _desktopHost.supported
            ? presentation
            : SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    children: [
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Row(
                          children: [
                            IconButton(
                              tooltip: 'Back to Asael',
                              onPressed: () => Navigator.of(context).maybePop(),
                              icon: const Icon(Icons.arrow_back_rounded),
                            ),
                            Expanded(
                              child: Text(
                                'Talk to ATLAS',
                                style: Theme.of(context).textTheme.titleLarge,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Expanded(child: presentation),
                      const Padding(
                        padding: EdgeInsets.only(top: 16, bottom: 8),
                        child: Text(
                          'You can use other apps while we talk. Mute or end the call from the notification.',
                          textAlign: TextAlign.center,
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

/// Uses the ordinary approval repository and card. Opening it changes only
/// presentation: microphone transport and the exact governed run remain live.
class _VoiceApprovalDialog extends StatefulWidget {
  const _VoiceApprovalDialog({
    required this.repository,
    required this.voice,
    required this.sessionId,
    this.approvalId,
    this.workflowId,
  });
  final approvals.InboxRepository repository;
  final VoiceConversationController voice;
  final String sessionId;
  final String? approvalId;
  final String? workflowId;
  @override
  State<_VoiceApprovalDialog> createState() => _VoiceApprovalDialogState();
}

class _VoiceApprovalDialogState extends State<_VoiceApprovalDialog> {
  approvals.ApprovalQueue? _queue;
  bool _loading = true;
  bool _closing = false;
  String? _deciding;
  String? _notice;
  bool get _current =>
      mounted &&
      widget.voice.active &&
      widget.voice.sessionId == widget.sessionId;
  @override
  void initState() {
    super.initState();
    widget.voice.addListener(_voiceChanged);
    unawaited(_load());
  }

  void _voiceChanged() {
    if (!_current && mounted && !_closing) {
      _closing = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !_current) Navigator.of(context).pop();
      });
    }
  }

  @override
  void dispose() {
    widget.voice.removeListener(_voiceChanged);
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final queue = await widget.repository.loadApprovals();
      if (_current) {
        setState(() {
          _queue = queue;
          _loading = false;
        });
      }
    } catch (_) {
      if (_current) {
        setState(() {
          _loading = false;
          _notice = 'The action could not be loaded. Close and try again.';
        });
      }
    }
  }

  Future<void> _decide(approvals.ApprovalItem item, bool approve) async {
    if (!_current || _deciding != null) return;
    setState(() {
      _deciding = item.id;
      _notice = null;
    });
    try {
      await widget.repository.decide(item, approve: approve);
      if (_current) {
        setState(
          () => _notice =
              'Your decision was recorded. ATLAS is following the same task.',
        );
        await _load();
      }
    } catch (_) {
      if (_current) {
        setState(
          () => _notice = 'The decision could not be confirmed. Refresh the action before trying again.',
        );
      }
    } finally {
      if (_current) setState(() => _deciding = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final items =
        _queue?.items
            .where(
              (item) =>
                  item.id == widget.approvalId ||
                  (widget.approvalId == null &&
                      item.kind == 'workflow' &&
                      item.id == widget.workflowId),
            )
            .toList() ??
        const <approvals.ApprovalItem>[];
    if (usesMobilePresentation()) {
      return Dialog.fullscreen(
        child: MobileFlowScaffold(
          title: 'Review action',
          footer: TextButton.icon(
            onPressed: !_current || _loading || _deciding != null
                ? null
                : () {
                    setState(() => _loading = true);
                    unawaited(_load());
                  },
            icon: const Icon(Icons.refresh_rounded),
            label: const Text('Refresh action'),
          ),
          child: !_current
              ? const Text(
                  'This call has ended. Return to Assistant to review pending work.',
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      'Your call stays connected. Review the action and its consequences before deciding.',
                    ),
                    const SizedBox(height: 20),
                    if (_loading)
                      const Center(child: CircularProgressIndicator()),
                    if (_notice != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 16),
                        child: Text(_notice!),
                      ),
                    if (!_loading && items.isEmpty)
                      const MobileSurface(
                        child: Text(
                          'There is no pending action here. ATLAS will pick up the latest task status.',
                        ),
                      ),
                    for (final item in items)
                      approvals.ApprovalCard(
                        item: item,
                        busy: _deciding != null,
                        focused: true,
                        onDecision: (approve) =>
                            unawaited(_decide(item, approve)),
                      ),
                  ],
                ),
        ),
      );
    }
    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520, maxHeight: 600),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 12, 4),
              child: Row(
                children: [
                  const Expanded(
                    child: Text(
                      'Review action',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Return to conversation',
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
            ),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 20, vertical: 8),
              child: Text(
                'Your voice call stays connected. Review the exact action before deciding.',
              ),
            ),
            if (_loading)
              const Padding(
                padding: EdgeInsets.all(24),
                child: Center(child: CircularProgressIndicator()),
              ),
            if (_notice != null)
              Padding(padding: const EdgeInsets.all(20), child: Text(_notice!)),
            if (!_loading && items.isEmpty)
              const Padding(
                padding: EdgeInsets.all(20),
                child: Text(
                  'No pending action remains here. ATLAS will read the updated task status.',
                ),
              ),
            Flexible(
              child: SingleChildScrollView(
                child: Column(
                  children: [
                    for (final item in items)
                      approvals.ApprovalCard(
                        item: item,
                        busy: _deciding != null,
                        focused: true,
                        onDecision: (approve) =>
                            unawaited(_decide(item, approve)),
                      ),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(12),
              child: TextButton(
                onPressed: _loading || _deciding != null
                    ? null
                    : () {
                        setState(() => _loading = true);
                        unawaited(_load());
                      },
                child: const Text('Refresh action'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
