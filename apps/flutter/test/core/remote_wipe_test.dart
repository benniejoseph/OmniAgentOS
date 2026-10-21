import 'dart:convert';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    FlutterSecureStorage.setMockInitialValues({});
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('app.omniagent.omniagent/listen'),
          (call) async => {'schemaVersion': 1, 'erased': true},
        );
  });
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('app.omniagent.omniagent/listen'),
          null,
        );
  });

  test('native erasure failure retains the challenge credentials and prevents acknowledgement', () async {
    final store = SecureSessionStore(const FlutterSecureStorage());
    final deviceId = await store.readOrCreateDeviceId();
    await store.writeTokens(
      accessToken: 'revoked',
      refreshToken: 'refresh',
      accessExpiresAt: DateTime.now().toUtc().toIso8601String(),
    );
    final transport = _WipeAdapter(deviceId);
    final client = ApiClient(
      Dio(),
      Dio()..httpClientAdapter = transport,
      store,
    );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('app.omniagent.omniagent/listen'),
          (call) async => throw PlatformException(code: 'local_erasure_failed'),
        );
    await expectLater(
      client.clearAndAcknowledgeRemoteWipe(),
      throwsA(isA<PlatformException>()),
    );
    expect(await store.hasStoredCredentials(), isTrue);
    expect(transport.acknowledged, isFalse);
  });

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

    var erased = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('app.omniagent.omniagent/listen'),
          (call) async {
            expect(call.method, 'eraseForRemoteWipe');
            expect(await store.hasStoredCredentials(), isTrue);
            expect(
              (rawDio.httpClientAdapter as _WipeAdapter).acknowledged,
              isFalse,
            );
            erased = true;
            return {'schemaVersion': 1, 'erased': true};
          },
        );
    expect(await client.clearAndAcknowledgeRemoteWipe(), isTrue);
    expect(erased, isTrue);
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
