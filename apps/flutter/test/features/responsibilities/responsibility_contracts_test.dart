import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/responsibilities/responsibility_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'responsibility_test_support.dart';

void main() {
  const verifier = ResponsibilityVerifier(testOwner);
  test('canonical request actor and persisted owner remain distinct', () {
    final owner = ResponsibilityOwner.fromSession(
      const AppSession(
        tenantId: 'tenant-a',
        actorId: 'owner@example.test',
        userId: '11111111-1111-4111-8111-111111111111',
        email: 'owner@example.test',
        displayName: 'Owner',
        workspaceName: 'Work',
        role: 'operator',
      ),
      'https://EXAMPLE.test/',
    );
    expect(owner!.actorId, testOwner.actorId);
    expect(owner.requestActorId, 'owner@example.test');
    expect(owner.apiBaseUrl, 'https://example.test');
    expect(
      ResponsibilityOwner.fromSession(
        const AppSession(
          tenantId: 'tenant-a',
          actorId: 'other@example.test',
          userId: '11111111-1111-4111-8111-111111111111',
          email: 'owner@example.test',
          displayName: 'Owner',
          workspaceName: 'Work',
          role: 'operator',
        ),
        'https://example.test',
      ),
      isNull,
    );
  });
  test('strict bounded list rejects false coverage, unknown authority, and foreign owners', () async {
    final record = await draftRecord();
    final response = {
      ...draftEnvelope,
      'records': [record],
      'hasMore': false,
      'coverage': {
        'kind': 'bounded_recent',
        'limit': 40,
        'returned': 1,
        'total': null,
      },
    };
    expect(
      (await verifier.read(response, ResponsibilityRead.list))['records'],
      hasLength(1),
    );
    for (final bad in [
      {
        ...response,
        'coverage': {
          'kind': 'bounded_recent',
          'limit': 40,
          'returned': 0,
          'total': null,
        },
      },
      {...response, 'executionAuthority': 'run'},
      {
        ...response,
        'records': [
          {...record, 'actorId': 'actor:22222222-2222-4222-8222-222222222222'},
        ],
      },
      {
        ...response,
        'compatibility': {
          ...responsibilityMap(draftEnvelope['compatibility']),
          'deliverySupported': true,
        },
      },
    ]) {
      await expectLater(
        verifier.read(bad, ResponsibilityRead.list),
        throwsFormatException,
      );
    }
  });
  test(
    'draft content and exact requested id must match the digest and target',
    () async {
      final record = await draftRecord();
      final response = {
        ...draftEnvelope,
        'record': record,
        'readiness': {'state': 'not_checked', 'issues': <String>[]},
      };
      await verifier.read(response, ResponsibilityRead.detail, id: testId);
      await expectLater(
        verifier.read(
          {
            ...response,
            'record': {
              ...record,
              'draft': {...fullDraft, 'purpose': 'Changed'},
            },
          },
          ResponsibilityRead.detail,
          id: testId,
        ),
        throwsFormatException,
      );
      await expectLater(
        verifier.read(
          response,
          ResponsibilityRead.detail,
          id: 'responsibility:${List.filled(64, 'b').join()}',
        ),
        throwsFormatException,
      );
    },
  );
  test(
    'ready review binds all sources, Work, procedure and Agent pins',
    () async {
      final record = await draftRecord();
      final ready = {
        'state': 'ready',
        'draftSha256': record['draftSha256'],
        'reviewSha256': await verifier.reviewDigest(record, 1, pins),
        'pins': pins,
        'authorityEffect': 'none',
        'activationSupported': false,
      };
      final response = {...draftEnvelope, 'record': record, 'readiness': ready};
      await verifier.read(
        response,
        ResponsibilityRead.detail,
        id: testId,
        preview: true,
      );
      final changedPins = {
        ...pins,
        'agent': {...responsibilityMap(pins['agent']), 'id': 'other-agent'},
      };
      await expectLater(
        verifier.read(
          {
            ...response,
            'readiness': {...ready, 'pins': changedPins},
          },
          ResponsibilityRead.detail,
          id: testId,
          preview: true,
        ),
        throwsFormatException,
      );
    },
  );
  test(
    'accepted draft receipt permits a later current head only on replay',
    () async {
      final input = {
        'action': 'create',
        'expectedRevision': 0,
        'draft': fullDraft,
      };
      final result = await draftResult(input, 'test-key');
      final current = responsibilityMap(result['current']);
      final newer = await draftRecord(id: current['id'] as String, revision: 3);
      await verifier.mutation(
        {...result, 'current': newer, 'replayed': true},
        ResponsibilityLane.draft,
        input,
        'test-key',
        null,
      );
      await expectLater(
        verifier.mutation(
          {...result, 'current': newer},
          ResponsibilityLane.draft,
          input,
          'test-key',
          null,
        ),
        throwsFormatException,
      );
      await expectLater(
        verifier.mutation(
          result,
          ResponsibilityLane.draft,
          input,
          'different-key',
          null,
        ),
        throwsFormatException,
      );
      await expectLater(
        verifier.mutation(
          result,
          ResponsibilityLane.draft,
          {
            ...input,
            'draft': {...fullDraft, 'purpose': 'Another intent'},
          },
          'test-key',
          null,
        ),
        throwsFormatException,
      );
    },
  );
  test(
    'current finite budgets cannot exceed checks or any cumulative dimension',
    () async {
      final head = await runtimeHead();
      await verifier.read(
        runtimeView(head),
        ResponsibilityRead.runtime,
        id: testId,
      );
      final budget = responsibilityMap(head['budget']);
      await expectLater(
        verifier.read(
          runtimeView({
            ...head,
            'budget': {...budget, 'reservedChecks': 8},
          }),
          ResponsibilityRead.runtime,
          id: testId,
        ),
        throwsFormatException,
      );
      await expectLater(
        verifier.read(
          runtimeView({
            ...head,
            'budget': {
              ...budget,
              'used': {...counters, 'toolCalls': 8},
            },
          }),
          ResponsibilityRead.runtime,
          id: testId,
        ),
        throwsFormatException,
      );
      await expectLater(
        verifier.read(
          runtimeView({...head, 'state': 'paused'}),
          ResponsibilityRead.runtime,
          id: testId,
        ),
        throwsFormatException,
      );
    },
  );
  test('runtime configuration cannot inherit notification or provider write authority', () async {
    final head = await runtimeHead(),
        configuration = responsibilityMap(
          (await runtimeHead())['configuration'],
        );
    final changed = {...configuration, 'notificationAuthority': 'owner_in_app'};
    await expectLater(
      verifier.read(
        runtimeView({...head, 'configuration': changed}),
        ResponsibilityRead.runtime,
        id: testId,
      ),
      throwsFormatException,
    );
    final otherSource = {
      ...configuration,
      'source': {...source, 'id': 'meeting:other'},
    };
    await expectLater(
      verifier.read(
        runtimeView({...head, 'configuration': otherSource}),
        ResponsibilityRead.runtime,
        id: testId,
      ),
      throwsFormatException,
    );
  });
  test(
    'pause response binds original key, revision, generation and exact action',
    () async {
      final input = {
            'action': 'pause',
            'expectedRevision': 8,
            'expectedGeneration': 2,
          },
          result = await runtimeResult({
            'action': 'pause',
            'expectedRevision': 8,
            'expectedGeneration': 2,
          }, 'pause-key');
      await verifier.mutation(
        result,
        ResponsibilityLane.runtime,
        input,
        'pause-key',
        testId,
      );
      await expectLater(
        verifier.mutation(
          result,
          ResponsibilityLane.runtime,
          {...input, 'expectedGeneration': 3},
          'pause-key',
          testId,
        ),
        throwsFormatException,
      );
      await expectLater(
        verifier.mutation(
          result,
          ResponsibilityLane.runtime,
          {...input, 'action': 'end'},
          'pause-key',
          testId,
        ),
        throwsFormatException,
      );
    },
  );
  test(
    'held notification requires current generation, head state and reservation',
    () async {
      final candidate = await notificationCandidate(),
          head = await notificationHead(reserved: 1);
      final view = {
        ...notificationView(head),
        'candidates': [candidate],
      };
      await verifier.read(view, ResponsibilityRead.notifications, id: testId);
      await expectLater(
        verifier.read(
          {
            ...notificationView(await notificationHead()),
            'candidates': [candidate],
          },
          ResponsibilityRead.notifications,
          id: testId,
        ),
        throwsFormatException,
      );
      await expectLater(
        verifier.read(
          {
            ...notificationView(
              await notificationHead(generation: 2, reserved: 1),
            ),
            'candidates': [candidate],
          },
          ResponsibilityRead.notifications,
          id: testId,
        ),
        throwsFormatException,
      );
      await expectLater(
        verifier.read(
          {
            ...notificationView(await notificationHead(state: 'paused')),
            'candidates': [candidate],
          },
          ResponsibilityRead.notifications,
          id: testId,
        ),
        throwsFormatException,
      );
    },
  );
  test(
    'delivered means one real in-app ledger binding, never a pending claim',
    () async {
      final candidate = await notificationCandidate(state: 'delivered'),
          head = await notificationHead(used: 1);
      await verifier.read(
        {
          ...notificationView(head),
          'candidates': [candidate],
        },
        ResponsibilityRead.notifications,
        id: testId,
      );
      for (final field in [
        'notificationId',
        'dispositionId',
        'deliveryBindingSha256',
      ]) {
        await expectLater(
          verifier.read(
            {
              ...notificationView(head),
              'candidates': [
                {...candidate, field: null},
              ],
            },
            ResponsibilityRead.notifications,
            id: testId,
          ),
          throwsFormatException,
        );
      }
      await expectLater(
        verifier.read(
          {...notificationView(head), 'externalDelivery': true},
          ResponsibilityRead.notifications,
          id: testId,
        ),
        throwsFormatException,
      );
    },
  );
  test('permanent notification stop verifies generation and preserves separate runtime', () async {
    final input = {
      'action': 'stop',
      'expectedRevision': 4,
      'expectedGeneration': 2,
    };
    final result = await notificationResult(input, 'stop-key');
    await verifier.mutation(
      result,
      ResponsibilityLane.notifications,
      input,
      'stop-key',
      testId,
    );
    expect(responsibilityMap(result['current'])['state'], 'ended');
    expect(
      responsibilityMap(result['current']).containsKey('runtime'),
      isFalse,
    );
    await expectLater(
      verifier.mutation(
        result,
        ResponsibilityLane.notifications,
        {...input, 'expectedGeneration': 1},
        'stop-key',
        testId,
      ),
      throwsFormatException,
    );
  });
  test('preview cannot claim notification admission where a current admission exists', () async {
    final view = {
      ...notificationView(await notificationHead()),
      'preview': {
        'state': 'ready',
        'authorityEffect': 'none',
        'configuration': await notificationConfiguration(),
        'expectedRuntimeRevision': 1,
        'expectedRuntimeGeneration': 1,
      },
    };
    await expectLater(
      verifier.read(
        view,
        ResponsibilityRead.notifications,
        id: testId,
        preview: true,
      ),
      throwsFormatException,
    );
  });
  test(
    'reference failure is explicit and does not erase other available choices',
    () async {
      final view = references(testOwner),
          groups = responsibilityMap(references(testOwner)['groups']);
      groups['sources'] = {
        'state': 'unavailable',
        'items': <Object?>[],
        'hasMore': null,
        'errorCode': 'responsibility_reference_read_unavailable',
      };
      groups['agents'] = {
        'state': 'available',
        'items': [
          {'id': 'atlas', 'label': 'Owner Agent'},
        ],
        'hasMore': false,
      };
      final result = await verifier.read({
        ...view,
        'groups': groups,
      }, ResponsibilityRead.references);
      expect(
        responsibilityMap(
          responsibilityMap(result['groups'])['agents'],
        )['items'],
        hasLength(1),
      );
      await expectLater(
        verifier.read({
          ...view,
          'owner': {
            'tenantId': testOwner.tenantId,
            'actorId': 'actor:22222222-2222-4222-8222-222222222222',
          },
        }, ResponsibilityRead.references),
        throwsFormatException,
      );
    },
  );
  test(
    'observation policy and empty baseline do not manufacture authority',
    () async {
      final view = await observationView();
      await verifier.read(
        view,
        ResponsibilityRead.observations,
        id: testId,
        limit: 25,
      );
      await expectLater(
        verifier.read(
          {...view, 'activationSupported': true},
          ResponsibilityRead.observations,
          id: testId,
          limit: 25,
        ),
        throwsFormatException,
      );
      await expectLater(
        verifier.read(
          {
            ...view,
            'policy': {
              ...responsibilityMap(view['policy']),
              'uncertainComparison': 'material_change',
            },
          },
          ResponsibilityRead.observations,
          id: testId,
          limit: 25,
        ),
        throwsFormatException,
      );
    },
  );
  test('baseline, cosmetic/no-change, material and insufficient evidence remain distinct accepted outcomes', () async {
    for (final outcome in [
      'baseline_established',
      'no_change',
      'material_change',
      'insufficient_evidence',
    ]) {
      final result = await verifier.read(
        await observationOutcome(outcome),
        ResponsibilityRead.observations,
        id: testId,
        limit: 25,
      );
      final plan = responsibilityMap(
        responsibilityMap((result['receipts'] as List).single)['plan'],
      );
      expect(plan['outcome'], outcome);
      expect(plan['change'] != null, outcome == 'material_change');
      expect(result['deliverySupported'], isFalse);
      if (outcome == 'insufficient_evidence') {
        expect(plan['nextBaseline'], isNull);
      }
    }
  });
  test('even a coherently hashed observation cannot invent a material change or baseline advancement', () async {
    final view = await observationOutcome('no_change'),
        receipt = responsibilityMap(
          ((await observationOutcome('no_change'))['receipts'] as List).single,
        );
    final plan = responsibilityMap(receipt['plan']);
    final changedReceipt = {
      ...receipt,
      'plan': {...plan, 'outcome': 'material_change'},
    }..remove('receiptSha256');
    await expectLater(
      verifier.read(
        {
          ...view,
          'receipts': [await sealed(changedReceipt, 'receiptSha256')],
        },
        ResponsibilityRead.observations,
        id: testId,
        limit: 25,
      ),
      throwsFormatException,
    );
    final missingBaseline = {
      ...receipt,
      'plan': {...plan, 'nextBaseline': null},
    }..remove('receiptSha256');
    await expectLater(
      verifier.read(
        {
          ...view,
          'receipts': [await sealed(missingBaseline, 'receiptSha256')],
        },
        ResponsibilityRead.observations,
        id: testId,
        limit: 25,
      ),
      throwsFormatException,
    );
  });
  test('a wake from an earlier generation can settle after pause without being re-admitted', () async {
    final head = await runtimeHead(
          revision: 5,
          generation: 2,
          state: 'paused',
          reason: 'owner_paused',
        ),
        wake = await settledWake();
    final keySha = await responsibilityHash([
      'responsibility-idempotency:1',
      'settle-key',
    ]);
    final receipt = await sealed({
      'schemaVersion': 1,
      'id':
          'responsibility-runtime-receipt:${await responsibilityHash([testOwner.tenantId, testOwner.actorId, keySha])}',
      'idempotencySha256': keySha,
      'requestSha256': hashA,
      'action': 'settle',
      'previousRevision': 4,
      'snapshot': head,
      'wake': wake,
      'savedAt': now,
    }, 'receiptSha256');
    await verifier.read(
      {
        ...runtimeView(head),
        'wakes': [wake],
        'receipts': [receipt],
      },
      ResponsibilityRead.runtime,
      id: testId,
    );
    await expectLater(
      verifier.read(
        {
          ...runtimeView(head),
          'wakes': [
            {...wake, 'charged': null},
          ],
        },
        ResponsibilityRead.runtime,
        id: testId,
      ),
      throwsFormatException,
    );
  });
  test('outbound strict mutations reject invented authority and cross-variant fields', () {
    expect(
      () => validateResponsibilityMutation(ResponsibilityLane.draft, {
        'action': 'create',
        'expectedRevision': 0,
        'draft': fullDraft,
        'activate': true,
      }),
      throwsFormatException,
    );
    expect(
      () => validateResponsibilityMutation(ResponsibilityLane.notifications, {
        'action': 'stop',
        'expectedRevision': 1,
        'expectedGeneration': 1,
        'acknowledgeDestination': 'owner_in_app',
      }),
      throwsFormatException,
    );
    expect(
      () => validateResponsibilityMutation(ResponsibilityLane.runtime, {
        'action': 'activate',
        'expectedRevision': 0,
        'expectedGeneration': 0,
        'configurationSha256': hashA,
        'acknowledgePilot': 'run-everything',
      }),
      throwsFormatException,
    );
  });
}
