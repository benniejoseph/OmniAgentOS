import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../generated/native_contract.g.dart';
import '../auth/domain/app_session.dart';
import 'markets_contracts.dart';

class MarketsAccess extends ChangeNotifier {
  MarketsAccess({this.owner, this.ready = false, required this.operations});
  MarketsOwner? owner;
  bool ready, closed = false;
  int generation = 0;
  final Set<String> operations;
  bool get readable => !closed && ready && owner != null;
  void update(MarketsOwner? next, {required bool available}) {
    if (closed || owner?.key == next?.key && ready == available) return;
    owner = next;
    ready = available;
    generation++;
    notifyListeners();
  }

  void close({bool notify = true}) {
    if (closed) return;
    closed = true;
    ready = false;
    generation++;
    if (notify) notifyListeners();
  }
}

const marketWriteSpecs = <String, (String, String, String, String, String)>{
  'events': (
    'market.events.backfill',
    '/api/market-research/events',
    'events.backfill',
    'market_event_history',
    'market-macro-event-events.v1',
  ),
  'replays': (
    'market.replays.backfill',
    '/api/market-research/replays',
    'replays.backfill',
    'market_event_replay',
    'market-event-replay-events.v1',
  ),
  'backtest': (
    'market.backtests.run',
    '/api/market-research/backtests',
    'backtests.run',
    'market_backtest',
    'market-backtest-events.v1',
  ),
  'daily': (
    'market.journal.generate',
    '/api/market-research/journal/generate',
    'journal.generate',
    'market_forward_forecast',
    'market-forward-shadow-events.v1',
  ),
  'weekly': (
    'market.journal.generate',
    '/api/market-research/journal/generate',
    'journal.generate',
    'market_forward_forecast',
    'market-forward-shadow-events.v1',
  ),
  'score': (
    'market.journal.score',
    '/api/market-research/journal/score',
    'journal.score',
    'market_forecast_outcome',
    'market-forward-shadow-events.v1',
  ),
};

abstract interface class MarketsRepository {
  MarketsAccess get access;
  bool authorityCurrent();
  Future<MarketDocument> read(
    String kind,
    MarketJson query,
    CancelToken cancel,
  );
  Future<MarketJson> submit(String action, MarketJson body, String key);
  Future<MarketJson> job(
    String id,
    String type,
    MarketJson submitted,
    CancelToken cancel,
  );
}

class ApiMarketsRepository implements MarketsRepository {
  ApiMarketsRepository(
    this.api, {
    required this.access,
    required bool Function() authorityProbe,
  }) : _probe = authorityProbe {
    access.addListener(_changed);
  }
  final ApiClient api;
  @override
  final MarketsAccess access;
  final bool Function() _probe;
  final Set<CancelToken> _reads = {};
  bool _disposed = false;
  @override
  bool authorityCurrent() =>
      !_disposed &&
      access.readable &&
      _probe() &&
      !_disposed &&
      access.readable;
  void _changed() {
    for (final token in _reads.toList()) {
      token.cancel('Market authority changed.');
    }
  }

  void _require(String operation, int epoch, [CancelToken? cancel]) {
    marketRequire(
      authorityCurrent() &&
          epoch == access.generation &&
          cancel?.isCancelled != true &&
          access.operations.contains(operation),
      'Current market access and a published operation are required.',
    );
  }

  Future<void> _bootstrap(
    String operation,
    int epoch,
    MarketsOwner owner,
    CancelToken cancel,
  ) async {
    _require(operation, epoch, cancel);
    try {
      final data = await api.getJsonFreshCancelable(
        NativePaths.bootstrapGet,
        cancelToken: cancel,
      );
      _require(operation, epoch, cancel);
      final current = MarketsOwner.fromSession(
        AppSession.fromJson(data),
        api.apiBaseUrl,
      );
      marketRequire(
        data['authenticated'] == true &&
            current?.key == owner.key &&
            marketMap(data['context'])['role'] == owner.role,
        'The current API identity changed.',
      );
    } catch (error) {
      final status = error is ApiException
          ? error.statusCode
          : error is DioException
          ? error.response?.statusCode
          : null;
      if ((status == 401 || status == 403 || error is FormatException) &&
          access.generation == epoch &&
          authorityCurrent()) {
        access.update(null, available: false);
      }
      rethrow;
    }
  }

  @override
  Future<MarketDocument> read(
    String kind,
    MarketJson query,
    CancelToken cancel,
  ) async {
    final spec = marketReadSpecs[kind]!, epoch = access.generation;
    _require(spec.operation, epoch, cancel);
    final owner = access.owner!;
    _reads.add(cancel);
    try {
      await _bootstrap(spec.operation, epoch, owner, cancel);
      _require(spec.operation, epoch, cancel);
      final arguments = {...query}..remove('snapshotId');
      if (kind == 'features') arguments['snapshotId'] = query['snapshotId'];
      final path = kind == 'snapshot'
          ? '${spec.path}/${Uri.encodeComponent(marketIdentity(query['snapshotId'], 'market_snapshot'))}'
          : spec.path;
      final data = await api.getJsonFreshCancelable(
        path,
        query: arguments,
        cancelToken: cancel,
      );
      _require(spec.operation, epoch, cancel);
      final result = await parseMarketDocument(kind, data, owner, query);
      _require(spec.operation, epoch, cancel);
      return result;
    } finally {
      _reads.remove(cancel);
    }
  }

