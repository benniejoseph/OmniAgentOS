import 'dart:convert';

import 'accounts_contracts.dart';
import 'accounts_mutation_contracts.dart' show accountRawSha;

const accountSalesforceReadContract = 'customer-salesforce-action-read:1';
const accountSalesforceRequestContract = 'customer-salesforce-action-request:1';
const accountSalesforceActions = ['sync', 'reconcile', 'disconnect'];
AccountJson _scope(AccountsOwner owner, String workspace) => {
  'tenantId': owner.tenantId,
  'workspaceId': workspace,
  'ownerActorId': 'actor:${owner.userId}',
};
Future<AccountJson> accountSalesforceConnection(
  Object? value,
  AccountsOwner owner,
  String workspace,
) async {
  final row = accountMap(value);
  accountKeys(row, [
    'tenantId',
    'workspaceId',
    'ownerActorId',
    'connectionId',
    'oauthGrantId',
    'authorizationGeneration',
    'organizationIdSha256',
    'instanceOrigin',
    'connectionState',
    'grantStatus',
    'grantAuthorizationGeneration',
    'readScopesGranted',
    'reviewSha256',
  ]);
  accountRequire(
    _scope(
      owner,
      workspace,
    ).entries.every((entry) => row[entry.key] == entry.value),
  );
  accountId(row['connectionId'], 'salesforce-connection');
  accountId(row['oauthGrantId']);
  accountInt(row['authorizationGeneration'], min: 1, max: 2147483647);
  accountInt(row['grantAuthorizationGeneration'], min: 1, max: 2147483647);
  accountHash(row['organizationIdSha256']);
  accountBool(row['readScopesGranted']);
  accountEnum(row['connectionState'], ['active', 'revoked', 'error']);
  accountEnum(row['grantStatus'], ['active', 'revoked']);
  final origin = accountText(row['instanceOrigin'], 300),
      uri = Uri.tryParse(origin);
  accountRequire(
    uri != null &&
        uri.scheme == 'https' &&
        uri.host.isNotEmpty &&
        uri.origin == origin,
  );
  await accountDigest(row, 'reviewSha256');
  return accountFreeze(row);
}

class AccountSalesforceIntent {
  const AccountSalesforceIntent._(
    this.owner,
    this.workspaceId,
    this.key,
    this.identity,
    this.requestSha256,
  );
  final AccountsOwner owner;
  final String workspaceId, key, requestSha256;
  final AccountJson identity;
  AccountJson get body => accountMap(identity['request']);
  AccountJson get review => accountMap(body['review']);
  String get action => body['action'] as String;
  String get keySha256 => identity['idempotencyKeySha256'] as String;
  AccountJson get stored => {
    'workspaceId': workspaceId,
    'key': key,
    'identity': identity,
    'requestSha256': requestSha256,
  };
  static Future<AccountSalesforceIntent> prepare(
    AccountsOwner owner,
    String workspace,
    String key,
    String action,
    AccountJson reviewed,
  ) async {
    accountRequire(
      RegExp(r'^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$')
              .hasMatch(accountId(workspace)) &&
          RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    accountEnum(action, accountSalesforceActions);
    final review = await accountSalesforceConnection(
      reviewed,
      owner,
      workspace,
    );
    accountRequire(
      review['connectionState'] == 'active' &&
          review['grantStatus'] == 'active' &&
          review['authorizationGeneration'] ==
              review['grantAuthorizationGeneration'] &&
          (action == 'disconnect'
              ? (review['grantAuthorizationGeneration'] as int) < 2147483647
              : review['readScopesGranted'] == true),
    );
    final identity = accountFreeze({
      'contract': 'customer-salesforce-action-intent:1',
      'scope': _scope(owner, workspace),
      'idempotencyKeySha256': await accountRawSha(
        '${owner.tenantId}\u0000$key',
      ),
      'request': {
        'contract': accountSalesforceRequestContract,
        'workspaceId': workspace,
        'action': action,
        'review': review,
      },
    });
    return AccountSalesforceIntent._(
      owner,
      workspace,
      key,
      identity,
      await accountSha(identity),
    );
  }

  static Future<AccountSalesforceIntent> restore(
    Object? value,
    AccountsOwner owner,
    String workspace,
  ) async {
    final row = accountMap(value);
    accountKeys(row, ['workspaceId', 'key', 'identity', 'requestSha256']);
    accountRequire(row['workspaceId'] == workspace);
    final identity = accountMap(row['identity']),
        body = accountMap(identity['request']);
    final restored = await prepare(
      owner,
      workspace,
      accountText(row['key'], 512),
      accountEnum(body['action'], accountSalesforceActions),
      accountMap(body['review']),
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
      'causationId': review['connectionId'],
      'contextGrantIds': <String>[],
      'capabilityGrantIds': <String>[],
      'purpose': 'api.customer-salesforce.action',
    },
  });
}

