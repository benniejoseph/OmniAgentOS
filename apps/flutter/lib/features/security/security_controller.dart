import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import 'security_contracts.dart';
import 'security_repository.dart';

enum SecuritySection {
  access('Your access'),
  retention('Your data'),
  audits('Recent decisions'),
  isolation('Technical checks');

  const SecuritySection(this.label);
  final String label;
}

enum SecuritySource { context, audits, isolation, retention }

enum SecurityLoadState { idle, loading, ready, restricted, failed }

class SecurityLane<T> {
  SecurityLoadState state = SecurityLoadState.idle;
  T? data;
  DateTime? receivedAt;
  String? error;
  void clear() {
    state = SecurityLoadState.idle;
    data = null;
    receivedAt = null;
    error = null;
  }
}

class SecurityController extends ChangeNotifier {
  SecurityController(this.repository);
  final SecurityRepository repository;
  final context = SecurityLane<SecurityAccessContext>();
  final audits = SecurityLane<SecurityAudits>();
  final isolation = SecurityLane<SecurityIsolation>();
  final retention = SecurityLane<SecurityRetention>();
  SecuritySection section = SecuritySection.access;
  String? selectedId;
  bool _disposed = false, _invalidated = false, _visible = true;
  bool authorizationDenied = false, privateDenied = false;
  int _generation = 0;
  final Map<SecuritySource, CancelToken> _tokens = {};
  final Map<SecuritySource, Future<void>> _pending = {};
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
  SecuritySource get selectedSource => switch (section) {
    SecuritySection.access => SecuritySource.context,
    SecuritySection.audits => SecuritySource.audits,
    SecuritySection.isolation => SecuritySource.isolation,
    SecuritySection.retention => SecuritySource.retention,
  };
  SecurityLane<Object> lane(SecuritySource source) => switch (source) {
    SecuritySource.context => context,
    SecuritySource.audits => audits,
    SecuritySource.isolation => isolation,
    SecuritySource.retention => retention,
  };
  void _publish() {
    if (!_disposed) notifyListeners();
  }

  void selectSection(SecuritySection value) {
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
      token.cancel('Security is no longer visible to this account.');
    }
    _tokens.clear();
    _pending.clear();
    for (final source in SecuritySource.values) {
      lane(source).clear();
    }
    selectedId = null;
  }

  void invalidate({bool notify = true}) {
    _invalidated = true;
    _clear();
    if (notify) _publish();
  }

  void invalidateAndNotifyLater() {
    // Authority can be probed during build: clear now, repaint after it unwinds.
    invalidate(notify: false);
    Future<void>.microtask(_publish);
  }

  void setVisible(bool value) {
    if (_disposed || _invalidated || _visible == value) return;
    _visible = value;
    if (!value) _clear();
    _publish();
  }

  Future<void> refresh() async {
    await Future.wait(SecuritySource.values.map(refreshSource));
  }

  Future<void> refreshSource(SecuritySource source) {
    if (!available) return Future.value();
    final pending = _pending[source];
    if (pending != null) return pending;
    final token = _tokens[source] = CancelToken(), generation = _generation;
    final target = lane(source);
    target.clear();
    target.state = SecurityLoadState.loading;
    if (selectedSource == source) selectedId = null;
    final future = _load(source, token, generation);
    _pending[source] = future;
    _publish();
    return future;
  }

  bool _current(SecuritySource source, CancelToken token, int generation) =>
      available &&
      generation == _generation &&
      identical(_tokens[source], token) &&
      !token.isCancelled;
  void _restrictPrivate() {
    privateDenied = true;
    selectedId = null;
    for (final source in SecuritySource.values.where(
      (source) => source != SecuritySource.context,
    )) {
      _tokens.remove(source)?.cancel('Private Security access was refused.');
      _pending.remove(source);
      final target = lane(source);
      target.clear();
      target.state = SecurityLoadState.restricted;
      target.error = 'Audit, isolation and retention evidence require an administrator account.';
    }
    _publish();
  }

  Future<void> _load(
    SecuritySource source,
    CancelToken token,
    int generation,
  ) async {
    // A synchronous refusal must settle after its coalesced future is registered.
    await Future<void>.value();
    if (!_current(source, token, generation)) return;
    final target = lane(source);
    try {
      if (source != SecuritySource.context &&
          (privateDenied || !repository.canReadPrivate)) {
        target.state = SecurityLoadState.restricted;
        target.error = 'Audit, isolation and retention evidence require an administrator account.';
        return;
      }
      final Object result = switch (source) {
        SecuritySource.context => await repository.context(token),
        SecuritySource.audits => await repository.audits(token),
        SecuritySource.isolation => await repository.isolation(token),
        SecuritySource.retention => await repository.retention(token),
      };
      if (!_current(source, token, generation)) return;
      if (result is SecurityAccessContext) context.data = result;
      if (result is SecurityAudits) audits.data = result;
      if (result is SecurityIsolation) isolation.data = result;
      if (result is SecurityRetention) retention.data = result;
      target.state = SecurityLoadState.ready;
      target.receivedAt = DateTime.now();
    } catch (failure) {
      if (!_current(source, token, generation)) return;
      if (failure is SecurityIdentityMismatch ||
          failure is NativeAuthorityVerificationException ||
          (failure is ApiException && failure.statusCode == 401)) {
        _clear();
        authorizationDenied = true;
        _publish();
        return;
      }
      if (failure is ApiException && failure.statusCode == 403) {
        _restrictPrivate();
        if (source != SecuritySource.context) return;
      }
      target.data = null;
      target.receivedAt = null;
      target.state = SecurityLoadState.failed;
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
