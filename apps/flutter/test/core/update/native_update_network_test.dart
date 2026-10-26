import 'dart:async';
import 'dart:typed_data';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/core/update/native_update_startup_gate.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

class _NoCredentials extends Fake implements AsaelSecureValueStore {
  @override
  Future<String?> read({required String key}) => throw StateError(
    'No credential reads belong in this synthetic dispatch check.',
  );
}

class _Adapter implements HttpClientAdapter {
  final entered = Completer<void>();
  final response = Completer<ResponseBody>();
  int calls = 0;
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    calls += 1;
    if (!entered.isCompleted) entered.complete();
    return response.future;
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  test('handoff rechecks after asynchronous interceptors before any business dispatch', () async {
    const nonce = 'late-dispatch-test';
    final store = SecureSessionStore.withStorage(_NoCredentials());
    final dio = Dio(BaseOptions(baseUrl: 'https://invalid.example'));
    final adapter = _Adapter();
    dio.httpClientAdapter = adapter;
    createApiClient(store, dio: dio);
    final entered = Completer<void>(), release = Completer<void>();
    dio.interceptors.insert(
      1,
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          entered.complete();
          await release.future;
          handler.next(options);
        },
      ),
    );
    addTearDown(() {
      nativeUpdateHandoffGate.release(nonce);
      dio.close(force: true);
      store.dispose();
    });
    final pending = dio.post<Object?>(
      NativePaths.authLogin,
      data: {'synthetic': true},
    );
    final rejected = expectLater(
      pending,
      throwsA(
        isA<DioException>().having(
          (value) => value.type,
          'type',
          DioExceptionType.cancel,
        ),
      ),
    );
    await entered.future;
    expect(
      nativeUpdateHandoffGate.begin(nonce, const Duration(seconds: 6)),
      true,
    );
    release.complete();
    await rejected;
    expect(adapter.calls, 0);
    expect(nativeUpdatePendingBusinessRequests, 0);
  });

  for (final status in [200, 500]) {
    test(
      'in-flight business request stays visible until HTTP $status settles',
      () async {
        const nonce = 'active-dispatch-test';
        final store = SecureSessionStore.withStorage(_NoCredentials());
        final dio = Dio(BaseOptions(baseUrl: 'https://invalid.example'));
        final adapter = _Adapter();
        dio.httpClientAdapter = adapter;
        createApiClient(store, dio: dio);
        addTearDown(() {
          nativeUpdateHandoffGate.release(nonce);
          dio.close(force: true);
          store.dispose();
        });
        final pending = dio.post<Object?>(
          NativePaths.authLogin,
          data: {'synthetic': true},
        );
        final failed = status == 500
            ? expectLater(pending, throwsA(isA<DioException>()))
            : null;
        await adapter.entered.future;
        expect(nativeUpdatePendingBusinessRequests, 1);
        expect(
          nativeUpdateHandoffGate.begin(nonce, const Duration(seconds: 6)),
          true,
        );
        await expectLater(
          dio.post<Object?>(NativePaths.authLogin),
          throwsA(isA<DioException>()),
        );
        expect(adapter.calls, 1);
        adapter.response.complete(
          ResponseBody.fromString(
            '{}',
            status,
            headers: {
              'content-type': ['application/json'],
            },
          ),
        );
        if (failed != null) {
          await failed;
        } else {
          await pending;
        }
        expect(nativeUpdatePendingBusinessRequests, 0);
      },
    );
  }
}
