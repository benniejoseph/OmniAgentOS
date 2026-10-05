import 'dart:convert';
import 'dart:math';

import 'connector_contracts.dart';
import 'connector_control_contracts.dart';
import 'connector_mcp_registration_contracts.dart'
    show normalizeMcpRegistrationEndpoint, mcpRegistrationEndpointProjection;

String normalizeOpenApiImportBase(String input) {
  final normalized = normalizeMcpRegistrationEndpoint(input);
  connectorRequire(!normalized.contains(RegExp('[?#]')));
  return normalized.endsWith('/')
      ? normalized.substring(0, normalized.length - 1)
      : normalized;
}

bool openApiImportHeaderValid(String value) =>
    RegExp(r"^[!#$%&'*+.^_\x60|~0-9A-Za-z-]{1,80}$").hasMatch(value) &&
    !RegExp(
      r'^(authorization|cookie|host|connection|content-length|transfer-encoding|forwarded|proxy-|sec-|cf-connecting-ip|true-client-ip|x-(?:forwarded-|original-|rewrite-|http-method-override$|method-override$|real-ip$|client-ip$|vercel-))',
      caseSensitive: false,
    ).hasMatch(value);

ConnectorJson openApiImportDeclaration({
  required String name,
  required String source,
  required String authType,
  String? specUrl,
  String? endpoint,
  String? authTokenEnv,
  String? authHeaderName,
  int defaultRiskLevel = 2,
  bool approvalRequired = true,
}) {
  final projection = specUrl == null
      ? null
      : mcpRegistrationEndpointProjection(specUrl);
  return _declaration({
    'name': name.trim(),
    'endpoint': endpoint == null ? null : normalizeOpenApiImportBase(endpoint),
    'endpointRedacted': false,
    'authType': authType,
    'authTokenEnv': authTokenEnv,
    'authHeaderName': authHeaderName,
    'defaultRiskLevel': defaultRiskLevel,
    'approvalRequired': approvalRequired,
    'specSource': source,
    'specUrl': projection?['endpoint'],
    'specUrlRedacted': projection?['endpointRedacted'] ?? false,
  });
}

ConnectorJson _declaration(Object? value, {bool resolved = false}) {
  final d = connectorObject(
    value,
    'name endpoint endpointRedacted authType authTokenEnv authHeaderName defaultRiskLevel approvalRequired specSource specUrl specUrlRedacted',
  );
  final name = connectorText(d['name'], 120);
  connectorRequire(
    name.trim() == name &&
        d['endpointRedacted'] == false &&
        const [
          'none',
          'bearer_env',
          'api_key_header_env',
        ].contains(d['authType']) &&
        d['approvalRequired'] is bool &&
        const ['url', 'text'].contains(d['specSource']) &&
        d['specUrlRedacted'] is bool,
  );
  if (d['endpoint'] != null) {
    final endpoint = connectorText(d['endpoint'], 2048);
    connectorRequire(normalizeOpenApiImportBase(endpoint) == endpoint);
  } else {
    connectorRequire(!resolved);
  }
  connectorRequire(
    d['authType'] == 'none'
        ? d['authTokenEnv'] == null
        : d['authTokenEnv'] is String &&
              RegExp(r'^[A-Z0-9_]{1,120}$')
                  .hasMatch(d['authTokenEnv'] as String),
  );
  connectorRequire(
    d['authType'] == 'api_key_header_env'
        ? d['authHeaderName'] is String &&
              openApiImportHeaderValid(d['authHeaderName'] as String)
        : d['authHeaderName'] == null,
  );
  if (d['specSource'] == 'url') {
    final url = connectorText(d['specUrl'], 2048);
    connectorRequire(
      normalizeMcpRegistrationEndpoint(url) == url &&
          !url.contains(RegExp('[?#]')),
    );
  } else {
    connectorRequire(d['specUrl'] == null && d['specUrlRedacted'] == false);
  }
  connectorCount(d['defaultRiskLevel'], 3);
  return connectorFreeze(d);
}

