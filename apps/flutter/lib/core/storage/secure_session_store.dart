import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SecureSessionStore {
  const SecureSessionStore(this._storage);
  static const _tokenKey = 'asael.session_token';
  static const _legacyTokenKey = 'omniagent.session_token';
  final FlutterSecureStorage _storage;

  Future<String?> readToken() async {
    final token = await _storage.read(key: _tokenKey);
    if (token != null) return token;
    final legacyToken = await _storage.read(key: _legacyTokenKey);
    if (legacyToken == null) return null;
    await _storage.write(key: _tokenKey, value: legacyToken);
    await _storage.delete(key: _legacyTokenKey);
    return legacyToken;
  }

  Future<void> writeToken(String token) async {
    await _storage.write(key: _tokenKey, value: token);
    await _storage.delete(key: _legacyTokenKey);
  }

  Future<void> clear() async {
    await _storage.delete(key: _tokenKey);
    await _storage.delete(key: _legacyTokenKey);
  }
}

final secureSessionStoreProvider = Provider<SecureSessionStore>(
  (_) => const SecureSessionStore(FlutterSecureStorage()),
);
