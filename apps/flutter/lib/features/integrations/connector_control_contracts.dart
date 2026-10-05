import 'dart:convert';
import 'dart:math';

import 'connector_contracts.dart';

const connectorControlContract = 'asael-connector-control-read:1';
const connectorControlActions = ['review_contracts', 'enable', 'disable'];
String controlId(Object? value) {
  final id = connectorText(value, 200);
  connectorRequire(
    RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@+~-]{0,199}$').hasMatch(id),
  );
  return id;
}

String controlKind(Object? value) {
  connectorRequire(const ['mcp', 'openapi'].contains(value));
  return value as String;
}

void _instant(Object? value) {
  connectorRequire(connectorInstant(value).endsWith('Z'));
}

void _fingerprint(Object? value) {
  connectorRequire(
    value is String && RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(value),
  );
}

ConnectorJson _summary(Object? value) {
  final row = connectorObject(
    value,
    'kind id name endpoint endpointRedacted status authType authTokenEnv authHeaderName credentialConfigured credentialVersion credentialOriginMatch defaultRiskLevel approvalRequired contractCount discoveredAt updatedAt',
  );
  controlKind(row['kind']);
  controlId(row['id']);
  connectorText(row['name'], 120);
  final endpoint = connectorText(row['endpoint'], 2048),
      uri = Uri.tryParse(endpoint);
  connectorRequire(
    uri != null &&
        const ['http', 'https'].contains(uri.scheme) &&
        uri.host.isNotEmpty &&
        uri.userInfo.isEmpty &&
        !uri.hasQuery &&
        !uri.hasFragment &&
        row['endpointRedacted'] is bool,
  );
  connectorRequire(
    const ['active', 'disabled', 'error'].contains(row['status']) &&
        const [
          'none',
          'bearer_env',
          'bearer_vault',
          'api_key_header_env',
        ].contains(row['authType']),
  );
  for (final field in ['authTokenEnv', 'authHeaderName']) {
    if (row[field] != null) {
      connectorText(row[field], 120, empty: true);
    }
  }
  for (final field in [
    'credentialConfigured',
    'credentialOriginMatch',
    'approvalRequired',
  ]) {
    connectorRequire(row[field] is bool);
  }
  connectorCount(row['credentialVersion'], 2147483647);
  connectorCount(row['contractCount'], 2147483647);
  connectorCount(row['defaultRiskLevel'], 3);
  if (row['discoveredAt'] != null) {
    _instant(row['discoveredAt']);
  }
  _instant(row['updatedAt']);
  return row;
}

ConnectorJson _pin(Object? value) {
  final pin = connectorObject(
    value,
    'kind connectorId connectorSha256 contractsSha256 configurationSha256 reviewFingerprint credentialVersion reviewSha256',
  );
  controlKind(pin['kind']);
  controlId(pin['connectorId']);
  connectorCount(pin['credentialVersion'], 2147483647);
  for (final field in [
    'connectorSha256',
    'contractsSha256',
    'configurationSha256',
    'reviewSha256',
  ]) {
    connectorHash(pin[field]);
  }
  if (pin['reviewFingerprint'] != null) {
    _fingerprint(pin['reviewFingerprint']);
  }
  return pin;
}

Future<void> _pinDigest(ConnectorJson pin) async => connectorRequire(
  pin['reviewSha256'] == await connectorSha({...pin}..remove('reviewSha256')),
);

class ConnectorInventory {
  const ConnectorInventory(this.rows, this.hasMore);
  final List<ConnectorJson> rows;
  final bool hasMore;
  static Future<ConnectorInventory> parse(
    Object? value,
    ConnectorOwner owner,
  ) async {
    final row = connectorObject(
          value,
          'contract scope connectors hasMore serviceReceipt',
        ),
        values = row['connectors'];
    connectorRequire(
      values is List && values.length <= 50 && row['hasMore'] is bool,
    );
    final entries = (values as List).map(_summary).toList(growable: false);
    connectorRequire(
      entries
              .map((item) => '${item['kind']}\u0000${item['id']}')
              .toSet()
              .length ==
          entries.length,
    );
    final ordered = entries
        .map((item) => '${item['kind']}\u0000${item['id']}')
        .toList();
    final sorted = [...ordered]..sort();
    connectorRequire(connectorSame(ordered, sorted));
    await connectorServiceReceipt(
      row,
      owner,
      contract: connectorControlContract,
      operation: 'app.connectors.native.list',
      resource: 'connector_native_action',
      count: entries.length,
    );
    return ConnectorInventory(
      List.unmodifiable(entries.map(connectorFreeze)),
      row['hasMore'] as bool,
    );
  }
}