String _randomHex(int count) => List.generate(
  count,
  (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0'),
).join();

Future<String> openApiImportTargetId(
  ConnectorOwner owner,
  String nonce,
) async =>
    'native-openapi-${await connectorSha({'scope': owner.scope, 'nonce': nonce})}';

Future<ConnectorJson> _safeIntent(Object? value, ConnectorOwner owner) async {
  final row = connectorObject(
    value,
    'contract scope keySha256 kind nonce operation connectorId review declaration',
  );
  connectorRequire(
    row['contract'] == 'asael-openapi-import-preparation-intent:1' &&
        connectorSame(row['scope'], owner.scope) &&
        row['kind'] == 'openapi' &&
        row['operation'] == 'import_openapi' &&
        row['review'] == null,
  );
  connectorHash(row['keySha256']);
  final nonce = connectorText(row['nonce'], 36);
  connectorRequire(
    RegExp(
      r'^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
    ).hasMatch(nonce),
  );
  connectorRequire(
    row['connectorId'] == await openApiImportTargetId(owner, nonce),
  );
  _declaration(row['declaration']);
  connectorRequire(utf8.encode(jsonEncode(row)).length <= 16384);
  return connectorFreeze(row);
}

/// Only this original public intent is durable. Full source URL, override and
/// specification text stay transient and are never copied into its declaration.
class ConnectorOpenApiImportPreparationIntent {
  const ConnectorOpenApiImportPreparationIntent._(
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
    'contract': 'asael-openapi-import-preparation-abandon:1',
    'intent': identity,
  };
  ConnectorJson privateRequest(ConnectorJson payload) {
    final p = connectorObject(payload, 'endpoint specUrl specText');
    final endpoint = p['endpoint'] == null
        ? null
        : normalizeOpenApiImportBase(connectorText(p['endpoint'], 2048));
    connectorRequire(endpoint == declaration['endpoint']);
    String? sourceUrl;
    if (declaration['specSource'] == 'url') {
      sourceUrl = normalizeMcpRegistrationEndpoint(
        connectorText(p['specUrl'], 2048),
      );
      final projection = mcpRegistrationEndpointProjection(sourceUrl);
      connectorRequire(
        p['specText'] == null &&
            projection['endpoint'] == declaration['specUrl'] &&
            projection['endpointRedacted'] == declaration['specUrlRedacted'],
      );
    } else {
      connectorRequire(
        p['specUrl'] == null &&
            p['specText'] is String &&
            utf8.encode(p['specText'] as String).isNotEmpty &&
            utf8.encode(p['specText'] as String).length <= 2000000,
      );
    }
    final request = <String, dynamic>{
      'contract': 'asael-openapi-import-prepare:1',
      for (final field in [
        'kind',
        'nonce',
        'operation',
        'connectorId',
        'review',
        'declaration',
      ])
        field: identity[field],
      'payload': {
        'endpoint': endpoint,
        'specUrl': sourceUrl,
        'specText': p['specText'],
      },
    };
    connectorRequire(utf8.encode(jsonEncode(request)).length <= 4100000);
    return request;
  }

  static Future<ConnectorOpenApiImportPreparationIntent> prepare(
    ConnectorOwner owner,
    ConnectorJson declaration, {
    String? key,
    String? nonce,
  }) async {
    final rawKey = key ?? 'native-openapi-import-preparation-${_randomHex(24)}';
    final hex = _randomHex(16);
    final originalNonce =
        nonce ??
        '${hex.substring(0, 8)}-${hex.substring(8, 12)}-4${hex.substring(13, 16)}-8${hex.substring(17, 20)}-${hex.substring(20)}';
    return _create(owner, rawKey, {
      'contract': 'asael-openapi-import-preparation-intent:1',
      'scope': owner.scope,
      'keySha256': await connectorRawSha('${owner.tenantId}\u0000$rawKey'),
      'kind': 'openapi',
      'nonce': originalNonce,
      'operation': 'import_openapi',
      'connectorId': await openApiImportTargetId(owner, originalNonce),
      'review': null,
      'declaration': _declaration(declaration),
    });
  }

  static Future<ConnectorOpenApiImportPreparationIntent> _create(
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
    return ConnectorOpenApiImportPreparationIntent._(
      owner,
      key,
      identity,
      await connectorSha(identity),
    );
  }

  static Future<ConnectorOpenApiImportPreparationIntent> restore(
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

Future<ConnectorJson> _attempt(
  Object? value,
  ConnectorOpenApiImportPreparationIntent intent,
) async {
  final a = connectorObject(
    value,
    'contract id scope keySha256 intentSha256 startedAt expiresAt attemptSha256',
  );
  final started = connectorInstant(a['startedAt']),
      expires = connectorInstant(a['expiresAt']);
  connectorRequire(
    a['contract'] == 'asael-openapi-import-attempt:1' &&
        a['id'] ==
            'connector-openapi-import-attempt:${await connectorSha({'operation': 'import_openapi', 'scope': intent.owner.scope, 'keySha256': intent.keySha256})}' &&
        connectorSame(a['scope'], intent.owner.scope) &&
        a['keySha256'] == intent.keySha256 &&
        a['intentSha256'] == intent.intentSha256 &&
        started.endsWith('Z') &&
        expires.endsWith('Z') &&
        DateTime.parse(expires)
                .difference(DateTime.parse(started))
                .inMilliseconds ==
            45000 &&
        a['attemptSha256'] ==
            await connectorSha({...a}..remove('attemptSha256')),
  );
  return connectorFreeze(a);
}

class ConnectorOpenApiImportPreparationProof {
  const ConnectorOpenApiImportPreparationProof._(this.raw, this.attempt);
  final ConnectorJson raw, attempt;
  String get sha256 => raw['preparationSha256'] as String;
  int get contractCount => raw['contractCount'] as int;
  ConnectorJson get resolvedDeclaration =>
      connectorMap(raw['resolvedDeclaration']);
  bool freshAt(DateTime now) =>
      !now.isBefore(DateTime.parse(raw['preparedAt'] as String)) &&
      now.isBefore(DateTime.parse(raw['expiresAt'] as String));
  static Future<ConnectorOpenApiImportPreparationProof> parse(
    Object? value,
    ConnectorOpenApiImportPreparationIntent intent,
    Object? attemptValue,
  ) async {
    final attempt = await _attempt(attemptValue, intent);
    final p = connectorObject(
      value,
      'contract id scope keySha256 intentSha256 kind nonce operation connectorId review declaration resolvedDeclaration attemptSha256 configurationSha256 snapshotSha256 summarySha256 reviewProjectionSha256 contractCount preparedAt expiresAt preparationSha256',
    );
    for (final field in [
      'scope',
      'keySha256',
      'kind',
      'nonce',
      'operation',
      'connectorId',
      'review',
      'declaration',
    ]) {
      connectorRequire(connectorSame(p[field], intent.identity[field]));
    }
    final resolved = _declaration(p['resolvedDeclaration'], resolved: true);
    connectorRequire(
      connectorSame({
            ...resolved,
            'endpoint': intent.declaration['endpoint'],
          }, intent.declaration) &&
          (intent.declaration['endpoint'] == null ||
              resolved['endpoint'] == intent.declaration['endpoint']),
    );
    for (final field in [
      'configurationSha256',
      'snapshotSha256',
      'summarySha256',
      'reviewProjectionSha256',
      'preparationSha256',
    ]) {
      connectorHash(p[field]);
    }
    final issued = connectorInstant(p['preparedAt']),
        expires = connectorInstant(p['expiresAt']);
    final issuedAt = DateTime.parse(issued);
    connectorRequire(
      p['contract'] == 'asael-openapi-import-preparation:1' &&
          p['id'] ==
              'connector-preparation:${await connectorSha({'operation': 'import_openapi', 'scope': intent.owner.scope, 'keySha256': intent.keySha256})}' &&
          p['intentSha256'] == intent.intentSha256 &&
          p['attemptSha256'] == attempt['attemptSha256'] &&
          connectorCount(p['contractCount'], 200) >= 1 &&
          issued.endsWith('Z') &&
          expires.endsWith('Z') &&
          !issuedAt.isBefore(DateTime.parse(attempt['startedAt'] as String)) &&
          issuedAt.isBefore(DateTime.parse(attempt['expiresAt'] as String)) &&
          DateTime.parse(expires).difference(issuedAt).inMilliseconds ==
              900000 &&
          p['preparationSha256'] ==
              await connectorSha({...p}..remove('preparationSha256')),
    );
    return ConnectorOpenApiImportPreparationProof._(
      connectorFreeze(p),
      attempt,
    );
  }
}

bool openApiImportPathValid(String path) {
  String decoded;
  try {
    decoded = Uri.decodeComponent(path);
  } catch (_) {
    return false;
  }
  return path.isNotEmpty &&
      path.length <= 2048 &&
      path.startsWith('/') &&
      !path.startsWith('//') &&
      !RegExp(r'[?#\\\x00-\x1f\x7f]').hasMatch(path) &&
      !RegExp(r'%5c|%25(?:2e|2f|5c)', caseSensitive: false).hasMatch(path) &&
      !decoded.startsWith('//') &&
      !RegExp(r'[\\\x00-\x1f\x7f]').hasMatch(decoded) &&
      !decoded.split('/').any((part) => part == '.' || part == '..');
}

Future<ConnectorJson> _summary(
  Object? value,
  ConnectorOpenApiImportPreparationProof proof,
) async {
  final s = connectorObject(value, 'contract connectorId operations');
  connectorRequire(
    s['contract'] == 'asael-openapi-import-summary:1' &&
        s['connectorId'] == proof.raw['connectorId'] &&
        s['operations'] is List,
  );
  final operations = s['operations'] as List;
  connectorRequire(operations.length == proof.contractCount);
  final ids = <String>{}, operationsIds = <String>{};
  for (final value in operations) {
    final op = connectorObject(
      value,
      'id operationId method path riskLevel approvalRequired definitionSha256',
    );
    final operation = connectorText(op['operationId'], 500);
    final id = connectorText(op['id'], 1000),
        path = connectorText(op['path'], 2048);
    connectorRequire(
      RegExp(r'^[A-Za-z0-9_]+$').hasMatch(operation) &&
          id ==
              'openapi:${s['connectorId']}:${Uri.encodeComponent(operation)}' &&
          ids.add(id) &&
          operationsIds.add(operation) &&
          const [
            'GET',
            'POST',
            'PUT',
            'PATCH',
            'DELETE',
            'HEAD',
            'OPTIONS',
          ].contains(op['method']) &&
          openApiImportPathValid(path),
    );
    connectorRequire(
      (const ['GET', 'HEAD', 'OPTIONS'].contains(op['method']) ||
              connectorCount(op['riskLevel'], 3) >= 2) &&
          connectorCount(op['riskLevel'], 3) >=
              (proof.resolvedDeclaration['defaultRiskLevel'] as int) &&
          op['approvalRequired'] is bool &&
          (proof.resolvedDeclaration['approvalRequired'] != true ||
              op['approvalRequired'] == true),
    );
    connectorHash(op['definitionSha256']);
  }
  connectorRequire(
    utf8.encode(jsonEncode(s)).length <= 262144 &&
        await connectorSha(s) == proof.raw['summarySha256'],
  );
  return connectorFreeze(s);
}

/// The complete summary and its service envelope are transient. [stored] holds
/// the original intent and compact domain evidence only; restoring it cannot
/// make a preparation confirmable without another authenticated exact GET.
class ConnectorOpenApiImportPreparationRead {
  const ConnectorOpenApiImportPreparationRead._(
    this.prepared,
    this.proof,
    this.summary,
  );
  final ConnectorJson? prepared, summary;
  final ConnectorOpenApiImportPreparationProof? proof;
  ConnectorJson? get stored => prepared;
  String? get availability => prepared?['availability'] as String?;
  String? get consumedKeySha256 => prepared?['consumedKeySha256'] as String?;
  ConnectorOpenApiImportPreparationRead evidenceOnly() =>
      ConnectorOpenApiImportPreparationRead._(prepared, proof, null);

  static Future<ConnectorOpenApiImportPreparationRead> _domain(
    Object? value,
    ConnectorOpenApiImportPreparationIntent intent, {
    required bool live,
  }) async {
    if (value == null) {
      return const ConnectorOpenApiImportPreparationRead._(null, null, null);
    }
    final branch = connectorMap(value), state = branch['availability'];
    final fields = switch (state) {
      'preparing' => 'availability intent attempt',
      'ready' =>
        'availability intent attempt preparation${live ? ' summary' : ''}',
      'expired' => 'availability intent attempt preparation',
      'failed' => 'availability intent attempt failure',
      'consumed' =>
        'availability intent attempt preparation consumedBy consumedKeySha256',
      'abandoned' => 'availability intent attempt preparation abandonment',
      _ => throw const FormatException(
        'Unsupported import preparation evidence.',
      ),
    };
    final p = connectorObject(branch, fields);
    connectorRequire(connectorSame(p['intent'], intent.identity));
    final attempt = p['attempt'] == null
        ? null
        : await _attempt(p['attempt'], intent);
    connectorRequire(attempt != null || state == 'abandoned');
    final proof = p['preparation'] == null
        ? null
        : await ConnectorOpenApiImportPreparationProof.parse(
            p['preparation'],
            intent,
            attempt,
          );
    connectorRequire(
      !const ['ready', 'consumed'].contains(state) || proof != null,
    );
    if (state == 'consumed') {
      final key = connectorHash(p['consumedKeySha256']);
      connectorRequire(
        p['consumedBy'] ==
            'connector-acceptance:${await connectorSha({'scope': intent.owner.scope, 'keySha256': key})}',
      );
    }
    if (state == 'failed') {
      final f = connectorObject(p['failure'], 'code failedAt');
      final at = connectorInstant(f['failedAt']);
      connectorRequire(
        const [
              'source_unavailable',
              'invalid_spec',
              'unsupported_spec',
              'scope_too_large',
              'admission_failed',
            ].contains(f['code']) &&
            at.endsWith('Z') &&
            !DateTime.parse(at)
                .isBefore(DateTime.parse(attempt!['startedAt'] as String)) &&
            !DateTime.parse(at)
                .isAfter(DateTime.parse(attempt['expiresAt'] as String)),
      );
    }
    if (state == 'abandoned') {
      final a = connectorObject(
        p['abandonment'],
        'contract id scope keySha256 intentSha256 attemptSha256 preparationSha256 abandonedAt abandonmentSha256',
      );
      final at = connectorInstant(a['abandonedAt']);
      connectorRequire(
        a['contract'] == 'asael-openapi-import-preparation-abandonment:1' &&
            a['id'] ==
                'connector-preparation-abandonment:${await connectorSha({'operation': 'import_openapi', 'scope': intent.owner.scope, 'keySha256': intent.keySha256})}' &&
            connectorSame(a['scope'], intent.owner.scope) &&
            a['keySha256'] == intent.keySha256 &&
            a['intentSha256'] == intent.intentSha256 &&
            a['attemptSha256'] == attempt?['attemptSha256'] &&
            a['preparationSha256'] == proof?.sha256 &&
            at.endsWith('Z') &&
            (attempt == null ||
                !DateTime.parse(
                  at,
                ).isBefore(DateTime.parse(attempt['startedAt'] as String))) &&
            (proof == null ||
                !DateTime.parse(at).isBefore(
                  DateTime.parse(proof.raw['preparedAt'] as String),
                )) &&
            a['abandonmentSha256'] ==
                await connectorSha({...a}..remove('abandonmentSha256')),
      );
    }
    final summary = state == 'ready' && live
        ? await _summary(p['summary'], proof!)
        : null;
    return ConnectorOpenApiImportPreparationRead._(
      connectorFreeze({...p}..remove('summary')),
      proof,
      summary,
    );
  }

  static Future<ConnectorOpenApiImportPreparationRead> restore(
    Object? value,
    ConnectorOpenApiImportPreparationIntent intent,
  ) => _domain(value, intent, live: false);

  static Future<ConnectorOpenApiImportPreparationRead> parse(
    Object? value,
    ConnectorOwner owner, {
    required ConnectorOpenApiImportPreparationIntent intent,
    String kind = 'read',
  }) async {
    connectorRequire(
      const ['read', 'submit', 'abandon'].contains(kind) &&
          owner.storageKey == intent.owner.storageKey &&
          connectorSame(owner.scope, intent.owner.scope) &&
          (kind != 'submit' || owner.key == intent.owner.key),
    );
    final mutation = kind != 'read';
    final row = connectorObject(
      value,
      'contract scope prepared serviceReceipt${mutation ? ' replayed' : ''}',
    );
    connectorRequire(
      !mutation || row['prepared'] != null && row['replayed'] is bool,
    );
    final result = await _domain(row['prepared'], intent, live: true);
    connectorRequire(kind != 'abandon' || result.availability == 'abandoned');
    await connectorServiceReceipt(
      row,
      owner,
      contract: connectorControlContract,
      operation: 'app.connectors.native.openapiImportPreparations.$kind',
      resource: 'connector_native_preparation',
      count: result.prepared == null ? 0 : 1,
      key: mutation ? intent.key : null,
      target: intent.id,
      purpose: kind == 'abandon'
          ? 'api.connectors.native.openapi_import_preparation.abandon'
          : 'api.connectors.native.action',
      action: kind == 'abandon' ? 'read' : 'manage.connector',
      event: 'connector-native-openapi-import-preparation-events.v1',
    );
    return result;
  }
}

/// A null raw key is a linked, GET-only identity recovered from consumption on
/// another device. It can never authorize a POST or acquire an invented key.
class ConnectorOpenApiImportIntent {
  const ConnectorOpenApiImportIntent._(
    this.preparation,
    this.proof,
    this.key,
    this.identity,
    this.requestSha256,
  );
  final ConnectorOpenApiImportPreparationIntent preparation;
  final ConnectorOpenApiImportPreparationProof proof;
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
    'attempt': proof.attempt,
    'key': key,
    'identity': identity,
    'requestSha256': requestSha256,
  };
  static Future<ConnectorOpenApiImportIntent> create(
    ConnectorOpenApiImportPreparationIntent preparation,
    ConnectorOpenApiImportPreparationProof proof, {
    String? key,
    String? consumedKeySha256,
  }) async {
    connectorRequire(key == null || consumedKeySha256 == null);
    final verified = await ConnectorOpenApiImportPreparationProof.parse(
      proof.raw,
      preparation,
      proof.attempt,
    );
    final rawKey = consumedKeySha256 == null
        ? key ?? 'native-openapi-import-${_randomHex(24)}'
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
        'kind': 'openapi',
        'connectorId': preparation.id,
        'action': 'import_openapi',
        'preparationId': verified.raw['id'],
        'preparationSha256': verified.sha256,
        'review': null,
      },
    });
    return ConnectorOpenApiImportIntent._(
      preparation,
      verified,
      rawKey,
      identity,
      await connectorSha(identity),
    );
  }

  static Future<ConnectorOpenApiImportIntent> restore(
    Object? value,
    ConnectorOwner owner,
  ) async {
    final row = connectorObject(
      value,
      'preparation proof attempt key identity requestSha256',
    );
    final preparation = await ConnectorOpenApiImportPreparationIntent.restore(
      row['preparation'],
      owner,
    );
    final proof = await ConnectorOpenApiImportPreparationProof.parse(
      row['proof'],
      preparation,
      row['attempt'],
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

class ConnectorOpenApiImportRead {
  const ConnectorOpenApiImportRead._(this.raw, this.action);
  final ConnectorJson raw;
  final ConnectorJson? action;
  bool get settled => action?['state'] == 'settled';
  ConnectorJson? get acceptance =>
      action == null ? null : connectorMap(action!['acceptance']);
  static Future<ConnectorOpenApiImportRead> parse(
    Object? value,
    ConnectorOwner owner, {
    required ConnectorOpenApiImportIntent intent,
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
            a['kind'] == 'openapi' &&
            a['connectorId'] == intent.id &&
            a['action'] == 'import_openapi' &&
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
              r['kind'] == 'openapi' &&
              r['connectorId'] == intent.id &&
              r['operation'] == 'import_openapi' &&
              r['status'] == 'complete' &&
              r['connectorStatus'] == 'disabled' &&
              r['contractCount'] == intent.proof.contractCount &&
              r['credentialVersion'] == 0 &&
              r['configurationSha256'] ==
                  intent.proof.raw['configurationSha256'] &&
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
      operation: 'app.connectors.native.openapiImports.$kind',
      resource: 'connector_native_action',
      count: action == null ? 0 : 1,
      key: mutation ? intent.key : null,
      target: intent.id,
      purpose: 'api.connectors.native.action',
      event: 'connector-native-openapi-import-events.v1',
    );
    return ConnectorOpenApiImportRead._(
      connectorFreeze(row),
      action == null ? null : connectorFreeze(action),
    );
  }
}
