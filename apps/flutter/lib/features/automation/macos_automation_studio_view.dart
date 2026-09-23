import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import '../auth/application/session_controller.dart';
import 'automation_controller.dart';
import 'automation_models.dart';
import 'automation_providers.dart';

enum AutomationStudioSection {
  overview('overview', 'Overview'),
  automations('automations', 'Automations'),
  skills('skills', 'Skills'),
  connections('connections', 'Connections & MCP'),
  plugins('plugins', 'Plugins'),
  advanced('advanced', 'Advanced audit');

  const AutomationStudioSection(this.id, this.label);

  final String id;
  final String label;

  static AutomationStudioSection parse(String? value) => values.firstWhere(
    (section) => section.id == value,
    orElse: () => overview,
  );
}

class MacosAutomationStudioView extends ConsumerStatefulWidget {
  const MacosAutomationStudioView({super.key, this.initialSection});

  final String? initialSection;

  @override
  ConsumerState<MacosAutomationStudioView> createState() =>
      _MacosAutomationStudioViewState();
}

class _MacosAutomationStudioViewState
    extends ConsumerState<MacosAutomationStudioView> {
  late AutomationStudioSection _section = AutomationStudioSection.parse(
    widget.initialSection,
  );
  final _manifestController = TextEditingController();

  @override
  void didUpdateWidget(covariant MacosAutomationStudioView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.initialSection != widget.initialSection) {
      _section = AutomationStudioSection.parse(widget.initialSection);
    }
  }

  @override
  void dispose() {
    _manifestController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionControllerProvider).value;
    if (session == null || !session.canManage) {
      return const _AutomationAccessDenied();
    }

    final controller = ref.watch(automationControllerProvider);
    return MacosPageScaffold(
      title: 'Automation',
      description: 'Define what Asael can access, how agents work, and what should happen again.',
      icon: Icons.auto_awesome_motion_rounded,
      actions: [
        _RefreshState(controller: controller),
        IconButton(
          key: const ValueKey('automation-refresh'),
          tooltip: controller.refreshing
              ? 'Refreshing capability status'
              : 'Refresh capability status',
          onPressed: controller.refreshing ? null : controller.refresh,
          icon: controller.refreshing
              ? const SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.refresh_rounded),
        ),
      ],
      toolbar: _SectionStrip(
        selected: _section,
        onSelected: (section) => setState(() => _section = section),
      ),
      body: Column(
        children: [
          if (controller.error != null || controller.notice != null)
            _MessageBar(
              error: controller.error,
              notice: controller.notice,
              onDismiss: controller.clearMessage,
            ),
          Expanded(
            child: AnimatedSwitcher(
              duration: MediaQuery.disableAnimationsOf(context)
                  ? Duration.zero
                  : const Duration(milliseconds: 180),
              switchInCurve: Curves.easeOutCubic,
              switchOutCurve: Curves.easeInCubic,
              child: KeyedSubtree(
                key: ValueKey(_section),
                child: _sectionBody(controller),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _sectionBody(AutomationController controller) => switch (_section) {
    AutomationStudioSection.overview => _OverviewSection(
      controller: controller,
      onOpen: (section) => setState(() => _section = section),
    ),
    AutomationStudioSection.automations => _AutomationsSection(
      snapshot: controller.snapshot,
      controller: controller,
    ),
    AutomationStudioSection.skills => _SkillsSection(
      resource: controller.snapshot.skills,
    ),
    AutomationStudioSection.connections => _ConnectionsSection(
      connections: controller.snapshot.connections,
      mcp: controller.snapshot.mcp,
    ),
    AutomationStudioSection.plugins => _PluginsSection(
      controller: controller,
      manifestController: _manifestController,
      onReview: (plugin) => _reviewCatalogPlugin(controller, plugin),
      onReviewManifest: () => _reviewManifest(controller),
      onToggle: (plugin, enabled) =>
          controller.setPluginEnabled(plugin, enabled),
      onUninstall: (plugin) => _confirmUninstall(controller, plugin),
    ),
    AutomationStudioSection.advanced => _AdvancedSection(
      snapshot: controller.snapshot,
    ),
  };

  Future<void> _reviewCatalogPlugin(
    AutomationController controller,
    AutomationPlugin plugin,
  ) async {
    final preview = await controller.previewCatalogPlugin(plugin);
    if (!mounted || preview == null) return;
    await _showPluginReview(controller, preview);
  }

  Future<void> _reviewManifest(AutomationController controller) async {
    final preview = await controller.previewManifest(_manifestController.text);
    if (!mounted || preview == null) return;
    await _showPluginReview(controller, preview);
  }

  Future<void> _showPluginReview(
    AutomationController controller,
    AutomationPluginPreview preview,
  ) async {
    final install = await showDialog<bool>(
      context: context,
      builder: (context) =>
          _PluginReviewDialog(preview: preview, busy: controller.pluginBusy),
    );
    if (install != true || !mounted) {
      controller.clearPluginPreview();
      return;
    }
    final installed = await controller.installPreview();
    if (installed) _manifestController.clear();
  }

  Future<void> _confirmUninstall(
    AutomationController controller,
    AutomationPlugin plugin,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Uninstall ${plugin.name}?'),
        content: const Text(
          'Projected Skills will be deactivated. Stored history remains available for audit.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton.tonal(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Uninstall'),
          ),
        ],
      ),
    );
    if (confirmed == true) await controller.uninstallPlugin(plugin);
  }
}

class _SectionStrip extends StatefulWidget {
  const _SectionStrip({required this.selected, required this.onSelected});

  final AutomationStudioSection selected;
  final ValueChanged<AutomationStudioSection> onSelected;

  @override
  State<_SectionStrip> createState() => _SectionStripState();
}

class _SectionStripState extends State<_SectionStrip> {
  late final _focusNodes = [
    for (final section in AutomationStudioSection.values)
      FocusNode(debugLabel: 'Automation ${section.label}'),
  ];

