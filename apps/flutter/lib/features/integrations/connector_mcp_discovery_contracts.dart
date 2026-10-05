import 'dart:math';

import 'connector_contracts.dart';
import 'connector_control_contracts.dart';

bool mcpDiscoveryEligible(ConnectorReview review) {
  final row = review.connector;
  return row != null &&
      review.pin != null &&
      review.value!['unavailableReason'] == null &&
      row['kind'] == 'mcp' &&
      row['status'] == 'disabled' &&
      const ['none', 'bearer_env', 'bearer_vault'].contains(row['authType']) &&
      (row['authType'] != 'bearer_vault' ||
          row['credentialConfigured'] == true &&
              row['credentialOriginMatch'] == true);
}

Future<ConnectorJson> _pin(Object? value, String id) async {
  final row = connectorObject(
    value,
    'kind connectorId connectorSha256 contractsSha256 configurationSha256 reviewFingerprint credentialVersion reviewSha256',
  );
  connectorRequire(row['kind'] == 'mcp' && row['connectorId'] == id);
  connectorCount(row['credentialVersion'], 2147483647);
  for (final field in [
    'connectorSha256',
    'contractsSha256',
    'configurationSha256',
    'reviewSha256',
  ]) {
    connectorHash(row[field]);
  }
  connectorRequire(
    row['reviewFingerprint'] == null ||
        row['reviewFingerprint'] is String &&
            RegExp(r'^[A-Za-z0-9_-]{43}$')
                .hasMatch(row['reviewFingerprint'] as String),
  );
  connectorRequire(
    row['reviewSha256'] == await connectorSha({...row}..remove('reviewSha256')),
  );
  return connectorFreeze(row);
}

DateTime _instant(Object? value) {
  final text = connectorInstant(value);
  connectorRequire(text.endsWith('Z'));
  // Match the server's Date.parse millisecond comparisons while preserving
  // the original instant string in every canonical digest.
  return DateTime.fromMillisecondsSinceEpoch(
    DateTime.parse(text).millisecondsSinceEpoch,
    isUtc: true,
  );
}

