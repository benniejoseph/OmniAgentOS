import 'dart:async';

import 'package:asael/features/customers/accounts_advanced_contracts.dart';
import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_mutation_controller.dart';
import 'package:asael/features/customers/accounts_recovery_store.dart';
import 'package:asael/features/customers/accounts_workflow_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_health_fixtures.dart';
import 'accounts_test_support.dart';
import 'accounts_workflow_fixtures.dart';

void main() {
  test('all eight normalized workflow inputs retain explicit defaults and finite money bounds', () {
    final common = {
      'objective': 'Review the exact customer evidence',
      'targetDate': null,
    };
    final samples = <AccountJson>[
      workflowInput(),
      {
        ...common,
        'workflowId': 'adoption_review',
        'periodStartAt': '2026-10-01T00:00:00.000Z',
        'periodEndAt': accountStamp,
        'adoptionGoals': ['Goal'],
        'productIds': <String>[],
      },
      {
        ...common,
        'workflowId': 'risk_escalation',
        'riskTitle': 'Risk',
        'severity': 'high',
        'signals': ['Signal'],
        'executiveSponsorId': null,
      },
      {
        ...common,
        'workflowId': 'renewal_planning',
        'renewalAt': accountStamp,
        'renewalGoals': ['Goal'],
        'amountMinor': null,
        'currency': null,
      },
      {
        ...common,
        'workflowId': 'qbr_ebr',
        'reviewKind': 'ebr',
        'meetingAt': accountStamp,
        'periodStartAt': '2026-10-01T00:00:00.000Z',
        'periodEndAt': accountStamp,
        'audience': ['Owner'],
        'agendaObjectives': ['Evidence'],
      },
      {
        ...common,
        'workflowId': 'meeting_prep_follow_up',
        'meetingId': 'meeting:one',
        'phase': 'prep',
        'participantIds': ['participant:one'],
        'meetingObjectives': ['Review'],
      },
      {
        ...common,
        'workflowId': 'support_escalation',
        'caseIds': ['case:one'],
        'severity': 'critical',
        'customerImpact': 'Impact',
        'requestedOutcome': 'Resolve',
      },
      {
        ...common,
        'workflowId': 'expansion_discovery',
        'hypotheses': ['Hypothesis'],
        'stakeholderIds': ['person:one'],
        'discoveryWindowEndAt': accountStamp,
      },
    ];
    for (final input in samples) {
      accountWorkflowInput(input);
    }
    expect(
      () => accountWorkflowInput({
        ...samples[3],
        'amountMinor': 9007199254740992,
        'currency': 'USD',
      }),
      throwsFormatException,
    );
    expect(
      () => accountWorkflowInput({...samples[3], 'amountMinor': 100}),
      throwsFormatException,
    );
    expect(
      () => accountWorkflowInput({
        ...samples[1],
        'periodEndAt': samples[1]['periodStartAt'],
      }),
      throwsFormatException,
    );
  });

  test('setup identity is stable, strict acceptance cannot claim execution or another key', () async {
    final intent = await workflowIntent(),
        restored = await AccountWorkflowIntent.restore(
          (await workflowIntent()).stored,
          healthOwner,
          accountWorkspace,
        );
    expect(restored.requestSha256, intent.requestSha256);
    final accepted = await workflowAcceptance(intent);
    expect(
      (await AccountWorkflowAcceptance.parse(
        await workflowResponse(intent),
        intent,
        mutation: true,
      )).acceptance!['effectAuthority'],
      'none',
    );
    for (final changed in <AccountJson>[
      {...accepted, 'effectAuthority': 'execute'},
      {...accepted, 'requestSha256': 'f' * 64},
      {...accepted, 'runRevision': 2},
    ]) {
      await expectLater(
        AccountWorkflowAcceptance.parse(
          await workflowResponse(
            intent,
            acceptance: await sealAccount(changed, 'acceptanceSha256'),
          ),
          intent,
          mutation: true,
        ),
        throwsFormatException,
      );
    }
  });

  test('outcome binds current reviewed Account separately from original run and has no client timestamp', () async {
    final first = await workflowIntent(),
        original = await workflowRun(await workflowIntent()),
        current = await healthAccount(revision: 2);
    final intent = await workflowIntent(
      key: 'outcome-key',
      account: current,
      run: original,
    );
    expect(intent.body.containsKey('recordedAt'), isFalse);
    final read = await AccountWorkflowAcceptance.parse(
      await workflowResponse(intent),
      intent,
      mutation: true,
    );
    expect(read.acceptance!['runAccountRevision'], 1);
    expect(
      read.acceptance!['runAccountSha256'],
      first.request['expectedAccountSha256'],
    );
    expect(read.acceptance!['reviewedAccountRevision'], 2);
    final later = await healthAccount(revision: 3);
    await AccountWorkflowAcceptance.parse(
      await workflowResponse(intent, mutation: false, current: later),
      intent,
      mutation: false,
    );
    await expectLater(
      AccountWorkflowAcceptance.parse(
        await workflowResponse(intent, current: later),
        intent,
        mutation: true,
      ),
      throwsFormatException,
    );
  });

  test('workflow preparation saves the exact schema3 intent before transport and preserves schema2 health', () async {
    final repo = WorkflowRepository(
          await healthAccount(),
          await workflowDefinition(),
        ),
        store = MemoryAccountsRecoveryStore();
    await store.write(healthOwner, accountWorkspace, {
      'schemaVersion': 2,
      'targetId': null,
      'draft': null,
      'pending': null,
      'acceptedIntent': null,
      'accepted': null,
      'health': {
        'pending': null,
        'acceptedIntent': null,
        'accepted': null,
        'disposition': null,
      },
    }, isCurrent: () => true);
    final actions = AccountsMutationController(
      repo,
      store,
      isVisible: () => true,
      canManage: () => true,
    );
    addTearDown(actions.dispose);
    await actions.bind(accountWorkspace);
    repo.beforeWrite = (intent) async {
      final saved = await store.read(healthOwner, accountWorkspace);
      expect(saved!['schemaVersion'], 3);
      expect(saved['health'], {
        'pending': null,
        'acceptedIntent': null,
        'accepted': null,
        'disposition': null,
      });
      expect((saved['workflow'] as Map)['pending'], intent.stored);
      expect(actions.locked, isTrue);
    };
    await actions.submitWorkflow(
      repo.account,
      repo.definition,
      workflowInput(),
      isReviewCurrent: () => true,
    );
    expect(repo.writes, hasLength(1));
    expect(
      actions.acceptedWorkflow!.acceptance!['outcomeStatus'],
      'in_progress',
    );
    expect(actions.pendingWorkflow, isNull);
  });

  test('lost response restart and absent exact receipt keep the intent; recovery only reads', () async {
    final repo = WorkflowRepository(
          await healthAccount(),
          await workflowDefinition(),
        )..writeFailure = TimeoutException('lost'),
        store = MemoryAccountsRecoveryStore();
    final first = AccountsMutationController(
      repo,
      store,
      isVisible: () => true,
      canManage: () => true,
    );
    await first.bind(accountWorkspace);
    await first.submitWorkflow(
      repo.account,
      repo.definition,
      workflowInput(),
      isReviewCurrent: () => true,
    );
    final held = first.pendingWorkflow!;
    first.dispose();
    final next = AccountsMutationController(
      repo,
      store,
      isVisible: () => true,
      canManage: () => true,
    );
    addTearDown(next.dispose);
    await next.bind(accountWorkspace);
    expect(next.pendingWorkflow!.requestSha256, held.requestSha256);
    repo.found = false;
    await next.recoverWorkflow();
    expect(next.pendingWorkflow!.key, held.key);
    repo.found = true;
    await next.recoverWorkflow();
    expect(next.pendingWorkflow, isNull);
    expect(next.acceptedWorkflowIntent!.key, held.key);
    expect(repo.writes, hasLength(1));
    expect(repo.recoveries, hasLength(2));
  });

  test(
    'missing journal cannot erase an existing unresolved workflow request',
    () async {
      final repo = WorkflowRepository(
            await healthAccount(),
            await workflowDefinition(),
          )..writeFailure = TimeoutException('unknown'),
          store = _MissingRead();
      final actions = AccountsMutationController(
        repo,
        store,
        isVisible: () => true,
        canManage: () => true,
      );
      addTearDown(actions.dispose);
      await actions.bind(accountWorkspace);
      await actions.submitWorkflow(
        repo.account,
        repo.definition,
        workflowInput(),
        isReviewCurrent: () => true,
      );
      final held = actions.pendingWorkflow!;
      store.missing = true;
      await actions.reload();
      expect(actions.pendingWorkflow!.requestSha256, held.requestSha256);
      expect(actions.storageUnconfirmed, isTrue);
      expect(actions.locked, isTrue);
    },
  );

  test(
    'closing a held preflight dispatches nothing and releases preparation',
    () async {
      final repo = WorkflowRepository(
            await healthAccount(),
            await workflowDefinition(),
          ),
          store = MemoryAccountsRecoveryStore();
      final actions = AccountsMutationController(
        repo,
        store,
        isVisible: () => true,
        canManage: () => true,
      );
      addTearDown(actions.dispose);
      await actions.bind(accountWorkspace);
      repo.heldDetail = Completer<CustomerDetail>();
      var visible = true;
      final submitting = actions.submitWorkflow(
        repo.account,
        repo.definition,
        workflowInput(),
        isReviewCurrent: () => visible,
      );
      visible = false;
      repo.heldDetail!.complete(await healthDetail(repo.account));
      await submitting;
      expect(actions.busy, isFalse);
      expect(repo.writes, isEmpty);
      expect(actions.pendingWorkflow, isNull);
      expect(await store.read(healthOwner, accountWorkspace), isNull);
    },
  );

  test(
    'known accepted B survives a failed local save over older accepted A',
    () async {
      final repo = WorkflowRepository(
            await healthAccount(),
            await workflowDefinition(),
          ),
          store = _FailAcceptedSave();
      final actions = AccountsMutationController(
        repo,
        store,
        isVisible: () => true,
        canManage: () => true,
      );
      addTearDown(actions.dispose);
      await actions.bind(accountWorkspace);
      await actions.submitWorkflow(
        repo.account,
        repo.definition,
        workflowInput(),
        isReviewCurrent: () => true,
      );
      final first = actions.acceptedWorkflowIntent!;
      store.fail = true;
      await actions.submitWorkflow(repo.account, repo.definition, {
        ...workflowInput(),
        'objective': 'A second explicitly reviewed plan',
      }, isReviewCurrent: () => true);
      final second = actions.acceptedWorkflowIntent!;
      expect(second.requestSha256, isNot(first.requestSha256));
      expect(actions.storageUnconfirmed, isTrue);
      await actions.reload();
      expect(
        actions.acceptedWorkflowIntent!.requestSha256,
        second.requestSha256,
      );
      expect(actions.pendingWorkflow, isNull);
      expect(actions.storageUnconfirmed, isTrue);
      store.fail = false;
      await actions.settleWorkflowLocally();
      expect(actions.storageUnconfirmed, isFalse);
      expect(repo.writes, hasLength(2));
    },
  );
}

class _MissingRead extends MemoryAccountsRecoveryStore {
  bool missing = false;
  @override
  Future<AccountJson?> read(AccountsOwner owner, String workspace) =>
      missing ? Future.value() : super.read(owner, workspace);
}

class _FailAcceptedSave extends MemoryAccountsRecoveryStore {
  bool fail = false;
  @override
  Future<void> write(
    AccountsOwner owner,
    String workspace,
    AccountJson value, {
    required bool Function() isCurrent,
  }) {
    final workflow = value['workflow'] as Map?;
    if (fail && workflow?['pending'] == null && workflow?['accepted'] != null) {
      throw StateError('Settlement not acknowledged');
    }
    return super.write(owner, workspace, value, isCurrent: isCurrent);
  }
}
