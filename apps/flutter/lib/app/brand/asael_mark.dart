import 'package:flutter/material.dart';

class AsaelMark extends StatelessWidget {
  const AsaelMark({
    super.key,
    this.size = 44,
    this.backgroundColor,
    this.foregroundColor,
  });

  final double size;
  final Color? backgroundColor;
  final Color? foregroundColor;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      label: 'Asael',
      image: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: backgroundColor ?? scheme.primary,
          borderRadius: BorderRadius.circular(size * .3),
          boxShadow: [
            BoxShadow(
              color: (backgroundColor ?? scheme.primary).withValues(alpha: .2),
              blurRadius: size * .45,
              offset: Offset(0, size * .14),
            ),
          ],
        ),
        child: SizedBox.square(
          dimension: size,
          child: CustomPaint(
            painter: _AsaelGlyphPainter(foregroundColor ?? scheme.onPrimary),
          ),
        ),
      ),
    );
  }
}

class AsaelWordmark extends StatelessWidget {
  const AsaelWordmark({super.key, this.compact = false, this.color});

  final bool compact;
  final Color? color;

  @override
  Widget build(BuildContext context) => Text(
    'ASAEL',
    style: TextStyle(
      color: color ?? Theme.of(context).colorScheme.onSurface,
      fontSize: compact ? 15 : 18,
      fontWeight: FontWeight.w800,
      letterSpacing: compact ? 2.1 : 2.8,
      height: 1,
    ),
  );
}

class _AsaelGlyphPainter extends CustomPainter {
  const _AsaelGlyphPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final link = Paint()
      ..color = color.withValues(alpha: .76)
      ..strokeWidth = size.width * .052
      ..strokeCap = StrokeCap.round;
    final node = Paint()..color = color;
    final center = Offset(size.width * .5, size.height * .5);
    final points = <Offset>[
      Offset(size.width * .5, size.height * .23),
      Offset(size.width * .76, size.height * .42),
      Offset(size.width * .66, size.height * .73),
      Offset(size.width * .34, size.height * .73),
      Offset(size.width * .24, size.height * .42),
    ];
    for (final point in points) {
      canvas.drawLine(center, point, link);
      canvas.drawCircle(point, size.width * .06, node);
    }
    canvas.drawCircle(center, size.width * .085, node);
  }

  @override
  bool shouldRepaint(_AsaelGlyphPainter oldDelegate) =>
      oldDelegate.color != color;
}
