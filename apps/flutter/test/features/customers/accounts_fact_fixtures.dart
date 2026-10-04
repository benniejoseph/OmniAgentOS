import 'dart:async';

import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_fact_contracts.dart';
import 'package:asael/features/customers/accounts_repository.dart';
import 'package:dio/dio.dart';

import 'accounts_health_fixtures.dart';
import 'accounts_test_support.dart';

AccountJson factRequest(
  CustomerAccountSummary account, {
  String operation = 'create',
}) => {
  'contract': accountFactRequestContract,
  'workspaceId': accountWorkspace,
  'expectedAccountRevision': account.revision,
  'expectedAccountSha256': account.sha256,
  'operation': operation,
  'factId': operation == 'create' ? null : 'customer-fact:${'d' * 64}',
  'expectedFactRevision': operation == 'create' ? null : 1,
  'expectedFactSha256': operation == 'create' ? null : 'e' * 64,
  'factKey': 'manual.organization',
  'value': {
    'kind': 'organization',
    'entityId': 'organization:acme',
    'name': 'Acme assertion',
    'industry': null,
    'website': null,
  },
  'owner': account.raw['accountOwner'],
  'confidenceBasisPoints': 7500,
  'validFrom': accountStamp,
  'validTo': null,
  'staleAfter': null,
  'manualSource': {'label': 'Owner conversation', 'observedAt': accountStamp},
  'allowedPurposeIds': ['customer_success.account.read'],
};
Future<AccountJson> factAcceptance(AccountFactIntent intent) async {
  final request = intent.request,
      revision = (intent.request['expectedFactRevision'] as int? ?? 0) + 1;
  return sealAccount({
    'schemaVersion': 1,
    'contract': 'customer-fact-mutation-acceptance:1',
    'operation': request['operation'],
    'tenantId': intent.owner.tenantId,
    'workspaceId': intent.workspaceId,
    'accountId': intent.accountId,
    'canonicalActorId': 'actor:${intent.owner.userId}',
    'idempotencyKeySha256': intent.identity['idempotencyKeySha256'],
    'requestSha256': intent.requestSha256,
    'mutationId': intent.identity['mutationId'],
    'factId': intent.factId,
    'factRevisionId': '${intent.factId}:v$revision',
    'factRevision': revision,
    'factSha256': 'f' * 64,
    'factKey': request['factKey'],
    'kind': request['value']['kind'],
    'state': request['operation'] == 'retract' ? 'retracted' : 'active',
    'valueSha256': await accountSha(request['value']),
    'reviewedAccountRevisionId':
        '${intent.accountId}:v${request['expectedAccountRevision']}',
    'reviewedAccountRevision': request['expectedAccountRevision'],
    'reviewedAccountSha256': request['expectedAccountSha256'],
    'expectedFactRevision': request['expectedFactRevision'],
    'expectedFactSha256': request['expectedFactSha256'],
    'sourceRevisionId': 'customer-manual-source:${intent.requestSha256}:v1',
    'sourceRevisionSha256': await accountSha({
      'contract': 'customer-manual-source:1',
      'tenantId': intent.owner.tenantId,
      'workspaceId': intent.workspaceId,
      'accountId': intent.accountId,
      'canonicalActorId': 'actor:${intent.owner.userId}',
      'requestSha256': intent.requestSha256,
    }),
    'sourceKind': 'manual',
    'permissionBasis': 'operator_assertion',
    'recordedAt': accountStamp,
  }, 'acceptanceSha256');
}

Future<AccountJson> factResponse(
  AccountFactIntent intent, {
  bool mutation = true,
  bool found = true,
  CustomerAccountSummary? current,
}) async {
  final body = {
    'contract': accountFactReadContract,
    'context': healthContext(),
    'currentAccount': {
      'accountId': intent.accountId,
      'revisionId':
          current?.revisionId ??
          '${intent.accountId}:v${intent.request['expectedAccountRevision']}',
      'revision':
          current?.revision ?? intent.request['expectedAccountRevision'],
      'accountSha256':
          current?.sha256 ?? intent.request['expectedAccountSha256'],
    },
    'acceptance': found ? await factAcceptance(intent) : null,
    if (mutation) 'replayed': false,
  };
  final proof = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': accountBoundary,
    'operation': mutation
        ? 'app.customer_accounts.facts.record'
        : 'app.customer_accounts.facts.mutations.show',
    'action': mutation ? 'manage.workflow' : 'read',
    'resourceType': 'customer_account_fact',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? 'customer-account-events.v1'
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
  return {...body, 'serviceReceipt': await sealAccount(proof, 'receiptSha256')};
}

class FactRepository extends HealthRepository
    implements AccountsFactRepository {
  FactRepository(super.account);
  final _factAccess = AccountsAccess(
    owner: healthOwner,
    ready: true,
    operations: const {
      'customers.list',
      'customers.get',
      'customers.create',
      'customers.update',
      'customers.facts.record',
      'customers.facts.acceptance.get',
    },
  );
  @override
  AccountsAccess get access => _factAccess;
  final writes = <AccountFactIntent>[], reads = <AccountFactIntent>[];
  bool loseFactResponse = false, foundFact = true;
  Future<void> Function(AccountFactIntent)? beforeFact;
  Completer<CustomerDetail>? factDetailGate;
  @override
  Future<CustomerDetail> detail(
    String id,
    CancelToken cancel, {
    String? workspaceId,
  }) async =>
      factDetailGate == null ? healthDetail(account) : factDetailGate!.future;
  @override
  Future<AccountFactAcceptance> mutateFact(
    AccountFactIntent intent, {
    required bool Function() isCurrent,
  }) async {
    await beforeFact?.call(intent);
    accountRequire(isCurrent());
    writes.add(intent);
    if (loseFactResponse) {
      throw StateError('Response lost after commit.');
    }
    return AccountFactAcceptance.parse(
      await factResponse(intent),
      intent,
      mutation: true,
    );
  }

  @override
  Future<AccountFactAcceptance> readFactAcceptance(
    AccountFactIntent intent,
    CancelToken cancel,
  ) async {
    reads.add(intent);
    return AccountFactAcceptance.parse(
      await factResponse(
        intent,
        mutation: false,
        found: foundFact,
        current: account,
      ),
      intent,
      mutation: false,
    );
  }
}
