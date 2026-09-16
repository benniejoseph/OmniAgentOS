import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

enum ReconnectPhase { checking, online, offline, reconciling, degraded }

enum ReconnectReason { networkRestored, appResumed, manual }

typedef ReconciliationHook = Future<void> Function();

class ReconnectCoordinator extends ChangeNotifier {
  ReconnectCoordinator(this._checkConnectivity, this._connectivityChanges);

  final Future<List<ConnectivityResult>> Function() _checkConnectivity;
  final Stream<List<ConnectivityResult>> _connectivityChanges;
  final Map<String, _RegisteredReconciliation> _hooks = {};
  StreamSubscription<List<ConnectivityResult>>? _subscription;
  Future<void>? _work;
  bool _rerunRequested = false;
  bool _started = false;
  bool _disposed = false;
  bool _isOnline = false;

  ReconnectPhase phase = ReconnectPhase.checking;
  DateTime? lastReconciledAt;
  ReconnectReason? lastReason;
  Map<String, Object> failures = const {};

  bool get isOnline => _isOnline;
  bool get isReconciling => phase == ReconnectPhase.reconciling;

  Future<void> start() async {
    if (_started || _disposed) return;
    _started = true;
    try {
      _applyConnectivity(await _checkConnectivity(), reconcile: false);
    } catch (_) {
      _setPhase(ReconnectPhase.degraded);
    }
    if (_disposed) return;
    _subscription = _connectivityChanges.listen(
      (states) => _applyConnectivity(states, reconcile: true),
      onError: (_) => _setPhase(ReconnectPhase.degraded),
    );
  }

  VoidCallback register(
    String key,
    ReconciliationHook hook, {
    int priority = 10,
  }) {
    if (key.trim().isEmpty || key.length > 120) {
      throw ArgumentError.value(key, 'key', 'Invalid reconciliation key.');
    }
    final registration = _RegisteredReconciliation(
      hook: hook,
      priority: priority,
    );
    _hooks[key] = registration;
    return () {
      if (identical(_hooks[key], registration)) _hooks.remove(key);
    };
  }

  Future<void> reconcile(ReconnectReason reason) {
    if (_disposed || !_isOnline) return Future<void>.value();
    final current = _work;
    if (current != null) {
      _rerunRequested = true;
      return current;
    }
    final created = _runReconciliation(reason);
    _work = created;
    return created;
  }

  Future<void> _runReconciliation(ReconnectReason reason) async {
    do {
      _rerunRequested = false;
      lastReason = reason;
      failures = const {};
      _setPhase(ReconnectPhase.reconciling);
      final failuresByKey = <String, Object>{};
      final entries = _hooks.entries.toList()
        ..sort((left, right) {
          final priority = left.value.priority.compareTo(right.value.priority);
          return priority != 0 ? priority : left.key.compareTo(right.key);
        });
      for (final entry in entries) {
        if (_disposed || !_isOnline) break;
        if (!identical(_hooks[entry.key], entry.value)) continue;
        try {
          await entry.value.hook();
        } catch (error) {
          failuresByKey[entry.key] = error;
        }
      }
      if (_disposed) return;
      failures = Map.unmodifiable(failuresByKey);
      if (_isOnline) {
        lastReconciledAt = DateTime.now();
        _setPhase(
          failuresByKey.isEmpty
              ? ReconnectPhase.online
              : ReconnectPhase.degraded,
        );
      } else {
        _setPhase(ReconnectPhase.offline);
      }
    } while (_rerunRequested && _isOnline && !_disposed);
    _work = null;
  }

  void _applyConnectivity(
    List<ConnectivityResult> states, {
    required bool reconcile,
  }) {
    if (_disposed) return;
    final wasOnline = _isOnline;
    _isOnline = states.any((state) => state != ConnectivityResult.none);
    if (!_isOnline) {
      _setPhase(ReconnectPhase.offline);
      return;
    }
    if (!isReconciling) _setPhase(ReconnectPhase.online);
    if (reconcile && !wasOnline) {
      unawaited(reconcileNowAfterNetworkRestore());
    }
  }

  Future<void> reconcileNowAfterNetworkRestore() =>
      reconcile(ReconnectReason.networkRestored);

  void _setPhase(ReconnectPhase value) {
    if (_disposed || phase == value) return;
    phase = value;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_subscription?.cancel());
    _hooks.clear();
    super.dispose();
  }
}

class _RegisteredReconciliation {
  const _RegisteredReconciliation({required this.hook, required this.priority});

  final ReconciliationHook hook;
  final int priority;
}

final reconnectCoordinatorProvider = Provider<ReconnectCoordinator>((ref) {
  final connectivity = Connectivity();
  final coordinator = ReconnectCoordinator(
    connectivity.checkConnectivity,
    connectivity.onConnectivityChanged,
  );
  unawaited(coordinator.start());
  ref.onDispose(coordinator.dispose);
  return coordinator;
});
