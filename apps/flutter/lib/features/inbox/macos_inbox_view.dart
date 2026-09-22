import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import 'inbox.dart';

enum _InboxSection { notifications, approvals }

/// A macOS triage workspace that keeps reminders and consequential approvals
/// visibly separate while retaining [InboxController]'s governed mutations.
class MacosInboxView extends StatefulWidget {
  const MacosInboxView({
    super.key,
    required this.controller,
    this.focusApprovalId,
  });

  final InboxController controller;
  final String? focusApprovalId;

  @override
  State<MacosInboxView> createState() => _MacosInboxViewState();
}

class _MacosInboxViewState extends State<MacosInboxView> {
  late _InboxSection _section = widget.focusApprovalId == null
      ? _InboxSection.notifications
      : _InboxSection.approvals;
  late String? _selectedApprovalId = widget.focusApprovalId;
  String? _selectedNotificationId;
  String _notificationFilter = 'all';
  String _approvalFilter = 'all';
  final _searchController = TextEditingController();
  final _searchFocus = FocusNode(debugLabel: 'Search attention inbox');

  @override
  void didUpdateWidget(covariant MacosInboxView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.focusApprovalId != null &&
        widget.focusApprovalId != oldWidget.focusApprovalId) {
      _section = _InboxSection.approvals;
      _selectedApprovalId = widget.focusApprovalId;
    }
  }

  @override
  void dispose() {
    _searchController.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final queue = widget.controller.queue;
      final center = widget.controller.notificationCenter;
      final notifications = _visibleNotifications(
        center?.notifications ?? const [],
      );
      final approvals = _visibleApprovals(queue?.items ?? const []);
      final selectedNotification = _selectedNotification(notifications);
      final selectedApproval = _selectedApproval(approvals);

      return CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.keyR, meta: true):
              widget.controller.refresh,
          const SingleActivator(LogicalKeyboardKey.keyF, meta: true):
              _searchFocus.requestFocus,
          const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
              _moveSelection(notifications, approvals, 1),
          const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
              _moveSelection(notifications, approvals, -1),
        },
        child: Focus(
          autofocus: true,
          child: MacosPageScaffold(
            title: 'Attention Inbox',
            description: 'Triage reminders and review governed actions before they continue.',
            icon: Icons.inbox_outlined,
            actions: [
              IconButton(
                key: const Key('macos-inbox-dispositions'),
                tooltip: 'Delivery decision history',
                onPressed: () => _showDispositionHistory(context),
                icon: Badge.count(
                  count:
                      widget.controller.dispositionHistory?.items.length ?? 0,
                  isLabelVisible:
                      (widget.controller.dispositionHistory?.items.isNotEmpty ??
                      false),
                  child: const Icon(Icons.rule_folder_outlined),
                ),
              ),
              if (widget.controller.loading)
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 8),
                  child: SizedBox.square(
                    dimension: 15,
                    child: CircularProgressIndicator(strokeWidth: 1.8),
                  ),
                ),
              IconButton(
                key: const Key('macos-inbox-refresh'),
                tooltip: 'Refresh inbox (⌘R)',
                onPressed: widget.controller.loading
                    ? null
                    : widget.controller.refresh,
                icon: const Icon(Icons.refresh_rounded),
              ),
            ],
            toolbar: _InboxToolbar(
              section: _section,
              notificationCount: center?.notifications.length ?? 0,
              approvalCount: queue?.items.length ?? 0,
              currentFilter: _section == _InboxSection.notifications
                  ? _notificationFilter
                  : _approvalFilter,
              searchController: _searchController,
              searchFocus: _searchFocus,
              onSearch: (_) => setState(() {}),
              onSectionChanged: (value) => setState(() => _section = value),
              onFilterChanged: (value) => setState(() {
                if (_section == _InboxSection.notifications) {
                  _notificationFilter = value;
                } else {
                  _approvalFilter = value;
                }
              }),
            ),
            inspector: _section == _InboxSection.notifications
                ? _NotificationInspector(
                    notification: selectedNotification,
                    busy:
                        selectedNotification != null &&
                        widget.controller.updatingNotifications.contains(
                          selectedNotification.id,
                        ),
                    onAction: selectedNotification == null
                        ? null
                        : (action, {snoozeMinutes}) =>
                              widget.controller.updateNotification(
                                selectedNotification,
                                action,
                                snoozeMinutes: snoozeMinutes,
                              ),
                  )
                : _ApprovalInspector(
                    key: ValueKey(selectedApproval?.id),
                    item: selectedApproval,
                    busy:
                        selectedApproval != null &&
                        widget.controller.deciding.contains(
                          selectedApproval.id,
                        ),
                    onDecision: selectedApproval == null
                        ? null
                        : (approve, reason) => widget.controller.decide(
                            selectedApproval,
                            approve,
                            reason: reason,
                          ),
                  ),
            inspectorWidth: 410,
            inspectorMinWidth: 340,
            inspectorMaxWidth: 540,
            body: _InboxBody(
              controller: widget.controller,
              section: _section,
              queue: queue,
              center: center,
              notifications: notifications,
              approvals: approvals,
              selectedNotificationId: selectedNotification?.id,
              selectedApprovalId: selectedApproval?.id,
              onSelectNotification: (item) =>
                  setState(() => _selectedNotificationId = item.id),
              onSelectApproval: (item) =>
                  setState(() => _selectedApprovalId = item.id),
            ),
          ),
        ),
      );
    },
  );

  List<PersonalNotification> _visibleNotifications(
    List<PersonalNotification> values,
  ) {
    final query = _searchController.text.trim().toLowerCase();
    return values
        .where((item) {
          final matchesFilter = switch (_notificationFilter) {
            'unread' => item.isUnread,
            'overdue' => item.isOverdue,
            _ => true,
          };
          return matchesFilter &&
              (query.isEmpty || item.title.toLowerCase().contains(query));
        })
        .toList(growable: false);
  }

  List<ApprovalItem> _visibleApprovals(List<ApprovalItem> values) {
    final query = _searchController.text.trim().toLowerCase();
    final visible = values.where((item) {
      final matchesFilter =
          _approvalFilter == 'all' || item.kind == _approvalFilter;
      final matchesSearch =
          query.isEmpty ||
          item.title.toLowerCase().contains(query) ||
          (item.reason?.toLowerCase().contains(query) ?? false);
      return matchesFilter && matchesSearch;
    }).toList();
    visible.sort((left, right) {
      if (left.id == widget.focusApprovalId) return -1;
      if (right.id == widget.focusApprovalId) return 1;
      final leftAt = left.createdAt ?? DateTime.fromMillisecondsSinceEpoch(0);
      final rightAt = right.createdAt ?? DateTime.fromMillisecondsSinceEpoch(0);
      return rightAt.compareTo(leftAt);
    });
    return visible;
  }

  PersonalNotification? _selectedNotification(
    List<PersonalNotification> values,
  ) {
    if (values.isEmpty) return null;
    for (final item in values) {
      if (item.id == _selectedNotificationId) return item;
    }
    return values.first;
  }

  ApprovalItem? _selectedApproval(List<ApprovalItem> values) {
    if (values.isEmpty) return null;
    for (final item in values) {
      if (item.id == _selectedApprovalId) return item;
    }
    return values.first;
  }

  void _moveSelection(
    List<PersonalNotification> notifications,
    List<ApprovalItem> approvals,
    int delta,
  ) {
    if (_section == _InboxSection.notifications) {
      if (notifications.isEmpty) return;
      final current = notifications.indexWhere(
        (item) => item.id == _selectedNotificationId,
      );
      final next = current < 0
          ? 0
          : (current + delta).clamp(0, notifications.length - 1);
      setState(() => _selectedNotificationId = notifications[next].id);
      return;
    }
    if (approvals.isEmpty) return;
    final current = approvals.indexWhere(
      (item) => item.id == _selectedApprovalId,
    );
    final next = current < 0
        ? 0
        : (current + delta).clamp(0, approvals.length - 1);
    setState(() => _selectedApprovalId = approvals[next].id);
  }

  Future<void> _showDispositionHistory(BuildContext context) =>
      showDialog<void>(
        context: context,
        builder: (_) =>
            _DispositionHistoryDialog(controller: widget.controller),
      );
}