  @override
  void dispose() {
    for (final node in _focusNodes) {
      node.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    scrollDirection: Axis.horizontal,
    child: Row(
      key: const ValueKey('automation-sections'),
      children: [
        for (
          var index = 0;
          index < AutomationStudioSection.values.length;
          index++
        )
          _SectionButton(
            section: AutomationStudioSection.values[index],
            selected: widget.selected == AutomationStudioSection.values[index],
            focusNode: _focusNodes[index],
            onPressed: () =>
                widget.onSelected(AutomationStudioSection.values[index]),
            onMove: (delta) {
              final next = (index + delta) % _focusNodes.length;
              final normalized = next < 0 ? next + _focusNodes.length : next;
              widget.onSelected(AutomationStudioSection.values[normalized]);
              _focusNodes[normalized].requestFocus();
            },
          ),
      ],
    ),
  );
}

class _SectionButton extends StatelessWidget {
  const _SectionButton({
    required this.section,
    required this.selected,
    required this.focusNode,
    required this.onPressed,
    required this.onMove,
  });

  final AutomationStudioSection section;
  final bool selected;
  final FocusNode focusNode;
  final VoidCallback onPressed;
  final ValueChanged<int> onMove;

  @override
  Widget build(BuildContext context) => Focus(
    focusNode: focusNode,
    onKeyEvent: (_, event) {
      if (event is! KeyDownEvent) return KeyEventResult.ignored;
      if (event.logicalKey == LogicalKeyboardKey.arrowRight) {
        onMove(1);
        return KeyEventResult.handled;
      }
      if (event.logicalKey == LogicalKeyboardKey.arrowLeft) {
        onMove(-1);
        return KeyEventResult.handled;
      }
      return KeyEventResult.ignored;
    },
    child: Semantics(
      button: true,
      selected: selected,
      label: section.label,
      child: TextButton(
        key: ValueKey('automation-section-${section.id}'),
        onPressed: onPressed,
        style: TextButton.styleFrom(
          minimumSize: const Size(0, 38),
          padding: const EdgeInsets.symmetric(horizontal: 14),
          foregroundColor: selected
              ? Theme.of(context).colorScheme.primary
              : Theme.of(context).colorScheme.onSurfaceVariant,
          shape: const RoundedRectangleBorder(),
          side: BorderSide.none,
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(section.label),
            const SizedBox(height: 5),
            AnimatedContainer(
              duration: MediaQuery.disableAnimationsOf(context)
                  ? Duration.zero
                  : const Duration(milliseconds: 160),
              width: selected ? 34 : 0,
              height: 2,
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.primary,
                borderRadius: BorderRadius.circular(99),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

class _OverviewSection extends StatelessWidget {
  const _OverviewSection({required this.controller, required this.onOpen});

  final AutomationController controller;
  final ValueChanged<AutomationStudioSection> onOpen;

  @override
  Widget build(BuildContext context) {
    final summary = _capabilitySummary(controller.snapshot);
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 1080;
        final chain = _WorkspaceSection(
          number: '01',
          title: 'How a capability becomes useful',
          description: 'Access, action, guidance, and repetition stay separate so authority remains visible.',
          child: Column(
            children: [
              for (var index = 0; index < summary.length; index++) ...[
                _CapabilityRow(item: summary[index], onOpen: onOpen),
                if (index != summary.length - 1) const Divider(height: 1),
              ],
            ],
          ),
        );
        final detail = Column(
          children: [
            const _WorkspaceSection(
              number: '02',
              title: 'What each part means',
              child: _CapabilityDefinitions(),
            ),
            const SizedBox(height: 16),
            _WorkspaceSection(
              number: '03',
              title: 'Live inventory',
              description: 'Each source reports independently; unavailable is never shown as zero.',
              child: _ResourceHealth(snapshot: controller.snapshot),
            ),
          ],
        );
        return ListView(
          key: const ValueKey('automation-overview'),
          padding: const EdgeInsets.all(20),
          children: [
            if (wide)
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(flex: 6, child: chain),
                  const SizedBox(width: 18),
                  Expanded(flex: 5, child: detail),
                ],
              )
            else ...[
              chain,
              const SizedBox(height: 16),
              detail,
            ],
          ],
        );
      },
    );
  }
}

class _AutomationsSection extends StatelessWidget {
  const _AutomationsSection({required this.snapshot, required this.controller});

  final AutomationSnapshot snapshot;
  final AutomationController controller;

  @override
  Widget build(BuildContext context) => _SplitInventory(
    key: const ValueKey('automation-automations'),
    left: _WorkspaceSection(
      number: '01',
      title: 'Triggers',
      description: 'Schedules and external events that begin repeatable work.',
      child: _ResourceBody<List<AutomationTrigger>>(
        resource: snapshot.triggers,
        emptyMessage: 'No automation triggers are configured.',
        builder: (items) => _InventoryList(
          children: [
            for (final trigger in items)
              _InventoryRow(
                icon: Icons.bolt_outlined,
                title: trigger.name,
                detail:
                    '${_plain(trigger.source)} · ${_plain(trigger.workflowMode)}',
                status: trigger.status,
                action: TextButton.icon(
                  key: ValueKey('automation-schedule-history-${trigger.id}'),
                  onPressed: () => _showSchedule(context, trigger),
                  icon: const Icon(Icons.history_rounded, size: 16),
                  label: const Text('History & leases'),
                ),
              ),
          ],
        ),
      ),
    ),
    right: _WorkspaceSection(
      number: '02',
      title: 'Recent workflow runs',
      description:
          'Live and recent executions started by people, agents, or triggers.',
      child: _ResourceBody<List<AutomationWorkflowRun>>(
        resource: snapshot.workflows,
        emptyMessage: 'No workflow runs are available yet.',
        builder: (items) => _InventoryList(
          children: [
            for (final run in items)
              _InventoryRow(
                icon: Icons.account_tree_outlined,
                title: run.title,
                detail: '${_plain(run.mode)}${_timeSuffix(run.updatedAt)}',
                status: run.status,
              ),
          ],
        ),
      ),
    ),
  );

  Future<void> _showSchedule(BuildContext context, AutomationTrigger trigger) =>
      showDialog<void>(
        context: context,
        builder: (context) =>
            _ScheduleHistoryDialog(controller: controller, trigger: trigger),
      );
}

class _ScheduleHistoryDialog extends StatefulWidget {
  const _ScheduleHistoryDialog({
    required this.controller,
    required this.trigger,
  });

  final AutomationController controller;
  final AutomationTrigger trigger;

  @override
  State<_ScheduleHistoryDialog> createState() => _ScheduleHistoryDialogState();
}

class _ScheduleHistoryDialogState extends State<_ScheduleHistoryDialog> {
  @override
  void initState() {
    super.initState();
    Future<void>.microtask(
      () => widget.controller.loadSchedule(widget.trigger.id),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final detail = widget.controller.scheduleDetails[widget.trigger.id];
      final loading = widget.controller.loadingScheduleIds.contains(
        widget.trigger.id,
      );
      final error = widget.controller.scheduleErrors[widget.trigger.id];
      return AlertDialog(
        title: Row(
          children: [
            const Icon(Icons.schedule_outlined, size: 20),
            const SizedBox(width: 9),
            Expanded(child: Text(widget.trigger.name)),
            if (loading)
              const SizedBox.square(
                dimension: 15,
                child: CircularProgressIndicator(strokeWidth: 1.8),
              ),
          ],
        ),
        content: SizedBox(
          width: 820,
          height: 620,
          child: detail == null
              ? _ScheduleUnavailable(
                  error: error,
                  onRetry: () => widget.controller.loadSchedule(
                    widget.trigger.id,
                    refresh: true,
                  ),
                )
              : _ScheduleHistoryContent(detail: detail, staleError: error),
        ),
        actions: [
          TextButton.icon(
            onPressed: loading
                ? null
                : () => widget.controller.loadSchedule(
                    widget.trigger.id,
                    refresh: true,
                  ),
            icon: const Icon(Icons.refresh_rounded, size: 16),
            label: const Text('Refresh'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Done'),
          ),
        ],
      );
    },
  );
}

class _ScheduleHistoryContent extends StatelessWidget {
  const _ScheduleHistoryContent({required this.detail, this.staleError});

  final AutomationScheduleDetail detail;
  final Object? staleError;

  @override
  Widget build(BuildContext context) => DefaultTabController(
    length: 3,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (staleError != null)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(9),
            color: Theme.of(context).colorScheme.errorContainer,
            child: Text('Showing the last verified history. $staleError'),
          ),
        Wrap(
          spacing: 9,
          runSpacing: 7,
          children: [
            _ScheduleFact(
              label: 'Status',
              value: _plain(detail.trigger.status),
            ),
            _ScheduleFact(
              label: 'Occurrences',
              value: '${detail.occurrences.length}',
            ),
            _ScheduleFact(
              label: 'Policy leases',
              value: detail.policyLeasesAvailable
                  ? '${detail.policyLeases.length}'
                  : 'Unavailable',
            ),
          ],
        ),
        const SizedBox(height: 7),
        const Text(
          'Exact content-free evidence. Missing IDs, digests, or lifecycle coordinates are never inferred.',
        ),
        const SizedBox(height: 10),
        const TabBar(
          isScrollable: true,
          tabs: [
            Tab(text: 'Occurrences'),
            Tab(text: 'Receipts'),
            Tab(text: 'PolicyLease'),
          ],
        ),
        Expanded(
          child: TabBarView(
            children: [
              _ScheduleOccurrences(items: detail.occurrences),
              _ScheduleReceipts(items: detail.receipts),
              _PolicyLeaseHistory(detail: detail),
            ],
          ),
        ),
      ],
    ),
  );
}

class _ScheduleOccurrences extends StatelessWidget {
  const _ScheduleOccurrences({required this.items});
  final List<AutomationScheduleOccurrence> items;
  @override
  Widget build(BuildContext context) => items.isEmpty
      ? const _ScheduleEmpty(message: 'No schedule occurrences recorded.')
      : ListView.separated(
          padding: const EdgeInsets.symmetric(vertical: 10),
          itemCount: items.length,
          separatorBuilder: (_, _) => const Divider(height: 1),
          itemBuilder: (context, index) {
            final item = items[index];
            return ListTile(
              contentPadding: const EdgeInsets.symmetric(horizontal: 4),
              leading: Icon(
                item.status == 'completed'
                    ? Icons.check_circle_outline
                    : item.status == 'failed'
                    ? Icons.error_outline
                    : Icons.schedule_outlined,
              ),
              title: SelectableText(item.id),
              subtitle: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${_plain(item.kind)} · ${_scheduleTime(item.scheduledFor)}${item.failureCode == null ? '' : ' · ${_plain(item.failureCode!)}'}',
                  ),
                  if (item.workflowRunId != null)
                    SelectableText('Workflow run ${item.workflowRunId}'),
                  SelectableText(
                    'Authority ${item.authoritySha256}',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ],
              ),
              trailing: _StatusPill(label: item.status),
            );
          },
        );
}

