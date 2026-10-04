import 'dart:convert';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_repository.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const accountUser = '11111111-1111-4111-8111-111111111111';
const accountOtherUser = '22222222-2222-4222-8222-222222222222';
const accountTenant = 'tenant-one',
    accountWorkspace = 'workspace:tenant-one',
    accountApi = 'https://accounts.example.test';
const accountStamp = '2026-10-04T10:00:00.000Z';
final customerId = 'customer-account:${'a' * 64}',
    otherCustomerId = 'customer-account:${'b' * 64}';
AppSession accountSession({
  String user = accountUser,
  String role = 'viewer',
}) => AppSession(
  tenantId: accountTenant,
  actorId: 'reader@example.test',
  userId: user,
  email: 'reader@example.test',
  displayName: 'Reader',
  workspaceName: 'Workspace',
  role: role,
);
AccountsOwner accountOwner({String role = 'viewer'}) =>
    AccountsOwner.fromSession(accountSession(role: role), accountApi)!;
AccountJson cloneAccount(AccountJson row) =>
    Map<String, dynamic>.from(jsonDecode(jsonEncode(row)) as Map);
Future<AccountJson> sealAccount(AccountJson row, String field) async {
  final body = {...row}..remove(field);
  return {...body, field: await accountSha(body)};
}

AccountJson accountContext() => {
  'scope': 'workspace',
  'workspaceId': accountWorkspace,
  'accessLevel': 'reader',
  'canWrite': false,
  'authoritySha256': 'e' * 64,
};
Future<AccountJson> accountRevision({
  String? id,
  int revision = 1,
  String name = 'Acme customer',
}) => sealAccount({
  'schemaVersion': 1,
  'contractVersion': 'p10.9-customer-account-360:1',
  'ontologyVersionId': 'asael-ontology:1',
  'tenantId': accountTenant,
  'workspaceId': accountWorkspace,
  'accountId': id ?? customerId,
  'accountEntityId': id ?? customerId,
  'organizationEntityId': null,
  'revisionId': '${id ?? customerId}:v$revision',
  'revision': revision,
  'previousRevisionId': revision == 1
      ? null
      : '${id ?? customerId}:v${revision - 1}',
  'mutationId': 'customer-mutation:${'c' * 64}',
  'name': name,
  'lifecycle': 'active',
  'accountOwner': {
    'ownerKind': 'actor',
    'ownerId': 'actor:$accountOtherUser',
    'displayName': 'Other workspace member',
  },
  'crmPermissions': {
    'readScope': 'workspace_members',
    'writeScope': 'account_owner',
    'externalWriteState': 'disabled',
    'customerDataPurposeIds': [
      'customer_success.account.manage',
      'customer_success.account.read',
    ],
  },
  'ownerActorId': 'actor:$accountOtherUser',
  'revisedByActorId': 'actor:$accountOtherUser',
  'revisedAt': accountStamp,
}, 'accountSha256');
Future<AccountJson> accountFact({
  String suffix = 'd',
  String title = 'Review the sourced risk',
}) async {
  final id = 'customer-fact:${suffix * 64}',
      value = {
        'kind': 'risk',
        'entityId': 'risk:one',
        'title': title,
        'severity': 'high',
        'status': 'open',
      };
  return sealAccount({
    'schemaVersion': 1,
    'contractVersion': 'p10.9-customer-account-360:1',
    'ontologyVersionId': 'asael-ontology:1',
    'tenantId': accountTenant,
    'workspaceId': accountWorkspace,
    'accountId': customerId,
    'factId': id,
    'factRevisionId': '$id:v1',
    'revision': 1,
    'previousFactRevisionId': null,
    'mutationId': 'customer-mutation:${'f' * 64}',
    'factKey': 'risk.same-key',
    'kind': 'risk',
    'state': 'active',
    'value': value,
    'valueSha256': await accountSha(value),
    'source': {
      'sourceKind': 'manual',
      'sourceId': 'source:one',
      'sourceRevisionId': 'source:one:v1',
      'sourceRevisionSha256': 'b' * 64,
      'sourceLabel': 'Review source <script>text</script>',
      'providerId': null,
      'providerObjectType': null,
      'providerObjectIdSha256': null,
      'permissionBasis': 'operator_assertion',
      'allowedPurposeIds': ['customer_success.account.read'],
      'observedAt': accountStamp,
      'ingestedAt': accountStamp,
    },
    'owner': {
      'ownerKind': 'actor',
      'ownerId': 'actor:$accountOtherUser',
      'displayName': 'Other member',
    },
    'confidenceBasisPoints': 8500,
    'validFrom': accountStamp,
    'validTo': null,
    'staleAfter': null,
    'recordedByActorId': 'actor:$accountOtherUser',
    'recordedAt': accountStamp,
  }, 'factSha256');
}