class _DispositionHistoryDialog extends StatelessWidget {
  const _DispositionHistoryDialog({required this.controller});

  final InboxController controller;

  @override
  Widget build(BuildContext context) => Dialog(
    clipBehavior: Clip.antiAlias,
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 880, maxHeight: 720),
      child: ListenableBuilder(
        listenable: controller,
        builder: (context, _) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(22, 20, 12, 14),
                child: Row(
                  children: [
                    const Icon(Icons.rule_folder_outlined),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Delivery decision history',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'Content-free policy outcomes. These records do not contain message content or grant authority.',
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: 'Refresh decisions',
                      onPressed: controller.loading ? null : controller.refresh,
                      icon: const Icon(Icons.refresh_rounded),
                    ),
                    IconButton(
                      tooltip: 'Close',
                      onPressed: () => Navigator.of(context).pop(),
                      icon: const Icon(Icons.close_rounded),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              Expanded(child: _DispositionHistoryBody(controller: controller)),
            ],
          );
        },
      ),
    ),
  );
}

class _DispositionHistoryBody extends StatelessWidget {
  const _DispositionHistoryBody({required this.controller});

  final InboxController controller;

  @override
  Widget build(BuildContext context) {
    final history = controller.dispositionHistory;
    if (controller.loading && history == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (history == null) {
      return MacosEmptyState(
        icon: Icons.cloud_off_outlined,
        title: 'Decision history is unavailable',
        message: controller.dispositionsError == null
            ? 'Refresh to load durable notification policy outcomes.'
            : 'The content-free decision projection could not be loaded.',
        action: FilledButton.tonalIcon(
          onPressed: controller.refresh,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('Retry'),
        ),
      );
    }
    if (history.items.isEmpty) {
      return const MacosEmptyState(
        icon: Icons.rule_folder_outlined,
        title: 'No delivery decisions yet',
        message: 'Send, defer, digest, and suppress outcomes appear after policy evaluation.',
      );
    }
    return Scrollbar(
      child: ListView.separated(
        padding: const EdgeInsets.all(16),
        itemCount: history.items.length,
        separatorBuilder: (_, _) => const SizedBox(height: 9),
        itemBuilder: (context, index) =>
            _DispositionHistoryCard(item: history.items[index]),
      ),
    );
  }
}

class _DispositionHistoryCard extends StatelessWidget {
  const _DispositionHistoryCard({required this.item});

