import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/application/session_controller.dart';
import 'automation_controller.dart';
import 'automation_models.dart';
import 'automation_providers.dart';

/// Touch-first Automation Studio used by Android.
///
/// It shares the same controller and exact management projections as macOS,
/// while using sheets and stacked cards instead of desktop split panes.
class AutomationStudioView extends ConsumerStatefulWidget {
  const AutomationStudioView({super.key, this.initialSection});

  final String? initialSection;

  @override
  ConsumerState<AutomationStudioView> createState() =>
      _AutomationStudioViewState();
}

class _AutomationStudioViewState extends ConsumerState<AutomationStudioView> {
  late int _tabIndex =
      const {'overview', 'automations', null}.contains(widget.initialSection)
      ? 0
      : 1;

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionControllerProvider).value;
    if (session == null || !session.canManage) {
      return const Scaffold(
        body: _PortableAutomationEmpty(
          icon: Icons.lock_outline_rounded,
          title: 'Operator access required',
          message: 'Automation inventory and schedule evidence are available to workspace operators.',
        ),
      );
    }
    final controller = ref.watch(automationControllerProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Capabilities'),
            Text(
              'Skills, connections, extensions, and repeatable work',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w400),
            ),
          ],
        ),
        actions: [
          IconButton(
            key: const Key('automation-portable-refresh'),
            tooltip: 'Refresh Automation Studio',
            onPressed: controller.refreshing ? null : controller.refresh,
            icon: controller.refreshing
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh_rounded),
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(48),
          child: NavigationBar(
            height: 48,
            selectedIndex: _tabIndex,
            onDestinationSelected: (value) => setState(() => _tabIndex = value),
            destinations: const [
              NavigationDestination(
                icon: Icon(Icons.schedule_outlined),
                selectedIcon: Icon(Icons.schedule_rounded),
                label: 'Automations',
              ),
              NavigationDestination(
                icon: Icon(Icons.extension_outlined),
                selectedIcon: Icon(Icons.extension_rounded),
                label: 'Skills & more',
              ),
            ],
          ),
        ),
      ),
      body: Column(
        children: [
          if (controller.error != null)
            MaterialBanner(
              content: Text(controller.error!),
              actions: [
                TextButton(
                  onPressed: controller.clearMessage,
                  child: const Text('Dismiss'),
                ),
              ],
            ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: controller.refresh,
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 180),
                child: _tabIndex == 0
                    ? _PortableAutomations(
                        key: const ValueKey('portable-automations'),
                        controller: controller,
                      )
                    : _PortableCapabilities(
                        key: const ValueKey('portable-capabilities'),
                        controller: controller,
                      ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PortableAutomations extends StatelessWidget {
  const _PortableAutomations({super.key, required this.controller});

  final AutomationController controller;

  @override
  Widget build(BuildContext context) {
    final triggers = controller.snapshot.triggers;
    final workflows = controller.snapshot.workflows;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 40),
      children: [
        _PortableSectionHeader(
          icon: Icons.bolt_outlined,
          title: 'Triggers',
          description:
              'Schedules and external events that begin repeatable work.',
          count: triggers.data?.length,
        ),
        const SizedBox(height: 10),
        _PortableResource<List<AutomationTrigger>>(
          resource: triggers,
          empty: 'No automation triggers are configured.',
          builder: (items) => Column(
            children: [
              for (final trigger in items)
                Card(
                  child: ListTile(
                    key: ValueKey('portable-automation-trigger-${trigger.id}'),
                    leading: const Icon(Icons.schedule_rounded),
                    title: Text(trigger.name),
                    subtitle: Text(
                      '${_plain(trigger.source)} · ${_plain(trigger.workflowMode)} · ${_plain(trigger.status)}',
                    ),
                    trailing: const Icon(Icons.chevron_right_rounded),
                    onTap: () => _showSchedule(context, controller, trigger),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 24),
        _PortableSectionHeader(
          icon: Icons.account_tree_outlined,
          title: 'Recent workflow runs',
          description:
              'Recent executions started by people, agents, or triggers.',
          count: workflows.data?.length,
        ),
        const SizedBox(height: 10),
        _PortableResource<List<AutomationWorkflowRun>>(
          resource: workflows,
          empty: 'No workflow runs are available yet.',
          builder: (items) => Column(
            children: [
              for (final run in items)
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.play_circle_outline_rounded),
                    title: Text(run.title),
                    subtitle: Text(
                      '${_plain(run.mode)} · ${_plain(run.status)}',
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Future<void> _showSchedule(
    BuildContext context,
    AutomationController controller,
    AutomationTrigger trigger,
  ) => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => FractionallySizedBox(
      heightFactor: .92,
      child: _PortableScheduleSheet(controller: controller, trigger: trigger),
    ),
  );
}

class _PortableScheduleSheet extends StatefulWidget {
  const _PortableScheduleSheet({
    required this.controller,
    required this.trigger,
  });

  final AutomationController controller;
  final AutomationTrigger trigger;

  @override
  State<_PortableScheduleSheet> createState() => _PortableScheduleSheetState();
}

class _PortableScheduleSheetState extends State<_PortableScheduleSheet> {
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
      return Column(
        children: [
          const SizedBox(height: 10),
          Container(
            width: 36,
            height: 4,
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.outlineVariant,
              borderRadius: BorderRadius.circular(999),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 8, 10),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        widget.trigger.name,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const Text(
                        'Occurrences, receipts, and PolicyLease outcomes',
                      ),
                    ],
                  ),
                ),
                IconButton(
                  key: const Key('portable-schedule-refresh'),
                  tooltip: 'Refresh history',
                  onPressed: loading
                      ? null
                      : () => widget.controller.loadSchedule(
                          widget.trigger.id,
                          refresh: true,
                        ),
                  icon: const Icon(Icons.refresh_rounded),
                ),
                IconButton(
                  tooltip: 'Close',
                  onPressed: () => Navigator.pop(context),
                  icon: const Icon(Icons.close_rounded),
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: loading && detail == null
                ? const Center(child: CircularProgressIndicator())
                : detail == null
                ? _PortableAutomationEmpty(
                    icon: Icons.cloud_off_outlined,
                    title: 'Schedule history is unavailable',
                    message: error == null
                        ? 'No exact schedule projection is available.'
                        : 'Reconnect and retry. No missing evidence is inferred.',
                  )
                : _PortableScheduleDetail(detail: detail, staleError: error),
          ),
        ],
      );
    },
  );
}

class _PortableScheduleDetail extends StatelessWidget {
  const _PortableScheduleDetail({required this.detail, this.staleError});

  final AutomationScheduleDetail detail;
  final Object? staleError;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.fromLTRB(16, 14, 16, 32),
    children: [
      if (staleError != null)
        Card(
          color: Theme.of(context).colorScheme.errorContainer,
          child: const ListTile(
            leading: Icon(Icons.cloud_off_outlined),
            title: Text('Showing the last verified schedule history.'),
          ),
        ),
      _PortableSectionHeader(
        icon: Icons.event_repeat_outlined,
        title: 'Occurrences',
        description:
            'Exact trigger occurrences and their bound authority digest.',
        count: detail.occurrences.length,
      ),
      if (detail.occurrences.isEmpty)
        const _PortableInlineEmpty('No occurrences are recorded.')
      else
        for (final occurrence in detail.occurrences)
          _PortableEvidenceCard(
            title: occurrence.id,
            subtitle:
                '${_plain(occurrence.status)} · attempt ${occurrence.attemptCount}',
            fields: {
              'Workflow run': occurrence.workflowRunId ?? 'Not created',
              'Authority SHA-256': occurrence.authoritySha256.isEmpty
                  ? 'Unavailable'
                  : occurrence.authoritySha256,
              if (occurrence.failureCode != null)
                'Failure code': occurrence.failureCode!,
            },
          ),
      const SizedBox(height: 20),
      _PortableSectionHeader(
        icon: Icons.receipt_long_outlined,
        title: 'Receipts',
        description: 'Durable occurrence and state receipts.',
        count: detail.receipts.length,
      ),
      if (detail.receipts.isEmpty)
        const _PortableInlineEmpty('No schedule receipts are recorded.')
      else
        for (final receipt in detail.receipts)
          _PortableEvidenceCard(
            title: receipt.id,
            subtitle: '${_plain(receipt.status)} · ${receipt.occurrenceId}',
            fields: {
              'Receipt SHA-256': receipt.receiptSha256.isEmpty
                  ? 'Unavailable'
                  : receipt.receiptSha256,
              'State SHA-256': receipt.stateSha256.isEmpty
                  ? 'Unavailable'
                  : receipt.stateSha256,
            },
          ),
      const SizedBox(height: 20),
      _PortableSectionHeader(
        icon: Icons.policy_outlined,
        title: 'PolicyLease outcomes',
        description: 'Content-free evidence only. A history record never grants authority.',
        count: detail.policyLeasesAvailable ? detail.policyLeases.length : null,
      ),
      if (!detail.policyLeasesAvailable)
        const _PortableInlineEmpty(
          'PolicyLease history is unavailable on this installation.',
        )
      else if (detail.policyLeases.isEmpty)
        const _PortableInlineEmpty('No PolicyLease outcomes are recorded.')
      else
        for (final lease in detail.policyLeases)
          _PortableEvidenceCard(
            title: lease.leaseId,
            subtitle: '${_plain(lease.status)} · ${lease.toolId}',
            fields: {
              'Occurrence': lease.occurrenceId,
              'Execution': lease.executionId,
              'Lease SHA-256': lease.leaseSha256,
              'Binding SHA-256': lease.bindingSha256,
              'Tool contract SHA-256': lease.toolContractSha256,
              'Policy SHA-256': lease.policySha256,
              'Influence manifest SHA-256': lease.influenceManifestSha256,
              'Consumption receipt':
                  lease.consumptionReceiptSha256 ?? 'Not consumed',
              'Authority': 'Not granted by this history record',
              'Content': 'Excluded',
            },
          ),
    ],
  );
}

class _PortableCapabilities extends StatelessWidget {
  const _PortableCapabilities({super.key, required this.controller});

  final AutomationController controller;

  @override
  Widget build(BuildContext context) {
    final snapshot = controller.snapshot;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 40),
      children: [
        Text(
          'What Asael can use',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 5),
        const Text(
          'Skills teach Asael how to work. Connections provide access. Extensions add optional packs.',
        ),
        const SizedBox(height: 14),
        _CapabilityCard(
          icon: Icons.psychology_outlined,
          title: 'Skills',
          resource: snapshot.skills,
          count: snapshot.skills.data?.length,
        ),
        _CapabilityCard(
          icon: Icons.link_rounded,
          title: 'Connections',
          resource: snapshot.connections,
          count: snapshot.connections.data?.installed.length,
        ),
        _CapabilityCard(
          icon: Icons.hub_outlined,
          title: 'Custom connections',
          resource: snapshot.mcp,
          count: snapshot.mcp.data?.length,
        ),
        _CapabilityCard(
          icon: Icons.extension_outlined,
          title: 'Extensions',
          resource: snapshot.plugins,
          count: snapshot.plugins.data?.plugins.length,
        ),
      ],
    );
  }
}

class _CapabilityCard<T> extends StatelessWidget {
  const _CapabilityCard({
    required this.icon,
    required this.title,
    required this.resource,
    required this.count,
  });

  final IconData icon;
  final String title;
  final AutomationResource<T> resource;
  final int? count;

  @override
  Widget build(BuildContext context) {
    final label = resource.hasError
        ? 'Unavailable'
        : resource.isLoading && count == null
        ? 'Loading…'
        : count == null
        ? 'Not loaded'
        : '$count available';
    return Card(
      child: ListTile(
        leading: Icon(icon),
        title: Text(title),
        subtitle: Text(resource.error ?? label),
        trailing: resource.isLoading
            ? const SizedBox.square(
                dimension: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : Text(label),
      ),
    );
  }
}

class _PortableSectionHeader extends StatelessWidget {
  const _PortableSectionHeader({
    required this.icon,
    required this.title,
    required this.description,
    this.count,
  });

  final IconData icon;
  final String title, description;
  final int? count;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Icon(icon, color: Theme.of(context).colorScheme.primary),
      const SizedBox(width: 10),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            Text(description, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
      if (count != null) Chip(label: Text('$count')),
    ],
  );
}

class _PortableResource<T> extends StatelessWidget {
  const _PortableResource({
    required this.resource,
    required this.empty,
    required this.builder,
  });

  final AutomationResource<T> resource;
  final String empty;
  final Widget Function(T value) builder;

  @override
  Widget build(BuildContext context) {
    final value = resource.data;
    if (value == null && resource.isLoading) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: CircularProgressIndicator(),
        ),
      );
    }
    if (value == null) {
      return _PortableInlineEmpty(
        resource.error ?? 'This source is unavailable.',
      );
    }
    if (value is List && value.isEmpty) return _PortableInlineEmpty(empty);
    return builder(value);
  }
}

