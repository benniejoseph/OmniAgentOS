import 'dart:math';

import 'connector_contracts.dart';
import 'connector_control_contracts.dart';

const githubExpandedMcpEndpoint = 'https://api.githubcopilot.com/mcp/x/all';

bool legacyOfficialGithubMcpEndpoint(Object? value) {
  // Keep the visible action identical to the server and SQL publisher's
  // accepted stored endpoint forms. URI normalization would admit strings
  // that cannot pass the publication trigger.
  return value == 'https://api.githubcopilot.com/mcp' ||
      value == 'https://api.githubcopilot.com/mcp/';
}

bool githubUpgradeEligible(ConnectorReview review) {
  final row = review.connector;
  if (row == null ||
      review.pin == null ||
      review.value!['unavailableReason'] != null ||
      row['kind'] != 'mcp' ||
      row['endpointRedacted'] != false ||
      !const ['none', 'bearer_env', 'bearer_vault'].contains(row['authType']) ||
      row['authType'] == 'bearer_vault' &&
          (row['credentialConfigured'] != true ||
              row['credentialOriginMatch'] != true)) {
    return false;
  }
  return legacyOfficialGithubMcpEndpoint(row['endpoint']);
}

DateTime _githubInstant(Object? value) {
  final text = connectorInstant(value);
  connectorRequire(text.endsWith('Z'));
  // Server deadline comparisons use millisecond precision.
  return DateTime.fromMillisecondsSinceEpoch(
    DateTime.parse(text).millisecondsSinceEpoch,
    isUtc: true,
  );
}