  final NotificationDisposition item;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final evaluated = item.evaluatedAt.toLocal();
    final evaluatedLabel =
        '${MaterialLocalizations.of(context).formatMediumDate(evaluated)} · '
        '${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(evaluated))}';
    return Material(
      color: mac.sidebar,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        side: BorderSide(color: mac.divider),
        borderRadius: BorderRadius.circular(9),
      ),
      child: ExpansionTile(
        tilePadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 3),
        childrenPadding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
        leading: Icon(_dispositionIcon(item.outcome)),
        title: Row(
          children: [
            Text(
              _inboxLabel(item.outcome),
              style: Theme.of(context).textTheme.titleSmall,
            ),
            const SizedBox(width: 8),
            _DispositionPill(label: _inboxLabel(item.state)),
            if (item.mustSend) ...[
              const SizedBox(width: 6),
              const _DispositionPill(label: 'Must send'),
            ],
            if (item.critical) ...[
              const SizedBox(width: 6),
              const _DispositionPill(label: 'Critical'),
            ],
          ],
        ),
        subtitle: Text(
          '${_inboxLabel(item.sourceKind)} · ${item.sourceId} · $evaluatedLabel',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        children: [
          _DispositionField(label: 'Disposition ID', value: item.id),
          _DispositionField(
            label: 'Source',
            value: '${item.sourceKind} / ${item.sourceId}',
          ),
          _DispositionField(label: 'Reason', value: item.reason),
          _DispositionField(
            label: 'Lifecycle revision',
            value: '${item.lifecycleRevision}',
          ),
          _DispositionField(
            label: 'Policy SHA-256',
            value: item.policySha256,
            monospace: true,
          ),
          _DispositionField(
            label: 'Occurrence SHA-256',
            value: item.occurrenceSha256,
            monospace: true,
          ),
          _DispositionField(
            label: 'Candidate SHA-256',
            value: item.candidateSha256,
            monospace: true,
          ),
          _DispositionField(
            label: 'Decision receipt SHA-256',
            value: item.decisionReceiptSha256,
            monospace: true,
          ),
          if (item.digestDeliveryId != null)
            _DispositionField(
              label: 'Digest delivery ID',
              value: item.digestDeliveryId!,
            ),
          if (item.deliveryKind != null)
            _DispositionField(
              label: 'Delivery binding',
              value:
                  '${item.deliveryKind} / ${item.deliveryBindingSha256 ?? 'digest unavailable'}',
              monospace: item.deliveryBindingSha256 != null,
            ),
          const SizedBox(height: 7),
          Row(
            children: [
              Icon(
                Icons.verified_user_outlined,
                size: 15,
                color: Theme.of(context).colorScheme.primary,
              ),
              const SizedBox(width: 6),
              const Expanded(
                child: Text('Content excluded · decision grants no authority'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _DispositionPill extends StatelessWidget {
  const _DispositionPill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.primaryContainer,
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(label, style: Theme.of(context).textTheme.labelSmall),
  );
}

class _DispositionField extends StatelessWidget {
  const _DispositionField({
    required this.label,
    required this.value,
    this.monospace = false,
  });

  final String label;
  final String value;
  final bool monospace;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 7),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 154,
          child: Text(label, style: Theme.of(context).textTheme.labelSmall),
        ),
        Expanded(
          child: SelectableText(
            value,
            style: monospace
                ? Theme.of(context).textTheme.bodySmall
                      ?.copyWith(fontFamily: 'monospace')
                : Theme.of(context).textTheme.bodySmall,
          ),
        ),
      ],
    ),
  );
}

IconData _dispositionIcon(String outcome) => switch (outcome) {
  'send' => Icons.send_outlined,
  'defer' => Icons.schedule_send_outlined,
  'digest' => Icons.view_agenda_outlined,
  'suppress' => Icons.notifications_off_outlined,
  _ => Icons.rule_folder_outlined,
};

class _InboxToolbar extends StatelessWidget {
  const _InboxToolbar({
    required this.section,
    required this.notificationCount,
    required this.approvalCount,
    required this.currentFilter,
    required this.searchController,
    required this.searchFocus,
    required this.onSearch,
    required this.onSectionChanged,
    required this.onFilterChanged,
  });