class _ScheduleReceipts extends StatelessWidget {
  const _ScheduleReceipts({required this.items});
  final List<AutomationScheduleReceipt> items;
  @override
  Widget build(BuildContext context) => items.isEmpty
      ? const _ScheduleEmpty(message: 'No occurrence receipts recorded.')
      : ListView.separated(
          padding: const EdgeInsets.symmetric(vertical: 10),
          itemCount: items.length,
          separatorBuilder: (_, _) => const Divider(height: 1),
          itemBuilder: (context, index) {
            final item = items[index];
            return ListTile(
              contentPadding: const EdgeInsets.symmetric(horizontal: 4),
              title: SelectableText(item.id),
              subtitle: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${item.occurrenceId} · ${_scheduleTime(item.recordedAt)}',
                  ),
                  SelectableText(
                    'Receipt ${item.receiptSha256}\nState ${item.stateSha256}',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ],
              ),
              trailing: _StatusPill(label: item.status),
            );
          },
        );
}

class _PolicyLeaseHistory extends StatelessWidget {
  const _PolicyLeaseHistory({required this.detail});
  final AutomationScheduleDetail detail;
  @override
  Widget build(BuildContext context) {
    if (!detail.policyLeasesAvailable) {
      return const _ScheduleEmpty(
        message: 'PolicyLease history is unavailable. No authority state was inferred.',
      );
    }
    if (detail.policyLeases.isEmpty) {
      return const _ScheduleEmpty(
        message: 'No scheduled mutation PolicyLeases have been issued.',
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.symmetric(vertical: 10),
      itemCount: detail.policyLeases.length,
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final item = detail.policyLeases[index];
        return Container(
          padding: const EdgeInsets.all(11),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainerLow,
            borderRadius: BorderRadius.circular(9),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: SelectableText(
                      item.toolId,
                      style: Theme.of(context).textTheme.labelLarge,
                    ),
                  ),
                  _StatusPill(label: item.status),
                ],
              ),
              const SizedBox(height: 5),
              SelectableText(item.leaseId),
              Text(
                'Occurrence ${item.occurrenceId} · execution ${item.executionId} · binding ${item.bindingIndex} · issued ${_scheduleTime(item.issuedAt)}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 5),
              SelectableText(
                'Lease ${item.leaseSha256}\nBinding ${item.bindingSha256}\nTool contract ${item.toolContractSha256}\nPolicy ${item.policySha256}\nInfluence ${item.influenceManifestSha256}\nConsumption receipt ${item.consumptionReceiptSha256 ?? 'Not consumed'}',
                style: Theme.of(context).textTheme.labelSmall,
              ),
              const SizedBox(height: 5),
              const Text(
                'Content-free history · this receipt does not grant authority.',
              ),
            ],
          ),
        );
      },
    );
  }
}

