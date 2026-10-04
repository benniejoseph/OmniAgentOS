import 'dart:convert';

import 'accounts_contracts.dart';
import 'accounts_mutation_contracts.dart';

const accountFactRequestContract = 'customer-fact-mutation-request:1';
const accountFactReadContract = 'customer-fact-mutation-read:1';
const _revisionMax = 2147483647;
String _factIdentity(Object? value, [String? prefix]) =>
    accountId(value, prefix);

AccountJson validateAccountFactRequest(Object? value) {
  final row = accountMap(value);
  accountKeys(row, [
    'contract',
    'workspaceId',
    'expectedAccountRevision',
    'expectedAccountSha256',
    'operation',
    'factId',
    'expectedFactRevision',
    'expectedFactSha256',
    'factKey',
    'value',
    'owner',
    'confidenceBasisPoints',
    'validFrom',
    'validTo',
    'staleAfter',
    'manualSource',
    'allowedPurposeIds',
  ]);
  accountRequire(
    row['contract'] == accountFactRequestContract &&
        accountId(row['workspaceId']).startsWith('workspace:'),
  );
  accountInt(row['expectedAccountRevision'], min: 1, max: _revisionMax);
  accountHash(row['expectedAccountSha256']);
  final operation = accountEnum(row['operation'], [
    'create',
    'revise',
    'retract',
  ]);
  if (operation == 'create') {
    accountRequire(
      row['factId'] == null &&
          row['expectedFactRevision'] == null &&
          row['expectedFactSha256'] == null,
    );
  } else {
    accountId(row['factId'], 'customer-fact');
    accountInt(row['expectedFactRevision'], min: 1, max: _revisionMax - 1);
    accountHash(row['expectedFactSha256']);
  }
  accountRequire(
    RegExp(r'^[a-z0-9][a-z0-9._:-]*$')
        .hasMatch(accountText(row['factKey'], 160)),
  );
  final fact = accountMap(row['value']),
      kind = accountEnum(fact['kind'], accountKinds);
  accountFactValue(fact, kind);
  accountSemanticOwner(row['owner']);
  accountInt(row['confidenceBasisPoints'], max: 10000);
  final validFrom = accountDate(row['validFrom']);
  accountNullable(row['validTo'], (value) {
    final end = accountDate(value);
    accountRequire(end.compareTo(validFrom) > 0);
    return end;
  });
  final source = accountMap(row['manualSource']);
  accountKeys(source, ['label', 'observedAt']);
  accountText(source['label'], 240);
  final observed = accountDate(source['observedAt']);
  accountNullable(row['staleAfter'], (value) {
    final stale = accountDate(value);
    accountRequire(stale.compareTo(observed) > 0);
    return stale;
  });
  final purposes = accountList(
    row['allowedPurposeIds'],
    5,
    (value) => accountEnum(value, accountPurposes),
  );
  accountUnique(purposes);
  accountRequire(
    purposes.contains('customer_success.account.read') &&
        accountCanonical([...purposes]..sort()) == accountCanonical(purposes),
  );
  accountRequire(utf8.encode(jsonEncode(row)).length <= 32768);
  return accountFreeze(row);
}

