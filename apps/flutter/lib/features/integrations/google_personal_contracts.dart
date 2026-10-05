import 'dart:math';

import 'connector_contracts.dart';

const googlePersonalReadContract = 'asael-google-personal-actions-read:1';
const _sources = ['mail', 'calendar', 'drive'];
const _actions = ['sync', 'disconnect'];
List<String> _sourceSet(Object? value) {
  connectorRequire(value is List && value.length <= 3);
  final list = List<String>.from(value as List);
  var previous = -1;
  for (final source in list) {
    final index = _sources.indexOf(source);
    connectorRequire(index > previous);
    previous = index;
  }
  return list;
}

Future<ConnectorJson> googlePersonalReview(Object? value) async {
  final row = connectorObject(
    value,
    'connectionId accountEmail authorizationGeneration status sourceScopeSha256 permittedSources reviewSha256',
  );
  connectorId(row['connectionId'], maximum: 320);
  final email = connectorText(row['accountEmail'], 320);
  connectorRequire(RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(email));
  connectorCount(row['authorizationGeneration'], 2147483647, minimum: 1);
  connectorRequire(const ['active', 'revoked'].contains(row['status']));
  connectorHash(row['sourceScopeSha256']);
  connectorHash(row['reviewSha256']);
  _sourceSet(row['permittedSources']);
  connectorRequire(
    row['reviewSha256'] == await connectorSha({...row}..remove('reviewSha256')),
  );
  return connectorFreeze(row);
}

Future<ConnectorJson> _request(Object? value) async {
  final row = connectorObject(value, 'contract action review'),
      review = await googlePersonalReview(row['review']);
  connectorRequire(
    row['contract'] == 'asael-google-personal-action:1' &&
        _actions.contains(row['action']) &&
        review['status'] == 'active' &&
        (row['action'] != 'sync' ||
            (review['permittedSources'] as List).isNotEmpty) &&
        (row['action'] != 'disconnect' ||
            (review['authorizationGeneration'] as int) < 2147483647),
  );
  return connectorFreeze(row);
}

class GooglePersonalIntent {
  const GooglePersonalIntent._(
    this.owner,
    this.key,
    this.identity,
    this.requestSha256,
  );
  final ConnectorOwner owner;
  final String key, requestSha256;
  final ConnectorJson identity;
  ConnectorJson get request => connectorMap(identity['request']);
  String get keySha256 => identity['idempotencyKeySha256'] as String;
  String get action => request['action'] as String;
  ConnectorJson get review => connectorMap(request['review']);
  String get connectionId => review['connectionId'] as String;
  ConnectorJson get stored => {
    'owner': owner.json,
    'key': key,
    'identity': identity,
    'requestSha256': requestSha256,
  };
  static Future<GooglePersonalIntent> prepare(
    ConnectorOwner owner,
    GooglePersonalRead reviewed,
    String action, {
    String? key,
  }) async {
    connectorRequire(
      reviewed.connection != null &&
          reviewed.actions.contains(action) &&
          connectorSame(reviewed.raw['scope'], owner.scope),
    );
    return _create(
      owner,
      key ??
          'native-google-${List.generate(24, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}',
      {
        'contract': 'asael-google-personal-action:1',
        'action': action,
        'review': reviewed.connection,
      },
    );
  }

  static Future<GooglePersonalIntent> _create(
    ConnectorOwner owner,
    String key,
    Object? request,
  ) async {
    connectorRequire(
      RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$').hasMatch(key),
    );
    final body = await _request(request);
    final identity = connectorFreeze({
      'contract': 'asael-google-personal-intent:1',
      'scope': owner.scope,
      'idempotencyKeySha256': await connectorRawSha(
        '${owner.tenantId}\u0000$key',
      ),
      'request': body,
    });
    return GooglePersonalIntent._(
      owner,
      key,
      identity,
      await connectorSha(identity),
    );
  }

