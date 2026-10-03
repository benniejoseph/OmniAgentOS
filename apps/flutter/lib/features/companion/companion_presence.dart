import 'package:flutter/material.dart';

import 'companion_models.dart';
import 'companion_presentation.dart';

class CompanionPortrait extends StatefulWidget {
  const CompanionPortrait({super.key, required this.visible});
  final bool visible;
  @override
  State<CompanionPortrait> createState() => _CompanionPortraitState();
}

class _CompanionPortraitState extends State<CompanionPortrait>
    with WidgetsBindingObserver {
  bool foreground = true;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final state = WidgetsBinding.instance.lifecycleState;
    foreground = state == null || state == AppLifecycleState.resumed;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (mounted) {
      setState(() => foreground = state == AppLifecycleState.resumed);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 36,
    height: 36,
    child: widget.visible && foreground
        ? Image.asset(
            'assets/companion/atlas-neutral.png',
            width: 36,
            height: 36,
            excludeFromSemantics: true,
            errorBuilder: (_, _, _) => const SizedBox.expand(),
          )
        : const SizedBox.expand(),
  );
}

/// Approved static artwork only. State and controls do not depend on loading it.
class CompanionPresence extends StatefulWidget {
  const CompanionPresence({
    super.key,
    required this.preferences,
    required this.work,
    this.microphoneActive = false,
    this.playbackActive = false,
    this.speechPreparing = false,
    this.onHome,
    this.homeDisabledReason,
    this.agentIdentity,
  });
  final CompanionPreferences? preferences;
  final CompanionWork work;
  final bool microphoneActive;
  final bool playbackActive;
  final bool speechPreparing;
  final VoidCallback? onHome;
  final String? homeDisabledReason;
  final String? agentIdentity;
  @override
  State<CompanionPresence> createState() => _CompanionPresenceState();
}

class _CompanionPresenceState extends State<CompanionPresence>
    with WidgetsBindingObserver {
  bool foreground = true;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final state = WidgetsBinding.instance.lifecycleState;
    foreground = state == null || state == AppLifecycleState.resumed;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (mounted) {
      setState(() => foreground = state == AppLifecycleState.resumed);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final preferences = widget.preferences;
    final presentation = companionForeground(
      work: widget.work,
      microphoneActive: widget.microphoneActive,
      playbackActive: widget.playbackActive,
      speechPreparing: widget.speechPreparing,
    );
    final reduced = MediaQuery.disableAnimationsOf(context);
    final color = Theme.of(context).colorScheme;
    return Semantics(
      container: true,
      label: 'ATLAS status',
      child: Container(
        key: const ValueKey('companion-presence'),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        decoration: BoxDecoration(
          color: color.surfaceContainerLow,
          border: Border(bottom: BorderSide(color: color.outlineVariant)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 36,
              height: 36,
              child: preferences?.visible == true && foreground
                  ? Image.asset(
                      'assets/companion/atlas-neutral.png',
                      width: 36,
                      height: 36,
                      excludeFromSemantics: true,
                      errorBuilder: (_, _, _) => const SizedBox.expand(),
                    )
                  : const SizedBox.expand(),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    presentation.label,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(
                    presentation.detail,
                    style: const TextStyle(fontSize: 13, height: 1.4),
                  ),
                  if (presentation != widget.work)
                    Text(
                      'Work: ${widget.work.label}',
                      style: const TextStyle(fontSize: 13),
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
                  if (preferences != null && preferences.intensity != 'quiet')
                    Text(
                      'Static ATLAS · ${companionEffectiveMotion(preferences, reduced)} motion preference',
                      style: TextStyle(
                        fontSize: 13,
                        color: color.onSurfaceVariant,
                      ),
                    ),
                  if (widget.homeDisabledReason != null)
                    Text(
                      widget.homeDisabledReason!,
                      style: const TextStyle(fontSize: 13),
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
          ],
        ),
      ),
    );
  }
}
