import 'dart:convert';
import 'dart:math';

import 'package:dio/dio.dart';

import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import 'watch_models.dart';

class WatchRepository {
  WatchRepository(this.access);
  final NativeWorkspaceAccess access;
  final _reads = <CancelToken>{};
  bool _disposed = false;
  ({String path, WatchJson body, String key})? _pending;
  bool get current => !_disposed && access.current;
  bool get hasPending => _pending != null;
  bool get canManage => current && access.canManage;
  void requireCurrent() {
    if (!current) {
      throw const ApiException('Your workspace changed. Reopen Watches.');
    }
  }

  void dispose() {
    _disposed = true;
    for (final cancel in _reads) {
      cancel.cancel('Watch workspace closed');
    }
    _reads.clear();
  }

  Future<WatchJson> _read(String path, {bool envelope = true}) async {
    requireCurrent();
    final cancel = CancelToken();
    _reads.add(cancel);
    try {
      final value = await access.api.getJsonAuthorized(
        path,
        authority: access.authority,
        cancelToken: cancel,
      );
      requireCurrent();
      if (envelope) _envelope(value);
      return value;
    } finally {
      _reads.remove(cancel);
    }
  }

  Future<({List<AvailabilityWatch> watches, bool hasMore})> list() async {
    final value = await _read(NativePaths.availabilityWatchesList(limit: 40));
    final records = value['watches'];
    if (records is! List || records.length > 100 || value['hasMore'] is! bool) {
      throw const FormatException('The watch list is invalid.');
    }
    return (
      watches: records.map(AvailabilityWatch.fromJson).toList(growable: false),
      hasMore: value['hasMore'] as bool,
    );
  }

  Future<({AvailabilityWatch watch, List<WatchJson> checks, bool hasMore})> get(
    String id,
  ) async {
    if (!watchIdPattern.hasMatch(id)) {
      throw const FormatException('This watch link is invalid.');
    }
    final value = await _read(NativePaths.availabilityWatchesGet(id));
    final watch = AvailabilityWatch.fromJson(value['watch']);
    final checks = value['checks'];
    if (watch.id != id ||
        checks is! List ||
        checks.length > 100 ||
        value['hasMore'] is! bool) {
      throw const FormatException('The watch detail is invalid.');
    }
    return (
      watch: watch,
      checks: checks.map(watchCheck).toList(growable: false),
      hasMore: value['hasMore'] as bool,
    );
  }

  Future<WatchJson> readiness(String id) async {
    if (!watchIdPattern.hasMatch(id)) {
      throw const FormatException('This watch link is invalid.');
    }
    final value = await _read(
      NativePaths.availabilityWatchesReadiness(id),
      envelope: false,
    );
    if (value['schemaVersion'] != 1 ||
        value['notificationsEnabled'] is! bool ||
        !const {'scheduled', 'queued', 'stopped'}.contains(value['checking'])) {
      throw const FormatException('Alert readiness is invalid.');
    }
    for (final key in [
      'sourceUrl',
      'method',
      'schedule',
      'alertPolicy',
      'inbox',
    ]) {
      watchText(value, key);
    }
    watchPublicUrl(value['sourceUrl'] as String);
    for (final key in ['android', 'browser']) {
      final channel = watchMap(value[key]);
      watchCount(channel, 'eligible');
      if (channel['configured'] is! bool) {
        throw const FormatException('Alert readiness is invalid.');
      }
    }
    for (final key in ['queued', 'accepted', 'received', 'opened', 'failed']) {
      watchCount(watchMap(value['browser']), key);
    }
    return value;
  }

  Future<AvailabilityWatch> create(WatchJson body) =>
      _begin(NativePaths.availabilityWatchesCreate, body);
  Future<AvailabilityWatch> stop(AvailabilityWatch watch) => _begin(
    NativePaths.availabilityWatchesStop(watch.id),
    {'expectedRevision': watch.revision},
  );
  Future<AvailabilityWatch> _begin(String path, WatchJson body) {
    requireCurrent();
    if (!canManage || _pending != null) {
      throw const ApiException(
        'Resolve the pending request before starting another.',
      );
    }
    _pending = (
      path: path,
      body: watchMap(jsonDecode(jsonEncode(body))),
      key:
          'watch-${List.generate(24, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}',
    );
    return retry();
  }

  Future<AvailabilityWatch> retry() async {
    requireCurrent();
    final pending = _pending;
    if (!canManage || pending == null) {
      throw const ApiException('There is no pending watch request.');
    }
    final WatchJson value;
    try {
      value = await access.api.postJsonAuthorized(
        pending.path,
        authority: access.authority,
        data: pending.body,
        headers: {'idempotency-key': pending.key},
      );
    } on ApiException catch (error) {
      requireCurrent();
      final evidence = error.responseData;
      // These endpoint refusals occur before a write or roll back the owner
      // transaction. Replayed accepted requests are resolved before them.
      // Unknown/network outcomes keep the exact body and key for recovery.
      if (evidence != null &&
          evidence.length == 2 &&
          evidence['error'] is String &&
          ((error.statusCode == 400 &&
                  evidence['code'] == 'availability_watch_invalid') ||
              (error.statusCode == 409 &&
                  const {
                    'availability_watch_changed',
                    'availability_watch_limit',
                  }.contains(evidence['code'])))) {
        _pending = null;
      }
      rethrow;
    }
    requireCurrent();
    _envelope(value);
    final watch = AvailabilityWatch.fromJson(value['watch']);
    if (pending.path != NativePaths.availabilityWatchesCreate &&
        pending.path != NativePaths.availabilityWatchesStop(watch.id)) {
      throw const FormatException(
        'The saved watch does not match this request.',
      );
    }
    _pending = null;
    return watch;
  }

  void _envelope(WatchJson value) {
    if (value['schemaVersion'] != 1 || value['contract'] != watchContract) {
      throw const FormatException('This app cannot read the watch response.');
    }
  }
}
