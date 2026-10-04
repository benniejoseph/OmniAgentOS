import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import '../auth/domain/app_session.dart';
import '../../core/network/api_client.dart';

typedef MarketJson = Map<String, dynamic>;
const marketFoundation = 'market-research-foundation:6';
const marketBoundary = 'p9.1-app-service-boundary:1';
void marketRequire(
  bool condition, [
  String message = 'Market evidence is invalid or incomplete.',
]) {
  if (!condition) throw FormatException(message);
}

MarketJson marketMap(Object? value) {
  marketRequire(value is Map && value.keys.every((key) => key is String));
  return Map<String, dynamic>.from(value as Map);
}

void marketKeys(MarketJson row, String fields) {
  final keys = fields.split(' ');
  marketRequire(row.length == keys.length && keys.every(row.containsKey));
}

String marketText(Object? value, [int max = 1600]) {
  marketRequire(value is String && value.isNotEmpty && value.length <= max);
  return value as String;
}

String marketIdentity(Object? value, String prefix) {
  final id = marketText(value, 120);
  marketRequire(RegExp('^${prefix}_[a-f0-9]{48}\$').hasMatch(id));
  return id;
}

String marketHash(Object? value) {
  final text = marketText(value, 64);
  marketRequire(RegExp(r'^[a-f0-9]{64}$').hasMatch(text));
  return text;
}

String marketDate(Object? value) {
  final text = marketText(value, 40);
  marketRequire(
    RegExp(r'^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$').hasMatch(text) &&
        DateTime.tryParse(text) != null,
  );
  return text;
}

int marketCount(Object? value, [int max = 9007199254740991]) {
  marketRequire(value is int && value >= 0 && value <= max);
  return value as int;
}

List<MarketJson> marketRows(Object? value, int max) {
  marketRequire(value is List && value.length <= max);
  return (value as List).map(marketMap).toList(growable: false);
}

MarketJson marketFreeze(MarketJson row) {
  var nodes = 0;
  Object? freeze(Object? value, int depth) {
    marketRequire(
      ++nodes <= 150000 && depth <= 24,
      'Market evidence exceeds its structural bound.',
    );
    if (value is Map) {
      return Map<String, dynamic>.unmodifiable(
        marketMap(value)
            .map((key, item) => MapEntry(key, freeze(item, depth + 1))),
      );
    }
    if (value is List) {
      return List<Object?>.unmodifiable(
        value.map((item) => freeze(item, depth + 1)),
      );
    }
    marketRequire(
      value == null ||
          value is bool ||
          value is String && value.length <= 20000 ||
          value is num && value.isFinite,
    );
    return value;
  }

  return freeze(row, 0) as MarketJson;
}

String _number(num value) {
  marketRequire(value.isFinite);
  if (value == 0) return '0';
  final sign = value < 0 ? '-' : '',
      text = value.abs().toString().toLowerCase(),
      parts = text.split('e');
  if (parts.length == 1) {
    return '$sign${text.endsWith('.0') ? text.substring(0, text.length - 2) : text}';
  }
  final exponent = int.parse(parts[1]),
      mantissa = parts[0].endsWith('.0')
          ? parts[0].substring(0, parts[0].length - 2)
          : parts[0];
  if (exponent < -6 || exponent >= 21) {
    return '$sign${mantissa}e${exponent >= 0 ? '+' : ''}$exponent';
  }
  final digits = mantissa.replaceAll('.', ''),
      point =
          (mantissa.contains('.') ? mantissa.indexOf('.') : mantissa.length) +
          exponent;
  if (point <= 0) return '${sign}0.${'0' * -point}$digits';
  if (point >= digits.length) {
    return '$sign$digits${'0' * (point - digits.length)}';
  }
  return '$sign${digits.substring(0, point)}.${digits.substring(point)}';
}

