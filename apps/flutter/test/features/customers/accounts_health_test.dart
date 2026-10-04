import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_controller.dart';
import 'package:asael/features/customers/accounts_health_contracts.dart';
import 'package:asael/features/customers/accounts_mutation_controller.dart';
import 'package:asael/features/customers/accounts_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_health_fixtures.dart';
import 'accounts_test_support.dart';

AccountsMutationController healthController(
  HealthRepository repo,
  AccountsRecoveryStore store,
) => AccountsMutationController(
  repo,
  store,
  isVisible: () => true,
  canManage: () => true,
);

void main() {
  test('health acceptance binds exact key, semantic intent and canonical Account owner', () async {
    final account = await healthAccount(),
        intent = await AccountHealthIntent.prepare(
          healthOwner,
          accountWorkspace,
          'health-key',
          await healthAccount(),
        );
    final response = await healthResponse(intent);
    expect(
      (await AccountHealthRead.parse(
        response,
        intent,
        mutation: true,
      )).acceptance!['status'],
      'unknown',
    );
    final other = await AccountHealthIntent.prepare(
      healthOwner,
      accountWorkspace,
      'another-key',
      account,
    );
    await expectLater(
      AccountHealthRead.parse(response, other, mutation: true),
      throwsFormatException,
    );
    final acceptance = await healthAcceptance(intent);
    final forged = await sealAccount({
      ...acceptance,
      'canonicalActorId': 'actor:$accountOtherUser',
    }, 'acceptanceSha256');
    await expectLater(
      AccountHealthRead.parse(
        await healthResponse(intent, acceptance: forged),
        intent,
        mutation: true,
      ),
      throwsFormatException,
    );
    final stored = cloneAccount(intent.stored);
    (stored['identity'] as Map)['request']['modelSuggestions'] = [
      {'statement': 'Unreviewed'},
    ];
    await expectLater(
      AccountHealthIntent.restore(stored, healthOwner, accountWorkspace),
      throwsFormatException,
    );
  });

  test('historical exact receipt allows a newer Account but fresh acceptance cannot claim it', () async {
    final intent = await AccountHealthIntent.prepare(
          healthOwner,
          accountWorkspace,
          'health-key',
          await healthAccount(),
        ),
        newer = await healthAccount(revision: 2);
    final read = await AccountHealthRead.parse(
      await healthResponse(intent, mutation: false, current: newer),
      intent,
      mutation: false,
    );
    expect(read.currentAccount['revision'], 2);
    expect(read.acceptance!['accountRevision'], 1);
    await expectLater(
      AccountHealthRead.parse(
        await healthResponse(intent, current: newer),
        intent,
        mutation: true,
      ),
      throwsFormatException,
    );
    expect(
      (await AccountHealthRead.parse(
        await healthResponse(intent, replayed: true, current: newer),
        intent,
        mutation: true,
      )).acceptance,
      isNotNull,
    );
  });

  test('lost response survives restart and recovers only through exact GET after Account revision', () async {
    final repo = HealthRepository(await healthAccount())
          ..writeFailure = StateError('Response lost'),
        store = MemoryAccountsRecoveryStore();
    final first = healthController(repo, store);
    await first.bind(accountWorkspace);
    await first.evaluateHealth(repo.account, isReviewCurrent: () => true);
    final key = first.pendingHealth!.key;
    first.dispose();
    final restored = healthController(repo, store);
    addTearDown(restored.dispose);
    await restored.bind(accountWorkspace);
    expect(restored.pendingHealth!.key, key);
    await restored.submit(recover: true);
    await restored.evaluateHealth(repo.account, isReviewCurrent: () => true);
    repo.account = await healthAccount(revision: 2);
    await restored.recoverHealth();
    expect(repo.evaluations, hasLength(1));
    expect(repo.recordWrites, 0);
    expect(repo.recoveries.single.key, key);
    expect(restored.pendingHealth, isNull);
    expect(restored.acceptedHealth!.acceptance!['accountRevision'], 1);
    expect(restored.acceptedHealth!.currentAccount['revision'], 2);
  });

  test(
    'null acceptance or denied/unavailable recovery never releases uncertainty',
    () async {
      final repo = HealthRepository(await healthAccount())
            ..writeFailure = StateError('Unknown'),
          store = MemoryAccountsRecoveryStore();
      final controller = healthController(repo, store);
      addTearDown(controller.dispose);
      await controller.bind(accountWorkspace);
      await controller.evaluateHealth(
        repo.account,
        isReviewCurrent: () => true,
      );
      final pending = controller.pendingHealth;
      repo.found = false;
      for (final failure in <Object?>[
        null,
        const ApiException('Denied', statusCode: 403),
        const ApiException('Missing', statusCode: 404),
        StateError('Offline'),
      ]) {
        repo.readFailure = failure;
        await controller.recoverHealth();
        expect(controller.pendingHealth, same(pending));
        expect(controller.acceptedHealth, isNull);
      }
      expect(repo.evaluations, hasLength(1));
      expect(
        ((await store.read(healthOwner, accountWorkspace))!['health']
            as Map)['pending'],
        isNotNull,
      );
    },
  );

  test(
    'closing a delayed preflight clears preparation and sends no request',
    () async {
      final repo = HealthRepository(await healthAccount())
            ..heldDetail = Completer<CustomerDetail>(),
          store = MemoryAccountsRecoveryStore();
      final controller = healthController(repo, store);
      addTearDown(controller.dispose);
      await controller.bind(accountWorkspace);
      var reviewed = true;
      final pending = controller.evaluateHealth(
        repo.account,
        isReviewCurrent: () => reviewed,
      );
      reviewed = false;
      repo.heldDetail!.complete(await healthDetail(repo.account));
      await pending;
      expect(controller.busy, isFalse);
      expect(controller.pendingHealth, isNull);
      expect(repo.evaluations, isEmpty);
      expect(await store.read(healthOwner, accountWorkspace), isNull);
    },
  );

  test(
    'unknown protected save blocks HTTP and reload does not evaluate',
    () async {
      final repo = HealthRepository(await healthAccount()),
          store = _UnknownHealthSave();
      final controller = healthController(repo, store);
      addTearDown(controller.dispose);
      await controller.bind(accountWorkspace);
      await controller.evaluateHealth(
        repo.account,
        isReviewCurrent: () => true,
      );
      expect(controller.storageUnconfirmed, isTrue);
      expect(repo.evaluations, isEmpty);
      final key = controller.pendingHealth!.key;
      await controller.reload();
      expect(controller.pendingHealth!.key, key);
      expect(repo.evaluations, isEmpty);
      repo.found = false;
      await controller.recoverHealth();
      expect(controller.pendingHealth, isNotNull);
    },
  );

  test(
    'only exact first-dispatch refusal proof releases the pending health slot',
    () async {
      for (final match in [false, true]) {
        final repo = HealthRepository(await healthAccount());
        final store = MemoryAccountsRecoveryStore();
        final controller = healthController(repo, store);
        addTearDown(controller.dispose);
        repo.beforeEvaluate = (intent) async {
          repo.writeFailure = ApiException(
            'Account changed',
            statusCode: 409,
            responseData: {
              ...healthRefusal(intent),
              if (!match) 'requestSha256': 'a' * 64,
            },
          );
        };
        await controller.bind(accountWorkspace);
        await controller.evaluateHealth(
          repo.account,
          isReviewCurrent: () => true,
        );
        expect(controller.pendingHealth == null, match);
        expect(controller.healthDisposition != null, match);
        expect(repo.evaluations, hasLength(1));
        expect(
          ((await store.read(healthOwner, accountWorkspace))!['health']
                  as Map)['pending'] ==
              null,
          match,
        );
      }
    },
  );

  test('v1 Account draft is preserved when health promotes the shared journal to v2', () async {
    final repo = HealthRepository(await healthAccount()),
        store = MemoryAccountsRecoveryStore();
    final controller = healthController(repo, store);
    addTearDown(controller.dispose);
    await controller.bind(accountWorkspace);
    controller.begin(account: repo.account);
    await controller.saveDraft();
    final old = (await store.read(healthOwner, accountWorkspace))!;
    expect(old['schemaVersion'], 1);
    final draft = accountCanonical(old['draft']);
    await controller.evaluateHealth(repo.account, isReviewCurrent: () => true);
    final saved = (await store.read(healthOwner, accountWorkspace))!;
    expect(saved['schemaVersion'], 2);
    expect(accountCanonical(saved['draft']), draft);
    expect(saved['pending'], isNull);
    expect((saved['health'] as Map)['accepted'], isNotNull);
    expect(repo.recordWrites, 0);
  });

  test('an accepted receipt survives a lost local acknowledgement and settles without another HTTP call', () async {
    final repo = HealthRepository(await healthAccount()),
        store = _UnknownHealthSave(accepted: true);
    final controller = healthController(repo, store);
    addTearDown(controller.dispose);
    await controller.bind(accountWorkspace);
    await controller.evaluateHealth(repo.account, isReviewCurrent: () => true);
    expect(controller.acceptedHealth, isNotNull);
    expect(controller.storageUnconfirmed, isTrue);
    await controller.reload();
    await controller.settleHealthLocally();
    expect(controller.storageUnconfirmed, isFalse);
    expect(controller.acceptedHealth, isNotNull);
    expect(repo.evaluations, hasLength(1));
    expect(repo.recoveries, isEmpty);
  });

  test('missing or different restored health intent cannot erase a dispatched uncertainty', () async {
    for (final variant in ['missing', 'schema1', 'empty', 'different']) {
      final repo = HealthRepository(await healthAccount())
            ..writeFailure = StateError('Unknown'),
          store = _ControlledHealthRead();
      final controller = healthController(repo, store);
      addTearDown(controller.dispose);
      await controller.bind(accountWorkspace);
      await controller.evaluateHealth(
        repo.account,
        isReviewCurrent: () => true,
      );
      final pending = controller.pendingHealth!;
      final original = (await store.read(healthOwner, accountWorkspace))!;
      final changed = cloneAccount(original);
      if (variant == 'schema1') {
        changed['schemaVersion'] = 1;
        changed.remove('health');
      } else if (variant != 'missing') {
        (changed['health'] as Map)['pending'] = variant == 'empty'
            ? null
            : (await AccountHealthIntent.prepare(
                healthOwner,
                accountWorkspace,
                'different-protected-key',
                repo.account,
              )).stored;
      }
      store.replacement = variant == 'missing' ? null : changed;
      store.replaceRead = true;
      await controller.reload();
      expect(controller.pendingHealth, same(pending));
      expect(controller.storageUnconfirmed, isTrue);
      expect(controller.locked, isTrue);
      await controller.evaluateHealth(
        repo.account,
        isReviewCurrent: () => true,
      );
      await controller.submit(recover: true);
      expect(repo.evaluations, hasLength(1));
      expect(repo.recordWrites, 0);
      store.replaceRead = false;
      await controller.reload();
      await controller.recoverHealth();
      expect(
        controller.acceptedHealthIntent!.requestSha256,
        pending.requestSha256,
      );
      expect(controller.pendingHealth, isNull);
      expect(repo.evaluations, hasLength(1));
    }
  });

  test('accepted B survives older accepted A when B local settlement did not commit', () async {
    final repo = HealthRepository(await healthAccount()),
        store = _UnknownHealthSave(accepted: true)..lose = false;
    final controller = healthController(repo, store);
    addTearDown(controller.dispose);
    await controller.bind(accountWorkspace);
    await controller.evaluateHealth(repo.account, isReviewCurrent: () => true);
    final acceptedA = controller.acceptedHealthIntent!;
    store.lose = true;
    await controller.evaluateHealth(repo.account, isReviewCurrent: () => true);
    final acceptedB = controller.acceptedHealthIntent!;
    expect(acceptedA.requestSha256, isNot(acceptedB.requestSha256));
    expect(controller.storageUnconfirmed, isTrue);
    final before =
        (await store.read(healthOwner, accountWorkspace))!['health'] as Map;
    expect(
      (before['pending'] as Map)['requestSha256'],
      acceptedB.requestSha256,
    );
    expect(
      (before['acceptedIntent'] as Map)['requestSha256'],
      acceptedA.requestSha256,
    );
    await controller.reload();
    expect(
      controller.acceptedHealthIntent!.requestSha256,
      acceptedB.requestSha256,
    );
    expect(
      controller.acceptedHealth!.acceptance!['requestSha256'],
      acceptedB.requestSha256,
    );
    expect(controller.pendingHealth, isNull);
    expect(controller.storageUnconfirmed, isTrue);
    await controller.settleHealthLocally();
    final after =
        (await store.read(healthOwner, accountWorkspace))!['health'] as Map;
    expect(
      (after['acceptedIntent'] as Map)['requestSha256'],
      acceptedB.requestSha256,
    );
    expect(after['pending'], isNull);
    expect(controller.storageUnconfirmed, isFalse);
    expect(repo.evaluations, hasLength(2));
    expect(repo.recoveries, isEmpty);
  });

  test('mounted owner replacement hides a held evaluation and rejects its late receipt', () async {
    final repo = HealthRepository(await healthAccount())
          ..heldEvaluation = Completer<AccountHealthRead>(),
        store = MemoryAccountsRecoveryStore();
    final controller = AccountsController(
      repo,
      accountId: customerId,
      active: true,
      recovery: store,
    );
    addTearDown(controller.dispose);
    await controller.refreshCore();
    final sent = Completer<AccountHealthIntent>();
    repo.beforeEvaluate = (intent) async => sent.complete(intent);
    final operation = controller.actions!.evaluateHealth(
      repo.account,
      isReviewCurrent: () => true,
    );
    final intent = await sent.future;
    repo.access.update(
      AccountsOwner(
        userId: accountOtherUser,
        tenantId: accountTenant,
        actorId: 'other@example.test',
        role: 'admin',
        apiScope: accountApi,
      ),
      available: true,
    );
    repo.heldEvaluation!.complete(
      await AccountHealthRead.parse(
        await healthResponse(intent),
        intent,
        mutation: true,
      ),
    );
    await operation;
    expect(controller.detail.value, isNull);
    expect(controller.actions!.acceptedHealth, isNull);
    expect(controller.actions!.pendingHealth, isNull);
    expect(
      ((await store.read(healthOwner, accountWorkspace))!['health']
          as Map)['pending'],
      isNotNull,
    );
  });

  test('closing review after protected save records no dispatch and preserves its identity', () async {
    var reviewed = true;
    final repo = HealthRepository(await healthAccount()),
        store = _AfterHealthSave(() => reviewed = false);
    final controller = healthController(repo, store);
    addTearDown(controller.dispose);
    await controller.bind(accountWorkspace);
    await controller.evaluateHealth(
      repo.account,
      isReviewCurrent: () => reviewed,
    );
    expect(repo.evaluations, isEmpty);
    expect(controller.pendingHealth, isNull);
    expect(controller.healthDisposition!['response'], isNull);
    final saved = (await store.read(healthOwner, accountWorkspace))!;
    expect((saved['health'] as Map)['pending'], isNull);
    expect(
      ((saved['health'] as Map)['disposition'] as Map)['intent'],
      isNotNull,
    );
    expect(controller.busy, isFalse);
  });
}

