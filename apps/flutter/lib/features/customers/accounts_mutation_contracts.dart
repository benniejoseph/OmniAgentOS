import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import 'accounts_contracts.dart';

String _id(Object? value, [String? prefix]) => accountId(value, prefix);

Future<String> accountRawSha(String value) async =>
    (await Sha256().hash(utf8.encode(value))).bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();

/// Sparse revision fields remain sparse. Explicit null is not omission.
AccountJson accountMutationFields(AccountJson input, {required bool create}) {
  final allowed = {
    'name',
    'lifecycle',
    'organizationEntityId',
    'accountOwner',
    'customerDataPurposeIds',
    if (!create) 'expectedRevision',
  };
  accountRequire(input.keys.every(allowed.contains));
  final value = <String, dynamic>{...input};
  if (create) {
    value.putIfAbsent('lifecycle', () => 'prospect');
    value.putIfAbsent('organizationEntityId', () => null);
    value.putIfAbsent(
      'customerDataPurposeIds',
      () => [
        'customer_success.account.manage',
        'customer_success.account.read',
      ],
    );
    accountRequire(
      value.containsKey('name') && value.containsKey('accountOwner'),
    );
  } else {
    accountInt(value['expectedRevision'], min: 1, max: 9007199254740990);
    accountRequire(value.keys.any((key) => key != 'expectedRevision'));
  }
  if (value.containsKey('name')) {
    accountText(value['name']);
  }
  if (value.containsKey('lifecycle')) {
    accountEnum(value['lifecycle'], accountLifecycles);
  }
  if (value.containsKey('organizationEntityId')) {
    accountNullable(value['organizationEntityId'], accountId);
  }
  if (value.containsKey('accountOwner')) {
    accountSemanticOwner(value['accountOwner']);
  }
  if (value.containsKey('customerDataPurposeIds')) {
    accountDataPurposes(value['customerDataPurposeIds']);
  }
  return accountFreeze(value);
}

class AccountMutationIntent {
  const AccountMutationIntent._(
    this.owner,
    this.workspaceId,
    this.key,
    this.fields,
    this.identity,
    this.requestSha256,
  );
  final AccountsOwner owner;
  final String workspaceId, key, requestSha256;
  final AccountJson fields, identity;
  bool get create => identity['request']['operation'] == 'account.create';
  String get accountId => identity['accountId'] as String;
  String get mutationId => identity['mutationId'] as String;
  String get operation => create ? 'customers.create' : 'customers.update';
  AccountJson get body => {...fields, 'workspaceId': workspaceId};
  AccountJson get stored => {
    'workspaceId': workspaceId,
    'key': key,
    'accountId': accountId,
    'create': create,
    'fields': fields,
    'requestSha256': requestSha256,
  };

  static Future<AccountMutationIntent> prepare(
    AccountsOwner owner,
    String workspace,
    String key,
    AccountJson fields, {
    String? selectedId,
  }) async {
    accountRequire(
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    accountRequire(_id(workspace).startsWith('workspace:'));
    final create = selectedId == null,
        operation = create ? 'account.create' : 'account.revise';
    final normalized = accountMutationFields(fields, create: create);
    final id =
        selectedId ??
        'customer-account:${await accountSha({'tenantId': owner.tenantId, 'workspaceId': workspace, 'idempotencyKey': key})}';
    _id(id, 'customer-account');
    final identity = accountFreeze({
      'schemaVersion': 1,
      'contract': 'customer-account-mutation-intent:1',
      'tenantId': owner.tenantId,
      'workspaceId': workspace,
      'accountId': id,
      'mutationId':
          'customer-mutation:${await accountSha({'accountId': id, 'idempotencyKey': key, 'operation': operation})}',
      'canonicalActorId': 'actor:${owner.userId}',
      'idempotencyKeySha256': await accountRawSha(
        '${owner.tenantId}\u0000$key',
      ),
      'request': {'operation': operation, ...normalized},
    });
    return AccountMutationIntent._(
      owner,
      workspace,
      key,
      normalized,
      identity,
      await accountSha(identity),
    );
  }

  static Future<AccountMutationIntent> restore(
    Object? raw,
    AccountsOwner owner,
    String workspace,
  ) async {
    final row = accountMap(raw);
    accountKeys(row, [
      'workspaceId',
      'key',
      'accountId',
      'create',
      'fields',
      'requestSha256',
    ]);
    accountRequire(row['workspaceId'] == workspace);
    final create = accountBool(row['create']);
    final intent = await prepare(
      owner,
      workspace,
      accountText(row['key'], 512),
      accountMap(row['fields']),
      selectedId: create ? null : _id(row['accountId'], 'customer-account'),
    );
    accountRequire(
      intent.accountId == row['accountId'] &&
          intent.requestSha256 == accountHash(row['requestSha256']),
    );
    return intent;
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
      'causationId': null,
      'contextGrantIds': <String>[],
      'capabilityGrantIds': <String>[],
      'purpose': create
          ? 'api.customer-account.create'
          : 'api.customer-account.revise',
    },
  });
}

