import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:lottie/lottie.dart';

import '../../core/platform/macos_power_state.dart';
import 'atlas_assets.dart' show atlasMotionAllowed;
import 'atlas_lottie_assets.dart';
import 'companion_models.dart';

/// A decorative state portrait. A fresh reaction key permits one finite clip;
/// returning to a visible route or changing preferences never replays that key.
class AtlasPortrait extends StatefulWidget {
  const AtlasPortrait({
    super.key,
    this.state = 'available',
    this.size = 36,
    this.visible = true,
    this.greeting = false,
    this.preferences,
    this.scopeKey,
    this.reactionKey,
    this.powerState,
  });
  final String state;
  final double size;
  final bool visible;

  /// Idle greetings keep the same quiet vector pose without a reaction.
  final bool greeting;
  final CompanionPreferences? preferences;
  final Object? scopeKey, reactionKey;
  final ValueListenable<MacosPowerState>? powerState;
  @override
  State<AtlasPortrait> createState() => _AtlasPortraitState();
}

class _AtlasPortraitState extends State<AtlasPortrait>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final AnimationController _clock;
  late ValueListenable<MacosPowerState> _powerState;
  final _scrollPositions = <ScrollPosition>{};
  AssetBundle? _bundle;
  Object? _configuration, _handledReaction;
  LottieComposition? _composition;
  bool _foreground = true, _dark = false, _motion = false, _allowed = false;
  bool _postFramePending = false;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    // Every reaction stops at the final vector pose. Idle has no ticker or loop.
    _clock = AnimationController(vsync: this);
    _powerState = widget.powerState ?? MacosPowerStateMonitor.instance;
    _powerState.addListener(_synchronize);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _bundle = DefaultAssetBundle.of(context);
    _dark = Theme.of(context).brightness == Brightness.dark;
    _motion = !MediaQuery.disableAnimationsOf(context) &&
        !MediaQuery.accessibleNavigationOf(context);
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
    if (!identical(oldWidget.powerState, widget.powerState)) {
      _powerState.removeListener(_synchronize);
      _powerState = widget.powerState ?? MacosPowerStateMonitor.instance;
      _powerState.addListener(_synchronize);
    }
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

  bool get _staticGreeting => widget.greeting && widget.state == 'available';

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
      _staticGreeting,
      widget.scopeKey,
      preference,
      _foreground,
      _allowed,
      _motion,
      _powerState,
      _powerState.value,
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
    _clearComposition();
    if (visible) {
      unawaited(
        _load(
          animate:
              !_staticGreeting &&
              freshReaction &&
              _motion &&
              _powerState.value == MacosPowerState.disabled &&
              preference?.motion == 'full' &&
              atlasMotionAllowed(preference?.intensity, widget.state),
        ),
      );
    }
    setState(() {});
  }

  void _clearComposition() {
    _generation++;
    _clock.stop();
    _composition = null;
  }

  Future<void> _load({required bool animate}) async {
    final bundle = _bundle;
    if (bundle == null || !mounted || !_visible) return;
    final generation = _generation;
    final configuration = _configuration;
    bool current() => mounted && generation == _generation &&
        configuration == _configuration && _visible;
    try {
      final composition = await AtlasLottieAssets.load(
        bundle, widget.state, dark: _dark,
      );
      if (!current()) return;
      _clock.duration = composition.duration;
      _clock.value = 1;
      setState(() => _composition = composition);
      if (animate) _clock.forward(from: 0);
    } catch (_) {
      // A matching vector still remains available if a bundled file fails.
      if (current()) setState(() {});
    }
  }

  @override
  void dispose() {
    _generation++;
    _powerState.removeListener(_synchronize);
    WidgetsBinding.instance.removeObserver(this);
    for (final position in _scrollPositions) {
      position.removeListener(_queueVisibilityCheck);
    }
    _clock.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final composition = _composition;
    final visible = widget.visible && widget.preferences?.visible == true &&
        _foreground && _allowed;
    return ExcludeSemantics(
      child: IgnorePointer(
        child: SizedBox.square(
          dimension: widget.size,
          child: !visible
              ? const SizedBox.expand()
              : RepaintBoundary(
                  child: composition == null
                      ? CustomPaint(painter: _AtlasStillPainter(
                          Theme.of(context).colorScheme,
                        ))
                      : Lottie(
                          composition: composition,
                          controller: _clock,
                          animate: false,
                          repeat: false,
                          fit: BoxFit.contain,
                          frameRate: FrameRate.composition,
                          addRepaintBoundary: false,
                        ),
                ),
        ),
      ),
    );
  }
}

/// Loading/failure pose uses the current theme and never starts a timer.
class _AtlasStillPainter extends CustomPainter {
  const _AtlasStillPainter(this.colors);
  final ColorScheme colors;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 256, size.height / 256);
    canvas.translate(128, 128);
    canvas.drawCircle(Offset.zero, 91, Paint()..color = colors.secondaryContainer.withValues(alpha: .42));
    canvas.save();
    canvas.rotate(-26 * 3.141592653589793 / 180);
    canvas.drawOval(Rect.fromCenter(center: Offset.zero, width: 210, height: 138),
      Paint()..color = colors.outlineVariant..style = PaintingStyle.stroke..strokeWidth = 2);
    canvas.restore();
    canvas.drawCircle(Offset.zero, 66, Paint()..color = colors.surface);
    canvas.drawCircle(Offset.zero, 66, Paint()..color = colors.outlineVariant..style = PaintingStyle.stroke..strokeWidth = 1.5);
    canvas.drawCircle(Offset.zero, 56, Paint()..color = colors.secondary.withValues(alpha: .23)..style = PaintingStyle.stroke..strokeWidth = .7);
    final star = Path()..moveTo(0, -40)
      ..cubicTo(3, -40, 7, -18, 13, -13)
      ..cubicTo(18, -7, 40, -3, 40, 0)
      ..cubicTo(40, 3, 18, 7, 13, 13)
      ..cubicTo(7, 18, 3, 40, 0, 40)
      ..cubicTo(-3, 40, -7, 18, -13, 13)
      ..cubicTo(-18, 7, -40, 3, -40, 0)
      ..cubicTo(-40, -3, -18, -7, -13, -13)
      ..cubicTo(-7, -18, -3, -40, 0, -40)..close();
    canvas.save();
    canvas.rotate(-12 * 3.141592653589793 / 180);
    canvas.drawPath(star, Paint()..color = colors.secondary);
    canvas.restore();
    canvas.drawCircle(Offset.zero, 4.5, Paint()..color = colors.surface);
    canvas.save();
    canvas.rotate(-26 * 3.141592653589793 / 180);
    canvas.drawArc(Rect.fromCenter(center: Offset.zero, width: 210, height: 138),
      15 * 3.141592653589793 / 180, 132 * 3.141592653589793 / 180, false,
      Paint()..color = colors.secondary..style = PaintingStyle.stroke..strokeWidth = 2.6..strokeCap = StrokeCap.round);
    canvas.restore();
    canvas.drawCircle(const Offset(55.75, -74.45), 11, Paint()..color = colors.surface);
    canvas.drawCircle(const Offset(55.75, -74.45), 6.5, Paint()..color = colors.secondary);
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _AtlasStillPainter oldDelegate) => oldDelegate.colors != colors;
}
