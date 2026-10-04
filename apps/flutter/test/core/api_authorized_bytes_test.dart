import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

const _base = 'https://archive.test';
const _user = '11111111-1111-4111-8111-111111111111';
NativeRequestAuthority _authority({bool Function()? current}) =>
    NativeRequestAuthority(
      tenantId: 'tenant-a',
      actorId: 'owner@example.test',
      canonicalUserId: _user,
      role: 'viewer',
      apiBaseUrl: _base,
      isCurrent: current ?? () => true,
    );
Future<ApiClient> _client(_DownloadService service) async {
  final store = SecureSessionStore(const FlutterSecureStorage());
  await store.writeTokens(
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
    accessExpiresAt: DateTime.now()
        .toUtc()
        .add(const Duration(minutes: 15))
        .toIso8601String(),
  );
  Dio client() => Dio(BaseOptions(baseUrl: _base))..httpClientAdapter = service;
  final requestDio = client();
  service.requestDio = requestDio;
  return createApiClient(store, dio: requestDio, refreshDio: client());
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  test('authorized download returns exact immutable bytes and only bounded metadata', () async {
    final service = _DownloadService();
    service.headers.addAll({
      'set-cookie': ['PRIVATE_COOKIE'],
      'authorization': ['PRIVATE_TOKEN'],
      'x-asael-archive-sha256': ['a' * 64],
    });
    final api = await _client(service), cancel = CancelToken();
    final response = await api.getBytesAuthorized(
      NativePaths.adminDataExport,
      authority: _authority(),
      cancelToken: cancel,
    );
    expect(utf8.decode(response.bytes), '{"value":1}');
    expect(
      response.headers.keys,
      unorderedEquals(['content-type', 'x-asael-archive-sha256']),
    );
    expect(() => response.bytes[0] = 0, throwsUnsupportedError);
    expect(
      () => response.headers['set-cookie'] = 'changed',
      throwsUnsupportedError,
    );
    expect(service.bootstraps, 1);
    expect(service.downloads, 1);
    expect(service.refreshes, 0);
    expect(service.downloadToken, 'Bearer test-access');
    expect(service.followRedirects, isFalse);
    expect(cancel.isCancelled, isFalse);
  });
  for (final cause in ['owner', '401', '403']) {
    test(
      'bootstrap $cause refusal never dispatches archive or refresh',
      () async {
        final service = _DownloadService();
        if (cause == 'owner') {
          service.owner = '22222222-2222-4222-8222-222222222222';
        } else {
          service.bootstrapStatus = int.parse(cause);
        }
        final api = await _client(service);
        await expectLater(
          api.getBytesAuthorized(
            NativePaths.adminDataExport,
            authority: _authority(),
            cancelToken: CancelToken(),
          ),
          throwsA(isA<NativeAuthorityVerificationException>()),
        );
        expect(service.downloads, 0);
        expect(service.refreshes, 0);
      },
    );
  }
  test(
    'already canceled or stale authority admits no bootstrap or download',
    () async {
      final service = _DownloadService();
      final bound = await _client(service);
      await expectLater(
        bound.getBytesAuthorized(
          NativePaths.adminDataExport,
          authority: _authority(current: () => false),
          cancelToken: CancelToken(),
        ),
        throwsA(isA<NativeAuthorityVerificationException>()),
      );
      final cancel = CancelToken()..cancel('canceled before request');
      await expectLater(
        bound.getBytesAuthorized(
          NativePaths.adminDataExport,
          authority: _authority(),
          cancelToken: cancel,
        ),
        throwsA(isA<ApiException>()),
      );
      expect(service.downloads, 0);
      expect(service.bootstraps, 0);
    },
  );
  for (final length in <String?>['99', null, '1']) {
    test(
      'size limit holds with declared length $length and closes the body',
      () async {
        final service = _DownloadService();
        if (length != null) service.headers['content-length'] = [length];
        final api = await _client(service), cancel = CancelToken();
        await expectLater(
          api.getBytesAuthorized(
            NativePaths.adminDataExport,
            authority: _authority(),
            cancelToken: cancel,
            maximumBytes: 4,
          ),
          throwsA(
            isA<ApiException>().having(
              (e) => e.diagnosticCode,
              'code',
              'download_size_limit',
            ),
          ),
        );
        await Future<void>.value();
        expect(cancel.isCancelled, isTrue);
        expect(service.closed, isTrue);
      },
    );
  }
  for (final invalid in [
    'html',
    'partial',
    'redirect',
    'malformed length',
    'metadata',
  ]) {
    test('rejects $invalid without returning private bytes', () async {
      final service = _DownloadService();
      switch (invalid) {
        case 'html':
          service.headers['content-type'] = ['text/html'];
        case 'partial':
          service.status = 206;
        case 'redirect':
          service.status = 302;
        case 'malformed length':
          service.headers['content-length'] = ['unknown'];
        case 'metadata':
          service.headers['content-disposition'] = ['x' * 1025];
      }
      final api = await _client(service), cancel = CancelToken();
      await expectLater(
        api.getBytesAuthorized(
          NativePaths.adminDataExport,
          authority: _authority(),
          cancelToken: cancel,
        ),
        throwsA(isA<ApiException>()),
      );
      expect(cancel.isCancelled, isTrue);
      expect(service.closed, isTrue);
      expect(service.downloads, 1);
      expect(service.refreshes, 0);
    });
  }
  for (final change in ['owner', 'cancel', 'API']) {
    test(
      '$change change during an open stream discards bytes and closes it',
      () async {
        final body = StreamController<Uint8List>();
        final service = _DownloadService()..stream = body.stream;
        final api = await _client(service), cancel = CancelToken();
        var current = true;
        final read = api.getBytesAuthorized(
          NativePaths.adminDataExport,
          authority: _authority(current: () => current),
          cancelToken: cancel,
        );
        final failure = expectLater(read, throwsA(isA<ApiException>()));
        await service.arrived.future;
        await Future<void>.delayed(Duration.zero);
        body.add(Uint8List.fromList([123]));
        await Future<void>.delayed(Duration.zero);
        if (change == 'owner') current = false;
        if (change == 'API') {
          service.requestDio!.options.baseUrl = 'https://replacement.test';
        }
        if (change == 'cancel') cancel.cancel('View hidden');
        body.add(Uint8List.fromList([125]));
        unawaited(body.close());
        await failure;
        expect(cancel.isCancelled, isTrue);
        await service.closedEvent.future.timeout(const Duration(seconds: 1));
        expect(service.closed, isTrue);
        expect(service.downloads, 1);
      },
    );
  }
  test(
    'overall deadline closes a trickling stream despite per-chunk activity',
    () async {
      final service = _DownloadService()
        ..stream = Stream<Uint8List>.periodic(
          const Duration(milliseconds: 5),
          (_) => Uint8List.fromList([32]),
        );
      final api = await _client(service), cancel = CancelToken();
      await expectLater(
        api.getBytesAuthorized(
          NativePaths.adminDataExport,
          authority: _authority(),
          cancelToken: cancel,
          timeout: const Duration(milliseconds: 80),
        ),
        throwsA(
          isA<ApiException>().having(
            (e) => e.diagnosticCode,
            'code',
            'download_deadline',
          ),
        ),
      );
      expect(cancel.isCancelled, isTrue);
      expect(service.closed, isTrue);
    },
  );
  test(
    'HTTP refusal discards error content while preserving its status',
    () async {
      final service = _DownloadService()..status = 403;
      final api = await _client(service);
      await expectLater(
        api.getBytesAuthorized(
          NativePaths.adminDataExport,
          authority: _authority(),
          cancelToken: CancelToken(),
        ),
        throwsA(
          isA<ApiException>()
              .having((e) => e.statusCode, 'status', 403)
              .having((e) => e.responseData, 'body', isNull),
        ),
      );
      expect(service.closed, isTrue);
      expect(service.downloads, 1);
    },
  );
}

