import 'dart:async';
import 'dart:math';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import 'markets_contracts.dart';
import 'markets_repository.dart';
import 'markets_recovery_store.dart';

class MarketsController extends ChangeNotifier {
  MarketsController(this.repository, this.recovery) {
    _ownerKey = repository.access.owner?.key;
    repository.access.addListener(_accessChanged);
  }
  final MarketsRepository repository;
  final MarketsRecoveryStore recovery;
  final Map<String, MarketDocument> documents = {};
  final Map<String, String> failures = {};
  final Map<String, CancelToken> _reads = {};
  final Set<String> loading = {};
  final List<MarketJson> intents = [];
  final Map<String, MarketJson> backtestDrafts = {};
  String startDate = '2000-01-01',
      endDate = DateTime.now().toUtc().toIso8601String().substring(0, 10);
  String instrumentId = 'xauusd.spot', interval = '15min';
  String? selectedBacktestId, recoveryError;
  String? _ownerKey;
  int tab = 0, _epoch = 0;
  bool active = false,
      _disposed = false,
      recoveryReady = false,
      submitting = false;
  bool get readable => !_disposed && active && repository.authorityCurrent();
  bool get unresolved => intents.any((row) => row['state'] != 'accepted');
  bool canSubmit(String action) =>
      readable &&
      recoveryReady &&
      recoveryError == null &&
      !submitting &&
      !unresolved &&
      intents.length < 8 &&
      repository.access.owner!.canManage &&
      repository.access.operations.contains(marketWriteSpecs[action]!.$1);
  MarketJson? data(String kind) => readable ? documents[kind]?.data : null;
  void _emit() {
    if (!_disposed) notifyListeners();
  }

  void _cancel() {
    _epoch++;
    for (final token in _reads.values) {
      token.cancel('Market view changed.');
    }
    _reads.clear();
    loading.clear();
  }

  void _accessChanged() {
    _cancel();
    documents.clear();
    failures.clear();
    recoveryReady = false;
    final key = repository.access.owner?.key;
    if (key != _ownerKey || repository.access.closed) {
      intents.clear();
      backtestDrafts.clear();
      startDate = '2000-01-01';
      endDate = DateTime.now().toUtc().toIso8601String().substring(0, 10);
      recoveryError = null;
      submitting = false;
      selectedBacktestId = null;
    }
    _ownerKey = key;
    _emit();
    if (readable) unawaited(initialize());
  }

  void setActive(bool value, {bool notify = true}) {
    if (_disposed || active == value) return;
    active = value;
    if (!value) {
      _cancel();
      documents.clear();
    } else {
      unawaited(initialize());
    }
    if (notify) _emit();
  }

  bool _current(int epoch, String? owner) =>
      readable && epoch == _epoch && owner == repository.access.owner?.key;
  Future<void> initialize() async {
    if (!readable) return;
    final epoch = _epoch, owner = repository.access.owner!;
    recoveryReady = false;
    recoveryError = null;
    _emit();
    try {
      final stored = await recovery.read(owner, 'workspace');
      if (!_current(epoch, owner.key)) return;
      if (stored != null) {
        marketKeys(stored, 'schemaVersion intents');
        marketRequire(stored['schemaVersion'] == 1);
        final rows = marketRows(stored['intents'], 8);
        for (final row in rows) {
          marketKeys(row, 'action key submitted createdAt state receipt job');
          marketRequire(
            marketWriteSpecs.containsKey(row['action']) &&
                ['submitted', 'unknown', 'accepted'].contains(row['state']),
          );
          marketText(row['key'], 160);
          marketMap(row['submitted']);
          marketDate(row['createdAt']);
          if (row['state'] == 'accepted') marketRequire(row['receipt'] is Map);
        }
        intents
          ..clear()
          ..addAll(
            rows.map(
              (row) => marketFreeze({
                ...row,
                if (row['state'] != 'accepted') 'state': 'unknown',
              }),
            ),
          );
      }
      recoveryReady = true;
    } catch (_) {
      if (_current(epoch, owner.key)) recoveryError = 'Protected intent recovery is unavailable. Reads remain available; new actions are held.';
    }
    if (!_current(epoch, owner.key)) return;
    _emit();
    await refresh('overview');
    if (_current(epoch, owner.key)) await refresh('snapshots');
    if (_current(epoch, owner.key) && tab != 0) await refreshTab();
  }

