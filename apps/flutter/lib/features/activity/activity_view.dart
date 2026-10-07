import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../../core/network/api_exception.dart';
import 'activity.dart';

class ActivityView extends StatefulWidget {
  const ActivityView({super.key, required this.controller, required this.onOpen});
  final ActivityController controller;
  final ValueChanged<String> onOpen;

  @override
  State<ActivityView> createState() => _ActivityViewState();
}

class _ActivityViewState extends State<ActivityView> {
  final _headingFocus = FocusNode(debugLabel: 'Activity results');
  CancelToken? _detailRequest;
  String? _selectedId, _detailError, _technicalId;
  ActivityTaskDetail? _detail;
  bool _detailLoading = false;

  @override
  void didUpdateWidget(covariant ActivityView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller)) _clearDetail();
  }

  void _clearDetail() {
    _detailRequest?.cancel('Task selection changed');
    _detailRequest = null;
    _selectedId = _detailError = _technicalId = null;
    _detail = null;
    _detailLoading = false;
  }

  @override
  void dispose() {
    _clearDetail();
    _headingFocus.dispose();
    super.dispose();
  }

  Future<void> _selectDetail(ActivityItem item, {bool retry = false}) async {
    if (_selectedId == item.id && !retry) {
      setState(_clearDetail);
      return;
    }
    _clearDetail();
    final controller = widget.controller;
    final cancel = CancelToken();
    setState(() {
      _selectedId = item.id;
      _detailRequest = cancel;
      _detailLoading = true;
    });
    bool current() => mounted && !cancel.isCancelled &&
        identical(widget.controller, controller) && identical(_detailRequest, cancel);
    try {
      final result = await controller.readTaskDetails(item.sourceRef.id, cancel);
      if (current()) setState(() => _detail = result);
    } catch (failure) {
      if (current()) {
        setState(() => _detailError = failure is ApiException &&
                (failure.statusCode == 401 || failure.statusCode == 403)
            ? 'You no longer have access to this task.'
            : failure is ApiException && failure.statusCode == 404
            ? 'This task is no longer available.'
            : 'Task details could not be loaded. Try again.');
      }
    } finally {
      if (current()) setState(() => _detailLoading = false);
    }
  }

  Future<void> _page(Future<void> Function() read) async {
    final controller = widget.controller;
    final before = controller.snapshot;
    final focused = FocusManager.instance.primaryFocus;
    final scope = focused?.nearestScope;
    setState(_clearDetail);
    await read();
    if (!mounted || !identical(controller, widget.controller) ||
        identical(before, controller.snapshot)) return;
    final current = FocusManager.instance.primaryFocus;
    if (current == focused || current == null ||
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
      final order = [ActivityGroup.all, ActivityGroup.needsYou,
        ActivityGroup.working, ActivityGroup.updates, ActivityGroup.history];
      final status = controller.loading
          ? 'Checking activity…${snapshot == null ? '' : ' Your last loaded activity remains visible.'}'
          : controller.error != null
          ? 'Activity could not be refreshed.${known ? ' Your last loaded activity is shown.' : ''}'
          : snapshot?.state == 'partial'
          ? 'Some activity could not be loaded.' : null;
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
                    Row(children: [
                      Expanded(child: Semantics(header: true,
                        child: Text('Timeline', style: theme.textTheme.headlineSmall))),
                      OutlinedButton.icon(
                        onPressed: controller.loading ? null : controller.refresh,
                        icon: const Icon(Icons.refresh, size: 18),
                        label: const Text('Refresh'),
                      ),
                    ]),
                    const SizedBox(height: 4),
                    const Text('Tasks, decisions, and reminders, in the order they happened.'),
                    if (snapshot != null) ...[
                      const SizedBox(height: 4),
                      Text('${controller.stale ? 'Last checked' : 'Updated'} ${_time(context, snapshot.generatedAt)}', style: support),
                    ],
                    const SizedBox(height: 12),
                    Semantics(container: true, label: 'Filter timeline',
                      child: Wrap(spacing: 8, runSpacing: 8, children: [
                        for (final option in order)
                          if (option == ActivityGroup.all || option == (pending ?? group) ||
                              !known || snapshot!.countFor(option) > 0)
                            ChoiceChip(
                              key: ValueKey('activity-filter-${option.wire}'),
                              selected: (pending ?? group) == option,
                              label: Text('${option.label}${known ? '  ${snapshot!.countFor(option)}' : ''}'),
                              onSelected: (_) {
                                setState(_clearDetail);
                                controller.select(option);
                              },
                            ),
                      ]),
                    ),
                    if (status != null) Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Semantics(liveRegion: true,
                        child: Text(status, key: const ValueKey('activity-read-status'), style: support)),
                    ),
                    if (controller.error != null) ...[
                      const SizedBox(height: 8),
                      Text(controller.error!, style: TextStyle(color: theme.colorScheme.error)),
                      Align(alignment: Alignment.centerLeft,
                        child: TextButton(onPressed: controller.loading ? null : controller.refresh,
                          child: const Text('Try again'))),
                    ],
                    if (controller.notice != null) Padding(
                      padding: const EdgeInsets.only(top: 8), child: Text(controller.notice!, style: support)),
                    const SizedBox(height: 16),
                    Focus(focusNode: _headingFocus,
                      child: Semantics(header: true,
                        child: Text(group.label, style: theme.textTheme.titleMedium))),
                    if (known && snapshot!.items.isNotEmpty) Padding(
                      padding: const EdgeInsets.only(top: 4, bottom: 8),
                      child: Text('${controller.pageIndex * activityPageLimit + 1}–${controller.pageIndex * activityPageLimit + snapshot.items.length} of ${snapshot.countFor(group)} recent updates', style: support)),
                    if (snapshot == null && controller.loading)
                      const Padding(padding: EdgeInsets.symmetric(vertical: 16),
                        child: LinearProgressIndicator(minHeight: 2))
                    else if (!known)
                      const _Empty(title: 'Activity is unavailable', message: 'Refresh to check your recent work again.')
                    else if (snapshot!.items.isEmpty)
                      _Empty(title: 'No recent ${group == ActivityGroup.all ? 'activity' : group.label.toLowerCase()}',
                        message: snapshot.state == 'partial'
                            ? 'Some activity could not be checked. Refresh to try again.'
                            : 'New tasks, decisions, and updates will appear here.')
                    else
                      for (final section in order.skip(1))
                        if (snapshot.items.any((item) => item.group == section)) ...[
                          if (group != section) Padding(
                            padding: const EdgeInsets.only(top: 12, bottom: 4),
                            child: Semantics(header: true,
                              child: Text(section.label, style: theme.textTheme.labelLarge))),
                          for (final item in snapshot.items.where((item) => item.group == section))
                            _ActivityRow(
                              item: item, onOpen: widget.onOpen,
                              selected: _selectedId == item.id,
                              onSelect: () => _selectDetail(item),
                              showTechnical: _technicalId == item.id,
                              onTechnical: () => setState(() => _technicalId = _technicalId == item.id ? null : item.id),
                              details: _selectedId == item.id
                                  ? _TaskPreview(detail: _detail, loading: _detailLoading,
                                      error: _detailError, onRetry: () => _selectDetail(item, retry: true))
                                  : null,
                            ),
                        ],
                    if (known && (snapshot!.hasMore || controller.pageIndex > 0))
                      Padding(padding: const EdgeInsets.only(top: 12),
                        child: Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
                          Text('Page ${controller.pageIndex + 1}', style: support),
                          OutlinedButton(onPressed: controller.canPrevious ? () => _page(controller.previous) : null,
                            child: const Text('Previous')),
                          const SizedBox(width: 8),
                          OutlinedButton(onPressed: controller.canNext ? () => _page(controller.next) : null,
                            child: const Text('Next')),
                        ])),
                    if (snapshot != null) Padding(
                      padding: const EdgeInsets.only(top: 16),
                      child: ExpansionTile(
                        key: const PageStorageKey('activity-coverage'),
                        tilePadding: EdgeInsets.zero,
                        dense: true,
                        title: Text(snapshot.state == 'ready' ? 'About this activity list' : 'Some activity is unavailable', style: support),
                        children: [
                          for (final source in activitySources)
                            if (snapshot.coverage[source]!.visibleCount != 0 || snapshot.coverage[source]!.state != 'ready')
                              _coverage(source, snapshot.coverage[source]!),
                          const Padding(padding: EdgeInsets.only(bottom: 12),
                            child: Text('Includes up to 100 recent records per source that you can access. Older activity may not appear. Refresh to check for changes.')),
                        ],
                      ),
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

  Widget _coverage(String source, ActivityCoverage coverage) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Align(alignment: Alignment.centerLeft,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(switch (source) { 'runs' => 'Assistant tasks', 'approvals' => 'Approvals', _ => 'Reminders and updates' },
          style: Theme.of(context).textTheme.labelLarge),
        Text('${coverage.label}${coverage.visibleCount == null ? '' : ' · ${coverage.visibleCount} recent records'}'),
      ])),
  );
}