class _ControlledHealthRead extends MemoryAccountsRecoveryStore {
  bool replaceRead = false;
  AccountJson? replacement;
  @override
  Future<AccountJson?> read(AccountsOwner owner, String workspace) async {
    if (replaceRead) {
      return replacement;
    }
    return await super.read(owner, workspace);
  }
}

class _AfterHealthSave extends MemoryAccountsRecoveryStore {
  _AfterHealthSave(this.afterSave);
  final void Function() afterSave;
  @override
  Future<void> write(
    AccountsOwner owner,
    String workspace,
    AccountJson value, {
    required bool Function() isCurrent,
  }) async {
    await super.write(owner, workspace, value, isCurrent: isCurrent);
    if ((value['health'] as Map?)?['pending'] != null) {
      afterSave();
    }
  }
}

class _UnknownHealthSave extends MemoryAccountsRecoveryStore {
  _UnknownHealthSave({this.accepted = false});
  final bool accepted;
  bool lose = true;
  @override
  Future<void> write(
    AccountsOwner owner,
    String workspace,
    AccountJson value, {
    required bool Function() isCurrent,
  }) async {
    final health = value['health'] as Map?;
    final savedAcceptance = health == null ? null : health['accepted'];
    final savedPending = health == null ? null : health['pending'];
    if (lose &&
        (accepted
            ? savedAcceptance != null && savedPending == null
            : savedPending != null)) {
      lose = false;
      if (!accepted) {
        await super.write(owner, workspace, value, isCurrent: isCurrent);
      }
      throw StateError('Acknowledgement lost');
    }
    await super.write(owner, workspace, value, isCurrent: isCurrent);
  }
}
