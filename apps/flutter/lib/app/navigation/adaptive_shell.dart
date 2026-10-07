import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/native_client_info.dart';
import '../brand/asael_mark.dart';
import '../platform/macos_presentation.dart';
import '../theme/daybook_backdrop.dart';
import 'app_destination.dart';
import 'macos_workspace_shell.dart';

class AdaptiveShell extends StatelessWidget {
  const AdaptiveShell({super.key, required this.navigationShell});

  final StatefulNavigationShell navigationShell;

  // Derive branch positions from destination metadata so adding a workspace
  // cannot silently break the phone dock or attention shortcut.
  static final _everydayBranches = destinationIndices(
    primary: true,
    adaptiveVisible: true,
  );
  static final _workspaceBranches = destinationIndices(
    group: AppDestinationGroup.workspace,
    primary: false,
    adaptiveVisible: true,
  );
  static final _reviewBranches = destinationIndices(
    group: AppDestinationGroup.review,
    adaptiveVisible: true,
  );
  static final _systemBranches = destinationIndices(
    group: AppDestinationGroup.system,
    adaptiveVisible: true,
  );
  static final _advancedBranches = destinationIndices(
    group: AppDestinationGroup.advanced,
    adaptiveVisible: true,
  );
  static final _adaptiveBranches = [
    ..._everydayBranches,
    ...destinationIndices(primary: false, adaptiveVisible: true).where(
      (index) => appDestinations[index].group != AppDestinationGroup.advanced,
    ),
  ];

  void _select(int index) => navigationShell.goBranch(
    index,
    initialLocation: index == navigationShell.currentIndex,
  );

  @override
  Widget build(BuildContext context) {
    if (usesMacosPresentation()) {
      return MacosWorkspaceShell(
        navigationShell: navigationShell,
        onSelect: _select,
      );
    }
    final width = MediaQuery.sizeOf(context).width;
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyK, control: true): () =>
            _select(destinationIndex('/search')),
        const SingleActivator(LogicalKeyboardKey.keyK, meta: true): () =>
            _select(destinationIndex('/search')),
      },
      child: FocusScope(
        autofocus: true,
        child: width < 840 ? _phone(context) : _wide(context, width),
      ),
    );
  }

  Widget _phone(BuildContext context) {
    final active = appDestinations[navigationShell.currentIndex];
    final colors = Theme.of(context).colorScheme;
    return Scaffold(
      drawerEdgeDragWidth: 32,
      drawer: _WorkspaceDrawer(
        currentIndex: navigationDisplayIndex(navigationShell.currentIndex),
        onSelect: _select,
      ),
      appBar: AppBar(
        toolbarHeight: 68,
        leadingWidth: 62,
        leading: Builder(
          builder: (context) => Padding(
            padding: const EdgeInsets.fromLTRB(10, 10, 6, 10),
            child: IconButton.outlined(
              tooltip: 'Open workspace menu',
              onPressed: Scaffold.of(context).openDrawer,
              icon: const Icon(Icons.menu_rounded, size: 20),
            ),
          ),
        ),
        titleSpacing: 4,
        title: Row(
          children: [
            const AsaelMark(size: 34),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    active.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 14),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    active.description,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: colors.onSurfaceVariant,
                      fontSize: 13,
                      fontWeight: FontWeight.w400,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Search workspace content',
            onPressed: () => _select(destinationIndex('/search')),
            icon: const Icon(Icons.search_rounded, size: 21),
          ),
          IconButton(
            tooltip: 'Attention inbox',
            onPressed: () => _select(destinationIndex('/inbox')),
            icon: const Icon(Icons.notifications_none_rounded, size: 21),
          ),
          const SizedBox(width: 4),
        ],
        shape: Border(bottom: BorderSide(color: colors.outlineVariant)),
      ),
      body: DaybookBackdrop(child: navigationShell),
      bottomNavigationBar: Builder(
        builder: (context) => _EverydayDock(
          currentIndex: navigationDisplayIndex(navigationShell.currentIndex),
          onSelect: _select,
        ),
      ),
    );
  }

  Widget _wide(BuildContext context, double width) {
    final extended = width >= 1120;
    return Scaffold(
      body: Row(
        children: [
          _DesktopSidebar(
            extended: extended,
            currentIndex: navigationDisplayIndex(navigationShell.currentIndex),
            onSelect: _select,
          ),
          Expanded(child: DaybookBackdrop(child: navigationShell)),
        ],
      ),
    );
  }
}

