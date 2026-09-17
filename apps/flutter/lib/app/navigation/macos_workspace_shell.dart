import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../core/platform/desktop_host_bridge.dart';
import '../brand/asael_mark.dart';
import '../theme/macos_app_theme.dart';
import '../theme/macos_workspace_backdrop.dart';
import 'app_destination.dart';

/// The installed Mac workspace. This deliberately does not share the tablet
/// navigation rail: desktop navigation remains labelled, searchable, and
/// keyboard reachable even at the primary window's minimum width.
class MacosWorkspaceShell extends StatefulWidget {
  const MacosWorkspaceShell({
    super.key,
    required this.navigationShell,
    required this.onSelect,
  });

  final StatefulNavigationShell navigationShell;
  final ValueChanged<int> onSelect;

  @override
  State<MacosWorkspaceShell> createState() => _MacosWorkspaceShellState();
}

class _MacosWorkspaceShellState extends State<MacosWorkspaceShell> {
  final _searchController = TextEditingController();
  final _searchFocus = FocusNode(debugLabel: 'Workspace search');
  final _sidebarScrollController = ScrollController();
  bool _sidebarCollapsed = false;

  static final _primaryIndices = destinationIndices(primary: true);

  @override
  void dispose() {
    _searchController.dispose();
    _searchFocus.dispose();
    _sidebarScrollController.dispose();
    super.dispose();
  }

  void _select(int index) {
    widget.onSelect(index);
    if (_searchController.text.isNotEmpty) {
      _searchController.clear();
      setState(() {});
    }
  }