class _ActivityRow extends StatelessWidget {
  const _ActivityRow({required this.item, required this.onOpen, required this.selected,
    required this.onSelect, required this.showTechnical, required this.onTechnical, this.details});
  final ActivityItem item;
  final ValueChanged<String> onOpen;
  final bool selected;
  final VoidCallback onSelect;
  final bool showTechnical;
  final VoidCallback onTechnical;
  final Widget? details;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final failed = item.status == 'failed' || item.canonicalStatus == 'failed';
    final attention = item.group == ActivityGroup.needsYou ||
        const {'unverified', 'partial', 'blocked'}.contains(item.canonicalStatus);
    final verified = item.canonicalStatus == 'succeeded';
    final color = failed ? theme.colorScheme.error
        : attention ? theme.colorScheme.secondary : theme.colorScheme.onSurfaceVariant;
    final destination = item.source == 'approvals' ? 'Review action'
        : item.source == 'runs' ? 'Open full task'
        : item.responsibilityId != null ? 'View update' : 'Open reminder';
    return Container(
      key: ValueKey('activity-record-${item.id}'),
      padding: const EdgeInsets.symmetric(vertical: 12),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: theme.dividerColor))),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(padding: const EdgeInsets.only(top: 2, right: 10),
          child: Icon(failed || attention ? Icons.error_outline : verified ? Icons.check_circle_outline
              : item.source == 'notifications' ? Icons.notifications_none
              : item.group == ActivityGroup.working ? Icons.schedule : Icons.chat_bubble_outline,
            size: 18, color: color)),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(_title(item), style: theme.textTheme.titleSmall),
          const SizedBox(height: 3),
          Wrap(spacing: 12, runSpacing: 4, children: [
            Text(_state(item), style: theme.textTheme.bodySmall?.copyWith(color: color)),
            Text('${item.timeBasis == 'completed' ? 'Finished' : _label(item.timeBasis)} ${_time(context, item.at)}',
              style: theme.textTheme.bodySmall),
          ]),
          if (item.summary.trim().isNotEmpty) Padding(
            padding: const EdgeInsets.only(top: 4), child: Text(_summary(item), style: theme.textTheme.bodySmall)),
          Wrap(spacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
            if (item.source == 'runs') TextButton(onPressed: onSelect,
              child: Text(selected ? 'Hide details' : failed ? 'View failure' : 'View task')),
            TextButton.icon(onPressed: () => onOpen(item.nativeLocation),
              icon: const Icon(Icons.north_east, size: 14), label: Text(destination)),
            if (item.originRunId != null) TextButton(
              onPressed: () => onOpen(ActivityItem.runLocation(item.originRunId!)),
              child: const Text('Open related task')),
            IconButton(tooltip: 'Technical details', icon: const Icon(Icons.more_horiz, size: 18),
              isSelected: showTechnical, onPressed: onTechnical),
          ]),
          if (details != null) details!,
          if (showTechnical) _references(),
        ])),
      ]),
    );
  }

  Widget _references() => Padding(padding: const EdgeInsets.only(top: 8),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          _field('Activity ID', item.id), _field('Work identity', item.workKey),
          _field('Source state', item.status),
          if (item.sourceRef.approvalKind != null) _field('Approval type', item.sourceRef.approvalKind!),
          if (item.conversationId != null) _field('Conversation ID', item.conversationId!),
          for (final reference in item.references) _field('${_label(reference.kind)} reference', reference.id),
        ]));

  Widget _field(String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Column(crossAxisAlignment: CrossAxisAlignment.start,
      children: [Text(label), SelectableText(value)]),
  );
}

