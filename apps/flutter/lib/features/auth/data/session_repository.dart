import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../../core/storage/secure_session_store.dart';
import '../domain/app_session.dart';

class SessionRepository {
  const SessionRepository(this._api, this._store);
  final ApiClient _api;
  final SecureSessionStore _store;

  Future<AppSession?> restore() async {
    if (await _store.readToken() == null) return null;
    return AppSession.fromJson(await _api.getJson('/api/mobile/session'));
  }

  Future<AppSession> signIn({
    required String email,
    required String password,
  }) async {
    final json = await _api.postJson(
      '/api/mobile/auth/login',
      data: {'email': email.trim(), 'password': password},
    );
    final token = (json['token'] ?? json['accessToken'])?.toString();
    if (token == null || token.isEmpty) {
      throw StateError('The service did not issue a session token.');
    }
    await _store.writeToken(token);
    return AppSession.fromJson(json);
  }

  Future<void> signOut() async {
    try {
      await _api.postJson('/api/mobile/auth/logout');
    } finally {
      await _store.clear();
    }
  }
}

final sessionRepositoryProvider = Provider<SessionRepository>(
  (ref) => SessionRepository(
    ref.watch(apiClientProvider),
    ref.watch(secureSessionStoreProvider),
  ),
);
