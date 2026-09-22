import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:asael/features/inbox/inbox.dart';

class _InboxRepository implements InboxRepository {
  Completer<ApprovalQueue> approvals = Completer<ApprovalQueue>();
  Completer<NotificationCenter> notifications = Completer<NotificationCenter>();
  Completer<NotificationDispositionHistory> dispositions =
      Completer<NotificationDispositionHistory>();
  int approvalLoads = 0;
  int notificationLoads = 0;
  int dispositionLoads = 0;

  @override
  Future<ApprovalQueue> loadApprovals() {
    approvalLoads += 1;
    return approvals.future;
  }

  @override
  Future<NotificationCenter> loadNotifications() {
    notificationLoads += 1;
    return notifications.future;
  }

  @override
  Future<NotificationDispositionHistory> loadNotificationDispositions() {
    dispositionLoads += 1;
    return dispositions.future;
  }

  @override
  Future<void> decide(
    ApprovalItem item, {
    required bool approve,
    String? reason,
    bool breakGlass = false,
    String? ticket,
  }) async {}

  @override
  Future<void> readAllNotifications() async {}

  @override
  Future<void> updateNotification(
    PersonalNotification notification,
    NotificationAction action, {
    int? snoozeMinutes,
  }) async {}
}

const _emptyApprovals = ApprovalQueue(
  items: [],
  tools: 0,
  workflows: 0,
  sloPolicies: 0,
);

final _emptyNotifications = NotificationCenter(
  notifications: const [],
  unreadCount: 0,
  quietHoursActive: false,
  generatedAt: DateTime.utc(2026, 9, 17),
);

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

  test(
    'coalesces concurrent refreshes and keeps cached data available',
    () async {
      final repository = _InboxRepository();
      final controller = InboxController(repository)
        ..queue = _emptyApprovals
        ..notificationCenter = _emptyNotifications;

      final first = controller.refresh();
      final second = controller.refresh();

      expect(identical(first, second), isTrue);
      expect(repository.approvalLoads, 1);
      expect(repository.notificationLoads, 1);
      expect(repository.dispositionLoads, 1);
      expect(controller.loading, isTrue);
      expect(controller.hasData, isTrue);

      repository.approvals.complete(_emptyApprovals);
      repository.notifications.complete(_emptyNotifications);
      repository.dispositions.complete(
        const NotificationDispositionHistory(
          version: 'notification-disposition-projection:1',
          items: [],
        ),
      );
      await Future.wait([first, second]);

      expect(controller.loading, isFalse);

      repository.approvals = Completer<ApprovalQueue>();
      repository.notifications = Completer<NotificationCenter>();
      repository.dispositions = Completer<NotificationDispositionHistory>();
      final next = controller.refresh();
      expect(repository.approvalLoads, 2);
      expect(repository.notificationLoads, 2);
      expect(repository.dispositionLoads, 2);
      repository.approvals.complete(_emptyApprovals);
      repository.notifications.complete(_emptyNotifications);
      repository.dispositions.complete(
        const NotificationDispositionHistory(
          version: 'notification-disposition-projection:1',
          items: [],
        ),
      );
      await next;
    },
  );

  testWidgets('keeps cached approvals visible during refresh', (tester) async {
    final repository = _InboxRepository();
    final controller = InboxController(repository)
      ..queue = const ApprovalQueue(
        items: [
          ApprovalItem(
            id: 'approval-1',
            kind: 'tool',
            title: 'Cached approval',
            status: 'waiting_approval',
            riskLevel: 2,
            input: {},
          ),
        ],
        tools: 1,
        workflows: 0,
        sloPolicies: 0,
      )
      ..notificationCenter = _emptyNotifications;

    final refresh = controller.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: InboxView(controller: controller)),
      ),
    );

    expect(controller.loading, isTrue);
    expect(find.text('Cached approval'), findsOneWidget);

    repository.approvals.complete(_emptyApprovals);
    repository.notifications.complete(_emptyNotifications);
    repository.dispositions.complete(
      const NotificationDispositionHistory(
        version: 'notification-disposition-projection:1',
        items: [],
      ),
    );
    await refresh;
    await tester.pump();
  });

  testWidgets('portable Inbox opens exact content-free decision evidence', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final repository = _InboxRepository();
    final controller = InboxController(repository)
      ..queue = _emptyApprovals
      ..notificationCenter = _emptyNotifications
      ..dispositionHistory = _portableDispositionHistory;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: InboxView(controller: controller)),
      ),
    );
    final card = find.byKey(
      const ValueKey(
        'notification-disposition-notification_disposition_111111111111111111111111111111111111111111111111',
      ),
    );
    await tester.ensureVisible(card);
    await tester.tap(card);
    await tester.pumpAndSettle();

    expect(
      find.textContaining('Exact content-free policy evidence'),
      findsOneWidget,
    );
    expect(
      find.text(
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      ),
      findsOneWidget,
    );
    expect(
      find.text(
        'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      ),
      findsOneWidget,
    );
    await tester.scrollUntilVisible(
      find.text(
        'notification_digest_222222222222222222222222222222222222222222222222',
      ),
      240,
      scrollable: find
          .descendant(
            of: find.byKey(const Key('notification-disposition-evidence-list')),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(
      find.text(
        'notification_digest_222222222222222222222222222222222222222222222222',
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
}

final _portableDispositionHistory = NotificationDispositionHistory(
  version: 'notification-disposition-projection:1',
  items: [
    NotificationDisposition(
      id: 'notification_disposition_111111111111111111111111111111111111111111111111',
      sourceKind: 'today_reminder',
      sourceId: 'notice-one',
      occurrenceSha256:
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      candidateSha256:
          'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      outcome: 'digest',
      state: 'terminal',
      reason: 'quiet_hours',
      mustSend: false,
      critical: false,
      policySha256:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      decisionReceiptSha256:
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      evaluatedAt: DateTime.utc(2026, 9, 22, 10),
      dueAt: null,
      deliveryKind: 'digest_ledger',
      deliveryBindingSha256:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      digestDeliveryId: 'notification_digest_222222222222222222222222222222222222222222222222',
      lifecycleRevision: 1,
      updatedAt: '2026-09-22T10:05:00.000Z',
      terminalAt: DateTime.utc(2026, 9, 22, 10, 1),
    ),
  ],
);
