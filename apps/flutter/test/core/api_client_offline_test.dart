import 'dart:async';
import 'dart:convert';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/offline_projection_store.dart';
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

  test(
    'falls back to the exact cached GET after a transport failure',
    () async {
      final secureStore = SecureSessionStore(const FlutterSecureStorage());
      await secureStore.writeOfflineProjectionOwner(
        tenantId: 'tenant-one',
        actorId: 'actor-one',
      );
      final adapter = _ProjectionAdapter();
      final dio = Dio(BaseOptions(baseUrl: 'https://asael.example'))
        ..httpClientAdapter = adapter;
      final projectionStore = _MemoryProjectionStore();
      final client = ApiClient(dio, Dio(), secureStore, projectionStore);

      expect((await client.getJson('/api/today'))['source'], 'server');
      await projectionStore.writeCompleted.future;
      adapter.offline = true;

      expect((await client.getJson('/api/today'))['source'], 'server');
      expect(projectionStore.lastReadOwner?.tenantId, 'tenant-one');
      expect(projectionStore.lastReadOwner?.actorId, 'actor-one');
    },
  );

  test('never masks an authorization response with cached data', () async {
    final secureStore = SecureSessionStore(const FlutterSecureStorage());
    await secureStore.writeOfflineProjectionOwner(
      tenantId: 'tenant-one',
      actorId: 'actor-one',
    );
    final adapter = _ProjectionAdapter()..statusCode = 403;
    final dio = Dio(BaseOptions(baseUrl: 'https://asael.example'))
      ..httpClientAdapter = adapter;
    final projectionStore = _MemoryProjectionStore()
      ..projection = OfflineProjection(
        payload: const {'source': 'cache'},
        writtenAt: DateTime.now().toUtc(),
      );
    final client = ApiClient(dio, Dio(), secureStore, projectionStore);

    await expectLater(
      client.getJson('/api/today'),
      throwsA(
        isA<ApiException>().having(
          (error) => error.statusCode,
          'statusCode',
          403,
        ),
      ),
    );
    expect(projectionStore.readCount, 0);
  });

  test(
    'bounds authenticated artifact bytes before returning a preview',
    () async {
      final secureStore = SecureSessionStore(const FlutterSecureStorage());
      final adapter = _BytesAdapter(Uint8List.fromList([1, 2, 3, 4]));
      final dio = Dio(BaseOptions(baseUrl: 'https://asael.example'))
        ..httpClientAdapter = adapter;
      final client = ApiClient(dio, Dio(), secureStore);

      expect(await client.getBytes('/api/capture/assets/a', maximumBytes: 4), [
        1,
        2,
        3,
        4,
      ]);
      await expectLater(
        client.getBytes('/api/capture/assets/a', maximumBytes: 3),
        throwsA(isA<ApiException>()),
      );
    },
  );

  test('applies a stream-specific receive timeout', () async {
    final secureStore = SecureSessionStore(const FlutterSecureStorage());
    final adapter = _StreamOptionsAdapter();
    final dio = Dio(
      BaseOptions(
        baseUrl: 'https://asael.example',
        receiveTimeout: const Duration(seconds: 30),
      ),
    )..httpClientAdapter = adapter;
    final client = ApiClient(dio, Dio(), secureStore);

    final body = await client.postStream(
      '/api/agent',
      receiveTimeout: const Duration(minutes: 10),
    );

    expect(adapter.receiveTimeout, const Duration(minutes: 10));
    expect(await body.stream.expand((chunk) => chunk).toList(), [1]);
  });

  test('classifies a live response timeout without claiming offline', () {
    final error = ApiException.fromDio(
      DioException(
        requestOptions: RequestOptions(path: '/api/agent'),
        type: DioExceptionType.receiveTimeout,
      ),
    );

    expect(error.diagnosticCode, 'receiveTimeout');
    expect(error.message, contains('run may still finish in History'));
  });
}

class _StreamOptionsAdapter implements HttpClientAdapter {
  Duration? receiveTimeout;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    receiveTimeout = options.receiveTimeout;
    return ResponseBody(Stream.value(Uint8List.fromList([1])), 200);
  }

  @override
  void close({bool force = false}) {}
}

class _BytesAdapter implements HttpClientAdapter {
  _BytesAdapter(this.bytes);
  final Uint8List bytes;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async => ResponseBody(
    Stream.fromIterable([bytes.sublist(0, 2), bytes.sublist(2)]),
    200,
    headers: {
      Headers.contentTypeHeader: ['application/octet-stream'],
    },
  );

  @override
  void close({bool force = false}) {}
}

class _MemoryProjectionStore implements OfflineProjectionStore {
  OfflineProjection? projection;
  ProjectionOwnerBinding? lastReadOwner;
  int readCount = 0;
  final writeCompleted = Completer<void>();

  @override
  Future<OfflineProjection?> read(
    ProjectionOwnerBinding owner,
    String key,
  ) async {
    readCount += 1;
    lastReadOwner = owner;
    return projection;
  }

  @override
  Future<void> write(
    ProjectionOwnerBinding owner,
    String key,
    Map<String, dynamic> payload,
  ) async {
    projection = OfflineProjection(
      payload: Map<String, dynamic>.from(payload),
      writtenAt: DateTime.now().toUtc(),
    );
    if (!writeCompleted.isCompleted) writeCompleted.complete();
  }
}

class _ProjectionAdapter implements HttpClientAdapter {
  bool offline = false;
  int statusCode = 200;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (offline) {
      throw DioException.connectionError(
        requestOptions: options,
        reason: 'offline',
      );
    }
    return ResponseBody.fromString(
      jsonEncode(
        statusCode == 200
            ? {'source': 'server'}
            : {
                'error': {'code': 'forbidden', 'message': 'Forbidden'},
              },
      ),
      statusCode,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}
