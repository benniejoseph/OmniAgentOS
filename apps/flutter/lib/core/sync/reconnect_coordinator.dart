import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

enum ReconnectPhase { checking, online, offline, reconciling, degraded }

enum ReconnectReason { networkRestored, appResumed, manual }

enum ReconciliationClass { durable, freshness }

typedef ReconciliationHook = Future<void> Function();
typedef ReconciliationPredicate = bool Function(ReconnectReason reason);

class ReconnectCoordinator extends ChangeNotifier {
  ReconnectCoordinator(this._checkConnectivity, this._connectivityChanges);

  final Future<List<ConnectivityResult>> Function() _checkConnectivity;
  final Stream<List<ConnectivityResult>> _connectivityChanges;
  final Map<String, _RegisteredReconciliation> _hooks = {};
  final Set<ReconnectReason> _pendingReasons = {};
  StreamSubscription<List<ConnectivityResult>>? _subscription;
  Future<void>? _work;
  bool _started = false;
  bool _disposed = false;
  bool _isOnline = false;

  ReconnectPhase phase = ReconnectPhase.checking;
  DateTime? lastReconciledAt;
  ReconnectReason? lastReason;
  ReconnectReason? activeReason;
  Map<String, Object> failures = const {};

  bool get isOnline => _isOnline;
  bool get isReconciling => phase == ReconnectPhase.reconciling;
  bool get shouldAnnounceRecovery =>
      isReconciling &&
      activeReason != null &&
      activeReason != ReconnectReason.appResumed;

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
    ReconciliationClass classification = ReconciliationClass.freshness,
    ReconciliationPredicate? shouldRun,
  }) {
    if (key.trim().isEmpty || key.length > 120) {
      throw ArgumentError.value(key, 'key', 'Invalid reconciliation key.');
    }
    final registration = _RegisteredReconciliation(
      hook: hook,
      priority: priority,
      classification: classification,
      shouldRun: shouldRun,
    );
    _hooks[key] = registration;
    return () {
      if (identical(_hooks[key], registration)) _hooks.remove(key);
    };
  }

  Future<void> reconcile(ReconnectReason reason) {
    if (_disposed || !_isOnline) return Future<void>.value();
    _pendingReasons.add(reason);
    final current = _work;
    if (current != null) return current;
    final created = _runReconciliation(reason);
    _work = created;
    return created;
  }

  Future<void> _runReconciliation(ReconnectReason initialReason) async {
    // Let reconcile() publish the shared future before evaluating an empty
    // batch. This keeps focus events with no eligible work coalescible too.
    await Future<void>.value();
    final completed = <_RegisteredReconciliation>{};
    final failuresByKey = <String, Object>{};
    var effectiveReason = initialReason;
    var performedWork = false;
    var announcedRecovery = false;
    while (_pendingReasons.isNotEmpty && _isOnline && !_disposed) {
      final reasons = Set<ReconnectReason>.from(_pendingReasons);
      _pendingReasons.removeAll(reasons);
      effectiveReason = _preferredReason(effectiveReason, reasons);
      final classifications = reasons.expand(_classesForReason).toSet();
      final entries = _hooks.entries.toList()
        ..sort((left, right) {
          final priority = left.value.priority.compareTo(right.value.priority);
          return priority != 0 ? priority : left.key.compareTo(right.key);
        });
      for (final entry in entries) {
        if (_disposed || !_isOnline) break;
        if (!identical(_hooks[entry.key], entry.value)) continue;
        if (completed.contains(entry.value) ||
            !classifications.contains(entry.value.classification)) {
          continue;
        }
        completed.add(entry.value);
        final shouldRun = entry.value.shouldRun;
        if (shouldRun != null) {
          try {
            if (!shouldRun(effectiveReason)) continue;
          } catch (error) {
            performedWork = true;
            activeReason = effectiveReason;
            if (effectiveReason != ReconnectReason.appResumed &&
                !announcedRecovery) {
              announcedRecovery = true;
              _setPhase(ReconnectPhase.reconciling);
            }
            failuresByKey[entry.key] = error;
            continue;
          }
        }
        if (!performedWork) {
          performedWork = true;
          failures = const {};
        }
        activeReason = effectiveReason;
        if (effectiveReason != ReconnectReason.appResumed &&
            !announcedRecovery) {
          announcedRecovery = true;
          _setPhase(ReconnectPhase.reconciling);
        }
        try {
          await entry.value.hook();
        } catch (error) {
          failuresByKey[entry.key] = error;
        }
      }
    }
    if (_disposed) return;
    if (performedWork) {
      lastReason = effectiveReason;
      failures = Map.unmodifiable(failuresByKey);
      if (_isOnline && announcedRecovery) {
        lastReconciledAt = DateTime.now();
        _setPhase(
          failuresByKey.isEmpty
              ? ReconnectPhase.online
              : ReconnectPhase.degraded,
        );
      } else if (!_isOnline) {
        _setPhase(ReconnectPhase.offline);
      } else {
        lastReconciledAt = DateTime.now();
      }
    }
    activeReason = null;
    _work = null;
  }

  static Iterable<ReconciliationClass> _classesForReason(
    ReconnectReason reason,
  ) => switch (reason) {
    ReconnectReason.appResumed => const [ReconciliationClass.durable],
    ReconnectReason.networkRestored ||
    ReconnectReason.manual => ReconciliationClass.values,
  };

  static ReconnectReason _preferredReason(
    ReconnectReason current,
    Set<ReconnectReason> pending,
  ) {
    if (pending.contains(ReconnectReason.networkRestored)) {
      return ReconnectReason.networkRestored;
    }
    if (current == ReconnectReason.networkRestored) return current;
    if (pending.contains(ReconnectReason.manual)) {
      return ReconnectReason.manual;
    }
    return current;
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
    _pendingReasons.clear();
    _hooks.clear();
    super.dispose();
  }
}

class _RegisteredReconciliation {
  const _RegisteredReconciliation({
    required this.hook,
    required this.priority,
    required this.classification,
    required this.shouldRun,
  });

  final ReconciliationHook hook;
  final int priority;
  final ReconciliationClass classification;
  final ReconciliationPredicate? shouldRun;
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
