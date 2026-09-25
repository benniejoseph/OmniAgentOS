import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../../core/auth/biometric_gate.dart';
import '../data/session_repository.dart';

enum BiometricSessionLockPhase { unlocked, locking, locked, unlocking }

enum BiometricSessionLockFailure {
  unavailable,
  notRecognized,
  protectedStorageUnavailable,
}

@immutable
class BiometricSessionLockState {
  const BiometricSessionLockState({
    this.phase = BiometricSessionLockPhase.unlocked,
    this.failure,
  });

  final BiometricSessionLockPhase phase;
  final BiometricSessionLockFailure? failure;

  bool get blocksInteraction => phase != BiometricSessionLockPhase.unlocked;
  bool get busy =>
      phase == BiometricSessionLockPhase.locking ||
      phase == BiometricSessionLockPhase.unlocking;
  bool get canUnlock => phase == BiometricSessionLockPhase.locked && !busy;

  String? get recoveryMessage => switch (failure) {
    BiometricSessionLockFailure.unavailable => 'Touch ID is not available. Check this Mac’s biometric settings and try again.',
    BiometricSessionLockFailure.notRecognized =>
      'Asael stayed locked because Touch ID was canceled or not recognized.',
    BiometricSessionLockFailure.protectedStorageUnavailable =>
      'Protected storage did not respond. Asael remains locked; try again.',
    null => null,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is BiometricSessionLockState &&
          phase == other.phase &&
          failure == other.failure;

  @override
  int get hashCode => Object.hash(phase, failure);
}

/// Keeps the authenticated workspace mounted while its protected credentials
/// are unavailable.
///
/// The app shell observes [state] and places an interaction-blocking privacy
/// surface over the existing router. Locking never replaces the canonical
/// `AppSession`, so returning to Asael does not recreate routes or
/// owner-scoped feature controllers. The secure store still drops all cached
/// credentials and encryption material until [unlock] completes successfully.
class BiometricSessionLockController extends ChangeNotifier {
  BiometricSessionLockController(this._sessions);

  final SessionRepository _sessions;

  BiometricSessionLockState _state = const BiometricSessionLockState();
  Future<void>? _transition;
  int _sessionGeneration = 0;

  BiometricSessionLockState get state => _state;

  /// Locks protected material when local biometric protection is enabled.
  ///
  /// Returns `true` only when the privacy surface must remain visible. With
  /// biometric protection disabled this is an intentional no-op.
  Future<bool> lock() {
    final generation = _sessionGeneration;
    return _enqueue(() => _lock(generation));
  }

  Future<bool> _lock(int generation) async {
    if (generation != _sessionGeneration) return false;
    if (_state.phase == BiometricSessionLockPhase.locked) return true;
    _setState(
      const BiometricSessionLockState(phase: BiometricSessionLockPhase.locking),
    );
    try {
      final enabled = await _sessions.lockBiometricRelease();
      if (generation != _sessionGeneration) return false;
      _setState(
        BiometricSessionLockState(
          phase: enabled
              ? BiometricSessionLockPhase.locked
              : BiometricSessionLockPhase.unlocked,
        ),
      );
      return enabled;
    } catch (_) {
      if (generation == _sessionGeneration) {
        // Fail closed. SessionRepository locks the in-memory credential
        // release before consulting protected settings, so a storage failure
        // cannot reveal a previously cached token behind an unlocked UI.
        _setState(
          const BiometricSessionLockState(
            phase: BiometricSessionLockPhase.locked,
            failure: BiometricSessionLockFailure.protectedStorageUnavailable,
          ),
        );
      }
      return generation == _sessionGeneration;
    }
  }

  /// Authenticates locally and releases protected material without restoring
  /// the server session or replacing the mounted router.
  Future<bool> unlock() {
    final generation = _sessionGeneration;
    return _enqueue(() => _unlock(generation));
  }

  Future<bool> _unlock(int generation) async {
    if (generation != _sessionGeneration) return false;
    if (_state.phase == BiometricSessionLockPhase.unlocked) return true;
    _setState(
      const BiometricSessionLockState(
        phase: BiometricSessionLockPhase.unlocking,
      ),
    );
    try {
      await _sessions.unlockBiometricRelease();
      if (generation != _sessionGeneration) return false;
      _setState(const BiometricSessionLockState());
      return true;
    } on BiometricGateException catch (error) {
      if (generation == _sessionGeneration) {
        _setState(
          BiometricSessionLockState(
            phase: BiometricSessionLockPhase.locked,
            failure: switch (error.failure) {
              BiometricGateFailure.unavailable =>
                BiometricSessionLockFailure.unavailable,
              BiometricGateFailure.notRecognized =>
                BiometricSessionLockFailure.notRecognized,
            },
          ),
        );
      }
      return false;
    } catch (_) {
      if (generation == _sessionGeneration) {
        _setState(
          const BiometricSessionLockState(
            phase: BiometricSessionLockPhase.locked,
            failure: BiometricSessionLockFailure.protectedStorageUnavailable,
          ),
        );
      }
      return false;
    }
  }

  /// Clears only the presentation state after authoritative session erasure.
  /// Credential deletion remains owned by [SessionRepository.signOut].
  void resetAfterSessionCleared() {
    _sessionGeneration += 1;
    _setState(const BiometricSessionLockState());
  }

  Future<bool> _enqueue(Future<bool> Function() operation) {
    final previous = _transition ?? Future<void>.value();
    final result = previous.then((_) => operation());
    late final Future<void> current;
    current = result.then<void>((_) {}).catchError((Object _) {});
    _transition = current;
    unawaited(
      current.whenComplete(() {
        if (identical(_transition, current)) _transition = null;
      }),
    );
    return result;
  }

  void _setState(BiometricSessionLockState next) {
    if (_state == next) return;
    _state = next;
    notifyListeners();
  }
}

final biometricSessionLockControllerProvider =
    ChangeNotifierProvider<BiometricSessionLockController>(
      (ref) =>
          BiometricSessionLockController(ref.watch(sessionRepositoryProvider)),
    );
