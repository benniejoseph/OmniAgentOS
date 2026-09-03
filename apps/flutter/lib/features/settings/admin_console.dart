import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/application/session_controller.dart';
import 'admin_controller.dart';
import 'admin_models.dart';
import 'admin_providers.dart';
import 'admin_registry.dart';

class AdminConsole extends ConsumerStatefulWidget {
  const AdminConsole({super.key});

  @override
  ConsumerState<AdminConsole> createState() => _AdminConsoleState();
}

class _AdminConsoleState extends ConsumerState<AdminConsole> {
  int selected = 0;

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionControllerProvider).value;
    if (session == null || !session.canManage) return const _AccessDenied();
    final module = adminModules[selected];
    final controller = ref.watch(adminControllerProvider(module.id));
    final width = MediaQuery.sizeOf(context).width;
    final showRail = width >= 840;

    return Scaffold(
      appBar: AppBar(
        title: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Control plane'),
            Text(
              'Workspace administration',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w400),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: controller.loading
                ? 'Refreshing status'
                : 'Refresh status',
            onPressed: controller.loading ? null : controller.refresh,
            icon: AnimatedRotation(
              turns: controller.loading ? 1 : 0,
              duration: const Duration(milliseconds: 220),
              child: const Icon(Icons.refresh_rounded),
            ),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: Row(
        children: [
          if (showRail) ...[
            NavigationRail(
              extended: width >= 1240,
              minExtendedWidth: 220,
              groupAlignment: -1,
              selectedIndex: selected,
              onDestinationSelected: (value) =>
                  setState(() => selected = value),
              leading: const Padding(
                padding: EdgeInsets.only(bottom: 12),
                child: Tooltip(
                  message: 'Administrative controls affect this workspace',
                  child: Icon(Icons.admin_panel_settings_outlined),
                ),
              ),
              destinations: [
                for (final item in adminModules)
                  NavigationRailDestination(
                    icon: Icon(item.icon),
                    selectedIcon: Icon(item.icon),
                    label: Text(item.label),
                  ),
              ],
            ),
            const VerticalDivider(width: 1),
          ],
          Expanded(
            child: Column(
              children: [
                if (!showRail)
                  _CompactNavigation(
                    selected: selected,
                    onSelected: (value) => setState(() => selected = value),
                  ),
                Expanded(
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 180),
                    switchInCurve: Curves.easeOutCubic,
                    child: _ModuleView(
                      key: ValueKey(module.id),
                      module: module,
                      controller: controller,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _CompactNavigation extends StatelessWidget {
  const _CompactNavigation({required this.selected, required this.onSelected});
  final int selected;
  final ValueChanged<int> onSelected;

  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.surfaceContainerLow,
    child: SizedBox(
      height: 58,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        itemCount: adminModules.length,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (context, index) {
          final item = adminModules[index];
          return ChoiceChip(
            selected: selected == index,
            onSelected: (_) => onSelected(index),
            avatar: Icon(item.icon, size: 18),
            label: Text(item.label),
          );
        },
      ),
    ),
  );
}

class _ModuleView extends StatelessWidget {
  const _ModuleView({
    super.key,
    required this.module,
    required this.controller,
  });
  final AdminModule module;
  final AdminController controller;

  @override
  Widget build(BuildContext context) {
    final snapshot = controller.snapshot;
    return RefreshIndicator(
      onRefresh: controller.refresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 24, 20, 44),
        children: [
          Align(
            alignment: Alignment.topLeft,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1080),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _ModuleHeader(module: module),
                  const SizedBox(height: 20),
                  _StatusBar(
                    loading: controller.loading,
                    available: snapshot?.values.length ?? 0,
                    failed: snapshot?.failures.length ?? 0,
                    total: module.endpoints.length,
                    updatedAt: snapshot?.updatedAt,
                  ),
                  if (controller.notice != null) ...[
                    const SizedBox(height: 12),
                    _MessagePanel(message: controller.notice!),
                  ],
                  if (controller.error != null) ...[
                    const SizedBox(height: 12),
                    _ErrorPanel(
                      error: controller.error!,
                      retry: controller.refresh,
                    ),
                  ],
                  const SizedBox(height: 24),
                  Row(
                    children: [
                      Text(
                        'System areas',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const Spacer(),
                      Text(
                        '${module.endpoints.length} total',
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  if (controller.loading && snapshot == null)
                    for (var i = 0; i < module.endpoints.length; i++)
                      const Padding(
                        padding: EdgeInsets.only(bottom: 8),
                        child: _EndpointSkeleton(),
                      )
                  else
                    for (final endpoint in module.endpoints)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: _EndpointPanel(
                          endpoint: endpoint,
                          value: snapshot?.values[endpoint.path],
                          error: snapshot?.failures[endpoint.path],
                        ),
                      ),
                  if (module.actions.isNotEmpty) ...[
                    const SizedBox(height: 18),
                    Text(
                      'Manual operations',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'These operations can change workspace state. Review the action before running it.',
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 10),
                    for (final action in module.actions)
                      _ActionTile(action: action, controller: controller),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ModuleHeader extends StatelessWidget {
  const _ModuleHeader({required this.module});
  final AdminModule module;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Container(
        width: 48,
        height: 48,
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.primaryContainer,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Icon(module.icon, color: Theme.of(context).colorScheme.primary),
      ),
      const SizedBox(width: 14),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              module.label,
              style: Theme.of(context).textTheme.headlineMedium,
            ),
            const SizedBox(height: 4),
            Text(
              module.description,
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                height: 1.4,
              ),
            ),
          ],
        ),
      ),
    ],
  );
}

class _StatusBar extends StatelessWidget {
  const _StatusBar({
    required this.loading,
    required this.available,
    required this.failed,
    required this.total,
    required this.updatedAt,
  });
  final bool loading;
  final int available;
  final int failed;
  final int total;
  final DateTime? updatedAt;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final hasData = updatedAt != null;
    final color = failed > 0
        ? scheme.error
        : hasData
        ? const Color(0xFF16805B)
        : scheme.onSurfaceVariant;
    final status = loading && !hasData
        ? 'Checking status'
        : failed > 0
        ? '$failed area${failed == 1 ? '' : 's'} need attention'
        : hasData
        ? 'All responses available'
        : 'Status not checked';
    return Semantics(
      liveRegion: true,
      label: '$status. $available of $total responses available.',
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerLow,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: scheme.outlineVariant),
        ),
        child: Wrap(
          spacing: 16,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (loading)
                  const SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                else
                  Icon(
                    failed > 0
                        ? Icons.error_outline_rounded
                        : hasData
                        ? Icons.check_circle_outline_rounded
                        : Icons.help_outline_rounded,
                    size: 18,
                    color: color,
                  ),
                const SizedBox(width: 8),
                Text(
                  status,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ],
            ),
            Text(
              '$available of $total responses',
              style: TextStyle(color: scheme.onSurfaceVariant),
            ),
            if (updatedAt != null)
              Text(
                'Updated ${TimeOfDay.fromDateTime(updatedAt!).format(context)}',
                style: TextStyle(color: scheme.onSurfaceVariant),
              ),
          ],
        ),
      ),
    );
  }
}

