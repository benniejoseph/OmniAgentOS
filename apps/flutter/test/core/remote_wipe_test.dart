import 'dart:convert';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    FlutterSecureStorage.setMockInitialValues({});
  });
  tearDown(() => debugDefaultTargetPlatformOverride = null);

  test('remote wipe clears the installation before acknowledging', () async {
    final store = SecureSessionStore(const FlutterSecureStorage());
    final deviceId = await store.readOrCreateDeviceId();
    await store.setBiometricEnabled(true);
    await store.writeTokens(
      accessToken: 'revoked-access-token',
      refreshToken: 'revoked-refresh-token',
      accessExpiresAt: DateTime.now().toUtc().toIso8601String(),
    );
    final rawDio = Dio()..httpClientAdapter = _WipeAdapter(deviceId);
    final client = ApiClient(Dio(), rawDio, store);

    expect(await client.clearAndAcknowledgeRemoteWipe(), isTrue);
    expect(await store.hasStoredCredentials(), isFalse);
    expect(await store.readExistingDeviceId(), isNull);
    expect(await store.readBiometricEnabled(), isFalse);
    expect((rawDio.httpClientAdapter as _WipeAdapter).acknowledged, isTrue);
  });
}

class _WipeAdapter implements HttpClientAdapter {
  _WipeAdapter(this.deviceId);

  final String deviceId;
  bool acknowledged = false;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (options.method == 'GET') {
      return ResponseBody.fromString(
        jsonEncode({
          'schemaVersion': 1,
          'wipeRequired': true,
          'deviceId': deviceId,
          'requestedAt': DateTime.now().toUtc().toIso8601String(),
          'acknowledgementToken': 'a' * 48,
        }),
        200,
        headers: {
          Headers.contentTypeHeader: ['application/json'],
        },
      );
    }
    final body = Map<String, dynamic>.from(options.data as Map);
    acknowledged =
        body['deviceId'] == deviceId &&
        body['acknowledgementToken'] == 'a' * 48;
    return ResponseBody.fromString(
      jsonEncode({'acknowledged': true}),
      200,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}
