import 'package:flutter/material.dart';

/// Uses the same shield asset as the web app. Native layout may adapt, but the
/// product mark must never fork into a platform-specific identity.
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
  Widget build(BuildContext context) => Semantics(
    label: 'Asael',
    image: true,
    child: Container(
      width: size,
      height: size,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: const Color(0xFF060A09),
        borderRadius: BorderRadius.circular(size * .28),
        border: Border.all(
          color: Theme.of(context).colorScheme.primary.withValues(alpha: .18),
        ),
        boxShadow: [
          BoxShadow(
            color: Theme.of(context).colorScheme.primary.withValues(alpha: .12),
            blurRadius: size * .55,
            offset: Offset(0, size * .16),
          ),
        ],
      ),
      child: Image.asset(
        'assets/brand/asael-mark.png',
        width: size,
        height: size,
        fit: BoxFit.cover,
        filterQuality: FilterQuality.high,
      ),
    ),
  );
}

class AsaelWordmark extends StatelessWidget {
  const AsaelWordmark({super.key, this.compact = false, this.color});

  final bool compact;
  final Color? color;

  @override
  Widget build(BuildContext context) => Text(
    'Asael',
    style: TextStyle(
      color: color ?? Theme.of(context).colorScheme.onSurface,
      fontSize: compact ? 15 : 18,
      fontWeight: FontWeight.w600,
      letterSpacing: compact ? -.15 : -.25,
      height: 1,
    ),
  );
}