  void _selectPath(String path) {
    final index = destinationIndex(path);
    if (index >= 0) _select(index);
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final active = appDestinations[widget.navigationShell.currentIndex];
    final compactWindow = media.size.width < 980;
    final collapsed = compactWindow || _sidebarCollapsed;
    final reduceMotion = media.disableAnimations;

    final shortcuts = <ShortcutActivator, VoidCallback>{
      const SingleActivator(LogicalKeyboardKey.keyK, meta: true): () =>
          _selectPath('/talk'),
      const SingleActivator(LogicalKeyboardKey.comma, meta: true): () =>
          _selectPath('/settings'),
      const SingleActivator(
        LogicalKeyboardKey.keyI,
        meta: true,
        shift: true,
      ): () =>
          _selectPath('/inbox'),
      for (var index = 0; index < _primaryIndices.length; index++)
        SingleActivator(
          <LogicalKeyboardKey>[
            LogicalKeyboardKey.digit1,
            LogicalKeyboardKey.digit2,
            LogicalKeyboardKey.digit3,
            LogicalKeyboardKey.digit4,
            LogicalKeyboardKey.digit5,
          ][index],
          meta: true,
        ): () =>
            _select(_primaryIndices[index]),
    };

    return CallbackShortcuts(
      bindings: shortcuts,
      child: Focus(
        autofocus: true,
        child: Scaffold(
          body: Row(
            children: [
              _MacosSidebar(
                collapsed: collapsed,
                compactWindow: compactWindow,
                currentIndex: widget.navigationShell.currentIndex,
                query: _searchController.text,
                searchController: _searchController,
                searchFocus: _searchFocus,
                scrollController: _sidebarScrollController,
                onQueryChanged: (_) => setState(() {}),
                onSelect: _select,
                onToggle: compactWindow
                    ? null
                    : () => setState(
                        () => _sidebarCollapsed = !_sidebarCollapsed,
                      ),
                onOpenDevices: () => context.push('/devices'),
              ),
              Expanded(
                child: Column(
                  children: [
                    _MacosGlobalToolbar(
                      active: active,
                      sidebarCollapsed: collapsed,
                      onToggleSidebar: compactWindow
                          ? null
                          : () => setState(
                              () => _sidebarCollapsed = !_sidebarCollapsed,
                            ),
                      onOpenCommand: () => _selectPath('/talk'),
                      onOpenInbox: () => _selectPath('/inbox'),
                      onOpenDevices: () => context.push('/devices'),
                    ),
                    Expanded(
                      child: MacosWorkspaceBackdrop(
                        child: _MacosWorkspaceViewport(
                          destination: active,
                          reduceMotion: reduceMotion,
                          child: widget.navigationShell,
                        ),
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
}

class _MacosSidebar extends StatelessWidget {
  const _MacosSidebar({
    required this.collapsed,
    required this.compactWindow,
    required this.currentIndex,
    required this.query,
    required this.searchController,
    required this.searchFocus,
    required this.scrollController,
    required this.onQueryChanged,
    required this.onSelect,
    required this.onToggle,
    required this.onOpenDevices,
  });

  final bool collapsed;
  final bool compactWindow;
  final int currentIndex;
  final String query;
  final TextEditingController searchController;
  final FocusNode searchFocus;
  final ScrollController scrollController;
  final ValueChanged<String> onQueryChanged;
  final ValueChanged<int> onSelect;
  final VoidCallback? onToggle;
  final VoidCallback onOpenDevices;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final scheme = Theme.of(context).colorScheme;
    final groups = <(String, AppDestinationGroup)>[
      ('Workspaces', AppDestinationGroup.workspace),
      ('Automation', AppDestinationGroup.automation),
      ('Review', AppDestinationGroup.review),
      ('System', AppDestinationGroup.system),
    ];

    return AnimatedContainer(
      duration: MediaQuery.disableAnimationsOf(context)
          ? Duration.zero
          : const Duration(milliseconds: 180),
      curve: Curves.easeOutCubic,
      width: collapsed ? 68 : 238,
      color: mac.sidebar,
      child: SafeArea(
        child: Column(
          children: [
            SizedBox(
              height: 60,
              child: Padding(
                padding: EdgeInsets.fromLTRB(collapsed ? 14 : 16, 10, 10, 8),
                child: Row(
                  children: [
                    const AsaelMark(size: 34),
                    if (!collapsed) ...[
                      const SizedBox(width: 10),
                      const Expanded(child: AsaelWordmark(compact: true)),
                      IconButton(
                        tooltip: 'Hide sidebar',
                        onPressed: onToggle,
                        icon: const Icon(
                          Icons.keyboard_double_arrow_left_rounded,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            Divider(height: 1, color: mac.divider),
            if (!collapsed)
              Padding(
                padding: const EdgeInsets.fromLTRB(10, 10, 10, 6),
                child: SizedBox(
                  height: 34,
                  child: TextField(
                    controller: searchController,
                    focusNode: searchFocus,
                    onChanged: onQueryChanged,
                    textInputAction: TextInputAction.search,
                    decoration: const InputDecoration(
                      hintText: 'Find a workspace',
                      prefixIcon: Icon(Icons.search_rounded, size: 17),
                      isDense: true,
                    ),
                  ),
                ),
              ),
            Expanded(
              child: Scrollbar(
                controller: scrollController,
                thumbVisibility: !collapsed,
                child: ListView(
                  controller: scrollController,
                  padding: EdgeInsets.fromLTRB(
                    collapsed ? 8 : 10,
                    collapsed ? 10 : 6,
                    collapsed ? 8 : 10,
                    16,
                  ),
                  children: [
                    for (final group in groups)
                      _MacosDestinationGroup(
                        label: group.$1,
                        group: group.$2,
                        collapsed: collapsed,
                        currentIndex: currentIndex,
                        query: query,
                        onSelect: onSelect,
                      ),
                  ],
                ),
              ),
            ),
            Divider(height: 1, color: mac.divider),
            Padding(
              padding: EdgeInsets.fromLTRB(
                collapsed ? 8 : 12,
                8,
                collapsed ? 8 : 10,
                10,
              ),
              child: collapsed
                  ? IconButton(
                      tooltip: 'Devices and security',
                      onPressed: onOpenDevices,
                      icon: const Icon(Icons.lock_outline_rounded),
                    )
                  : Row(
                      children: [
                        Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: mac.positive,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 9),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Private workspace',
                                style: Theme.of(context).textTheme.labelMedium,
                              ),
                              Text(
                                'This Mac',
                                style: Theme.of(context).textTheme.bodySmall
                                    ?.copyWith(color: scheme.onSurfaceVariant),
                              ),
                            ],
                          ),
                        ),
                        IconButton(
                          tooltip: 'Devices and security',
                          onPressed: onOpenDevices,
                          icon: const Icon(Icons.devices_outlined, size: 18),
                        ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MacosDestinationGroup extends StatelessWidget {
  const _MacosDestinationGroup({
    required this.label,
    required this.group,
    required this.collapsed,
    required this.currentIndex,
    required this.query,
    required this.onSelect,
  });

  final String label;
  final AppDestinationGroup group;
  final bool collapsed;
  final int currentIndex;
  final String query;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    final normalized = query.trim().toLowerCase();
    final indices = destinationIndices(group: group)
        .where((index) {
          if (normalized.isEmpty) return true;
          final destination = appDestinations[index];
          return destination.label.toLowerCase().contains(normalized) ||
              destination.description.toLowerCase().contains(normalized);
        })
        .toList(growable: false);
    if (indices.isEmpty) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (!collapsed)
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 8, 5),
              child: Text(
                label,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  fontWeight: FontWeight.w600,
                ),
              ),
            )
          else if (group != AppDestinationGroup.workspace)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: Divider(height: 1),
            ),
          for (final index in indices)
            _MacosDestinationTile(
              destination: appDestinations[index],
              collapsed: collapsed,
              selected: currentIndex == index,
              shortcut: _shortcutFor(index),
              onTap: () => onSelect(index),
            ),
        ],
      ),
    );
  }

  String? _shortcutFor(int index) {
    final primary = destinationIndices(primary: true);
    final position = primary.indexOf(index);
    return position < 0 ? null : '⌘${position + 1}';
  }
}

class _MacosDestinationTile extends StatelessWidget {
  const _MacosDestinationTile({
    required this.destination,
    required this.collapsed,
    required this.selected,
    required this.shortcut,
    required this.onTap,
  });

  final AppDestination destination;
  final bool collapsed;
  final bool selected;
  final String? shortcut;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final mac = MacosThemeColors.of(context);
    final icon = Icon(
      selected ? destination.selectedIcon : destination.icon,
      size: 18,
      color: selected ? scheme.primary : scheme.onSurfaceVariant,
    );
    final content = Material(
      color: selected ? mac.selection : Colors.transparent,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        onTap: onTap,
        mouseCursor: SystemMouseCursors.click,
        borderRadius: BorderRadius.circular(8),
        hoverColor: mac.hover,
        focusColor: mac.focus.withValues(alpha: .16),
        child: SizedBox(
          height: 36,
          child: collapsed
              ? Center(child: icon)
              : Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 9),
                  child: Row(
                    children: [
                      icon,
                      const SizedBox(width: 9),
                      Expanded(
                        child: Text(
                          destination.label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: selected
                                ? FontWeight.w600
                                : FontWeight.w500,
                            color: selected
                                ? scheme.onSurface
                                : scheme.onSurfaceVariant,
                          ),
                        ),
                      ),
                      if (shortcut != null)
                        Text(
                          shortcut!,
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(
                                color: scheme.onSurfaceVariant.withValues(
                                  alpha: .72,
                                ),
                                fontWeight: FontWeight.w500,
                              ),
                        ),
                    ],
                  ),
                ),
        ),
      ),
    );

    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: collapsed
          ? Tooltip(message: destination.label, child: content)
          : Semantics(selected: selected, child: content),
    );
  }
}

class _MacosGlobalToolbar extends StatelessWidget {
  const _MacosGlobalToolbar({
    required this.active,
    required this.sidebarCollapsed,
    required this.onToggleSidebar,
    required this.onOpenCommand,
    required this.onOpenInbox,
    required this.onOpenDevices,
  });

  final AppDestination active;
  final bool sidebarCollapsed;
  final VoidCallback? onToggleSidebar;
  final VoidCallback onOpenCommand;
  final VoidCallback onOpenInbox;
  final VoidCallback onOpenDevices;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final scheme = Theme.of(context).colorScheme;
    final width = MediaQuery.sizeOf(context).width;
    final canOpenWindow =
        appDesktopHostBridge.supported &&
        DesktopHostBridge.isWorkspaceRoute(active.path);

    return Material(
      color: mac.toolbar,
      child: Container(
        height: 58,
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: mac.divider)),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 10),
        child: Row(
          children: [
            IconButton(
              tooltip: sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar',
              onPressed: onToggleSidebar,
              icon: Icon(
                sidebarCollapsed
                    ? Icons.keyboard_double_arrow_right_rounded
                    : Icons.keyboard_double_arrow_left_rounded,
              ),
            ),
            const SizedBox(width: 4),
            Container(width: 1, height: 22, color: mac.divider),
            const SizedBox(width: 12),
            Icon(active.selectedIcon, size: 18, color: scheme.primary),
            const SizedBox(width: 8),
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: width < 1160 ? 150 : 240),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    active.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.labelLarge,
                  ),
                  if (width >= 1160)
                    Text(
                      active.description,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                ],
              ),
            ),
            const Spacer(),
            Flexible(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 390),
                child: _MacosCommandButton(onPressed: onOpenCommand),
              ),
            ),
            const Spacer(),
            IconButton(
              tooltip: canOpenWindow
                  ? 'Open ${active.label} in a new window'
                  : 'This workspace cannot open in another window',
              onPressed: canOpenWindow
                  ? () => unawaited(
                      appDesktopHostBridge.openWorkspaceWindow(active.path),
                    )
                  : null,
              icon: const Icon(Icons.open_in_new_rounded),
            ),
            IconButton(
              tooltip: 'Attention inbox (⌘⇧I)',
              onPressed: onOpenInbox,
              icon: const Icon(Icons.notifications_none_rounded),
            ),
            IconButton(
              tooltip: 'Devices and security',
              onPressed: onOpenDevices,
              icon: const Icon(Icons.account_circle_outlined),
            ),
          ],
        ),
      ),
    );
  }
}