class _ScheduleFact extends StatelessWidget {
  const _ScheduleFact({required this.label, required this.value});
  final String label, value;
  @override
  Widget build(BuildContext context) => Chip(label: Text('$label · $value'));
}

class _ScheduleEmpty extends StatelessWidget {
  const _ScheduleEmpty({required this.message});
  final String message;
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Text(message, textAlign: TextAlign.center),
    ),
  );
}

class _ScheduleUnavailable extends StatelessWidget {
  const _ScheduleUnavailable({this.error, required this.onRetry});
  final Object? error;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Icon(Icons.cloud_off_outlined, size: 34),
        const SizedBox(height: 10),
        Text(
          error == null
              ? 'Schedule history is unavailable.'
              : 'Schedule history could not be loaded: $error',
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 12),
        TextButton.icon(
          onPressed: onRetry,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('Retry'),
        ),
      ],
    ),
  );
}

String _scheduleTime(DateTime? value) =>
    value == null ? 'unknown time' : value.toLocal().toString();

class _SkillsSection extends StatelessWidget {
  const _SkillsSection({required this.resource});

  final AutomationResource<List<AutomationSkill>> resource;

  @override
  Widget build(BuildContext context) => ListView(
    key: const ValueKey('automation-skills'),
    padding: const EdgeInsets.all(20),
    children: [
      _WorkspaceSection(
        number: '01',
        title: 'Skill catalog',
        description: 'Reusable playbooks teach agents a method. A Skill never grants access on its own.',
        child: _ResourceBody<List<AutomationSkill>>(
          resource: resource,
          emptyMessage: 'No Skills are available for this workspace.',
          builder: (items) => _InventoryList(
            children: [
              for (final skill in items)
                _InventoryRow(
                  icon: Icons.menu_book_outlined,
                  title: skill.name,
                  detail: skill.description.isEmpty
                      ? '${_plain(skill.category)} · ${skill.builtIn ? 'built in' : 'personal'}'
                      : skill.description,
                  meta:
                      '${skill.toolIds.length} tools · ${skill.knowledgeTags.length} knowledge tags',
                  status: skill.status,
                ),
            ],
          ),
        ),
      ),
    ],
  );
}

class _ConnectionsSection extends StatelessWidget {
  const _ConnectionsSection({required this.connections, required this.mcp});

  final AutomationResource<AutomationConnectionInventory> connections;
  final AutomationResource<List<AutomationMcpServer>> mcp;

  @override
  Widget build(BuildContext context) => _SplitInventory(
    key: const ValueKey('automation-connections'),
    footer: const _McpDirectionNote(),
    left: _WorkspaceSection(
      number: '01',
      title: 'Account and API connections',
      description: 'Connections authorize access; they do not decide what an agent should do.',
      child: _ResourceBody<AutomationConnectionInventory>(
        resource: connections,
        emptyMessage: 'No account or API connections are installed.',
        builder: (inventory) {
          final accounts = inventory.installed
              .where((connection) => connection.kind.toLowerCase() != 'mcp')
              .toList(growable: false);
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (inventory.state.toLowerCase() == 'partial')
                const _PartialInventory(
                  'Some connection sources are unavailable. The visible accounts are verified, but missing accounts are unknown rather than zero.',
                ),
              if (accounts.isEmpty)
                _EmptyInventory(
                  inventory.state.toLowerCase() == 'partial'
                      ? 'No account or API connection is currently verifiable.'
                      : 'No account or API connections are installed.',
                )
              else
                _InventoryList(
                  children: [
                    for (final connection in accounts)
                      _InventoryRow(
                        icon: Icons.cable_outlined,
                        title: connection.name,
                        detail:
                            '${_plain(connection.adapter)} · ${_plain(connection.permissionMode)} · sync ${_plain(connection.syncStatus)}',
                        meta: connection.nextAction,
                        status: connection.state,
                      ),
                  ],
                ),
            ],
          );
        },
      ),
    ),
    right: _WorkspaceSection(
      number: '02',
      title: 'MCP servers',
      description:
          'MCP exposes live tools and resources through a standard protocol.',
      child: _ResourceBody<List<AutomationMcpServer>>(
        resource: mcp,
        emptyMessage: 'No MCP servers have been added.',
        builder: (items) => _InventoryList(
          children: [
            for (final server in items)
              _InventoryRow(
                icon: Icons.hub_outlined,
                title: server.name,
                detail:
                    '${server.toolCount} tools · ${_plain(server.authType)} · risk ${server.defaultRiskLevel}',
                meta: server.approvalRequired
                    ? 'Consequential actions remain approval gated'
                    : 'Uses the reviewed lower-risk contract',
                status: server.status,
              ),
          ],
        ),
      ),
    ),
  );
}