class _TaskPreview extends StatelessWidget {
  const _TaskPreview({required this.detail, required this.loading, required this.error, required this.onRetry});
  final ActivityTaskDetail? detail;
  final bool loading;
  final String? error;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final value = detail;
    return Container(
      margin: const EdgeInsets.only(top: 4, bottom: 8),
      padding: const EdgeInsets.only(left: 12),
      decoration: BoxDecoration(border: Border(left: BorderSide(color: theme.dividerColor, width: 2))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (loading) const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('Loading task details…')),
        if (error != null) ...[Text(error!, style: TextStyle(color: theme.colorScheme.error)),
          Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: onRetry, child: const Text('Try again')))],
        if (value != null) ...[
          if (value.prompt.isNotEmpty) _section(context, 'Your task', value.prompt),
          if (value.error.isNotEmpty) _section(context, 'What went wrong', value.error, failure: true),
          if (value.response.isNotEmpty) _section(context, value.error.isEmpty ? 'Response' : 'Partial response', value.response),
          if (value.duration != null) Text('Time taken: ${_elapsed(value.duration!)}', style: theme.textTheme.bodySmall),
          if (value.prompt.isEmpty && value.response.isEmpty && value.error.isEmpty)
            const Text('No task text is available here. Open the full task for its current status.'),
        ],
      ]),
    );
  }

  Widget _section(BuildContext context, String title, String text, {bool failure = false}) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(title, style: Theme.of(context).textTheme.labelLarge),
      const SizedBox(height: 3),
      SelectableText(text, style: failure ? TextStyle(color: Theme.of(context).colorScheme.error) : null),
    ]),
  );
}

