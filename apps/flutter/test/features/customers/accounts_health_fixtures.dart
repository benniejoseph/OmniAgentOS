import 'dart:async';

import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_health_contracts.dart';
import 'package:asael/features/customers/accounts_mutation_contracts.dart';
import 'package:asael/features/customers/accounts_repository.dart';
import 'package:dio/dio.dart';

import 'accounts_test_support.dart';

final healthOwner = accountOwner(role: 'admin');
AccountJson healthContext() => {
  ...accountContext(),
  'accessLevel': 'manager',
  'canWrite': true,
};
Future<CustomerAccountSummary> healthAccount({int revision = 1}) async {
  final raw = await sealAccount({
    ...await accountRevision(revision: revision),
    'ownerActorId': 'actor:$accountUser',
    'revisedByActorId': 'actor:$accountUser',
  }, 'accountSha256');
  return CustomerAccountSummary.parse(raw, healthOwner, accountWorkspace);
}

Future<CustomerDetail> healthDetail(CustomerAccountSummary account) async =>
    CustomerDetail.parse(
      await accountEnvelope(
        {
          'context': healthContext(),
          'account': {
            'account': account.raw,
            'facts': <Object>[],
            'factsByKind': {for (final kind in accountKinds) kind: <Object>[]},
            'historyCount': account.revision,
            'conflictCount': 0,
            'staleCount': 0,
            'evaluatedAt': accountStamp,
          },
        },
        'app.customer_accounts.show',
        1,
        owner: healthOwner,
      ),
      healthOwner,
      account.id,
      workspaceId: accountWorkspace,
    );

Future<AccountJson> healthAcceptance(AccountHealthIntent intent) async {
  final scoreId =
      'customer-health-score:${await accountSha({'tenantId': intent.owner.tenantId, 'workspaceId': intent.workspaceId, 'accountId': intent.accountId})}';
  return sealAccount({
    'schemaVersion': 1,
    'contract': 'customer-health-evaluation-acceptance:1',
    'operation': 'health.evaluate',
    'tenantId': intent.owner.tenantId,
    'workspaceId': intent.workspaceId,
    'accountId': intent.accountId,
    'canonicalActorId': 'actor:${intent.owner.userId}',
    'evaluationId': intent.evaluationId,
    'idempotencyKeySha256': intent.identity['idempotencyKeySha256'],
    'requestSha256': intent.requestSha256,
    'accountRevisionId': '${intent.accountId}:v${intent.accountRevision}',
    'accountRevision': intent.accountRevision,
    'accountSha256': intent.accountSha256,
    'scoreId': scoreId,
    'scoreRevisionId': '$scoreId:v1',
    'scoreRevision': 1,
    'scoreSha256': 'b' * 64,
    'policyId': 'customer-health-policy:${'c' * 64}',
    'policySha256': 'c' * 64,
    'inputSha256': 'd' * 64,
    'scoreBasisPoints': null,
    'status': 'unknown',
    'confidenceBasisPoints': 0,
    'coverageBasisPoints': 0,
    'authority': 'deterministic_policy',
    'acceptedAt': accountStamp,
  }, 'acceptanceSha256');
}

Future<AccountJson> healthResponse(
  AccountHealthIntent intent, {
  bool mutation = true,
  bool replayed = false,
  bool found = true,
  CustomerAccountSummary? current,
  AccountJson? acceptance,
}) async {
  final body = <String, dynamic>{
    'contract': accountHealthReadContract,
    'context': healthContext(),
    'currentAccount': {
      'accountId': intent.accountId,
      'revisionId':
          current?.revisionId ??
          '${intent.accountId}:v${intent.accountRevision}',
      'revision': current?.revision ?? intent.accountRevision,
      'accountSha256': current?.sha256 ?? intent.accountSha256,
    },
    'acceptance': found ? acceptance ?? await healthAcceptance(intent) : null,
    if (mutation) 'replayed': replayed,
  };
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': accountBoundary,
    'operation': mutation
        ? 'app.customer_accounts.health.evaluate'
        : 'app.customer_accounts.health.evaluations.show',
    'action': mutation ? 'manage.workflow' : 'read',
    'resourceType': 'customer_health_score',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? 'customer-health-events.v1'
        : 'read_only:no_domain_mutation',
    'authoritySha256': mutation
        ? await intent.authorityHash()
        : await accountSha({
            'boundaryVersion': accountBoundary,
            'tenantId': intent.owner.tenantId,
            'actorId': intent.owner.actorId,
            'role': intent.owner.role,
            'executionScope': null,
          }),
    'idempotencyKeySha256': mutation
        ? intent.identity['idempotencyKeySha256']
        : null,
    'outcomeSha256': await accountSha(body),
    'resourceCount': found ? 1 : 0,
    'occurredAt': accountStamp,
  };
  return {
    ...body,
    'serviceReceipt': await sealAccount(receipt, 'receiptSha256'),
  };
}

AccountJson healthRefusal(AccountHealthIntent intent) => {
  'contract': 'customer-health-evaluation-refusal:1',
  'error': 'Account changed.',
  'code': 'customer_health_account_changed',
  'admission': 'not_admitted',
  'evaluationId': intent.evaluationId,
  'requestSha256': intent.requestSha256,
};

class HealthRepository extends TestAccountsRepository
    implements AccountsHealthRepository, AccountsMutationRepository {
  HealthRepository(this.account);
  CustomerAccountSummary account;
  @override
  AccountsAccess get access => _healthAccess;
  final _healthAccess = AccountsAccess(
    owner: healthOwner,
    ready: true,
    operations: const {
      'customers.list',
      'customers.get',
      'customers.health',
      'customers.create',
      'customers.update',
      'customers.health.evaluate',
      'customers.health.evaluations.get',
    },
  );
  final evaluations = <AccountHealthIntent>[],
      recoveries = <AccountHealthIntent>[];
  int recordWrites = 0;
  bool found = true;
  Object? writeFailure, readFailure;
  Completer<CustomerDetail>? heldDetail;
  Completer<AccountHealthRead>? heldEvaluation;
  Future<void> Function(AccountHealthIntent)? beforeEvaluate;
  @override
  Future<CustomerDetail> detail(
    String id,
    CancelToken cancel, {
    String? workspaceId,
  }) async {
    detailCalls++;
    return heldDetail == null ? healthDetail(account) : heldDetail!.future;
  }

  @override
  Future<AccountHealthRead> evaluateHealth(
    AccountHealthIntent intent, {
    required bool Function() isCurrent,
  }) async {
    await beforeEvaluate?.call(intent);
    accountRequire(isCurrent());
    evaluations.add(intent);
    if (writeFailure != null) {
      throw writeFailure!;
    }
    return heldEvaluation == null
        ? AccountHealthRead.parse(
            await healthResponse(intent),
            intent,
            mutation: true,
          )
        : heldEvaluation!.future;
  }

  @override
  Future<AccountHealthRead> readHealthEvaluation(
    AccountHealthIntent intent,
    CancelToken cancel,
  ) async {
    recoveries.add(intent);
    if (readFailure != null) {
      throw readFailure!;
    }
    return AccountHealthRead.parse(
      await healthResponse(
        intent,
        mutation: false,
        found: found,
        current: account,
      ),
      intent,
      mutation: false,
    );
  }

  @override
  Future<AccountMutationReceipt> mutate(
    AccountMutationIntent intent, {
    required bool Function() isCurrent,
  }) {
    recordWrites++;
    throw StateError('No record write expected in a health test.');
  }
}
