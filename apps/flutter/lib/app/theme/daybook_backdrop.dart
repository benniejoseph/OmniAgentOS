import 'package:flutter/material.dart';

import 'app_theme.dart';

/// The same warm/cool Daybook canvas used behind the authenticated web shell.
class DaybookBackdrop extends StatelessWidget {
  const DaybookBackdrop({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final colors = context.asaelColors;
    final transparentScaffold = Theme.of(context)
        .copyWith(scaffoldBackgroundColor: Colors.transparent);
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: dark
              ? const [Color(0xFF071416), Color(0xFF030C0F), Color(0xFF02080A)]
              : const [Color(0xFFFFFEF8), Color(0xFFFEF9EC), Color(0xFFFEF3E2)],
          stops: const [0, .46, 1],
        ),
      ),
      child: CustomPaint(
        painter: _DaybookGlowPainter(
          warm: colors.accent.withValues(alpha: dark ? .07 : .12),
          cool: (dark ? const Color(0xFF0C2B34) : const Color(0xFFBAEAFC))
              .withValues(alpha: dark ? .22 : .24),
          line: colors.line.withValues(alpha: dark ? .16 : .22),
        ),
        child: Theme(data: transparentScaffold, child: child),
      ),
    );
  }
}

class _DaybookGlowPainter extends CustomPainter {
  const _DaybookGlowPainter({
    required this.warm,
    required this.cool,
    required this.line,
  });

  final Color warm;
  final Color cool;
  final Color line;

  @override
  void paint(Canvas canvas, Size size) {
    final warmCenter = Offset(size.width * .96, size.height * .06);
    final warmRadius = size.shortestSide * .72;
    canvas.drawCircle(
      warmCenter,
      warmRadius,
      Paint()
        ..shader = RadialGradient(
          colors: [warm, warm.withValues(alpha: 0)],
        ).createShader(Rect.fromCircle(center: warmCenter, radius: warmRadius)),
    );

    final coolCenter = Offset(-size.width * .06, size.height * .48);
    final coolRadius = size.shortestSide * .82;
    canvas.drawCircle(
      coolCenter,
      coolRadius,
      Paint()
        ..shader = RadialGradient(
          colors: [cool, cool.withValues(alpha: 0)],
        ).createShader(Rect.fromCircle(center: coolCenter, radius: coolRadius)),
    );

    canvas.drawArc(
      Rect.fromCircle(
        center: Offset(size.width * 1.02, size.height * .32),
        radius: size.width * .46,
      ),
      2.8,
      2.3,
      false,
      Paint()
        ..color = line
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1,
    );
  }

  @override
  bool shouldRepaint(_DaybookGlowPainter oldDelegate) =>
      oldDelegate.warm != warm ||
      oldDelegate.cool != cool ||
      oldDelegate.line != line;
}
