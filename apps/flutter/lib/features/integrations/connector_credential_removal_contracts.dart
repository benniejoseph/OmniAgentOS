import 'dart:math';

import 'connector_contracts.dart';
import 'connector_control_contracts.dart';

bool credentialRemovalEligible(ConnectorReview review) {
  final connector = review.connector, pin = review.pin;
  return connector != null &&
      pin != null &&
      review.value!['unavailableReason'] == null &&
      connector['kind'] == 'mcp' &&
      connector['authType'] == 'bearer_vault' &&
      connector['credentialConfigured'] == true &&
      connector['credentialVersion'] is int &&
      (connector['credentialVersion'] as int) > 0 &&
      (connector['credentialVersion'] as int) < 2147483647;
}

Future<ConnectorJson> _removalRequest(Object? value) async {
  final request = connectorObject(
    value,
    'contract kind connectorId action review preview',
  );
  final id = controlId(request['connectorId']);
  final pin = connectorObject(
    request['review'],
    'kind connectorId connectorSha256 contractsSha256 configurationSha256 reviewFingerprint credentialVersion reviewSha256',
  );
  connectorRequire(
    request['contract'] == 'asael-connector-lifecycle-action:1' &&
        request['kind'] == 'mcp' &&
        request['action'] == 'remove_credential' &&
        request['preview'] == null &&
        pin['kind'] == 'mcp' &&
        pin['connectorId'] == id,
  );
  connectorCount(pin['credentialVersion'], 2147483646, minimum: 1);
  for (final field in [
    'connectorSha256',
    'contractsSha256',
    'configurationSha256',
    'reviewSha256',
  ]) {
    connectorHash(pin[field]);
  }
  connectorRequire(
    pin['reviewFingerprint'] == null ||
        pin['reviewFingerprint'] is String &&
            RegExp(r'^[A-Za-z0-9_-]{43}$')
                .hasMatch(pin['reviewFingerprint'] as String),
  );
  connectorRequire(
    pin['reviewSha256'] == await connectorSha({...pin}..remove('reviewSha256')),
  );
  return connectorFreeze(request);
}

class ConnectorCredentialRemovalIntent {
  const ConnectorCredentialRemovalIntent._(
    this.owner,
    this.key,
    this.identity,
    this.requestSha256,
  );
  final ConnectorOwner owner;
  final String key, requestSha256;
  final ConnectorJson identity;
  ConnectorJson get request => connectorMap(identity['request']);
  ConnectorJson get review => connectorMap(request['review']);
  String get keySha256 => identity['keySha256'] as String;
  String get id => request['connectorId'] as String;
  ConnectorJson get stored => {
    'owner': owner.json,
    'key': key,
    'identity': identity,
    'requestSha256': requestSha256,
  };

  static Future<ConnectorCredentialRemovalIntent> prepare(
    ConnectorOwner owner,
    ConnectorReview review, {
    String? key,
  }) async {
    connectorRequire(
      credentialRemovalEligible(review) &&
          connectorSame(review.raw['scope'], owner.scope),
    );
    return _create(
      owner,
      key ??
          'native-credential-removal-${List.generate(24, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}',
      {
        'contract': 'asael-connector-lifecycle-action:1',
        'kind': 'mcp',
        'connectorId': review.connector!['id'],
        'action': 'remove_credential',
        'review': review.pin,
        'preview': null,
      },
    );
  }

  static Future<ConnectorCredentialRemovalIntent> _create(
    ConnectorOwner owner,
    String key,
    Object? value,
  ) async {
    connectorRequire(
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    final request = await _removalRequest(value);
    final identity = connectorFreeze({
      'contract': 'asael-connector-action-intent:1',
      'scope': owner.scope,
      'keySha256': await connectorRawSha('${owner.tenantId}\u0000$key'),
      'request': request,
    });
    return ConnectorCredentialRemovalIntent._(
      owner,
      key,
      identity,
      await connectorSha(identity),
    );
  }

  static Future<ConnectorCredentialRemovalIntent> restore(
    Object? value,
    ConnectorOwner current,
  ) async {
    final row = connectorObject(value, 'owner key identity requestSha256');
    final owner = ConnectorOwner.restore(row['owner'], current);
    connectorRequire(connectorSame(owner.scope, current.scope));
    final identity = connectorObject(
      row['identity'],
      'contract scope keySha256 request',
    );
    final intent = await _create(
      owner,
      connectorText(row['key'], 512),
      identity['request'],
    );
    connectorRequire(
      connectorSame(identity, intent.identity) &&
          row['requestSha256'] == intent.requestSha256,
    );
    return intent;
  }
}

class ConnectorCredentialRemovalRead {
  const ConnectorCredentialRemovalRead._(this.raw, this.action);
  final ConnectorJson raw;
  final ConnectorJson? action;
  ConnectorJson? get acceptance =>
      action == null ? null : connectorMap(action!['acceptance']);
  bool get settled => action?['state'] == 'settled';