class _DownloadService implements HttpClientAdapter {
  String owner = _user;
  int status = 200,
      bootstrapStatus = 200,
      bootstraps = 0,
      downloads = 0,
      refreshes = 0;
  bool closed = false;
  Object? downloadToken;
  bool? followRedirects;
  Dio? requestDio;
  Stream<Uint8List>? stream;
  final arrived = Completer<void>();
  final closedEvent = Completer<void>();
  final headers = <String, List<String>>{
    'content-type': ['application/json; charset=utf-8'],
  };
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (options.uri.path == NativePaths.bootstrapGet) {
      bootstraps++;
      return ResponseBody.fromString(
        jsonEncode({
          'authenticated': true,
          'context': {
            'tenantId': 'tenant-a',
            'actorId': 'owner@example.test',
            'role': 'viewer',
          },
          'user': {'id': owner, 'email': 'owner@example.test'},
          'membership': {'role': 'viewer'},
        }),
        bootstrapStatus,
        headers: {
          'content-type': ['application/json'],
        },
      );
    }
    if (options.uri.path == NativePaths.authRefresh) {
      refreshes++;
      return ResponseBody.fromString(
        '{}',
        500,
        headers: {
          'content-type': ['application/json'],
        },
      );
    }
    downloads++;
    downloadToken = options.headers['Authorization'];
    followRedirects = options.followRedirects;
    if (!arrived.isCompleted) arrived.complete();
    return ResponseBody(
      stream ?? Stream.value(Uint8List.fromList(utf8.encode('{"value":1}'))),
      status,
      headers: headers,
      onClose: () {
        closed = true;
        if (!closedEvent.isCompleted) closedEvent.complete();
      },
    );
  }

  @override
  void close({bool force = false}) {}
}