class _EndpointPanel extends StatefulWidget {
  const _EndpointPanel({required this.endpoint, this.value, this.error});
  final AdminEndpoint endpoint;
  final Map<String, dynamic>? value;
  final Object? error;

  @override
  State<_EndpointPanel> createState() => _EndpointPanelState();
}

class _EndpointPanelState extends State<_EndpointPanel> {
  bool expanded = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final failed = widget.error != null;
    final unknown = widget.value == null && !failed;
    final stateColor = failed
        ? scheme.error
        : unknown
        ? scheme.onSurfaceVariant
        : const Color(0xFF16805B);
    final stateLabel = failed
        ? 'Failed'
        : unknown
        ? 'Unknown'
        : 'Available';
    return Material(
      color: scheme.surfaceContainerLowest,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          InkWell(
            onTap: widget.value == null
                ? null
                : () => setState(() => expanded = !expanded),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(
                children: [
                  Icon(
                    failed
                        ? Icons.warning_amber_rounded
                        : unknown
                        ? Icons.help_outline_rounded
                        : Icons.check_circle_outline_rounded,
                    color: stateColor,
                    size: 22,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Wrap(
                          spacing: 8,
                          runSpacing: 4,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            Text(
                              widget.endpoint.label,
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            _StateBadge(label: stateLabel, color: stateColor),
                          ],
                        ),
                        const SizedBox(height: 3),
                        Text(
                          widget.error?.toString() ??
                              _summary(widget.value) ??
                              (widget.endpoint.description.isEmpty
                                  ? 'No response is available yet.'
                                  : widget.endpoint.description),
                          maxLines: expanded ? 4 : 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: scheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  if (widget.value != null)
                    Icon(
                      expanded
                          ? Icons.keyboard_arrow_up_rounded
                          : Icons.keyboard_arrow_down_rounded,
                    ),
                ],
              ),
            ),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOutCubic,
            child: !expanded || widget.value == null
                ? const SizedBox.shrink()
                : _EvidenceBody(
                    endpoint: widget.endpoint,
                    value: widget.value!,
                  ),
          ),
        ],
      ),
    );
  }
}

class _StateBadge extends StatelessWidget {
  const _StateBadge({required this.label, required this.color});
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
    decoration: BoxDecoration(
      color: color.withValues(alpha: .1),
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(
      label,
      style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w700),
    ),
  );
}

