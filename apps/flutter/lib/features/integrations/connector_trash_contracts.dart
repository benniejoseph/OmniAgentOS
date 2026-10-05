import 'dart:math';

import 'connector_contracts.dart';
import 'connector_control_contracts.dart';

const connectorTrashReconnectLimitation =
    'Connector configuration and contracts can be restored, but its vault credential must be reconnected by a human.';

bool connectorTrashEligible(ConnectorReview review) =>
    review.connector != null && review.pin != null &&
    review.value!['unavailableReason'] == null && review.connector!['kind'] == 'mcp';

ConnectorJson connectorTrashCompensation(ConnectorReview review) {
  final reconnect = review.connector!['credentialConfigured'] == true ||
      review.connector!['authType'] == 'bearer_vault';
  return {'kind': reconnect ? 'equivalent_action' : 'exact_restore',
    'handlerId': reconnect ? 'trash.compensate.mcp_connector' : 'trash.restore.mcp_connector',
    'limitation': reconnect ? connectorTrashReconnectLimitation : null};
}

Future<ConnectorJson> _preview(Object? value, ConnectorJson pin) async {
  final p = connectorObject(value,
    'version action trashId resourceType resourceId lifecycleRevision targetSha256 effectSummary reversible issuedAt expiresAt previewSha256');
  final issued = connectorInstant(p['issuedAt']), expires = connectorInstant(p['expiresAt']);
  connectorText(p['effectSummary'], 500);
  connectorHash(p['targetSha256']); connectorHash(p['previewSha256']);
  connectorRequire(p['version'] == 'p9.3-trash-preview:1' && p['action'] == 'trash' &&
    p['trashId'] == null && p['resourceType'] == 'mcp_connector' &&
    p['resourceId'] == pin['connectorId'] && p['lifecycleRevision'] == 0 && p['reversible'] == true &&
    DateTime.parse(expires).difference(DateTime.parse(issued)).inMilliseconds == 600000 &&
    p['targetSha256'] == await connectorSha({'kind': 'mcp', 'connectorId': pin['connectorId'], 'reviewSha256': pin['reviewSha256']}) &&
    p['previewSha256'] == await connectorSha({...p}..remove('previewSha256')));
  return connectorFreeze(p);
}

/// A GET preview has management authorization but no execution scope or effect.
Future<void> _previewReceipt(ConnectorJson row, ConnectorOwner owner) async {
  connectorRequire(row['contract'] == connectorControlContract && connectorSame(row['scope'], owner.scope));
  final r = connectorObject(row['serviceReceipt'],
    'schemaVersion receiptKind boundaryVersion operation action resourceType accessMode eventContract authoritySha256 idempotencyKeySha256 outcomeSha256 resourceCount occurredAt receiptSha256');
  connectorInstant(r['occurredAt']);
  connectorRequire(r['schemaVersion'] == 1 && r['receiptKind'] == 'app_service_receipt' &&
    r['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
    r['operation'] == 'app.connectors.native.trash.preview' && r['action'] == 'manage.connector' &&
    r['resourceType'] == 'connector_native_action' && r['accessMode'] == 'read' &&
    r['eventContract'] == 'read_only:no_domain_mutation' && r['idempotencyKeySha256'] == null &&
    r['resourceCount'] == (row['review'] == null ? 0 : 1) &&
    r['authoritySha256'] == await connectorSha({'boundaryVersion': 'p9.1-app-service-boundary:1',
      'tenantId': owner.tenantId, 'actorId': owner.actorId, 'role': owner.role, 'executionScope': null}) &&
    r['outcomeSha256'] == await connectorSha({...row}..remove('serviceReceipt')) &&
    r['receiptSha256'] == await connectorSha({...r}..remove('receiptSha256')));
}

class ConnectorTrashPreview {
  const ConnectorTrashPreview._(this.raw, this.review, this.preview, this.compensation);
  final ConnectorJson raw;
  final ConnectorReview review;
  final ConnectorJson? preview, compensation;
  String? get id => review.connector?['id'] as String?;
  bool freshAt(DateTime now) => preview != null &&
      !now.isBefore(DateTime.parse(preview!['issuedAt'] as String)) &&
      now.isBefore(DateTime.parse(preview!['expiresAt'] as String));

  static Future<ConnectorTrashPreview> parse(Object? value, ConnectorOwner owner, String id) async {
    final row = connectorObject(value, 'contract scope review preview compensation serviceReceipt');
    await _previewReceipt(row, owner);
    final review = ConnectorReview(connectorFreeze(row), await ConnectorReview.parseValue(row['review'], 'mcp', id));
    ConnectorJson? preview, compensation;
    if (row['preview'] != null) {
      connectorRequire(connectorTrashEligible(review));
      preview = await _preview(row['preview'], review.pin!);
      compensation = connectorObject(row['compensation'], 'kind handlerId limitation');
      connectorRequire(connectorSame(compensation, connectorTrashCompensation(review)) &&
        preview['effectSummary'] == 'Move MCP connector ${review.connector!['name']} and ${(review.value!['contracts'] as List).length} contract(s) to Trash.');
    } else {
      connectorRequire(!connectorTrashEligible(review) && row['compensation'] == null);
    }
    return ConnectorTrashPreview._(connectorFreeze(row), review, preview,
      compensation == null ? null : connectorFreeze(compensation));
  }
}

Future<ConnectorJson> _trashRequest(Object? value) async {
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
        request['action'] == 'trash' &&
        pin['kind'] == 'mcp' &&
        pin['connectorId'] == id,
  );
  connectorCount(pin['credentialVersion'], 2147483647);
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
  await _preview(request['preview'], pin);
  return connectorFreeze(request);
}