class _Empty extends StatelessWidget {
  const _Empty({required this.title, required this.message});
  final String title, message;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 20),
    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(title, style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: 6), Text(message),
    ]),
  );
}

String _title(ActivityItem item) {
  if (item.title == 'Tool approval') return 'Review a proposed action';
  if (item.title == 'Workflow approval') return 'Review a proposed plan';
  if (item.title != 'Agent run') return item.title;
  return switch (item.status) {
    'completed' => 'Assistant response completed', 'failed' => 'Assistant task failed',
    'canceled' => 'Assistant task stopped', 'waiting_approval' => 'Assistant needs your approval',
    'waiting_clarification' => 'Assistant has a question', 'queued' => 'Assistant task queued',
    _ => 'Assistant is working',
  };
}

String _state(ActivityItem item) {
  if (item.status == 'failed' || item.canonicalStatus == 'failed') return 'Failed';
  if (item.status == 'reconciliation_required') return 'Action outcome needs review';
  final canonical = switch (item.canonicalStatus) {
    'unverified' => 'Needs verification', 'partial' => 'Partly complete',
    'succeeded' => 'Verified complete', 'blocked' => 'Blocked', 'preview' => 'Preview only', _ => null,
  };
  return canonical ?? switch (item.status) {
    'queued' => 'Queued', 'running' => 'In progress', 'resuming' => 'Continuing',
    'completed' => 'Completed', 'canceled' => 'Stopped',
    'waiting_approval' || 'approval_required' => 'Approval needed',
    'pending' => 'Decision needed', 'waiting_clarification' => 'Reply needed',
    'unread' => 'New', 'read' => 'Read', 'snoozed' => 'Snoozed',
    'dismissed' => 'Dismissed', 'acted' => 'Action recorded', _ => 'Status available',
  };
}

String _summary(ActivityItem item) => switch (item.summary) {
  'The run is in progress.' => 'Working on your request.',
  'The run is resuming.' => 'Continuing your task.',
  'The run failed. Open its source to inspect the result.' => 'Open the task to see what went wrong.',
  'The terminal receipt reports a failed outcome.' => 'The task ended with a failed outcome. Review the details before retrying.',
  'The run completed; its outcome has not been verified.' => 'The response is ready; its outcome still needs verification.',
  'The run ended; its outcome has not been verified.' => 'The task ended; its outcome still needs verification.',
  'The run ended with a partial outcome. Open its source to inspect what remains.' => 'Part of the task finished. Review what remains.',
  'An approved action needs reconciliation. Open the approval to inspect its receipt.' => 'The result of an approved action is uncertain. Review it before trying again.',
  _ => item.summary,
};

String _label(String value) => value.isEmpty ? '' : '${value[0].toUpperCase()}${value.substring(1).replaceAll('_', ' ')}';
String _time(BuildContext context, DateTime value) {
  final date = value.toLocal();
  final now = DateTime.now();
  final local = MaterialLocalizations.of(context);
  final day = DateUtils.isSameDay(date, now) ? 'today'
      : DateUtils.isSameDay(date, now.subtract(const Duration(days: 1))) ? 'yesterday'
      : local.formatShortDate(date);
  return '$day at ${local.formatTimeOfDay(TimeOfDay.fromDateTime(date))}';
}
String _elapsed(Duration duration) {
  final seconds = duration.inSeconds < 1 ? 1 : duration.inSeconds;
  if (seconds < 60) return '${seconds}s';
  final minutes = seconds ~/ 60;
  return minutes < 60 ? '${minutes}m ${seconds % 60}s' : '${minutes ~/ 60}h ${minutes % 60}m';
}
