import 'package:asael/features/responsibilities/responsibility_contracts.dart';
import 'package:asael/features/responsibilities/responsibility_controller.dart';
import 'package:asael/features/responsibilities/responsibility_recovery_store.dart';
import 'package:asael/features/responsibilities/responsibility_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'responsibility_test_support.dart';

const verifier = ResponsibilityVerifier(testOwner);
const reviewedAt = '2026-10-04T00:01:00.000Z';
const restartedAt = '2026-10-04T00:02:00.000Z';
Future<ResponsibilityJson> reseal(ResponsibilityJson value, String field) =>
    sealed({...value}..remove(field), field);

Future<Map<String, ResponsibilityJson>> fixture() async {
  final record = await draftRecord(revision: 3);
  final reviewHash = await verifier.reviewDigest(record, 2, pins);
  final reviewed = {
    ...record,
    'state': 'reviewed',
    'updatedAt': reviewedAt,
    'review': {
      'schemaVersion': 1,
      'draftSha256': record['draftSha256'],
      'reviewSha256': reviewHash,
      'pins': pins,
      'reviewedAt': reviewedAt,
      'authorityEffect': 'none',
      'activationSupported': false,
    },
  };
  final oldConfiguration = await reseal({
    ...await runtimeConfiguration(),
    'draftSha256': record['draftSha256'],
  }, 'configurationSha256');
  final configuration = await reseal({
    ...oldConfiguration,
    'responsibilityRevision': 3,
    'reviewSha256': reviewHash,
  }, 'configurationSha256');
  final blocked = {
    ...await runtimeHead(
      revision: 6,
      generation: 2,
      state: 'blocked',
      reason: 'authority_changed',
    ),
    'configuration': oldConfiguration,
  };
  final active = {
    ...blocked,
    'revision': 7,
    'generation': 3,
    'state': 'active',
    'reason': 'owner_resumed',
    'configuration': configuration,
    'nextDueAt': restartedAt,
    'updatedAt': restartedAt,
  };
  final oldNotificationConfiguration = await reseal({
    ...await notificationConfiguration(),
    'draftSha256': record['draftSha256'],
    'runtimeConfigurationSha256': oldConfiguration['configurationSha256'],
  }, 'configurationSha256');
  final notificationConfig = await reseal({
    ...oldNotificationConfiguration,
    'responsibilityRevision': 3,
    'reviewSha256': reviewHash,
    'runtimeConfigurationSha256': configuration['configurationSha256'],
  }, 'configurationSha256');
  final ended = {
    ...await notificationHead(
      revision: 6,
      generation: 2,
      state: 'ended',
      reason: 'runtime_blocked',
      used: 1,
    ),
    'configuration': oldNotificationConfiguration,
  };
  final enabled = {
    ...ended,
    'revision': 7,
    'generation': 3,
    'state': 'enabled',
    'reason': 'owner_enabled',
    'configuration': notificationConfig,
    'updatedAt': restartedAt,
  };
  return {
    'record': reviewed,
    'oldConfiguration': oldConfiguration,
    'configuration': configuration,
    'blocked': blocked,
    'active': active,
    'ended': ended,
    'enabled': enabled,
    'notificationConfiguration': notificationConfig,
  };
}

ResponsibilityJson runtimePreview(Map<String, ResponsibilityJson> f) => {
  ...runtimeView(f['blocked']),
  'preview': {
    'state': 'ready',
    'authorityEffect': 'none',
    'dispatchReadiness': 'not_observed',
    'configuration': f['configuration'],
    'recovery': 'reviewed_authority_change',
  },
};
ResponsibilityJson notificationPreview(Map<String, ResponsibilityJson> f) => {
  ...notificationView(f['ended']),
  'preview': {
    'state': 'ready',
    'authorityEffect': 'none',
    'configuration': f['notificationConfiguration'],
    'expectedRuntimeRevision': 7,
    'expectedRuntimeGeneration': 3,
    'expectedRevision': 6,
    'expectedGeneration': 2,
  },
};

Future<ResponsibilityJson> resultWithSnapshot(
  ResponsibilityJson result,
  ResponsibilityJson snapshot,
) async => {
  ...result,
  'current': snapshot,
  'receipt': await reseal({
    ...responsibilityMap(result['receipt']),
    'previousRevision': (snapshot['revision'] as int) - 1,
    'snapshot': snapshot,
    'savedAt': snapshot['updatedAt'],
  }, 'receiptSha256'),
};

