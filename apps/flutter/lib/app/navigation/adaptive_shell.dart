import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../brand/asael_mark.dart';
import 'app_destination.dart';

class AdaptiveShell extends StatelessWidget {
  const AdaptiveShell({super.key, required this.navigationShell});
  final StatefulNavigationShell navigationShell;

  static const _phoneBranches = [0, 1, 2, 7];

  void _select(int index) => navigationShell.goBranch(
    index,
    initialLocation: index == navigationShell.currentIndex,
  );

  int get _phoneIndex {
    final current = navigationShell.currentIndex;
    final index = _phoneBranches.indexOf(current);
    return index < 0 ? _phoneBranches.length : index;
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
      final phoneDestinations = <NavigationDestination>[
        ..._phoneBranches
            .map((index) => appDestinations[index])
            .map(
              (item) => NavigationDestination(
                icon: Icon(item.icon),
                selectedIcon: Icon(item.selectedIcon),
                label: item.label,
              ),
            ),
        const NavigationDestination(
          icon: Icon(Icons.grid_view_outlined),
          selectedIcon: Icon(Icons.grid_view_rounded),
          label: 'More',
        ),
      ];
      return Scaffold(
        body: navigationShell,
        bottomNavigationBar: SafeArea(
          top: false,
          minimum: const EdgeInsets.fromLTRB(10, 0, 10, 8),
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surface,
              borderRadius: BorderRadius.circular(24),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(alpha: .08),
                  blurRadius: 26,
                  offset: const Offset(0, 9),
                ),
              ],
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(24),
              child: NavigationBar(
                selectedIndex: _phoneIndex,
                onDestinationSelected: (index) {
                  if (index == _phoneBranches.length) {
                    _openLauncher(context);
                  } else {
                    _select(_phoneBranches[index]);
                  }
                },
                destinations: phoneDestinations,
              ),
            ),
          ),
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
    constraints: const BoxConstraints(maxHeight: 720),
    child: CustomScrollView(
      slivers: [
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(20, 8, 12, 18),
          sliver: SliverToBoxAdapter(
            child: Row(
              children: [
                const AsaelMark(size: 38),
                const SizedBox(width: 13),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      AsaelWordmark(compact: true),
                      SizedBox(height: 4),
                      Text(
                        'Choose a workspace',
                        style: TextStyle(fontSize: 13),
                      ),
                    ],
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
                trailing: currentIndex == index
                    ? Icon(
                        Icons.circle,
                        size: 8,
                        color: Theme.of(context).colorScheme.primary,
                      )
                    : const Icon(Icons.chevron_right_rounded),
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
            Text('Private workspace', style: TextStyle(fontSize: 11)),
          ],
        ),
      ],
    ],
  );
}
