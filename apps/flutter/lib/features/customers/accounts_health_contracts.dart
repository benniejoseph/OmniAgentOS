import 'dart:convert';

import 'accounts_contracts.dart';
import 'accounts_mutation_contracts.dart';

const accountHealthRequestContract = 'customer-health-evaluation-request:1';
const accountHealthReadContract = 'customer-health-evaluation-read:1';
const accountHealthRevisionLimit = 2147483647;
String _healthId(Object? value, [String? prefix]) => accountId(value, prefix);

class AccountHealthIntent {
  const AccountHealthIntent._(
    this.owner,
    this.workspaceId,
    this.key,
    this.accountName,
    this.identity,
    this.requestSha256,
  );
  final AccountsOwner owner;
  final String workspaceId, key, accountName, requestSha256;
  final AccountJson identity;
  String get accountId => identity['accountId'] as String;
  String get evaluationId => identity['evaluationId'] as String;
  AccountJson get request => accountMap(identity['request']);
  int get accountRevision => request['expectedAccountRevision'] as int;
  String get accountSha256 => request['expectedAccountSha256'] as String;
  AccountJson get body => {
    'contract': accountHealthRequestContract,
    'workspaceId': workspaceId,
    ...request,
  };
  AccountJson get stored => {
    'workspaceId': workspaceId,
    'key': key,
    'accountName': accountName,
    'identity': identity,
    'requestSha256': requestSha256,
  };

  static Future<AccountHealthIntent> prepare(
    AccountsOwner owner,
    String workspace,
    String key,
    CustomerAccountSummary account,
  ) {
    accountRequire(
      account.raw['tenantId'] == owner.tenantId &&
          account.raw['workspaceId'] == workspace &&
          account.raw['ownerActorId'] == 'actor:${owner.userId}',
    );
    return _build(
      owner,
      workspace,
      key,
      account.name,
      account.id,
      account.revision,
      account.sha256,
    );
  }