void main() {
  test('baseline review rebind preserves the exact accepted evidence and never invents an observation', () async {
    final view = await observationOutcome('baseline_established');
    final previous = responsibilityMap(view['baseline']);
    final next = await reseal({
      ...previous,
      'revision': (previous['revision'] as int) + 1,
      'target': {
        ...responsibilityMap(previous['target']),
        'responsibilityRevision': 3,
        'reviewSha256': List.filled(64, 'b').join(),
      },
    }, 'baselineSha256');
    final runtimeReceiptId = 'responsibility-runtime-receipt:$hashA';
    final rebind = await sealed({
      'schemaVersion': 1,
      'id':
          'responsibility-baseline-rebind:${await responsibilityHash([runtimeReceiptId, previous['baselineSha256']])}',
      'runtimeReceiptId': runtimeReceiptId,
      'runtimeReceiptSha256': hashA,
      'previous': previous,
      'next': next,
      'savedAt': restartedAt,
    }, 'receiptSha256');
    await verifier.read(
      {
        ...view,
        'baseline': next,
        'baselineRebinds': [rebind],
      },
      ResponsibilityRead.observations,
      id: testId,
      limit: 25,
    );
    expect(next['observationId'], previous['observationId']);
    expect(next['acceptedAt'], previous['acceptedAt']);
    for (final changed in [
      {...next, 'observationSha256': List.filled(64, 'c').join()},
      {...next, 'acceptedAt': restartedAt},
      {
        ...next,
        'target': {
          ...responsibilityMap(next['target']),
          'responsibilityRevision': 2,
        },
      },
      {
        ...next,
        'target': {
          ...responsibilityMap(next['target']),
          'actorId': 'actor:22222222-2222-4222-8222-222222222222',
        },
      },
    ]) {
      final altered = await reseal(changed, 'baselineSha256');
      await expectLater(
        verifier.read(
          {
            ...view,
            'baseline': altered,
            'baselineRebinds': [
              await reseal({...rebind, 'next': altered}, 'receiptSha256'),
            ],
          },
          ResponsibilityRead.observations,
          id: testId,
          limit: 25,
        ),
        throwsFormatException,
      );
    }
  });

  test('accepting a new draft review refreshes checks and notifications without starting either', () async {
    final f = await fixture(), repository = TestResponsibilityRepository();
    final unreviewed = await draftRecord(revision: 2);
    var accepted = false;
    final afterReads = <ResponsibilityRead>{};
    repository.onRead = (kind, id, preview) async {
      if (accepted) afterReads.add(kind);
      if (kind == ResponsibilityRead.detail) {
        return {
          ...draftEnvelope,
          'record': accepted ? f['record'] : unreviewed,
          'readiness': preview
              ? {
                  'state': 'ready',
                  'draftSha256': unreviewed['draftSha256'],
                  'reviewSha256': responsibilityMap(
                    f['record']!['review'],
                  )['reviewSha256'],
                  'pins': pins,
                  'authorityEffect': 'none',
                  'activationSupported': false,
                }
              : {'state': 'not_checked', 'issues': <String>[]},
        };
      }
      if (kind == ResponsibilityRead.runtime) return runtimeView(f['blocked']);
      if (kind == ResponsibilityRead.notifications) {
        return notificationView(f['ended']);
      }
      return repository.defaultRead(kind, id);
    };
    repository.onMutation = (lane, input, key, id) async {
      accepted = true;
      final result = await draftResult(
        {'action': 'update', 'expectedRevision': 2, 'draft': fullDraft},
        key,
        id: id,
      );
      return {
        ...result,
        'current': f['record'],
        'receipt': {
          ...responsibilityMap(result['receipt']),
          'action': 'reviewed',
          'snapshot': f['record'],
          'savedAt': reviewedAt,
          'requestSha256': await responsibilityHash([
            'responsibility-request:1',
            id,
            input,
          ]),
        },
      };
    };
    final controller = ResponsibilityController(
      repository,
      MemoryResponsibilityRecoveryStore(),
    );
    addTearDown(controller.dispose);
    await controller.initialize(focusId: testId);
    await controller.requestPreview(ResponsibilityRead.detail);
    await controller.acceptReview();
    expect(repository.writes.single.$2['action'], 'review');
    expect(repository.writes.single.$4, testId);
    expect(controller.pending, isNull);
    expect(controller.record!.state, 'reviewed');
    expect(
      afterReads,
      containsAll([
        ResponsibilityRead.detail,
        ResponsibilityRead.runtime,
        ResponsibilityRead.notifications,
        ResponsibilityRead.observations,
      ]),
    );
    expect(controller.head(ResponsibilityRead.runtime)!['state'], 'blocked');
    expect(
      controller.head(ResponsibilityRead.notifications)!['state'],
      'ended',
    );
  });

  test('recovery preview requires the exact blocked reason, new review and unchanged finite scope', () async {
    final f = await fixture(), view = runtimePreview(await fixture());
    await verifier.read(
      view,
      ResponsibilityRead.runtime,
      id: testId,
      preview: true,
    );
    final ready = responsibilityMap(view['preview']);
    for (final changed in [
      {
        ...view,
        'current': {...f['blocked']!, 'reason': 'uncertain_started_work'},
      },
      {
        ...view,
        'current': {...f['blocked']!, 'state': 'paused'},
      },
      {
        ...view,
        'preview': {...ready, 'configuration': f['oldConfiguration']},
      },
      {
        ...view,
        'preview': {...ready, 'recovery': 'run_anything'},
      },
      {
        ...view,
        'preview': {
          ...ready,
          'configuration': await reseal({
            ...f['configuration']!,
            'maximumChecks': 9,
          }, 'configurationSha256'),
        },
      },
    ]) {
      await expectLater(
        verifier.read(
          changed,
          ResponsibilityRead.runtime,
          id: testId,
          preview: true,
        ),
        throwsFormatException,
      );
    }
    await verifier.read(runtimeView(), ResponsibilityRead.runtime, id: testId);
  });

  test('notification renewal requires paired exact admission coordinates and runtime-blocked state', () async {
    final f = await fixture(), view = notificationPreview(await fixture());
    await verifier.read(
      view,
      ResponsibilityRead.notifications,
      id: testId,
      preview: true,
    );
    final ready = responsibilityMap(view['preview']);
    for (final changed in [
      {
        ...view,
        'current': {...f['ended']!, 'reason': 'owner_stopped'},
      },
      {...view, 'current': null},
      {
        ...view,
        'preview': {...ready, 'expectedRevision': 5},
      },
      {
        ...view,
        'preview': {...ready}..remove('expectedGeneration'),
      },
      {
        ...view,
        'preview': {
          ...ready,
          'configuration': responsibilityMap(f['ended']!['configuration']),
        },
      },
      {
        ...view,
        'preview': {
          ...ready,
          'configuration': await reseal({
            ...f['notificationConfiguration']!,
            'maximumNotifications': 4,
          }, 'configurationSha256'),
        },
      },
    ]) {
      await expectLater(
        verifier.read(
          changed,
          ResponsibilityRead.notifications,
          id: testId,
          preview: true,
        ),
        throwsFormatException,
      );
    }
    final request = {
      'action': 'enable',
      'expectedRevision': 6,
      'expectedGeneration': 2,
      'expectedRuntimeRevision': 7,
      'expectedRuntimeGeneration': 3,
      'configurationSha256':
          f['notificationConfiguration']!['configurationSha256'],
      'acknowledgeDestination': 'owner_in_app',
    };
    validateResponsibilityMutation(ResponsibilityLane.notifications, request);
    for (final field in ['expectedRevision', 'expectedGeneration']) {
      expect(
        () => validateResponsibilityMutation(
          ResponsibilityLane.notifications,
          {...request}..remove(field),
        ),
        throwsFormatException,
      );
    }
    final result = await resultWithSnapshot(
      await notificationResult(request, 'renewal'),
      f['enabled']!,
    );
    await verifier.mutation(
      result,
      ResponsibilityLane.notifications,
      request,
      'renewal',
      testId,
    );
    expect(responsibilityMap(result['current'])['used'], 1);
    await expectLater(
      verifier.mutation(
        {
          ...result,
          'current': {...f['enabled']!, 'generation': 1},
        },
        ResponsibilityLane.notifications,
        request,
        'renewal',
        testId,
      ),
      throwsFormatException,
    );
  });

  test('runtime terminal history needs a verified older configuration receipt after recovery', () async {
    final f = await fixture();
    final initial = await resultWithSnapshot(
      await runtimeResult({
        'action': 'activate',
        'expectedRevision': 0,
        'expectedGeneration': 0,
        'configurationSha256': f['oldConfiguration']!['configurationSha256'],
        'acknowledgePilot': responsibilityPilot,
      }, 'initial-runtime'),
      {...await runtimeHead(), 'configuration': f['oldConfiguration']},
    );
    final wake = {
      ...await settledWake(),
      'configurationSha256': f['oldConfiguration']!['configurationSha256'],
    };
    final view = {
      ...runtimeView(f['active']),
      'wakes': [wake],
      'configurationReceipts': [initial['receipt']],
    };
    await verifier.read(view, ResponsibilityRead.runtime, id: testId);
    for (final changed in [
      {...view}..remove('configurationReceipts'),
      {
        ...view,
        'wakes': [
          {...wake, 'configurationSha256': hashA},
        ],
      },
      {
        ...view,
        'wakes': [
          {...wake, 'state': 'reserved', 'charged': null, 'settledAt': null},
        ],
      },
      {
        ...view,
        'configurationReceipts': [
          {...responsibilityMap(initial['receipt']), 'receiptSha256': hashA},
        ],
      },
    ]) {
      await expectLater(
        verifier.read(changed, ResponsibilityRead.runtime, id: testId),
        throwsFormatException,
      );
    }
    final sameGeneration = {...f['active']!, 'generation': 1};
    await expectLater(
      verifier.read(
        {...view, 'current': sameGeneration},
        ResponsibilityRead.runtime,
        id: testId,
      ),
      throwsFormatException,
    );
  });

  test('notification history and original replay survive renewal without reopening old candidates', () async {
    final f = await fixture();
    final oldConfiguration = responsibilityMap(f['ended']!['configuration']);
    final originalRequest = {
      'action': 'enable',
      'expectedRuntimeRevision': 1,
      'expectedRuntimeGeneration': 1,
      'configurationSha256': oldConfiguration['configurationSha256'],
      'acknowledgeDestination': 'owner_in_app',
    };
    final original = await resultWithSnapshot(
      await notificationResult(originalRequest, 'initial-notices'),
      {...await notificationHead(), 'configuration': oldConfiguration},
    );
    final candidate = {
      ...await notificationCandidate(state: 'delivered'),
      'configurationSha256': oldConfiguration['configurationSha256'],
    };
    final view = {
      ...notificationView(f['enabled']),
      'candidates': [candidate],
      'configurationReceipts': [original['receipt']],
    };
    await verifier.read(view, ResponsibilityRead.notifications, id: testId);
    await verifier.mutation(
      {...original, 'current': f['enabled'], 'replayed': true},
      ResponsibilityLane.notifications,
      originalRequest,
      'initial-notices',
      testId,
    );
    for (final changed in [
      {...view}..remove('configurationReceipts'),
      {
        ...view,
        'candidates': [
          {...candidate, 'configurationSha256': hashA},
        ],
      },
      {
        ...view,
        'candidates': [
          {
            ...await notificationCandidate(),
            'configurationSha256': oldConfiguration['configurationSha256'],
          },
        ],
      },
    ]) {
      await expectLater(
        verifier.read(changed, ResponsibilityRead.notifications, id: testId),
        throwsFormatException,
      );
    }
    final changedScope = await reseal({
      ...f['notificationConfiguration']!,
      'maximumNotifications': 4,
    }, 'configurationSha256');
    await expectLater(
      verifier.mutation(
        {
          ...original,
          'current': {...f['enabled']!, 'configuration': changedScope},
          'replayed': true,
        },
        ResponsibilityLane.notifications,
        originalRequest,
        'initial-notices',
        testId,
      ),
      throwsFormatException,
    );
  });

  test('same-record restart and notification renewal remain separate explicit requests', () async {
    final f = await fixture(), repository = TestResponsibilityRepository();
    var runtime = f['blocked']!, admission = f['ended']!;
    repository.onRead = (kind, id, preview) async {
      final value = switch (kind) {
        ResponsibilityRead.detail => {
          ...draftEnvelope,
          'record': f['record'],
          'readiness': {'state': 'not_checked', 'issues': <String>[]},
        },
        ResponsibilityRead.runtime =>
          preview ? runtimePreview(f) : runtimeView(runtime),
        ResponsibilityRead.notifications =>
          preview ? notificationPreview(f) : notificationView(admission),
        _ => await repository.defaultRead(kind, id),
      };
      return verifier.read(
        value,
        kind,
        id: id,
        preview: preview,
        limit: kind == ResponsibilityRead.observations ? 25 : 40,
      );
    };
    repository.onMutation = (lane, input, key, id) async {
      expect(id, testId);
      if (lane == ResponsibilityLane.runtime) {
        runtime = f['active']!;
        return resultWithSnapshot(await runtimeResult(input, key), runtime);
      }
      admission = f['enabled']!;
      return resultWithSnapshot(
        await notificationResult(input, key),
        admission,
      );
    };
    final controller = ResponsibilityController(
      repository,
      MemoryResponsibilityRecoveryStore(),
    );
    addTearDown(controller.dispose);
    await controller.initialize(focusId: testId);
    await controller.lifecycle('resume');
    expect(repository.writes, isEmpty);
    await controller.requestPreview(ResponsibilityRead.runtime);
    expect(controller.canRestartTracking, isTrue);
    await controller.lifecycle('resume');
    expect(repository.writes, hasLength(1));
    expect(repository.writes.single.$2, {
      'action': 'resume',
      'expectedRevision': 6,
      'expectedGeneration': 2,
      'configurationSha256': f['configuration']!['configurationSha256'],
      'acknowledgePilot': responsibilityPilot,
    });
    expect(
      controller.head(ResponsibilityRead.notifications)!['state'],
      'ended',
    );
    expect(controller.pending, isNull);
    await controller.notification('enable');
    expect(repository.writes, hasLength(1));
    await controller.requestPreview(ResponsibilityRead.notifications);
    expect(controller.canRenewNotifications, isTrue);
    await controller.notification('enable');
    expect(repository.writes, hasLength(2));
    expect(repository.writes.last.$2, {
      'action': 'enable',
      'expectedRevision': 6,
      'expectedGeneration': 2,
      'expectedRuntimeRevision': 7,
      'expectedRuntimeGeneration': 3,
      'configurationSha256':
          f['notificationConfiguration']!['configurationSha256'],
      'acknowledgeDestination': 'owner_in_app',
    });
    expect(controller.head(ResponsibilityRead.notifications)!['used'], 1);
    expect(controller.accepted, hasLength(2));
    expect(controller.pending, isNull);
  });

  test('missing server recovery capability cannot resume a blocked record; ordinary paused resume stays available', () async {
    final f = await fixture(), repository = TestResponsibilityRepository();
    var state = 'blocked';
    repository.onRead = (kind, id, preview) async {
      if (kind != ResponsibilityRead.runtime) {
        return repository.defaultRead(kind, id);
      }
      return {
        ...runtimeView({
          ...f['blocked']!,
          'state': state,
          'reason': state == 'paused' ? 'owner_paused' : 'authority_changed',
        }),
        if (preview)
          'preview': {
            'state': 'ready',
            'authorityEffect': 'none',
            'dispatchReadiness': 'not_observed',
            'configuration': f['oldConfiguration'],
          },
      };
    };
    repository.onMutation = (lane, input, key, id) async => resultWithSnapshot(
      await runtimeResult(input, key),
      {...f['active']!, 'configuration': f['oldConfiguration']},
    );
    final controller = ResponsibilityController(
      repository,
      MemoryResponsibilityRecoveryStore(),
    );
    addTearDown(controller.dispose);
    await controller.initialize(focusId: testId);
    await controller.requestPreview(ResponsibilityRead.runtime);
    await controller.lifecycle('resume');
    expect(repository.writes, isEmpty);
    state = 'paused';
    // A new owner-scoped controller models a separately read paused state.
    final paused = ResponsibilityController(
      repository,
      MemoryResponsibilityRecoveryStore(),
    );
    addTearDown(paused.dispose);
    await paused.initialize(focusId: testId);
    await paused.requestPreview(ResponsibilityRead.runtime);
    await paused.lifecycle('resume');
    expect(repository.writes.single.$2['action'], 'resume');
    expect(paused.pending, isNull);
  });

  testWidgets(
    'blocked tracking explains recovery and requires a ready capability before showing restart',
    (tester) async {
      tester.view.physicalSize = const Size(1400, 1100);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final f = await fixture(), repository = TestResponsibilityRepository();
      repository.onRead = (kind, id, preview) async => switch (kind) {
        ResponsibilityRead.detail => {
          ...draftEnvelope,
          'record': f['record'],
          'readiness': {'state': 'not_checked', 'issues': <String>[]},
        },
        ResponsibilityRead.runtime =>
          preview ? runtimePreview(f) : runtimeView(f['blocked']),
        ResponsibilityRead.notifications => notificationView(f['ended']),
        _ => await repository.defaultRead(kind, id),
      };
      final controller = ResponsibilityController(
        repository,
        MemoryResponsibilityRecoveryStore(),
      );
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: ResponsibilityWorkspaceView(
            controller: controller,
            focusId: testId,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Checks stopped because the reviewed access'),
        findsOneWidget,
      );
      expect(find.text('Restart tracking'), findsNothing);
      expect(find.text('Resume reviewed checks'), findsNothing);
      expect(find.text('Enable reviewed in-app notices'), findsNothing);
      await controller.requestPreview(ResponsibilityRead.runtime);
      await tester.pumpAndSettle();
      expect(find.text('Restart tracking'), findsOneWidget);
      final detailScroll = tester.state<ScrollableState>(
        find
            .ancestor(
              of: find.text('Restart tracking'),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      detailScroll.position.jumpTo(detailScroll.position.maxScrollExtent);
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Inbox updates stopped with tracking'),
        findsOneWidget,
      );
      expect(repository.writes, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );
}
