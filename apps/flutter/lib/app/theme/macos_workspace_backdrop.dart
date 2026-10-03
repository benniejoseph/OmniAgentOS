import 'package:flutter/material.dart';

/// Flat desktop canvas using the same opaque semantic surface as mobile.
class MacosWorkspaceBackdrop extends StatelessWidget {
  const MacosWorkspaceBackdrop({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.surfaceContainerLowest,
    child: child,
  );
}
