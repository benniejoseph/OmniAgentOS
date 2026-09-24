import 'dart:async';

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
  Future<NotificationDispositionHistory> loadNotificationDispositions();
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

class NotificationDispositionHistory {
  const NotificationDispositionHistory({
    required this.version,
    required this.items,
  });

  final String version;
  final List<NotificationDisposition> items;

  factory NotificationDispositionHistory.fromJson(Json json) {
    final version = json['version'];
    if (version != 'notification-disposition-projection:1' ||
        json['contentIncluded'] != false) {
      throw const FormatException(
        'Notification decision history is not a supported content-free projection.',
      );
    }
    final dispositions = json['dispositions'];
    if (dispositions is! List || dispositions.any((item) => item is! Map)) {
      throw const FormatException(
        'Notification decision history must be a list of records.',
      );
    }
    return NotificationDispositionHistory(
      version: version as String,
      items: dispositions
          .cast<Map>()
          .map(
            (item) => NotificationDisposition.fromJson(
              Map<String, dynamic>.from(item),
            ),
          )
          .toList(growable: false),
    );
  }
}

class NotificationDisposition {
  const NotificationDisposition({
    required this.id,
    required this.sourceKind,
    required this.sourceId,
    required this.occurrenceSha256,
    required this.candidateSha256,
    required this.outcome,
    required this.state,
    required this.reason,
    required this.mustSend,
    required this.critical,
    required this.policySha256,
    required this.decisionReceiptSha256,
    required this.evaluatedAt,
    required this.dueAt,
    required this.deliveryKind,
    required this.deliveryBindingSha256,
    required this.digestDeliveryId,
    required this.lifecycleRevision,
    required this.updatedAt,
    required this.terminalAt,
  });

  final String id,
      sourceKind,
      sourceId,
      occurrenceSha256,
      candidateSha256,
      outcome,
      state,
      reason,
      policySha256,
      decisionReceiptSha256,
      updatedAt;
  final bool mustSend, critical;
  final int lifecycleRevision;
  final DateTime evaluatedAt;
  final DateTime? dueAt, terminalAt;
  final String? deliveryKind, deliveryBindingSha256, digestDeliveryId;

  factory NotificationDisposition.fromJson(Json value) {
    if (value['contentIncluded'] != false ||
        value['decisionGrantsAuthority'] != false) {
      throw const FormatException(
        'Notification decision history included content or authority.',
      );
    }
    final id = _requiredDispositionText(value, 'dispositionId');
    final sourceKind = _dispositionChoice(
      value,
      'sourceKind',
      _notificationSourceKinds,
    );
    final outcome = _dispositionChoice(value, 'outcome', _notificationOutcomes);
    final state = _dispositionChoice(value, 'state', _notificationStates);
    final reason = _dispositionChoice(value, 'reason', _notificationReasons);
    final mustSend = _dispositionBool(value, 'mustSend');
    final critical = _dispositionBool(value, 'critical');
    final evaluatedAt = _dispositionTime(value, 'evaluatedAt');
    final dueAt = _nullableDispositionTime(value, 'dueAt');
    final updatedAt = _requiredDispositionText(value, 'updatedAt');
    final updated = _dispositionTime(value, 'updatedAt');
    final terminalAt = _nullableDispositionTime(value, 'terminalAt');
    final digestDeliveryId = _nullableDispositionText(
      value,
      'digestDeliveryId',
    );
    final deliveryKind = _nullableDispositionChoice(
      value,
      'deliveryKind',
      _notificationDeliveryKinds,
    );
    final deliveryBindingSha256 = value['deliveryBindingSha256'] == null
        ? null
        : _dispositionSha(value, 'deliveryBindingSha256');
    final lifecycleRevision = _dispositionRevision(value, 'lifecycleRevision');
    final retryable =
        outcome == 'defer' || (outcome == 'send' && state == 'pending');
    final digestDelivered = outcome == 'digest' && state == 'terminal';
    final directPending = outcome == 'send' && state == 'pending';
    if (!_notificationDispositionId.hasMatch(id) ||
        (state == 'terminal') != (terminalAt != null) ||
        (retryable &&
            (state != 'pending' ||
                dueAt == null ||
                !dueAt.isAfter(evaluatedAt) ||
                dueAt.difference(evaluatedAt) > const Duration(hours: 24))) ||
        (!retryable && dueAt != null) ||
        (outcome == 'digest' &&
            (digestDelivered != (digestDeliveryId != null) ||
                digestDelivered != (deliveryKind == 'digest_ledger') ||
                digestDelivered != (deliveryBindingSha256 != null))) ||
        (outcome != 'digest' && digestDeliveryId != null) ||
        (outcome == 'send' &&
            ((directPending &&
                    (deliveryKind != null || deliveryBindingSha256 != null)) ||
                (!directPending &&
                    (deliveryKind == null ||
                        deliveryBindingSha256 == null)))) ||
        (outcome == 'suppress' &&
            (state != 'terminal' ||
                deliveryKind != null ||
                deliveryBindingSha256 != null)) ||
        (!const {'send', 'digest'}.contains(outcome) &&
            (deliveryKind != null || deliveryBindingSha256 != null)) ||
        evaluatedAt.isAfter(updated) ||
        (terminalAt != null && terminalAt.isAfter(updated))) {
      throw const FormatException(
        'Notification disposition lifecycle coordinates are invalid.',
      );
    }
    return NotificationDisposition(
      id: id,
      sourceKind: sourceKind,
      sourceId: _requiredDispositionText(value, 'sourceId'),
      occurrenceSha256: _dispositionSha(value, 'occurrenceSha256'),
      candidateSha256: _dispositionSha(value, 'candidateSha256'),
      outcome: outcome,
      state: state,
      reason: reason,
      mustSend: mustSend,
      critical: critical,
      policySha256: _dispositionSha(value, 'policySha256'),
      decisionReceiptSha256: _dispositionSha(value, 'decisionReceiptSha256'),
      evaluatedAt: evaluatedAt,
      dueAt: dueAt,
      deliveryKind: deliveryKind,
      deliveryBindingSha256: deliveryBindingSha256,
      digestDeliveryId: digestDeliveryId,
      lifecycleRevision: lifecycleRevision,
      updatedAt: updatedAt,
      terminalAt: terminalAt,
    );
  }
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
  Future<void>? _refreshing;
  ApprovalQueue? queue;
  NotificationCenter? notificationCenter;
  NotificationDispositionHistory? dispositionHistory;
  Object? approvalsError;
  Object? notificationsError;
  Object? dispositionsError;
  Object? actionError;
  bool loading = false;
  final Set<String> deciding = {};
  final Set<String> updatingNotifications = {};