String marketCanonical(Object? value) {
  if (value is Map) {
    final row = marketMap(value), keys = row.keys.toList()..sort();
    return '{${keys.map((key) => '${jsonEncode(key)}:${marketCanonical(row[key])}').join(',')}}';
  }
  if (value is List) return '[${value.map(marketCanonical).join(',')}]';
  if (value is num) return _number(value);
  marketRequire(value == null || value is String || value is bool);
  return jsonEncode(value);
}

Future<String> marketSha(Object? value) async =>
    (await Sha256().hash(utf8.encode(marketCanonical(value)))).bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
Future<String> marketStringSha(String value) async =>
    (await Sha256().hash(utf8.encode(value))).bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
Future<void> marketDigest(
  MarketJson value,
  String field, [
  List<String> excluded = const [],
]) async {
  final body = {...value}..remove(field);
  for (final key in excluded) {
    body.remove(key);
  }
  marketRequire(
    marketHash(value[field]) == await marketSha(body),
    'The immutable market evidence digest differs from its body.',
  );
}

class MarketsOwner {
  const MarketsOwner(
    this.userId,
    this.tenantId,
    this.actorId,
    this.role,
    this.apiScope,
  );
  final String userId, tenantId, actorId, role, apiScope;
  String get key => jsonEncode([userId, tenantId, actorId, role, apiScope]);
  bool get canManage => ['operator', 'admin', 'system'].contains(role);
  static MarketsOwner? fromSession(AppSession? session, String api) {
    if (session == null ||
        !RegExp(
          r'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',
        ).hasMatch(session.userId) ||
        session.tenantId.isEmpty ||
        !['viewer', 'operator', 'admin', 'system'].contains(session.role)) {
      return null;
    }
    final user = session.userId.toLowerCase();
    if (session.actorId != 'actor:$user' &&
        (session.email.isEmpty ||
            session.actorId.trim().toLowerCase() !=
                session.email.trim().toLowerCase())) {
      return null;
    }
    return MarketsOwner(
      user,
      session.tenantId,
      session.actorId,
      session.role,
      NativeRequestAuthority.normalizeApiBaseUrl(api),
    );
  }
}

class MarketReadSpec {
  const MarketReadSpec(
    this.operation,
    this.path,
    this.serviceOperation,
    this.resource,
    this.fields,
    this.listField,
    this.limit,
  );
  final String operation, path, serviceOperation, resource, fields;
  final String? listField;
  final int limit;
}

const marketReadSpecs = <String, MarketReadSpec>{
  'overview': MarketReadSpec(
    'market.overview',
    '/api/market-research',
    'overview.show',
    'market_research',
    'contractVersion generatedAt phase instruments providers agent engineTracks guardrails',
    'instruments',
    20,
  ),
  'snapshots': MarketReadSpec(
    'market.snapshots.list',
    '/api/market-research/snapshots',
    'snapshots.list',
    'market_snapshot',
    'contractVersion instrumentId interval snapshots hasMore',
    'snapshots',
    40,
  ),
  'snapshot': MarketReadSpec(
    'market.snapshots.get',
    '/api/market-research/snapshots',
    'snapshots.show',
    'market_snapshot',
    'contractVersion instrumentId provider providerSymbol providerTimezone interval retrievedAt asOf bars snapshotId snapshotSha256 snapshotSource',
    'bars',
    1000,
  ),
  'bars': MarketReadSpec(
    'market.bars',
    '/api/market-research/bars',
    'bars.list',
    'market_snapshot',
    'contractVersion instrumentId provider providerSymbol providerTimezone interval retrievedAt asOf bars snapshotId snapshotSha256 snapshotSource',
    'bars',
    1000,
  ),
  'events': MarketReadSpec(
    'market.events',
    '/api/market-research/events',
    'events.list',
    'market_event_history',
    'contractVersion events total lastImportedAt',
    'events',
    100,
  ),
  'replays': MarketReadSpec(
    'market.replays',
    '/api/market-research/replays',
    'replays.list',
    'market_event_replay',
    'contractVersion instrumentId replays eligibleEvents replayedEvents remainingEvents lastReplayedAt',
    'replays',
    100,
  ),
  'baselines': MarketReadSpec(
    'market.baselines',
    '/api/market-research/baselines',
    'baselines.show',
    'market_event_baseline',
    'contractVersion baselineVersion instrumentId minimumSampleSize includedReplays groups resultSha256 interpretation',
    'groups',
    50,
  ),
  'features': MarketReadSpec(
    'market.features',
    '/api/market-research/features',
    'features.show',
    'market_technical_features',
    'contractVersion detectorVersion snapshot timeContext range definitions detections layers annotations counts resultSha256',
    'detections',
    240,
  ),
  'analysis': MarketReadSpec(
    'market.analysis.metadata',
    '/api/market-research/analysis',
    'analysis.list',
    'market_analysis_version',
    'contractVersion view instrumentId interval versions total',
    'versions',
    40,
  ),
  'backtests': MarketReadSpec(
    'market.backtests',
    '/api/market-research/backtests',
    'backtests.list',
    'market_backtest',
    'contractVersion instrumentId backtests total',
    'backtests',
    20,
  ),
  'journal': MarketReadSpec(
    'market.journal',
    '/api/market-research/journal',
    'journal.list',
    'market_forecast_journal',
    'contractVersion instrumentId entries scorecard',
    'entries',
    40,
  ),
  'calendar': MarketReadSpec(
    'market.calendar',
    '/api/market-research/calendar',
    'events.list',
    'market_event_history',
    'contractVersion generatedAt marketDate timezone windowDays catalog events sourceHealth disclosures',
    'events',
    120,
  ),
};