Future<AccountJson> _action(
  Object? value,
  AccountsOwner owner,
  String workspace,
) async {
  final row = accountMap(value);
  accountKeys(row, ['acceptance', 'state', 'settlement']);
  final accepted = accountMap(row['acceptance']);
  accountKeys(accepted, [
    'contract',
    'id',
    'scope',
    'action',
    'idempotencyKeySha256',
    'requestSha256',
    'review',
    'acceptedAt',
    'localRevoked',
    'acceptanceSha256',
  ]);
  final scope = accountMap(accepted['scope']);
  accountKeys(scope, ['tenantId', 'workspaceId', 'ownerActorId']);
  accountRequire(
    accountCanonical(scope) == accountCanonical(_scope(owner, workspace)) &&
        accepted['contract'] == 'customer-salesforce-action-acceptance:1',
  );
  final action = accountEnum(accepted['action'], accountSalesforceActions),
      key = accountHash(accepted['idempotencyKeySha256']);
  final review = await accountSalesforceConnection(
    accepted['review'],
    owner,
    workspace,
  );
  final identity = {
    'contract': 'customer-salesforce-action-intent:1',
    'scope': scope,
    'idempotencyKeySha256': key,
    'request': {
      'contract': accountSalesforceRequestContract,
      'workspaceId': workspace,
      'action': action,
      'review': review,
    },
  };
  accountRequire(
    review['connectionState'] == 'active' &&
        review['grantStatus'] == 'active' &&
        review['authorizationGeneration'] ==
            review['grantAuthorizationGeneration'] &&
        (action == 'disconnect'
            ? (review['grantAuthorizationGeneration'] as int) < 2147483647
            : review['readScopesGranted'] == true),
  );
  accountRequire(
    accepted['id'] ==
            'salesforce-action:${await accountSha({'contract': 'customer-salesforce-action-id:1', 'scope': scope, 'idempotencyKeySha256': key})}' &&
        accountHash(accepted['requestSha256']) == await accountSha(identity) &&
        accountBool(accepted['localRevoked']) == (action == 'disconnect'),
  );
  final acceptedAt = accountDate(accepted['acceptedAt']);
  await accountDigest(accepted, 'acceptanceSha256');
  final state = accountEnum(row['state'], ['accepted', 'settled']);
  accountRequire((state == 'settled') == (row['settlement'] != null));
  if (row['settlement'] != null) {
    final settled = accountMap(row['settlement']);
    accountRequire(
      settled['action'] == action &&
          accountDate(settled['settledAt']).compareTo(acceptedAt) >= 0,
    );
    switch (action) {
      case 'sync':
        accountKeys(settled, [
          'action',
          'status',
          'pages',
          'records',
          'advanced',
          'conflicts',
          'projection',
          'settledAt',
        ]);
        accountEnum(settled['status'], ['healthy', 'partial']);
        for (final key in ['pages', 'records', 'advanced', 'conflicts']) {
          accountInt(settled[key]);
        }
        final projection = accountMap(settled['projection']);
        accountKeys(projection, ['examined', 'projected', 'held', 'failed']);
        for (final key in projection.keys) {
          accountInt(projection[key]);
        }
        accountRequire(
          projection['examined'] ==
              projection['projected'] +
                  projection['held'] +
                  projection['failed'],
        );
      case 'reconcile':
        accountKeys(settled, [
          'action',
          'status',
          'checked',
          'findings',
          'settledAt',
        ]);
        accountRequire(settled['status'] == 'complete');
        accountInt(settled['checked']);
        accountInt(settled['findings']);
      case 'disconnect':
        accountKeys(settled, [
          'action',
          'status',
          'providerRevocation',
          'settledAt',
        ]);
        accountRequire(settled['status'] == 'local_revoked');
        accountEnum(settled['providerRevocation'], [
          'revoked',
          'not_supported',
          'unconfirmed',
        ]);
    }
  }
  return accountFreeze(row);
}

