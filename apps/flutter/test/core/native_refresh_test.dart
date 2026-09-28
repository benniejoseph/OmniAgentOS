import 'dart:async';
import 'dart:convert';

import 'package:asael/core/auth/biometric_gate.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

// Every SecureSessionStore below reads and writes the same mock Keychain, so a
// second store stands in for another engine, such as a second macOS window.
void main() {
  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    FlutterSecureStorage.setMockInitialValues({});
  });
  tearDown(() => debugDefaultTargetPlatformOverride = null);

  group('a request refused with a stale access token', () {
    test('uses the pair another engine stored instead of refreshing', () async {
      final service = _Service()..issue('access-2', 'refresh-2');
      final store = await _signedIn('access-1', 'refresh-1');
      await _otherEngineStores('access-2', 'refresh-2');

      expect(
        await _client(store, service).getJsonFresh(NativePaths.bootstrapGet),
        _bootstrap,
      );
      expect(service.refreshes, isEmpty);
      expect(await _stored(), ('access-2', 'refresh-2'));
    });

    test('refreshes when the stored token is the one refused', () async {
      final service = _Service()..issueRefreshOnly('refresh-1');
      final store = await _signedIn('access-1', 'refresh-1');

      expect(
        await _client(store, service).getJsonFresh(NativePaths.bootstrapGet),
        _bootstrap,
      );
      expect(service.refreshes, ['refresh-1']);
      expect(await _stored(), ('rotated-access-1', 'rotated-refresh-1'));
    });
  });

  group('an access token about to expire', () {
    test('is replaced by a fresh pair another engine stored', () async {
      final service = _Service()..issue('access-2', 'refresh-2');
      final store = await _signedIn(
        'access-1',
        'refresh-1',
        expiresIn: const Duration(seconds: 10),
      );
      await _otherEngineStores('access-2', 'refresh-2');

      expect(
        await _client(store, service).getJsonFresh(NativePaths.bootstrapGet),
        _bootstrap,
      );
      expect(service.refreshes, isEmpty);
    });

    test('is refreshed with the refresh token stored last', () async {
      final service = _Service()..issue('access-2', 'refresh-2');
      final store = await _signedIn(
        'access-1',
        'refresh-1',
        expiresIn: const Duration(seconds: 10),
      );
      await _otherEngineStores(
        'access-2',
        'refresh-2',
        expiresIn: const Duration(seconds: 10),
      );

      expect(
        await _client(store, service).getJsonFresh(NativePaths.bootstrapGet),
        _bootstrap,
      );
      expect(service.refreshes, ['refresh-2']);
      expect(await _stored(), ('rotated-access-1', 'rotated-refresh-1'));
    });
  });

  group('a refused refresh', () {
    test('clears the pair it presented', () async {
      final service = _Service();
      final store = await _signedIn('access-1', 'refresh-1');

      await expectLater(
        _client(store, service).getJsonFresh(NativePaths.bootstrapGet),
        throwsA(_status(401)),
      );
      expect(service.refreshes, ['refresh-1']);
      expect(await store.hasStoredCredentials(), isFalse);
    });

    test('erases the installation when the service asks for a wipe', () async {
      final store = await _signedIn('access-1', 'refresh-1');
      final service = _Service()
        ..wipeDeviceId = await store.readExistingDeviceId();

      await expectLater(
        _client(store, service).getJsonFresh(NativePaths.bootstrapGet),
        throwsA(_status(401)),
      );
      expect(service.wipeAcknowledged, isTrue);
      expect(await store.hasStoredCredentials(), isFalse);
      expect(await store.readExistingDeviceId(), isNull);
    });

    test('keeps and uses a pair another engine stored meanwhile', () async {
      final service = _Service();
      service.onRefresh = () async {
        await _otherEngineStores('access-new', 'refresh-new');
        service.issue('access-new', 'refresh-new');
      };
      final store = await _signedIn('access-1', 'refresh-1');

      expect(
        await _client(store, service).getJsonFresh(NativePaths.bootstrapGet),
        _bootstrap,
      );
      expect(service.refreshes, ['refresh-1']);
      expect(await _stored(), ('access-new', 'refresh-new'));
    });

    test('is reported when another engine signed out meanwhile', () async {
      final service = _Service();
      service.onRefresh = () =>
          SecureSessionStore(const FlutterSecureStorage()).clear();
      final store = await _signedIn('access-1', 'refresh-1');
      final api = _client(store, service);

      await expectLater(
        api.ensureRefreshed(rejectedAccessToken: 'access-1'),
        throwsA(_status(401)),
      );
      expect(service.refreshes, ['refresh-1']);
      expect(await store.hasStoredCredentials(), isFalse);
    });
  });

  group('restore', () {
    test('joins a refresh a request already started', () async {
      FlutterSecureStorage.setMockInitialValues({
        // A first sign-in that stopped after storing only its refresh token.
        'asael.refresh_token': 'refresh-1',
      });
      final arrived = Completer<void>();
      final release = Completer<void>();
      final service = _Service()..issueRefreshOnly('refresh-1');
      service.onRefresh = () {
        if (!arrived.isCompleted) arrived.complete();
        return release.future;
      };
      final store = SecureSessionStore(const FlutterSecureStorage());
      final api = _client(store, service);

      final request = api.getJsonFresh(NativePaths.bootstrapGet);
      await arrived.future;
      final restored = SessionRepository(api, store, _NoBiometrics()).restore();
      await pumpEventQueue(times: 100);
      expect(service.refreshes, ['refresh-1']);
      release.complete();

      expect((await restored)?.tenantId, 'tenant-1');
      expect(await request, _bootstrap);
      expect(service.refreshes, ['refresh-1']);
    });

    test('signs out when its own refresh is refused', () async {
      FlutterSecureStorage.setMockInitialValues({
        'asael.refresh_token': 'refresh-1',
      });
      final service = _Service();
      final store = SecureSessionStore(const FlutterSecureStorage());
      final api = _client(store, service);

      expect(
        await SessionRepository(api, store, _NoBiometrics()).restore(),
        isNull,
      );
      expect(service.refreshes, ['refresh-1']);
      expect(await store.hasStoredCredentials(), isFalse);
    });

    test('signs out once a request has had the pair refused', () async {
      final service = _Service();
      final store = await _signedIn('access-1', 'refresh-1');
      final api = _client(store, service);

      expect(
        await SessionRepository(api, store, _NoBiometrics()).restore(),
        isNull,
      );
      expect(service.refreshes, ['refresh-1']);
      expect(await store.hasStoredCredentials(), isFalse);
    });
  });
}

