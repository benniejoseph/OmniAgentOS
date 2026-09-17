import 'package:flutter/material.dart';
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
  static final _everydayBranches = destinationIndices(primary: true);
  static final _workspaceBranches = destinationIndices(
    group: AppDestinationGroup.workspace,
  );
  static final _automationBranches = destinationIndices(
    group: AppDestinationGroup.automation,
  );
  static final _reviewBranches = destinationIndices(
    group: AppDestinationGroup.review,
  );
  static final _systemBranches = destinationIndices(
    group: AppDestinationGroup.system,
  );

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
    return width < 840 ? _phone(context) : _wide(context, width);
  }

  Widget _phone(BuildContext context) {
    final active = appDestinations[navigationShell.currentIndex];
    final colors = Theme.of(context).colorScheme;
    return Scaffold(
      drawerEdgeDragWidth: 32,
      drawer: _WorkspaceDrawer(
        currentIndex: navigationShell.currentIndex,
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
                    style: const TextStyle(fontSize: 14.5),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    active.description,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: colors.onSurfaceVariant,
                      fontSize: 10.5,
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
            tooltip: 'Attention inbox',
            onPressed: () => _select(destinationIndex('/inbox')),
            icon: const Icon(Icons.notifications_none_rounded, size: 21),
          ),
          const SizedBox(width: 4),
        ],
        shape: Border(
          bottom: BorderSide(
            color: colors.outlineVariant.withValues(alpha: .7),
          ),
        ),
      ),
      body: DaybookBackdrop(child: navigationShell),
      bottomNavigationBar: _EverydayDock(
        currentIndex: navigationShell.currentIndex,
        onSelect: _select,
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
            currentIndex: navigationShell.currentIndex,
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
      duration: const Duration(milliseconds: 180),
      curve: Curves.easeOutCubic,
      width: extended ? 244 : 76,
      decoration: BoxDecoration(
        color: scheme.surface.withValues(alpha: .95),
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
                          label: 'Workspace',
                          indices: AdaptiveShell._workspaceBranches,
                          currentIndex: currentIndex,
                          onSelect: onSelect,
                        ),
                        const SizedBox(height: 16),
                        _DrawerGroup(
                          label: 'Automation',
                          indices: AdaptiveShell._automationBranches,
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
                      ],
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      itemCount: appDestinations.length,
                      itemBuilder: (context, index) {
                        final destination = appDestinations[index];
                        final selected = currentIndex == index;
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
                              onPressed: () => onSelect(index),
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
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surface.withValues(alpha: .97),
        border: Border(top: BorderSide(color: scheme.outlineVariant)),
        boxShadow: [
          BoxShadow(
            color: scheme.shadow.withValues(alpha: .16),
            blurRadius: 28,
            offset: const Offset(0, -8),
          ),
        ],
      ),
      child: SafeArea(
        top: false,
        minimum: const EdgeInsets.fromLTRB(4, 4, 4, 5),
        child: SizedBox(
          height: 58,
          child: Row(
            children: [
              for (final index in AdaptiveShell._everydayBranches)
                Expanded(
                  child: _DockDestination(
                    destination: appDestinations[index],
                    selected: currentIndex == index,
                    onTap: () => onSelect(index),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DockDestination extends StatelessWidget {
  const _DockDestination({
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
    final color = selected ? scheme.primary : scheme.onSurfaceVariant;
    return Semantics(
      selected: selected,
      button: true,
      label: destination.label,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              width: selected ? 22 : 0,
              height: 2,
              margin: const EdgeInsets.only(bottom: 5),
              decoration: BoxDecoration(
                color: color,
                borderRadius: BorderRadius.circular(99),
              ),
            ),
            Icon(
              selected ? destination.selectedIcon : destination.icon,
              color: color,
              size: 20,
            ),
            const SizedBox(height: 2),
            Text(
              destination.label,
              maxLines: 1,
              style: TextStyle(
                color: color,
                fontSize: 10.5,
                fontWeight: FontWeight.w600,
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
                          style: TextStyle(fontSize: 11),
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
                    label: 'Workspace',
                    indices: AdaptiveShell._workspaceBranches,
                    currentIndex: currentIndex,
                    onSelect: (index) => _select(context, index),
                  ),
                  const SizedBox(height: 16),
                  _DrawerGroup(
                    label: 'Automation',
                    indices: AdaptiveShell._automationBranches,
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
                color: Theme.of(context).colorScheme.surface
                    .withValues(alpha: .72),
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
                      style: const TextStyle(fontSize: 11.5),
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
  });

  final String label;
  final List<int> indices;
  final int currentIndex;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(10, 0, 10, 6),
        child: Text(
          label,
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontSize: 11,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
      for (final index in indices)
        _WorkspaceTile(
          destination: appDestinations[index],
          selected: currentIndex == index,
          onTap: () => onSelect(index),
        ),
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
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: selected
              ? scheme.primary.withValues(alpha: .12)
              : Colors.transparent,
          border: Border.all(
            color: selected
                ? scheme.primary.withValues(alpha: .42)
                : Colors.transparent,
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
            style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
          ),
          subtitle: Text(
            destination.description,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: selected
                  ? scheme.onSurface.withValues(alpha: .78)
                  : scheme.onSurfaceVariant,
              fontSize: 10.5,
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
      style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
    ),
    subtitle: Text(
      description,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: const TextStyle(fontSize: 10.5),
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
        const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AsaelWordmark(compact: true),
            SizedBox(height: 4),
            Text('Your second brain', style: TextStyle(fontSize: 11)),
          ],
        ),
      ],
    ],
  );
}
