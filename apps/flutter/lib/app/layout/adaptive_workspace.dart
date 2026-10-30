import 'dart:ui' show DisplayFeature;

import 'package:flutter/material.dart';

/// Shared width decisions use the space available to a feature, after native
/// navigation and safe areas. A wide phone never becomes a Mac workspace.
@immutable
class AdaptiveWorkspaceMetrics {
  const AdaptiveWorkspaceMetrics({
    required this.contentWidth,
    this.breakpoint = 720,
  });

  factory AdaptiveWorkspaceMetrics.of(
    BuildContext context,
    BoxConstraints constraints, {
    double breakpoint = 720,
  }) => AdaptiveWorkspaceMetrics(
    contentWidth: constraints.hasBoundedWidth
        ? constraints.maxWidth
        : MediaQuery.sizeOf(context).width,
    breakpoint: breakpoint,
  );

  final double contentWidth;
  final double breakpoint;
  bool get isExpanded => contentWidth >= breakpoint;
}

/// Retains the same primary and secondary element positions while a window
/// changes size. Use intrinsic mode inside a scroll view; fillHeight mode is
/// for bounded, independently scrolling list/detail panes. A compact bounded
/// layout keeps the secondary mounted but hidden; its feature owns drill-down.
class AdaptiveWorkspaceLayout extends StatelessWidget {
  const AdaptiveWorkspaceLayout({
    super.key,
    required this.primary,
    this.secondary,
    this.breakpoint = 720,
    this.secondaryWidth = 300,
    this.gap = 24,
    this.fillHeight = false,
  });

  final Widget primary;
  final Widget? secondary;
  final double breakpoint;
  final double secondaryWidth;
  final double gap;
  final bool fillHeight;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final metrics = AdaptiveWorkspaceMetrics.of(
        context,
        constraints,
        breakpoint: breakpoint,
      );
      final split = secondary != null && metrics.isExpanded;
      final asideWidth = secondaryWidth.clamp(0.0, metrics.contentWidth * .45);
      if (fillHeight) {
        assert(
          constraints.hasBoundedHeight,
          'fillHeight needs a bounded viewport',
        );
        return Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(child: primary),
            SizedBox(width: split ? gap : 0),
            Offstage(
              offstage: !split,
              child: ExcludeFocus(
                excluding: !split,
                child: TickerMode(
                  enabled: split,
                  child: SizedBox(width: asideWidth, child: secondary),
                ),
              ),
            ),
          ],
        );
      }
      return Wrap(
        spacing: gap,
        runSpacing: gap,
        children: [
          SizedBox(
            width: split
                ? metrics.contentWidth - asideWidth - gap
                : metrics.contentWidth,
            child: primary,
          ),
          if (secondary != null)
            SizedBox(
              width: split ? asideWidth : metrics.contentWidth,
              child: secondary,
            ),
        ],
      );
    },
  );
}

/// Uses the largest unobstructed display region for app navigation and content.
/// On a continuous unfolded display, the full window remains available. A
/// physical hinge or half-open fold never covers an action, editor or dock.
/// Place directly under the window MediaQuery, before Scaffold/SafeArea padding.
class WorkspaceDisplayRegion extends StatelessWidget {
  const WorkspaceDisplayRegion({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final regions = DisplayFeatureSubScreen.subScreensInBounds(
      Offset.zero & media.size,
      DisplayFeatureSubScreen.avoidBounds(media),
    );
    var largest = Offset.zero & media.size;
    var area = -1.0;
    for (final region in regions) {
      final candidateArea = region.width * region.height;
      if (candidateArea > area) {
        largest = region;
        area = candidateArea;
      }
    }
    return DisplayFeatureSubScreen(
      anchorPoint: largest.center,
      child: MediaQuery(
        // Sub-screen padding does not update Flutter's inherited window size.
        // Descendant navigation must choose its layout from this safe pane.
        data: media
            .removeDisplayFeatures(largest)
            .copyWith(
              size: largest.size,
              displayFeatures: [
                for (final feature in media.displayFeatures)
                  if (largest.overlaps(feature.bounds))
                    DisplayFeature(
                      bounds: feature.bounds.shift(-largest.topLeft),
                      type: feature.type,
                      state: feature.state,
                    ),
              ],
            ),
        child: child,
      ),
    );
  }
}
