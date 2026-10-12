import 'package:asael/features/responsibilities/responsibility_contracts.dart';
import 'package:asael/features/responsibilities/responsibility_controller.dart';
import 'package:asael/features/responsibilities/responsibility_recovery_store.dart';
import 'package:asael/features/responsibilities/responsibility_work_item_setup.dart';
import 'package:asael/features/responsibilities/responsibility_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'responsibility_test_support.dart';

Future<ResponsibilityJson> reseal(ResponsibilityJson value, String field) =>
    sealed({...value}..remove(field), field);

ResponsibilityJson workReferences() {
  final value = references(testOwner),
      groups = responsibilityMap(value['groups']);
  return {
    ...value,
    'groups': {
      ...groups,
      'sources': {
        'state': 'available',
        'hasMore': false,
        'items': [
          {'source': workItemSource, 'label': 'Launch proposal'},
        ],
      },
      'work': {
        'state': 'available',
        'hasMore': false,
        'items': [workItemChoice],
      },
      'procedures': {
        'state': 'available',
        'hasMore': false,
        'items': [
          {
            'id': responsibilityWorkItemProcedure,
            'label': 'Follow this work item',
          },
        ],
      },
    },
  };
}

void main() {
  const verifier = ResponsibilityVerifier(testOwner);

  test(
    'work references and draft preserve exact workspace, project and item',
    () async {
      await verifier.read(workReferences(), ResponsibilityRead.references);
      final draft = workItemFollowthroughDraft(
        draft: emptyResponsibilityDraft(),
        work: workItemChoice,
        now: DateTime.parse(now),
      );
      final record = await draftRecord(draft: draft);
      await verifier.read(
        {
          ...draftEnvelope,
          'record': record,
          'readiness': {'state': 'not_checked', 'issues': <String>[]},
        },
        ResponsibilityRead.detail,
        id: testId,
      );
      expect(draft['sources'], [workItemSource]);
      expect(draft['procedureId'], responsibilityWorkItemProcedure);
      expect(draft['agentId'], 'atlas');
      // The server admits review only when every incompleteDraft requirement
      // is present. A schema-valid editable draft alone is insufficient.
      for (final field in [
        'purpose',
        'desiredOutcome',
        'successCondition',
        'procedureId',
        'agentId',
      ]) {
        expect(draft[field], isNotEmpty, reason: field);
      }
      expect((draft['purpose'] as String).length, greaterThanOrEqualTo(3));
      expect(draft['stopConditions'], [
        'The tracking period expires or I stop tracking.',
      ]);
      expect(draft['work'], {
        'workspaceId': workItemChoice['workspaceId'],
        'projectId': workItemChoice['projectId'],
        'workItemId': workItemChoice['workItemId'],
      });
      expect(draft['notificationRule'], {
        'kind': 'material_change_only',
        'destination': 'owner_in_app',
        'quietOnNoChange': true,
      });
      expect(responsibilityMap(draft['limits'])['maxChecks'], 7);
      expect(responsibilityMap(draft['limits'])['maxNotifications'], 7);
      final cadence = responsibilityMap(draft['cadence']);
      expect(cadence['frequency'], 'daily');
      expect(
        DateTime.parse(cadence['expiresAt'] as String)
            .isAfter(DateTime.parse(now)),
        isTrue,
      );
      expect(
        DateTime.parse(cadence['expiresAt'] as String)
            .difference(DateTime.parse(cadence['startsAt'] as String)),
        const Duration(days: 7),
      );
      expect(
        draft['successCondition'],
        contains('does not mean independently verified'),
      );
      final malformed = {
        ...draft,
        'sources': [
          {...workItemSource}..remove('projectId'),
        ],
      };
      expect(
        () => validateResponsibilityDraft(malformed),
        throwsFormatException,
      );
    },
  );

  test('quick setup preserves explicit wording, cadence, limits and specialist choice', () {
    final original = {...fullDraft, 'agentId': 'my-specialist'};
    final draft = workItemFollowthroughDraft(
      draft: original,
      work: workItemChoice,
      now: DateTime.parse(now),
    );
    for (final field in [
      'purpose',
      'desiredOutcome',
      'successCondition',
      'stopConditions',
      'cadence',
      'limits',
      'notificationRule',
      'agentId',
    ]) {
      expect(draft[field], original[field], reason: field);
    }
    expect(draft['sources'], [workItemSource]);
    expect(draft['procedureId'], responsibilityWorkItemProcedure);
  });

  test('work configuration rejects coherent hashes for mixed lanes and changed targets', () async {
    final configuration = await runtimeConfiguration(workItem: true);
    await verifier.configuration(configuration);
    await verifier.configuration(await runtimeConfiguration());
    final pinned = responsibilityMap(configuration['pins']);
    final tool = responsibilityMap(configuration['tool']);
    for (final modified in [
      {...configuration, 'pilot': responsibilityPilot},
      {
        ...configuration,
        'stops': ['expiry', 'meeting_started', 'meeting_canceled'],
      },
      {
        ...configuration,
        'tool': {
          ...tool,
          'id': 'app.meetings.show',
          'input': {'workspaceId': 'workspace:owner', 'meetingId': 'work-a'},
        },
      },
      {
        ...configuration,
        'tool': {
          ...tool,
          'input': {
            ...responsibilityMap(tool['input']),
            'projectId': 'other-project',
          },
        },
      },
      {
        ...configuration,
        'pins': {
          ...pinned,
          'work': {
            ...responsibilityMap(pinned['work']),
            'workItemId': 'other-item',
          },
        },
      },
      {
        ...configuration,
        'pins': {
          ...pinned,
          'procedure': {
            ...responsibilityMap(pinned['procedure']),
            'id': 'custom-procedure',
          },
        },
      },
      {...configuration, 'source': source},
    ]) {
      await expectLater(
        verifier.configuration(await reseal(modified, 'configurationSha256')),
        throwsFormatException,
      );
    }
  });

  test('runtime disclosure and activation acknowledgement bind the exact reviewed work lane', () async {
    final head = await runtimeHead(workItem: true);
    final view = runtimeView(head);
    await verifier.read(view, ResponsibilityRead.runtime, id: testId);
    await expectLater(
      verifier.read(
        {
          ...view,
          'disclosure': {
            ...responsibilityMap(view['disclosure']),
            'pilot': responsibilityPilot,
          },
        },
        ResponsibilityRead.runtime,
        id: testId,
      ),
      throwsFormatException,
    );
    final configuration = await runtimeConfiguration(workItem: true);
    final input = {
      'action': 'activate',
      'expectedRevision': 0,
      'expectedGeneration': 0,
      'configurationSha256': configuration['configurationSha256'],
      'acknowledgePilot': responsibilityWorkItemPilot,
    };
    validateResponsibilityMutation(ResponsibilityLane.runtime, input);
    await verifier.mutation(
      await runtimeResult(input, 'work-activation'),
      ResponsibilityLane.runtime,
      input,
      'work-activation',
      testId,
    );
  });

  for (final outcome in [
    'baseline_established',
    'material_change',
    'no_change',
    'insufficient_evidence',
  ]) {
    test(
      'work observation $outcome preserves exact evidence and separate delivery',
      () async {
        final value = await observationOutcome(outcome, workItem: true);
        await verifier.read(
          value,
          ResponsibilityRead.observations,
          id: testId,
          limit: 25,
        );
        final plan = responsibilityMap(
          responsibilityMap((value['receipts'] as List).single)['plan'],
        );
        expect(plan['outcome'], outcome);
        if (outcome == 'material_change') {
          expect(responsibilityMap(plan['change'])['categories'], [
            'work_overdue',
          ]);
          expect(
            responsibilityMap(plan['change'])['deliveryState'],
            'not_requested',
          );
        }
      },
    );
  }

  test('work inbox admission accepts exact work source without granting external delivery', () async {
    final configuration = await reseal({
      ...await notificationConfiguration(),
      'source': workItemSource,
      'runtimeConfigurationSha256': (await runtimeConfiguration(
        workItem: true,
      ))['configurationSha256'],
    }, 'configurationSha256');
    await verifier.configuration(configuration, id: testId, notification: true);
    final view = notificationView({
      ...await notificationHead(),
      'configuration': configuration,
    });
    await verifier.read(view, ResponsibilityRead.notifications, id: testId);
    await expectLater(
      verifier.read(
        {...view, 'externalDelivery': true},
        ResponsibilityRead.notifications,
        id: testId,
      ),
      throwsFormatException,
    );
  });

  test(
    'controller acknowledges reviewed work pilot instead of the meeting pilot',
    () async {
      final repository = TestResponsibilityRepository();
      final configuration = await runtimeConfiguration(workItem: true);
      repository.onRead = (kind, id, preview) async {
        if (kind != ResponsibilityRead.runtime) {
          return repository.defaultRead(kind, id);
        }
        return {
          ...runtimeView(),
          'disclosure': {
            ...responsibilityMap(runtimeView()['disclosure']),
            'pilot': responsibilityWorkItemPilot,
          },
          if (preview)
            'preview': {
              'state': 'ready',
              'configuration': configuration,
              'authorityEffect': 'none',
            },
        };
      };
      final controller = ResponsibilityController(
        repository,
        MemoryResponsibilityRecoveryStore(),
      );
      addTearDown(controller.dispose);
      await controller.initialize(focusId: testId);
      await controller.requestPreview(ResponsibilityRead.runtime);
      await controller.lifecycle('activate');
      expect(repository.writes, hasLength(1));
      expect(
        repository.writes.single.$2['acknowledgePilot'],
        responsibilityWorkItemPilot,
      );
      expect(controller.pending, isNull);
      expect(controller.accepted, hasLength(1));
    },
  );

  testWidgets(
    'selecting work prepares and saves an inactive draft without starting checks or notices',
    (tester) async {
      tester.view.physicalSize = const Size(420, 1100);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = TestResponsibilityRepository();
      repository.onRead = (kind, id, preview) async =>
          kind == ResponsibilityRead.references
          ? workReferences()
          : repository.defaultRead(kind, id);
      final controller = ResponsibilityController(
        repository,
        MemoryResponsibilityRecoveryStore(),
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      controller.edit({
        ...emptyResponsibilityDraft(),
        'purpose': 'Keep my wording',
      });
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: ResponsibilityWorkspaceView(controller: controller),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Continue your draft'));
      await tester.pumpAndSettle();
      final work = find.byKey(const ValueKey('responsibility-quick-work-null'));
      await tester.ensureVisible(work);
      await tester.pumpAndSettle();
      await tester.tap(work);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Launch proposal').last);
      await tester.pumpAndSettle();
      final prepare = find.byKey(const Key('responsibility-prepare-work'));
      await tester.ensureVisible(prepare);
      await tester.pumpAndSettle();
      await tester.tap(prepare);
      await tester.pumpAndSettle();
      expect(controller.draft['purpose'], 'Keep my wording');
      expect(controller.draft['sources'], [workItemSource]);
      expect(repository.writes, isEmpty);
      final save = find.byKey(const Key('responsibility-save'));
      await tester.ensureVisible(save);
      await tester.pumpAndSettle();
      await tester.tap(save);
      await tester.pumpAndSettle();
      expect(repository.writes, hasLength(1));
      expect(repository.writes.single.$1, ResponsibilityLane.draft);
      expect(repository.writes.single.$2['action'], 'create');
      expect(
        responsibilityMap(repository.writes.single.$2['draft'])['sources'],
        [workItemSource],
      );
      expect(tester.takeException(), isNull);
    },
  );
}
