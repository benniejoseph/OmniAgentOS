import 'package:flutter/material.dart';

import 'activity.dart';

class ActivityView extends StatefulWidget {
  const ActivityView({
    super.key,
    required this.controller,
    required this.onOpen,
  });
  final ActivityController controller;
  final ValueChanged<String> onOpen;

  @override
  State<ActivityView> createState() => _ActivityViewState();
}

class _ActivityViewState extends State<ActivityView> {
  final _headingFocus = FocusNode(debugLabel: 'Activity results');
  @override
  void dispose() {
    _headingFocus.dispose();
    super.dispose();
  }

  Future<void> _page(Future<void> Function() read) async {
    final controller = widget.controller;
    final before = controller.snapshot;
    final focused = FocusManager.instance.primaryFocus;
    final scope = focused?.nearestScope;
    await read();
    if (!mounted ||
        !identical(controller, widget.controller) ||
        identical(before, controller.snapshot)) {
      return;
    }
    final current = FocusManager.instance.primaryFocus;
    if (current == focused ||
        current == null ||
        (current is FocusScopeNode && current == scope)) {
      _headingFocus.requestFocus();
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      final snapshot = controller.snapshot;
      final known = snapshot?.known ?? false;
      final group = snapshot?.group ?? ActivityGroup.all;
      final pending = controller.pendingGroup;
      final theme = Theme.of(context);
      final support = theme.textTheme.bodySmall;
      final status = controller.loading
          ? 'Checking ${pending!.label.toLowerCase()}.${snapshot == null ? '' : ' Last loaded records remain below.'}'
          : controller.error != null
          ? 'Activity could not be checked.${known ? ' Last loaded rows and counts are shown.' : ' Counts are unavailable.'}'
          : !known
          ? 'Activity sources are unavailable. Counts could not be checked.'
          : '${snapshot!.items.length} records shown.${snapshot.state == 'partial' ? ' Some source coverage is incomplete.' : ' Current window loaded.'}';
      return Scaffold(
        body: SafeArea(
          top: false,
          child: Align(
            alignment: Alignment.topCenter,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1280),
              child: SingleChildScrollView(
                key: const PageStorageKey('activity-scroll'),
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Wrap(
                      alignment: WrapAlignment.spaceBetween,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      spacing: 16,
                      runSpacing: 12,
                      children: [
                        Semantics(
                          header: true,
                          child: Text(
                            'Activity',
                            style: theme.textTheme.headlineMedium,
                          ),
                        ),
                        OutlinedButton.icon(
                          onPressed: controller.loading
                              ? null
                              : controller.refresh,
                          icon: const Icon(Icons.refresh),
                          label: const Text('Refresh activity'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Work in progress, decisions and updates from your workspace.',
                    ),
                    const SizedBox(height: 8),
                    Text(
                      snapshot == null
                          ? 'No activity window has been loaded.'
                          : '${controller.stale
                                ? 'Last loaded'
                                : known
                                ? 'Window checked'
                                : 'Read attempted'} ${_time(snapshot.generatedAt)}',
                      style: support,
                    ),
                    const SizedBox(height: 16),
                    const Text(
                      'This view checks up to 100 recent records per source. Counts describe this readable window; older or inaccessible records may be absent. Open a source to inspect its details or take action.',
                    ),
                    const SizedBox(height: 16),
                    Semantics(
                      container: true,
                      label: 'Activity views',
                      child: Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          for (final option in ActivityGroup.values)
                            Semantics(
                              selected: (pending ?? group) == option,
                              child: OutlinedButton(
                                key: ValueKey('activity-filter-${option.wire}'),
                                onPressed: () => controller.select(option),
                                style: (pending ?? group) == option
                                    ? OutlinedButton.styleFrom(
                                        backgroundColor: theme
                                            .colorScheme
                                            .secondaryContainer,
                                        side: BorderSide(
                                          color: theme.colorScheme.secondary,
                                          width: 3,
                                        ),
                                      )
                                    : null,
                                child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Text(option.label),
                                    Text(
                                      known
                                          ? '${snapshot!.countFor(option)} in window'
                                          : 'Count unavailable',
                                      style: support,
                                    ),
                                  ],
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                    Semantics(
                      liveRegion: true,
                      child: Text(
                        status,
                        key: const ValueKey('activity-read-status'),
                        style: support,
                      ),
                    ),
                    if (controller.error != null) ...[
                      const SizedBox(height: 12),
                      Text(
                        controller.error!,
                        style: TextStyle(color: theme.colorScheme.error),
                      ),
                      if (known)
                        const Text(
                          'The retained records describe the previous window and may have changed.',
                        ),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: OutlinedButton(
                          onPressed: controller.loading
                              ? null
                              : controller.refresh,
                          child: const Text('Retry activity'),
                        ),
                      ),
                    ],
                    if (controller.notice != null)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: Text(controller.notice!),
                      ),
                    if (snapshot != null)
                      ExpansionTile(
                        key: const PageStorageKey('activity-coverage'),
                        tilePadding: EdgeInsets.zero,
                        title: Text(
                          'Source coverage · ${controller.stale
                              ? 'last loaded'
                              : snapshot.state == 'ready'
                              ? 'checked'
                              : snapshot.state == 'partial'
                              ? 'incomplete'
                              : 'unavailable'}',
                        ),
                        children: [
                          for (final source in activitySources)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: _coverage(
                                source,
                                snapshot.coverage[source]!,
                              ),
                            ),
                          const Padding(
                            padding: EdgeInsets.only(bottom: 16),
                            child: Text(
                              'Only authorized metadata is shown. This page does not continuously monitor the sources.',
                            ),
                          ),
                        ],
                      ),
                    const SizedBox(height: 20),
                    Focus(
                      focusNode: _headingFocus,
                      child: Semantics(
                        header: true,
                        child: Text(
                          group.label,
                          style: theme.textTheme.titleLarge,
                        ),
                      ),
                    ),
                    Text(
                      known
                          ? '${controller.stale ? 'Last loaded: ' : ''}${snapshot!.items.isEmpty ? 0 : controller.pageIndex * activityPageLimit + 1}–${snapshot.items.isEmpty ? 0 : controller.pageIndex * activityPageLimit + snapshot.items.length} of ${snapshot.countFor(group)} in this window'
                          : 'Count unavailable',
                      style: support,
                    ),
                    const SizedBox(height: 16),
                    if (snapshot == null && controller.loading)
                      const Text('Loading the records you can access.')
                    else if (!known)
                      const _Empty(
                        title: 'Activity is unavailable',
                        message: 'The source reads have not established whether any activity is available.',
                      )
                    else if (snapshot!.items.isEmpty)
                      _Empty(
                        title:
                            'No ${group == ActivityGroup.all ? 'activity' : group.label.toLowerCase()} in this window',
                        message: snapshot.state == 'partial'
                            ? 'No matching records were returned by the readable sources. Incomplete sources may contain other activity.'
                            : 'The checked sources returned no matching records within this bounded window.',
                      )
                    else
                      for (final section in ActivityGroup.values.skip(1))
                        if (snapshot.items.any(
                          (item) => item.group == section,
                        )) ...[
                          Semantics(
                            header: true,
                            child: Text(
                              section.label,
                              style: theme.textTheme.titleMedium,
                            ),
                          ),
                          for (final item in snapshot.items.where(
                            (item) => item.group == section,
                          ))
                            _ActivityRow(item: item, onOpen: widget.onOpen),
                          const SizedBox(height: 24),
                        ],
                    if (known)
                      Wrap(
                        alignment: WrapAlignment.spaceBetween,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        spacing: 16,
                        runSpacing: 12,
                        children: [
                          Text(
                            'Page ${controller.pageIndex + 1} of the ${controller.stale ? 'last loaded ' : ''}window',
                            style: support,
                          ),
                          Wrap(
                            spacing: 12,
                            runSpacing: 12,
                            children: [
                              OutlinedButton(
                                onPressed: controller.canPrevious
                                    ? () => _page(controller.previous)
                                    : null,
                                child: const Text('Previous'),
                              ),
                              OutlinedButton(
                                onPressed: controller.canNext
                                    ? () => _page(controller.next)
                                    : null,
                                child: const Text('Next'),
                              ),
                            ],
                          ),
                        ],
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    },
  );

  Widget _coverage(String source, ActivityCoverage coverage) => Align(
    alignment: Alignment.centerLeft,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(switch (source) {
          'runs' => 'Your runs',
          'approvals' => 'Authorized approvals',
          _ => 'Your reminders',
        }, style: Theme.of(context).textTheme.titleSmall),
        Text(coverage.label),
        Text(
          coverage.visibleCount == null
              ? 'Count unavailable.'
              : '${coverage.visibleCount} readable records within the 100-record source limit.',
        ),
      ],
    ),
  );
}

class _ActivityRow extends StatelessWidget {
  const _ActivityRow({required this.item, required this.onOpen});
  final ActivityItem item;
  final ValueChanged<String> onOpen;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      key: ValueKey('activity-record-${item.id}'),
      padding: const EdgeInsets.symmetric(vertical: 16),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: theme.dividerColor)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(item.title, style: theme.textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(
            '${_label(item.status)}${item.outcomeLabel.isEmpty ? '' : ' · ${item.outcomeLabel}'}',
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: 8),
          Text(item.summary),
          const SizedBox(height: 8),
          Text(
            '${_label(item.sourceRef.kind)} ID',
            style: theme.textTheme.bodySmall,
          ),
          SelectableText(item.sourceRef.id),
          Text(
            '${_label(item.timeBasis)} ${_time(item.at)}',
            style: theme.textTheme.bodySmall,
          ),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: const Text('Record references'),
            children: [
              _field('Activity ID', item.id),
              _field('Work identity', item.workKey),
              _field('Source state', item.status),
              if (item.sourceRef.approvalKind != null)
                _field('Approval type', item.sourceRef.approvalKind!),
              if (item.conversationId != null)
                _field('Conversation ID', item.conversationId!),
              for (final reference in item.references)
                _field('${_label(reference.kind)} reference', reference.id),
              _field('Web source', item.href),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              OutlinedButton(
                onPressed: () => onOpen(item.nativeLocation),
                child: Text(item.sourceLabel),
              ),
              if (item.originRunId != null)
                TextButton(
                  onPressed: () =>
                      onOpen(ActivityItem.runLocation(item.originRunId!)),
                  child: const Text('Inspect originating run'),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _field(String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Align(
      alignment: Alignment.centerLeft,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [Text(label), SelectableText(value)],
      ),
    ),
  );
}

class _Empty extends StatelessWidget {
  const _Empty({required this.title, required this.message});
  final String title, message;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Text(message),
      ],
    ),
  );
}

String _label(String value) => value.replaceAll('_', ' ');
String _time(DateTime value) =>
    '${value.toLocal().toIso8601String().replaceFirst('T', ' ').split('.').first} (local)';