class _DesktopSidebar extends StatelessWidget {
  const _DesktopSidebar({
    required this.extended,
    required this.currentIndex,
    required this.onSelect,
  });

  final bool extended;
  final int currentIndex;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return AnimatedContainer(
      duration: MediaQuery.disableAnimationsOf(context)
          ? Duration.zero
          : const Duration(milliseconds: 180),
      curve: Curves.easeOutCubic,
      width: extended ? 244 : 76,
      decoration: BoxDecoration(
        color: scheme.surface,
        border: Border(right: BorderSide(color: scheme.outlineVariant)),
      ),
      child: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: EdgeInsets.fromLTRB(extended ? 18 : 12, 14, 12, 16),
              child: _BrandMark(extended: extended),
            ),
            const Divider(height: 1),
            Expanded(
              child: extended
                  ? ListView(
                      padding: const EdgeInsets.fromLTRB(10, 14, 10, 20),
                      children: [
                        _DrawerGroup(
                          label: 'Workspaces',
                          indices: AdaptiveShell._everydayBranches,
                          currentIndex: currentIndex,
                          onSelect: onSelect,
                        ),
                        const SizedBox(height: 16),
                        _DrawerGroup(
                          label: 'More',
                          indices: AdaptiveShell._workspaceBranches,
                          currentIndex: currentIndex,
                          onSelect: onSelect,
                        ),
                        const SizedBox(height: 16),

                        _DrawerGroup(
                          label: 'Review',
                          indices: AdaptiveShell._reviewBranches,
                          currentIndex: currentIndex,
                          onSelect: onSelect,
                        ),
                        const SizedBox(height: 16),
                        _DrawerGroup(
                          label: 'System',
                          indices: AdaptiveShell._systemBranches,
                          currentIndex: currentIndex,
                          onSelect: onSelect,
                        ),
                        const SizedBox(height: 12),
                        _DrawerGroup(
                          label: 'Advanced',
                          indices: AdaptiveShell._advancedBranches,
                          currentIndex: currentIndex,
                          onSelect: onSelect,
                          collapsible: true,
                        ),
                      ],
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      itemCount: AdaptiveShell._adaptiveBranches.length + 1,
                      itemBuilder: (context, index) {
                        if (index == AdaptiveShell._adaptiveBranches.length) {
                          return _AdvancedMenu(onSelect: onSelect);
                        }
                        final branchIndex =
                            AdaptiveShell._adaptiveBranches[index];
                        final destination = appDestinations[branchIndex];
                        final selected = currentIndex == branchIndex;
                        return Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 2,
                          ),
                          child: Tooltip(
                            message: destination.label,
                            child: IconButton(
                              isSelected: selected,
                              style: IconButton.styleFrom(
                                foregroundColor: selected
                                    ? scheme.primary
                                    : scheme.onSurfaceVariant,
                                backgroundColor: selected
                                    ? scheme.primary.withValues(alpha: .12)
                                    : Colors.transparent,
                              ),
                              onPressed: () => onSelect(branchIndex),
                              icon: Icon(destination.icon),
                              selectedIcon: Icon(destination.selectedIcon),
                            ),
                          ),
                        );
                      },
                    ),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: IconButton(
                tooltip: 'Devices & security',
                onPressed: () => context.push('/devices'),
                icon: const Icon(Icons.devices_rounded),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EverydayDock extends StatelessWidget {
  const _EverydayDock({required this.currentIndex, required this.onSelect});
  final int currentIndex;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surface,
      border: Border(
        top: BorderSide(color: Theme.of(context).colorScheme.outlineVariant),
      ),
    ),
    child: SafeArea(
      top: false,
      minimum: const EdgeInsets.fromLTRB(4, 6, 4, 6),
      child: Row(
        children: [
          for (final index in AdaptiveShell._everydayBranches)
            Expanded(
              child: _DockDestination(
                label: appDestinations[index].path == '/automation'
                    ? 'Tools'
                    : appDestinations[index].label,
                icon: currentIndex == index
                    ? appDestinations[index].selectedIcon
                    : appDestinations[index].icon,
                selected: currentIndex == index,
                onTap: () => onSelect(index),
              ),
            ),
        ],
      ),
    ),
  );
}