class _PluginsSection extends StatelessWidget {
  const _PluginsSection({
    required this.controller,
    required this.manifestController,
    required this.onReview,
    required this.onReviewManifest,
    required this.onToggle,
    required this.onUninstall,
  });

  final AutomationController controller;
  final TextEditingController manifestController;
  final ValueChanged<AutomationPlugin> onReview;
  final VoidCallback onReviewManifest;
  final void Function(AutomationPlugin plugin, bool enabled) onToggle;
  final ValueChanged<AutomationPlugin> onUninstall;

  @override
  Widget build(BuildContext context) {
    final resource = controller.snapshot.plugins;
    return ListView(
      key: const ValueKey('automation-plugins'),
      padding: const EdgeInsets.all(20),
      children: [
        const _PluginBoundary(),
        const SizedBox(height: 16),
        _ResourceBody<AutomationPluginCatalog>(
          resource: resource,
          isEmpty: (catalog) => catalog.plugins.isEmpty,
          emptyMessage: 'No Plugins are available.',
          builder: (catalog) {
            final installed = catalog.plugins
                .where(
                  (plugin) =>
                      plugin.installed && plugin.status != 'uninstalled',
                )
                .toList(growable: false);
            final available = catalog.plugins
                .where((plugin) => !plugin.installed)
                .toList(growable: false);
            return _ResponsiveColumns(
              left: _WorkspaceSection(
                number: '01',
                title: 'Installed',
                description: 'Bundles retained for this private workspace.',
                child: installed.isEmpty
                    ? const _EmptyInventory('No Plugins are installed.')
                    : _InventoryList(
                        children: [
                          for (final plugin in installed)
                            _PluginRow(
                              plugin: plugin,
                              busy: controller.pluginBusy,
                              canMutate: controller.canMutatePlugins,
                              onToggle: onToggle,
                              onUninstall: onUninstall,
                            ),
                        ],
                      ),
              ),
              right: _WorkspaceSection(
                number: '02',
                title: 'Available',
                description: 'Review exact effects before adding a bundle.',
                child: available.isEmpty
                    ? const _EmptyInventory(
                        'No additional Plugins are available.',
                      )
                    : _InventoryList(
                        children: [
                          for (final plugin in available)
                            _InventoryRow(
                              icon: Icons.extension_outlined,
                              title: plugin.name,
                              detail: plugin.description,
                              meta: _pluginContents(plugin),
                              status: plugin.publisherName,
                              action: TextButton(
                                onPressed:
                                    controller.canMutatePlugins &&
                                        !controller.pluginBusy
                                    ? () => onReview(plugin)
                                    : null,
                                child: const Text('Review'),
                              ),
                            ),
                        ],
                      ),
              ),
            );
          },
        ),
        const SizedBox(height: 16),
        _WorkspaceSection(
          number: '03',
          title: 'Import a declarative manifest',
          description: 'Paste schema-v1 JSON. Asael validates a maximum of 128 KB and shows an immutable preview.',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                key: const ValueKey('automation-plugin-manifest'),
                controller: manifestController,
                minLines: 4,
                maxLines: 10,
                enabled: controller.canMutatePlugins && !controller.pluginBusy,
                style: Theme.of(context).textTheme.bodySmall
                    ?.copyWith(fontFamily: 'monospace'),
                decoration: const InputDecoration(
                  hintText: '{\n  "schemaVersion": 1,\n  ...\n}',
                  alignLabelWithHint: true,
                ),
              ),
              const SizedBox(height: 10),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton.tonalIcon(
                  onPressed:
                      controller.canMutatePlugins && !controller.pluginBusy
                      ? onReviewManifest
                      : null,
                  icon: const Icon(Icons.fact_check_outlined, size: 17),
                  label: const Text('Prepare review'),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _AdvancedSection extends StatelessWidget {
  const _AdvancedSection({required this.snapshot});

  final AutomationSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final tools = snapshot.tools.data ?? const <AutomationTool>[];
    return _SplitInventory(
      key: const ValueKey('automation-advanced'),
      left: _WorkspaceSection(
        number: '01',
        title: 'Source integrity',
        description: 'Every inventory is loaded and reported independently.',
        child: _ResourceHealth(snapshot: snapshot),
      ),
      right: _WorkspaceSection(
        number: '02',
        title: 'Tool risk distribution',
        description: 'Risk and approval remain attached to each atomic action.',
        child: snapshot.tools.data == null && snapshot.tools.hasError
            ? _SourceUnavailable(message: snapshot.tools.error)
            : Column(
                children: [
                  for (var level = 0; level <= 3; level++) ...[
                    _RiskRow(
                      level: level,
                      count: tools
                          .where((tool) => tool.riskLevel == level)
                          .length,
                    ),
                    if (level != 3) const Divider(height: 1),
                  ],
                ],
              ),
      ),
    );
  }
}

class _SplitInventory extends StatelessWidget {
  const _SplitInventory({
    super.key,
    required this.left,
    required this.right,
    this.footer,
  });

  final Widget left, right;
  final Widget? footer;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => ListView(
      padding: const EdgeInsets.all(20),
      children: [
        if (constraints.maxWidth >= 960)
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: left),
              const SizedBox(width: 18),
              Expanded(child: right),
            ],
          )
        else ...[
          left,
          const SizedBox(height: 16),
          right,
        ],
        if (footer != null) ...[const SizedBox(height: 16), footer!],
      ],
    ),
  );
}

class _ResponsiveColumns extends StatelessWidget {
  const _ResponsiveColumns({required this.left, required this.right});

  final Widget left, right;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => constraints.maxWidth >= 920
        ? Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: left),
              const SizedBox(width: 18),
              Expanded(child: right),
            ],
          )
        : Column(children: [left, const SizedBox(height: 16), right]),
  );
}

