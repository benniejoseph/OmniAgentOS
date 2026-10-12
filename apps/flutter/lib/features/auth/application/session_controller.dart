import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/session_repository.dart';
import '../domain/app_session.dart';
import 'biometric_session_lock_controller.dart';

class SessionController extends AsyncNotifier<AppSession?> {
  bool _showSignIn = false;

  /// A submitted sign-in stays on its form while loading or showing an error.
  /// Restoring an existing session still uses the protected bootstrap screen.
  bool get showSignIn => _showSignIn;

  @override
  Future<AppSession?> build() {
    final repository = ref.read(sessionRepositoryProvider);
    final ended = repository.sessionEnded.listen((_) => _showSignedOut());
    ref.onDispose(ended.cancel);
    return repository.restore();
  }

  /// Stops showing a session the service refused, whose credentials are
  /// already cleared, so the app does not stay signed in while every request
  /// fails. A sign-in or sign-out in progress sets the state itself.
  void _showSignedOut() {
    if (state.value == null) return;
    _showSignIn = false;
    ref.read(biometricSessionLockControllerProvider).resetAfterSessionCleared();
    state = const AsyncData(null);
  }

  Future<bool> signIn(String email, String password) async {
    _showSignIn = true;
    state = const AsyncLoading();
    final result = await AsyncValue.guard(
      () => ref
          .read(sessionRepositoryProvider)
          .signIn(email: email, password: password),
    );
    if (!result.hasError) _showSignIn = false;
    state = result;
    return !result.hasError;
  }

  Future<void> signOut() async {
    _showSignIn = false;
    state = const AsyncLoading();
    try {
      await ref.read(sessionRepositoryProvider).signOut();
    } finally {
      ref
          .read(biometricSessionLockControllerProvider)
          .resetAfterSessionCleared();
      state = const AsyncData(null);
    }
  }

  Future<void> retry() async {
    _showSignIn = false;
    state = const AsyncLoading();
    state = await AsyncValue.guard(
      () => ref.read(sessionRepositoryProvider).restore(),
    );
  }

  Future<void> migrateLegacyCredentials() async {
    _showSignIn = false;
    state = const AsyncLoading();
    state = await AsyncValue.guard(
      () => ref.read(sessionRepositoryProvider).migrateLegacyCredentials(),
    );
  }

  Future<void> lockForBiometrics() async {
    await ref.read(biometricSessionLockControllerProvider).lock();
  }
}

final sessionControllerProvider =
    AsyncNotifierProvider<SessionController, AppSession?>(
      SessionController.new,
    );

typedef SessionOwnerKey = ({String tenantId, String actorId});

final sessionOwnerKeyProvider = Provider<SessionOwnerKey?>((ref) {
  final state = ref.watch(sessionControllerProvider);
  if (state.isLoading || state.hasError) return null;
  final session = state.value;
  if (session == null) return null;
  return (tenantId: session.tenantId, actorId: session.actorId);
});