class ConnectorMcpDiscoveryIntent {
  const ConnectorMcpDiscoveryIntent._(
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
  String get id => request['connectorId'] as String;
  String get keySha256 => identity['keySha256'] as String;
  ConnectorJson get closeRequest => {
    'contract': 'asael-mcp-discovery-close:1',
    'intent': identity,
  };
  ConnectorJson get stored => {
    'owner': owner.json,
    'key': key,
    'identity': identity,
    'requestSha256': requestSha256,
  };

  static Future<ConnectorMcpDiscoveryIntent> prepare(
    ConnectorOwner owner,
    ConnectorReview review, {
    String? key,
  }) {
    connectorRequire(
      mcpDiscoveryEligible(review) &&
          connectorSame(review.raw['scope'], owner.scope),
    );
    return _create(
      owner,
      key ??
          'native-mcp-discovery-${List.generate(24, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}',
      {
        'contract': 'asael-connector-lifecycle-action:1',
        'kind': 'mcp',
        'connectorId': review.connector!['id'],
        'action': 'discover',
        'review': review.pin,
        'preview': null,
      },
    );
  }

  static Future<ConnectorMcpDiscoveryIntent> _create(
    ConnectorOwner owner,
    String key,
    Object? value,
  ) async {
    connectorRequire(
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    final request = connectorObject(
      value,
      'contract kind connectorId action review preview',
    );
    final id = controlId(request['connectorId']);
    connectorRequire(
      request['contract'] == 'asael-connector-lifecycle-action:1' &&
          request['kind'] == 'mcp' &&
          request['action'] == 'discover' &&
          request['preview'] == null,
    );
    await _pin(request['review'], id);
    final identity = connectorFreeze({
      'contract': 'asael-connector-action-intent:1',
      'scope': owner.scope,
      'keySha256': await connectorRawSha('${owner.tenantId}\u0000$key'),
      'request': request,
    });
    return ConnectorMcpDiscoveryIntent._(
      owner,
      key,
      identity,
      await connectorSha(identity),
    );
  }

  static Future<ConnectorMcpDiscoveryIntent> restore(
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
    final result = await _create(
      owner,
      connectorText(row['key'], 512),
      identity['request'],
    );
    connectorRequire(
      connectorSame(identity, result.identity) &&
          row['requestSha256'] == result.requestSha256,
    );
    return result;
  }
}

class ConnectorMcpDiscoveryRead {
  const ConnectorMcpDiscoveryRead._(this.raw, this.discovery);
  final ConnectorJson raw;
  final ConnectorJson? discovery;
  String? get state => discovery?['state'] as String?;
  ConnectorJson? get attempt => discovery?['attempt'] == null
      ? null
      : connectorMap(discovery!['attempt']);
  ConnectorJson? get settlement => discovery?['settlement'] == null
      ? null
      : connectorMap(discovery!['settlement']);
  ConnectorJson? get result =>
      settlement == null ? null : connectorMap(settlement!['result']);
  bool get terminal => state == 'settled' || state == 'closed';

  static Future<ConnectorMcpDiscoveryRead> parse(
    Object? value,
    ConnectorOwner owner, {
    required ConnectorMcpDiscoveryIntent intent,
    String kind = 'read',
  }) async {
    connectorRequire(const ['read', 'submit', 'close'].contains(kind));
    final mutation = kind != 'read';
    connectorRequire(
      owner.storageKey == intent.owner.storageKey &&
          connectorSame(owner.scope, intent.owner.scope) &&
          (kind != 'submit' || owner.key == intent.owner.key),
    );
    final row = connectorObject(
      value,
      'contract scope discovery serviceReceipt${mutation ? ' replayed' : ''}',
    );
    if (mutation) {
      connectorRequire(row['discovery'] != null && row['replayed'] is bool);
    }
    ConnectorJson? discovery;
    if (row['discovery'] != null) {
      final state = connectorMap(row['discovery'])['state'];
      connectorRequire(
        const ['pending', 'expired', 'settled', 'closed'].contains(state),
      );
      discovery = connectorObject(
        row['discovery'],
        'state intent attempt${state == 'settled'
            ? ' settlement'
            : state == 'closed'
            ? ' closure'
            : ''}',
      );
      connectorRequire(
        connectorSame(discovery['intent'], intent.identity) &&
            (kind != 'close' || const ['settled', 'closed'].contains(state)),
      );
      ConnectorJson? attempt;
      DateTime? started, expires;
      if (discovery['attempt'] != null) {
        attempt = connectorObject(
          discovery['attempt'],
          'contract id scope keySha256 intentSha256 kind connectorId reviewSha256 startedAt expiresAt attemptSha256',
        );
        started = _instant(attempt['startedAt']);
        expires = _instant(attempt['expiresAt']);
        connectorRequire(
          attempt['contract'] == 'asael-mcp-discovery-attempt:1' &&
              connectorSame(attempt['scope'], intent.owner.scope) &&
              attempt['keySha256'] == intent.keySha256 &&
              attempt['intentSha256'] == intent.requestSha256 &&
              attempt['kind'] == 'mcp' &&
              attempt['connectorId'] == intent.id &&
              attempt['reviewSha256'] == intent.review['reviewSha256'] &&
              expires.difference(started).inMicroseconds == 45000000 &&
              attempt['id'] ==
                  'mcp-discovery-attempt:${await connectorSha({'family': 'mcp-discovery-attempt:1', 'scope': intent.owner.scope, 'keySha256': intent.keySha256})}' &&
              attempt['attemptSha256'] ==
                  await connectorSha({...attempt}..remove('attemptSha256')),
        );
      } else {
        connectorRequire(state == 'closed');
      }
      if (state == 'settled') {
        final s = connectorObject(
          discovery['settlement'],
          'contract attemptId attemptSha256 settledAt result settlementSha256',
        );
        final at = _instant(s['settledAt']);
        connectorRequire(
          s['contract'] == 'asael-mcp-discovery-settlement:1' &&
              s['attemptId'] == attempt!['id'] &&
              s['attemptSha256'] == attempt['attemptSha256'] &&
              !at.isBefore(started!) &&
              s['settlementSha256'] ==
                  await connectorSha({...s}..remove('settlementSha256')),
        );
        final status = connectorMap(s['result'])['status'];
        connectorRequire(status == 'complete' || status == 'failed');
        final result = connectorObject(
          s['result'],
          status == 'complete'
              ? 'status kind connectorId connectorStatus contractCount pendingCount credentialVersion review'
              : 'status kind connectorId failureCode',
        );
        connectorRequire(
          result['kind'] == 'mcp' && result['connectorId'] == intent.id,
        );
        if (status == 'complete') {
          final count = connectorCount(result['contractCount'], 200);
          connectorCount(result['pendingCount'], count);
          connectorCount(result['credentialVersion'], 2147483647);
          final pin = await _pin(result['review'], intent.id);
          connectorRequire(
            at.isBefore(expires!) &&
                result['connectorStatus'] == 'disabled' &&
                result['credentialVersion'] ==
                    intent.review['credentialVersion'] &&
                pin['credentialVersion'] ==
                    intent.review['credentialVersion'] &&
                (count == 0) ==
                    (pin['contractsSha256'] == await connectorSha(<Object?>[])),
          );
        } else {
          connectorRequire(
            const [
              'discovery_failed',
              'catalog_unreviewable',
              'target_changed',
              'deadline_exceeded',
            ].contains(result['failureCode']),
          );
          connectorRequire(
            result['failureCode'] != 'deadline_exceeded' ||
                !at.isBefore(expires!),
          );
        }
      }
      if (state == 'closed') {
        final closure = connectorObject(
          discovery['closure'],
          'contract scope keySha256 intentSha256 attemptId attemptSha256 closedAt closureSha256',
        );
        final at = _instant(closure['closedAt']);
        connectorRequire(
          closure['contract'] == 'asael-mcp-discovery-closure:1' &&
              connectorSame(closure['scope'], intent.owner.scope) &&
              closure['keySha256'] == intent.keySha256 &&
              closure['intentSha256'] == intent.requestSha256 &&
              closure['attemptId'] == attempt?['id'] &&
              closure['attemptSha256'] == attempt?['attemptSha256'] &&
              (started == null || !at.isBefore(started)) &&
              closure['closureSha256'] ==
                  await connectorSha({...closure}..remove('closureSha256')),
        );
      }
    }
    await connectorServiceReceipt(
      row,
      owner,
      contract: connectorControlContract,
      operation: 'app.connectors.native.mcpDiscoveries.$kind',
      resource: 'connector_native_discovery',
      count: discovery == null ? 0 : 1,
      key: mutation ? intent.key : null,
      target: intent.id,
      purpose: kind == 'close'
          ? 'api.connectors.native.mcp_discovery_close'
          : 'api.connectors.native.mcp_discovery',
      action: kind == 'close' ? 'read' : 'manage.connector',
      event: 'connector-native-mcp-discovery-events.v1',
    );
    return ConnectorMcpDiscoveryRead._(
      connectorFreeze(row),
      discovery == null ? null : connectorFreeze(discovery),
    );
  }
}
