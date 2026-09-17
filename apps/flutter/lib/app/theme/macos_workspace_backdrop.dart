import 'package:flutter/material.dart';

/// A quiet desktop canvas that gives large windows depth without animating or
/// competing with the work surface.
class MacosWorkspaceBackdrop extends StatelessWidget {
  const MacosWorkspaceBackdrop({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final dark = scheme.brightness == Brightness.dark;
    final transparentScaffold = Theme.of(context)
        .copyWith(scaffoldBackgroundColor: Colors.transparent);

    return RepaintBoundary(
      child: ColoredBox(
        color: scheme.surfaceContainerLowest,
        child: CustomPaint(
          painter: _MacosWorkspacePainter(
            primary: scheme.primary.withValues(alpha: dark ? .07 : .055),
            secondary: scheme.secondary.withValues(alpha: dark ? .035 : .028),
            line: scheme.outlineVariant.withValues(alpha: dark ? .12 : .18),
          ),
          child: Theme(data: transparentScaffold, child: child),
        ),
      ),
    );
  }
}

class _MacosWorkspacePainter extends CustomPainter {
  const _MacosWorkspacePainter({
    required this.primary,
    required this.secondary,
    required this.line,
  });

  final Color primary;
  final Color secondary;
  final Color line;

  @override
  void paint(Canvas canvas, Size size) {
    final short = size.shortestSide;
    final primaryCenter = Offset(size.width * .18, -short * .08);
    final primaryRadius = short * .9;
    canvas.drawCircle(
      primaryCenter,
      primaryRadius,
      Paint()
        ..shader =
            RadialGradient(colors: [primary, primary.withValues(alpha: 0)])
                .createShader(
                  Rect.fromCircle(center: primaryCenter, radius: primaryRadius),
                ),
    );

    final secondaryCenter = Offset(size.width * .96, size.height * .92);
    final secondaryRadius = short * .62;
    canvas.drawCircle(
      secondaryCenter,
      secondaryRadius,
      Paint()
        ..shader =
            RadialGradient(
              colors: [secondary, secondary.withValues(alpha: 0)],
            ).createShader(
              Rect.fromCircle(center: secondaryCenter, radius: secondaryRadius),
            ),
    );

    final path = Path()
      ..moveTo(size.width * .46, 0)
      ..cubicTo(
        size.width * .58,
        size.height * .24,
        size.width * .38,
        size.height * .52,
        size.width * .56,
        size.height,
      );
    canvas.drawPath(
      path,
      Paint()
        ..color = line
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1,
    );
  }

  @override
  bool shouldRepaint(covariant _MacosWorkspacePainter oldDelegate) =>
      oldDelegate.primary != primary ||
      oldDelegate.secondary != secondary ||
      oldDelegate.line != line;
}
