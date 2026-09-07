import 'package:flutter/material.dart';

typedef Json = Map<String, dynamic>;

class ApprovalItem {
  const ApprovalItem({
    required this.id,
    required this.kind,
    required this.title,
    required this.status,
    required this.riskLevel,
    required this.input,
    this.reason,
    this.createdAt,
  });
  final String id, kind, title, status;
  final int riskLevel;
  final Json input;
  final String? reason;
  final DateTime? createdAt;
  factory ApprovalItem.fromJson(Json j) => ApprovalItem(
    id: j['id'] as String,
    kind: j['kind'] as String,
    title: j['title'] as String? ?? 'Approval',
    status: j['status'] as String? ?? 'pending',
    riskLevel: j['riskLevel'] as int? ?? 1,
    input: j['input'] is Json ? j['input'] as Json : <String, dynamic>{},
    reason: j['reason'] as String?,
    createdAt: DateTime.tryParse(j['createdAt'] as String? ?? ''),
  );
}

class ApprovalQueue {
  const ApprovalQueue({
    required this.items,
    required this.tools,
    required this.workflows,
    required this.sloPolicies,
  });
  final List<ApprovalItem> items;
  final int tools, workflows, sloPolicies;
  factory ApprovalQueue.fromJson(Json j) {
    final stats = j['stats'] is Json ? j['stats'] as Json : <String, dynamic>{};
    return ApprovalQueue(
      items: ((j['items'] as List?) ?? const [])
          .whereType<Json>()
          .map(ApprovalItem.fromJson)
          .toList(),
      tools: stats['tools'] as int? ?? 0,
      workflows: stats['workflows'] as int? ?? 0,
      sloPolicies: stats['sloPolicies'] as int? ?? 0,
    );
  }
}

abstract interface class InboxRepository {
  Future<ApprovalQueue> loadApprovals();
  Future<NotificationCenter> loadNotifications();
  Future<void> decide(
    ApprovalItem item, {
    required bool approve,
    String? reason,
    bool breakGlass = false,
    String? ticket,
  });
  Future<void> updateNotification(
    PersonalNotification notification,
    NotificationAction action, {
    int? snoozeMinutes,
  });
  Future<void> readAllNotifications();
}

enum NotificationAction { read, dismiss, snooze, complete }

extension NotificationActionApi on NotificationAction {
  String get apiValue => name;
}

class PersonalNotification {
  const PersonalNotification({
    required this.id,
    required this.title,
    required this.status,
    required this.urgency,
    required this.dueAt,
    this.snoozedUntil,
  });

  final String id, title, status, urgency;
  final DateTime dueAt;
  final DateTime? snoozedUntil;

  bool get isUnread => status == 'unread';
  bool get isOverdue => urgency == 'overdue';

  factory PersonalNotification.fromJson(Json json) {
    final id = json['id'];
    final title = json['title'];
    final dueAt = DateTime.tryParse(json['dueAt'] as String? ?? '');
    if (id is! String || title is! String || dueAt == null) {
      throw const FormatException('Notification response is invalid.');
    }
    return PersonalNotification(
      id: id,
      title: title,
      status: json['status'] as String? ?? 'unread',
      urgency: json['urgency'] as String? ?? 'due_soon',
      dueAt: dueAt,
      snoozedUntil: DateTime.tryParse(json['snoozedUntil'] as String? ?? ''),
    );
  }
}

class NotificationCenter {
  const NotificationCenter({
    required this.notifications,
    required this.unreadCount,
    required this.quietHoursActive,
    required this.generatedAt,
  });

  final List<PersonalNotification> notifications;
  final int unreadCount;
  final bool quietHoursActive;
  final DateTime generatedAt;

  factory NotificationCenter.fromJson(Json json) => NotificationCenter(
    notifications: ((json['notifications'] as List?) ?? const [])
        .whereType<Json>()
        .map(PersonalNotification.fromJson)
        .toList(growable: false),
    unreadCount: json['unreadCount'] as int? ?? 0,
    quietHoursActive: json['quietHoursActive'] as bool? ?? false,
    generatedAt:
        DateTime.tryParse(json['generatedAt'] as String? ?? '') ??
        DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
  );
}

class InboxController extends ChangeNotifier {
  InboxController(this.repository);
  final InboxRepository repository;
  ApprovalQueue? queue;
  NotificationCenter? notificationCenter;
  Object? approvalsError;
  Object? notificationsError;
  Object? actionError;
  bool loading = false;
  final Set<String> deciding = {};
  final Set<String> updatingNotifications = {};

  bool get hasData => queue != null || notificationCenter != null;
  bool get hasLoadError => approvalsError != null || notificationsError != null;

  Future<void> refresh() async {
    loading = true;
    approvalsError = null;
    notificationsError = null;
    actionError = null;
    notifyListeners();
    await Future.wait([_loadApprovals(), _loadNotifications()]);
    loading = false;
    notifyListeners();
  }

