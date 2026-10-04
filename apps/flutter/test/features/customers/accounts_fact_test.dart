import 'dart:async';

import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_fact_contracts.dart';
import 'package:asael/features/customers/accounts_mutation_controller.dart';
import 'package:asael/features/customers/accounts_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_fact_fixtures.dart';
import 'accounts_health_fixtures.dart';
import 'accounts_test_support.dart';

void main() {
  test('manual create revise and retract receipts bind author, original pins and exact source identity', () async {
    final account = await healthAccount();
    for (final operation in ['create', 'revise', 'retract']) {
      final intent = await AccountFactIntent.prepare(
        healthOwner,
        accountWorkspace,
        'fact-$operation',
        account,
        factRequest(account, operation: operation),
      );
      final response = await factResponse(intent),
          receipt = await AccountFactAcceptance.parse(
            await factResponse(intent),
            intent,
            mutation: true,
          );
      expect(
        receipt.acceptance!['state'],
        operation == 'retract' ? 'retracted' : 'active',
      );
      expect(
        receipt.acceptance!['sourceRevisionId'],
        'customer-manual-source:${intent.requestSha256}:v1',
      );
      final altered = await AccountFactIntent.prepare(
        healthOwner,
        accountWorkspace,
        'another-key',
        account,
        factRequest(account, operation: operation),
      );
      await expectLater(
        AccountFactAcceptance.parse(response, altered, mutation: true),
        throwsFormatException,
      );
      final later = await healthAccount(revision: 2);
      expect(
        (await AccountFactAcceptance.parse(
          await factResponse(intent, mutation: false, current: later),
          intent,
          mutation: false,
        )).currentAccount['revision'],
        2,
      );
      await expectLater(
        AccountFactAcceptance.parse(
          await factResponse(intent, current: later),
          intent,
          mutation: true,
        ),
        throwsFormatException,
      );
    }
  });
  test(
    'source purposes, validity, money and required request pins fail closed',
    () async {
      final account = await healthAccount(),
          request = factRequest(await healthAccount());
      expect(
        () => validateAccountFactRequest({
          ...request,
          'allowedPurposeIds': ['customer_success.crm_sync'],
        }),
        throwsFormatException,
      );
      expect(
        () => validateAccountFactRequest({...request, 'validTo': accountStamp}),
        throwsFormatException,
      );
      expect(
        () =>
            validateAccountFactRequest({...request, 'expectedFactRevision': 1}),
        throwsFormatException,
      );
      await expectLater(
        AccountFactIntent.prepare(
          healthOwner,
          accountWorkspace,
          'bad-purpose',
          account,
          {
            ...request,
            'allowedPurposeIds': [
              'customer_success.account.read',
              'customer_success.crm_sync',
            ],
          },
        ),
        throwsFormatException,
      );
      expect(
        () => validateAccountFactRequest({
          ...request,
          'value': {
            'kind': 'opportunity',
            'entityId': 'opportunity:one',
            'name': 'Renewal',
            'stage': 'Open',
            'amountMinor': 9007199254740992,
            'currency': 'USD',
            'expectedCloseAt': null,
          },
        }),
        throwsFormatException,
      );
    },
  );
  test('schema4 exact intent is protected before POST and survives restart for GET-only recovery', () async {
    final account = await healthAccount(),
        repo = FactRepository(await healthAccount())..loseFactResponse = true,
        store = MemoryAccountsRecoveryStore();
    final controller = AccountsMutationController(
      repo,
      store,
      isVisible: () => true,
      canManage: () => true,
    );
    await controller.bind(accountWorkspace);
    repo.beforeFact = (intent) async {
      final saved = (await store.read(healthOwner, accountWorkspace))!;
      expect(saved['schemaVersion'], 4);
      expect(saved['fact']['pending']['requestSha256'], intent.requestSha256);
      expect(saved.containsKey('health'), isTrue);
      expect(saved.containsKey('workflow'), isTrue);
    };
    await controller.submitFact(
      account,
      factRequest(account),
      isReviewCurrent: () => true,
    );
    final key = controller.pendingFact!.key;
    controller.dispose();
    final restored = AccountsMutationController(
      repo,
      store,
      isVisible: () => true,
      canManage: () => true,
    );
    await restored.bind(accountWorkspace);
    expect(restored.pendingFact!.key, key);
    repo.foundFact = false;
    await restored.recoverFact();
    expect(restored.pendingFact!.key, key);
    repo.foundFact = true;
    repo.account = await healthAccount(revision: 2);
    await restored.recoverFact();
    expect(restored.pendingFact, isNull);
    expect(
      restored.factState.accepted!.acceptance!['reviewedAccountRevision'],
      1,
    );
    expect(repo.writes, hasLength(1));
    expect(repo.reads, hasLength(2));
    restored.dispose();
  });
  test('missing protected read retains unresolved fact identity and blocks another write', () async {
    final account = await healthAccount(),
        repo = FactRepository(await healthAccount())..loseFactResponse = true,
        store = _MissingFacts();
    final controller = AccountsMutationController(
      repo,
      store,
      isVisible: () => true,
      canManage: () => true,
    );
    await controller.bind(accountWorkspace);
    await controller.submitFact(
      account,
      factRequest(account),
      isReviewCurrent: () => true,
    );
    final key = controller.pendingFact!.key;
    store.missing = true;
    await controller.reload();
    expect(controller.pendingFact!.key, key);
    expect(controller.storageUnconfirmed, isTrue);
    await controller.submitFact(
      account,
      factRequest(account),
      isReviewCurrent: () => true,
    );
    expect(repo.writes, hasLength(1));
    controller.dispose();
  });
  test('closing a delayed exact preflight submits nothing and releases the mutation slot', () async {
    var visible = true;
    final account = await healthAccount(),
        repo = FactRepository(await healthAccount()),
        store = MemoryAccountsRecoveryStore();
    final gate = Completer<CustomerDetail>();
    repo.factDetailGate = gate;
    final controller = AccountsMutationController(
      repo,
      store,
      isVisible: () => true,
      canManage: () => true,
    );
    await controller.bind(accountWorkspace);
    final pending = controller.submitFact(
      account,
      factRequest(account),
      isReviewCurrent: () => visible,
    );
    visible = false;
    gate.complete(await healthDetail(account));
    await pending;
    expect(repo.writes, isEmpty);
    expect(controller.pendingFact, isNull);
    expect(controller.busy, isFalse);
    expect(await store.read(healthOwner, accountWorkspace), isNull);
    controller.dispose();
  });
  test('accepted B wins stored A after B settlement fails and is saved without another POST', () async {
    final account = await healthAccount(),
        repo = FactRepository(await healthAccount()),
        store = _FailedFacts();
    final controller = AccountsMutationController(
      repo,
      store,
      isVisible: () => true,
      canManage: () => true,
    );
    await controller.bind(accountWorkspace);
    await controller.submitFact(
      account,
      factRequest(account),
      isReviewCurrent: () => true,
    );
    final a = controller.factState.acceptedIntent!.requestSha256;
    store.fail = true;
    await controller.submitFact(account, {
      ...factRequest(account),
      'factKey': 'manual.second',
    }, isReviewCurrent: () => true);
    final b = controller.factState.acceptedIntent!.requestSha256;
    expect(a, isNot(b));
    expect(controller.storageUnconfirmed, isTrue);
    store.fail = false;
    await controller.reload();
    expect(controller.factState.acceptedIntent!.requestSha256, b);
    expect(controller.pendingFact, isNull);
    expect(controller.storageUnconfirmed, isTrue);
    await controller.settleFactLocally();
    expect(controller.storageUnconfirmed, isFalse);
    expect(repo.writes, hasLength(2));
    controller.dispose();
  });
}

class _MissingFacts extends MemoryAccountsRecoveryStore {
  bool missing = false;
  @override
  Future<AccountJson?> read(AccountsOwner owner, String workspace) =>
      missing ? Future.value() : super.read(owner, workspace);
}

class _FailedFacts extends MemoryAccountsRecoveryStore {
  bool fail = false;
  @override
  Future<void> write(
    AccountsOwner owner,
    String workspace,
    AccountJson value, {
    required bool Function() isCurrent,
  }) async {
    final fact = value['fact'] as Map?;
    if (fail &&
        fact != null &&
        fact['pending'] == null &&
        fact['accepted'] != null) {
      throw StateError('Local settlement unavailable.');
    }
    await super.write(owner, workspace, value, isCurrent: isCurrent);
  }
}