class MarketDocument {
  const MarketDocument(this.kind, this.data);
  final String kind;
  final MarketJson data;
  List<MarketJson> get rows {
    final spec = marketReadSpecs[kind], field = spec?.listField;
    return field == null ? const [] : marketRows(data[field], spec!.limit);
  }
}

Future<void> marketReceipt(
  MarketJson envelope,
  MarketsOwner owner, {
  required String operation,
  required String resource,
  required int count,
  String action = 'read',
  String event = 'read_only:no_domain_mutation',
  String? key,
}) async {
  final receipt = marketMap(envelope['serviceReceipt']),
      body = {...envelope}..remove('serviceReceipt');
  marketKeys(
    receipt,
    'schemaVersion receiptKind boundaryVersion operation action resourceType accessMode eventContract authoritySha256 idempotencyKeySha256 outcomeSha256 resourceCount occurredAt receiptSha256',
  );
  marketRequire(
    receipt['schemaVersion'] == 1 &&
        receipt['receiptKind'] == 'app_service_receipt' &&
        receipt['boundaryVersion'] == marketBoundary &&
        receipt['operation'] == 'app.market_research.$operation' &&
        receipt['action'] == action &&
        receipt['resourceType'] == resource &&
        receipt['eventContract'] == event &&
        receipt['accessMode'] == (key == null ? 'read' : 'mutation') &&
        receipt['resourceCount'] == count,
  );
  marketDate(receipt['occurredAt']);
  await marketDigest(receipt, 'receiptSha256');
  marketRequire(receipt['outcomeSha256'] == await marketSha(body));
  // Mutation authority includes server execution scope, which is not returned.
  // Exact-token transport binds that authority; reads have a reproducible null scope.
  if (key == null) {
    marketRequire(
      receipt['authoritySha256'] ==
          await marketSha({
            'boundaryVersion': marketBoundary,
            'tenantId': owner.tenantId,
            'actorId': owner.actorId,
            'role': owner.role,
            'executionScope': null,
          }),
    );
  }
  marketRequire(
    receipt['idempotencyKeySha256'] ==
        (key == null ? null : await marketStringSha(key)),
  );
}