  static Future<AccountHealthIntent> _build(
    AccountsOwner owner,
    String workspace,
    String key,
    String name,
    String id,
    int revision,
    String sha,
  ) async {
    accountRequire(
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    accountRequire(_healthId(workspace).startsWith('workspace:'));
    _healthId(id, 'customer-account');
    accountText(name);
    accountInt(revision, min: 1, max: accountHealthRevisionLimit);
    accountHash(sha);
    final identity = accountFreeze({
      'schemaVersion': 1,
      'contract': 'customer-health-evaluation-intent:1',
      'tenantId': owner.tenantId,
      'workspaceId': workspace,
      'accountId': id,
      'evaluationId':
          'customer-health-evaluation:${await accountSha({'accountId': id, 'idempotencyKey': key})}',
      'canonicalActorId': 'actor:${owner.userId}',
      'idempotencyKeySha256': await accountRawSha(
        '${owner.tenantId}\u0000$key',
      ),
      'request': {
        'expectedAccountRevision': revision,
        'expectedAccountSha256': sha,
        'modelSuggestions': <Object>[],
      },
    });
    return AccountHealthIntent._(
      owner,
      workspace,
      key,
      name,
      identity,
      await accountSha(identity),
    );
  }

  static Future<AccountHealthIntent> restore(
    Object? value,
    AccountsOwner owner,
    String workspace,
  ) async {
    final row = accountMap(value);
    accountKeys(row, [
      'workspaceId',
      'key',
      'accountName',
      'identity',
      'requestSha256',
    ]);
    accountRequire(row['workspaceId'] == workspace);
    final identity = accountMap(row['identity']),
        request = accountMap(identity['request']);
    final restored = await _build(
      owner,
      workspace,
      accountText(row['key'], 512),
      accountText(row['accountName']),
      _healthId(identity['accountId'], 'customer-account'),
      accountInt(
        request['expectedAccountRevision'],
        min: 1,
        max: accountHealthRevisionLimit,
      ),
      accountHash(request['expectedAccountSha256']),
    );
    accountRequire(
      accountCanonical(identity) == accountCanonical(restored.identity) &&
          row['requestSha256'] == restored.requestSha256,
    );
    return restored;
  }

  Future<String> authorityHash() async => accountSha({
    'boundaryVersion': accountBoundary,
    'tenantId': owner.tenantId,
    'actorId': owner.actorId,
    'role': owner.role,
    'executionScope': {
      'version': 1,
      'tenantId': owner.tenantId,
      'initiatingActorId': owner.actorId,
      'executingPrincipalType': 'user',
      'executingPrincipalId': owner.actorId,
      'workspaceId': workspaceId,
      'projectId': null,
      'missionId': null,
      'delegationId': null,
      'correlationId': key.length <= 256
          ? key
          : 'idempotency-key:${await accountSha(key)}',
      'causationId': accountId,
      'contextGrantIds': <String>[],
      'capabilityGrantIds': <String>[],
      'purpose': 'api.customer-health.evaluate',
    },
  });
}

class AccountHealthRefusal {
  const AccountHealthRefusal._(this.raw);
  final AccountJson raw;
  String get message => raw['error'] as String;
  static AccountHealthRefusal parse(Object? value, AccountHealthIntent intent) {
    final row = accountMap(value);
    accountKeys(row, [
      'contract',
      'error',
      'code',
      'admission',
      'evaluationId',
      'requestSha256',
    ]);
    accountRequire(
      row['contract'] == 'customer-health-evaluation-refusal:1' &&
          row['admission'] == 'not_admitted' &&
          row['evaluationId'] == intent.evaluationId &&
          row['requestSha256'] == intent.requestSha256,
    );
    accountRequire(
      row['error'] is String &&
          (row['error'] as String).isNotEmpty &&
          (row['error'] as String).length <= 4000,
    );
    accountEnum(row['code'], const [
      'customer_health_account_changed',
      'customer_health_revision_exhausted',
      'customer_health_projection_limit',
    ]);
    return AccountHealthRefusal._(accountFreeze(row));
  }
}

/// A compact immutable acceptance; the full evidence remains a separate read.
class AccountHealthRead {
  const AccountHealthRead._(
    this.raw,
    this.currentAccount,
    this.acceptance,
    this.mutation,
  );
  final AccountJson raw, currentAccount;
  final AccountJson? acceptance;
  final bool mutation;
  static Future<AccountHealthRead> parse(
    Object? value,
    AccountHealthIntent intent, {
    required bool mutation,
  }) async {
    final row = accountMap(value);
    accountRequire(utf8.encode(jsonEncode(row)).length <= 32768);
    accountKeys(row, [
      'contract',
      'context',
      'currentAccount',
      'acceptance',
      if (mutation) 'replayed',
      'serviceReceipt',
    ]);
    accountRequire(row['contract'] == accountHealthReadContract);
    final context = AccountContext.parse(
      row['context'],
      workspaceId: intent.workspaceId,
    );
    final current = accountMap(row['currentAccount']);
    accountKeys(current, [
      'accountId',
      'revisionId',
      'revision',
      'accountSha256',
    ]);
    final revision = accountInt(
      current['revision'],
      min: 1,
      max: accountHealthRevisionLimit,
    );
    accountRequire(
      current['accountId'] == intent.accountId &&
          current['revisionId'] == '${intent.accountId}:v$revision',
    );
    accountHash(current['accountSha256']);
    if (mutation) {
      accountBool(row['replayed']);
      accountRequire(
        context.accessLevel != 'reader' && row['acceptance'] != null,
      );
    }
    AccountJson? accepted;
    if (row['acceptance'] != null) {
      accepted = accountMap(row['acceptance']);
      accountKeys(accepted, [
        'schemaVersion',
        'contract',
        'operation',
        'tenantId',
        'workspaceId',
        'accountId',
        'canonicalActorId',
        'evaluationId',
        'idempotencyKeySha256',
        'requestSha256',
        'accountRevisionId',
        'accountRevision',
        'accountSha256',
        'scoreId',
        'scoreRevisionId',
        'scoreRevision',
        'scoreSha256',
        'policyId',
        'policySha256',
        'inputSha256',
        'scoreBasisPoints',
        'status',
        'confidenceBasisPoints',
        'coverageBasisPoints',
        'authority',
        'acceptedAt',
        'acceptanceSha256',
      ]);
      final scoreRevision = accountInt(
            accepted['scoreRevision'],
            min: 1,
            max: accountHealthRevisionLimit,
          ),
          scoreId =
              'customer-health-score:${await accountSha({'tenantId': intent.owner.tenantId, 'workspaceId': intent.workspaceId, 'accountId': intent.accountId})}';
      accountRequire(
        accepted['schemaVersion'] == 1 &&
            accepted['contract'] == 'customer-health-evaluation-acceptance:1' &&
            accepted['operation'] == 'health.evaluate' &&
            accepted['tenantId'] == intent.owner.tenantId &&
            accepted['workspaceId'] == intent.workspaceId &&
            accepted['accountId'] == intent.accountId &&
            accepted['canonicalActorId'] == 'actor:${intent.owner.userId}' &&
            accepted['evaluationId'] == intent.evaluationId &&
            accepted['idempotencyKeySha256'] ==
                intent.identity['idempotencyKeySha256'] &&
            accepted['requestSha256'] == intent.requestSha256 &&
            accepted['accountRevision'] == intent.accountRevision &&
            accepted['accountRevisionId'] ==
                '${intent.accountId}:v${intent.accountRevision}' &&
            accepted['accountSha256'] == intent.accountSha256 &&
            accepted['scoreId'] == scoreId &&
            accepted['scoreRevisionId'] == '$scoreId:v$scoreRevision' &&
            accepted['authority'] == 'deterministic_policy',
      );
      for (final field in ['scoreSha256', 'policySha256', 'inputSha256']) {
        accountHash(accepted[field]);
      }
      accountRequire(
        accepted['policyId'] ==
            'customer-health-policy:${accepted['policySha256']}',
      );
      final status = accountEnum(accepted['status'], [
        'healthy',
        'watch',
        'at_risk',
        'unknown',
      ]);
      accountRequire(
        (accepted['scoreBasisPoints'] == null) == (status == 'unknown'),
      );
      accountNullable(
        accepted['scoreBasisPoints'],
        (v) => accountInt(v, max: 10000),
      );
      accountInt(accepted['confidenceBasisPoints'], max: 10000);
      accountInt(accepted['coverageBasisPoints'], max: 10000);
      accountDate(accepted['acceptedAt']);
      await accountDigest(accepted, 'acceptanceSha256');
      accountRequire(
        revision >= intent.accountRevision &&
            (revision != intent.accountRevision ||
                current['accountSha256'] == intent.accountSha256),
      );
      if (mutation && row['replayed'] == false) {
        accountRequire(
          revision == intent.accountRevision &&
              current['accountSha256'] == intent.accountSha256,
        );
      }
    }
    if (mutation) {
      final receipt = accountMap(row['serviceReceipt']);
      accountKeys(receipt, [
        'schemaVersion',
        'receiptKind',
        'boundaryVersion',
        'operation',
        'action',
        'resourceType',
        'accessMode',
        'eventContract',
        'authoritySha256',
        'idempotencyKeySha256',
        'outcomeSha256',
        'resourceCount',
        'occurredAt',
        'receiptSha256',
      ]);
      accountRequire(
        receipt['schemaVersion'] == 1 &&
            receipt['receiptKind'] == 'app_service_receipt' &&
            receipt['boundaryVersion'] == accountBoundary &&
            receipt['operation'] == 'app.customer_accounts.health.evaluate' &&
            receipt['action'] == 'manage.workflow' &&
            receipt['resourceType'] == 'customer_health_score' &&
            receipt['accessMode'] == 'mutation' &&
            receipt['eventContract'] == 'customer-health-events.v1' &&
            receipt['resourceCount'] == 1 &&
            receipt['authoritySha256'] == await intent.authorityHash() &&
            receipt['idempotencyKeySha256'] ==
                intent.identity['idempotencyKeySha256'] &&
            receipt['outcomeSha256'] ==
                await accountSha({...row}..remove('serviceReceipt')),
      );
      accountDate(receipt['occurredAt']);
      await accountDigest(receipt, 'receiptSha256');
    } else {
      await accountReadReceipt(
        row,
        intent.owner,
        'app.customer_accounts.health.evaluations.show',
        'customer_health_score',
        accepted == null ? 0 : 1,
      );
    }
    return AccountHealthRead._(
      accountFreeze(row),
      accountFreeze(current),
      accepted == null ? null : accountFreeze(accepted),
      mutation,
    );
  }
}