  MarketJson _query(String kind) {
    if (kind == 'overview') return {};
    if (kind == 'events') return {'limit': 100};
    if (kind == 'calendar') return {'days': 14};
    if (kind == 'features') {
      return {'snapshotId': data('snapshot')?['snapshotId']};
    }
    if (kind == 'bars') {
      return {
        'instrumentId': instrumentId,
        'interval': interval,
        'outputSize': 480,
      };
    }
    if (kind == 'snapshots') {
      return {'instrumentId': instrumentId, 'interval': interval, 'limit': 20};
    }
    if (kind == 'analysis') {
      return {
        'instrumentId': instrumentId,
        'interval': interval,
        'limit': 10,
        'view': 'metadata',
      };
    }
    if (kind == 'baselines') {
      return {'instrumentId': instrumentId, 'minimumSampleSize': 20};
    }
    return {
      'instrumentId': instrumentId,
      'limit': kind == 'journal'
          ? 40
          : kind == 'backtests'
          ? 20
          : 100,
    };
  }

  Future<void> refresh(String kind, {MarketJson? query}) async {
    if (!readable) return;
    final arguments = marketFreeze(query ?? _query(kind));
    if (kind == 'features' && arguments['snapshotId'] == null) return;
    final spec = marketReadSpecs[kind]!;
    if (!repository.access.operations.contains(spec.operation)) {
      failures[kind] =
          'This read is not published for the current native contract.';
      _emit();
      return;
    }
    _reads.remove(kind)?.cancel('A newer exact read started.');
    final cancel = CancelToken(), epoch = _epoch, owner = _ownerKey;
    _reads[kind] = cancel;
    loading.add(kind);
    failures.remove(kind);
    documents.remove(kind);
    _emit();
    try {
      final result = await repository.read(kind, arguments, cancel);
      if (!_current(epoch, owner) || !identical(_reads[kind], cancel)) return;
      documents[kind == 'bars' ? 'snapshot' : kind] = result;
    } catch (_) {
      if (_current(epoch, owner) && !cancel.isCancelled) failures[kind] = 'This market source is unavailable or its exact evidence could not be verified. Refresh reads to inspect again.';
    } finally {
      if (_current(epoch, owner) && identical(_reads[kind], cancel)) {
        _reads.remove(kind);
        loading.remove(kind);
        _emit();
      }
    }
  }

  Future<void> selectMarket(String instrument, String nextInterval) async {
    if (instrument == instrumentId && nextInterval == interval) return;
    _cancel();
    instrumentId = instrument;
    interval = nextInterval;
    selectedBacktestId = null;
    documents.removeWhere((key, _) => key != 'overview');
    failures.clear();
    _emit();
    await refresh('snapshots');
    await refreshTab();
  }

  Future<void> selectSnapshot(MarketJson metadata) async {
    marketRequire(
      metadata['instrumentId'] == instrumentId &&
          metadata['interval'] == interval,
    );
    documents.remove('features');
    documents.remove('snapshot');
    _emit();
    await refresh(
      'snapshot',
      query: {
        'snapshotId': metadata['snapshotId'],
        'instrumentId': instrumentId,
        'interval': interval,
      },
    );
    if (tab == 2) await refresh('features');
  }

  Future<void> selectTab(int value) async {
    tab = value;
    _emit();
    await refreshTab();
  }

  Future<void> refreshTab() async {
    if (!readable) return;
    for (final kind in switch (tab) {
      1 => ['events', 'replays', 'baselines'],
      2 => ['features', 'analysis'],
      3 => ['backtests'],
      4 => ['journal'],
      _ => ['snapshots'],
    }) {
      await refresh(kind);
    }
  }

