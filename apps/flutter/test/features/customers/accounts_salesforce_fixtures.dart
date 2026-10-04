import 'dart:async';

import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_repository.dart';
import 'package:asael/features/customers/accounts_salesforce_contracts.dart';
import 'package:dio/dio.dart';

import 'accounts_health_fixtures.dart';
import 'accounts_test_support.dart';

Future<AccountJson> salesforceConnection({int generation = 1}) => sealAccount({
  'tenantId': accountTenant,
  'workspaceId': accountWorkspace,
  'ownerActorId': 'actor:$accountUser',
  'connectionId': 'salesforce-connection:${'a' * 64}',
  'oauthGrantId': 'grant:one',
  'authorizationGeneration': generation,
  'organizationIdSha256': 'b' * 64,
  'instanceOrigin': 'https://example.my.salesforce.com',
  'connectionState': 'active',
  'grantStatus': 'active',
  'grantAuthorizationGeneration': generation,
  'readScopesGranted': true,
}, 'reviewSha256');

Future<AccountJson> salesforceAction(
  AccountSalesforceIntent intent, {
  bool settled = true,
}) async {
  final acceptance = await sealAccount({
    'contract': 'customer-salesforce-action-acceptance:1',
    'id':
        'salesforce-action:${await accountSha({'contract': 'customer-salesforce-action-id:1', 'scope': intent.identity['scope'], 'idempotencyKeySha256': intent.keySha256})}',
    'scope': intent.identity['scope'],
    'action': intent.action,
    'idempotencyKeySha256': intent.keySha256,
    'requestSha256': intent.requestSha256,
    'review': intent.review,
    'acceptedAt': accountStamp,
    'localRevoked': intent.action == 'disconnect',
  }, 'acceptanceSha256');
  final outcome = switch (intent.action) {
    'sync' => <String, dynamic>{
      'action': 'sync',
      'status': 'partial',
      'pages': 8,
      'records': 3,
      'advanced': 2,
      'conflicts': 1,
      'projection': {'examined': 3, 'projected': 1, 'held': 1, 'failed': 1},
      'settledAt': accountStamp,
    },
    'reconcile' => <String, dynamic>{
      'action': 'reconcile',
      'status': 'complete',
      'checked': 3,
      'findings': 1,
      'settledAt': accountStamp,
    },
    _ => <String, dynamic>{
      'action': 'disconnect',
      'status': 'local_revoked',
      'providerRevocation': 'unconfirmed',
      'settledAt': accountStamp,
    },
  };
  return {
    'acceptance': acceptance,
    'state': settled ? 'settled' : 'accepted',
    'settlement': settled ? outcome : null,
  };
}

Future<AccountJson> salesforceResponse({
  AccountSalesforceIntent? intent,
  String kind = 'review',
  bool found = true,
  bool settled = true,
  AccountJson? connection,
}) async {
  final action = kind == 'review' || !found
      ? null
      : await salesforceAction(intent!, settled: settled);
  final review = connection ?? await salesforceConnection();
  final body = <String, dynamic>{
    'contract': accountSalesforceReadContract,
    'context': healthContext(),
    'current': {
      'connection': review,
      'availableActions': action?['state'] == 'accepted'
          ? <String>[]
          : accountSalesforceActions,
      'blockedAction': action?['state'] == 'accepted' ? action : null,
      'busy': false,
    },
    'action': action,
    if (kind == 'mutation') 'replayed': false,
  };
  final mutation = kind == 'mutation';
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': accountBoundary,
    'operation':
        'app.customer_accounts.salesforce.actions.${mutation
            ? 'submit'
            : kind == 'review'
            ? 'review'
            : 'show'}',
    'action': mutation ? 'manage.connector' : 'read',
    'resourceType': 'salesforce_connection',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? 'customer-salesforce-events.v1'
        : 'read_only:no_domain_mutation',
    'authoritySha256': mutation
        ? await intent!.authorityHash()
        : await accountSha({
            'boundaryVersion': accountBoundary,
            'tenantId': healthOwner.tenantId,
            'actorId': healthOwner.actorId,
            'role': healthOwner.role,
            'executionScope': null,
          }),
    'idempotencyKeySha256': mutation ? intent!.keySha256 : null,
    'outcomeSha256': await accountSha(body),
    'resourceCount': kind == 'review' || action != null ? 1 : 0,
    'occurredAt': accountStamp,
  };
  return {
    ...body,
    'serviceReceipt': await sealAccount(receipt, 'receiptSha256'),
  };
}

class SalesforceRepository extends HealthRepository
    implements AccountsSalesforceRepository {
  SalesforceRepository(super.account);
  @override
  AccountsAccess get access => _salesforceAccess;
  final _salesforceAccess = AccountsAccess(
    owner: healthOwner,
    ready: true,
    operations: const {
      'customers.list',
      'customers.get',
      'customers.create',
      'customers.update',
      'customers.health',
      'customers.salesforce.actions.review',
      'customers.salesforce.actions.submit',
      'customers.salesforce.actions.get',
    },
  );
  final writes = <AccountSalesforceIntent>[],
      reads = <AccountSalesforceIntent>[];
  bool loseResponse = false, settled = true;
  Future<void> Function(AccountSalesforceIntent)? beforeWrite;
  Completer<AccountSalesforceRead>? reviewGate;
  @override
  Future<AccountSalesforceRead> reviewSalesforce(
    String workspace,
    CancelToken cancel,
  ) async => reviewGate == null
      ? AccountSalesforceRead.parse(
          await salesforceResponse(),
          healthOwner,
          workspace,
          kind: 'review',
        )
      : reviewGate!.future;
  @override
  Future<AccountSalesforceRead> submitSalesforce(
    AccountSalesforceIntent intent, {
    required bool Function() isCurrent,
  }) async {
    await beforeWrite?.call(intent);
    accountRequire(isCurrent());
    writes.add(intent);
    if (loseResponse) {
      throw StateError('Response lost after dispatch');
    }
    return AccountSalesforceRead.parse(
      await salesforceResponse(
        intent: intent,
        kind: 'mutation',
        settled: settled,
      ),
      healthOwner,
      accountWorkspace,
      kind: 'mutation',
      intent: intent,
    );
  }

  @override
  Future<AccountSalesforceRead> readSalesforceAction(
    AccountSalesforceIntent intent,
    CancelToken cancel,
  ) async {
    reads.add(intent);
    return AccountSalesforceRead.parse(
      await salesforceResponse(
        intent: intent,
        kind: 'read',
        found: found,
        settled: settled,
      ),
      healthOwner,
      accountWorkspace,
      kind: 'read',
      intent: intent,
    );
  }
}