class ConnectorTrashIntent {
  const ConnectorTrashIntent._(
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

  static Future<ConnectorTrashIntent> prepare(
    ConnectorOwner owner,
    ConnectorTrashPreview reviewed, {
    String? key,
    DateTime? now,
  }) async {
    final review = reviewed.review;
    connectorRequire(connectorTrashEligible(review) && reviewed.freshAt(now ?? DateTime.now()) &&
      connectorSame(reviewed.raw['scope'], owner.scope));
    return _create(
      owner,
      key ??
          'native-connector-trash-${List.generate(24, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}',
      {
        'contract': 'asael-connector-lifecycle-action:1',
        'kind': 'mcp',
        'connectorId': review.connector!['id'],
        'action': 'trash',
        'review': review.pin,
        'preview': reviewed.preview,
      },
    );
  }

  static Future<ConnectorTrashIntent> _create(
    ConnectorOwner owner,
    String key,
    Object? value,
  ) async {
    connectorRequire(
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    final request = await _trashRequest(value);
    final identity = connectorFreeze({
      'contract': 'asael-connector-action-intent:1',
      'scope': owner.scope,
      'keySha256': await connectorRawSha('${owner.tenantId}\u0000$key'),
      'request': request,
    });
    return ConnectorTrashIntent._(
      owner,
      key,
      identity,
      await connectorSha(identity),
    );
  }

  static Future<ConnectorTrashIntent> restore(
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

class ConnectorTrashRead {
  const ConnectorTrashRead._(this.raw, this.action);
  final ConnectorJson raw;
  final ConnectorJson? action;
  ConnectorJson? get acceptance =>
      action == null ? null : connectorMap(action!['acceptance']);
  bool get settled => action?['state'] == 'settled';

  static Future<ConnectorTrashRead> parse(
    Object? value,
    ConnectorOwner owner, {
    String kind = 'read',
    String? keySha256,
    required ConnectorTrashIntent intent,
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
            a['action'] == 'trash' &&
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
        final trash = connectorObject(result['trash'], 'trashId proofSha256 restoreUntil compensation limitation');
        connectorRequire(trash['trashId'] is String && RegExp(r'^trash:[0-9a-f-]{36}$').hasMatch(trash['trashId'] as String));
        connectorHash(trash['proofSha256']);
        final restoreUntil = connectorInstant(trash['restoreUntil']);
        connectorRequire(s['contract'] == 'asael-connector-settlement:2' && s['acceptanceId'] == a['id'] &&
          settledAt.endsWith('Z') && !DateTime.parse(settledAt).isBefore(DateTime.parse(acceptedAt)) &&
          restoreUntil.endsWith('Z') && DateTime.parse(restoreUntil).isAfter(DateTime.parse(settledAt)) &&
          result['kind'] == 'mcp' && result['connectorId'] == intent.id && result['operation'] == 'trash' &&
          result['status'] == 'complete' && result['failureCode'] == null &&
          ['connectorStatus', 'contractCount', 'credentialVersion', 'connectorSha256', 'contractsSha256', 'configurationSha256']
            .every((field) => result[field] == null) &&
          (trash['compensation'] == 'exact_restore' && trash['limitation'] == null ||
            trash['compensation'] == 'equivalent_action' && trash['limitation'] == connectorTrashReconnectLimitation) &&
          s['settlementSha256'] == await connectorSha({...s}..remove('settlementSha256')));
      }
    }
    await connectorServiceReceipt(
      row,
      owner,
      contract: connectorControlContract,
      operation: 'app.connectors.native.trash.$kind',
      resource: 'connector_native_action',
      count: action == null ? 0 : 1,
      key: mutation ? intent.key : null,
      target: intent.id,
      purpose: 'api.connectors.native.action',
      event: 'connector-native-trash-events.v1',
    );
    return ConnectorTrashRead._(
      connectorFreeze(row),
      action == null ? null : connectorFreeze(action),
    );
  }
}