  final _InboxSection section;
  final int notificationCount;
  final int approvalCount;
  final String currentFilter;
  final TextEditingController searchController;
  final FocusNode searchFocus;
  final ValueChanged<String> onSearch;
  final ValueChanged<_InboxSection> onSectionChanged;
  final ValueChanged<String> onFilterChanged;

  @override
  Widget build(BuildContext context) {
    final filters = section == _InboxSection.notifications
        ? const {
            'all': 'All reminders',
            'unread': 'Unread',
            'overdue': 'Overdue',
          }
        : const {
            'all': 'All approvals',
            'tool': 'Tools',
            'workflow': 'Workflows',
            'slo_policy': 'Policies',
          };
    return LayoutBuilder(
      builder: (context, constraints) {
        final compact = constraints.maxWidth < 900;
        final search = TextField(
          controller: searchController,
          focusNode: searchFocus,
          onChanged: onSearch,
          decoration: const InputDecoration(
            prefixIcon: Icon(Icons.search_rounded, size: 17),
            hintText: 'Search inbox  ⌘F',
          ),
        );
        return Row(
          children: [
            SegmentedButton<_InboxSection>(
              showSelectedIcon: false,
              segments: [
                ButtonSegment(
                  value: _InboxSection.notifications,
                  icon: const Icon(Icons.notifications_none_rounded, size: 16),
                  label: Text(
                    compact
                        ? 'Notices  $notificationCount'
                        : 'Notifications  $notificationCount',
                  ),
                ),
                ButtonSegment(
                  value: _InboxSection.approvals,
                  icon: const Icon(Icons.gavel_outlined, size: 16),
                  label: Text('Approvals  $approvalCount'),
                ),
              ],
              selected: {section},
              onSelectionChanged: (value) => onSectionChanged(value.single),
            ),
            const SizedBox(width: 10),
            SizedBox(
              width: compact ? 150 : 220,
              child: DropdownButtonFormField<String>(
                key: ValueKey('${section.name}:$currentFilter'),
                initialValue: currentFilter,
                isDense: true,
                isExpanded: true,
                decoration: InputDecoration(
                  prefixIcon: compact
                      ? null
                      : const Icon(Icons.filter_list_rounded, size: 16),
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 6,
                  ),
                ),
                items: [
                  for (final entry in filters.entries)
                    DropdownMenuItem(
                      value: entry.key,
                      child: Text(entry.value),
                    ),
                ],
                onChanged: (value) {
                  if (value != null) onFilterChanged(value);
                },
              ),
            ),
            const SizedBox(width: 10),
            if (compact)
              Expanded(child: search)
            else ...[
              const Spacer(),
              SizedBox(width: 250, child: search),
            ],
          ],
        );
      },
    );
  }
}

class _InboxBody extends StatelessWidget {
  const _InboxBody({
    required this.controller,
    required this.section,
    required this.queue,
    required this.center,
    required this.notifications,
    required this.approvals,
    required this.selectedNotificationId,
    required this.selectedApprovalId,
    required this.onSelectNotification,
    required this.onSelectApproval,
  });

  final InboxController controller;
  final _InboxSection section;
  final ApprovalQueue? queue;
  final NotificationCenter? center;
  final List<PersonalNotification> notifications;
  final List<ApprovalItem> approvals;
  final String? selectedNotificationId;
  final String? selectedApprovalId;
  final ValueChanged<PersonalNotification> onSelectNotification;
  final ValueChanged<ApprovalItem> onSelectApproval;