class _EvidenceBody extends StatelessWidget {
  const _EvidenceBody({required this.endpoint, required this.value});
  final AdminEndpoint endpoint;
  final Map<String, dynamic> value;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final entries = value.entries.take(8).toList();
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(48, 12, 14, 14),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow.withValues(alpha: .65),
        border: Border(top: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final entry in entries)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 150,
                    child: Text(
                      _humanize(entry.key),
                      style: TextStyle(color: scheme.onSurfaceVariant),
                    ),
                  ),
                  Expanded(
                    child: SelectableText(
                      _displayValue(entry.value),
                      style: const TextStyle(fontWeight: FontWeight.w500),
                    ),
                  ),
                ],
              ),
            ),
          if (value.length > entries.length)
            Text(
              '${value.length - entries.length} additional fields are hidden',
              style: TextStyle(color: scheme.onSurfaceVariant),
            ),
          const SizedBox(height: 4),
          Text(
            endpoint.path,
            style: TextStyle(
              color: scheme.onSurfaceVariant,
              fontFamily: 'monospace',
              fontSize: 11,
            ),
          ),
        ],
      ),
    );
  }
}

class _ActionTile extends StatefulWidget {
  const _ActionTile({required this.action, required this.controller});
  final AdminAction action;
  final AdminController controller;

  @override
  State<_ActionTile> createState() => _ActionTileState();
}

class _ActionTileState extends State<_ActionTile> {
  bool reviewing = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final running = widget.controller.runningAction == widget.action.path;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        children: [
          Row(
            children: [
              const Icon(Icons.play_circle_outline_rounded),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  widget.action.label,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              OutlinedButton(
                onPressed: widget.controller.runningAction == null
                    ? () => setState(() => reviewing = !reviewing)
                    : null,
                child: Text(reviewing ? 'Cancel' : 'Review action'),
              ),
            ],
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 180),
            child: !reviewing
                ? const SizedBox.shrink()
                : Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Wrap(
                      spacing: 12,
                      runSpacing: 10,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          'Runs once now. Its result will appear in the status above.',
                          style: TextStyle(color: scheme.onSurfaceVariant),
                        ),
                        FilledButton.icon(
                          onPressed: running
                              ? null
                              : () => widget.controller.run(widget.action),
                          icon: running
                              ? const SizedBox.square(
                                  dimension: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.play_arrow_rounded),
                          label: Text(
                            running ? 'Running operation' : 'Run operation',
                          ),
                        ),
                      ],
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}

class _EndpointSkeleton extends StatelessWidget {
  const _EndpointSkeleton();
  @override
  Widget build(BuildContext context) => Container(
    height: 76,
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(14),
    ),
    child: const Center(child: LinearProgressIndicator(minHeight: 2)),
  );
}

class _MessagePanel extends StatelessWidget {
  const _MessagePanel({required this.message});
  final String message;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.secondaryContainer,
      borderRadius: BorderRadius.circular(14),
    ),
    child: Row(
      children: [
        const Icon(Icons.info_outline_rounded),
        const SizedBox(width: 10),
        Expanded(child: Text(message)),
      ],
    ),
  );
}

class _ErrorPanel extends StatelessWidget {
  const _ErrorPanel({required this.error, required this.retry});
  final Object error;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.errorContainer,
      borderRadius: BorderRadius.circular(14),
    ),
    child: Row(
      children: [
        const Icon(Icons.cloud_off_rounded),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Control plane unavailable',
                style: TextStyle(fontWeight: FontWeight.w700),
              ),
              Text(error.toString()),
            ],
          ),
        ),
        TextButton(onPressed: retry, child: const Text('Retry status')),
      ],
    ),
  );
}

class _AccessDenied extends StatelessWidget {
  const _AccessDenied();
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Control plane')),
    body: Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: const Padding(
          padding: EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.lock_outline_rounded, size: 44),
              SizedBox(height: 16),
              Text(
                'Administrator access required',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
              ),
              SizedBox(height: 8),
              Text(
                'Your workspace role does not permit control-plane changes.',
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

String? _summary(Map<String, dynamic>? value) {
  if (value == null) return null;
  for (final key in const ['status', 'summary', 'message', 'state']) {
    if (value[key] != null) return value[key].toString();
  }
  for (final entry in value.entries) {
    if (entry.value is List) {
      return '${(entry.value as List).length} ${_humanize(entry.key)}';
    }
  }
  return '${value.length} signals available';
}

String _humanize(String value) => value
    .replaceAllMapped(
      RegExp(r'([a-z])([A-Z])'),
      (match) => '${match[1]} ${match[2]}',
    )
    .replaceAll('_', ' ')
    .split(' ')
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');

String _displayValue(dynamic value) {
  if (value is Map || value is List) {
    final encoded = jsonEncode(value);
    return encoded.length > 180 ? '${encoded.substring(0, 180)}…' : encoded;
  }
  return value?.toString() ?? 'Not set';
}
