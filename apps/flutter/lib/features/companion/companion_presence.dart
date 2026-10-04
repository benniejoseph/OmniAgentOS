import 'package:flutter/material.dart';

import 'atlas_player.dart';
import 'companion_models.dart';
import 'companion_presentation.dart';

class CompanionPortrait extends StatelessWidget {
  const CompanionPortrait({
    super.key,
    required this.visible,
    this.state = 'available',
    this.preferences,
  });
  final bool visible;
  final String state;
  final CompanionPreferences? preferences;
  @override
  Widget build(BuildContext context) => AtlasPortrait(
    state: state,
    visible: visible,
    preferences:
        preferences ?? CompanionPreferences(visible: visible, motion: 'off'),
  );
}

/// Receipt-bound state presentation. Artwork never supplies run authority.
class CompanionPresence extends StatefulWidget {
  const CompanionPresence({
    super.key,
    required this.preferences,
    required this.work,
    this.reactionScope,
    this.microphoneActive = false,
    this.playbackActive = false,
    this.speechPreparing = false,
    this.onHome,
    this.homeDisabledReason,
    this.agentIdentity,
    this.statusDetail,
    this.showPortrait = true,
  });
  final CompanionPreferences? preferences;
  final CompanionWork work;
  final Object? reactionScope;
  final bool microphoneActive, playbackActive, speechPreparing;
  final VoidCallback? onHome;
  final String? homeDisabledReason, agentIdentity;
  final String? statusDetail;
  final bool showPortrait;
  @override
  State<CompanionPresence> createState() => _CompanionPresenceState();
}

class _CompanionPresenceState extends State<CompanionPresence> {
  CompanionReactionLedger _ledger = CompanionReactionLedger();
  String? _lastState;
  Object? _reaction;

  CompanionWork get _presentation => companionForeground(
    work: widget.work,
    microphoneActive: widget.microphoneActive,
    playbackActive: widget.playbackActive,
    speechPreparing: widget.speechPreparing,
  );

  void _prime() {
    _ledger = CompanionReactionLedger();
    _ledger.observe(widget.work, allowReaction: false);
    _lastState = _presentation.state;
    _reaction = null;
  }

  @override
  void initState() {
    super.initState();
    _prime();
  }

  @override
  void didUpdateWidget(covariant CompanionPresence oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.reactionScope != widget.reactionScope) {
      _prime();
      return;
    }
    final state = _presentation.state;
    final completion = _ledger.observe(
      widget.work,
      allowReaction: widget.reactionScope != null && state == 'completed',
    );
    if (completion || state != _lastState && state != 'completed') {
      _reaction = Object();
    } else if (state != _lastState) {
      _reaction = null;
    }
    _lastState = state;
  }

  @override
  Widget build(BuildContext context) {
    final preferences = widget.preferences;
    final presentation = _presentation;
    final reduced = MediaQuery.disableAnimationsOf(context);
    final motion = preferences == null
        ? 'off'
        : companionEffectiveMotion(preferences, reduced);
    final color = Theme.of(context).colorScheme;
    final needsAttention = const {
      'needs_you',
      'blocked',
      'paused',
    }.contains(presentation.state);
    final detail = needsAttention
        ? presentation.detail
        : widget.statusDetail ??
              (presentation != widget.work ? presentation.detail : null);
    return Semantics(
      container: true,
      label: 'ATLAS status',
      child: KeyedSubtree(
        key: const ValueKey('companion-presence'),
        child: Theme(
          data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
          child: ExpansionTile(
            key: PageStorageKey(('companion-details', widget.reactionScope)),
            expansionAnimationStyle: reduced
                ? AnimationStyle.noAnimation
                : const AnimationStyle(duration: Duration(milliseconds: 180)),
            tilePadding: const EdgeInsets.symmetric(
              horizontal: 16,
              vertical: 4,
            ),
            childrenPadding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
            shape: const Border(),
            collapsedShape: const Border(),
            leading: Offstage(
              offstage: !widget.showPortrait,
              child: AtlasPortrait(
                state: presentation.state,
                size: 44,
                visible: widget.showPortrait,
                preferences: preferences,
                scopeKey: widget.reactionScope,
                reactionKey: _reaction,
              ),
            ),
            title: Text(
              presentation.label,
              style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
            ),
            subtitle:
                detail == null &&
                    widget.homeDisabledReason == null &&
                    !(presentation != widget.work && widget.work.runId != null)
                ? null
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (detail != null)
                        Text(
                          detail,
                          style: TextStyle(
                            fontSize: 13,
                            height: 1.4,
                            color: color.onSurfaceVariant,
                          ),
                        ),
                      if (presentation != widget.work &&
                          widget.work.runId != null)
                        Text(
                          'Work: ${widget.work.label}',
                          style: const TextStyle(fontSize: 13),
                        ),
                      if (widget.homeDisabledReason != null)
                        Text(
                          widget.homeDisabledReason!,
                          style: const TextStyle(fontSize: 13, height: 1.4),
                        ),
                    ],
                  ),
            children: [
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 220),
                child: SingleChildScrollView(
                  key: PageStorageKey((
                    'companion-details-scroll',
                    widget.reactionScope,
                  )),
                  primary: false,
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (detail != presentation.detail)
                          Text(
                            presentation.detail,
                            style: const TextStyle(fontSize: 13, height: 1.4),
                          ),
                        if (widget.work.runId != null)
                          SelectableText(
                            'Run ${widget.work.runId}',
                            style: const TextStyle(fontSize: 13),
                          ),
                        if (widget.agentIdentity != null)
                          Text(
                            widget.agentIdentity!,
                            style: const TextStyle(fontSize: 13),
                          ),
                        if (preferences != null &&
                            preferences.intensity != 'quiet')
                          Text(
                            motion == 'full'
                                ? 'ATLAS motion is on.'
                                : 'ATLAS motion: $motion.',
                            style: TextStyle(
                              fontSize: 13,
                              color: color.onSurfaceVariant,
                            ),
                          ),
                        if (widget.onHome != null ||
                            widget.homeDisabledReason != null)
                          TextButton(
                            onPressed: widget.onHome,
                            style: TextButton.styleFrom(
                              minimumSize: const Size(48, 48),
                            ),
                            child: const Text('Open home conversation'),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