  static Future<GooglePersonalIntent> restore(
    Object? value,
    ConnectorOwner current,
  ) async {
    final row = connectorObject(value, 'owner key identity requestSha256'),
        owner = ConnectorOwner.restore(row['owner'], current);
    final identity = connectorObject(
      row['identity'],
      'contract scope idempotencyKeySha256 request',
    );
    connectorRequire(connectorSame(owner.scope, current.scope));
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

Future<ConnectorJson> _action(Object? value, ConnectorOwner owner) async {
  final row = connectorObject(value, 'acceptance state settlement');
  final a = connectorObject(
    row['acceptance'],
    'contract id scope action idempotencyKeySha256 requestSha256 review acceptedAt localRevoked acceptanceSha256',
  );
  final review = await googlePersonalReview(a['review']),
      key = connectorHash(a['idempotencyKeySha256']);
  connectorHash(a['requestSha256']);
  connectorHash(a['acceptanceSha256']);
  connectorInstant(a['acceptedAt']);
  final request = await _request({
    'contract': 'asael-google-personal-action:1',
    'action': a['action'],
    'review': review,
  });
  final identity = {
    'contract': 'asael-google-personal-intent:1',
    'scope': owner.scope,
    'idempotencyKeySha256': key,
    'request': request,
  };
  connectorRequire(
    a['contract'] == 'asael-google-personal-acceptance:1' &&
        connectorSame(a['scope'], owner.scope) &&
        a['localRevoked'] == (a['action'] == 'disconnect') &&
        a['requestSha256'] == await connectorSha(identity) &&
        a['id'] ==
            'google-personal-action:${await connectorSha({'scope': owner.scope, 'idempotencyKeySha256': key})}' &&
        a['acceptanceSha256'] ==
            await connectorSha({...a}..remove('acceptanceSha256')) &&
        const ['accepted', 'settled'].contains(row['state']) &&
        (row['state'] == 'settled') == (row['settlement'] != null),
  );
  if (row['settlement'] != null) {
    final s = connectorObject(
      row['settlement'],
      a['action'] == 'sync'
          ? 'action status imported removed cursorAdvanced sources settledAt'
          : 'action status providerRevocation settledAt',
    );
    connectorRequire(
      s['action'] == a['action'] &&
          !DateTime.parse(connectorInstant(s['settledAt']))
              .isBefore(DateTime.parse(a['acceptedAt'] as String)),
    );
    if (a['action'] == 'disconnect') {
      connectorRequire(
        s['status'] == 'local_revoked' &&
            const ['revoked', 'unconfirmed'].contains(s['providerRevocation']),
      );
    } else {
      connectorRequire(
        const ['healthy', 'partial'].contains(s['status']) &&
            s['cursorAdvanced'] is bool &&
            s['sources'] is List,
      );
      connectorCount(s['imported'], 2147483647);
      connectorCount(s['removed'], 2147483647);
      final sources = s['sources'] as List;
      connectorRequire(sources.isNotEmpty && sources.length <= 3);
      var imported = 0, removed = 0, healthy = true;
      final ids = <String>[];
      for (final source in sources) {
        final item = connectorObject(
          source,
          'source status backfillState imported removed lastAttemptedAt lastSuccessfulAt',
        );
        connectorRequire(
          _sources.contains(item['source']) &&
              const ['syncing', 'healthy'].contains(item['status']) &&
              const [
                'unknown',
                'in_progress',
                'complete',
              ].contains(item['backfillState']),
        );
        ids.add(item['source'] as String);
        imported += connectorCount(item['imported'], 2147483647);
        removed += connectorCount(item['removed'], 2147483647);
        connectorInstant(item['lastAttemptedAt']);
        connectorInstant(item['lastSuccessfulAt']);
        healthy = healthy && item['status'] == 'healthy';
      }
      connectorRequire(
        connectorSame(ids, review['permittedSources']) &&
            imported == s['imported'] &&
            removed == s['removed'] &&
            (s['status'] == 'healthy') == healthy,
      );
    }
  }
  return connectorFreeze(row);
}

class GooglePersonalRead {
  const GooglePersonalRead._(
    this.raw,
    this.connection,
    this.actions,
    this.blocked,
    this.action,
    this.busy,
  );
  final ConnectorJson raw;
  final ConnectorJson? connection, blocked, action;
  final List<String> actions;
  final bool busy;
  ConnectorJson? get acceptance =>
      action == null ? null : connectorMap(action!['acceptance']);
  bool get settled => action?['state'] == 'settled';
  static Future<GooglePersonalRead> parse(
    Object? value,
    ConnectorOwner owner, {
    String kind = 'review',
    String? keySha256,
    GooglePersonalIntent? intent,
  }) async {
    connectorRequire(const ['review', 'read', 'submit'].contains(kind));
    final mutation = kind == 'submit';
    connectorRequire(!mutation || intent != null);
    final row = connectorObject(
      value,
      mutation
          ? 'contract scope current action replayed serviceReceipt'
          : 'contract scope current action serviceReceipt',
    );
    final current = connectorObject(
      row['current'],
      'connection availableActions blockedAction busy',
    );
    final connection = current['connection'] == null
        ? null
        : await googlePersonalReview(current['connection']);
    final blocked = current['blockedAction'] == null
        ? null
        : await _action(current['blockedAction'], owner);
    final action = row['action'] == null
            ? null
            : await _action(row['action'], owner),
        actions = current['availableActions'];
    connectorRequire(
      current['busy'] is bool &&
          actions is List &&
          actions.length <= 2 &&
          actions.toSet().length == actions.length &&
          actions.every(_actions.contains),
    );
    connectorRequire(blocked == null || blocked['state'] == 'accepted');
    if ((actions as List).isNotEmpty) {
      connectorRequire(
        connection != null &&
            connection['status'] == 'active' &&
            blocked == null &&
            current['busy'] == false &&
            (!actions.contains('sync') ||
                (connection['permittedSources'] as List).isNotEmpty) &&
            (!actions.contains('disconnect') ||
                (connection['authorizationGeneration'] as int) < 2147483647),
      );
    }
    connectorRequire(kind != 'review' || action == null);
    if (mutation) {
      connectorRequire(action != null && row['replayed'] is bool);
    }
    if (keySha256 != null) {
      connectorHash(keySha256);
      connectorRequire(
        action == null ||
            (action['acceptance'] as Map)['idempotencyKeySha256'] == keySha256,
      );
    }
    if (intent != null) {
      connectorRequire(
        owner.storageKey == intent.owner.storageKey &&
            connectorSame(owner.scope, intent.owner.scope),
      );
      if (action != null) {
        final a = connectorMap(action['acceptance']);
        connectorRequire(
          a['idempotencyKeySha256'] == intent.keySha256 &&
              a['requestSha256'] == intent.requestSha256 &&
              a['action'] == intent.action &&
              connectorSame(a['review'], intent.review),
        );
      }
    }
    await connectorServiceReceipt(
      row,
      owner,
      contract: googlePersonalReadContract,
      operation: 'app.google.personal.actions.$kind',
      resource: 'oauth_grant',
      count: kind == 'review'
          ? (connection == null ? 0 : 1)
          : (action == null ? 0 : 1),
      key: mutation ? intent!.key : null,
      purpose: 'api.google.personal.action',
      target: intent?.connectionId,
      event: 'google-personal-native-events.v1',
      action: 'write.memory',
    );
    return GooglePersonalRead._(
      connectorFreeze(row),
      connection,
      List.unmodifiable(List<String>.from(actions)),
      blocked,
      action,
      current['busy'] as bool,
    );
  }
}