class AccountSalesforceRead {
  const AccountSalesforceRead._(
    this.raw,
    this.connection,
    this.allowed,
    this.blockedAction,
    this.action,
  );
  final AccountJson raw;
  final AccountJson? connection, blockedAction, action;
  final List<String> allowed;
  bool get settled => action?['state'] == 'settled';
  bool get busy => accountMap(raw['current'])['busy'] == true;
  static Future<AccountSalesforceRead> parse(
    Object? value,
    AccountsOwner owner,
    String workspace, {
    required String kind,
    AccountSalesforceIntent? intent,
  }) async {
    final row = accountMap(value);
    accountRequire(utf8.encode(jsonEncode(row)).length <= 65536);
    accountEnum(kind, ['review', 'read', 'mutation']);
    accountKeys(row, [
      'contract',
      'context',
      'current',
      'action',
      if (kind == 'mutation') 'replayed',
      'serviceReceipt',
    ]);
    accountRequire(row['contract'] == accountSalesforceReadContract);
    final context = AccountContext.parse(
          row['context'],
          workspaceId: workspace,
        ),
        current = accountMap(row['current']);
    accountKeys(current, [
      'connection',
      'availableActions',
      'blockedAction',
      'busy',
    ]);
    final connection = current['connection'] == null
            ? null
            : await accountSalesforceConnection(
                current['connection'],
                owner,
                workspace,
              ),
        blocked = current['blockedAction'] == null
            ? null
            : await _action(current['blockedAction'], owner, workspace),
        action = row['action'] == null
            ? null
            : await _action(row['action'], owner, workspace);
    final allowed = accountList(
      current['availableActions'],
      3,
      (value) => accountEnum(value, accountSalesforceActions),
    );
    accountUnique(allowed);
    final busy = accountBool(current['busy']);
    accountRequire(blocked == null || blocked['state'] == 'accepted');
    accountRequire(
      allowed.isEmpty ||
          (context.accessLevel != 'reader' &&
              connection != null &&
              blocked == null &&
              !busy &&
              connection['connectionState'] == 'active' &&
              connection['grantStatus'] == 'active' &&
              connection['authorizationGeneration'] ==
                  connection['grantAuthorizationGeneration']),
    );
    accountRequire(
      !allowed.any((item) => item != 'disconnect') ||
          connection?['readScopesGranted'] == true,
    );
    accountRequire(
      !allowed.contains('disconnect') ||
          connection?['grantAuthorizationGeneration'] != 2147483647,
    );
    if (kind == 'review') {
      accountRequire(action == null && intent == null);
    } else {
      accountRequire(
        intent != null &&
            intent.owner.key == owner.key &&
            intent.workspaceId == workspace,
      );
      if (action != null) {
        final accepted = accountMap(action['acceptance']);
        accountRequire(
          accepted['requestSha256'] == intent!.requestSha256 &&
              accepted['idempotencyKeySha256'] == intent.keySha256 &&
              accepted['action'] == intent.action &&
              accountCanonical(accepted['review']) ==
                  accountCanonical(intent.review),
        );
      }
    }
    if (kind == 'mutation') {
      accountBool(row['replayed']);
      accountRequire(
        action != null && intent != null && context.accessLevel != 'reader',
      );
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
            proof['operation'] ==
                'app.customer_accounts.salesforce.actions.submit' &&
            proof['action'] == 'manage.connector' &&
            proof['resourceType'] == 'salesforce_connection' &&
            proof['accessMode'] == 'mutation' &&
            proof['eventContract'] == 'customer-salesforce-events.v1' &&
            proof['resourceCount'] == 1 &&
            proof['authoritySha256'] == await intent!.authorityHash() &&
            proof['idempotencyKeySha256'] == intent.keySha256 &&
            proof['outcomeSha256'] ==
                await accountSha({...row}..remove('serviceReceipt')),
      );
      accountDate(proof['occurredAt']);
      await accountDigest(proof, 'receiptSha256');
    } else {
      await accountReadReceipt(
        row,
        owner,
        'app.customer_accounts.salesforce.actions.${kind == 'review' ? 'review' : 'show'}',
        'salesforce_connection',
        kind == 'review'
            ? (connection == null ? 0 : 1)
            : (action == null ? 0 : 1),
      );
    }
    return AccountSalesforceRead._(
      accountFreeze(row),
      connection,
      List.unmodifiable(allowed),
      blocked,
      action,
    );
  }
}

