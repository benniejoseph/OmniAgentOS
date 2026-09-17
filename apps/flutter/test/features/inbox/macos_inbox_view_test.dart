import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/inbox/inbox.dart';
import 'package:asael/features/inbox/macos_inbox_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _InboxRepository implements InboxRepository {
  _InboxRepository({required this.queue, required this.center});

  final ApprovalQueue queue;
  final NotificationCenter center;
  final List<(String, bool, String?)> decisions = [];
  final List<(String, NotificationAction, int?)> notificationActions = [];

  @override
  Future<void> decide(
    ApprovalItem item, {
    required bool approve,
    String? reason,
    bool breakGlass = false,
    String? ticket,
  }) async {
    decisions.add((item.id, approve, reason));
  }

  @override
  Future<ApprovalQueue> loadApprovals() async => queue;

  @override
  Future<NotificationCenter> loadNotifications() async => center;

  @override
  Future<void> readAllNotifications() async {}

  @override
  Future<void> updateNotification(
    PersonalNotification notification,
    NotificationAction action, {
    int? snoozeMinutes,
  }) async {
    notificationActions.add((notification.id, action, snoozeMinutes));
  }
}

final _notificationCenter = NotificationCenter(
  notifications: [
    PersonalNotification(
      id: 'notice-one',
      title: 'Review the market brief',
      status: 'unread',
      urgency: 'overdue',
      dueAt: DateTime.utc(2026, 9, 18, 3),
    ),
  ],
  unreadCount: 1,
  quietHoursActive: false,
  generatedAt: DateTime.utc(2026, 9, 18, 2),
);

const _approvalQueue = ApprovalQueue(
  items: [
    ApprovalItem(
      id: 'approval-one',
      kind: 'tool',
      title: 'Send the message',
      status: 'waiting_approval',
      riskLevel: 2,
      input: {'recipient': 'owner@example.test'},
      reason: 'External side effect',
    ),
    ApprovalItem(
      id: 'approval-two',
      kind: 'workflow',
      title: 'Deploy the workspace',
      status: 'waiting_approval',
      riskLevel: 3,
      input: {'target': 'production'},
      reason: 'Production change',
    ),
  ],
  tools: 1,
  workflows: 1,
  sloPolicies: 0,
);

void main() {
  testWidgets('fits the minimum Mac workspace viewport', (tester) async {
    tester.view.physicalSize = const Size(786, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final repository = _InboxRepository(
      queue: _approvalQueue,
      center: _notificationCenter,
    );
    final controller = InboxController(repository)
      ..queue = _approvalQueue
      ..notificationCenter = _notificationCenter;

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: MacosInboxView(controller: controller),
      ),
    );

    expect(tester.takeException(), isNull);
    expect(find.text('Notices  1'), findsOneWidget);
  });

  testWidgets(
    'keeps notifications separate and dispatches their exact action',
    (tester) async {
      tester.view.physicalSize = const Size(1500, 920);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = _InboxRepository(
        queue: _approvalQueue,
        center: _notificationCenter,
      );
      final controller = InboxController(repository)
        ..queue = _approvalQueue
        ..notificationCenter = _notificationCenter;

      await tester.pumpWidget(
        MaterialApp(
          theme: MacosAppTheme.light(),
          home: MacosInboxView(controller: controller),
        ),
      );

      expect(find.text('Review the market brief'), findsNWidgets(2));
      await tester.tap(find.byKey(const Key('macos-notification-complete')));
      await tester.pumpAndSettle();

      expect(repository.notificationActions, [
        ('notice-one', NotificationAction.complete, null),
      ]);
    },
  );

  testWidgets(
    'shows exact consequences and preserves approve and reject calls',
    (tester) async {
      tester.view.physicalSize = const Size(1500, 920);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = _InboxRepository(
        queue: _approvalQueue,
        center: _notificationCenter,
      );
      final controller = InboxController(repository)
        ..queue = _approvalQueue
        ..notificationCenter = _notificationCenter;

      await tester.pumpWidget(
        MaterialApp(
          theme: MacosAppTheme.light(),
          home: MacosInboxView(
            controller: controller,
            focusApprovalId: 'approval-two',
          ),
        ),
      );

      expect(
        find.text(
          'The workflow resumes. Exact reviewed reversible actions receive short-lived, budgeted plan grants; dynamic or changed targets still pause for their own approval.',
        ),
        findsOneWidget,
      );
      await tester.drag(find.byType(ListView).last, const Offset(0, -360));
      await tester.pumpAndSettle();
      expect(find.textContaining('"target": "production"'), findsOneWidget);

      await tester.enterText(
        find.byKey(const Key('macos-approval-note')),
        'Reviewed exact production target',
      );
      await tester.ensureVisible(
        find.byKey(const Key('macos-approval-approve')),
      );
      await tester.tap(find.byKey(const Key('macos-approval-approve')));
      await tester.pumpAndSettle();

      expect(repository.decisions.single, (
        'approval-two',
        true,
        'Reviewed exact production target',
      ));

      await tester.ensureVisible(
        find.byKey(const Key('macos-approval-reject')),
      );
      await tester.tap(find.byKey(const Key('macos-approval-reject')));
      await tester.pumpAndSettle();
      expect(repository.decisions.last.$1, 'approval-two');
      expect(repository.decisions.last.$2, isFalse);
    },
  );
}