const _bootstrap = {
  'context': {'tenantId': 'tenant-1', 'actorId': 'actor-1'},
  'user': {'id': 'user-1', 'email': 'owner@example.com'},
};

Matcher _status(int statusCode) =>
    isA<ApiException>().having((e) => e.statusCode, 'statusCode', statusCode);

String _expiresIn(Duration duration) =>
    DateTime.now().toUtc().add(duration).toIso8601String();

Future<SecureSessionStore> _signedIn(
  String accessToken,
  String refreshToken, {
  Duration expiresIn = const Duration(minutes: 15),
}) async {
  final store = SecureSessionStore(const FlutterSecureStorage());
  await store.readOrCreateDeviceId();
  await store.writeTokens(
    accessToken: accessToken,
    refreshToken: refreshToken,
    accessExpiresAt: _expiresIn(expiresIn),
  );
  return store;
}

Future<void> _otherEngineStores(
  String accessToken,
  String refreshToken, {
  Duration expiresIn = const Duration(minutes: 15),
}) => SecureSessionStore(const FlutterSecureStorage()).writeTokens(
  accessToken: accessToken,
  refreshToken: refreshToken,
  accessExpiresAt: _expiresIn(expiresIn),
);

Future<(String?, String?)> _stored() async {
  final store = SecureSessionStore(const FlutterSecureStorage());
  return (await store.readToken(), await store.readRefreshToken());
}

ApiClient _client(SecureSessionStore store, _Service service) {
  Dio dio() =>
      Dio(BaseOptions(baseUrl: 'https://asael.example'))
        ..httpClientAdapter = service;
  return createApiClient(store, dio: dio(), refreshDio: dio());
}

class _NoBiometrics implements BiometricGate {
  @override
  Future<bool> isAvailable() async => false;

  @override
  Future<void> authenticate() =>
      throw const BiometricGateException(BiometricGateFailure.unavailable);
}

/// Accepts the access tokens it issued and rotates each refresh token once.
class _Service implements HttpClientAdapter {
  final _accessTokens = <String>{};
  final _refreshTokens = <String, String?>{};
  final refreshes = <String>[];
  var _rotations = 0;

  /// Runs when a refresh arrives, before the service answers it.
  Future<void> Function()? onRefresh;

  /// The installation the service asks to erase, if any.
  String? wipeDeviceId;
  var wipeAcknowledged = false;

  void issue(String accessToken, String refreshToken) {
    _accessTokens.add(accessToken);
    _refreshTokens[refreshToken] = accessToken;
  }

  void issueRefreshOnly(String refreshToken) =>
      _refreshTokens[refreshToken] = null;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (options.path == NativePaths.authRefresh) {
      final presented = (options.data as Map)['refreshToken'] as String;
      refreshes.add(presented);
      await onRefresh?.call();
      if (!_refreshTokens.containsKey(presented)) {
        return _respond(401, {'error': 'refresh_token_reuse'});
      }
      _accessTokens.remove(_refreshTokens.remove(presented));
      _rotations += 1;
      final accessToken = 'rotated-access-$_rotations';
      final refreshToken = 'rotated-refresh-$_rotations';
      issue(accessToken, refreshToken);
      return _respond(200, {
        'tokens': {
          'tokenType': 'Bearer',
          'accessToken': accessToken,
          'refreshToken': refreshToken,
          'accessExpiresAt': _expiresIn(const Duration(minutes: 15)),
          'refreshExpiresAt': _expiresIn(const Duration(days: 30)),
        },
      });
    }
    if (options.method == 'GET' && options.path == NativePaths.wipeChallenge) {
      final deviceId = wipeDeviceId;
      return _respond(200, {
        'schemaVersion': 1,
        'wipeRequired': deviceId != null,
        'deviceId': ?deviceId,
        'acknowledgementToken': 'a' * 48,
      });
    }
    if (options.method == 'POST' &&
        options.path == NativePaths.wipeAcknowledge) {
      wipeAcknowledged =
          (options.data as Map)['deviceId'] == wipeDeviceId &&
          wipeDeviceId != null;
      return _respond(200, {'acknowledged': true});
    }
    final authorization = options.headers['Authorization'];
    if (authorization is String &&
        _accessTokens.contains(authorization.replaceFirst('Bearer ', ''))) {
      return _respond(200, _bootstrap);
    }
    return _respond(401, {'error': 'unauthorized'});
  }

  ResponseBody _respond(int statusCode, Object body) => ResponseBody.fromString(
    jsonEncode(body),
    statusCode,
    headers: {
      Headers.contentTypeHeader: ['application/json'],
    },
  );

  @override
  void close({bool force = false}) {}
}
