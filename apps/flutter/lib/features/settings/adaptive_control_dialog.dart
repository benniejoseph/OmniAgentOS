import 'package:flutter/material.dart';

import '../../app/mobile/mobile_flow_scaffold.dart';
import '../../app/platform/mobile_presentation.dart';

/// Retains the feature's existing dialog route and decision callbacks while
/// giving long phone editors and exact reviews a complete screen.
class AdaptiveControlDialog extends StatelessWidget {
  const AdaptiveControlDialog({
    super.key,
    this.title,
    this.content,
    this.actions,
    this.icon,
    this.scrollable = false,
    this.insetPadding = const EdgeInsets.symmetric(
      horizontal: 40,
      vertical: 24,
    ),
  });

  final Widget? title, content, icon;
  final List<Widget>? actions;
  final bool scrollable;
  final EdgeInsets insetPadding;

  @override
  Widget build(BuildContext context) {
    if (!usesMobilePresentation()) {
      return AlertDialog(
        title: title,
        content: content,
        actions: actions,
        icon: icon,
        scrollable: scrollable,
        insetPadding: insetPadding,
      );
    }
    final heading = title;
    return Dialog.fullscreen(
      child: MobileFlowScaffold(
        title: heading is Text ? heading.data ?? 'Review' : 'Review',
        onClose: () => Navigator.of(context).pop(),
        footer: actions == null || actions!.isEmpty
            ? null
            : ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.sizeOf(context).height * .3,
                ),
                child: SingleChildScrollView(
                  child: Wrap(
                    alignment: WrapAlignment.end,
                    spacing: 10,
                    runSpacing: 8,
                    children: actions!,
                  ),
                ),
              ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (icon != null) ...[icon!, const SizedBox(height: 16)],
            if (heading != null && heading is! Text) ...[
              heading,
              const SizedBox(height: 16),
            ],
            if (content != null) content!,
          ],
        ),
      ),
    );
  }
}