class _PortableEvidenceCard extends StatelessWidget {
  const _PortableEvidenceCard({
    required this.title,
    required this.subtitle,
    required this.fields,
  });

  final String title, subtitle;
  final Map<String, String> fields;

  @override
  Widget build(BuildContext context) => Card(
    child: ExpansionTile(
      title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(subtitle),
      childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
      children: [
        for (final entry in fields.entries)
          Padding(
            padding: const EdgeInsets.only(top: 7),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 116,
                  child: Text(
                    entry.key,
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ),
                Expanded(
                  child: SelectableText(
                    entry.value,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      fontFamily: entry.key.contains('SHA-256')
                          ? 'monospace'
                          : null,
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

class _PortableInlineEmpty extends StatelessWidget {
  const _PortableInlineEmpty(this.message);

  final String message;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          const Icon(Icons.info_outline_rounded),
          const SizedBox(width: 10),
          Expanded(child: Text(message)),
        ],
      ),
    ),
  );
}

class _PortableAutomationEmpty extends StatelessWidget {
  const _PortableAutomationEmpty({
    required this.icon,
    required this.title,
    required this.message,
  });

  final IconData icon;
  final String title, message;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 42, color: Theme.of(context).colorScheme.primary),
          const SizedBox(height: 12),
          Text(title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 6),
          Text(message, textAlign: TextAlign.center),
        ],
      ),
    ),
  );
}

String _plain(String value) => value
    .replaceAll('_', ' ')
    .split(' ')
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');