class AccountMutationReceipt {
  const AccountMutationReceipt(this.raw, this.account, this.acceptance);
  final AccountJson raw, acceptance;
  final CustomerAccountSummary account;
  static Future<AccountMutationReceipt> parse(
    AccountJson response,
    AccountMutationIntent intent,
  ) async {
    accountKeys(response, [
      'context',
      'account',
      'acceptance',
      'serviceReceipt',
    ]);
    final context = AccountContext.parse(
      response['context'],
      workspaceId: intent.workspaceId,
    );
    accountRequire(context.accessLevel != 'reader');
    final account = await CustomerAccountSummary.parse(
      response['account'],
      intent.owner,
      intent.workspaceId,
    );
    final expectedRevision = intent.create
        ? 1
        : accountInt(intent.fields['expectedRevision'], min: 1) + 1;
    accountRequire(
      account.id == intent.accountId &&
          account.revision == expectedRevision &&
          account.raw['mutationId'] == intent.mutationId &&
          account.raw['ownerActorId'] == 'actor:${intent.owner.userId}' &&
          account.raw['revisedByActorId'] == 'actor:${intent.owner.userId}',
    );
    for (final entry in intent.fields.entries) {
      if (entry.key == 'expectedRevision') {
        continue;
      }
      final actual = entry.key == 'customerDataPurposeIds'
          ? (account.raw['crmPermissions'] as Map)[entry.key]
          : account.raw[entry.key];
      accountRequire(
        accountCanonical(actual) == accountCanonical(entry.value),
        'The account receipt differs from the submitted fields.',
      );
    }
    if (intent.create) {
      accountRequire(
        (account.raw['crmPermissions'] as Map)['externalWriteState'] ==
            'disabled',
      );
    }
    final accepted = accountMap(response['acceptance']);
    accountKeys(accepted, [
      'schemaVersion',
      'contract',
      'operation',
      'tenantId',
      'workspaceId',
      'accountId',
      'mutationId',
      'canonicalActorId',
      'idempotencyKeySha256',
      'requestSha256',
      'revisionId',
      'revision',
      'accountSha256',
      'acceptedAt',
      'acceptanceSha256',
    ]);
    final expected = {
      'schemaVersion': 1,
      'contract': 'customer-account-mutation-acceptance:1',
      'operation': intent.identity['request']['operation'],
      'tenantId': intent.owner.tenantId,
      'workspaceId': intent.workspaceId,
      'accountId': intent.accountId,
      'mutationId': intent.mutationId,
      'canonicalActorId': 'actor:${intent.owner.userId}',
      'idempotencyKeySha256': intent.identity['idempotencyKeySha256'],
      'requestSha256': intent.requestSha256,
      'revisionId': account.revisionId,
      'revision': account.revision,
      'accountSha256': account.sha256,
      'acceptedAt': account.updatedAt,
    };
    accountRequire(
      accountCanonical(accepted) ==
          accountCanonical({
            ...expected,
            'acceptanceSha256': await accountSha(expected),
          }),
      'This acceptance belongs to another exact intent.',
    );
    final receipt = accountMap(response['serviceReceipt']);
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
          receipt['operation'] ==
              (intent.create
                  ? 'app.customer_accounts.create'
                  : 'app.customer_accounts.revise') &&
          receipt['action'] == 'manage.workflow' &&
          receipt['resourceType'] == 'customer_account' &&
          receipt['accessMode'] == 'mutation' &&
          receipt['eventContract'] == 'customer-account-events.v1' &&
          receipt['resourceCount'] == 1 &&
          receipt['idempotencyKeySha256'] ==
              intent.identity['idempotencyKeySha256'] &&
          receipt['authoritySha256'] == await intent.authorityHash() &&
          receipt['outcomeSha256'] ==
              await accountSha({...response}..remove('serviceReceipt')),
    );
    accountDate(receipt['occurredAt']);
    await accountDigest(receipt, 'receiptSha256');
    return AccountMutationReceipt(
      accountFreeze(response),
      account,
      accountFreeze(accepted),
    );
  }
}