Future<AccountJson> accountEnvelope(
  AccountJson data,
  String operation,
  int count, {
  AccountsOwner? owner,
}) async {
  final scope = owner ?? accountOwner();
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': accountBoundary,
    'operation': operation,
    'action': 'read',
    'resourceType': operation.endsWith('portfolio.show')
        ? 'customer_success_portfolio'
        : 'customer_account',
    'accessMode': 'read',
    'eventContract': 'read_only:no_domain_mutation',
    'authoritySha256': await accountSha({
      'boundaryVersion': accountBoundary,
      'tenantId': scope.tenantId,
      'actorId': scope.actorId,
      'role': scope.role,
      'executionScope': null,
    }),
    'idempotencyKeySha256': null,
    'outcomeSha256': await accountSha(data),
    'resourceCount': count,
    'occurredAt': accountStamp,
  };
  return {
    ...data,
    'serviceReceipt': await sealAccount(receipt, 'receiptSha256'),
  };
}

Future<AccountJson> accountListResponse({int revision = 1}) async =>
    accountEnvelope(
      {
        'context': accountContext(),
        'accounts': [await accountRevision(revision: revision)],
      },
      'app.customer_accounts.list',
      1,
    );
Future<AccountJson> accountDetailResponse({bool conflicts = false}) async {
  final facts = [
    await accountFact(),
    if (conflicts)
      await accountFact(suffix: 'e', title: 'Competing source value'),
  ];
  final views = [
    for (final fact in facts)
      {
        'fact': fact,
        'freshness': {
          'status': 'unknown',
          'observedAt': accountStamp,
          'staleAfter': null,
          'evaluatedAt': accountStamp,
        },
        'conflict': {
          'state': conflicts ? 'conflicting' : 'none',
          'conflictingFactIds': [
            for (final other in facts)
              if (other['factId'] != fact['factId']) other['factId'],
          ],
        },
      },
  ];
  return accountEnvelope(
    {
      'context': accountContext(),
      'account': {
        'account': await accountRevision(),
        'facts': views,
        'factsByKind': {
          for (final kind in accountKinds) kind: kind == 'risk' ? views : [],
        },
        'historyCount': facts.length + 1,
        'conflictCount': conflicts ? 2 : 0,
        'staleCount': 0,
        'evaluatedAt': accountStamp,
      },
    },
    'app.customer_accounts.show',
    1,
  );
}

Future<AccountJson> accountPortfolioResponse({int revision = 1}) async {
  final account = await accountRevision(revision: revision);
  final recommendation = await sealAccount({
    'policyVersion': 'p10.14-customer-success-intelligence:1',
    'recommendationId': 'customer-success-recommendation:${'a' * 64}',
    'action': 'monitor_account',
    'workflowId': null,
    'title': 'Inspect customer evidence',
    'reason': 'No evaluated health is available.',
    'confidenceBasisPoints': 0,
    'uncertainty': ['No current evaluation'],
    'evidence': [
      {
        'kind': 'account_revision',
        'refId': customerId,
        'revisionId': account['revisionId'],
        'sha256': account['accountSha256'],
        'observedAt': accountStamp,
        'label': 'Exact account',
      },
    ],
    'freshness': {
      'status': 'unknown',
      'oldestObservedAt': null,
      'evaluatedAt': accountStamp,
    },
    'authoritative': false,
    'suggested': true,
    'generatedAt': accountStamp,
  }, 'recommendationSha256');
  final portfolio = await sealAccount({
    'policyVersion': 'p10.14-customer-success-intelligence:1',
    'generatedAt': accountStamp,
    'accounts': [
      {
        'accountId': customerId,
        'accountRevisionId': account['revisionId'],
        'accountSha256': account['accountSha256'],
        'name': account['name'],
        'lifecycle': account['lifecycle'],
        'ownerName': 'Other member',
        'attention': 'unknown',
        'health': {
          'status': 'unknown',
          'scoreBasisPoints': null,
          'confidenceBasisPoints': 0,
          'coverageBasisPoints': 0,
          'current': false,
          'evaluatedAt': null,
        },
        'counts': {
          'openRisks': 0,
          'criticalRisks': 0,
          'openCommitments': 0,
          'overdueCommitments': 0,
          'pendingApprovals': 0,
          'staleFacts': 0,
          'conflicts': 0,
        },
        'nextBestAction': recommendation,
        'changedAt': accountStamp,
      },
    ],
    'counts': {
      'total': 1,
      'urgent': 0,
      'attention': 0,
      'pendingApprovals': 0,
      'overdueCommitments': 0,
    },
  }, 'projectionSha256');
  return accountEnvelope(
    {'context': accountContext(), 'portfolio': portfolio},
    'app.customer_accounts.portfolio.show',
    1,
  );
}