class _WorkspaceSection extends StatelessWidget {
  const _WorkspaceSection({
    required this.number,
    required this.title,
    required this.child,
    this.description,
  });

  final String number, title;
  final String? description;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final scheme = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surface.withValues(alpha: .78),
        border: Border.all(color: mac.divider),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 13),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  number,
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: scheme.primary,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      if (description != null) ...[
                        const SizedBox(height: 3),
                        Text(
                          description!,
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(color: scheme.onSurfaceVariant),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
          Divider(height: 1, color: mac.divider),
          child,
        ],
      ),
    );
  }
}

class _InventoryList extends StatelessWidget {
  const _InventoryList({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      for (var index = 0; index < children.length; index++) ...[
        children[index],
        if (index != children.length - 1) const Divider(height: 1),
      ],
    ],
  );
}

class _InventoryRow extends StatelessWidget {
  const _InventoryRow({
    required this.icon,
    required this.title,
    required this.detail,
    required this.status,
    this.meta,
    this.action,
  });

  final IconData icon;
  final String title, detail, status;
  final String? meta;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              color: MacosThemeColors.of(context).selection,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Icon(icon, size: 16, color: scheme.primary),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.labelLarge,
                      ),
                    ),
                    const SizedBox(width: 8),
                    _StatusPill(label: status),
                  ],
                ),
                if (detail.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    detail,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall
                        ?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ],
                if (meta != null && meta!.isNotEmpty) ...[
                  const SizedBox(height: 5),
                  Text(meta!, style: Theme.of(context).textTheme.labelSmall),
                ],
                if (action != null) ...[
                  const SizedBox(height: 8),
                  Align(alignment: Alignment.centerRight, child: action!),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _PluginRow extends StatelessWidget {
  const _PluginRow({
    required this.plugin,
    required this.busy,
    required this.canMutate,
    required this.onToggle,
    required this.onUninstall,
  });

  final AutomationPlugin plugin;
  final bool busy, canMutate;
  final void Function(AutomationPlugin plugin, bool enabled) onToggle;
  final ValueChanged<AutomationPlugin> onUninstall;

  @override
  Widget build(BuildContext context) {
    final enabled = plugin.status == 'enabled';
    return _InventoryRow(
      icon: Icons.extension_outlined,
      title: plugin.name,
      detail: plugin.description,
      meta: _pluginContents(plugin),
      status: plugin.status ?? 'installed',
      action: Wrap(
        alignment: WrapAlignment.end,
        spacing: 8,
        children: [
          TextButton(
            onPressed: canMutate && !busy
                ? () => onToggle(plugin, !enabled)
                : null,
            child: Text(enabled ? 'Disable' : 'Enable'),
          ),
          TextButton(
            onPressed: canMutate && !busy ? () => onUninstall(plugin) : null,
            child: const Text('Uninstall'),
          ),
        ],
      ),
    );
  }
}

class _ResourceBody<T> extends StatelessWidget {
  const _ResourceBody({
    required this.resource,
    required this.emptyMessage,
    required this.builder,
    this.isEmpty,
  });

  final AutomationResource<T> resource;
  final String emptyMessage;
  final Widget Function(T data) builder;
  final bool Function(T data)? isEmpty;

  @override
  Widget build(BuildContext context) {
    final data = resource.data;
    if (data == null && resource.isLoading) {
      return const Padding(
        padding: EdgeInsets.all(28),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    if (data == null && resource.hasError) {
      return _SourceUnavailable(message: resource.error);
    }
    if (data == null) return _EmptyInventory(emptyMessage);
    final empty = isEmpty?.call(data) ?? (data is Iterable && data.isEmpty);
    if (empty) return _EmptyInventory(emptyMessage);
    return Stack(
      children: [
        builder(data),
        if (resource.isLoading)
          const Positioned(
            top: 8,
            right: 10,
            child: SizedBox.square(
              dimension: 13,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ),
      ],
    );
  }
}

class _CapabilityDefinitions extends StatelessWidget {
  const _CapabilityDefinitions();

  static const definitions = <(String, String)>[
    ('Connections', 'Authorize an account or API.'),
    (
      'Custom connections',
      'Add specialist services through MCP when a built-in Connection is not available.',
    ),
    ('Skills', 'Teach an agent a reusable method without granting access.'),
    ('Automations', 'Start reviewed workflow steps from a schedule or event.'),
    (
      'Extensions',
      'Add reviewed packs of Skills, connection setup, and Automation templates.',
    ),
  ];

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(14),
    child: Column(
      children: [
        for (var index = 0; index < definitions.length; index++) ...[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 104,
                child: Text(
                  definitions[index].$1,
                  style: Theme.of(context).textTheme.labelLarge,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  definitions[index].$2,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ],
          ),
          if (index != definitions.length - 1) const SizedBox(height: 11),
        ],
      ],
    ),
  );
}

class _CapabilityRow extends StatelessWidget {
  const _CapabilityRow({required this.item, required this.onOpen});

  final _CapabilityMetric item;
  final ValueChanged<AutomationStudioSection> onOpen;

  @override
  Widget build(BuildContext context) => InkWell(
    onTap: () => onOpen(item.section),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        children: [
          Icon(
            item.icon,
            size: 18,
            color: Theme.of(context).colorScheme.primary,
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(item.label, style: Theme.of(context).textTheme.labelLarge),
                const SizedBox(height: 2),
                Text(item.detail, style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Text(item.value, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(width: 6),
          const Icon(Icons.chevron_right_rounded, size: 18),
        ],
      ),
    ),
  );
}

class _ResourceHealth extends StatelessWidget {
  const _ResourceHealth({required this.snapshot});

  final AutomationSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final sources = <(String, AutomationResource<Object>, bool)>[
      ('Skills', _erase(snapshot.skills), false),
      (
        'Connections',
        _erase(snapshot.connections),
        snapshot.connectionsPartial,
      ),
      ('MCP servers', _erase(snapshot.mcp), false),
      ('Governed tools', _erase(snapshot.tools), false),
      ('Workflow runs', _erase(snapshot.workflows), false),
      ('Automation triggers', _erase(snapshot.triggers), false),
      ('Plugins', _erase(snapshot.plugins), false),
    ];
    return Column(
      children: [
        for (var index = 0; index < sources.length; index++) ...[
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
            child: Row(
              children: [
                Icon(
                  sources[index].$2.hasError || sources[index].$3
                      ? Icons.warning_amber_rounded
                      : sources[index].$2.isLoading
                      ? Icons.sync_rounded
                      : Icons.check_circle_outline_rounded,
                  size: 17,
                  color: sources[index].$2.hasError || sources[index].$3
                      ? Theme.of(context).colorScheme.error
                      : sources[index].$2.isLoading
                      ? MacosThemeColors.of(context).warning
                      : MacosThemeColors.of(context).positive,
                ),
                const SizedBox(width: 9),
                Expanded(child: Text(sources[index].$1)),
                Text(
                  sources[index].$2.hasError
                      ? 'Unavailable'
                      : sources[index].$3
                      ? 'Partial'
                      : sources[index].$2.isLoading
                      ? 'Refreshing'
                      : sources[index].$2.isReady
                      ? 'Available'
                      : 'Not checked',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
          if (index != sources.length - 1) const Divider(height: 1),
        ],
      ],
    );
  }
}

class _McpDirectionNote extends StatelessWidget {
  const _McpDirectionNote();

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      color: MacosThemeColors.of(context).selection,
      borderRadius: BorderRadius.circular(12),
    ),
    child: const Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.compare_arrows_rounded, size: 20),
        SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Connect Codex or Claude to Asael'),
              SizedBox(height: 4),
              Text(
                'Asael can expose a governed, currently read-only MCP surface. Service keys and maximum scopes remain configured separately.',
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

class _PluginBoundary extends StatelessWidget {
  const _PluginBoundary();

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      color: MacosThemeColors.of(context).selection,
      borderRadius: BorderRadius.circular(12),
    ),
    child: const Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.verified_user_outlined, size: 20),
        SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('An Extension adds methods, not permission.'),
              SizedBox(height: 4),
              Text(
                'Extensions add Skills and setup templates. Accounts, private data, and sensitive actions keep their own connection and approval controls.',
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

class _PluginReviewDialog extends StatelessWidget {
  const _PluginReviewDialog({required this.preview, required this.busy});

  final AutomationPluginPreview preview;
  final bool busy;

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text('Review ${preview.name}'),
    content: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 560),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${preview.pluginId} · ${preview.pluginVersion}'),
            const SizedBox(height: 14),
            Text('Effects', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 6),
            for (final effect in preview.effects)
              _ReviewLine(icon: Icons.add_circle_outline, text: effect),
            const SizedBox(height: 12),
            Text('Limitations', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 6),
            for (final limitation in preview.limitations)
              _ReviewLine(icon: Icons.lock_outline, text: limitation),
            const SizedBox(height: 12),
            Text(
              'Expires ${preview.expiresAt.toLocal()}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: busy ? null : () => Navigator.pop(context, false),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: busy ? null : () => Navigator.pop(context, true),
        child: const Text('Install reviewed Plugin'),
      ),
    ],
  );
}

class _ReviewLine extends StatelessWidget {
  const _ReviewLine({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 15),
        const SizedBox(width: 8),
        Expanded(child: Text(text)),
      ],
    ),
  );
}

