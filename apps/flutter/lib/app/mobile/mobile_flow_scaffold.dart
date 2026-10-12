import 'package:flutter/material.dart';

/// Phone composition for a focused editor, review or reader. Route ownership,
/// authorization invalidation and mutation callbacks remain with the feature.
/// Use inside the feature's existing guarded route (or Dialog.fullscreen).
class MobileFlowScaffold extends StatelessWidget {
  const MobileFlowScaffold({
    super.key,
    required this.title,
    required this.child,
    this.footer,
    this.actions = const [],
    this.onClose,
    this.scrollBody = true,
    this.padding = const EdgeInsets.all(20),
  });

  final String title;
  final Widget child;
  final Widget? footer;
  final List<Widget> actions;
  final VoidCallback? onClose;
  final bool scrollBody;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      leading: BackButton(onPressed: onClose),
      title: Text(title),
      actions: actions,
    ),
    body: SafeArea(
      top: false,
      bottom: footer == null,
      child: scrollBody
          ? SingleChildScrollView(
              keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
              padding: padding,
              child: child,
            )
          : Padding(padding: padding, child: child),
    ),
    bottomNavigationBar: footer == null
        ? null
        : Material(
            color: Theme.of(context).colorScheme.surface,
            child: SafeArea(
              top: false,
              minimum: const EdgeInsets.fromLTRB(20, 12, 20, 12),
              child: footer!,
            ),
          ),
  );
}

/// Secondary provenance stays available without taking over the reading flow.
/// Never use this to hide the consequence or payload a user must approve.
class MobileDetailsDisclosure extends StatelessWidget {
  const MobileDetailsDisclosure({
    super.key,
    required this.child,
    this.title = 'Source details',
    this.initiallyExpanded = false,
  });

  final Widget child;
  final String title;
  final bool initiallyExpanded;

  @override
  Widget build(BuildContext context) => Material(
    type: MaterialType.transparency,
    child: ExpansionTile(
      title: Text(title),
      initiallyExpanded: initiallyExpanded,
      tilePadding: EdgeInsets.zero,
      childrenPadding: const EdgeInsets.only(bottom: 16),
      expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
      expansionAnimationStyle: MediaQuery.disableAnimationsOf(context)
          ? AnimationStyle.noAnimation
          : null,
      children: [child],
    ),
  );
}