  @override
  Widget build(BuildContext context) {
    if (controller.loading && !controller.hasData) {
      return const MacosLoadingList(rows: 9);
    }
    if (controller.hasLoadError && !controller.hasData) {
      return MacosEmptyState(
        icon: Icons.cloud_off_outlined,
        title: 'The attention inbox is unavailable',
        message: 'Reconnect to load reminders and approval requests.',
        action: FilledButton.tonalIcon(
          onPressed: controller.refresh,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('Reconnect'),
        ),
      );
    }

    return Column(
      children: [
        if (controller.hasLoadError || controller.actionError != null)
          _InboxNotice(
            stale: controller.hasData && controller.hasLoadError,
            onRetry: controller.refresh,
          ),
        if (section == _InboxSection.notifications)
          _NotificationSummary(
            center: center,
            onReadAll: controller.readAllNotifications,
          )
        else
          _ApprovalSummary(queue: queue),
        _InboxColumnHeader(section: section),
        Expanded(
          child: section == _InboxSection.notifications
              ? notifications.isEmpty
                    ? const MacosEmptyState(
                        icon: Icons.notifications_none_rounded,
                        title: 'No notifications in this view',
                        message: 'Change the filter or refresh to check for new reminders.',
                      )
                    : _ManagedScrollbar(
                        builder: (scrollController) => ListView.builder(
                          controller: scrollController,
                          padding: const EdgeInsets.fromLTRB(8, 5, 8, 20),
                          itemCount: notifications.length,
                          itemBuilder: (context, index) {
                            final item = notifications[index];
                            return _NotificationRow(
                              key: Key('macos-inbox-notification-${item.id}'),
                              notification: item,
                              selected: item.id == selectedNotificationId,
                              busy: controller.updatingNotifications.contains(
                                item.id,
                              ),
                              onTap: () => onSelectNotification(item),
                            );
                          },
                        ),
                      )
              : approvals.isEmpty
              ? const MacosEmptyState(
                  icon: Icons.verified_user_outlined,
                  title: 'No approvals in this view',
                  message:
                      'Nothing matching this filter is waiting for a decision.',
                )
              : _ManagedScrollbar(
                  builder: (scrollController) => ListView.builder(
                    controller: scrollController,
                    padding: const EdgeInsets.fromLTRB(8, 5, 8, 20),
                    itemCount: approvals.length,
                    itemBuilder: (context, index) {
                      final item = approvals[index];
                      return _ApprovalRow(
                        key: Key('macos-inbox-approval-${item.id}'),
                        item: item,
                        selected: item.id == selectedApprovalId,
                        busy: controller.deciding.contains(item.id),
                        onTap: () => onSelectApproval(item),
                      );
                    },
                  ),
                ),
        ),
      ],
    );
  }
}

class _InboxNotice extends StatelessWidget {
  const _InboxNotice({required this.stale, required this.onRetry});

  final bool stale;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
    color: Theme.of(context).colorScheme.errorContainer,
    child: Row(
      children: [
        const Icon(Icons.cloud_off_outlined, size: 16),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            stale
                ? 'Some sources are unavailable. Showing the last available inbox.'
                : 'An inbox action failed. Your previous state is unchanged.',
          ),
        ),
        TextButton(onPressed: onRetry, child: const Text('Retry')),
      ],
    ),
  );
}

class _NotificationSummary extends StatelessWidget {
  const _NotificationSummary({required this.center, required this.onReadAll});

  final NotificationCenter? center;
  final VoidCallback onReadAll;

  @override
  Widget build(BuildContext context) {
    final value = center;
    return Container(
      constraints: const BoxConstraints(minHeight: 48),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          _SummaryFact(value: '${value?.unreadCount ?? 0}', label: 'unread'),
          const SizedBox(width: 22),
          if (value?.quietHoursActive ?? false) ...[
            const Icon(Icons.bedtime_outlined, size: 16),
            const SizedBox(width: 6),
            Text(
              'Quiet hours active',
              style: Theme.of(context).textTheme.labelMedium,
            ),
          ] else if (value != null)
            Text(
              'Generated ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(value.generatedAt.toLocal()))}',
              style: Theme.of(context).textTheme.labelSmall,
            ),
          const Spacer(),
          if ((value?.unreadCount ?? 0) > 0)
            TextButton.icon(
              key: const Key('macos-inbox-read-all'),
              onPressed: onReadAll,
              icon: const Icon(Icons.done_all_rounded, size: 16),
              label: const Text('Mark all read'),
            ),
        ],
      ),
    );
  }
}

class _ApprovalSummary extends StatelessWidget {
  const _ApprovalSummary({required this.queue});

  final ApprovalQueue? queue;

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(minHeight: 48),
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
    child: Row(
      children: [
        _SummaryFact(value: '${queue?.tools ?? 0}', label: 'tools'),
        const SizedBox(width: 22),
        _SummaryFact(value: '${queue?.workflows ?? 0}', label: 'workflows'),
        const SizedBox(width: 22),
        _SummaryFact(value: '${queue?.sloPolicies ?? 0}', label: 'policies'),
        const Spacer(),
        const Icon(Icons.shield_outlined, size: 15),
        const SizedBox(width: 6),
        Text(
          'Actions remain stopped until reviewed',
          style: Theme.of(context).textTheme.labelSmall,
        ),
      ],
    ),
  );
}

class _SummaryFact extends StatelessWidget {
  const _SummaryFact({required this.value, required this.label});

  final String value;
  final String label;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Text(value, style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(width: 5),
      Text(label, style: Theme.of(context).textTheme.labelSmall),
    ],
  );
}

class _InboxColumnHeader extends StatelessWidget {
  const _InboxColumnHeader({required this.section});