  Future<void> _loadApprovals() async {
    try {
      queue = await repository.loadApprovals();
    } catch (error) {
      approvalsError = error;
    }
  }

  Future<void> _loadNotifications() async {
    try {
      notificationCenter = await repository.loadNotifications();
    } catch (error) {
      notificationsError = error;
    }
  }

  Future<void> decide(ApprovalItem item, bool approve, {String? reason}) async {
    deciding.add(item.id);
    notifyListeners();
    try {
      await repository.decide(item, approve: approve, reason: reason);
      await refresh();
    } catch (e) {
      actionError = e;
    } finally {
      deciding.remove(item.id);
      notifyListeners();
    }
  }

  Future<void> updateNotification(
    PersonalNotification notification,
    NotificationAction action, {
    int? snoozeMinutes,
  }) async {
    updatingNotifications.add(notification.id);
    actionError = null;
    notifyListeners();
    try {
      await repository.updateNotification(
        notification,
        action,
        snoozeMinutes: snoozeMinutes,
      );
      notificationCenter = await repository.loadNotifications();
    } catch (error) {
      actionError = error;
    } finally {
      updatingNotifications.remove(notification.id);
      notifyListeners();
    }
  }

  Future<void> readAllNotifications() async {
    actionError = null;
    notifyListeners();
    try {
      await repository.readAllNotifications();
      notificationCenter = await repository.loadNotifications();
    } catch (error) {
      actionError = error;
    } finally {
      notifyListeners();
    }
  }
}

class InboxView extends StatelessWidget {
  const InboxView({super.key, required this.controller});
  final InboxController controller;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (_, _) {
      final q = controller.queue;
      final notifications = controller.notificationCenter;
      if (controller.loading && !controller.hasData) {
        return const _InboxSkeleton();
      }
      if (controller.hasLoadError && !controller.hasData) {
        return Center(
          child: FilledButton.tonal(
            onPressed: controller.refresh,
            child: const Text('Reconnect inbox'),
          ),
        );
      }
      return RefreshIndicator(
        onRefresh: controller.refresh,
        child: CustomScrollView(
          slivers: [
            SliverAppBar.large(
              title: const Text('Attention inbox'),
              actions: [
                IconButton(
                  onPressed: controller.refresh,
                  tooltip: 'Refresh inbox',
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ],
            ),
            if (controller.hasLoadError || controller.actionError != null)
              SliverToBoxAdapter(
                child: _InboxNotice(
                  stale: controller.hasData && controller.hasLoadError,
                  onRetry: controller.refresh,
                ),
              ),
            if (notifications != null) ...[
              SliverToBoxAdapter(
                child: _SectionHeader(
                  title: 'Notifications',
                  count: notifications.unreadCount,
                  trailing: notifications.unreadCount > 0
                      ? TextButton(
                          onPressed: controller.readAllNotifications,
                          child: const Text('Mark all read'),
                        )
                      : null,
                ),
              ),
              if (notifications.quietHoursActive)
                const SliverToBoxAdapter(
                  child: Padding(
                    padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
                    child: Text('Quiet hours are active.'),
                  ),
                ),
              SliverList.builder(
                itemCount: notifications.notifications.length,
                itemBuilder: (_, index) {
                  final item = notifications.notifications[index];
                  return NotificationCard(
                    notification: item,
                    busy: controller.updatingNotifications.contains(item.id),
                    onAction: (action, {snoozeMinutes}) =>
                        controller.updateNotification(
                          item,
                          action,
                          snoozeMinutes: snoozeMinutes,
                        ),
                  );
                },
              ),
            ],
            SliverToBoxAdapter(
              child: _SectionHeader(
                title: 'Approvals',
                count: q?.items.length ?? 0,
              ),
            ),
            if (q != null && q.items.isNotEmpty)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 18),
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      _QueueChip(
                        icon: Icons.build_outlined,
                        label: '${q.tools} tools',
                      ),
                      _QueueChip(
                        icon: Icons.account_tree_outlined,
                        label: '${q.workflows} workflows',
                      ),
                      _QueueChip(
                        icon: Icons.monitor_heart_outlined,
                        label: '${q.sloPolicies} policies',
                      ),
                    ],
                  ),
                ),
              ),
            if ((q == null || q.items.isEmpty) &&
                (notifications == null || notifications.notifications.isEmpty))
              SliverFillRemaining(
                child: Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        Icons.verified_user_outlined,
                        size: 48,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        'Nothing needs your attention',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Approvals and time-sensitive reminders will appear here.',
                      ),
                    ],
                  ),
                ),
              )
            else if (q != null && q.items.isNotEmpty)
              SliverPadding(
                padding: const EdgeInsets.only(bottom: 32),
                sliver: SliverList.builder(
                  itemCount: q.items.length,
                  itemBuilder: (_, i) => ApprovalCard(
                    item: q.items[i],
                    busy: controller.deciding.contains(q.items[i].id),
                    onDecision: (value) => controller.decide(q.items[i], value),
                  ),
                ),
              ),
          ],
        ),
      );
    },
  );
}

