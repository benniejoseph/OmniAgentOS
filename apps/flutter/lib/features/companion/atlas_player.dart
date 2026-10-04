import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import 'atlas_assets.dart';
import 'companion_models.dart';

/// A decorative state portrait. A fresh reaction key permits one finite clip;
/// returning to a visible route or changing preferences never replays that key.
class AtlasPortrait extends StatefulWidget {
  const AtlasPortrait({
    super.key,
    this.state = 'available',
    this.size = 36,
    this.visible = true,
    this.preferences,
    this.scopeKey,
    this.reactionKey,
  });
  final String state;
  final double size;
  final bool visible;
  final CompanionPreferences? preferences;
  final Object? scopeKey, reactionKey;
  @override
  State<AtlasPortrait> createState() => _AtlasPortraitState();
}

class _AtlasPortraitState extends State<AtlasPortrait>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final AnimationController _clock;
  final _scrollPositions = <ScrollPosition>{};
  AssetBundle? _bundle;
  Object? _configuration, _handledReaction;
  ui.Image? _image;
  AtlasClip? _clip;
  bool _foreground = true, _dark = false, _motion = false, _allowed = false;
  bool _sprite = false, _postFramePending = false;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    // A completed ticker stops at the exact final pose. The single current
    // texture stays until a state/scope change; no idle ticker or clip loop.
    _clock = AnimationController(vsync: this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _bundle = DefaultAssetBundle.of(context);
    _dark = Theme.of(context).brightness == Brightness.dark;
    _motion = !MediaQuery.disableAnimationsOf(context);
    _allowed =
        TickerMode.valuesOf(context).enabled &&
        (ModalRoute.of(context)?.isCurrent ?? true);
    for (final position in _scrollPositions) {
      position.removeListener(_queueVisibilityCheck);
    }
    _scrollPositions.clear();
    context.visitAncestorElements((element) {
      if (element is StatefulElement && element.state is ScrollableState) {
        _scrollPositions.add((element.state as ScrollableState).position);
      }
      return true;
    });
    for (final position in _scrollPositions) {
      position.addListener(_queueVisibilityCheck);
    }
    _synchronize();
    _queueVisibilityCheck();
  }

  @override
  void didUpdateWidget(covariant AtlasPortrait oldWidget) {
    super.didUpdateWidget(oldWidget);
    _synchronize();
    _queueVisibilityCheck();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _synchronize();
  }

  @override
  void didChangeMetrics() {
    _queueVisibilityCheck();
  }

  bool get _onScreen {
    final box = context.findRenderObject();
    if (box is! RenderBox ||
        !box.attached ||
        !box.hasSize ||
        box.size.isEmpty) {
      return false;
    }
    var visible = (box.localToGlobal(Offset.zero) & box.size).intersect(
      Offset.zero & MediaQuery.sizeOf(context),
    );
    RenderObject? parent = box.parent;
    while (parent != null) {
      if (parent is RenderOffstage && parent.offstage) {
        return false;
      }
      final viewport = parent;
      if (parent is RenderAbstractViewport &&
          viewport is RenderBox &&
          viewport.hasSize) {
        visible = visible.intersect(
          viewport.localToGlobal(Offset.zero) & viewport.size,
        );
      }
      parent = parent.parent;
    }
    return !visible.isEmpty;
  }

  void _queueVisibilityCheck() {
    if (_postFramePending || !mounted) {
      return;
    }
    _postFramePending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _postFramePending = false;
      if (mounted) {
        _synchronize();
      }
    });
  }

  bool get _visible =>
      widget.visible &&
      widget.preferences?.visible == true &&
      _foreground &&
      _allowed &&
      _onScreen;

  void _synchronize() {
    if (!mounted || _bundle == null) {
      return;
    }
    final visible = _visible;
    final preference = widget.preferences;
    final next = (
      _bundle,
      _dark,
      widget.state,
      widget.scopeKey,
      preference,
      _foreground,
      _allowed,
      _motion,
      visible,
    );
    final freshReaction =
        widget.reactionKey != null && widget.reactionKey != _handledReaction;
    if (freshReaction) {
      _handledReaction = widget.reactionKey;
    }
    final changed = next != _configuration;
    if (!changed && !freshReaction) {
      return;
    }
    _configuration = next;
    _clearTexture();
    if (visible) {
      unawaited(
        _load(
          sprite:
              freshReaction &&
              _motion &&
              preference?.motion == 'full' &&
              preference?.intensity != 'quiet',
        ),
      );
    }
    setState(() {});
  }

  void _clearTexture() {
    _generation++;
    _clock.stop();
    _image?.dispose();
    _image = null;
    _clip = null;
    _sprite = false;
  }

  Future<void> _load({required bool sprite}) async {
    final bundle = _bundle;
    if (bundle == null || !mounted || !_visible) {
      return;
    }
    _clearTexture();
    final generation = _generation;
    final configuration = _configuration;
    final state = widget.state, dark = _dark;
    bool current() =>
        mounted &&
        generation == _generation &&
        configuration == _configuration &&
        _visible;
    try {
      final manifest = await AtlasAssets.manifest(bundle);
      if (!current() || manifest == null) {
        return;
      }
      final clip = manifest.states[state];
      if (clip == null) {
        return;
      }
      final animated = sprite && clip.durationMs > 0 && clip.frameCount > 1;
      final image = await AtlasAssets.texture(
        bundle,
        clip,
        dark: dark,
        sprite: animated,
      );
      if (!current()) {
        image.dispose();
        return;
      }
      setState(() {
        _image = image;
        _clip = clip;
        _sprite = animated;
      });
      if (animated) {
        _clock.duration = Duration(milliseconds: clip.durationMs);
        _clock.forward(from: 0);
      }
    } catch (_) {
      // Missing, incomplete, or mismatched deliveries keep the approved neutral.
      if (current()) {
        setState(() {});
      }
    }
  }

  @override
  void dispose() {
    _generation++;
    WidgetsBinding.instance.removeObserver(this);
    for (final position in _scrollPositions) {
      position.removeListener(_queueVisibilityCheck);
    }
    _clock.dispose();
    _image?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final image = _image, clip = _clip;
    final visible =
        widget.visible &&
        widget.preferences?.visible == true &&
        _foreground &&
        _allowed;
    return ExcludeSemantics(
      child: IgnorePointer(
        child: SizedBox.square(
          dimension: widget.size,
          child: !visible
              ? const SizedBox.expand()
              : image == null || clip == null
              ? Image.asset(
                  'assets/companion/atlas-neutral.png',
                  fit: BoxFit.contain,
                  excludeFromSemantics: true,
                  errorBuilder: (_, _, _) => const SizedBox.expand(),
                )
              : RepaintBoundary(
                  child: CustomPaint(
                    painter: _AtlasPainter(image, clip, _sprite, _clock),
                  ),
                ),
        ),
      ),
    );
  }
}

class _AtlasPainter extends CustomPainter {
  _AtlasPainter(this.image, this.clip, this.sprite, this.clock)
    : super(repaint: clock);
  final ui.Image image;
  final AtlasClip clip;
  final bool sprite;
  final Animation<double> clock;
  @override
  void paint(Canvas canvas, Size size) {
    final frame = !sprite
        ? 0
        : clock.value >= 1
        ? clip.frameCount - 1
        : (clock.value * clip.durationMs / 50).floor().clamp(
            0,
            clip.frameCount - 1,
          );
    final source = Rect.fromLTWH(
      sprite ? (frame % 4) * 256.0 : 0,
      sprite ? (frame ~/ 4) * 256.0 : 0,
      256,
      256,
    );
    canvas.drawImageRect(
      image,
      source,
      Offset.zero & size,
      Paint()..filterQuality = FilterQuality.medium,
    );
  }

  @override
  bool shouldRepaint(covariant _AtlasPainter oldDelegate) =>
      oldDelegate.image != image ||
      oldDelegate.sprite != sprite ||
      oldDelegate.clip != clip;
}
