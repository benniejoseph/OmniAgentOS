import 'dart:convert';
import 'dart:math';

import 'connector_contracts.dart';
import 'connector_control_contracts.dart';

bool mcpRegistrationTokenValid(String token) =>
    utf8.encode(token).length >= 8 &&
    utf8.encode(token).length <= 8192 &&
    token == token.trim() &&
    !RegExp(r'[\r\n]').hasMatch(token);

/// Bounded ASCII URL admission with WHATWG-compatible serialization. Preserve
/// escape case and every query/fragment byte; Uri.toString can rewrite these.
/// International hosts must use their ASCII form and paths percent encoding.
String normalizeMcpRegistrationEndpoint(String input) {
  connectorRequire(
    input.isNotEmpty &&
        input.length <= 2048 &&
        !RegExp(r'[\x00-\x20\x7f-\uffff\\<>"`{}|^]').hasMatch(input),
  );
  final match = RegExp(
    r'^(https?)://([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(/[^?#]*)?(\?[^#]*)?(#.*)?$',
    caseSensitive: false,
  ).firstMatch(input);
  connectorRequire(match != null);
  final scheme = match![1]!.toLowerCase(), host = match[2]!.toLowerCase();
  // WHATWG accepts legacy numeric IPv4 forms. Requiring ordinary dotted decimal
  // here prevents Dart from reviewing a different host from the server.
  final labels = host.replaceFirst(RegExp(r'\.$'), '').split('.');
  if (RegExp(
    r'^(?:[0-9]+|0x[0-9a-f]+)$',
    caseSensitive: false,
  ).hasMatch(labels.last)) {
    connectorRequire(
      !host.endsWith('.') &&
          labels.length == 4 &&
          labels.every(
            (label) =>
                RegExp(r'^(?:0|[1-9][0-9]{0,2})$').hasMatch(label) &&
                int.parse(label) <= 255,
          ),
    );
  }
  final port = match[3] == null ? null : int.parse(match[3]!);
  connectorRequire(port == null || port <= 65535);
  final authority =
      '$scheme://$host${port == null || port == (scheme == 'https' ? 443 : 80) ? '' : ':$port'}';
  final segments = (match[4] ?? '/').split('/').skip(1).toList();
  final path = <String>[];
  for (var index = 0; index < segments.length; index++) {
    final segment = segments[index];
    final dots = segment.replaceAll(RegExp('%2e', caseSensitive: false), '.');
    if (dots == '.' || dots == '..') {
      if (dots == '..' && path.isNotEmpty) {
        path.removeLast();
      }
      if (index == segments.length - 1) {
        path.add('');
      }
    } else {
      path.add(segment);
    }
  }
  final query = (match[5] ?? '').replaceAll("'", '%27');
  final normalized = '$authority/${path.join('/')}$query${match[6] ?? ''}';
  connectorRequire(normalized.length <= 2048);
  return normalized;
}

ConnectorJson mcpRegistrationEndpointProjection(String input) {
  final normalized = normalizeMcpRegistrationEndpoint(input);
  final offset = normalized.indexOf(RegExp('[?#]'));
  return {
    'endpoint': offset < 0 ? normalized : normalized.substring(0, offset),
    'endpointRedacted': offset >= 0,
  };
}

ConnectorJson mcpRegistrationDeclaration({
  required String name,
  required String endpoint,
  required String authType,
  String? authTokenEnv,
  int defaultRiskLevel = 2,
  bool approvalRequired = true,
}) => _declaration({
  'name': name.trim(),
  ...mcpRegistrationEndpointProjection(endpoint),
  'authType': authType,
  'authTokenEnv': authTokenEnv,
  'authHeaderName': null,
  'defaultRiskLevel': defaultRiskLevel,
  'approvalRequired': approvalRequired,
  'specSource': 'none',
  'specUrl': null,
  'specUrlRedacted': false,
});

