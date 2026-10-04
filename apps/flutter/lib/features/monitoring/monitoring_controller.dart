import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'monitoring_contracts.dart';
import 'monitoring_repository.dart';

enum MonitoringSection {
  slo('SLO measurements'),
  incidents('Active incidents'),
  alerts('Alert deliveries'),
  timeline('Runtime timeline');

  const MonitoringSection(this.label);
  final String label;
}

enum MonitoringSource { health, slo, incidents, alerts, timeline }

enum MonitoringLoadState { idle, loading, ready, restricted, failed }

class MonitoringLane<T> {
  MonitoringLoadState state = MonitoringLoadState.idle;
  T? data;
  DateTime? receivedAt;
  String? error;
  void clear() {
    state = MonitoringLoadState.idle;
    data = null;
    receivedAt = null;
    error = null;
  }
}

class MonitoringController extends ChangeNotifier {
  MonitoringController(this.repository);
  final MonitoringRepository repository;
  final health = MonitoringLane<MonitoringHealth>();
  final slo = MonitoringLane<MonitoringSloSnapshot>();
  final incidents = MonitoringLane<MonitoringIncidents>();
  final alerts = MonitoringLane<MonitoringAlerts>();
  final timeline = MonitoringLane<MonitoringTimeline>();
  MonitoringSection section = MonitoringSection.slo;
  String? selectedId;
  bool _disposed = false, _invalidated = false, _visible = true;
  bool authorizationDenied = false, privateDenied = false;
  int _generation = 0;
  final Map<MonitoringSource, CancelToken> _tokens = {};
  final Map<MonitoringSource, Future<void>> _pending = {};

  bool get available =>
      !_disposed &&
      !_invalidated &&
      _visible &&
      !authorizationDenied &&
      repository.current &&
      !_disposed &&
      !_invalidated &&
      _visible &&
      !authorizationDenied;
  bool get loading => _pending.isNotEmpty;
  MonitoringSource get selectedSource => switch (section) {
    MonitoringSection.slo => MonitoringSource.slo,
    MonitoringSection.incidents => MonitoringSource.incidents,
    MonitoringSection.alerts => MonitoringSource.alerts,
    MonitoringSection.timeline => MonitoringSource.timeline,
  };
  MonitoringLane<Object> lane(MonitoringSource source) => switch (source) {
    MonitoringSource.health => health,
    MonitoringSource.slo => slo,
    MonitoringSource.incidents => incidents,
    MonitoringSource.alerts => alerts,
    MonitoringSource.timeline => timeline,
  };
  void _publish() {
    if (!_disposed) notifyListeners();
  }

  void selectSection(MonitoringSection value) {
    if (!available || value == section) return;
    section = value;
    selectedId = null;
    _publish();
  }

  void select(String? id) {
    if (!available) return;
    selectedId = id;
    _publish();
  }

  void _clear() {
    _generation++;
    for (final token in _tokens.values) {
      token.cancel('Monitoring is no longer visible to this account.');
    }
    _tokens.clear();
    _pending.clear();
    for (final source in MonitoringSource.values) {
      lane(source).clear();
    }
    selectedId = null;
  }

  void invalidate({bool notify = true}) {
    _invalidated = true;
    _clear();
    if (notify) _publish();
  }

  void setVisible(bool value) {
    if (_disposed || _invalidated || _visible == value) return;
    _visible = value;
    if (!value) _clear();
    _publish();
  }

  Future<void> refresh() async {
    await Future.wait(MonitoringSource.values.map(refreshSource));
  }

  Future<void> refreshSource(MonitoringSource source) {
    if (!available) return Future.value();
    final pending = _pending[source];
    if (pending != null) return pending;
    final token = _tokens[source] = CancelToken(), generation = _generation;
    final target = lane(source);
    target.clear();
    target.state = MonitoringLoadState.loading;
    if (selectedSource == source) selectedId = null;
    final future = _load(source, token, generation);
    _pending[source] = future;
    _publish();
    return future;
  }

  bool _current(MonitoringSource source, CancelToken token, int generation) =>
      available &&
      generation == _generation &&
      identical(_tokens[source], token) &&
      !token.isCancelled;
  void _restrictPrivate() {
    privateDenied = true;
    selectedId = null;
    for (final source in MonitoringSource.values.where(
      (source) => source != MonitoringSource.health,
    )) {
      _tokens.remove(source)?.cancel('Private monitoring access was refused.');
      _pending.remove(source);
      final target = lane(source);
      target.clear();
      target.state = MonitoringLoadState.restricted;
      target.error = 'Private monitoring requires an administrator account.';
    }
    _publish();
  }

  Future<void> _load(
    MonitoringSource source,
    CancelToken token,
    int generation,
  ) async {
    // Register the pending future before a synchronous denial can complete.
    await Future<void>.value();
    if (!_current(source, token, generation)) return;
    final target = lane(source);
    try {
      if (source != MonitoringSource.health &&
          (privateDenied || !repository.canReadPrivate)) {
        target.state = MonitoringLoadState.restricted;
        target.error = 'Private monitoring requires an administrator account.';
        return;
      }
      final Object result = switch (source) {
        MonitoringSource.health => await repository.health(token),
        MonitoringSource.slo => await repository.slo(token),
        MonitoringSource.incidents => await repository.incidents(token),
        MonitoringSource.alerts => await repository.alerts(token),
        MonitoringSource.timeline => await repository.timeline(token),
      };
      if (!_current(source, token, generation)) return;
      if (result is MonitoringHealth) health.data = result;
      if (result is MonitoringSloSnapshot) slo.data = result;
      if (result is MonitoringIncidents) incidents.data = result;
      if (result is MonitoringAlerts) alerts.data = result;
      if (result is MonitoringTimeline) timeline.data = result;
      target.state = MonitoringLoadState.ready;
      target.receivedAt = DateTime.now();
    } catch (failure) {
      if (!_current(source, token, generation)) return;
      if (failure is ApiException && failure.statusCode == 401) {
        _clear();
        authorizationDenied = true;
        _publish();
        return;
      }
      if (failure is ApiException && failure.statusCode == 403) {
        _restrictPrivate();
        if (source != MonitoringSource.health) return;
      }
      target.data = null;
      target.receivedAt = null;
      target.state = MonitoringLoadState.failed;
      target.error = failure is FormatException
          ? 'This source returned incomplete evidence. Retry its live read.'
          : 'This source is unavailable. Retry when the connection is available.';
    } finally {
      if (_current(source, token, generation)) {
        _tokens.remove(source);
        _pending.remove(source);
        _publish();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _clear();
    super.dispose();
  }
}
