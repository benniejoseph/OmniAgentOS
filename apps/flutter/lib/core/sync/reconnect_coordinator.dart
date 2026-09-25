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
  ReconnectCoordinator(
    this._checkConnectivity,
    this._connectivityChanges, {
    this.automaticRecoveryEnabled = true,
  });

  final Future<List<ConnectivityResult>> Function() _checkConnectivity;
  final Stream<List<ConnectivityResult>> _connectivityChanges;
  final bool automaticRecoveryEnabled;
  final Map<String, _RegisteredReconciliation> _hooks = {};
  final Set<ReconnectReason> _pendingReasons = {};
  StreamSubscription<List<ConnectivityResult>>? _subscription;
  Future<void>? _work;
  bool _started = false;
  bool _disposed = false;
  bool _isOnline = false;
  bool _suspended = false;
  String? _activeFreshnessScope;

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
    String? freshnessScope,
    ReconciliationPredicate? shouldRun,
  }) {
    if (key.trim().isEmpty || key.length > 120) {
      throw ArgumentError.value(key, 'key', 'Invalid reconciliation key.');
    }
    final registration = _RegisteredReconciliation(
      hook: hook,
      priority: priority,
      classification: classification,
      freshnessScope: _normalizeScope(freshnessScope),
      shouldRun: shouldRun,
    );
    _hooks[key] = registration;
    return () {
      if (identical(_hooks[key], registration)) _hooks.remove(key);
    };
  }

  /// Selects the mounted page whose server projection may be refreshed after
  /// a real network recovery. Durable outbox work is intentionally unscoped.
  void setActiveFreshnessScope(String? route) {
    _activeFreshnessScope = _normalizeScope(route);
  }

  Future<void> reconcile(ReconnectReason reason) {
    if (_disposed) return Future<void>.value();
    _pendingReasons.add(reason);
    return _drainIfAvailable();
  }

  /// Prevents protected feature work from reaching credential-backed stores.
  /// Connectivity observations still update while suspended and their recovery
  /// reason remains queued for the next successful unlock.
  void suspend() {
    if (_disposed) return;
    _suspended = true;
  }

  Future<void> resume({ReconnectReason? reason}) {
    if (_disposed) return Future<void>.value();
    _suspended = false;
    if (reason != null) _pendingReasons.add(reason);
    return _drainIfAvailable();
  }

  Future<void> _drainIfAvailable() {
    if (_disposed || _suspended || !_isOnline || _pendingReasons.isEmpty) {
      return Future<void>.value();
    }
    final current = _work;
    if (current != null) return current;
    final initialReason = _preferredReason(
      ReconnectReason.appResumed,
      _pendingReasons,
    );
    final created = _runReconciliation(initialReason);
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
    while (_pendingReasons.isNotEmpty &&
        _isOnline &&
        !_suspended &&
        !_disposed) {
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
        if (_disposed || !_isOnline || _suspended) break;
        if (!identical(_hooks[entry.key], entry.value)) continue;
        if (completed.contains(entry.value) ||
            !classifications.contains(entry.value.classification)) {
          continue;
        }
        if (entry.value.classification == ReconciliationClass.freshness &&
            entry.value.freshnessScope != null &&
            entry.value.freshnessScope != _activeFreshnessScope) {
          continue;
        }
        final shouldRun = entry.value.shouldRun;
        if (shouldRun != null) {
          try {
            if (!shouldRun(effectiveReason)) continue;
          } catch (error) {
            completed.add(entry.value);
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
        completed.add(entry.value);
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
      if (_suspended) {
        _pendingReasons.addAll(reasons);
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
    if (!_suspended && _pendingReasons.isNotEmpty && _isOnline) {
      unawaited(_drainIfAvailable());
    }
  }

  static Iterable<ReconciliationClass> _classesForReason(
    ReconnectReason reason,
  ) => switch (reason) {
    ReconnectReason.appResumed => const [ReconciliationClass.durable],
    ReconnectReason.networkRestored ||
    ReconnectReason.manual => ReconciliationClass.values,
  };

  static String? _normalizeScope(String? route) {
    final value = route?.trim();
    if (value == null || value.isEmpty) return null;
    final path = Uri.tryParse(value)?.path ?? value;
    final segments = path.split('/').where((part) => part.isNotEmpty);
    final first = segments.firstOrNull;
    final scope = first == null ? '/' : '/$first';
    return switch (scope) {
      '/quick-entry' || '/ambient-voice' => '/talk',
      '/missions' => '/projects',
      '/workflows' || '/integrations' || '/tools' => '/automation',
      _ => scope,
    };
  }

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
    if (reconcile && !wasOnline && automaticRecoveryEnabled) {
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
    required this.freshnessScope,
    required this.shouldRun,
  });

  final ReconciliationHook hook;
  final int priority;
  final ReconciliationClass classification;
  final String? freshnessScope;
  final ReconciliationPredicate? shouldRun;
}

/// Secondary macOS windows run in independent Flutter engines. Only the
/// primary runtime may drain shared durable work or react globally to a network
/// restoration; auxiliary windows retain their mounted view state.
final primaryNativeRuntimeProvider = Provider<bool>((_) => true);

final reconnectCoordinatorProvider = Provider<ReconnectCoordinator>((ref) {
  final connectivity = Connectivity();
  final coordinator = ReconnectCoordinator(
    connectivity.checkConnectivity,
    connectivity.onConnectivityChanged,
    automaticRecoveryEnabled: ref.watch(primaryNativeRuntimeProvider),
  );
  unawaited(coordinator.start());
  ref.onDispose(coordinator.dispose);
  return coordinator;
});