  Future<void> providerRefresh() async {
    documents.remove('features');
    await refresh('bars');
    if (data('snapshot') != null && tab == 2) await refresh('features');
  }

  Future<void> _persist(MarketsOwner owner, int epoch) => recovery.write(
    owner,
    'workspace',
    {'schemaVersion': 1, 'intents': intents},
    isCurrent: () => _current(epoch, owner.key),
  );
  Future<void> submit(String action, MarketJson body) async {
    if (!canSubmit(action)) return;
    final epoch = _epoch, owner = repository.access.owner!;
    final bytes = List<int>.generate(24, (_) => Random.secure().nextInt(256)),
        key =
            'market-${bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
    final intent = marketFreeze({
      'action': action,
      'key': key,
      'submitted': body,
      'createdAt': DateTime.now().toUtc().toIso8601String(),
      'state': 'submitted',
      'receipt': null,
      'job': null,
    });
    intents.add(intent);
    submitting = true;
    _emit();
    try {
      // A durable fixed decision precedes dispatch. Recovery never queues it.
      await _persist(owner, epoch);
      if (!_current(epoch, owner.key)) return;
      final response = await repository.submit(
        action,
        marketMap(intent['submitted']),
        key,
      );
      if (!_current(epoch, owner.key)) return;
      final index = intents.indexWhere((row) => row['key'] == key);
      if (index < 0) return;
      intents[index] = marketFreeze({
        ...intent,
        'state': 'accepted',
        'receipt': response,
        'job': response['job'],
      });
      await _persist(owner, epoch);
      // Acceptance is retained even when this independent read fails.
      await refreshTab();
    } catch (_) {
      if (_current(epoch, owner.key)) {
        final index = intents.indexWhere((row) => row['key'] == key);
        if (index >= 0 && intents[index]['state'] != 'accepted') {
          intents[index] = marketFreeze({...intent, 'state': 'unknown'});
        }
        try {
          await _persist(owner, epoch);
        } catch (_) {
          recoveryError = 'Protected intent persistence needs reconciliation. New actions remain held.';
        }
      }
    } finally {
      if (_current(epoch, owner.key)) {
        submitting = false;
        _emit();
      }
    }
  }

  Future<void> inspectJob(MarketJson intent) async {
    if (!readable || intent['job'] == null) return;
    final epoch = _epoch,
        owner = _ownerKey,
        initial = marketMap(intent['job']),
        token = CancelToken(),
        key = marketText(intent['key']);
    _reads['job:$key'] = token;
    try {
      final job = await repository.job(
        marketText(initial['id']),
        marketText(initial['type']),
        marketMap(intent['submitted']),
        token,
      );
      if (!_current(epoch, owner)) return;
      final index = intents.indexWhere((row) => row['key'] == key);
      if (index >= 0) {
        intents[index] = marketFreeze({...intents[index], 'job': job});
        await _persist(repository.access.owner!, epoch);
      }
    } catch (_) {
      if (_current(epoch, owner)) failures['job:$key'] = 'Job status could not refresh. The accepted submission remains recorded.';
    } finally {
      if (_current(epoch, owner)) {
        _reads.remove('job:$key');
        _emit();
      }
    }
  }

  Future<void> dismissAccepted(String key) async {
    if (!readable || !recoveryReady || recoveryError != null) return;
    final epoch = _epoch, owner = repository.access.owner!;
    intents.removeWhere(
      (row) =>
          row['key'] == key &&
          row['state'] == 'accepted' &&
          (row['job'] == null ||
              [
                'completed',
                'failed',
                'canceled',
              ].contains(marketMap(row['job'])['status'])),
    );
    try {
      await _persist(owner, epoch);
    } catch (_) {
      recoveryError =
          'Receipt storage changed. Reload recovery before another action.';
      recoveryReady = false;
    }
    _emit();
  }

  void invalidateAuthority({bool notify = true}) {
    _cancel();
    documents.clear();
    failures.clear();
    recoveryReady = false;
    if (notify) _emit();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _cancel();
    documents.clear();
    intents.clear();
    repository.access.removeListener(_accessChanged);
    super.dispose();
  }
}