class AccountSalesforceState {
  AccountSalesforceIntent? pending, observedIntent, notSubmitted;
  AccountSalesforceRead? observed;
  bool needsLocalSave = false;
  AccountJson get stored => {
    'pending': pending?.stored,
    'observedIntent': observedIntent?.stored,
    'observed': observed?.raw,
    'notSubmitted': notSubmitted?.stored,
  };
  static bool same(AccountSalesforceIntent? a, AccountSalesforceIntent? b) =>
      a != null &&
      b != null &&
      a.owner.key == b.owner.key &&
      a.workspaceId == b.workspaceId &&
      a.requestSha256 == b.requestSha256;
  static Future<AccountSalesforceState> restore(
    Object? value,
    AccountsOwner owner,
    String workspace,
    AccountSalesforceState previous, {
    required bool storageUnconfirmed,
  }) async {
    final next = AccountSalesforceState();
    if (value != null) {
      final row = accountMap(value);
      accountKeys(row, [
        'pending',
        'observedIntent',
        'observed',
        'notSubmitted',
      ]);
      if (row['pending'] != null) {
        next.pending = await AccountSalesforceIntent.restore(
          row['pending'],
          owner,
          workspace,
        );
      }
      if (row['notSubmitted'] != null) {
        next.notSubmitted = await AccountSalesforceIntent.restore(
          row['notSubmitted'],
          owner,
          workspace,
        );
      }
      if (row['observedIntent'] != null) {
        next.observedIntent = await AccountSalesforceIntent.restore(
          row['observedIntent'],
          owner,
          workspace,
        );
      }
      accountRequire(
        (next.observedIntent == null) == (row['observed'] == null),
      );
      if (next.observedIntent != null) {
        final raw = accountMap(row['observed']);
        next.observed = await AccountSalesforceRead.parse(
          raw,
          owner,
          workspace,
          kind: raw.containsKey('replayed') ? 'mutation' : 'read',
          intent: next.observedIntent,
        );
        accountRequire(
          next.observed!.action != null &&
              (next.observed!.settled ||
                  same(next.pending, next.observedIntent)),
        );
      }
      accountRequire(
        !same(next.notSubmitted, next.observedIntent) &&
            !same(next.notSubmitted, next.pending),
      );
    }
    accountRequire(
      previous.pending == null ||
          same(previous.pending, next.pending) ||
          next.observed?.settled == true &&
              same(previous.pending, next.observedIntent) ||
          same(previous.pending, next.notSubmitted),
      'The protected journal does not prove the saved Salesforce request was resolved. Its original identity remains held.',
    );
    accountRequire(
      !storageUnconfirmed ||
          previous.observed == null ||
          same(previous.observedIntent, next.pending) ||
          same(previous.observedIntent, next.observedIntent),
      'The known Salesforce receipt is retained until protected storage confirms its exact request.',
    );
    if (previous.observed != null &&
        next.observed != null &&
        same(previous.observedIntent, next.observedIntent)) {
      accountRequire(
        accountCanonical(previous.observed!.action!['acceptance']) ==
            accountCanonical(next.observed!.action!['acceptance']),
      );
      if (previous.observed!.settled && next.observed!.settled) {
        accountRequire(
          accountCanonical(previous.observed!.action) ==
              accountCanonical(next.observed!.action),
        );
      }
    }
    if (previous.observed != null &&
        same(previous.observedIntent, next.pending)) {
      if (previous.observed!.settled) {
        next.pending = null;
      }
      next.observedIntent = previous.observedIntent;
      next.observed = previous.observed;
      next.needsLocalSave = true;
    } else if (same(previous.notSubmitted, next.pending)) {
      next.pending = null;
      next.notSubmitted = previous.notSubmitted;
      next.needsLocalSave = true;
    }
    if (next.observed == null && previous.observed != null) {
      next.observed = previous.observed;
      next.observedIntent = previous.observedIntent;
    }
    return next;
  }
}