  static Future<ConnectorCredentialRemovalRead> parse(
    Object? value,
    ConnectorOwner owner, {
    String kind = 'read',
    String? keySha256,
    required ConnectorCredentialRemovalIntent intent,
  }) async {
    connectorRequire(const ['read', 'submit'].contains(kind));
    final mutation = kind == 'submit';
    connectorRequire(
      owner.storageKey == intent.owner.storageKey &&
          connectorSame(owner.scope, intent.owner.scope) &&
          (keySha256 == null || keySha256 == intent.keySha256) &&
          (!mutation || owner.key == intent.owner.key),
    );
    final row = connectorObject(
      value,
      'contract scope action serviceReceipt${mutation ? ' replayed' : ''}',
    );
    if (mutation) {
      connectorRequire(row['action'] != null && row['replayed'] is bool);
    }
    ConnectorJson? action;
    if (row['action'] != null) {
      action = connectorObject(row['action'], 'acceptance state settlement');
      final a = connectorObject(
        action['acceptance'],
        'contract id scope keySha256 requestSha256 kind connectorId action reviewSha256 acceptedAt acceptanceSha256',
      );
      final acceptedAt = connectorInstant(a['acceptedAt']);
      connectorRequire(acceptedAt.endsWith('Z'));
      for (final field in [
        'keySha256',
        'requestSha256',
        'reviewSha256',
        'acceptanceSha256',
      ]) {
        connectorHash(a[field]);
      }
      connectorRequire(
        a['contract'] == 'asael-connector-acceptance:1' &&
            connectorSame(a['scope'], owner.scope) &&
            a['keySha256'] == intent.keySha256 &&
            a['requestSha256'] == intent.requestSha256 &&
            a['kind'] == 'mcp' &&
            a['connectorId'] == intent.id &&
            a['action'] == 'remove_credential' &&
            a['reviewSha256'] == intent.review['reviewSha256'] &&
            a['id'] ==
                'connector-acceptance:${await connectorSha({'scope': owner.scope, 'keySha256': intent.keySha256})}' &&
            a['acceptanceSha256'] ==
                await connectorSha({...a}..remove('acceptanceSha256')) &&
            const ['accepted', 'settled'].contains(action['state']) &&
            (action['state'] == 'settled') == (action['settlement'] != null),
      );
      if (action['settlement'] != null) {
        final s = connectorObject(
          action['settlement'],
          'contract acceptanceId settledAt result settlementSha256',
        );
        final result = connectorObject(
          s['result'],
          'kind connectorId operation status connectorStatus contractCount credentialVersion connectorSha256 contractsSha256 configurationSha256 trash failureCode',
        );
        final settledAt = connectorInstant(s['settledAt']);
        connectorHash(s['settlementSha256']);
        for (final field in [
          'connectorSha256',
          'contractsSha256',
          'configurationSha256',
        ]) {
          connectorHash(result[field]);
        }
        connectorCount(result['credentialVersion'], 2147483647, minimum: 2);
        connectorRequire(
          s['contract'] == 'asael-connector-settlement:2' &&
              s['acceptanceId'] == a['id'] &&
              settledAt.endsWith('Z') &&
              !DateTime.parse(settledAt).isBefore(DateTime.parse(acceptedAt)) &&
              result['kind'] == 'mcp' &&
              result['connectorId'] == intent.id &&
              result['operation'] == 'remove_credential' &&
              result['status'] == 'complete' &&
              result['connectorStatus'] == 'disabled' &&
              result['contractCount'] == 0 &&
              result['credentialVersion'] ==
                  (intent.review['credentialVersion'] as int) + 1 &&
              result['contractsSha256'] == await connectorSha(<Object?>[]) &&
              result['trash'] == null &&
              result['failureCode'] == null &&
              s['settlementSha256'] ==
                  await connectorSha({...s}..remove('settlementSha256')),
        );
      }
    }
    await connectorServiceReceipt(
      row,
      owner,
      contract: connectorControlContract,
      operation: 'app.connectors.native.credentialRemovals.$kind',
      resource: 'connector_native_action',
      count: action == null ? 0 : 1,
      key: mutation ? intent.key : null,
      target: intent.id,
      purpose: 'api.connectors.native.action',
      event: 'connector-native-credential-removal-events.v1',
    );
    return ConnectorCredentialRemovalRead._(
      connectorFreeze(row),
      action == null ? null : connectorFreeze(action),
    );
  }
}
