import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import '../auth/application/session_controller.dart';
import 'admin_controller.dart';
import 'admin_models.dart';
import 'admin_providers.dart';
import 'admin_registry.dart';

/// A pointer-first control-plane workspace used only by the installed macOS
/// application. Web and mobile keep their existing presentation.
class MacosAdminWorkspaceView extends ConsumerStatefulWidget {
  const MacosAdminWorkspaceView({super.key, required this.moduleId});

  final String moduleId;

  @override
  ConsumerState<MacosAdminWorkspaceView> createState() =>
      _MacosAdminWorkspaceViewState();
}

enum _AreaFilter { all, attention, available }

class _MacosAdminWorkspaceViewState
    extends ConsumerState<MacosAdminWorkspaceView> {
  String _query = '';
  String? _selectedPath;
  _AreaFilter _filter = _AreaFilter.all;

  @override
  void didUpdateWidget(covariant MacosAdminWorkspaceView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.moduleId != widget.moduleId) {
      _query = '';
      _filter = _AreaFilter.all;
      _selectedPath = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionControllerProvider).value;
    if (session == null || !session.canManage) {
      return const _MacosAccessDenied();
    }

    final module = adminModules.firstWhere(
      (item) => item.id == widget.moduleId,
    );
    final controller = ref.watch(adminControllerProvider(module.id));
    final snapshot = controller.snapshot;
    final visible = module.endpoints
        .where((endpoint) {
          final matchesQuery =
              _query.isEmpty ||
              endpoint.label.toLowerCase().contains(_query.toLowerCase()) ||
              endpoint.description.toLowerCase().contains(
                _query.toLowerCase(),
              ) ||
              endpoint.path.toLowerCase().contains(_query.toLowerCase());
          if (!matchesQuery) return false;
          final failed = snapshot?.failures.containsKey(endpoint.path) ?? false;
          final available =
              snapshot?.values.containsKey(endpoint.path) ?? false;
          return switch (_filter) {
            _AreaFilter.all => true,
            _AreaFilter.attention => failed || !available,
            _AreaFilter.available => available && !failed,
          };
        })
        .toList(growable: false);

    final selected = _selectedEndpoint(module, visible);
    final availableCount = snapshot?.values.length ?? 0;
    final failureCount = snapshot?.failures.length ?? 0;

    return MacosPageScaffold(
      title: module.label,
      description: module.description,
      icon: module.icon,
      actions: [
        IconButton(
          key: const ValueKey('macos-admin-refresh'),
          tooltip: controller.loading ? 'Refreshing status' : 'Refresh status',
          onPressed: controller.loading ? null : controller.refresh,
          icon: controller.loading
              ? const SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.refresh_rounded),
        ),
      ],
      toolbar: Row(
        children: [
          SizedBox(
            width: 280,
            child: TextField(
              key: const ValueKey('macos-admin-search'),
              onChanged: (value) => setState(() => _query = value.trim()),
              decoration: const InputDecoration(
                hintText: 'Search system areas',
                prefixIcon: Icon(Icons.search_rounded, size: 17),
              ),
            ),
          ),
          const SizedBox(width: 14),
          SegmentedButton<_AreaFilter>(
            segments: const [
              ButtonSegment(value: _AreaFilter.all, label: Text('All')),
              ButtonSegment(
                value: _AreaFilter.attention,
                label: Text('Needs attention'),
              ),
              ButtonSegment(
                value: _AreaFilter.available,
                label: Text('Available'),
              ),
            ],
            selected: {_filter},
            showSelectedIcon: false,
            onSelectionChanged: (value) => setState(() {
              _filter = value.first;
              _selectedPath = null;
            }),
          ),
          const Spacer(),
          Text(
            '${visible.length} of ${module.endpoints.length} areas',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
      inspectorWidth: 340,
      inspector: _OperationsInspector(
        module: module,
        controller: controller,
        availableCount: availableCount,
        failureCount: failureCount,
      ),
      body: Column(
        children: [
          _HealthStrip(
            controller: controller,
            available: availableCount,
            failed: failureCount,
            total: module.endpoints.length,
          ),
          if (controller.notice != null)
            _InlineNotice(message: controller.notice!),
          if (controller.error != null)
            _InlineError(error: controller.error!, retry: controller.refresh),
          Expanded(
            child: controller.loading && snapshot == null
                ? const MacosLoadingList(rows: 8)
                : visible.isEmpty
                ? MacosEmptyState(
                    icon: Icons.filter_alt_off_outlined,
                    title: 'No matching system areas',
                    message: 'Change the search or status filter to see more.',
                    action: TextButton(
                      onPressed: () => setState(() {
                        _query = '';
                        _filter = _AreaFilter.all;
                      }),
                      child: const Text('Clear filters'),
                    ),
                  )
                : Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SizedBox(
                        width: 330,
                        child: _AreaList(
                          endpoints: visible,
                          snapshot: snapshot,
                          selectedPath: selected?.path,
                          onSelected: (endpoint) =>
                              setState(() => _selectedPath = endpoint.path),
                        ),
                      ),
                      VerticalDivider(
                        width: 1,
                        color: MacosThemeColors.of(context).divider,
                      ),
                      Expanded(
                        child: selected == null
                            ? const MacosEmptyState(
                                icon: Icons.view_list_outlined,
                                title: 'Select a system area',
                                message: 'Status, evidence, and endpoint information will appear here.',
                              )
                            : _AreaEvidence(
                                endpoint: selected,
                                value: snapshot?.values[selected.path],
                                error: snapshot?.failures[selected.path],
                              ),
                      ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }

  AdminEndpoint? _selectedEndpoint(
    AdminModule module,
    List<AdminEndpoint> visible,
  ) {
    if (visible.isEmpty) return null;
    final selectedPath = _selectedPath;
    if (selectedPath == null) return visible.first;
    return visible.cast<AdminEndpoint?>().firstWhere(
      (endpoint) => endpoint?.path == selectedPath,
      orElse: () => visible.first,
    );
  }
}

class _HealthStrip extends StatelessWidget {
  const _HealthStrip({
    required this.controller,
    required this.available,
    required this.failed,
    required this.total,
  });

  final AdminController controller;
  final int available;
  final int failed;
  final int total;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final updated = controller.snapshot?.updatedAt;
    final unknown = (total - available - failed).clamp(0, total);
    return Container(
      height: 56,
      padding: const EdgeInsets.symmetric(horizontal: 18),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border(bottom: BorderSide(color: mac.divider)),
      ),
      child: Row(
        children: [
          _StatusMetric(
            icon: failed > 0
                ? Icons.warning_amber_rounded
                : Icons.check_circle_outline_rounded,
            color: failed > 0
                ? Theme.of(context).colorScheme.error
                : mac.positive,
            label: failed > 0 ? '$failed need attention' : 'No failures',
          ),
          const SizedBox(width: 24),
          _StatusMetric(
            icon: Icons.cloud_done_outlined,
            color: mac.positive,
            label: '$available available',
          ),
          const SizedBox(width: 24),
          _StatusMetric(
            icon: Icons.help_outline_rounded,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            label: '$unknown not checked',
          ),
          const Spacer(),
          Text(
            updated == null
                ? 'Status has not been checked'
                : 'Checked ${TimeOfDay.fromDateTime(updated).format(context)}',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}

class _StatusMetric extends StatelessWidget {
  const _StatusMetric({
    required this.icon,
    required this.color,
    required this.label,
  });

  final IconData icon;
  final Color color;
  final String label;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Icon(icon, color: color, size: 17),
      const SizedBox(width: 7),
      Text(label, style: Theme.of(context).textTheme.labelLarge),
    ],
  );
}

class _AreaList extends StatelessWidget {
  const _AreaList({
    required this.endpoints,
    required this.snapshot,
    required this.selectedPath,
    required this.onSelected,
  });

  final List<AdminEndpoint> endpoints;
  final AdminSnapshot? snapshot;
  final String? selectedPath;
  final ValueChanged<AdminEndpoint> onSelected;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return ListView.builder(
      key: const ValueKey('macos-admin-area-list'),
      padding: const EdgeInsets.all(10),
      itemCount: endpoints.length,
      itemBuilder: (context, index) {
        final endpoint = endpoints[index];
        final failed = snapshot?.failures.containsKey(endpoint.path) ?? false;
        final available = snapshot?.values.containsKey(endpoint.path) ?? false;
        final selected = endpoint.path == selectedPath;
        final statusColor = failed
            ? Theme.of(context).colorScheme.error
            : available
            ? mac.positive
            : Theme.of(context).colorScheme.onSurfaceVariant;
        return Padding(
          padding: const EdgeInsets.only(bottom: 3),
          child: Material(
            color: selected ? mac.selection : Colors.transparent,
            borderRadius: BorderRadius.circular(7),
            child: InkWell(
              key: ValueKey('macos-admin-area-${endpoint.path}'),
              borderRadius: BorderRadius.circular(7),
              onTap: () => onSelected(endpoint),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 11,
                  vertical: 10,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 5),
                      child: Container(
                        width: 7,
                        height: 7,
                        decoration: BoxDecoration(
                          color: statusColor,
                          shape: BoxShape.circle,
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            endpoint.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                          const SizedBox(height: 3),
                          Text(
                            endpoint.description.isEmpty
                                ? endpoint.path
                                : endpoint.description,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                    if (selected)
                      Icon(
                        Icons.chevron_right_rounded,
                        size: 17,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _AreaEvidence extends StatelessWidget {
  const _AreaEvidence({required this.endpoint, this.value, this.error});

  final AdminEndpoint endpoint;
  final Map<String, dynamic>? value;
  final Object? error;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final mac = MacosThemeColors.of(context);
    final failed = error != null;
    final available = value != null && !failed;
    final statusColor = failed
        ? scheme.error
        : available
        ? mac.positive
        : scheme.onSurfaceVariant;
    final statusLabel = failed
        ? 'Needs attention'
        : available
        ? 'Available'
        : 'Not checked';
    final entries = value?.entries.toList(growable: false) ?? const [];

    return ListView(
      key: ValueKey('macos-admin-evidence-${endpoint.path}'),
      padding: const EdgeInsets.all(22),
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    endpoint.label,
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    endpoint.description.isEmpty
                        ? 'Live control-plane evidence for this system area.'
                        : endpoint.description,
                    style: Theme.of(context).textTheme.bodyMedium
                        ?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
            _StatusPill(label: statusLabel, color: statusColor),
          ],
        ),
        const SizedBox(height: 22),
        MacosSectionHeader(
          title: 'Current evidence',
          description: available
              ? '${entries.length} fields returned by the service.'
              : 'The service has not returned usable evidence yet.',
        ),
        const SizedBox(height: 10),
        if (failed)
          _EvidenceMessage(
            icon: Icons.cloud_off_rounded,
            title: 'This area could not be read',
            message: error.toString(),
            color: scheme.error,
          )
        else if (!available)
          _EvidenceMessage(
            icon: Icons.hourglass_empty_rounded,
            title: 'No status available',
            message: 'Refresh the workspace to check this area now.',
            color: scheme.onSurfaceVariant,
          )
        else
          MacosPane(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                for (var index = 0; index < entries.length; index++) ...[
                  _EvidenceRow(entry: entries[index]),
                  if (index != entries.length - 1)
                    Divider(height: 1, color: mac.divider),
                ],
              ],
            ),
          ),
        const SizedBox(height: 22),
        MacosSectionHeader(
          title: 'Source',
          description: 'The application endpoint used for this live check.',
        ),
        const SizedBox(height: 8),
        SelectableText(
          endpoint.path,
          style: Theme.of(context).textTheme.bodySmall
              ?.copyWith(fontFamily: 'monospace'),
        ),
      ],
    );
  }
}

class _EvidenceRow extends StatelessWidget {
  const _EvidenceRow({required this.entry});

  final MapEntry<String, dynamic> entry;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 180,
          child: Text(
            _humanize(entry.key),
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: SelectableText(
            _displayValue(entry.value),
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ),
      ],
    ),
  );
}

class _EvidenceMessage extends StatelessWidget {
  const _EvidenceMessage({
    required this.icon,
    required this.title,
    required this.message,
    required this.color,
  });

  final IconData icon;
  final String title;
  final String message;
  final Color color;

  @override
  Widget build(BuildContext context) => MacosPane(
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: color),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: 4),
              Text(message, style: Theme.of(context).textTheme.bodySmall),
            ],
          ),
        ),
      ],
    ),
  );
}

class _OperationsInspector extends StatelessWidget {
  const _OperationsInspector({
    required this.module,
    required this.controller,
    required this.availableCount,
    required this.failureCount,
  });

  final AdminModule module;
  final AdminController controller;
  final int availableCount;
  final int failureCount;

  @override
  Widget build(BuildContext context) => ListView(
    key: const ValueKey('macos-admin-operations-inspector'),
    padding: const EdgeInsets.all(16),
    children: [
      const MacosSectionHeader(
        title: 'Workspace status',
        description: 'Live availability and safe manual operations.',
      ),
      const SizedBox(height: 14),
      _InspectorSummary(
        label: 'Available',
        value: '$availableCount / ${module.endpoints.length}',
        icon: Icons.cloud_done_outlined,
      ),
      const SizedBox(height: 7),
      _InspectorSummary(
        label: 'Needs attention',
        value: '$failureCount',
        icon: Icons.warning_amber_rounded,
        warning: failureCount > 0,
      ),
      const SizedBox(height: 22),
      MacosSectionHeader(
        title: 'Manual operations',
        description: module.actions.isEmpty
            ? 'This workspace has no manual operations.'
            : 'Review each operation before it changes workspace state.',
      ),
      const SizedBox(height: 10),
      if (module.actions.isEmpty)
        Text(
          'Status is read-only here.',
          style: Theme.of(context).textTheme.bodySmall,
        )
      else
        for (final action in module.actions)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: _OperationButton(action: action, controller: controller),
          ),
      const SizedBox(height: 18),
      TextButton.icon(
        onPressed: controller.loading ? null : controller.refresh,
        icon: const Icon(Icons.refresh_rounded),
        label: const Text('Refresh all areas'),
      ),
    ],
  );
}

