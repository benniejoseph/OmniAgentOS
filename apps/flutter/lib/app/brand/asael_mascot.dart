import 'package:flutter/material.dart';
import 'package:lottie/lottie.dart';

/// The passive visual state shown by [AsaelMascot].
enum AsaelMascotState {
  ready,
  listening,
  transcribing,
  working,
  success,
  attention,
}

/// A calm, stateful companion to the Asael product mark.
///
/// The mascot communicates activity; it never replaces the product mark and
/// intentionally exposes no gestures or callbacks.
class AsaelMascot extends StatefulWidget {
  const AsaelMascot({super.key, required this.state, this.size = 72});

  final AsaelMascotState state;
  final double size;

  @override
  State<AsaelMascot> createState() => _AsaelMascotWidgetState();
}

class _AsaelMascotWidgetState extends State<AsaelMascot>
    with SingleTickerProviderStateMixin {
  static const _assetName = 'assets/mascot/asael-orbit.json';
  static const _totalFrames = 180.0;
  static const _minimumSize = 24.0;
  static const _maximumSize = 240.0;

  late final AnimationController _controller;
  bool _compositionLoaded = false;
  bool _motionPreferenceInitialized = false;
  bool _reduceMotion = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final media = MediaQuery.maybeOf(context);
    final reduceMotion =
        media?.disableAnimations == true || media?.accessibleNavigation == true;
    if (!_motionPreferenceInitialized || _reduceMotion != reduceMotion) {
      _motionPreferenceInitialized = true;
      _reduceMotion = reduceMotion;
      _synchronizeAnimation();
    }
  }

  @override
  void didUpdateWidget(covariant AsaelMascot oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.state != widget.state) {
      _synchronizeAnimation();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _handleLoaded(LottieComposition composition) {
    _compositionLoaded = true;
    _controller.duration = composition.duration;
    _synchronizeAnimation();
  }

  void _synchronizeAnimation() {
    final segment = _segmentFor(widget.state);
    _controller.stop();
    if (_reduceMotion || !_compositionLoaded) {
      _controller.value = segment.posterFrame / _totalFrames;
      return;
    }
    _controller.repeat(
      min: segment.startFrame / _totalFrames,
      max: (segment.endFrame - .001) / _totalFrames,
      period: segment.period,
    );
  }

  @override
  Widget build(BuildContext context) {
    final requestedSize = widget.size.isFinite ? widget.size : 72.0;
    final boundedSize = requestedSize
        .clamp(_minimumSize, _maximumSize)
        .toDouble();
    final segment = _segmentFor(widget.state);
    return Semantics(
      label: segment.semanticLabel,
      image: true,
      liveRegion: widget.state != AsaelMascotState.ready,
      child: RepaintBoundary(
        child: SizedBox.square(
          dimension: boundedSize,
          child: ExcludeSemantics(
            child: Lottie.asset(
              _assetName,
              controller: _controller,
              onLoaded: _handleLoaded,
              width: boundedSize,
              height: boundedSize,
              fit: BoxFit.contain,
              alignment: Alignment.center,
              frameRate: FrameRate.composition,
              addRepaintBoundary: false,
              filterQuality: FilterQuality.medium,
            ),
          ),
        ),
      ),
    );
  }
}

_MascotSegment _segmentFor(AsaelMascotState state) => switch (state) {
  AsaelMascotState.ready => const _MascotSegment(
    startFrame: 0,
    endFrame: 30,
    posterFrame: 15,
    period: Duration(milliseconds: 1600),
    semanticLabel: 'Asael is ready',
  ),
  AsaelMascotState.listening => const _MascotSegment(
    startFrame: 30,
    endFrame: 60,
    posterFrame: 42,
    period: Duration(milliseconds: 1100),
    semanticLabel: 'Asael is listening',
  ),
  AsaelMascotState.transcribing => const _MascotSegment(
    startFrame: 60,
    endFrame: 90,
    posterFrame: 75,
    period: Duration(milliseconds: 900),
    semanticLabel: 'Asael is transcribing',
  ),
  AsaelMascotState.working => const _MascotSegment(
    startFrame: 90,
    endFrame: 120,
    posterFrame: 105,
    period: Duration(milliseconds: 950),
    semanticLabel: 'Asael is working',
  ),
  AsaelMascotState.success => const _MascotSegment(
    startFrame: 120,
    endFrame: 150,
    posterFrame: 138,
    period: Duration(milliseconds: 1400),
    semanticLabel: 'Asael completed the task',
  ),
  AsaelMascotState.attention => const _MascotSegment(
    startFrame: 150,
    endFrame: 180,
    posterFrame: 165,
    period: Duration(milliseconds: 1050),
    semanticLabel: 'Asael needs your attention',
  ),
};

class _MascotSegment {
  const _MascotSegment({
    required this.startFrame,
    required this.endFrame,
    required this.posterFrame,
    required this.period,
    required this.semanticLabel,
  });

  final double startFrame;
  final double endFrame;
  final double posterFrame;
  final Duration period;
  final String semanticLabel;
}
