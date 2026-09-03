import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/session_repository.dart';
import '../domain/app_session.dart';

class SessionController extends AsyncNotifier<AppSession?> {
  @override
  Future<AppSession?> build() => ref.read(sessionRepositoryProvider).restore();

  Future<bool> signIn(String email, String password) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(
      () => ref
          .read(sessionRepositoryProvider)
          .signIn(email: email, password: password),
    );
    return !state.hasError;
  }

  Future<void> signOut() async {
    state = const AsyncLoading();
    await ref.read(sessionRepositoryProvider).signOut();
    state = const AsyncData(null);
  }

  Future<void> retry() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(
      () => ref.read(sessionRepositoryProvider).restore(),
    );
  }
}

final sessionControllerProvider =
    AsyncNotifierProvider<SessionController, AppSession?>(
      SessionController.new,
    );