  @override
  Future<MarketJson> submit(String action, MarketJson body, String key) async {
    final spec = marketWriteSpecs[action]!, epoch = access.generation;
    _require(spec.$1, epoch);
    final owner = access.owner!;
    marketRequire(owner.canManage, 'This role cannot start market work.');
    final submitted = marketFreeze(body);
    final data = marketFreeze(
      await api.postJsonAuthorized(
        spec.$2,
        authority: NativeRequestAuthority(
          tenantId: owner.tenantId,
          actorId: owner.actorId,
          canonicalUserId: owner.userId,
          role: owner.role,
          apiBaseUrl: owner.apiScope,
          isCurrent: () =>
              authorityCurrent() &&
              epoch == access.generation &&
              owner.key == access.owner?.key,
        ),
        data: submitted,
        headers: {'Idempotency-Key': key},
      ),
    );
    _require(spec.$1, epoch);
    var count = 1;
    if (['events', 'replays', 'backtest'].contains(action)) {
      marketKeys(data, 'job serviceReceipt');
      validateMarketJob(
        marketMap(data['job']),
        type: action == 'backtest'
            ? 'market.backtest.run'
            : 'market.$action.backfill',
        submitted: submitted,
      );
    } else if (action == 'score') {
      marketKeys(data, 'outcomes serviceReceipt');
      final outcomes = marketRows(data['outcomes'], 2);
      count = outcomes.length;
      for (final outcome in outcomes) {
        await marketDigest(outcome, 'outcomeSha256', ['id']);
        marketIdentity(outcome['forecastId'], 'market_forecast');
        marketRequire(outcome['brierScore'] == null);
      }
    } else {
      marketKeys(data, 'forecast reused serviceReceipt');
      marketRequire(data['reused'] is bool);
      final forecast = marketMap(data['forecast']);
      await validateMarketForecast(
        forecast,
        owner,
        marketText(submitted['instrumentId'], 120),
      );
      marketRequire(forecast['horizon'] == submitted['horizon']);
    }
    await marketReceipt(
      data,
      owner,
      operation: spec.$3,
      resource: spec.$4,
      count: count,
      key: key,
      action: ['daily', 'weekly'].contains(action)
          ? 'run.agent'
          : 'manage.workflow',
      event: spec.$5,
    );
    _require(spec.$1, epoch);
    return data;
  }

  @override
  Future<MarketJson> job(
    String id,
    String type,
    MarketJson submitted,
    CancelToken cancel,
  ) async {
    const operation = 'market.jobs.get';
    final epoch = access.generation;
    _require(operation, epoch, cancel);
    _reads.add(cancel);
    try {
      await _bootstrap(operation, epoch, access.owner!, cancel);
      _require(operation, epoch, cancel);
      final data = marketFreeze(
        await api.getJsonFreshCancelable(
          '/api/market-research/jobs/${Uri.encodeComponent(id)}',
          cancelToken: cancel,
        ),
      );
      _require(operation, epoch, cancel);
      marketKeys(data, 'job');
      final job = marketMap(data['job']);
      validateMarketJob(job, id: id, type: type, submitted: submitted);
      return job;
    } finally {
      _reads.remove(cancel);
    }
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _changed();
    access.removeListener(_changed);
  }
}

void validateMarketJob(
  MarketJson row, {
  String? id,
  required String type,
  required MarketJson submitted,
}) {
  const allowed = {
    'id',
    'type',
    'status',
    'quarantined',
    'priority',
    'attempt',
    'maxAttempts',
    'runAt',
    'createdAt',
    'updatedAt',
    'completedAt',
    'lastError',
    'progress',
    'result',
  };
  marketRequire(
    row.keys.every(allowed.contains) &&
        RegExp(
          r'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',
        ).hasMatch(marketText(row['id'], 36)) &&
        (id == null || row['id'] == id) &&
        row['type'] == type &&
        [
          'queued',
          'running',
          'completed',
          'failed',
          'canceled',
        ].contains(row['status']),
  );
  marketCount(row['attempt']);
  marketCount(row['maxAttempts']);
  for (final field in ['runAt', 'createdAt', 'updatedAt']) {
    marketDate(row[field]);
  }
  if (row['lastError'] != null) marketText(row['lastError'], 4000);
  if (row['result'] != null) {
    final result = marketMap(row['result']);
    if (submitted['instrumentId'] != null) {
      marketRequire(result['instrumentId'] == submitted['instrumentId']);
    }
    if (submitted['snapshotId'] != null) {
      marketRequire(result['snapshotId'] == submitted['snapshotId']);
    }
    if (submitted['startDate'] != null) {
      marketRequire(
        result['startDate'] == submitted['startDate'] &&
            result['endDate'] == submitted['endDate'],
      );
    }
    if (type == 'market.backtest.run') {
      marketRequire(result['resourceId'] == result['backtestId']);
    }
  }
  marketRequire(utf8.encode(jsonEncode(row)).length <= 64000);
}