class _MacosCommandButton extends StatelessWidget {
  const _MacosCommandButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.surfaceContainerLow,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(9),
        side: BorderSide(color: mac.divider),
      ),
      child: InkWell(
        onTap: onPressed,
        mouseCursor: SystemMouseCursors.click,
        hoverColor: mac.hover,
        borderRadius: BorderRadius.circular(9),
        child: SizedBox(
          height: 34,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Row(
              children: [
                Icon(
                  Icons.auto_awesome_rounded,
                  size: 16,
                  color: scheme.primary,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Ask Asael or run a command',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: scheme.onSurfaceVariant,
                      fontSize: 12.5,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                const _MacosKeycap(label: '⌘K'),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _MacosKeycap extends StatelessWidget {
  const _MacosKeycap({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: mac.canvas,
        borderRadius: BorderRadius.circular(5),
        border: Border.all(color: mac.divider),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelSmall
            ?.copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
      ),
    );
  }
}

class _MacosWorkspaceViewport extends StatelessWidget {
  const _MacosWorkspaceViewport({
    required this.destination,
    required this.reduceMotion,
    required this.child,
  });

  final AppDestination destination;
  final bool reduceMotion;
  final Widget child;

  static const _fullBleed = {
    '/talk',
    '/knowledge',
    '/markets',
    '/workflows',
    '/integrations',
    '/tools',
    '/quality',
    '/monitoring',
    '/security',
    '/settings',
  };

  @override
  Widget build(BuildContext context) {
    final fullBleed = _fullBleed.contains(destination.path);
    return AnimatedPadding(
      duration: reduceMotion
          ? Duration.zero
          : const Duration(milliseconds: 180),
      curve: Curves.easeOutCubic,
      padding: fullBleed
          ? EdgeInsets.zero
          : const EdgeInsets.fromLTRB(12, 10, 12, 12),
      child: Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: fullBleed ? double.infinity : 1480,
          ),
          child: ClipRect(child: child),
        ),
      ),
    );
  }
}
