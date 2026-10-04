import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'quality_contracts.dart';
import 'quality_repository.dart';

enum QualitySection {
  runs('Runs'),
  jobs('Jobs'),
  cases('Case catalog'),
  release('Release evidence');

  const QualitySection(this.label);
  final String label;
}

enum QualitySource { evaluations, release }

enum QualityLoadState { idle, loading, ready, restricted, failed }

class QualityLane<T> {
  QualityLoadState state = QualityLoadState.idle;
  T? data;
  DateTime? receivedAt;
  String? error;
  void clear() {
    state = QualityLoadState.idle;
    data = null;
    receivedAt = null;
    error = null;
  }
}

/// Scoped, memory-only evidence. A completed execution is never a pass verdict.
class QualityController extends ChangeNotifier {
  QualityController(this.repository);
  final QualityRepository repository;
  final evaluations = QualityLane<QualityEvaluationsSnapshot>();
  final release = QualityLane<QualityReleaseReport>();
  QualitySection section = QualitySection.runs;
  String? selectedId;
  bool _disposed = false, _invalidated = false, _visible = true;
  bool authorizationDenied = false;
  int _generation = 0;
  final Map<QualitySource, CancelToken> _tokens = {};
  final Map<QualitySource, Future<void>> _pending = {};

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

  QualityLane<Object> lane(QualitySource source) => switch (source) {
    QualitySource.evaluations => evaluations,
    QualitySource.release => release,
  };
  QualitySource get selectedSource => section == QualitySection.release
      ? QualitySource.release
      : QualitySource.evaluations;

  void _publish() {
    if (!_disposed) notifyListeners();
  }

  void selectSection(QualitySection value) {
    if (!available || section == value) return;
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
      token.cancel('Quality is no longer visible to this account.');
    }
    _tokens.clear();
    _pending.clear();
    evaluations.clear();
    release.clear();
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
    await Future.wait([
      refreshSource(QualitySource.evaluations),
      refreshSource(QualitySource.release),
    ]);
  }

  Future<void> refreshSource(QualitySource source) {
    if (!available) return Future.value();
    final current = _pending[source];
    if (current != null) return current;
    final token = _tokens[source] = CancelToken(), generation = _generation;
    final target = lane(source);
    target.clear();
    target.state = QualityLoadState.loading;
    if (selectedSource == source) selectedId = null;
    final future = _load(source, token, generation);
    _pending[source] = future;
    _publish();
    return future;
  }

  bool _current(QualitySource source, CancelToken token, int generation) =>
      available &&
      generation == _generation &&
      identical(_tokens[source], token) &&
      !token.isCancelled;

  Future<void> _load(
    QualitySource source,
    CancelToken token,
    int generation,
  ) async {
    // Register the coalesced future before even a synchronous refusal settles.
    await Future<void>.value();
    if (!_current(source, token, generation)) return;
    final target = lane(source);
    try {
      final Object result;
      if (source == QualitySource.release && !repository.canReadRelease) {
        // Keep operator evaluation reads independent of admin-only evidence.
        throw const ApiException('Restricted.', statusCode: 403);
      }
      result = source == QualitySource.evaluations
          ? await repository.evaluations(token)
          : await repository.release(token);
      if (!_current(source, token, generation)) return;
      if (result is QualityEvaluationsSnapshot) evaluations.data = result;
      if (result is QualityReleaseReport) release.data = result;
      target.state = QualityLoadState.ready;
      target.receivedAt = DateTime.now();
    } catch (failure) {
      if (!_current(source, token, generation)) return;
      if (failure is ApiException && failure.statusCode == 401) {
        _clear();
        authorizationDenied = true;
        _publish();
        return;
      }
      target.data = null;
      target.receivedAt = null;
      final denied = failure is ApiException && failure.statusCode == 403;
      target.state = denied
          ? QualityLoadState.restricted
          : QualityLoadState.failed;
      target.error = denied
          ? source == QualitySource.release
                ? 'Release evidence requires an administrator account.'
                : 'Evaluation access is restricted for this account.'
          : failure is FormatException
          ? 'This source returned incomplete evidence. Retry its live read.'
          : 'This source could not connect. Retry when the connection is available.';
    } finally {
      if (_current(source, token, generation)) {
        _pending.remove(source);
        _tokens.remove(source);
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