class _InspectorSummary extends StatelessWidget {
  const _InspectorSummary({
    required this.label,
    required this.value,
    required this.icon,
    this.warning = false,
  });

  final String label;
  final String value;
  final IconData icon;
  final bool warning;

  @override
  Widget build(BuildContext context) {
    final color = warning
        ? Theme.of(context).colorScheme.error
        : Theme.of(context).colorScheme.onSurfaceVariant;
    return Row(
      children: [
        Icon(icon, size: 17, color: color),
        const SizedBox(width: 8),
        Expanded(child: Text(label)),
        Text(value, style: Theme.of(context).textTheme.labelLarge),
      ],
    );
  }
}

class _OperationButton extends StatelessWidget {
  const _OperationButton({required this.action, required this.controller});

  final AdminAction action;
  final AdminController controller;

  @override
  Widget build(BuildContext context) {
    final running = controller.runningAction == action.path;
    return OutlinedButton.icon(
      onPressed: controller.runningAction == null
          ? () => _reviewOperation(context)
          : null,
      icon: running
          ? const SizedBox.square(
              dimension: 14,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.play_arrow_rounded),
      label: Align(
        alignment: Alignment.centerLeft,
        child: Text(running ? 'Running ${action.label}' : action.label),
      ),
    );
  }

  Future<void> _reviewOperation(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        icon: const Icon(Icons.play_circle_outline_rounded),
        title: Text(action.label),
        content: const Text(
          'This operation runs once now and can change workspace state. Continue?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Run operation'),
          ),
        ],
      ),
    );
    if (confirmed == true) await controller.run(action);
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.label, required this.color});

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
    decoration: BoxDecoration(
      color: color.withValues(alpha: .1),
      borderRadius: BorderRadius.circular(6),
      border: Border.all(color: color.withValues(alpha: .28)),
    ),
    child: Text(
      label,
      style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color),
    ),
  );
}

