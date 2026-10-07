import 'package:flutter/material.dart';

import '../../features/companion/atlas_player.dart';
import '../../features/companion/companion_models.dart';

/// Compatibility vocabulary for existing brand surfaces, rendered by ATLAS.
enum AsaelMascotState { ready, listening, transcribing, working, success, attention }

class AsaelMascot extends StatefulWidget {
  const AsaelMascot({super.key, required this.state, this.size = 72});
  final AsaelMascotState state;
  final double size;

  @override
  State<AsaelMascot> createState() => _AsaelMascotWidgetState();
}

class _AsaelMascotWidgetState extends State<AsaelMascot> {
  Object? _reaction;

  @override
  void didUpdateWidget(covariant AsaelMascot oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.state != widget.state) _reaction = Object();
  }

  @override
  Widget build(BuildContext context) {
    final (state, label) = switch (widget.state) {
      AsaelMascotState.ready => ('available', 'ATLAS is ready'),
      AsaelMascotState.listening => ('listening', 'ATLAS is listening'),
      AsaelMascotState.transcribing => ('working', 'ATLAS is preparing your message'),
      AsaelMascotState.working => ('working', 'ATLAS is working'),
      AsaelMascotState.success => ('completed', 'ATLAS finished'),
      AsaelMascotState.attention => ('needs_you', 'ATLAS needs your attention'),
    };
    final size = (widget.size.isFinite ? widget.size : 72.0).clamp(24.0, 240.0).toDouble();
    return Semantics(
      label: label,
      image: true,
      child: AtlasPortrait(
        state: state,
        size: size,
        scopeKey: this,
        reactionKey: _reaction,
        preferences: const CompanionPreferences(intensity: 'expressive'),
      ),
    );
  }
}