  bool get hasData =>
      queue != null || notificationCenter != null || dispositionHistory != null;
  bool get hasLoadError =>
      approvalsError != null ||
      notificationsError != null ||
      dispositionsError != null;

  Future<void> refresh() {
    final refreshing = _refreshing;
    if (refreshing != null) return refreshing;

    final completion = Completer<void>();
    _refreshing = completion.future;
    unawaited(_refresh(completion));
    return completion.future;
  }

  Future<void> _refresh(Completer<void> completion) async {
    loading = true;
    approvalsError = null;
    notificationsError = null;
    dispositionsError = null;
    actionError = null;
    notifyListeners();
    try {
      // Approvals and notifications make the inbox useful. Load those as one
      // bounded request wave, render them immediately, and only then fetch the
      // auxiliary delivery-decision history used by its inspector.
      await Future.wait([_loadApprovals(), _loadNotifications()]);
      notifyListeners();
      await _loadDispositions();
      completion.complete();
    } catch (error, stackTrace) {
      completion.completeError(error, stackTrace);
    } finally {
      loading = false;
      _refreshing = null;
      notifyListeners();
    }
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

  Future<void> _loadDispositions() async {
    try {
      dispositionHistory = await repository.loadNotificationDispositions();
    } catch (error) {
      dispositionsError = error;
    }
  }

  Future<void> decide(ApprovalItem item, bool approve, {String? reason}) async {
    deciding.add(item.id);
    actionError = null;
    approvalsError = null;
    notificationsError = null;
    notifyListeners();
    try {
      await repository.decide(item, approve: approve, reason: reason);
      // An approval decision can affect the queue and its user notification,
      // but it cannot rewrite historical delivery dispositions. Refresh only
      // the two affected projections.
      await Future.wait([_loadApprovals(), _loadNotifications()]);
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
  const InboxView({super.key, required this.controller, this.focusApprovalId});
  final InboxController controller;
  final String? focusApprovalId;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (_, _) {
      final q = controller.queue;
      final approvals = q == null ? const <ApprovalItem>[] : [...q.items]
        ..sort((left, right) {
          if (left.id == focusApprovalId) return -1;
          if (right.id == focusApprovalId) return 1;
          return 0;
        });
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
            if (controller.dispositionHistory != null) ...[
              SliverToBoxAdapter(
                child: _SectionHeader(
                  title: 'Delivery decisions',
                  count: controller.dispositionHistory!.items.length,
                ),
              ),
              if (controller.dispositionHistory!.items.isEmpty)
                const SliverToBoxAdapter(
                  child: Padding(
                    padding: EdgeInsets.fromLTRB(16, 0, 16, 12),
                    child: Text(
                      'No durable notification decisions are recorded yet.',
                    ),
                  ),
                )
              else
                SliverToBoxAdapter(
                  child: SizedBox(
                    height: 144,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                      itemCount: controller.dispositionHistory!.items.length,
                      separatorBuilder: (_, _) => const SizedBox(width: 9),
                      itemBuilder: (context, index) => SizedBox(
                        width: 280,
                        child: NotificationDispositionCard(
                          item: controller.dispositionHistory!.items[index],
                        ),
                      ),
                    ),
                  ),
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
                (notifications == null ||
                    notifications.notifications.isEmpty) &&
                (controller.dispositionHistory == null ||
                    controller.dispositionHistory!.items.isEmpty))
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
                  itemCount: approvals.length,
                  itemBuilder: (_, i) => ApprovalCard(
                    item: approvals[i],
                    busy: controller.deciding.contains(approvals[i].id),
                    focused: approvals[i].id == focusApprovalId,
                    onDecision: (value) =>
                        controller.decide(approvals[i], value),
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
    this.focused = false,
    required this.onDecision,
  });
  final ApprovalItem item;
  final bool busy;
  final bool focused;
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
          color: focused
              ? Theme.of(context).colorScheme.primaryContainer
              : Theme.of(context).colorScheme.surfaceContainerLow,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: focused
                ? Theme.of(context).colorScheme.primary
                : color.withValues(alpha: item.riskLevel >= 3 ? .45 : .18),
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

class NotificationDispositionCard extends StatelessWidget {
  const NotificationDispositionCard({super.key, required this.item});
  final NotificationDisposition item;

  @override
  Widget build(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    clipBehavior: Clip.antiAlias,
    child: InkWell(
      key: ValueKey('notification-disposition-${item.id}'),
      onTap: () => _showDispositionEvidence(context, item),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(_dispositionIcon(item.outcome), size: 18),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    _dispositionLabel(item.outcome),
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
                Text(item.state, style: Theme.of(context).textTheme.labelSmall),
              ],
            ),
            const SizedBox(height: 7),
            Text('${_dispositionLabel(item.sourceKind)} · ${item.reason}'),
            const Spacer(),
            Text(
              'Exact evidence · tap to inspect',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.labelSmall,
            ),
          ],
        ),
      ),
    ),
  );
}

