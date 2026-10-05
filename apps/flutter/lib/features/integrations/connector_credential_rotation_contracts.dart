import 'dart:convert';
import 'dart:math';

import 'connector_contracts.dart';
import 'connector_control_contracts.dart';

bool credentialRotationEligible(ConnectorReview review) {
  final c = review.connector;
  return c != null &&
      review.pin != null &&
      review.value!['unavailableReason'] == null &&
      c['kind'] == 'mcp' &&
      (c['authType'] == 'bearer_vault' ||
          c['authType'] == 'none' && c['credentialConfigured'] == false) &&
      (c['credentialVersion'] as int) < 2147483647;
}

bool credentialRotationTokenValid(String token) =>
    utf8.encode(token).length >= 8 &&
    utf8.encode(token).length <= 8192 &&
    token == token.trim() &&
    !RegExp(r'[\r\n]').hasMatch(token);

String _randomHex(int count) => List.generate(
  count,
  (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0'),
).join();

Future<ConnectorJson> _pin(Object? value, String id) async {
  final pin = connectorObject(
    value,
    'kind connectorId connectorSha256 contractsSha256 configurationSha256 reviewFingerprint credentialVersion reviewSha256',
  );
  connectorRequire(pin['kind'] == 'mcp' && pin['connectorId'] == id);
  connectorCount(pin['credentialVersion'], 2147483646);
  for (final name in [
    'connectorSha256',
    'contractsSha256',
    'configurationSha256',
    'reviewSha256',
  ]) {
    connectorHash(pin[name]);
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
  return connectorFreeze(pin);
}

ConnectorJson credentialRotationDeclaration(ConnectorReview review) => {
  'name': review.connector!['name'],
  'endpoint': review.connector!['endpoint'],
  'endpointRedacted': review.connector!['endpointRedacted'],
  'authType': 'bearer_vault',
  'authTokenEnv': null,
  'authHeaderName': null,
  'defaultRiskLevel': review.connector!['defaultRiskLevel'],
  'approvalRequired': review.connector!['approvalRequired'],
  'specSource': 'none',
  'specUrl': null,
  'specUrlRedacted': false,
};

Future<ConnectorJson> _safeIntent(Object? value, ConnectorOwner owner) async {
  final row = connectorObject(
    value,
    'contract scope keySha256 nonce operation connectorId review declaration',
  );
  connectorRequire(
    row['contract'] == 'asael-connector-preparation-intent:1' &&
        connectorSame(row['scope'], owner.scope) &&
        row['operation'] == 'rotate_mcp',
  );
  connectorHash(row['keySha256']);
  connectorRequire(
    RegExp(
      r'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',
    ).hasMatch(connectorText(row['nonce'], 36)),
  );
  await _pin(row['review'], controlId(row['connectorId']));
  final d = connectorObject(
    row['declaration'],
    'name endpoint endpointRedacted authType authTokenEnv authHeaderName defaultRiskLevel approvalRequired specSource specUrl specUrlRedacted',
  );
  final name = connectorText(d['name'], 120),
      endpoint = connectorText(d['endpoint'], 2048);
  final uri = Uri.tryParse(endpoint);
  connectorRequire(
    name.trim() == name &&
        uri != null &&
        const ['http', 'https'].contains(uri.scheme) &&
        uri.host.isNotEmpty &&
        uri.userInfo.isEmpty &&
        !uri.hasQuery &&
        !uri.hasFragment &&
        d['endpointRedacted'] is bool &&
        d['authType'] == 'bearer_vault' &&
        d['authTokenEnv'] == null &&
        d['authHeaderName'] == null &&
        d['approvalRequired'] is bool &&
        d['specSource'] == 'none' &&
        d['specUrl'] == null &&
        d['specUrlRedacted'] == false,
  );
  connectorCount(d['defaultRiskLevel'], 3);
  connectorRequire(utf8.encode(jsonEncode(row)).length <= 16384);
  return connectorFreeze(row);
}

/// Only safe intent is serializable. The transient token is never a field.
class ConnectorCredentialPreparationIntent {
  const ConnectorCredentialPreparationIntent._(
    this.owner,
    this.key,
    this.identity,
    this.intentSha256,
  );
  final ConnectorOwner owner;
  final String key, intentSha256;
  final ConnectorJson identity;
  String get id => identity['connectorId'] as String;
  String get keySha256 => identity['keySha256'] as String;
  ConnectorJson get review => connectorMap(identity['review']);
  ConnectorJson get stored => {
    'owner': owner.json,
    'key': key,
    'identity': identity,
    'intentSha256': intentSha256,
  };
  ConnectorJson get abandonRequest => {
    'contract': 'asael-connector-credential-preparation-abandon:1',
    'intent': identity,
  };
  ConnectorJson secretRequest(String token) {
    connectorRequire(credentialRotationTokenValid(token));
    return {
      'contract': 'asael-connector-prepare:1',
      for (final field in [
        'nonce',
        'operation',
        'connectorId',
        'review',
        'declaration',
      ])
        field: identity[field],
      'payload': {
        'endpoint': null,
        'specUrl': null,
        'specText': null,
        'bearerToken': token,
      },
    };
  }

  static Future<ConnectorCredentialPreparationIntent> prepare(
    ConnectorOwner owner,
    ConnectorReview review, {
    String? key,
    String? nonce,
  }) async {
    connectorRequire(
      credentialRotationEligible(review) &&
          connectorSame(review.raw['scope'], owner.scope),
    );
    final rawKey = key ?? 'native-credential-preparation-${_randomHex(24)}';
    final hex = _randomHex(16);
    return _create(owner, rawKey, {
      'contract': 'asael-connector-preparation-intent:1',
      'scope': owner.scope,
      'keySha256': await connectorRawSha('${owner.tenantId}\u0000$rawKey'),
      'nonce':
          nonce ??
          '${hex.substring(0, 8)}-${hex.substring(8, 12)}-4${hex.substring(13, 16)}-8${hex.substring(17, 20)}-${hex.substring(20)}',
      'operation': 'rotate_mcp',
      'connectorId': review.connector!['id'],
      'review': review.pin,
      'declaration': credentialRotationDeclaration(review),
    });
  }

  static Future<ConnectorCredentialPreparationIntent> _create(
    ConnectorOwner owner,
    String key,
    Object? value,
  ) async {
    connectorId(key, maximum: 512);
    final identity = await _safeIntent(value, owner);
    connectorRequire(
      identity['keySha256'] ==
          await connectorRawSha('${owner.tenantId}\u0000$key'),
    );
    return ConnectorCredentialPreparationIntent._(
      owner,
      key,
      identity,
      await connectorSha(identity),
    );
  }

  static Future<ConnectorCredentialPreparationIntent> restore(
    Object? value,
    ConnectorOwner current,
  ) async {
    final row = connectorObject(value, 'owner key identity intentSha256');
    final owner = ConnectorOwner.restore(row['owner'], current);
    connectorRequire(connectorSame(owner.scope, current.scope));
    final intent = await _create(
      owner,
      connectorText(row['key'], 512),
      row['identity'],
    );
    connectorRequire(row['intentSha256'] == intent.intentSha256);
    return intent;
  }
}

class ConnectorCredentialPreparationProof {
  const ConnectorCredentialPreparationProof._(this.raw);
  final ConnectorJson raw;
  String get sha256 => raw['preparationSha256'] as String;
  bool freshAt(DateTime now) =>
      !now.isBefore(DateTime.parse(raw['preparedAt'] as String)) &&
      now.isBefore(DateTime.parse(raw['expiresAt'] as String));
  static Future<ConnectorCredentialPreparationProof> parse(
    Object? value,
    ConnectorCredentialPreparationIntent intent,
  ) async {
    final p = connectorObject(
      value,
      'contract id scope keySha256 intentSha256 nonce operation connectorId review declaration configurationSha256 preparedAt expiresAt preparationSha256',
    );
    for (final field in [
      'scope',
      'keySha256',
      'nonce',
      'operation',
      'connectorId',
      'review',
      'declaration',
    ]) {
      connectorRequire(connectorSame(p[field], intent.identity[field]));
    }
    final issued = connectorInstant(p['preparedAt']),
        expires = connectorInstant(p['expiresAt']);
    connectorHash(p['preparationSha256']);
    connectorRequire(
      p['contract'] == 'asael-connector-preparation:1' &&
          p['id'] ==
              'connector-preparation:${await connectorSha({'scope': intent.owner.scope, 'keySha256': intent.keySha256})}' &&
          p['intentSha256'] == intent.intentSha256 &&
          p['configurationSha256'] == intent.review['configurationSha256'] &&
          issued.endsWith('Z') &&
          expires.endsWith('Z') &&
          DateTime.parse(expires)
                  .difference(DateTime.parse(issued))
                  .inMilliseconds ==
              900000 &&
          p['preparationSha256'] ==
              await connectorSha({...p}..remove('preparationSha256')),
    );
    return ConnectorCredentialPreparationProof._(connectorFreeze(p));
  }
}

class ConnectorCredentialPreparationRead {
  const ConnectorCredentialPreparationRead._(
    this.raw,
    this.prepared,
    this.proof,
  );
  final ConnectorJson raw;
  final ConnectorJson? prepared;
  final ConnectorCredentialPreparationProof? proof;
  String? get availability => prepared?['availability'] as String?;
  String? get consumedKeySha256 => prepared?['consumedKeySha256'] as String?;
  static Future<ConnectorCredentialPreparationRead> parse(
    Object? value,
    ConnectorOwner owner, {
    required ConnectorCredentialPreparationIntent intent,
    String kind = 'read',
  }) async {
    connectorRequire(
      const ['read', 'submit', 'abandon'].contains(kind) &&
          owner.storageKey == intent.owner.storageKey &&
          connectorSame(owner.scope, intent.owner.scope),
    );
    final mutation = kind != 'read';
    if (kind == 'submit') {
      connectorRequire(owner.key == intent.owner.key);
    }
    final row = connectorObject(
      value,
      'contract scope prepared serviceReceipt${mutation ? ' replayed' : ''}',
    );
    if (mutation) {
      connectorRequire(row['prepared'] != null && row['replayed'] is bool);
    }
    ConnectorJson? prepared;
    ConnectorCredentialPreparationProof? proof;
    if (row['prepared'] != null) {
      final branch = connectorMap(row['prepared']);
      final abandoned = branch['availability'] == 'abandoned';
      prepared = connectorObject(
        branch,
        'preparation availability consumedBy consumedKeySha256${abandoned ? ' intent abandonment' : ''}',
      );
      connectorRequire(
        const [
              'ready',
              'expired',
              'consumed',
              'abandoned',
            ].contains(prepared['availability']) &&
            (kind != 'submit' || !abandoned) &&
            (kind != 'abandon' || abandoned),
      );
      if (prepared['preparation'] != null) {
        proof = await ConnectorCredentialPreparationProof.parse(
          prepared['preparation'],
          intent,
        );
      } else {
        connectorRequire(abandoned);
      }
      if (prepared['availability'] == 'consumed') {
        final key = connectorHash(prepared['consumedKeySha256']);
        connectorRequire(
          prepared['consumedBy'] ==
              'connector-acceptance:${await connectorSha({'scope': owner.scope, 'keySha256': key})}',
        );
      } else {
        connectorRequire(
          prepared['consumedBy'] == null &&
              prepared['consumedKeySha256'] == null,
        );
      }
      if (abandoned) {
        connectorRequire(connectorSame(prepared['intent'], intent.identity));
        final a = connectorObject(
          prepared['abandonment'],
          'contract id scope keySha256 intentSha256 preparationSha256 abandonedAt abandonmentSha256',
        );
        connectorRequire(connectorInstant(a['abandonedAt']).endsWith('Z'));
        connectorHash(a['abandonmentSha256']);
        connectorRequire(
          a['contract'] ==
                  'asael-connector-credential-preparation-abandonment:1' &&
              a['id'] ==
                  'connector-preparation-abandonment:${await connectorSha({'scope': owner.scope, 'keySha256': intent.keySha256})}' &&
              connectorSame(a['scope'], owner.scope) &&
              a['keySha256'] == intent.keySha256 &&
              a['intentSha256'] == intent.intentSha256 &&
              a['preparationSha256'] == proof?.sha256 &&
              (proof == null ||
                  !DateTime.parse(a['abandonedAt'] as String).isBefore(
                    DateTime.parse(proof.raw['preparedAt'] as String),
                  )) &&
              a['abandonmentSha256'] ==
                  await connectorSha({...a}..remove('abandonmentSha256')),
        );
      }
    }
    await connectorServiceReceipt(
      row,
      owner,
      contract: connectorControlContract,
      operation: 'app.connectors.native.credentialPreparations.$kind',
      resource: 'connector_native_preparation',
      count: prepared == null ? 0 : 1,
      key: mutation ? intent.key : null,
      target: intent.id,
      purpose: kind == 'abandon'
          ? 'api.connectors.native.preparation.abandon'
          : 'api.connectors.native.action',
      action: kind == 'abandon' ? 'read' : 'manage.connector',
      event: 'connector-native-credential-preparation-events.v1',
    );
    return ConnectorCredentialPreparationRead._(
      connectorFreeze(row),
      prepared == null ? null : connectorFreeze(prepared),
      proof,
    );
  }
}

/// A null raw key is a linked, GET-only identity recovered from consumption on
/// another device. It can never authorize a POST or acquire an invented key.
class ConnectorCredentialRotationIntent {
  const ConnectorCredentialRotationIntent._(
    this.preparation,
    this.proof,
    this.key,
    this.identity,
    this.requestSha256,
  );
  final ConnectorCredentialPreparationIntent preparation;
  final ConnectorCredentialPreparationProof proof;
  final String? key;
  final ConnectorJson identity;
  final String requestSha256;
  ConnectorOwner get owner => preparation.owner;
  String get id => preparation.id;
  String get keySha256 => identity['keySha256'] as String;
  ConnectorJson get review => preparation.review;
  ConnectorJson get request => connectorMap(identity['request']);
  ConnectorJson get stored => {
    'preparation': preparation.stored,
    'proof': proof.raw,
    'key': key,
    'identity': identity,
    'requestSha256': requestSha256,
  };
  static Future<ConnectorCredentialRotationIntent> create(
    ConnectorCredentialPreparationIntent preparation,
    ConnectorCredentialPreparationProof proof, {
    String? key,
    String? consumedKeySha256,
  }) async {
    connectorRequire(key == null || consumedKeySha256 == null);
    final verified = await ConnectorCredentialPreparationProof.parse(
      proof.raw,
      preparation,
    );
    final rawKey = consumedKeySha256 == null
        ? key ?? 'native-credential-rotation-${_randomHex(24)}'
        : null;
    if (rawKey != null) {
      connectorId(rawKey, maximum: 512);
    }
    final sha = consumedKeySha256 == null
        ? await connectorRawSha('${preparation.owner.tenantId}\u0000$rawKey')
        : connectorHash(consumedKeySha256);
    final identity = connectorFreeze({
      'contract': 'asael-connector-action-intent:1',
      'scope': preparation.owner.scope,
      'keySha256': sha,
      'request': {
        'contract': 'asael-connector-prepared-action:1',
        'kind': 'mcp',
        'connectorId': preparation.id,
        'action': 'rotate_mcp',
        'preparationId': verified.raw['id'],
        'preparationSha256': verified.sha256,
        'review': preparation.review,
      },
    });
    return ConnectorCredentialRotationIntent._(
      preparation,
      verified,
      rawKey,
      identity,
      await connectorSha(identity),
    );
  }

  static Future<ConnectorCredentialRotationIntent> restore(
    Object? value,
    ConnectorOwner owner,
  ) async {
    final row = connectorObject(
      value,
      'preparation proof key identity requestSha256',
    );
    final preparation = await ConnectorCredentialPreparationIntent.restore(
      row['preparation'],
      owner,
    );
    final proof = await ConnectorCredentialPreparationProof.parse(
      row['proof'],
      preparation,
    );
    final identity = connectorObject(
      row['identity'],
      'contract scope keySha256 request',
    );
    final intent = await create(
      preparation,
      proof,
      key: row['key'] == null ? null : connectorText(row['key'], 512),
      consumedKeySha256: row['key'] == null
          ? connectorHash(identity['keySha256'])
          : null,
    );
    connectorRequire(
      connectorSame(intent.identity, identity) &&
          intent.requestSha256 == row['requestSha256'],
    );
    return intent;
  }
}

class ConnectorCredentialRotationRead {
  const ConnectorCredentialRotationRead._(this.raw, this.action);
  final ConnectorJson raw;
  final ConnectorJson? action;
  bool get settled => action?['state'] == 'settled';
  ConnectorJson? get acceptance =>
      action == null ? null : connectorMap(action!['acceptance']);
  static Future<ConnectorCredentialRotationRead> parse(
    Object? value,
    ConnectorOwner owner, {
    required ConnectorCredentialRotationIntent intent,
    String kind = 'read',
  }) async {
    final mutation = kind == 'submit';
    connectorRequire(
      const ['read', 'submit'].contains(kind) &&
          owner.storageKey == intent.owner.storageKey &&
          connectorSame(owner.scope, intent.owner.scope) &&
          (!mutation || intent.key != null && owner.key == intent.owner.key),
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
      final at = connectorInstant(a['acceptedAt']);
      connectorRequire(
        at.endsWith('Z') &&
            a['contract'] == 'asael-connector-acceptance:1' &&
            connectorSame(a['scope'], owner.scope) &&
            a['keySha256'] == intent.keySha256 &&
            a['requestSha256'] == intent.requestSha256 &&
            a['kind'] == 'mcp' &&
            a['connectorId'] == intent.id &&
            a['action'] == 'rotate_mcp' &&
            a['reviewSha256'] == intent.proof.sha256 &&
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
        final r = connectorObject(
          s['result'],
          'kind connectorId operation status connectorStatus contractCount credentialVersion connectorSha256 contractsSha256 configurationSha256 trash failureCode',
        );
        final settledAt = connectorInstant(s['settledAt']);
        for (final name in [
          'connectorSha256',
          'contractsSha256',
          'configurationSha256',
        ]) {
          connectorHash(r[name]);
        }
        connectorRequire(
          s['contract'] == 'asael-connector-settlement:2' &&
              s['acceptanceId'] == a['id'] &&
              settledAt.endsWith('Z') &&
              !DateTime.parse(settledAt).isBefore(DateTime.parse(at)) &&
              r['kind'] == 'mcp' &&
              r['connectorId'] == intent.id &&
              r['operation'] == 'rotate_mcp' &&
              r['status'] == 'complete' &&
              r['connectorStatus'] == 'disabled' &&
              r['contractCount'] == 0 &&
              r['credentialVersion'] ==
                  (intent.review['credentialVersion'] as int) + 1 &&
              r['contractsSha256'] == await connectorSha(<Object?>[]) &&
              r['trash'] == null &&
              r['failureCode'] == null &&
              s['settlementSha256'] ==
                  await connectorSha({...s}..remove('settlementSha256')),
        );
      }
    }
    await connectorServiceReceipt(
      row,
      owner,
      contract: connectorControlContract,
      operation: 'app.connectors.native.credentialRotations.$kind',
      resource: 'connector_native_action',
      count: action == null ? 0 : 1,
      key: mutation ? intent.key : null,
      target: intent.id,
      purpose: 'api.connectors.native.action',
      event: 'connector-native-credential-rotation-events.v1',
    );
    return ConnectorCredentialRotationRead._(
      connectorFreeze(row),
      action == null ? null : connectorFreeze(action),
    );
  }
}
