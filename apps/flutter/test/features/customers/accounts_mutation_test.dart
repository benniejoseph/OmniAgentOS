import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_mutation_contracts.dart';
import 'package:asael/features/customers/accounts_mutation_controller.dart';
import 'package:asael/features/customers/accounts_recovery_store.dart';
import 'package:asael/features/customers/accounts_repository.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_test_support.dart';

void main() {
  test('accepted revision must prove the exact canonical owner and submitted fields', () async {
    final intent = await AccountMutationIntent.prepare(
      accountOwner(role: 'admin'),
      accountWorkspace,
      'original-account-request',
      _fields,
    );
    final response = await _response(intent);
    expect(
      (await AccountMutationReceipt.parse(response, intent)).account.name,
      'Reviewed Account',
    );
    final other = await AccountMutationIntent.prepare(
      accountOwner(role: 'admin'),
      accountWorkspace,
      'different-request',
      _fields,
    );
    await expectLater(
      AccountMutationReceipt.parse(response, other),
      throwsFormatException,
    );
    final changed = await AccountMutationIntent.prepare(
      accountOwner(role: 'admin'),
      accountWorkspace,
      intent.key,
      {..._fields, 'name': 'Unreviewed replacement'},
    );
    await expectLater(
      AccountMutationReceipt.parse(response, changed),
      throwsFormatException,
    );
  });

  test('lost response survives replacement and retries only the original saved request', () async {
    final repository = _MutationRepository(),
        store = MemoryAccountsRecoveryStore();
    final first = _controller(repository, store);
    await first.bind(accountWorkspace);
    first.begin();
    first.edit(_fields);
    await first.submit();
    expect(first.pending, isNotNull);
    final key = first.pending!.key;
    expect(repository.requests, hasLength(1));
    first.dispose();
    final restored = _controller(repository, store);
    addTearDown(restored.dispose);
    await restored.bind(accountWorkspace);
    expect(restored.pending!.key, key);
    expect(repository.requests, hasLength(1));
    await restored.submit();
    expect(repository.requests, hasLength(1));
    await restored.submit(recover: true);
    expect(repository.requests.map((intent) => intent.key), [key, key]);
    expect(restored.accepted!.account.name, 'Reviewed Account');
    expect(restored.pending, isNull);
  });

  test(
    'an unknown durable save sends no HTTP and reload never auto-dispatches',
    () async {
      final repository = _MutationRepository(), store = _LostSave();
      final controller = _controller(repository, store);
      addTearDown(controller.dispose);
      await controller.bind(accountWorkspace);
      controller.begin();
      controller.edit(_fields);
      await controller.submit();
      expect(controller.storageUnconfirmed, isTrue);
      expect(repository.requests, isEmpty);
      final key = controller.pending!.key;
      await controller.reload();
      expect(controller.storageUnconfirmed, isFalse);
      expect(controller.pending!.key, key);
      expect(repository.requests, isEmpty);
    },
  );
}

final AccountJson _fields = {
  'name': 'Reviewed Account',
  'lifecycle': 'prospect',
  'organizationEntityId': null,
  'accountOwner': {
    'ownerKind': 'actor',
    'ownerId': 'actor:$accountUser',
    'displayName': 'Reviewed owner',
  },
  'customerDataPurposeIds': [
    'customer_success.account.manage',
    'customer_success.account.read',
  ],
};

AccountsMutationController _controller(
  _MutationRepository repository,
  AccountsRecoveryStore store,
) => AccountsMutationController(
  repository,
  store,
  isVisible: () => true,
  canManage: () => true,
);

class _MutationRepository extends TestAccountsRepository
    implements AccountsMutationRepository {
  _MutationRepository() {
    access.update(accountOwner(role: 'admin'), available: true);
  }
  final requests = <AccountMutationIntent>[];
  @override
  Future<AccountMutationReceipt> mutate(
    AccountMutationIntent intent, {
    required bool Function() isCurrent,
  }) async {
    expect(isCurrent(), isTrue);
    requests.add(intent);
    if (requests.length == 1) {
      throw StateError('Acknowledgement lost after commit');
    }
    return AccountMutationReceipt.parse(await _response(intent), intent);
  }
}

class _LostSave extends MemoryAccountsRecoveryStore {
  bool lose = true;
  @override
  Future<void> write(
    AccountsOwner owner,
    String workspace,
    AccountJson value, {
    required bool Function() isCurrent,
  }) async {
    await super.write(owner, workspace, value, isCurrent: isCurrent);
    if (lose && value['pending'] != null) {
      lose = false;
      throw StateError('Storage acknowledgement lost');
    }
  }
}

Future<AccountJson> _response(AccountMutationIntent intent) async {
  final account = await sealAccount({
    ...await accountRevision(id: intent.accountId),
    'name': intent.fields['name'],
    'lifecycle': intent.fields['lifecycle'],
    'accountOwner': intent.fields['accountOwner'],
    'mutationId': intent.mutationId,
    'ownerActorId': 'actor:${intent.owner.userId}',
    'revisedByActorId': 'actor:${intent.owner.userId}',
  }, 'accountSha256');
  final acceptance = await sealAccount({
    'schemaVersion': 1,
    'contract': 'customer-account-mutation-acceptance:1',
    'operation': 'account.create',
    'tenantId': accountTenant,
    'workspaceId': accountWorkspace,
    'accountId': intent.accountId,
    'mutationId': intent.mutationId,
    'canonicalActorId': 'actor:${intent.owner.userId}',
    'idempotencyKeySha256': intent.identity['idempotencyKeySha256'],
    'requestSha256': intent.requestSha256,
    'revisionId': account['revisionId'],
    'revision': 1,
    'accountSha256': account['accountSha256'],
    'acceptedAt': accountStamp,
  }, 'acceptanceSha256');
  final body = {
    'context': {
      ...accountContext(),
      'canWrite': true,
      'accessLevel': 'manager',
    },
    'account': account,
    'acceptance': acceptance,
  };
  return {
    ...body,
    'serviceReceipt': await sealAccount({
      'schemaVersion': 1,
      'receiptKind': 'app_service_receipt',
      'boundaryVersion': accountBoundary,
      'operation': 'app.customer_accounts.create',
      'action': 'manage.workflow',
      'resourceType': 'customer_account',
      'accessMode': 'mutation',
      'eventContract': 'customer-account-events.v1',
      'authoritySha256': await intent.authorityHash(),
      'idempotencyKeySha256': intent.identity['idempotencyKeySha256'],
      'outcomeSha256': await accountSha(body),
      'resourceCount': 1,
      'occurredAt': accountStamp,
    }, 'receiptSha256'),
  };
}
