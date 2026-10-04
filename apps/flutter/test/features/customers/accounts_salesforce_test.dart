import 'dart:async';

import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_mutation_controller.dart';
import 'package:asael/features/customers/accounts_recovery_store.dart';
import 'package:asael/features/customers/accounts_salesforce_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_health_fixtures.dart';
import 'accounts_salesforce_fixtures.dart';
import 'accounts_test_support.dart';

AccountsMutationController controllerFor(
  SalesforceRepository repo,
  AccountsRecoveryStore store,
) => AccountsMutationController(
  repo,
  store,
  isVisible: () => true,
  canManage: () => true,
);

void main() {
  test('strict action receipts bind the exact key and reviewed generation; local disconnect is separate from provider confirmation', () async {
    final review = await salesforceConnection();
    for (final action in accountSalesforceActions) {
      final intent = await AccountSalesforceIntent.prepare(
        healthOwner,
        accountWorkspace,
        'action-$action',
        action,
        review,
      );
      final raw = await salesforceResponse(intent: intent, kind: 'mutation');
      final parsed = await AccountSalesforceRead.parse(
        raw,
        healthOwner,
        accountWorkspace,
        kind: 'mutation',
        intent: intent,
      );
      expect(parsed.settled, isTrue);
      if (action == 'disconnect') {
        expect(parsed.action!['acceptance']['localRevoked'], isTrue);
        expect(
          parsed.action!['settlement']['providerRevocation'],
          'unconfirmed',
        );
      }
      for (final changed in [
        await AccountSalesforceIntent.prepare(
          healthOwner,
          accountWorkspace,
          'different-key',
          action,
          review,
        ),
        await AccountSalesforceIntent.prepare(
          healthOwner,
          accountWorkspace,
          'action-$action',
          action,
          await salesforceConnection(generation: 2),
        ),
      ]) {
        await expectLater(
          AccountSalesforceRead.parse(
            raw,
            healthOwner,
            accountWorkspace,
            kind: 'mutation',
            intent: changed,
          ),
          throwsFormatException,
        );
      }
    }
  });

  test('schema5 saves one shared pending slot before POST; unknown and admitted receipts recover by GET until settled', () async {
    final repo = SalesforceRepository(await healthAccount())
          ..loseResponse = true,
        store = MemoryAccountsRecoveryStore();
    final controller = controllerFor(repo, store);
    await controller.bind(accountWorkspace);
    repo.beforeWrite = (intent) async {
      final journal = (await store.read(healthOwner, accountWorkspace))!;
      expect(journal['schemaVersion'], 5);
      expect(
        journal['salesforce']['pending']['requestSha256'],
        intent.requestSha256,
      );
      for (final section in ['health', 'workflow', 'fact']) {
        expect(journal.containsKey(section), isTrue);
      }
    };
    await controller.submitSalesforceAction(
      'sync',
      await salesforceConnection(),
      isReviewCurrent: () => true,
    );
    final held = controller.salesforceState.pending!;
    controller.dispose();
    final restored = controllerFor(repo, store);
    await restored.bind(accountWorkspace);
    expect(restored.salesforceState.pending!.requestSha256, held.requestSha256);
    repo.found = false;
    await restored.recoverSalesforceAction();
    expect(restored.salesforceState.pending!.requestSha256, held.requestSha256);
    repo.found = true;
    repo.settled = false;
    await restored.recoverSalesforceAction();
    expect(restored.salesforceState.observed!.settled, isFalse);
    expect(restored.locked, isTrue);
    await restored.submitSalesforceAction(
      'reconcile',
      await salesforceConnection(),
      isReviewCurrent: () => true,
    );
    repo.settled = true;
    await restored.recoverSalesforceAction();
    expect(restored.salesforceState.pending, isNull);
    expect(restored.salesforceState.observed!.settled, isTrue);
    expect(repo.writes, hasLength(1));
    expect(repo.reads, hasLength(3));
    restored.dispose();
  });

  test('settlement saved with a lost acknowledgment reloads exact receipt; older stored receipt cannot replace known B', () async {
    for (final commits in [false, true]) {
      final repo = SalesforceRepository(await healthAccount()),
          store = _AmbiguousSalesforceStore();
      final controller = controllerFor(repo, store);
      await controller.bind(accountWorkspace);
      await controller.submitSalesforceAction(
        'sync',
        await salesforceConnection(),
        isReviewCurrent: () => true,
      );
      final a = controller.salesforceState.observedIntent!.requestSha256;
      store.fail = true;
      store.commitBeforeThrow = commits;
      await controller.submitSalesforceAction(
        'reconcile',
        await salesforceConnection(),
        isReviewCurrent: () => true,
      );
      final b = controller.salesforceState.observedIntent!.requestSha256;
      expect(a, isNot(b));
      expect(controller.storageUnconfirmed, isTrue);
      store.fail = false;
      await controller.reload();
      expect(controller.salesforceState.observedIntent!.requestSha256, b);
      expect(controller.salesforceState.pending, isNull);
      if (controller.salesforceState.needsLocalSave) {
        await controller.settleSalesforceLocally();
      }
      expect(controller.storageUnconfirmed, isFalse);
      expect(repo.writes, hasLength(2));
      expect(repo.reads, isEmpty);
      controller.dispose();
    }
  });

  test('absent or different protected pending identity remains held; closing delayed review sends nothing', () async {
    final repo = SalesforceRepository(await healthAccount())
          ..loseResponse = true,
        store = _AmbiguousSalesforceStore();
    final controller = controllerFor(repo, store);
    await controller.bind(accountWorkspace);
    await controller.submitSalesforceAction(
      'sync',
      await salesforceConnection(),
      isReviewCurrent: () => true,
    );
    final original = controller.salesforceState.pending!;
    final saved = (await store.read(healthOwner, accountWorkspace))!;
    store.missing = true;
    await controller.reload();
    expect(
      controller.salesforceState.pending!.requestSha256,
      original.requestSha256,
    );
    expect(controller.storageUnconfirmed, isTrue);
    store.missing = false;
    final other = await AccountSalesforceIntent.prepare(
      healthOwner,
      accountWorkspace,
      'other-key',
      'sync',
      await salesforceConnection(),
    );
    await store.write(healthOwner, accountWorkspace, {
      ...saved,
      'salesforce': {
        'pending': other.stored,
        'observedIntent': null,
        'observed': null,
        'notSubmitted': null,
      },
    }, isCurrent: () => true);
    await controller.reload();
    expect(
      controller.salesforceState.pending!.requestSha256,
      original.requestSha256,
    );
    expect(controller.storageUnconfirmed, isTrue);
    expect(repo.writes, hasLength(1));
    controller.dispose();

    final delayed = SalesforceRepository(await healthAccount()),
        gate = Completer<AccountSalesforceRead>();
    delayed.reviewGate = gate;
    final closed = controllerFor(delayed, MemoryAccountsRecoveryStore());
    await closed.bind(accountWorkspace);
    var visible = true;
    final task = closed.submitSalesforceAction(
      'sync',
      await salesforceConnection(),
      isReviewCurrent: () => visible,
    );
    visible = false;
    gate.complete(
      await AccountSalesforceRead.parse(
        await salesforceResponse(),
        healthOwner,
        accountWorkspace,
        kind: 'review',
      ),
    );
    await task;
    expect(delayed.writes, isEmpty);
    expect(closed.salesforceState.pending, isNull);
    closed.dispose();
  });
}

class _AmbiguousSalesforceStore extends MemoryAccountsRecoveryStore {
  bool fail = false, commitBeforeThrow = false, missing = false;
  @override
  Future<AccountJson?> read(AccountsOwner owner, String workspace) =>
      missing ? Future.value() : super.read(owner, workspace);
  @override
  Future<void> write(
    AccountsOwner owner,
    String workspace,
    AccountJson value, {
    required bool Function() isCurrent,
  }) async {
    final action = value['salesforce'] as Map?;
    final settlement =
        fail && action?['pending'] == null && action?['observed'] != null;
    if (settlement && !commitBeforeThrow) {
      throw StateError('Settlement save unavailable');
    }
    await super.write(owner, workspace, value, isCurrent: isCurrent);
    if (settlement) {
      throw StateError('Settlement committed; acknowledgment lost');
    }
  }
}