class _InboxNotice extends StatelessWidget {
  const _InboxNotice({required this.stale, required this.onRetry});
  final bool stale;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.fromLTRB(16, 0, 16, 14),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.errorContainer,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Row(
      children: [
        const Icon(Icons.cloud_off_outlined),
        const SizedBox(width: 10),
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

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.title,
    required this.count,
    this.trailing,
  });
  final String title;
  final int count;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
    child: Row(
      children: [
        Expanded(
          child: Text(
            '$title · $count',
            style: Theme.of(context).textTheme.titleLarge,
          ),
        ),
        ?trailing,
      ],
    ),
  );
}

typedef NotificationActionCallback = void Function(
  NotificationAction action, {
  int? snoozeMinutes,
});

class NotificationCard extends StatelessWidget {
  const NotificationCard({
    super.key,
    required this.notification,
    required this.busy,
    required this.onAction,
  });
  final PersonalNotification notification;
  final bool busy;
  final NotificationActionCallback onAction;

  @override
  Widget build(BuildContext context) {
    final color = notification.isOverdue
        ? Theme.of(context).colorScheme.error
        : Theme.of(context).colorScheme.primary;
    final due = MaterialLocalizations.of(context)
        .formatMediumDate(notification.dueAt.toLocal());
    return AnimatedOpacity(
      duration: const Duration(milliseconds: 180),
      opacity: busy ? .62 : 1,
      child: Container(
        margin: const EdgeInsets.fromLTRB(16, 0, 16, 10),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerLow,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: color.withValues(alpha: .25)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  notification.isOverdue
                      ? Icons.notification_important_outlined
                      : Icons.notifications_active_outlined,
                  color: color,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    notification.title,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                if (notification.isUnread)
                  Icon(Icons.circle, size: 9, color: color),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              notification.isOverdue ? 'Overdue · $due' : 'Due $due',
              style: TextStyle(color: color, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (notification.isUnread)
                  OutlinedButton(
                    onPressed: busy
                        ? null
                        : () => onAction(NotificationAction.read),
                    child: const Text('Mark read'),
                  ),
                OutlinedButton.icon(
                  onPressed: busy
                      ? null
                      : () => onAction(
                          NotificationAction.snooze,
                          snoozeMinutes: 15,
                        ),
                  icon: const Icon(Icons.snooze_rounded),
                  label: const Text('Snooze 15m'),
                ),
                FilledButton.tonal(
                  onPressed: busy
                      ? null
                      : () => onAction(NotificationAction.complete),
                  child: busy
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Complete'),
                ),
                IconButton(
                  tooltip: 'Dismiss notification',
                  onPressed: busy
                      ? null
                      : () => onAction(NotificationAction.dismiss),
                  icon: const Icon(Icons.close_rounded),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _QueueChip extends StatelessWidget {
  const _QueueChip({required this.icon, required this.label});
  final IconData icon;
  final String label;
  @override
  Widget build(BuildContext context) => Chip(
    avatar: Icon(icon, size: 16),
    label: Text(label),
    side: BorderSide.none,
    visualDensity: VisualDensity.compact,
  );
}

class ApprovalCard extends StatelessWidget {
  const ApprovalCard({
    super.key,
    required this.item,
    required this.busy,
    required this.onDecision,
  });
  final ApprovalItem item;
  final bool busy;
  final ValueChanged<bool> onDecision;
  @override
  Widget build(BuildContext context) {
    final color = item.riskLevel >= 3
        ? Theme.of(context).colorScheme.error
        : Theme.of(context).colorScheme.tertiary;
    return AnimatedOpacity(
      duration: const Duration(milliseconds: 180),
      opacity: busy ? .62 : 1,
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerLow,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: color.withValues(alpha: item.riskLevel >= 3 ? .45 : .18),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    item.kind == 'tool'
                        ? Icons.build_outlined
                        : item.kind == 'workflow'
                        ? Icons.account_tree_outlined
                        : Icons.monitor_heart_outlined,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      item.title,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 9,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: .12),
                      borderRadius: BorderRadius.circular(99),
                    ),
                    child: Text(
                      'Risk ${item.riskLevel}',
                      style: TextStyle(
                        color: color,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
              if (item.reason?.isNotEmpty ?? false)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(item.reason!),
                ),
              if (item.input.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(
                    item.input.entries
                        .take(3)
                        .map((e) => '${e.key}: ${e.value}')
                        .join('\n'),
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: busy ? null : () => onDecision(false),
                      child: const Text('Reject action'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton(
                      onPressed: busy ? null : () => onDecision(true),
                      child: busy
                          ? const SizedBox.square(
                              dimension: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('Approve action'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _InboxSkeleton extends StatelessWidget {
  const _InboxSkeleton();
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.fromLTRB(16, 84, 16, 16),
    children: List.generate(
      3,
      (i) => Container(
        height: 178,
        margin: const EdgeInsets.only(bottom: 12),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(14),
        ),
      ),
    ),
  );
}