  final _InboxSection section;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return LayoutBuilder(
      builder: (context, constraints) => Container(
        height: 31,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        decoration: BoxDecoration(
          color: mac.toolbar,
          border: Border.symmetric(horizontal: BorderSide(color: mac.divider)),
        ),
        child: Row(
          children: [
            SizedBox(
              width: 94,
              child: Text(
                section == _InboxSection.notifications ? 'DUE' : 'REQUESTED',
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ),
            Expanded(
              child: Text(
                section == _InboxSection.notifications
                    ? 'NOTIFICATION'
                    : 'ACTION',
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ),
            if (constraints.maxWidth >= 630)
              SizedBox(
                width: 110,
                child: Text(
                  section == _InboxSection.notifications ? 'URGENCY' : 'KIND',
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              ),
            SizedBox(
              width: 92,
              child: Text(
                section == _InboxSection.notifications ? 'STATE' : 'RISK',
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _NotificationRow extends StatelessWidget {
  const _NotificationRow({
    super.key,
    required this.notification,
    required this.selected,
    required this.busy,
    required this.onTap,
  });

  final PersonalNotification notification;
  final bool selected;
  final bool busy;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final due = notification.dueAt.toLocal();
    final dueLabel =
        '${MaterialLocalizations.of(context).formatMediumDate(due)}\n${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(due))}';
    final accent = notification.isOverdue
        ? Theme.of(context).colorScheme.error
        : Theme.of(context).colorScheme.primary;
    return LayoutBuilder(
      builder: (context, constraints) => AnimatedOpacity(
        opacity: busy ? .58 : 1,
        duration: const Duration(milliseconds: 140),
        child: Material(
          color: selected ? mac.selection : Colors.transparent,
          borderRadius: BorderRadius.circular(7),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(7),
            child: Container(
              constraints: const BoxConstraints(minHeight: 54),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              decoration: BoxDecoration(
                border: Border(left: BorderSide(color: accent, width: 3)),
              ),
              child: Row(
                children: [
                  SizedBox(
                    width: 94,
                    child: Text(
                      dueLabel,
                      style: Theme.of(context).textTheme.labelSmall,
                    ),
                  ),
                  Expanded(
                    child: Row(
                      children: [
                        if (notification.isUnread) ...[
                          Icon(Icons.circle, size: 7, color: accent),
                          const SizedBox(width: 7),
                        ],
                        Expanded(
                          child: Text(
                            notification.title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.bodyMedium
                                ?.copyWith(
                                  fontWeight: notification.isUnread
                                      ? FontWeight.w600
                                      : FontWeight.w400,
                                ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (constraints.maxWidth >= 630)
                    SizedBox(
                      width: 110,
                      child: Text(
                        _inboxLabel(notification.urgency),
                        style: Theme.of(context).textTheme.labelMedium
                            ?.copyWith(color: accent),
                      ),
                    ),
                  SizedBox(
                    width: 92,
                    child: Text(
                      _inboxLabel(notification.status),
                      style: Theme.of(context).textTheme.labelSmall,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ApprovalRow extends StatelessWidget {
  const _ApprovalRow({
    super.key,
    required this.item,
    required this.selected,
    required this.busy,
    required this.onTap,
  });

  final ApprovalItem item;
  final bool selected;
  final bool busy;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final created = item.createdAt?.toLocal();
    final createdLabel = created == null
        ? 'Not recorded'
        : '${MaterialLocalizations.of(context).formatMediumDate(created)}\n${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(created))}';
    final accent = _riskColor(context, item.riskLevel);
    return LayoutBuilder(
      builder: (context, constraints) => AnimatedOpacity(
        opacity: busy ? .58 : 1,
        duration: const Duration(milliseconds: 140),
        child: Material(
          color: selected ? mac.selection : Colors.transparent,
          borderRadius: BorderRadius.circular(7),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(7),
            child: Container(
              constraints: const BoxConstraints(minHeight: 58),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              decoration: BoxDecoration(
                border: Border(left: BorderSide(color: accent, width: 3)),
              ),
              child: Row(
                children: [
                  SizedBox(
                    width: 94,
                    child: Text(
                      createdLabel,
                      style: Theme.of(context).textTheme.labelSmall,
                    ),
                  ),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          item.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodyMedium
                              ?.copyWith(fontWeight: FontWeight.w600),
                        ),
                        Text(
                          item.reason?.isNotEmpty ?? false
                              ? item.reason!
                              : 'Human approval required by policy.',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                  if (constraints.maxWidth >= 630)
                    SizedBox(
                      width: 110,
                      child: Text(
                        _kindLabel(item.kind),
                        style: Theme.of(context).textTheme.labelSmall,
                      ),
                    ),
                  SizedBox(
                    width: 92,
                    child: Row(
                      children: [
                        Container(
                          width: 7,
                          height: 7,
                          decoration: BoxDecoration(
                            color: accent,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          'Risk ${item.riskLevel}',
                          style: Theme.of(context).textTheme.labelMedium
                              ?.copyWith(color: accent),
                        ),
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
  }
}

class _NotificationInspector extends StatelessWidget {
  const _NotificationInspector({
    required this.notification,
    required this.busy,
    required this.onAction,
  });

  final PersonalNotification? notification;
  final bool busy;
  final NotificationActionCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final item = notification;
    if (item == null) {
      return const MacosEmptyState(
        icon: Icons.notifications_none_rounded,
        title: 'Select a notification',
        message: 'Its due time and available actions appear here.',
      );
    }
    final accent = item.isOverdue
        ? Theme.of(context).colorScheme.error
        : Theme.of(context).colorScheme.primary;
    final due = item.dueAt.toLocal();
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 22, 20, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'NOTIFICATION',
            style: Theme.of(context).textTheme.labelSmall
                ?.copyWith(color: accent),
          ),
          const SizedBox(height: 9),
          Text(item.title, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 14),
          _InspectorFactLine(
            icon: Icons.schedule_rounded,
            label: 'Due',
            value:
                '${MaterialLocalizations.of(context).formatMediumDate(due)} at ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(due))}',
          ),
          _InspectorFactLine(
            icon: Icons.priority_high_rounded,
            label: 'Urgency',
            value: _inboxLabel(item.urgency),
          ),
          _InspectorFactLine(
            icon: Icons.circle_outlined,
            label: 'State',
            value: _inboxLabel(item.status),
          ),
          if (item.snoozedUntil != null)
            _InspectorFactLine(
              icon: Icons.snooze_rounded,
              label: 'Snoozed until',
              value: MaterialLocalizations.of(context).formatTimeOfDay(
                TimeOfDay.fromDateTime(item.snoozedUntil!.toLocal()),
              ),
            ),
          const Spacer(),
          if (busy) ...[
            const LinearProgressIndicator(),
            const SizedBox(height: 12),
          ],
          Row(
            children: [
              if (item.isUnread)
                Expanded(
                  child: OutlinedButton(
                    key: const Key('macos-notification-read'),
                    onPressed: busy
                        ? null
                        : () => onAction?.call(NotificationAction.read),
                    child: const Text('Mark read'),
                  ),
                ),
              if (item.isUnread) const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  key: const Key('macos-notification-snooze'),
                  onPressed: busy
                      ? null
                      : () => onAction?.call(
                          NotificationAction.snooze,
                          snoozeMinutes: 15,
                        ),
                  icon: const Icon(Icons.snooze_rounded),
                  label: const Text('Snooze 15m'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              key: const Key('macos-notification-complete'),
              onPressed: busy
                  ? null
                  : () => onAction?.call(NotificationAction.complete),
              icon: const Icon(Icons.check_rounded),
              label: const Text('Complete notification'),
            ),
          ),
          const SizedBox(height: 4),
          SizedBox(
            width: double.infinity,
            child: TextButton(
              key: const Key('macos-notification-dismiss'),
              onPressed: busy
                  ? null
                  : () => onAction?.call(NotificationAction.dismiss),
              child: const Text('Dismiss'),
            ),
          ),
        ],
      ),
    );
  }
}

typedef _ApprovalDecision = void Function(bool approve, String? reason);

class _ApprovalInspector extends StatefulWidget {
  const _ApprovalInspector({
    super.key,
    required this.item,
    required this.busy,
    required this.onDecision,
  });

  final ApprovalItem? item;
  final bool busy;
  final _ApprovalDecision? onDecision;

  @override
  State<_ApprovalInspector> createState() => _ApprovalInspectorState();
}

class _ApprovalInspectorState extends State<_ApprovalInspector> {
  final _reasonController = TextEditingController();
  final _scrollController = ScrollController();

  @override
  void dispose() {
    _reasonController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    if (item == null) {
      return const MacosEmptyState(
        icon: Icons.gavel_outlined,
        title: 'Select an approval',
        message: 'Review what will happen, reversibility, and exact inputs before deciding.',
      );
    }
    final accent = _riskColor(context, item.riskLevel);
    final mac = MacosThemeColors.of(context);
    return Column(
      children: [
        Expanded(
          child: Scrollbar(
            controller: _scrollController,
            child: ListView(
              controller: _scrollController,
              padding: const EdgeInsets.fromLTRB(20, 22, 20, 20),
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        'GOVERNED ACTION',
                        style: Theme.of(context).textTheme.labelSmall
                            ?.copyWith(color: accent),
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: accent.withValues(alpha: .12),
                        borderRadius: BorderRadius.circular(5),
                      ),
                      child: Text(
                        'Risk ${item.riskLevel}',
                        style: Theme.of(context).textTheme.labelMedium
                            ?.copyWith(color: accent),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  item.title,
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: 5),
                Text(
                  '${_kindLabel(item.kind)} · ${_inboxLabel(item.status)}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 20),
                _ConsentFact(
                  title: 'If you approve',
                  value: _whatWillHappen(item),
                  icon: Icons.play_arrow_rounded,
                ),
                _ConsentFact(
                  title: 'Reversibility',
                  value: _reversibility(item.riskLevel),
                  icon: Icons.history_rounded,
                ),
                _ConsentFact(
                  title: 'Why it is waiting',
                  value:
                      item.reason ??
                      'This action requires human approval by policy.',
                  icon: Icons.pause_circle_outline_rounded,
                ),
                if (item.input.isNotEmpty) ...[
                  const SizedBox(height: 20),
                  Text(
                    'Exact inputs',
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  const SizedBox(height: 3),
                  Text(
                    'Secrets are redacted by the approval service.',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  const SizedBox(height: 8),
                  _ExactInputs(input: item.input),
                ],
              ],
            ),
          ),
        ),
        Container(
          padding: const EdgeInsets.fromLTRB(16, 11, 16, 14),
          decoration: BoxDecoration(
            color: mac.sidebar,
            border: Border(top: BorderSide(color: mac.divider)),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                key: const Key('macos-approval-note'),
                controller: _reasonController,
                maxLength: 1000,
                maxLines: 2,
                decoration: const InputDecoration(
                  labelText: 'Decision note',
                  hintText: 'Optional note recorded in the audit trail',
                  alignLabelWithHint: true,
                ),
              ),
              if (widget.busy) ...[
                const LinearProgressIndicator(),
                const SizedBox(height: 10),
              ],
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      key: const Key('macos-approval-reject'),
                      onPressed: widget.busy
                          ? null
                          : () => widget.onDecision?.call(false, _reason),
                      icon: const Icon(Icons.close_rounded),
                      label: const Text('Reject'),
                    ),
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: FilledButton.icon(
                      key: const Key('macos-approval-approve'),
                      onPressed: widget.busy
                          ? null
                          : () => widget.onDecision?.call(true, _reason),
                      icon: const Icon(Icons.check_rounded),
                      label: const Text('Approve and run'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  String? get _reason {
    final value = _reasonController.text.trim();
    return value.isEmpty ? null : value;
  }
}

class _ConsentFact extends StatelessWidget {
  const _ConsentFact({
    required this.title,
    required this.value,
    required this.icon,
  });

  final String title;
  final String value;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: mac.hover,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: mac.divider),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 17),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.labelMedium),
                const SizedBox(height: 3),
                Text(value, style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ExactInputs extends StatelessWidget {
  const _ExactInputs({required this.input});

  final Json input;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      constraints: const BoxConstraints(maxHeight: 240),
      width: double.infinity,
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: mac.canvas,
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: mac.divider),
      ),
      child: SingleChildScrollView(
        child: SelectableText(
          const JsonEncoder.withIndent('  ').convert(input),
          style: Theme.of(context).textTheme.bodySmall
              ?.copyWith(fontFamily: 'Menlo', height: 1.45),
        ),
      ),
    );
  }
}

class _InspectorFactLine extends StatelessWidget {
  const _InspectorFactLine({
    required this.icon,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 11),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 16),
        const SizedBox(width: 8),
        SizedBox(
          width: 74,
          child: Text(label, style: Theme.of(context).textTheme.labelSmall),
        ),
        Expanded(child: Text(value)),
      ],
    ),
  );
}

String _whatWillHappen(ApprovalItem item) {
  if (item.kind == 'tool') {
    return 'The ${item.title} tool executes for real with the inputs below, and the output is recorded in the tool audit ledger.';
  }
  if (item.kind == 'workflow') {
    return 'The workflow resumes. Exact reviewed reversible actions receive short-lived, budgeted plan grants; dynamic or changed targets still pause for their own approval.';
  }
  return 'The monitoring policy change is applied and starts affecting SLO evaluation, incidents, and alerts.';
}

String _reversibility(int riskLevel) {
  if (riskLevel <= 1) {
    return 'Low impact. It writes to internal stores that can be edited or removed afterwards.';
  }
  if (riskLevel == 2) {
    return 'Side-effecting. It may reach external systems and may not be reversible. Review the inputs first.';
  }
  return 'High impact. It requires two distinct admin approvals, and the requester cannot approve their own request.';
}

String _kindLabel(String kind) => switch (kind) {
  'tool' => 'Tool call',
  'workflow' => 'Workflow gate',
  'slo_policy' => 'SLO policy',
  _ => _inboxLabel(kind),
};

String _inboxLabel(String value) => value
    .replaceAll('_', ' ')
    .split(' ')
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');

Color _riskColor(BuildContext context, int level) {
  final mac = MacosThemeColors.of(context);
  if (level <= 1) return mac.positive;
  if (level == 2) return mac.warning;
  return Theme.of(context).colorScheme.error;
}

class _ManagedScrollbar extends StatefulWidget {
  const _ManagedScrollbar({required this.builder});

  final Widget Function(ScrollController controller) builder;

  @override
  State<_ManagedScrollbar> createState() => _ManagedScrollbarState();
}

class _ManagedScrollbarState extends State<_ManagedScrollbar> {
  final _controller = ScrollController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      Scrollbar(controller: _controller, child: widget.builder(_controller));
}
