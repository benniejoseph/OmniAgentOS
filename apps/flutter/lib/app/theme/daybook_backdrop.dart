import 'package:flutter/material.dart';

import 'app_theme.dart';

/// Flat workspace canvas. The class name remains for existing shell imports.
class DaybookBackdrop extends StatelessWidget {
  const DaybookBackdrop({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) =>
      Material(color: context.asaelColors.background, child: child);
}
