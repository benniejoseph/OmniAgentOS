import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:lottie/lottie.dart';

import '../../core/platform/macos_power_state.dart';
import 'atlas_assets.dart' show atlasMotionAllowed;
import 'atlas_lottie_assets.dart';
import 'companion_models.dart';

/// A decorative state portrait. A fresh reaction key permits one finite clip.
/// Explicit voice playback may repeat its speaking performance for the duration
/// of actual output. Idle, listening, work and outcome reactions never loop.
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
    this.voiceExpression = false,
    this.playbackActive = false,
    this.floatingPresence = false,
  });
  final String state;
  final double size;
  final bool visible;

  /// Idle greetings keep the same quiet vector pose without a reaction.
  final bool greeting;
  final CompanionPreferences? preferences;
  final Object? scopeKey, reactionKey;
  final ValueListenable<MacosPowerState>? powerState;

  /// An explicitly opened voice surface can express real audio state in both
  /// Balanced and Expressive. It never changes execution or audio authority.
  final bool voiceExpression;
  final bool playbackActive;

  /// A visible Mac voice window remains present when another app has focus.
  final bool floatingPresence;
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
    _foreground = _lifecycleVisible(WidgetsBinding.instance.lifecycleState);
    // Reactions settle at their final pose; only real voice playback can repeat.
    _clock = AnimationController(vsync: this);
    _powerState = widget.powerState ?? MacosPowerStateMonitor.instance;
    _powerState.addListener(_synchronize);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _bundle = DefaultAssetBundle.of(context);
    _dark = Theme.of(context).brightness == Brightness.dark;
    _motion =
        !MediaQuery.disableAnimationsOf(context) &&
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
    _foreground = _lifecycleVisible(WidgetsBinding.instance.lifecycleState);
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
    _foreground = _lifecycleVisible(state);
    _synchronize();
  }

  bool _lifecycleVisible(AppLifecycleState? state) =>
      state == null ||
      state == AppLifecycleState.resumed ||
      (widget.floatingPresence && state == AppLifecycleState.inactive);

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
      widget.voiceExpression,
      widget.playbackActive,
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
      final voiceMotion =
          widget.voiceExpression &&
          (preference?.intensity == 'balanced' ||
              preference?.intensity == 'expressive') &&
          const {'listening', 'responding', 'working'}.contains(widget.state);
      final playback =
          widget.voiceExpression &&
          widget.playbackActive &&
          widget.state == 'responding';
      final animate =
          !_staticGreeting &&
          (freshReaction || playback) &&
          _motion &&
          _powerState.value == MacosPowerState.disabled &&
          preference?.motion == 'full' &&
          (voiceMotion ||
              atlasMotionAllowed(preference?.intensity, widget.state));
      unawaited(_load(animate: animate, repeatPlayback: animate && playback));
    }
    setState(() {});
  }

  void _clearComposition() {
    _generation++;
    _clock.stop();
    _composition = null;
  }

  Future<void> _load({
    required bool animate,
    required bool repeatPlayback,
  }) async {
    final bundle = _bundle;
    if (bundle == null || !mounted || !_visible) return;
    final generation = _generation;
    final configuration = _configuration;
    bool current() =>
        mounted &&
        generation == _generation &&
        configuration == _configuration &&
        _visible;
    try {
      final composition = await AtlasLottieAssets.load(
        bundle,
        widget.state,
        dark: _dark,
      );
      if (!current()) return;
      _clock.duration = composition.duration;
      _clock.value = 1;
      setState(() => _composition = composition);
      if (repeatPlayback) {
        _clock.value = 0;
        _clock.repeat();
      } else if (animate) {
        _clock.forward(from: 0);
      }
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
              : RepaintBoundary(
                  child: composition == null
                      ? CustomPaint(
                          painter: _AtlasStillPainter(
                            Theme.of(context).colorScheme,
                          ),
                        )
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

/// Original Scout still. Loading and failure never start an animation clock.
class _AtlasStillPainter extends CustomPainter {
  const _AtlasStillPainter(this.colors);
  final ColorScheme colors;

  @override
  void paint(Canvas canvas, Size size) {
    final dark = colors.brightness == Brightness.dark;
    final shell = dark ? colors.onSurface : colors.surfaceContainerLowest;
    final face = dark ? colors.surfaceContainerLowest : colors.onSurface;
    final edge = dark ? const Color(0xFFD9D4CB) : colors.outlineVariant;
    const eye = Color(0xFFFAF9F6);
    Paint fill(Color color) => Paint()..color = color;
    Paint line(Color color, double width) => Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = width
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    void box(
      double x,
      double y,
      double w,
      double h,
      double radius,
      Color color, {
      bool outlined = false,
    }) {
      final shape = RRect.fromRectAndRadius(
        Rect.fromCenter(center: Offset(x, y), width: w, height: h),
        Radius.circular(radius),
      );
      canvas.drawRRect(shape, fill(color));
      if (outlined) canvas.drawRRect(shape, line(colors.outline, 2));
    }

    canvas.save();
    canvas.scale(size.width / 256, size.height / 256);
    canvas.drawOval(
      const Rect.fromLTWH(80, 224.5, 96, 13),
      fill((dark ? Colors.black : face).withValues(alpha: .10)),
    );
    canvas.translate(128, 132);
    box(-22, 84, 28, 15, 7, colors.secondary);
    box(22, 84, 28, 15, 7, colors.secondary);
    for (final side in [-1, 1]) {
      canvas.save();
      canvas.translate(side * 52.0, 26);
      canvas.rotate(-side * 14 * 3.141592653589793 / 180);
      box(0, 16, 21, 42, 10, edge, outlined: true);
      canvas.drawOval(const Rect.fromLTWH(-13, 23.5, 26, 23), fill(shell));
      canvas.drawOval(
        const Rect.fromLTWH(-13, 23.5, 26, 23),
        line(colors.outline, 1.8),
      );
      box(0, 26, 20, 6, 3, colors.secondary);
      canvas.restore();
    }
    box(0, 53, 75, 67, 28, shell, outlined: true);
    box(0, 18, 59, 15, 7, face);
    box(0, 52, 14, 14, 5, colors.secondary);
    box(0, 51, 4, 6, 2, shell);
    canvas.translate(0, -39);
    final crest = Path()
      ..moveTo(-28, -48)
      ..cubicTo(-27, -55, -30, -72, -24, -70)
      ..cubicTo(-19, -69, -17, -68, -11, -65)
      ..cubicTo(-5, -63, -1, -68, 4, -66)
      ..cubicTo(3, -60, 2, -56, 0, -50)
      ..cubicTo(-7, -50, -29, -43, -28, -48)
      ..close();
    canvas.drawPath(crest, fill(colors.secondary));
    final helmet = Path()
      ..moveTo(-79, -5)
      ..cubicTo(-79, 9, -75, -37, -61, -47)
      ..cubicTo(-47, -57, -21, -59, 3, -58)
      ..cubicTo(27, -57, 45, -56, 62, -44)
      ..cubicTo(74, -35, 79, -22, 80, -4)
      ..cubicTo(81, 13, 79, 23, 74, 32)
      ..cubicTo(66, 48, 67, 53, 48, 54)
      ..cubicTo(24, 56, -29, 57, -51, 51)
      ..cubicTo(-70, 45, -70, 40, -77, 27)
      ..cubicTo(-83, 16, -79, -23, -79, -5)
      ..close();
    canvas.drawPath(helmet, fill(shell));
    canvas.drawPath(helmet, line(colors.outline, 2));
    box(0, 2, 129, 76, 29, face);
    box(-26, -2, 14, 23, 7, eye);
    box(26, -2, 14, 23, 7, eye);
    final smile = Path()
      ..moveTo(-11, 15)
      ..cubicTo(-9, 19, -5, 21, 0, 21)
      ..cubicTo(5, 21, 9, 19, 11, 15);
    canvas.drawPath(smile, line(eye, 3.5));
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _AtlasStillPainter oldDelegate) =>
      oldDelegate.colors != colors;
}