class _RiskRow extends StatelessWidget {
  const _RiskRow({required this.level, required this.count});

  final int level, count;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
    child: Row(
      children: [
        _StatusPill(label: 'Risk $level'),
        const SizedBox(width: 12),
        Expanded(child: Text(_riskLabel(level))),
        Text('$count', style: Theme.of(context).textTheme.titleMedium),
      ],
    ),
  );
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final normalized = label.toLowerCase();
    final positive = const {
      'active',
      'enabled',
      'ready',
      'available',
      'completed',
    }.contains(normalized);
    final attention =
        normalized.contains('error') ||
        normalized.contains('failed') ||
        normalized.contains('unavailable');
    final color = attention
        ? Theme.of(context).colorScheme.error
        : positive
        ? MacosThemeColors.of(context).positive
        : Theme.of(context).colorScheme.onSurfaceVariant;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: .11),
        borderRadius: BorderRadius.circular(99),
      ),
      child: Text(
        _plain(label),
        style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color),
      ),
    );
  }
}

class _SourceUnavailable extends StatelessWidget {
  const _SourceUnavailable({this.message});

  final String? message;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(18),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          Icons.warning_amber_rounded,
          color: Theme.of(context).colorScheme.error,
          size: 19,
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            message ?? 'This source is unavailable. Refresh to try again.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
      ],
    ),
  );
}

class _PartialInventory extends StatelessWidget {
  const _PartialInventory(this.message);

  final String message;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(14),
    color: MacosThemeColors.of(context).warning.withValues(alpha: .1),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          Icons.warning_amber_rounded,
          size: 18,
          color: MacosThemeColors.of(context).warning,
        ),
        const SizedBox(width: 9),
        Expanded(child: Text(message)),
      ],
    ),
  );
}

class _EmptyInventory extends StatelessWidget {
  const _EmptyInventory(this.message);

  final String message;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(22),
    child: Text(message, style: Theme.of(context).textTheme.bodySmall),
  );
}

class _RefreshState extends StatelessWidget {
  const _RefreshState({required this.controller});

  final AutomationController controller;

  @override
  Widget build(BuildContext context) {
    final attentionCount = controller.snapshot.attentionCount;
    final label = controller.refreshing
        ? 'Refreshing'
        : attentionCount == 1
        ? '1 source needs attention'
        : attentionCount > 1
        ? '$attentionCount sources need attention'
        : controller.refreshedAt == null
        ? 'Not checked'
        : 'Current';
    final color = attentionCount > 0
        ? Theme.of(context).colorScheme.error
        : controller.refreshing
        ? MacosThemeColors.of(context).warning
        : MacosThemeColors.of(context).positive;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 7),
        Text(label, style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}

class _MessageBar extends StatelessWidget {
  const _MessageBar({
    required this.error,
    required this.notice,
    required this.onDismiss,
  });

