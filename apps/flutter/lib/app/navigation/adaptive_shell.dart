import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'app_destination.dart';

class AdaptiveShell extends StatelessWidget {
  const AdaptiveShell({super.key, required this.navigationShell});
  final StatefulNavigationShell navigationShell;

  static const _phoneBranches = [0, 1, 2, 3, 6];

  void _select(int index) => navigationShell.goBranch(
    index,
    initialLocation: index == navigationShell.currentIndex,
  );

  int get _phoneIndex {
    final current = navigationShell.currentIndex;
    if (current >= 3 && current <= 5) return 3;
    final index = _phoneBranches.indexOf(current);
    return index < 0 ? 4 : index;
  }

  void _openLauncher(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (sheetContext) => _WorkspaceLauncher(
        currentIndex: navigationShell.currentIndex,
        onSelect: (index) {
          Navigator.pop(sheetContext);
          _select(index);
        },
        onAdministration: () {
          Navigator.pop(sheetContext);
          context.push('/administration');
        },
        onDevices: () {
          Navigator.pop(sheetContext);
          context.push('/devices');
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    if (width < 840) {
      final phoneDestinations = _phoneBranches
          .map((index) => appDestinations[index])
          .map(
            (item) => NavigationDestination(
              icon: Icon(item.icon),
              selectedIcon: Icon(item.selectedIcon),
              label: item.label,
            ),
          )
          .toList();
      return Scaffold(
        body: navigationShell,
        floatingActionButton: FloatingActionButton.small(
          tooltip: 'Open all workspaces',
          onPressed: () => _openLauncher(context),
          child: const Icon(Icons.apps_rounded),
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _phoneIndex,
          onDestinationSelected: (index) => _select(_phoneBranches[index]),
          destinations: phoneDestinations,
        ),
      );
    }

    final extended = width >= 1180;
    return Scaffold(
      body: Row(
        children: [
          SafeArea(
            child: NavigationRail(
              selectedIndex: navigationShell.currentIndex,
              onDestinationSelected: _select,
              extended: extended,
              leading: Padding(
                padding: const EdgeInsets.only(top: 14, bottom: 22),
                child: _BrandMark(extended: extended),
              ),
              trailing: Expanded(
                child: Align(
                  alignment: Alignment.bottomCenter,
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (extended)
                          FilledButton.tonalIcon(
                            onPressed: () => context.push('/devices'),
                            icon: const Icon(Icons.devices_rounded),
                            label: const Text('Devices & security'),
                          )
                        else
                          IconButton.filledTonal(
                            tooltip: 'Devices & security',
                            onPressed: () => context.push('/devices'),
                            icon: const Icon(Icons.devices_rounded),
                          ),
                        const SizedBox(height: 8),
                        if (extended)
                          FilledButton.tonalIcon(
                            onPressed: () => context.push('/administration'),
                            icon: const Icon(
                              Icons.admin_panel_settings_outlined,
                            ),
                            label: const Text('Control plane'),
                          )
                        else
                          IconButton.filledTonal(
                            tooltip: 'Control plane',
                            onPressed: () => context.push('/administration'),
                            icon: const Icon(
                              Icons.admin_panel_settings_outlined,
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
              destinations: appDestinations
                  .map(
                    (item) => NavigationRailDestination(
                      icon: Icon(item.icon),
                      selectedIcon: Icon(item.selectedIcon),
                      label: Text(item.label),
                    ),
                  )
                  .toList(),
            ),
          ),
          const VerticalDivider(width: 1),
          Expanded(child: navigationShell),
        ],
      ),
    );
  }
}

class _WorkspaceLauncher extends StatelessWidget {
  const _WorkspaceLauncher({
    required this.currentIndex,
    required this.onSelect,
    required this.onAdministration,
    required this.onDevices,
  });
  final int currentIndex;
  final ValueChanged<int> onSelect;
  final VoidCallback onAdministration;
  final VoidCallback onDevices;

  @override
  Widget build(BuildContext context) => ConstrainedBox(
    constraints: const BoxConstraints(maxHeight: 620),
    child: CustomScrollView(
      slivers: [
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(20, 6, 12, 12),
          sliver: SliverToBoxAdapter(
            child: Row(
              children: [
                const Expanded(
                  child: Text(
                    'All workspaces',
                    style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
                  ),
                ),
                IconButton(
                  tooltip: 'Close',
                  onPressed: () => Navigator.pop(context),
                  icon: const Icon(Icons.close_rounded),
                ),
              ],
            ),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          sliver: SliverList.builder(
            itemCount: appDestinations.length,
            itemBuilder: (context, index) {
              final destination = appDestinations[index];
              return ListTile(
                selected: currentIndex == index,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
                leading: Icon(
                  currentIndex == index
                      ? destination.selectedIcon
                      : destination.icon,
                ),
                title: Text(destination.label),
                subtitle: Text(
                  destination.description,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => onSelect(index),
              );
            },
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 24),
          sliver: SliverList.list(
            children: [
              ListTile(
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
                leading: const Icon(Icons.devices_rounded),
                title: const Text('Devices & security'),
                subtitle: const Text('Sessions, biometrics, and remote wipe'),
                trailing: const Icon(Icons.arrow_outward_rounded),
                onTap: onDevices,
              ),
              ListTile(
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
                leading: const Icon(Icons.admin_panel_settings_outlined),
                title: const Text('Control plane'),
                subtitle: const Text(
                  'Automation, tools, security, and settings',
                ),
                trailing: const Icon(Icons.arrow_outward_rounded),
                onTap: onAdministration,
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

class _BrandMark extends StatelessWidget {
  const _BrandMark({required this.extended});
  final bool extended;

  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Asael',
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.primary,
            borderRadius: BorderRadius.circular(11),
          ),
          child: Icon(
            Icons.hub_rounded,
            color: Theme.of(context).colorScheme.onPrimary,
            size: 21,
          ),
        ),
        if (extended) ...[
          const SizedBox(width: 12),
          const Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Asael',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
              ),
              Text('System online', style: TextStyle(fontSize: 11)),
            ],
          ),
        ],
      ],
    ),
  );
}