Future<ConnectorJson> _githubPin(Object? value, String id) async {
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

/// Dedicated v47 read of raw stored endpoint eligibility. The ordinary native
/// review intentionally redacts/normalizes its URL and cannot prove this.
class ConnectorGithubUpgradeReview {
  const ConnectorGithubUpgradeReview._(this.raw, this.value);

  final ConnectorJson raw;
  final ConnectorJson? value;
  bool get eligible => value?['eligible'] == true;
  ConnectorJson? get pin =>
      value?['review'] == null ? null : connectorMap(value!['review']);

  bool matches(ConnectorReview review) =>
      eligible &&
      review.pin != null &&
      connectorSame(raw['scope'], review.raw['scope']) &&
      connectorSame(pin, review.pin) &&
      review.connector?['id'] == value?['connectorId'];

  static Future<ConnectorGithubUpgradeReview> parse(
    Object? input,
    ConnectorOwner owner,
    String id,
  ) async {
    controlId(id);
    final row = connectorObject(
      input,
      'contract scope upgradeReview serviceReceipt',
    );
    connectorRequire(
      row['contract'] == connectorControlContract &&
          connectorSame(row['scope'], owner.scope),
    );
    ConnectorJson? value;
    if (row['upgradeReview'] != null) {
      value = connectorObject(
        row['upgradeReview'],
        'connectorId eligible reason review',
      );
      connectorRequire(
        value['connectorId'] == id &&
            value['eligible'] is bool &&
            const ['eligible', 'unavailable'].contains(value['reason']) &&
            (value['eligible'] == true) == (value['reason'] == 'eligible') &&
            (value['eligible'] != true || value['review'] != null),
      );
      if (value['review'] != null) {
        await _githubPin(value['review'], id);
      }
    }
    final receipt = connectorObject(
      row['serviceReceipt'],
      'schemaVersion receiptKind boundaryVersion operation action resourceType accessMode eventContract authoritySha256 idempotencyKeySha256 outcomeSha256 resourceCount occurredAt receiptSha256',
    );
    connectorInstant(receipt['occurredAt']);
    connectorRequire(
      receipt['schemaVersion'] == 1 &&
          receipt['receiptKind'] == 'app_service_receipt' &&
          receipt['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
          receipt['operation'] ==
              'app.connectors.native.githubUpgrades.review' &&
          receipt['action'] == 'manage.connector' &&
          receipt['resourceType'] == 'connector_native_upgrade' &&
          receipt['accessMode'] == 'read' &&
          receipt['eventContract'] == 'read_only:no_domain_mutation' &&
          receipt['idempotencyKeySha256'] == null &&
          receipt['resourceCount'] == (value == null ? 0 : 1) &&
          receipt['authoritySha256'] ==
              await connectorSha({
                'boundaryVersion': 'p9.1-app-service-boundary:1',
                'tenantId': owner.tenantId,
                'actorId': owner.actorId,
                'role': owner.role,
                'executionScope': null,
              }) &&
          receipt['outcomeSha256'] ==
              await connectorSha({...row}..remove('serviceReceipt')) &&
          receipt['receiptSha256'] ==
              await connectorSha({...receipt}..remove('receiptSha256')),
    );
    return ConnectorGithubUpgradeReview._(
      connectorFreeze(row),
      value == null ? null : connectorFreeze(value),
    );
  }
}

class ConnectorGithubUpgradeIntent {
  const ConnectorGithubUpgradeIntent._(
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
    'contract': 'asael-github-upgrade-close:1',
    'intent': identity,
  };
  ConnectorJson get stored => {
    'owner': owner.json,
    'key': key,
    'identity': identity,
    'requestSha256': requestSha256,
  };

  static Future<ConnectorGithubUpgradeIntent> prepare(
    ConnectorOwner owner,
    ConnectorReview review, {
    required ConnectorGithubUpgradeReview eligibility,
    String? key,
  }) {
    connectorRequire(
      githubUpgradeEligible(review) &&
          eligibility.matches(review) &&
          connectorSame(review.raw['scope'], owner.scope),
    );
    return _create(
      owner,
      key ??
          'native-github-upgrade-${List.generate(24, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}',
      {
        'contract': 'asael-connector-lifecycle-action:1',
        'kind': 'mcp',
        'connectorId': review.connector!['id'],
        'action': 'upgrade_github',
        'review': review.pin,
        'preview': null,
      },
    );
  }

  static Future<ConnectorGithubUpgradeIntent> _create(
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
          request['action'] == 'upgrade_github' &&
          request['preview'] == null,
    );
    await _githubPin(request['review'], id);
    final identity = connectorFreeze({
      'contract': 'asael-connector-action-intent:1',
      'scope': owner.scope,
      'keySha256': await connectorRawSha('${owner.tenantId}\u0000$key'),
      'request': request,
    });
    return ConnectorGithubUpgradeIntent._(
      owner,
      key,
      identity,
      await connectorSha(identity),
    );
  }

  static Future<ConnectorGithubUpgradeIntent> restore(
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

class ConnectorGithubUpgradeRead {
  const ConnectorGithubUpgradeRead._(this.raw, this.upgrade);

  final ConnectorJson raw;
  final ConnectorJson? upgrade;
  String? get state => upgrade?['state'] as String?;
  ConnectorJson? get attempt =>
      upgrade?['attempt'] == null ? null : connectorMap(upgrade!['attempt']);
  ConnectorJson? get settlement => upgrade?['settlement'] == null
      ? null
      : connectorMap(upgrade!['settlement']);
  ConnectorJson? get result =>
      settlement == null ? null : connectorMap(settlement!['result']);

  /// Even an expired read needs explicit closure of the original key. A
  /// never-admitted delayed request has no server deadline yet.
  bool get terminal => state == 'closed' || state == 'settled';

  static Future<ConnectorGithubUpgradeRead> parse(
    Object? value,
    ConnectorOwner owner, {
    required ConnectorGithubUpgradeIntent intent,
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
      'contract scope upgrade serviceReceipt${mutation ? ' replayed' : ''}',
    );
    if (mutation) {
      connectorRequire(row['upgrade'] != null && row['replayed'] is bool);
    }

    ConnectorJson? upgrade;
    if (row['upgrade'] != null) {
      final candidate = connectorMap(row['upgrade']);
      final state = candidate['state'];
      connectorRequire(
        const ['pending', 'expired', 'settled', 'closed'].contains(state),
      );
      if (kind == 'close') {
        connectorRequire(const ['settled', 'closed'].contains(state));
      }
      upgrade = connectorObject(
        candidate,
        state == 'settled'
            ? 'state intent attempt settlement'
            : state == 'closed'
            ? 'state intent attempt closure'
            : 'state intent attempt',
      );
      connectorRequire(connectorSame(upgrade['intent'], intent.identity));

      ConnectorJson? attempt;
      DateTime? started, expires;
      if (upgrade['attempt'] != null) {
        attempt = connectorObject(
          upgrade['attempt'],
          'contract id scope keySha256 intentSha256 connectorId reviewSha256 targetEndpoint startedAt expiresAt attemptSha256',
        );
        started = _githubInstant(attempt['startedAt']);
        expires = _githubInstant(attempt['expiresAt']);
        connectorRequire(
          attempt['contract'] == 'asael-github-upgrade-attempt:1' &&
              connectorSame(attempt['scope'], intent.owner.scope) &&
              attempt['keySha256'] == intent.keySha256 &&
              attempt['intentSha256'] == intent.requestSha256 &&
              attempt['connectorId'] == intent.id &&
              attempt['reviewSha256'] == intent.review['reviewSha256'] &&
              attempt['targetEndpoint'] == githubExpandedMcpEndpoint &&
              expires.difference(started).inMilliseconds == 45000 &&
              attempt['id'] ==
                  'github-upgrade-attempt:${await connectorSha({'family': 'github-upgrade-attempt:1', 'scope': intent.owner.scope, 'keySha256': intent.keySha256})}' &&
              attempt['attemptSha256'] ==
                  await connectorSha({...attempt}..remove('attemptSha256')),
        );
      } else {
        connectorRequire(state == 'closed');
      }
      if (state == 'settled') {
        final settlement = connectorObject(
          upgrade['settlement'],
          'contract attemptId attemptSha256 settledAt result settlementSha256',
        );
        final settledAt = _githubInstant(settlement['settledAt']);
        connectorRequire(
          settlement['contract'] == 'asael-github-upgrade-settlement:1' &&
              settlement['attemptId'] == attempt!['id'] &&
              settlement['attemptSha256'] == attempt['attemptSha256'] &&
              !settledAt.isBefore(started!) &&
              settlement['settlementSha256'] ==
                  await connectorSha(
                    {...settlement}..remove('settlementSha256'),
                  ),
        );
        final summary = connectorMap(settlement['result']);
        connectorRequire(
          const ['complete', 'failed'].contains(summary['status']),
        );
        if (summary['status'] == 'complete') {
          final result = connectorObject(
            summary,
            'status kind connectorId connectorStatus endpoint defaultRiskLevel approvalRequired contractCount pendingCount credentialVersion review',
          );
          final count = connectorCount(
            result['contractCount'],
            200,
            minimum: 1,
          );
          final pin = await _githubPin(result['review'], intent.id);
          connectorRequire(
            result['kind'] == 'mcp' &&
                result['connectorId'] == intent.id &&
                result['connectorStatus'] == 'disabled' &&
                result['endpoint'] == githubExpandedMcpEndpoint &&
                result['defaultRiskLevel'] == 2 &&
                result['approvalRequired'] == false &&
                result['pendingCount'] == count &&
                result['credentialVersion'] ==
                    intent.review['credentialVersion'] &&
                pin['credentialVersion'] ==
                    intent.review['credentialVersion'] &&
                settledAt.isBefore(expires!),
          );
        } else {
          final result = connectorObject(
            summary,
            'status kind connectorId failureCode',
          );
          connectorRequire(
            result['kind'] == 'mcp' &&
                result['connectorId'] == intent.id &&
                const [
                  'discovery_failed',
                  'catalog_unreviewable',
                  'target_changed',
                  'deadline_exceeded',
                ].contains(result['failureCode']) &&
                (result['failureCode'] != 'deadline_exceeded' ||
                    !settledAt.isBefore(expires!)),
          );
        }
      }
      if (state == 'closed') {
        final closure = connectorObject(
          upgrade['closure'],
          'contract scope keySha256 intentSha256 attemptId attemptSha256 closedAt closureSha256',
        );
        final closedAt = _githubInstant(closure['closedAt']);
        connectorRequire(
          closure['contract'] == 'asael-github-upgrade-closure:1' &&
              connectorSame(closure['scope'], intent.owner.scope) &&
              closure['keySha256'] == intent.keySha256 &&
              closure['intentSha256'] == intent.requestSha256 &&
              closure['attemptId'] == attempt?['id'] &&
              closure['attemptSha256'] == attempt?['attemptSha256'] &&
              (started == null || !closedAt.isBefore(started)) &&
              closure['closureSha256'] ==
                  await connectorSha({...closure}..remove('closureSha256')),
        );
      }
    }

    await connectorServiceReceipt(
      row,
      owner,
      contract: connectorControlContract,
      operation: 'app.connectors.native.githubUpgrades.$kind',
      resource: 'connector_native_upgrade',
      count: upgrade == null ? 0 : 1,
      key: mutation ? intent.key : null,
      target: intent.id,
      purpose: kind == 'close'
          ? 'api.connectors.native.github_upgrade_close'
          : 'api.connectors.native.github_upgrade',
      action: kind == 'submit' ? 'manage.connector' : 'read',
      event: 'connector-native-github-upgrade-events.v1',
    );
    return ConnectorGithubUpgradeRead._(
      connectorFreeze(row),
      upgrade == null ? null : connectorFreeze(upgrade),
    );
  }
}
