import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SecureSessionStore {
  const SecureSessionStore(this._storage);
  static const _tokenKey = 'omniagent.session_token';
  final FlutterSecureStorage _storage;

  Future<String?> readToken() => _storage.read(key: _tokenKey);
  Future<void> writeToken(String token) =>
      _storage.write(key: _tokenKey, value: token);
  Future<void> clear() => _storage.delete(key: _tokenKey);
}

final secureSessionStoreProvider = Provider<SecureSessionStore>(
  (_) => const SecureSessionStore(FlutterSecureStorage()),
);