class ConnectorReview {
  const ConnectorReview(this.raw, this.value);
  final ConnectorJson raw;
  final ConnectorJson? value;
  ConnectorJson? get connector =>
      value == null ? null : connectorMap(value!['connector']);
  ConnectorJson? get pin =>
      value?['pin'] == null ? null : connectorMap(value!['pin']);
  List<String> get actions => value == null
      ? const []
      : List<String>.from(value!['availableActions'] as List);
  static Future<ConnectorReview> parse(
    Object? input,
    ConnectorOwner owner,
    String kind,
    String id,
  ) async {
    controlKind(kind);
    controlId(id);
    final raw = connectorObject(input, 'contract scope review serviceReceipt');
    ConnectorJson? review;
    if (raw['review'] != null) {
      review = connectorObject(
        raw['review'],
        'connector contracts pin availableActions unavailableReason',
      );
      final summary = _summary(review['connector']),
          contracts = review['contracts'],
          actions = review['availableActions'];
      connectorRequire(
        summary['kind'] == kind &&
            summary['id'] == id &&
            contracts is List &&
            contracts.length <= 200 &&
            actions is List &&
            actions.length <= 3 &&
            actions.toSet().length == actions.length &&
            actions.every(connectorControlActions.contains),
      );
      connectorRequire(utf8.encode(jsonEncode(review)).length <= 1048576);
      final ids = <String>{};
      for (final value in contracts as List) {
        final contract = connectorObject(
          value,
          'id name description status riskLevel approvalRequired fingerprint definition',
        );
        connectorRequire(ids.add(connectorText(contract['id'], 1000)));
        connectorText(contract['name'], 500);
        if (contract['description'] != null) {
          connectorText(contract['description'], 16000, empty: true);
        }
        connectorRequire(
          const [
                'active',
                'disabled',
                'pending_review',
              ].contains(contract['status']) &&
              contract['approvalRequired'] is bool,
        );
        connectorCount(contract['riskLevel'], 3);
        _fingerprint(contract['fingerprint']);
        connectorFreeze(connectorMap(contract['definition']));
      }
      connectorRequire(
        review['unavailableReason'] == null ||
            const [
              'scope_too_large',
              'unsupported_connector',
            ].contains(review['unavailableReason']),
      );
      connectorRequire(
        (review['unavailableReason'] == null ||
                review['pin'] == null && (actions as List).isEmpty) &&
            ((actions as List).isEmpty || review['pin'] != null) &&
            (kind != 'openapi' ||
                actions.every((action) => action == 'review_contracts')),
      );
      if (review['pin'] != null) {
        final pin = _pin(review['pin']);
        await _pinDigest(pin);
        connectorRequire(
          pin['kind'] == kind &&
              pin['connectorId'] == id &&
              pin['credentialVersion'] == summary['credentialVersion'] &&
              pin['connectorSha256'] == await connectorSha(summary) &&
              pin['contractsSha256'] == await connectorSha(contracts) &&
              summary['contractCount'] == contracts.length,
        );
      }
    }
    await connectorServiceReceipt(
      raw,
      owner,
      contract: connectorControlContract,
      operation: 'app.connectors.native.review',
      resource: 'connector_native_action',
      count: review == null ? 0 : 1,
    );
    return ConnectorReview(
      connectorFreeze(raw),
      review == null ? null : connectorFreeze(review),
    );
  }
}

class ConnectorIntent {
  const ConnectorIntent._(
    this.owner,
    this.key,
    this.identity,
    this.requestSha256,
  );
  final ConnectorOwner owner;
  final String key, requestSha256;
  final ConnectorJson identity;
  ConnectorJson get request => connectorMap(identity['request']);
  String get keySha256 => identity['keySha256'] as String;
  String get kind => request['kind'] as String;
  String get id => request['connectorId'] as String;
  String get action => request['action'] as String;
  ConnectorJson get stored => {
    'owner': owner.json,
    'key': key,
    'identity': identity,
    'requestSha256': requestSha256,
  };
  static Future<ConnectorIntent> prepare(
    ConnectorOwner owner,
    ConnectorReview review,
    String action, {
    String? key,
  }) async {
    connectorRequire(
      review.value != null &&
          review.pin != null &&
          review.actions.contains(action) &&
          connectorSame(review.raw['scope'], owner.scope),
    );
    return _create(
      owner,
      key ??
          'native-connector-${List.generate(24, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}',
      {
        'contract': 'asael-connector-action:1',
        'kind': review.connector!['kind'],
        'connectorId': review.connector!['id'],
        'action': action,
        'review': review.pin,
      },
    );
  }