Future<void> _showDispositionEvidence(
  BuildContext context,
  NotificationDisposition item,
) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  builder: (context) => FractionallySizedBox(
    heightFactor: .88,
    child: ListView(
      key: const Key('notification-disposition-evidence-list'),
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
      children: [
        Center(
          child: Container(
            width: 38,
            height: 4,
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.outlineVariant,
              borderRadius: BorderRadius.circular(99),
            ),
          ),
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            Icon(_dispositionIcon(item.outcome)),
            const SizedBox(width: 9),
            Expanded(
              child: Text(
                '${_dispositionLabel(item.outcome)} decision',
                style: Theme.of(context).textTheme.titleLarge,
              ),
            ),
            IconButton(
              tooltip: 'Close',
              onPressed: () => Navigator.pop(context),
              icon: const Icon(Icons.close_rounded),
            ),
          ],
        ),
        const Text(
          'Exact content-free policy evidence. This record does not grant authority.',
        ),
        const SizedBox(height: 14),
        _PortableDispositionField(label: 'Disposition ID', value: item.id),
        _PortableDispositionField(
          label: 'Source',
          value: '${item.sourceKind} / ${item.sourceId}',
        ),
        _PortableDispositionField(label: 'Reason', value: item.reason),
        _PortableDispositionField(
          label: 'Lifecycle revision',
          value: '${item.lifecycleRevision}',
        ),
        _PortableDispositionField(
          label: 'Occurrence SHA-256',
          value: item.occurrenceSha256,
          monospace: true,
        ),
        _PortableDispositionField(
          label: 'Candidate SHA-256',
          value: item.candidateSha256,
          monospace: true,
        ),
        _PortableDispositionField(
          label: 'Policy SHA-256',
          value: item.policySha256,
          monospace: true,
        ),
        _PortableDispositionField(
          label: 'Decision receipt SHA-256',
          value: item.decisionReceiptSha256,
          monospace: true,
        ),
        if (item.digestDeliveryId != null)
          _PortableDispositionField(
            label: 'Digest delivery ID',
            value: item.digestDeliveryId!,
          ),
        if (item.deliveryKind != null)
          _PortableDispositionField(
            label: 'Delivery binding',
            value:
                '${item.deliveryKind} / ${item.deliveryBindingSha256 ?? 'Unavailable'}',
            monospace: item.deliveryBindingSha256 != null,
          ),
      ],
    ),
  ),
);

