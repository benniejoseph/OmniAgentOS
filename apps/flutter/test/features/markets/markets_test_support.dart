import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/markets/markets_contracts.dart';
import 'package:asael/features/markets/markets_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const marketOwner = MarketsOwner(
  '11111111-1111-4111-8111-111111111111',
  'tenant-market',
  'reader@example.test',
  'operator',
  'https://markets.example.test',
);
const marketStamp = '2026-10-04T10:00:00.000Z';
MarketJson marketOverviewFixture() => {
  'contractVersion': marketFoundation,
  'generatedAt': marketStamp,
  'phase': 'configuration_required',
  'instruments': [
    {
      'instrumentId': 'xauusd.spot',
      'label': 'Gold · XAU/USD',
      'identityWarning': 'Indicative spot; no futures identity is implied.',
    },
    {
      'instrumentId': 'ndx.cash',
      'label': 'Nasdaq-100 cash index',
      'identityWarning': 'NDX is not NQ, MNQ, QQQ or a CFD.',
    },
  ],
  'providers': [],
  'agent': {
    'name': 'Meridian',
    'note': 'Model assignment is unavailable.',
    'assignmentState': 'assignment_required',
  },
  'engineTracks': [],
  'guardrails': ['Research only.'],
};
Future<MarketJson> marketEnvelope(
  String kind,
  MarketJson body, {
  MarketsOwner owner = marketOwner,
}) async {
  final spec = marketReadSpecs[kind]!;
  final receipt = <String, dynamic>{
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': marketBoundary,
    'operation': 'app.market_research.${spec.serviceOperation}',
    'action': 'read',
    'resourceType': spec.resource,
    'accessMode': 'read',
    'eventContract': 'read_only:no_domain_mutation',
    'authoritySha256': await marketSha({
      'boundaryVersion': marketBoundary,
      'tenantId': owner.tenantId,
      'actorId': owner.actorId,
      'role': owner.role,
      'executionScope': null,
    }),
    'idempotencyKeySha256': null,
    'outcomeSha256': await marketSha(body),
    'resourceCount': (body[spec.listField] as List).length,
    'occurredAt': marketStamp,
  };
  return {
    ...body,
    'serviceReceipt': {...receipt, 'receiptSha256': await marketSha(receipt)},
  };
}

Future<MarketJson> marketSnapshotFixture({
  MarketsOwner owner = marketOwner,
}) async {
  final body = <String, dynamic>{
    'contractVersion': marketFoundation,
    'instrumentId': 'xauusd.spot',
    'provider': 'twelve_data',
    'providerSymbol': 'XAU/USD',
    'providerTimezone': 'UTC',
    'interval': '15min',
    'asOf': marketStamp,
    'bars': [
      {
        'time': DateTime.parse(marketStamp).millisecondsSinceEpoch ~/ 1000,
        'timestamp': marketStamp,
        'open': 100,
        'high': 101,
        'low': 99,
        'close': 100.5,
        'volume': null,
      },
    ],
  };
  final hash = await marketSha(body),
      identity = await marketStringSha(
        '${owner.tenantId}:${owner.actorId}:$hash',
      );
  return {
    ...body,
    'retrievedAt': marketStamp,
    'snapshotId': 'market_snapshot_${identity.substring(0, 48)}',
    'snapshotSha256': hash,
    'snapshotSource': 'cache',
  };
}

class MarketTestRepository implements MarketsRepository {
  MarketTestRepository({MarketsOwner owner = marketOwner})
    : access = MarketsAccess(
        owner: owner,
        ready: true,
        operations: {
          ...marketReadSpecs.values.map((row) => row.operation),
          ...marketWriteSpecs.values.map((row) => row.$1),
          'market.jobs.get',
        },
      );
  @override
  final MarketsAccess access;
  final List<String> reads = [];
  final List<MarketJson> writes = [];
  bool failWrite = false, failRead = false;
  Future<MarketDocument> Function(String, MarketJson, CancelToken)? pending;
  @override
  bool authorityCurrent() => access.readable;
  @override
  Future<MarketDocument> read(
    String kind,
    MarketJson query,
    CancelToken cancel,
  ) async {
    reads.add(kind);
    if (failRead) throw StateError('Unavailable source');
    if (pending != null) return pending!(kind, query, cancel);
    final data = switch (kind) {
      'overview' => marketOverviewFixture(),
      'snapshots' => <String, dynamic>{
        'contractVersion': marketFoundation,
        'instrumentId': query['instrumentId'],
        'interval': query['interval'],
        'snapshots': [],
        'hasMore': false,
      },
      'events' => <String, dynamic>{'events': [], 'total': 0},
      'replays' => <String, dynamic>{
        'replays': [],
        'eligibleEvents': 0,
        'replayedEvents': 0,
        'remainingEvents': 0,
      },
      'baselines' => <String, dynamic>{'groups': []},
      'analysis' => <String, dynamic>{'versions': [], 'total': 0},
      'backtests' => <String, dynamic>{'backtests': [], 'total': 0},
      'journal' => <String, dynamic>{
        'entries': [],
        'scorecard': {
          'total': 0,
          'resolved': 0,
          'due': 0,
          'directionalAccuracy': null,
        },
      },
      _ => <String, dynamic>{},
    };
    return MarketDocument(kind, marketFreeze(data));
  }

  @override
  Future<MarketJson> submit(String action, MarketJson body, String key) async {
    writes.add({'action': action, 'body': body, 'key': key});
    if (failWrite) throw StateError('Response lost after dispatch');
    return {
      'outcomes': [],
      'serviceReceipt': {'receiptSha256': 'a' * 64},
    };
  }

  @override
  Future<MarketJson> job(
    String id,
    String type,
    MarketJson submitted,
    CancelToken cancel,
  ) async => {'id': id, 'type': type, 'status': 'completed'};
}

class MarketTestApi extends ApiClient {
  MarketTestApi()
    : super(
        Dio(BaseOptions(baseUrl: marketOwner.apiScope)),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  int reads = 0, writes = 0;
  @override
  Future<MarketJson> getJsonFreshCancelable(
    String path, {
    MarketJson? query,
    MarketJson? headers,
    required CancelToken cancelToken,
  }) async {
    reads++;
    throw StateError('An invalid authority must not dispatch a read.');
  }

  @override
  Future<MarketJson> postJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    MarketJson? data,
    MarketJson? headers,
  }) async {
    writes++;
    throw StateError('An invalid authority must not dispatch a mutation.');
  }
}