Future<void> _snapshotIdentity(MarketJson row, MarketsOwner owner) async {
  marketIdentity(row['snapshotId'], 'market_snapshot');
  marketHash(row['snapshotSha256']);
  final expected = await marketStringSha(
    '${owner.tenantId}:${owner.actorId}:${row['snapshotSha256']}',
  );
  marketRequire(
    row['snapshotId'] == 'market_snapshot_${expected.substring(0, 48)}',
    'Stored evidence belongs to another exact owner.',
  );
}

Future<MarketDocument> parseMarketDocument(
  String kind,
  MarketJson input,
  MarketsOwner owner,
  MarketJson query,
) async {
  final spec = marketReadSpecs[kind]!;
  marketRequire(utf8.encode(jsonEncode(input)).length <= 8 * 1024 * 1024);
  final envelope = marketFreeze(input),
      body = {...envelope}..remove('serviceReceipt');
  marketRequire(
    body['contractVersion'] ==
        (kind == 'journal'
            ? 'market-forward-shadow:1'
            : kind == 'analysis'
            ? 'market-analysis-version:1'
            : kind == 'calendar'
            ? 'market-live-calendar:1'
            : marketFoundation),
  );
  if (spec.fields.isNotEmpty) marketKeys(body, spec.fields);
  final rows = spec.listField == null
      ? <MarketJson>[]
      : marketRows(body[spec.listField], spec.limit);
  await marketReceipt(
    envelope,
    owner,
    operation: spec.serviceOperation,
    resource: spec.resource,
    count: rows.length,
  );
  if (query['instrumentId'] != null) {
    marketRequire(body['instrumentId'] == query['instrumentId']);
  }
  if (query['interval'] != null) {
    marketRequire(body['interval'] == query['interval']);
  }
  if (query['limit'] is int) {
    marketRequire(rows.length <= (query['limit'] as int));
  }
  if (kind == 'overview') {
    marketRequire(
      body['contractVersion'] == marketFoundation && rows.isNotEmpty,
    );
    final ids = <String>{};
    for (final row in rows) {
      marketRequire(ids.add(marketText(row['instrumentId'], 120)));
      marketText(row['label'], 120);
      marketText(row['identityWarning'], 700);
    }
    marketRows(body['providers'], 8);
    marketRows(body['engineTracks'], 4);
    marketMap(body['agent']);
    marketDate(body['generatedAt']);
  } else if (kind == 'snapshots') {
    marketRequire(
      body['contractVersion'] == marketFoundation && body['hasMore'] is bool,
    );
    final ids = <String>{};
    for (final row in rows) {
      marketKeys(
        row,
        'snapshotId snapshotSha256 instrumentId provider providerSymbol providerTimezone interval retrievedAt asOf barCount',
      );
      await _snapshotIdentity(row, owner);
      marketRequire(
        ids.add(row['snapshotId'] as String) &&
            row['instrumentId'] == body['instrumentId'] &&
            row['interval'] == body['interval'] &&
            row['provider'] == 'twelve_data',
      );
      marketCount(row['barCount'], 1000);
      marketDate(row['asOf']);
      marketDate(row['retrievedAt']);
    }
  } else if (kind == 'snapshot' || kind == 'bars') {
    await _snapshotIdentity(body, owner);
    marketRequire(
      body['contractVersion'] == marketFoundation &&
          body['provider'] == 'twelve_data' &&
          ['cache', 'provider'].contains(body['snapshotSource']),
    );
    if (kind == 'snapshot') {
      marketRequire(
        body['snapshotSource'] == 'cache' &&
            body['snapshotId'] == query['snapshotId'],
      );
    }
    if (query['outputSize'] is int) {
      marketRequire(rows.length <= (query['outputSize'] as int));
    }
    marketDate(body['asOf']);
    marketDate(body['retrievedAt']);
    var prior = -1;
    for (final bar in rows) {
      marketKeys(bar, 'time timestamp open high low close volume');
      final time = marketCount(bar['time']);
      marketDate(bar['timestamp']);
      marketRequire(
        time > prior &&
            DateTime.parse(bar['timestamp'] as String).millisecondsSinceEpoch ==
                time * 1000,
      );
      for (final field in ['open', 'high', 'low', 'close']) {
        marketRequire(bar[field] is num && (bar[field] as num).isFinite);
      }
      marketRequire(
        (bar['low'] as num) <= (bar['open'] as num) &&
            (bar['low'] as num) <= (bar['close'] as num) &&
            (bar['high'] as num) >= (bar['open'] as num) &&
            (bar['high'] as num) >= (bar['close'] as num),
      );
      marketRequire(
        bar['volume'] == null ||
            bar['volume'] is num && (bar['volume'] as num) >= 0,
      );
      prior = time;
    }
    final normalized = {...body}
      ..remove('snapshotId')
      ..remove('snapshotSha256')
      ..remove('snapshotSource')
      ..remove('retrievedAt');
    marketRequire(body['snapshotSha256'] == await marketSha(normalized));
  } else if (kind == 'features') {
    final snapshot = marketMap(body['snapshot']);
    marketRequire(snapshot['id'] == query['snapshotId']);
    await _snapshotIdentity({
      'snapshotId': snapshot['id'],
      'snapshotSha256': snapshot['sha256'],
    }, owner);
    await marketDigest(body, 'resultSha256');
    marketRows(body['annotations'], 120);
    marketRows(body['layers'], 8);
    marketRows(body['definitions'], 30);
  } else if (kind == 'analysis') {
    marketRequire(
      body['view'] == 'metadata' &&
          body['contractVersion'] == 'market-analysis-version:1',
    );
    marketCount(body['total']);
    for (final row in rows) {
      marketKeys(
        row,
        'id contractVersion instrumentId interval snapshotId snapshotSha256 detectorVersion technicalResultSha256 visibleLayerIds chartStateSha256 annotationCount detectionCount candidateCount savedAt versionSha256',
      );
      marketRequire(
        row['instrumentId'] == body['instrumentId'] &&
            row['interval'] == body['interval'],
      );
      marketIdentity(row['id'], 'market_analysis');
      await _snapshotIdentity(row, owner);
      marketDate(row['savedAt']);
      marketCount(row['annotationCount'], 120);
      marketCount(row['detectionCount'], 240);
      marketRequire(
        marketCount(row['candidateCount'], 240) <=
            (row['detectionCount'] as int),
      );
    }
  } else if (kind == 'events') {
    marketCount(body['total']);
    for (final row in rows) {
      marketIdentity(row['id'], 'market_event');
      marketText(row['name'], 160);
      marketRequire(
        ['date', 'instant'].contains(row['timestampPrecision']) &&
            (row['timestampPrecision'] == 'instant') ==
                (row['occurredAt'] != null),
      );
      marketRows(row['observations'], 12);
      final identity = await marketStringSha(
        'fred:${marketCount(row['sourceReleaseId'])}:${row['releaseDate']}',
      );
      marketRequire(row['id'] == 'market_event_${identity.substring(0, 48)}');
    }
  } else if (kind == 'replays') {
    for (final row in rows) {
      marketIdentity(row['id'], 'market_replay');
      marketRequire(row['instrumentId'] == body['instrumentId']);
      marketHash(row['snapshotSha256']);
      final identity = await marketStringSha(
        '${owner.tenantId}:${owner.actorId}:${row['eventId']}:${row['instrumentId']}:${row['interval']}:${row['snapshotSha256']}',
      );
      marketRequire(row['id'] == 'market_replay_${identity.substring(0, 48)}');
    }
    final remaining =
        marketCount(body['eligibleEvents']) -
        marketCount(body['replayedEvents']);
    marketRequire(body['remainingEvents'] == (remaining < 0 ? 0 : remaining));
  } else if (kind == 'baselines') {
    await marketDigest(body, 'resultSha256');
    marketCount(body['includedReplays'], 500);
    for (final row in rows) {
      marketCount(row['sampleSize']);
      marketRequire(
        ['low_sample', 'descriptive_baseline'].contains(row['state']),
      );
    }
  } else if (kind == 'backtests') {
    marketCount(body['total']);
    for (final row in rows) {
      marketIdentity(row['id'], 'market_backtest');
      marketRequire(row['instrumentId'] == body['instrumentId']);
      await marketDigest(row, 'resultSha256', ['createdAt']);
      await _snapshotIdentity(row, owner);
      marketRows(row['trades'], 1000);
      final identity = await marketStringSha(
        await marketSha({
          'tenantId': owner.tenantId,
          'actorId': owner.actorId,
          'snapshotId': row['snapshotId'],
          'snapshotSha256': row['snapshotSha256'],
          'manifest': row['manifest'],
        }),
      );
      marketRequire(
        row['id'] == 'market_backtest_${identity.substring(0, 48)}',
      );
    }
  } else if (kind == 'journal') {
    final score = marketMap(body['scorecard']);
    marketRequire(
      score['probabilityState'] == 'uncalibrated' &&
          score['brierScore'] == null &&
          score['total'] == rows.length,
    );
    for (final row in rows) {
      marketKeys(row, 'forecast resolutionState outcome');
      final forecast = marketMap(row['forecast']);
      await validateMarketForecast(
        forecast,
        owner,
        query['instrumentId'] as String,
      );
      marketRequire(
        ['open', 'due', 'resolved'].contains(row['resolutionState']) &&
            (row['resolutionState'] == 'resolved') == (row['outcome'] != null),
      );
      if (row['outcome'] != null) {
        final outcome = marketMap(row['outcome']);
        await marketDigest(outcome, 'outcomeSha256', ['id']);
        marketRequire(
          outcome['forecastId'] == forecast['id'] &&
              outcome['brierScore'] == null,
        );
      }
    }
    final resolved = rows.where((row) => row['outcome'] != null).toList(),
        directional = resolved
            .where((row) => marketMap(row['forecast'])['stance'] != 'abstain')
            .toList();
    final hits = directional
        .where((row) => marketMap(row['outcome'])['stanceHit'] == true)
        .length;
    marketRequire(
      await marketSha(score) ==
          await marketSha({
            'total': rows.length,
            'resolved': resolved.length,
            'due': rows.where((row) => row['resolutionState'] == 'due').length,
            'abstentions': rows
                .where(
                  (row) => marketMap(row['forecast'])['stance'] == 'abstain',
                )
                .length,
            'directionalAccuracy': directional.isEmpty
                ? null
                : hits / directional.length,
            'directionalSampleSize': directional.length,
            'coverage': resolved.isEmpty
                ? null
                : directional.length / resolved.length,
            'brierScore': null,
            'probabilityState': 'uncalibrated',
          }),
    );
  } else if (kind == 'calendar') {
    marketRequire(body['contractVersion'] == 'market-live-calendar:1');
    // Source failures are independent of an empty upcoming-events array.
    marketRows(body['sourceHealth'], 4);
  }
  return MarketDocument(kind, marketFreeze(body));
}

Future<void> validateMarketForecast(
  MarketJson forecast,
  MarketsOwner owner,
  String instrument,
) async {
  marketIdentity(forecast['id'], 'market_forecast');
  marketRequire(
    forecast['instrumentId'] == instrument &&
        forecast['researchMode'] == true &&
        forecast['probabilityState'] == 'uncalibrated',
  );
  await marketDigest(forecast, 'forecastSha256', ['id']);
  final identity = await marketStringSha(
    jsonEncode({
      'tenantId': owner.tenantId,
      'actorId': owner.actorId,
      'forecastSha256': forecast['forecastSha256'],
    }),
  );
  marketRequire(
    forecast['id'] == 'market_forecast_${identity.substring(0, 48)}',
  );
  marketRows(forecast['scenarios'], 3);
  marketText(forecast['summary'], 1600);
  await _snapshotIdentity(marketMap(forecast['evidence']), owner);
}