class _PortableDispositionField extends StatelessWidget {
  const _PortableDispositionField({
    required this.label,
    required this.value,
    this.monospace = false,
  });

  final String label, value;
  final bool monospace;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.labelSmall),
        const SizedBox(height: 3),
        SelectableText(
          value,
          style: monospace
              ? Theme.of(context).textTheme.bodySmall
                    ?.copyWith(fontFamily: 'monospace')
              : null,
        ),
      ],
    ),
  );
}

String _requiredDispositionText(Json value, String key) {
  final result = value[key];
  if (result is! String || result.trim().isEmpty) {
    throw FormatException('$key must be a non-empty string.');
  }
  return result;
}

String _dispositionSha(Json value, String key) {
  final result = _requiredDispositionText(value, key);
  if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(result)) {
    throw FormatException('$key must be a SHA-256 digest.');
  }
  return result;
}

final _notificationDispositionId = RegExp(
  r'^notification_disposition_[a-f0-9]{48}$',
);
const _notificationSourceKinds = {
  'tool_approval',
  'meeting',
  'customer_risk',
  'agent_run',
  'today_reminder',
  'delegated_task',
  'scheduled_routine',
  'security_incident',
};
const _notificationOutcomes = {'send', 'defer', 'digest', 'suppress'};
const _notificationStates = {'pending', 'terminal'};
const _notificationReasons = {
  'approval_required',
  'security_alert',
  'actionable_failure',
  'meeting_imminent',
  'critical_delivery',
  'quiet_hours',
  'cooldown_active',
  'digest_nonurgent',
  'digest_during_cooldown',
  'routine_success',
  'failure_not_actionable',
  'meeting_not_imminent',
  'not_worthy',
};
const _notificationDeliveryKinds = {
  'mobile_push_outbox',
  'incident_alert_outbox',
  'notification_ledger',
  'digest_ledger',
};

String _dispositionChoice(Json value, String key, Set<String> choices) {
  final result = _requiredDispositionText(value, key);
  if (!choices.contains(result)) {
    throw FormatException('$key has an unsupported value.');
  }
  return result;
}

String? _nullableDispositionChoice(
  Json value,
  String key,
  Set<String> choices,
) {
  final result = _nullableDispositionText(value, key);
  if (result != null && !choices.contains(result)) {
    throw FormatException('$key has an unsupported value.');
  }
  return result;
}

String? _nullableDispositionText(Json value, String key) {
  final result = value[key];
  if (result == null) return null;
  if (result is! String || result.trim().isEmpty) {
    throw FormatException('$key must be null or a non-empty string.');
  }
  return result;
}

bool _dispositionBool(Json value, String key) {
  final result = value[key];
  if (result is! bool) throw FormatException('$key must be a boolean.');
  return result;
}

int _dispositionRevision(Json value, String key) {
  final result = value[key];
  if (result is! num || result.toInt() != result || result < 0) {
    throw FormatException('$key must be a non-negative integer.');
  }
  return result.toInt();
}

DateTime _dispositionTime(Json value, String key) {
  final source = _requiredDispositionText(value, key);
  final parsed = DateTime.tryParse(source);
  if (parsed == null ||
      !parsed.isUtc ||
      parsed.toUtc().toIso8601String() != source) {
    throw FormatException('$key must be a canonical UTC timestamp.');
  }
  return parsed;
}

DateTime? _nullableDispositionTime(Json value, String key) =>
    value[key] == null ? null : _dispositionTime(value, key);

IconData _dispositionIcon(String outcome) => switch (outcome) {
  'send' => Icons.send_outlined,
  'defer' => Icons.schedule_outlined,
  'digest' => Icons.summarize_outlined,
  _ => Icons.notifications_off_outlined,
};

String _dispositionLabel(String value) => value
    .replaceAll('_', ' ')
    .split(' ')
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');

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
