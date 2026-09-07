import 'package:flutter_test/flutter_test.dart';
import 'package:asael/features/inbox/inbox.dart';

void main() {
  test('decodes unified approval queue', () {
    final queue = ApprovalQueue.fromJson({
      'items': [
        {
          'id': 'a1',
          'kind': 'workflow',
          'title': 'Deploy',
          'status': 'waiting_approval',
          'riskLevel': 3,
          'input': {'target': 'prod'},
        },
      ],
      'stats': {'tools': 0, 'workflows': 1, 'sloPolicies': 0},
    });
    expect(queue.items.single.riskLevel, 3);
    expect(queue.workflows, 1);
  });

  test('decodes the actor-scoped notification center', () {
    final center = NotificationCenter.fromJson({
      'generatedAt': '2026-09-08T03:00:00.000Z',
      'unreadCount': 1,
      'quietHoursActive': true,
      'notifications': [
        {
          'id': 'notification-1',
          'title': 'Review launch brief',
          'status': 'unread',
          'urgency': 'overdue',
          'dueAt': '2026-09-08T02:00:00.000Z',
        },
      ],
    });

    expect(center.unreadCount, 1);
    expect(center.quietHoursActive, isTrue);
    expect(center.notifications.single.isOverdue, isTrue);
    expect(center.notifications.single.isUnread, isTrue);
  });

  test('rejects malformed notification identity or due time', () {
    expect(
      () => PersonalNotification.fromJson({
        'id': 'notification-1',
        'title': 'Invalid due time',
        'dueAt': 'tomorrow',
      }),
      throwsFormatException,
    );
  });
}