class TestAccountsRepository implements AccountsRepository {
  TestAccountsRepository()
    : access = AccountsAccess(owner: accountOwner(), ready: true);
  @override
  final AccountsAccess access;
  bool current = true;
  final tokens = <CancelToken>[];
  int listCalls = 0, portfolioCalls = 0, detailCalls = 0;
  Future<AccountsSnapshot> Function(CancelToken)? listRead;
  Future<AccountsPortfolio> Function(CancelToken)? portfolioRead;
  Future<CustomerDetail> Function(CancelToken)? detailRead;
  @override
  bool authorityCurrent() => current && access.readable;
  @override
  Future<AccountsSnapshot> list(
    CancelToken cancel, {
    String? workspaceId,
  }) async {
    listCalls++;
    tokens.add(cancel);
    return listRead != null
        ? listRead!(cancel)
        : AccountsSnapshot.parse(
            await accountListResponse(),
            access.owner!,
            workspaceId: workspaceId,
          );
  }

  @override
  Future<AccountsPortfolio> portfolio(
    CancelToken cancel, {
    String? workspaceId,
  }) async {
    portfolioCalls++;
    tokens.add(cancel);
    return portfolioRead != null
        ? portfolioRead!(cancel)
        : AccountsPortfolio.parse(
            await accountPortfolioResponse(),
            access.owner!,
            workspaceId: workspaceId,
          );
  }

  @override
  Future<CustomerDetail> detail(
    String id,
    CancelToken cancel, {
    String? workspaceId,
  }) async {
    detailCalls++;
    tokens.add(cancel);
    return detailRead != null
        ? detailRead!(cancel)
        : CustomerDetail.parse(
            await accountDetailResponse(conflicts: true),
            access.owner!,
            id,
            workspaceId: workspaceId,
          );
  }
}

class AccountsTestApi extends ApiClient {
  AccountsTestApi({String origin = accountApi})
    : super(
        Dio(BaseOptions(baseUrl: origin)),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  AppSession session = accountSession();
  Future<AccountJson> Function(String, AccountJson?, CancelToken)? read;
  final paths = <String>[],
      queries = <AccountJson?>[],
      tokens = <CancelToken>[];
  @override
  Future<AccountJson> getJsonFreshCancelable(
    String path, {
    AccountJson? query,
    AccountJson? headers,
    required CancelToken cancelToken,
  }) async {
    paths.add(path);
    queries.add(query);
    tokens.add(cancelToken);
    if (path == NativePaths.bootstrapGet) {
      return {
        'authenticated': true,
        'context': {
          'tenantId': session.tenantId,
          'actorId': session.actorId,
          'role': session.role,
        },
        'user': {
          'id': session.userId,
          'email': session.email,
          'name': session.displayName,
        },
        'membership': {'role': session.role},
        'tenant': {'name': session.workspaceName},
        'api': {
          'nativeContract': {
            'id': NativeContract.id,
            'supportedVersions': NativeContract.supportedVersions,
          },
        },
      };
    }
    if (read != null) {
      return read!(path, query, cancelToken);
    }
    if (path == NativePaths.customersList()) {
      return accountListResponse();
    }
    if (path == NativePaths.customersPortfolio()) {
      return accountPortfolioResponse();
    }
    if (path == NativePaths.customersGet(customerId)) {
      return accountDetailResponse();
    }
    throw StateError('Unexpected customer request $path');
  }

  @override
  Future<AccountJson> getJson(String path, {AccountJson? query}) =>
      throw StateError('Customer reads cannot use offline fallback.');
  @override
  Future<AccountJson> postJson(
    String path, {
    AccountJson? data,
    AccountJson? headers,
  }) => throw StateError('Customer read view must not write.');
}