  final String? error, notice;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final isError = error != null;
    return Material(
      color: isError
          ? Theme.of(context).colorScheme.errorContainer
          : Theme.of(context).colorScheme.tertiaryContainer,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 8, 8, 8),
        child: Row(
          children: [
            Icon(
              isError
                  ? Icons.error_outline_rounded
                  : Icons.check_circle_outline,
              size: 18,
            ),
            const SizedBox(width: 9),
            Expanded(child: Text(error ?? notice ?? '')),
            IconButton(
              tooltip: 'Dismiss',
              onPressed: onDismiss,
              icon: const Icon(Icons.close_rounded, size: 17),
            ),
          ],
        ),
      ),
    );
  }
}

class _AutomationAccessDenied extends StatelessWidget {
  const _AutomationAccessDenied();

  @override
  Widget build(BuildContext context) => const MacosPageScaffold(
    title: 'Automation',
    description: 'Capability and workflow administration.',
    icon: Icons.lock_outline_rounded,
    body: Center(
      child: MacosEmptyState(
        icon: Icons.admin_panel_settings_outlined,
        title: 'Operator access required',
        message: 'Automation, connections, Tools, Skills, and Plugins are available to workspace operators and owners.',
      ),
    ),
  );
}

class _CapabilityMetric {
  const _CapabilityMetric({
    required this.label,
    required this.value,
    required this.detail,
    required this.icon,
    required this.section,
  });

  final String label, value, detail;
  final IconData icon;
  final AutomationStudioSection section;
}

List<_CapabilityMetric> _capabilitySummary(AutomationSnapshot snapshot) {
  final connectionInventory = snapshot.connections.data;
  final connections =
      connectionInventory?.installed
          .where((item) => item.kind.toLowerCase() != 'mcp')
          .toList(growable: false) ??
      const <AutomationConnection>[];
  final connected = connections.where((item) => item.connected).length;
  final connectionsPartial = snapshot.connectionsPartial;
  final mcp = snapshot.mcp.data;
  final activeMcp = mcp?.where((item) => item.status == 'active').length;
  final tools = snapshot.tools.data;
  final activeTools = tools?.where((item) => item.status == 'active').length;
  final skills = snapshot.skills.data;
  final activeSkills = skills?.where((item) => item.status == 'active').length;
  final triggers = snapshot.triggers.data;
  final activeTriggers = triggers
      ?.where((item) => item.status == 'active')
      .length;
  final workflows = snapshot.workflows.data;
  final liveRuns = workflows
      ?.where(
        (item) => const {
          'queued',
          'running',
          'waiting_approval',
          'paused',
        }.contains(item.status),
      )
      .length;
  final plugins = snapshot.plugins.data?.plugins;
  final enabledPlugins = plugins
      ?.where((item) => item.installed && item.status == 'enabled')
      .length;
  return [
    _CapabilityMetric(
      label: 'Access',
      value: mcp == null && snapshot.connections.data == null
          ? '—'
          : connectionsPartial
          ? '≥${connected + (activeMcp ?? 0)}'
          : '${connected + (activeMcp ?? 0)}',
      detail: connectionsPartial
          ? '$connected verified connections · ${activeMcp ?? '—'} MCP · partial source data'
          : '${snapshot.connections.data == null ? '—' : connected} connected · ${activeMcp ?? '—'} MCP',
      icon: Icons.cable_outlined,
      section: AutomationStudioSection.connections,
    ),
    _CapabilityMetric(
      label: 'Actions',
      value: activeTools?.toString() ?? '—',
      detail: tools == null
          ? 'Tool inventory unavailable'
          : '${tools.length} governed tools',
      icon: Icons.build_outlined,
      section: AutomationStudioSection.advanced,
    ),
    _CapabilityMetric(
      label: 'Guidance',
      value: activeSkills?.toString() ?? '—',
      detail: skills == null
          ? 'Skill catalog unavailable'
          : '${skills.length} reusable Skills',
      icon: Icons.menu_book_outlined,
      section: AutomationStudioSection.skills,
    ),
    _CapabilityMetric(
      label: 'Repeat',
      value: activeTriggers?.toString() ?? '—',
      detail:
          '${activeTriggers ?? '—'} active triggers · ${liveRuns ?? '—'} live runs',
      icon: Icons.account_tree_outlined,
      section: AutomationStudioSection.automations,
    ),
    _CapabilityMetric(
      label: 'Bundles',
      value: enabledPlugins?.toString() ?? '—',
      detail: plugins == null
          ? 'Plugin catalog unavailable'
          : '${plugins.length} Plugin records',
      icon: Icons.extension_outlined,
      section: AutomationStudioSection.plugins,
    ),
  ];
}

AutomationResource<Object> _erase<T>(AutomationResource<T> resource) =>
    switch (resource.status) {
      AutomationResourceStatus.idle => const AutomationResource.idle(),
      AutomationResourceStatus.loading => AutomationResource.loading(
        resource.data,
      ),
      AutomationResourceStatus.ready => AutomationResource.ready(
        resource.data as Object,
      ),
      AutomationResourceStatus.failed => AutomationResource.failed(
        resource.error ?? 'Unavailable',
        resource.data,
      ),
    };

String _pluginContents(AutomationPlugin plugin) =>
    '${plugin.skillCount} Skills · ${plugin.mcpTemplateCount} MCP templates · ${plugin.workflowTemplateCount} workflow templates';

String _plain(String value) => value.replaceAll('_', ' ').trim();

String _timeSuffix(DateTime? value) {
  if (value == null) return '';
  final local = value.toLocal();
  final minute = local.minute.toString().padLeft(2, '0');
  return ' · ${local.month}/${local.day} ${local.hour}:$minute';
}

String _riskLabel(int level) => switch (level) {
  0 => 'Read-only and informational',
  1 => 'Low-impact reversible action',
  2 => 'Consequential action; approval expected',
  _ => 'High-impact or irreversible action',
};