class _InlineNotice extends StatelessWidget {
  const _InlineNotice({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) => _InlineBanner(
    icon: Icons.info_outline_rounded,
    message: message,
    color: Theme.of(context).colorScheme.primary,
  );
}

class _InlineError extends StatelessWidget {
  const _InlineError({required this.error, required this.retry});

  final Object error;
  final VoidCallback retry;

  @override
  Widget build(BuildContext context) => _InlineBanner(
    icon: Icons.cloud_off_rounded,
    message: error.toString(),
    color: Theme.of(context).colorScheme.error,
    action: TextButton(onPressed: retry, child: const Text('Retry')),
  );
}

class _InlineBanner extends StatelessWidget {
  const _InlineBanner({
    required this.icon,
    required this.message,
    required this.color,
    this.action,
  });

  final IconData icon;
  final String message;
  final Color color;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minHeight: 42),
    padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
    decoration: BoxDecoration(
      color: color.withValues(alpha: .08),
      border: Border(bottom: BorderSide(color: color.withValues(alpha: .18))),
    ),
    child: Row(
      children: [
        Icon(icon, size: 17, color: color),
        const SizedBox(width: 9),
        Expanded(
          child: Text(message, maxLines: 2, overflow: TextOverflow.ellipsis),
        ),
        action ?? const SizedBox.shrink(),
      ],
    ),
  );
}

class _MacosAccessDenied extends StatelessWidget {
  const _MacosAccessDenied();

  @override
  Widget build(BuildContext context) => const MacosPageScaffold(
    title: 'Control plane',
    description: 'Workspace administration',
    icon: Icons.admin_panel_settings_outlined,
    body: MacosEmptyState(
      icon: Icons.lock_outline_rounded,
      title: 'Administrator access required',
      message: 'Your workspace role does not permit control-plane changes.',
    ),
  );
}

String _humanize(String value) {
  final spaced = value
      .replaceAllMapped(
        RegExp(r'([a-z0-9])([A-Z])'),
        (match) => '${match[1]} ${match[2]}',
      )
      .replaceAll(RegExp(r'[_\-.]+'), ' ')
      .trim();
  if (spaced.isEmpty) return value;
  return '${spaced[0].toUpperCase()}${spaced.substring(1)}';
}

String _displayValue(dynamic value) {
  if (value == null) return 'Not available';
  if (value is String || value is num || value is bool) return '$value';
  try {
    return const JsonEncoder.withIndent('  ').convert(value);
  } catch (_) {
    return value.toString();
  }
}
