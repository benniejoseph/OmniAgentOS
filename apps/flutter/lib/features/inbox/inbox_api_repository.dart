import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'inbox.dart';

class ApiInboxRepository implements InboxRepository {
  const ApiInboxRepository(this.api);
  final ApiClient api;
  @override
  Future<ApprovalQueue> loadApprovals() async => ApprovalQueue.fromJson(
    await api.getJson(NativePaths.approvalsList, query: {'limit': 50}),
  );
  @override
  Future<NotificationCenter> loadNotifications() async =>
      NotificationCenter.fromJson(
        await api.getJson(NativePaths.notificationsList),
      );
  @override
  Future<void> decide(
    ApprovalItem item, {
    required bool approve,
    String? reason,
    bool breakGlass = false,
    String? ticket,
  }) async {
    await api.postJson(
      NativePaths.approvalsDecide(item.id),
      data: {
        'kind': item.kind,
        'decision': approve ? 'approve' : 'reject',
        if (reason?.trim().isNotEmpty ?? false) 'reason': reason!.trim(),
        if (breakGlass) 'breakGlass': true,
        if (ticket?.trim().isNotEmpty ?? false) 'ticket': ticket!.trim(),
      },
    );
  }

  @override
  Future<void> updateNotification(
    PersonalNotification notification,
    NotificationAction action, {
    int? snoozeMinutes,
  }) async {
    await api.patchJson(
      NativePaths.notificationsAcknowledge(notification.id),
      data: {'action': action.apiValue, 'minutes': ?snoozeMinutes},
      headers: {
        'idempotency-key':
            'notification-${notification.id}-${action.apiValue}-${DateTime.now().microsecondsSinceEpoch}',
      },
    );
  }

  @override
  Future<void> readAllNotifications() async {
    await api.patchJson(
      NativePaths.notificationsReadAll,
      data: {'action': 'read_all'},
      headers: {
        'idempotency-key':
            'notifications-read-all-${DateTime.now().microsecondsSinceEpoch}',
      },
    );
  }
}
