import 'dart:async';
import 'dart:convert';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/activity/activity.dart';
import 'package:asael/features/activity/activity_api_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'activity_fixture.dart';

void main() {
  test(
    'uses only the authenticated fresh GET with exact query and cancellation',
    () async {
      final adapter = _ActivityAdapter();
      final dio = Dio(BaseOptions(baseUrl: 'https://synthetic.invalid'))
        ..httpClientAdapter = adapter;
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            options.headers['Authorization'] = 'Bearer synthetic-only';
            handler.next(options);
          },
        ),
      );
      addTearDown(() => dio.close(force: true));
      final api = ApiClient(
        dio,
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
      final cancel = CancelToken();
      final pending = ApiActivityRepository(api).load(
        group: ActivityGroup.working,
        cursor: 'exact:/cursor%2F',
        cancelToken: cancel,
      );
      await adapter.started.future;
      final request = adapter.requests.single;
      expect(request.method, 'GET');
      expect(request.path, '/api/activity');
      expect(request.queryParameters, {
        'group': 'working',
        'limit': 25,
        'cursor': 'exact:/cursor%2F',
      });
      expect(request.data, isNull);
      expect(request.headers['Authorization'], 'Bearer synthetic-only');
      expect(
        request.headers.keys.any(
          (key) => key.toLowerCase().contains('idempotency'),
        ),
        isFalse,
      );
      expect(adapter.cancelFuture, isNotNull);
      adapter.response.complete(
        ResponseBody.fromString(
          jsonEncode(activityFixture(group: ActivityGroup.working)),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        ),
      );
      expect((await pending).group, ActivityGroup.working);
    },
  );

  test('cancellation reaches Dio and is not replaced by cached rows', () async {
    final adapter = _ActivityAdapter();
    final dio = Dio(BaseOptions(baseUrl: 'https://synthetic.invalid'))
      ..httpClientAdapter = adapter;
    addTearDown(() => dio.close(force: true));
    final api = ApiClient(
      dio,
      Dio(),
      SecureSessionStore(const FlutterSecureStorage()),
    );
    final cancel = CancelToken();
    final pending = ApiActivityRepository(api)
        .load(group: ActivityGroup.all, cancelToken: cancel);
    final rejected = expectLater(
      pending,
      throwsA(
        isA<ApiException>().having(
          (error) => error.diagnosticCode,
          'diagnostic',
          'cancel',
        ),
      ),
    );
    await adapter.started.future;
    cancel.cancel('Owner changed');
    await adapter.cancelFuture;
    await rejected;
    // The held synthetic adapter is explicitly settled; no network is used.
    adapter.response.complete(ResponseBody.fromString('{}', 200));
    expect(adapter.requests, hasLength(1));
  });
}

class _ActivityAdapter implements HttpClientAdapter {
  final requests = <RequestOptions>[];
  final started = Completer<void>();
  final response = Completer<ResponseBody>();
  Future<void>? cancelFuture;
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) {
    requests.add(options);
    this.cancelFuture = cancelFuture;
    started.complete();
    return response.future;
  }

  @override
  void close({bool force = false}) {}
}
