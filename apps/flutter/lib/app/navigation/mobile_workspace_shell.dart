import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import 'app_destination.dart';

/// Installed-phone navigation has its own information architecture. Branches
/// still belong to the existing lazy StatefulShellRoute and keep their state.
class MobileWorkspaceShell extends StatelessWidget {
  const MobileWorkspaceShell({super.key, required this.navigationShell});

  final StatefulNavigationShell navigationShell;

  static const _destinations = [
    (
      path: '/today',
      label: 'Today',
      icon: Icons.wb_sunny_outlined,
      selected: Icons.wb_sunny_rounded,
    ),
    (
      path: '/talk',
      label: 'Assistant',
      icon: Icons.graphic_eq_rounded,
      selected: Icons.graphic_eq_rounded,
    ),
    (
      path: '/capture',
      label: 'Capture',
      icon: Icons.add_circle_outline_rounded,
      selected: Icons.add_circle_rounded,
    ),
    (
      path: '/projects',
      label: 'Work',
      icon: Icons.work_outline_rounded,
      selected: Icons.work_rounded,
    ),
    (
      path: '/library',
      label: 'Library',
      icon: Icons.widgets_outlined,
      selected: Icons.widgets_rounded,
    ),
  ];

  void _select(int index) {
    final branch = destinationIndex(_destinations[index].path);
    if (branch < 0 || branch == navigationShell.currentIndex) return;
    FocusManager.instance.primaryFocus?.unfocus();
    navigationShell.goBranch(branch);
  }

  @override
  Widget build(BuildContext context) {
    final path = appDestinations[navigationShell.currentIndex].path;
    final primaryIndex = _destinations.indexWhere((item) => item.path == path);
    final selected = primaryIndex < 0 ? _destinations.length - 1 : primaryIndex;
    final scheme = Theme.of(context).colorScheme;
    final wide = MediaQuery.sizeOf(context).width >= 840;
    final keyboardOpen = MediaQuery.viewInsetsOf(context).bottom > 0;
    final reducedMotion = MediaQuery.disableAnimationsOf(context);
    final scaledLabels = MediaQuery.textScalerOf(context).scale(13) > 18;
    final content = SafeArea(
      bottom: wide || keyboardOpen,
      child: RepaintBoundary(child: navigationShell),
    );

    return AnnotatedRegion<SystemUiOverlayStyle>(
      value:
          (Theme.of(context).brightness == Brightness.dark
                  ? SystemUiOverlayStyle.light
                  : SystemUiOverlayStyle.dark)
              .copyWith(
                statusBarColor: Colors.transparent,
                systemNavigationBarColor: scheme.surface,
                systemNavigationBarDividerColor: Colors.transparent,
              ),
      child: Scaffold(
        backgroundColor: scheme.surfaceContainerLowest,
        body: wide
            ? Row(
                children: [
                  SafeArea(
                    child: NavigationRail(
                      selectedIndex: selected,
                      onDestinationSelected: _select,
                      labelType: NavigationRailLabelType.all,
                      groupAlignment: -.7,
                      destinations: [
                        for (final item in _destinations)
                          NavigationRailDestination(
                            icon: Icon(item.icon),
                            selectedIcon: Icon(item.selected),
                            label: Text(item.label),
                          ),
                      ],
                    ),
                  ),
                  VerticalDivider(width: 1, color: scheme.outlineVariant),
                  Expanded(child: content),
                ],
              )
            : content,
        bottomNavigationBar: wide || keyboardOpen
            ? null
            : DecoratedBox(
                decoration: BoxDecoration(
                  color: scheme.surface,
                  border: Border(top: BorderSide(color: scheme.outlineVariant)),
                ),
                child: SafeArea(
                  top: false,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(8, 6, 8, 4),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        for (
                          var index = 0;
                          index < _destinations.length;
                          index++
                        )
                          Expanded(
                            child: Semantics(
                              selected: index == selected,
                              child: InkWell(
                                borderRadius: BorderRadius.circular(14),
                                onTap: () => _select(index),
                                child: ConstrainedBox(
                                  constraints: BoxConstraints(
                                    minHeight: scaledLabels ? 82 : 64,
                                  ),
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(
                                      vertical: 5,
                                      horizontal: 2,
                                    ),
                                    child: Column(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        AnimatedContainer(
                                          duration: reducedMotion
                                              ? Duration.zero
                                              : const Duration(
                                                  milliseconds: 180,
                                                ),
                                          curve: Curves.easeOutCubic,
                                          width: 42,
                                          height: 28,
                                          decoration: BoxDecoration(
                                            color: index == selected
                                                ? scheme.secondaryContainer
                                                : Colors.transparent,
                                            borderRadius: BorderRadius.circular(
                                              100,
                                            ),
                                          ),
                                          child: Icon(
                                            index == selected
                                                ? _destinations[index].selected
                                                : _destinations[index].icon,
                                            size: 22,
                                            color: index == selected
                                                ? scheme.secondary
                                                : scheme.onSurfaceVariant,
                                          ),
                                        ),
                                        const SizedBox(height: 5),
                                        Text(
                                          _destinations[index].label,
                                          textAlign: TextAlign.center,
                                          style: Theme.of(context)
                                              .textTheme
                                              .labelSmall
                                              ?.copyWith(
                                                fontSize: 11,
                                                fontWeight: index == selected
                                                    ? FontWeight.w700
                                                    : FontWeight.w500,
                                                color: index == selected
                                                    ? scheme.onSurface
                                                    : scheme.onSurfaceVariant,
                                              ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
      ),
    );
  }
}