class _DockDestination extends StatelessWidget {
  const _DockDestination({
    required this.label,
    required this.icon,
    required this.selected,
    required this.onTap,
  });
  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Semantics(
      selected: selected,
      child: TextButton(
        onPressed: onTap,
        style: TextButton.styleFrom(
          minimumSize: const Size(48, 60),
          padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 8),
          backgroundColor: selected
              ? theme.colorScheme.secondaryContainer
              : theme.colorScheme.surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
          ),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            AnimatedScale(
              scale: selected ? 1.08 : 1,
              duration: MediaQuery.disableAnimationsOf(context)
                  ? Duration.zero
                  : const Duration(milliseconds: 180),
              curve: Curves.easeOutCubic,
              child: Icon(icon, size: 20),
            ),
            const SizedBox(height: 4),
            Text(
              label,
              textAlign: TextAlign.center,
              style: theme.textTheme.labelMedium?.copyWith(
                fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _WorkspaceDrawer extends StatelessWidget {
  const _WorkspaceDrawer({required this.currentIndex, required this.onSelect});

  final int currentIndex;
  final ValueChanged<int> onSelect;

  void _select(BuildContext context, int index) {
    Navigator.pop(context);
    onSelect(index);
  }

  @override
  Widget build(BuildContext context) => Drawer(
    width: MediaQuery.sizeOf(context).width.clamp(280, 360),
    shape: const RoundedRectangleBorder(),
    child: DaybookBackdrop(
      child: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 12, 10, 14),
              child: Row(
                children: [
                  const AsaelMark(size: 42),
                  const SizedBox(width: 12),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        AsaelWordmark(),
                        SizedBox(height: 4),
                        Text(
                          'Your second brain',
                          style: TextStyle(fontSize: 13),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: 'Close workspace menu',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(10, 12, 10, 20),
                children: [
                  _DrawerGroup(
                    label: 'Workspaces',
                    indices: AdaptiveShell._everydayBranches,
                    currentIndex: currentIndex,
                    onSelect: (index) => _select(context, index),
                  ),
                  const SizedBox(height: 16),
                  _DrawerGroup(
                    label: 'More',
                    indices: AdaptiveShell._workspaceBranches,
                    currentIndex: currentIndex,
                    onSelect: (index) => _select(context, index),
                  ),
                  const SizedBox(height: 16),

                  _DrawerGroup(
                    label: 'Review',
                    indices: AdaptiveShell._reviewBranches,
                    currentIndex: currentIndex,
                    onSelect: (index) => _select(context, index),
                  ),
                  const SizedBox(height: 16),
                  _DrawerGroup(
                    label: 'System',
                    indices: AdaptiveShell._systemBranches,
                    currentIndex: currentIndex,
                    onSelect: (index) => _select(context, index),
                  ),
                  const SizedBox(height: 12),
                  _DrawerGroup(
                    label: 'Advanced',
                    indices: AdaptiveShell._advancedBranches,
                    currentIndex: currentIndex,
                    onSelect: (index) => _select(context, index),
                    collapsible: true,
                  ),
                  const SizedBox(height: 14),
                  const Divider(height: 1),
                  const SizedBox(height: 8),
                  _UtilityTile(
                    icon: Icons.devices_rounded,
                    label: 'Devices & security',
                    description: 'Sessions, biometrics, and notifications',
                    onTap: () {
                      Navigator.pop(context);
                      context.push('/devices');
                    },
                  ),
                ],
              ),
            ),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(18, 12, 18, 14),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainerLow,
                border: Border(
                  top: BorderSide(
                    color: Theme.of(context).colorScheme.outlineVariant,
                  ),
                ),
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.lock_outline_rounded,
                    size: 16,
                    color: Theme.of(context).colorScheme.primary,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Private workspace · This ${NativeClientInfo.platformLabel} device',
                      style: const TextStyle(fontSize: 13),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

class _DrawerGroup extends StatelessWidget {
  const _DrawerGroup({
    required this.label,
    required this.indices,
    required this.currentIndex,
    required this.onSelect,
    this.collapsible = false,
  });
  final String label;
  final List<int> indices;
  final int currentIndex;
  final ValueChanged<int> onSelect;
  final bool collapsible;

  @override
  Widget build(BuildContext context) {
    if (indices.isEmpty) return const SizedBox.shrink();
    final tiles = [
      for (final index in indices)
        _WorkspaceTile(
          destination: appDestinations[index],
          selected: currentIndex == index,
          onTap: () => onSelect(index),
        ),
    ];
    if (collapsible)
      return ExpansionTile(
        key: PageStorageKey('navigation-$label'),
        initiallyExpanded: indices.contains(currentIndex),
        expansionAnimationStyle: MediaQuery.disableAnimationsOf(context)
            ? AnimationStyle.noAnimation
            : null,
        tilePadding: const EdgeInsets.symmetric(horizontal: 10),
        shape: const Border(),
        collapsedShape: const Border(),
        leading: const Icon(Icons.build_outlined, size: 18),
        title: Text(
          label,
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
        ),
        children: tiles,
      );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(10, 0, 10, 6),
          child: Text(
            label,
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        ...tiles,
      ],
    );
  }
}

class _AdvancedMenu extends StatelessWidget {
  const _AdvancedMenu({required this.onSelect});
  final ValueChanged<int> onSelect;
  @override
  Widget build(BuildContext context) => PopupMenuButton<int>(
    tooltip: 'Advanced tools',
    icon: const Icon(Icons.build_outlined, size: 20),
    onSelected: onSelect,
    itemBuilder: (_) => [
      for (final index in AdaptiveShell._advancedBranches)
        PopupMenuItem(value: index, child: Text(appDestinations[index].label)),
    ],
  );
}

class _WorkspaceTile extends StatelessWidget {
  const _WorkspaceTile({
    required this.destination,
    required this.selected,
    required this.onTap,
  });

  final AppDestination destination;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 3),
      child: Material(
        color: selected
            ? scheme.primary.withValues(alpha: .12)
            : Colors.transparent,
        shape: RoundedRectangleBorder(
          side: BorderSide(
            color: selected ? scheme.outline : Colors.transparent,
          ),
          borderRadius: BorderRadius.circular(8),
        ),
        child: ListTile(
          selected: selected,
          minTileHeight: 54,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          selectedTileColor: Colors.transparent,
          selectedColor: scheme.primary,
          leading: Icon(
            selected ? destination.selectedIcon : destination.icon,
            size: 19,
          ),
          title: Text(
            destination.label,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),
          subtitle: Text(
            destination.description,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: selected
                  ? scheme.onSurfaceVariant
                  : scheme.onSurfaceVariant,
              fontSize: 13,
            ),
          ),
          trailing: selected
              ? Icon(
                  Icons.arrow_forward_rounded,
                  size: 15,
                  color: scheme.primary,
                )
              : null,
          onTap: onTap,
        ),
      ),
    );
  }
}

class _UtilityTile extends StatelessWidget {
  const _UtilityTile({
    required this.icon,
    required this.label,
    required this.description,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final String description;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => ListTile(
    minTileHeight: 54,
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
    leading: Icon(icon, size: 19),
    title: Text(
      label,
      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
    ),
    subtitle: Text(
      description,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: const TextStyle(fontSize: 13),
    ),
    trailing: const Icon(Icons.arrow_outward_rounded, size: 16),
    onTap: onTap,
  );
}

class _BrandMark extends StatelessWidget {
  const _BrandMark({required this.extended});

  final bool extended;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      const AsaelMark(size: 40),
      if (extended) ...[
        const SizedBox(width: 12),
        const Flexible(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AsaelWordmark(compact: true),
              SizedBox(height: 4),
              Text('Your second brain', style: TextStyle(fontSize: 13)),
            ],
          ),
        ),
      ],
    ],
  );
}