ConnectorJson _declaration(Object? value) {
  final d = connectorObject(
    value,
    'name endpoint endpointRedacted authType authTokenEnv authHeaderName defaultRiskLevel approvalRequired specSource specUrl specUrlRedacted',
  );
  final name = connectorText(d['name'], 120),
      endpoint = connectorText(d['endpoint'], 2048);
  connectorRequire(
    name.trim() == name &&
        normalizeMcpRegistrationEndpoint(endpoint) == endpoint &&
        !endpoint.contains(RegExp('[?#]')) &&
        d['endpointRedacted'] is bool &&
        const ['none', 'bearer_env', 'bearer_vault'].contains(d['authType']) &&
        (d['authType'] == 'bearer_env'
            ? d['authTokenEnv'] is String &&
                  RegExp(r'^[A-Z0-9_]{1,120}$')
                      .hasMatch(d['authTokenEnv'] as String)
            : d['authTokenEnv'] == null) &&
        d['authHeaderName'] == null &&
        d['approvalRequired'] is bool &&
        d['specSource'] == 'none' &&
        d['specUrl'] == null &&
        d['specUrlRedacted'] == false,
  );
  connectorCount(d['defaultRiskLevel'], 3);
  return connectorFreeze(d);
}

String _randomHex(int count) => List.generate(
  count,
  (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0'),
).join();

Future<String> mcpRegistrationTargetId(
  ConnectorOwner owner,
  String nonce,
) async =>
    'native-mcp-${await connectorSha({'scope': owner.scope, 'nonce': nonce})}';

Future<ConnectorJson> _safeIntent(Object? value, ConnectorOwner owner) async {
  final row = connectorObject(
    value,
    'contract scope keySha256 nonce operation connectorId review declaration',
  );
  connectorRequire(
    row['contract'] == 'asael-connector-preparation-intent:1' &&
        connectorSame(row['scope'], owner.scope) &&
        row['operation'] == 'register_mcp' &&
        row['review'] == null,
  );
  connectorHash(row['keySha256']);
  final nonce = connectorText(row['nonce'], 36);
  connectorRequire(
    RegExp(
      r'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',
    ).hasMatch(nonce),
  );
  connectorRequire(
    row['connectorId'] == await mcpRegistrationTargetId(owner, nonce),
  );
  _declaration(row['declaration']);
  connectorRequire(utf8.encode(jsonEncode(row)).length <= 16384);
  return connectorFreeze(row);
}

/// Only the public declaration is serializable. Endpoint input and token are
/// transient arguments, never fields or a part of the durable journal.
class ConnectorMcpRegistrationPreparationIntent {
  const ConnectorMcpRegistrationPreparationIntent._(
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
  ConnectorJson get declaration => connectorMap(identity['declaration']);
  ConnectorJson get stored => {
    'owner': owner.json,
    'key': key,
    'identity': identity,
    'intentSha256': intentSha256,
  };
  ConnectorJson get abandonRequest => {
    'contract': 'asael-mcp-registration-preparation-abandon:1',
    'intent': identity,
  };
  ConnectorJson secretRequest(String endpoint, String? token) {
    final normalized = normalizeMcpRegistrationEndpoint(endpoint);
    final projected = mcpRegistrationEndpointProjection(normalized);
    connectorRequire(
      projected['endpoint'] == declaration['endpoint'] &&
          projected['endpointRedacted'] == declaration['endpointRedacted'] &&
          (declaration['authType'] == 'bearer_vault'
              ? token != null && mcpRegistrationTokenValid(token)
              : token == null),
    );
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
        'endpoint': normalized,
        'specUrl': null,
        'specText': null,
        'bearerToken': token,
      },
    };
  }

  static Future<ConnectorMcpRegistrationPreparationIntent> prepare(
    ConnectorOwner owner,
    ConnectorJson declaration, {
    String? key,
    String? nonce,
  }) async {
    final rawKey =
        key ?? 'native-mcp-registration-preparation-${_randomHex(24)}';
    final hex = _randomHex(16);
    final originalNonce =
        nonce ??
        '${hex.substring(0, 8)}-${hex.substring(8, 12)}-4${hex.substring(13, 16)}-8${hex.substring(17, 20)}-${hex.substring(20)}';
    return _create(owner, rawKey, {
      'contract': 'asael-connector-preparation-intent:1',
      'scope': owner.scope,
      'keySha256': await connectorRawSha('${owner.tenantId}\u0000$rawKey'),
      'nonce': originalNonce,
      'operation': 'register_mcp',
      'connectorId': await mcpRegistrationTargetId(owner, originalNonce),
      'review': null,
      'declaration': _declaration(declaration),
    });
  }

  static Future<ConnectorMcpRegistrationPreparationIntent> _create(
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
    return ConnectorMcpRegistrationPreparationIntent._(
      owner,
      key,
      identity,
      await connectorSha(identity),
    );
  }

  static Future<ConnectorMcpRegistrationPreparationIntent> restore(
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

class ConnectorMcpRegistrationPreparationProof {
  const ConnectorMcpRegistrationPreparationProof._(this.raw);
  final ConnectorJson raw;
  String get sha256 => raw['preparationSha256'] as String;
  bool freshAt(DateTime now) =>
      !now.isBefore(DateTime.parse(raw['preparedAt'] as String)) &&
      now.isBefore(DateTime.parse(raw['expiresAt'] as String));
  static Future<ConnectorMcpRegistrationPreparationProof> parse(
    Object? value,
    ConnectorMcpRegistrationPreparationIntent intent,
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
    connectorHash(p['configurationSha256']);
    connectorRequire(
      p['contract'] == 'asael-connector-preparation:1' &&
          p['id'] ==
              'connector-preparation:${await connectorSha({'operation': 'register_mcp', 'scope': intent.owner.scope, 'keySha256': intent.keySha256})}' &&
          p['intentSha256'] == intent.intentSha256 &&
          issued.endsWith('Z') &&
          expires.endsWith('Z') &&
          DateTime.parse(expires)
                  .difference(DateTime.parse(issued))
                  .inMilliseconds ==
              900000 &&
          p['preparationSha256'] ==
              await connectorSha({...p}..remove('preparationSha256')),
    );
    return ConnectorMcpRegistrationPreparationProof._(connectorFreeze(p));
  }
}

class ConnectorMcpRegistrationPreparationRead {
  const ConnectorMcpRegistrationPreparationRead._(
    this.raw,
    this.prepared,
    this.proof,
  );
  final ConnectorJson raw;
  final ConnectorJson? prepared;
  final ConnectorMcpRegistrationPreparationProof? proof;
  String? get availability => prepared?['availability'] as String?;
  String? get consumedKeySha256 => prepared?['consumedKeySha256'] as String?;
  static Future<ConnectorMcpRegistrationPreparationRead> parse(
    Object? value,
    ConnectorOwner owner, {
    required ConnectorMcpRegistrationPreparationIntent intent,
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
    ConnectorMcpRegistrationPreparationProof? proof;
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
        proof = await ConnectorMcpRegistrationPreparationProof.parse(
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
          a['contract'] == 'asael-mcp-registration-preparation-abandonment:1' &&
              a['id'] ==
                  'connector-preparation-abandonment:${await connectorSha({'operation': 'register_mcp', 'scope': owner.scope, 'keySha256': intent.keySha256})}' &&
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
      operation: 'app.connectors.native.mcpRegistrationPreparations.$kind',
      resource: 'connector_native_preparation',
      count: prepared == null ? 0 : 1,
      key: mutation ? intent.key : null,
      target: intent.id,
      purpose: kind == 'abandon'
          ? 'api.connectors.native.mcp_registration_preparation.abandon'
          : 'api.connectors.native.action',
      action: kind == 'abandon' ? 'read' : 'manage.connector',
      event: 'connector-native-mcp-registration-preparation-events.v1',
    );
    return ConnectorMcpRegistrationPreparationRead._(
      connectorFreeze(row),
      prepared == null ? null : connectorFreeze(prepared),
      proof,
    );
  }
}

/// A null raw key is a linked, GET-only identity recovered from consumption on
/// another device. It can never authorize a POST or acquire an invented key.
class ConnectorMcpRegistrationIntent {
  const ConnectorMcpRegistrationIntent._(
    this.preparation,
    this.proof,
    this.key,
    this.identity,
    this.requestSha256,
  );
  final ConnectorMcpRegistrationPreparationIntent preparation;
  final ConnectorMcpRegistrationPreparationProof proof;
  final String? key;
  final ConnectorJson identity;
  final String requestSha256;
  ConnectorOwner get owner => preparation.owner;
  String get id => preparation.id;
  String get keySha256 => identity['keySha256'] as String;
  ConnectorJson get request => connectorMap(identity['request']);
  ConnectorJson get stored => {
    'preparation': preparation.stored,
    'proof': proof.raw,
    'key': key,
    'identity': identity,
    'requestSha256': requestSha256,
  };
  static Future<ConnectorMcpRegistrationIntent> create(
    ConnectorMcpRegistrationPreparationIntent preparation,
    ConnectorMcpRegistrationPreparationProof proof, {
    String? key,
    String? consumedKeySha256,
  }) async {
    connectorRequire(key == null || consumedKeySha256 == null);
    final verified = await ConnectorMcpRegistrationPreparationProof.parse(
      proof.raw,
      preparation,
    );
    final rawKey = consumedKeySha256 == null
        ? key ?? 'native-mcp-registration-${_randomHex(24)}'
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
        'action': 'register_mcp',
        'preparationId': verified.raw['id'],
        'preparationSha256': verified.sha256,
        'review': null,
      },
    });
    return ConnectorMcpRegistrationIntent._(
      preparation,
      verified,
      rawKey,
      identity,
      await connectorSha(identity),
    );
  }

  static Future<ConnectorMcpRegistrationIntent> restore(
    Object? value,
    ConnectorOwner owner,
  ) async {
    final row = connectorObject(
      value,
      'preparation proof key identity requestSha256',
    );
    final preparation = await ConnectorMcpRegistrationPreparationIntent.restore(
      row['preparation'],
      owner,
    );
    final proof = await ConnectorMcpRegistrationPreparationProof.parse(
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

class ConnectorMcpRegistrationRead {
  const ConnectorMcpRegistrationRead._(this.raw, this.action);
  final ConnectorJson raw;
  final ConnectorJson? action;
  bool get settled => action?['state'] == 'settled';
  ConnectorJson? get acceptance =>
      action == null ? null : connectorMap(action!['acceptance']);
  static Future<ConnectorMcpRegistrationRead> parse(
    Object? value,
    ConnectorOwner owner, {
    required ConnectorMcpRegistrationIntent intent,
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
            a['action'] == 'register_mcp' &&
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
              r['operation'] == 'register_mcp' &&
              r['status'] == 'complete' &&
              r['connectorStatus'] == 'disabled' &&
              r['contractCount'] == 0 &&
              r['credentialVersion'] ==
                  (intent.preparation.declaration['authType'] == 'bearer_vault'
                      ? 1
                      : 0) &&
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
      operation: 'app.connectors.native.mcpRegistrations.$kind',
      resource: 'connector_native_action',
      count: action == null ? 0 : 1,
      key: mutation ? intent.key : null,
      target: intent.id,
      purpose: 'api.connectors.native.action',
      event: 'connector-native-mcp-registration-events.v1',
    );
    return ConnectorMcpRegistrationRead._(
      connectorFreeze(row),
      action == null ? null : connectorFreeze(action),
    );
  }
}