  static Future<ConnectorIntent> _create(
    ConnectorOwner owner,
    String key,
    ConnectorJson request,
  ) async {
    connectorRequire(
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    connectorObject(request, 'contract kind connectorId action review');
    final kind = controlKind(request['kind']),
        id = controlId(request['connectorId']),
        pin = _pin(request['review']);
    await _pinDigest(pin);
    connectorRequire(
      request['contract'] == 'asael-connector-action:1' &&
          connectorControlActions.contains(request['action']) &&
          pin['kind'] == kind &&
          pin['connectorId'] == id &&
          (kind != 'openapi' || request['action'] == 'review_contracts'),
    );
    final identity = connectorFreeze({
      'contract': 'asael-connector-action-intent:1',
      'scope': owner.scope,
      'keySha256': await connectorRawSha('${owner.tenantId}\u0000$key'),
      'request': request,
    });
    return ConnectorIntent._(
      owner,
      key,
      identity,
      await connectorSha(identity),
    );
  }

  static Future<ConnectorIntent> restore(
    Object? value,
    ConnectorOwner current,
  ) async {
    final row = connectorObject(value, 'owner key identity requestSha256'),
        owner = ConnectorOwner.restore(row['owner'], current),
        identity = connectorObject(
          row['identity'],
          'contract scope keySha256 request',
        );
    final restored = await _create(
      owner,
      connectorText(row['key'], 512),
      connectorMap(identity['request']),
    );
    connectorRequire(
      connectorSame(restored.identity, identity) &&
          restored.requestSha256 == row['requestSha256'],
    );
    return restored;
  }
}

class ConnectorActionRead {
  const ConnectorActionRead(this.raw, this.action);
  final ConnectorJson raw;
  final ConnectorJson? action;
  ConnectorJson? get acceptance =>
      action == null ? null : connectorMap(action!['acceptance']);
  static Future<ConnectorActionRead> parse(
    Object? value,
    ConnectorOwner owner,
    String keySha256, {
    ConnectorIntent? intent,
    bool mutation = false,
  }) async {
    connectorHash(keySha256);
    final row = connectorObject(
      value,
      'contract scope action serviceReceipt${mutation ? ' replayed' : ''}',
    );
    if (mutation) {
      connectorRequire(
        intent != null &&
            row['action'] != null &&
            row['replayed'] is bool &&
            owner.key == intent.owner.key,
      );
    }
    ConnectorJson? action;
    if (row['action'] != null) {
      action = connectorObject(row['action'], 'acceptance state settlement');
      final accepted = connectorObject(
        action['acceptance'],
        'contract id scope keySha256 requestSha256 kind connectorId action reviewSha256 acceptedAt acceptanceSha256',
      );
      controlKind(accepted['kind']);
      controlId(accepted['connectorId']);
      _instant(accepted['acceptedAt']);
      for (final field in [
        'keySha256',
        'requestSha256',
        'reviewSha256',
        'acceptanceSha256',
      ]) {
        connectorHash(accepted[field]);
      }
      connectorRequire(
        accepted['contract'] == 'asael-connector-acceptance:1' &&
            connectorSame(accepted['scope'], owner.scope) &&
            accepted['keySha256'] == keySha256 &&
            connectorControlActions.contains(accepted['action']) &&
            accepted['id'] ==
                'connector-acceptance:${await connectorSha({'scope': owner.scope, 'keySha256': keySha256})}' &&
            accepted['acceptanceSha256'] ==
                await connectorSha({...accepted}..remove('acceptanceSha256')),
      );
      connectorRequire(
        const ['accepted', 'settled'].contains(action['state']) &&
            (action['state'] == 'settled') == (action['settlement'] != null),
      );
      if (action['settlement'] != null) {
        final settlement = connectorObject(
              action['settlement'],
              'contract acceptanceId settledAt result settlementSha256',
            ),
            result = connectorObject(
              settlement['result'],
              'kind connectorId status contractCount promotedCount connectorSha256 contractsSha256',
            );
        _instant(settlement['settledAt']);
        connectorHash(settlement['settlementSha256']);
        connectorHash(result['connectorSha256']);
        connectorHash(result['contractsSha256']);
        connectorCount(result['contractCount'], 200);
        connectorCount(result['promotedCount'], 200);
        connectorRequire(
          settlement['contract'] == 'asael-connector-settlement:1' &&
              settlement['acceptanceId'] == accepted['id'] &&
              result['kind'] == accepted['kind'] &&
              result['connectorId'] == accepted['connectorId'] &&
              const [
                'active',
                'disabled',
                'error',
              ].contains(result['status']) &&
              !DateTime.parse(settlement['settledAt'] as String)
                  .isBefore(DateTime.parse(accepted['acceptedAt'] as String)) &&
              settlement['settlementSha256'] ==
                  await connectorSha(
                    {...settlement}..remove('settlementSha256'),
                  ),
        );
      }
      if (intent != null) {
        connectorRequire(
          intent.owner.storageKey == owner.storageKey &&
              connectorSame(intent.owner.scope, owner.scope) &&
              keySha256 == intent.keySha256 &&
              accepted['requestSha256'] == intent.requestSha256 &&
              accepted['kind'] == intent.kind &&
              accepted['connectorId'] == intent.id &&
              accepted['action'] == intent.action &&
              accepted['reviewSha256'] ==
                  (intent.request['review'] as Map)['reviewSha256'],
        );
      }
    }
    await connectorServiceReceipt(
      row,
      owner,
      contract: connectorControlContract,
      operation: 'app.connectors.native.${mutation ? 'act' : 'show'}',
      resource: 'connector_native_action',
      count: action == null ? 0 : 1,
      key: mutation ? intent!.key : null,
      target: intent?.id,
      purpose: 'api.connectors.native.action',
      event: 'connector-native-events.v1',
    );
    return ConnectorActionRead(
      connectorFreeze(row),
      action == null ? null : connectorFreeze(action),
    );
  }
}