class AccountFactIntent {
  const AccountFactIntent._(
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
  String get factId => identity['factId'] as String;
  AccountJson get request => accountMap(identity['request']);
  AccountJson get body => {
    'contract': accountFactRequestContract,
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
  static Future<AccountFactIntent> prepare(
    AccountsOwner owner,
    String workspace,
    String key,
    CustomerAccountSummary account,
    AccountJson input,
  ) {
    accountRequire(
      account.raw['tenantId'] == owner.tenantId &&
          account.raw['workspaceId'] == workspace &&
          account.raw['ownerActorId'] == 'actor:${owner.userId}' &&
          input['workspaceId'] == workspace &&
          input['expectedAccountRevision'] == account.revision &&
          input['expectedAccountSha256'] == account.sha256,
    );
    final allowed =
        accountMap(account.raw['crmPermissions'])['customerDataPurposeIds']
            as List;
    accountRequire(
      (input['allowedPurposeIds'] as List).every(allowed.contains),
    );
    return _build(owner, workspace, key, account.name, account.id, input);
  }

  static Future<AccountFactIntent> _build(
    AccountsOwner owner,
    String workspace,
    String key,
    String name,
    String id,
    AccountJson input,
  ) async {
    accountRequire(
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    _factIdentity(id, 'customer-account');
    accountText(name);
    final full = validateAccountFactRequest(input);
    accountRequire(full['workspaceId'] == workspace);
    final request = {...full}
      ..remove('contract')
      ..remove('workspaceId');
    final identity = accountFreeze({
      'schemaVersion': 1,
      'contract': 'customer-fact-mutation-intent:1',
      'tenantId': owner.tenantId,
      'workspaceId': workspace,
      'accountId': id,
      'canonicalActorId': 'actor:${owner.userId}',
      'factId':
          request['factId'] ??
          'customer-fact:${await accountSha({'accountId': id, 'idempotencyKey': key})}',
      'mutationId':
          'customer-mutation:${await accountSha({'accountId': id, 'idempotencyKey': key, 'operation': 'fact.record'})}',
      'idempotencyKeySha256': await accountRawSha(
        '${owner.tenantId}\u0000$key',
      ),
      'request': request,
    });
    return AccountFactIntent._(
      owner,
      workspace,
      key,
      name,
      identity,
      await accountSha(identity),
    );
  }

  static Future<AccountFactIntent> restore(
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
    final identity = accountMap(row['identity']);
    final restored = await _build(
      owner,
      workspace,
      accountText(row['key'], 512),
      accountText(row['accountName']),
      _factIdentity(identity['accountId'], 'customer-account'),
      {
        'contract': accountFactRequestContract,
        'workspaceId': workspace,
        ...accountMap(identity['request']),
      },
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
      'purpose': 'api.customer-account.fact.record',
    },
  });
}

class AccountFactAcceptance {
  const AccountFactAcceptance._(
    this.raw,
    this.currentAccount,
    this.acceptance,
    this.mutation,
  );
  final AccountJson raw, currentAccount;
  final AccountJson? acceptance;
  final bool mutation;
  static Future<AccountFactAcceptance> parse(
    Object? value,
    AccountFactIntent intent, {
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
    accountRequire(row['contract'] == accountFactReadContract);
    final context = AccountContext.parse(
          row['context'],
          workspaceId: intent.workspaceId,
        ),
        current = accountMap(row['currentAccount']);
    accountKeys(current, [
      'accountId',
      'revisionId',
      'revision',
      'accountSha256',
    ]);
    final revision = accountInt(current['revision'], min: 1, max: _revisionMax);
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
    AccountJson? acceptance;
    if (row['acceptance'] != null) {
      acceptance = accountMap(row['acceptance']);
      accountKeys(acceptance, [
        'schemaVersion',
        'contract',
        'operation',
        'tenantId',
        'workspaceId',
        'accountId',
        'canonicalActorId',
        'idempotencyKeySha256',
        'requestSha256',
        'mutationId',
        'factId',
        'factRevisionId',
        'factRevision',
        'factSha256',
        'factKey',
        'kind',
        'state',
        'valueSha256',
        'reviewedAccountRevisionId',
        'reviewedAccountRevision',
        'reviewedAccountSha256',
        'expectedFactRevision',
        'expectedFactSha256',
        'sourceRevisionId',
        'sourceRevisionSha256',
        'sourceKind',
        'permissionBasis',
        'recordedAt',
        'acceptanceSha256',
      ]);
      final request = intent.request,
          factRevision = accountInt(
            acceptance['factRevision'],
            min: 1,
            max: _revisionMax,
          ),
          reviewed = accountInt(
            request['expectedAccountRevision'],
            min: 1,
            max: _revisionMax,
          );
      accountRequire(
        acceptance['schemaVersion'] == 1 &&
            acceptance['contract'] == 'customer-fact-mutation-acceptance:1' &&
            acceptance['operation'] == request['operation'] &&
            acceptance['tenantId'] == intent.owner.tenantId &&
            acceptance['workspaceId'] == intent.workspaceId &&
            acceptance['accountId'] == intent.accountId &&
            acceptance['canonicalActorId'] == 'actor:${intent.owner.userId}' &&
            acceptance['idempotencyKeySha256'] ==
                intent.identity['idempotencyKeySha256'] &&
            acceptance['requestSha256'] == intent.requestSha256 &&
            acceptance['mutationId'] == intent.identity['mutationId'] &&
            acceptance['factId'] == intent.factId &&
            acceptance['factRevisionId'] == '${intent.factId}:v$factRevision' &&
            factRevision ==
                (request['expectedFactRevision'] as int? ?? 0) + 1 &&
            acceptance['factKey'] == request['factKey'] &&
            acceptance['kind'] == request['value']['kind'] &&
            acceptance['state'] ==
                (request['operation'] == 'retract' ? 'retracted' : 'active') &&
            acceptance['valueSha256'] == await accountSha(request['value']) &&
            acceptance['reviewedAccountRevisionId'] ==
                '${intent.accountId}:v$reviewed' &&
            acceptance['reviewedAccountRevision'] == reviewed &&
            acceptance['reviewedAccountSha256'] ==
                request['expectedAccountSha256'] &&
            acceptance['expectedFactRevision'] ==
                request['expectedFactRevision'] &&
            acceptance['expectedFactSha256'] == request['expectedFactSha256'] &&
            acceptance['sourceRevisionId'] ==
                'customer-manual-source:${intent.requestSha256}:v1' &&
            acceptance['sourceKind'] == 'manual' &&
            acceptance['permissionBasis'] == 'operator_assertion',
      );
      accountRequire(
        acceptance['sourceRevisionSha256'] ==
            await accountSha({
              'contract': 'customer-manual-source:1',
              'tenantId': intent.owner.tenantId,
              'workspaceId': intent.workspaceId,
              'accountId': intent.accountId,
              'canonicalActorId': 'actor:${intent.owner.userId}',
              'requestSha256': intent.requestSha256,
            }),
      );
      accountHash(acceptance['factSha256']);
      accountDate(acceptance['recordedAt']);
      await accountDigest(acceptance, 'acceptanceSha256');
      accountRequire(
        revision >= reviewed &&
            (revision != reviewed ||
                current['accountSha256'] == request['expectedAccountSha256']),
      );
      if (mutation && row['replayed'] == false) {
        accountRequire(
          revision == reviewed &&
              current['accountSha256'] == request['expectedAccountSha256'],
        );
      }
    }
    if (mutation) {
      final proof = accountMap(row['serviceReceipt']);
      accountKeys(proof, [
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
        proof['schemaVersion'] == 1 &&
            proof['receiptKind'] == 'app_service_receipt' &&
            proof['boundaryVersion'] == accountBoundary &&
            proof['operation'] == 'app.customer_accounts.facts.record' &&
            proof['action'] == 'manage.workflow' &&
            proof['resourceType'] == 'customer_account_fact' &&
            proof['accessMode'] == 'mutation' &&
            proof['eventContract'] == 'customer-account-events.v1' &&
            proof['resourceCount'] == 1 &&
            proof['authoritySha256'] == await intent.authorityHash() &&
            proof['idempotencyKeySha256'] ==
                intent.identity['idempotencyKeySha256'] &&
            proof['outcomeSha256'] ==
                await accountSha({...row}..remove('serviceReceipt')),
      );
      accountDate(proof['occurredAt']);
      await accountDigest(proof, 'receiptSha256');
    } else {
      await accountReadReceipt(
        row,
        intent.owner,
        'app.customer_accounts.facts.mutations.show',
        'customer_account_fact',
        acceptance == null ? 0 : 1,
      );
    }
    return AccountFactAcceptance._(
      accountFreeze(row),
      accountFreeze(current),
      acceptance == null ? null : accountFreeze(acceptance),
      mutation,
    );
  }
}

/// One typed section of the existing encrypted Account journal. A missing or
/// different stored value cannot erase an unresolved admitted request.
class AccountFactState {
  AccountFactIntent? pending, acceptedIntent, notSubmitted;
  AccountFactAcceptance? accepted;
  AccountJson? draft;
  bool needsLocalSave = false;
  AccountJson get stored => {
    'draft': draft,
    'pending': pending?.stored,
    'acceptedIntent': acceptedIntent?.stored,
    'accepted': accepted?.raw,
    'notSubmitted': notSubmitted?.stored,
  };
  static AccountJson validateDraft(Object? value, AccountsOwner owner) {
    final row = accountMap(value);
    accountKeys(row, [
      'accountId',
      'ownerKey',
      'operation',
      'kind',
      'factId',
      'expectedFactRevision',
      'expectedFactSha256',
      'factKey',
      'owner',
      'confidenceBasisPoints',
      'validFrom',
      'validTo',
      'staleAfter',
      'manualSource',
      'allowedPurposeIds',
      'values',
    ]);
    accountId(row['accountId'], 'customer-account');
    accountRequire(row['ownerKey'] == owner.key);
    accountEnum(row['operation'], ['create', 'revise', 'retract']);
    accountEnum(row['kind'], accountKinds);
    accountRequire(utf8.encode(jsonEncode(row)).length <= 32768);
    return accountFreeze(row);
  }

  static Future<AccountFactState> restore(
    Object? value,
    AccountsOwner owner,
    String workspace,
    AccountFactState previous, {
    required bool storageUnconfirmed,
  }) async {
    final next = AccountFactState();
    if (value != null) {
      final row = accountMap(value);
      accountKeys(row, [
        'draft',
        'pending',
        'acceptedIntent',
        'accepted',
        'notSubmitted',
      ]);
      if (row['draft'] != null) {
        next.draft = validateDraft(row['draft'], owner);
      }
      if (row['pending'] != null) {
        next.pending = await AccountFactIntent.restore(
          row['pending'],
          owner,
          workspace,
        );
      }
      if (row['acceptedIntent'] != null) {
        next.acceptedIntent = await AccountFactIntent.restore(
          row['acceptedIntent'],
          owner,
          workspace,
        );
      }
      accountRequire(
        (next.acceptedIntent == null) == (row['accepted'] == null),
      );
      if (next.acceptedIntent != null) {
        final response = accountMap(row['accepted']);
        next.accepted = await AccountFactAcceptance.parse(
          response,
          next.acceptedIntent!,
          mutation: response.containsKey('replayed'),
        );
        accountRequire(next.accepted!.acceptance != null);
      }
      if (row['notSubmitted'] != null) {
        next.notSubmitted = await AccountFactIntent.restore(
          row['notSubmitted'],
          owner,
          workspace,
        );
      }
    }
    bool same(AccountFactIntent? a, AccountFactIntent? b) =>
        a != null &&
        b != null &&
        a.owner.key == b.owner.key &&
        a.workspaceId == b.workspaceId &&
        a.requestSha256 == b.requestSha256;
    accountRequire(
      previous.pending == null ||
          same(previous.pending, next.pending) ||
          next.accepted != null &&
              same(previous.pending, next.acceptedIntent) ||
          same(previous.pending, next.notSubmitted),
      'The exact pending fact request is absent or changed in storage. Its original identity remains held.',
    );
    accountRequire(
      !storageUnconfirmed ||
          previous.accepted == null ||
          same(previous.acceptedIntent, next.pending) ||
          same(previous.acceptedIntent, next.acceptedIntent),
      'The verified fact receipt is retained until storage confirms the exact request.',
    );
    if (previous.accepted != null &&
        same(previous.acceptedIntent, next.pending)) {
      next.pending = null;
      next.draft = null;
      next.acceptedIntent = previous.acceptedIntent;
      next.accepted = previous.accepted;
      next.needsLocalSave = true;
    } else if (same(previous.notSubmitted, next.pending)) {
      next.pending = null;
      next.notSubmitted = previous.notSubmitted;
      next.needsLocalSave = true;
    }
    if (next.accepted == null && previous.accepted != null) {
      next.accepted = previous.accepted;
      next.acceptedIntent = previous.acceptedIntent;
    }
    return next;
  }
}
