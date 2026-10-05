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

const _base = 'https://authority.test';
const _ownerId = '11111111-1111-4111-8111-111111111111';
const _replacementId = '22222222-2222-4222-8222-222222222222';

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  for (final refusal in ['bootstrap401', 'bootstrap403', 'canonical owner']) {
    test(
      '$refusal is a typed authority refusal with no dispatch or refresh',
      () async {
        final store = await _store(), service = _Service();
        if (refusal == 'canonical owner') {
          service.bootstrapOverride = () => _bootstrap(_replacementId);
        } else {
          service.bootstrapStatus = refusal == 'bootstrap401' ? 401 : 403;
        }
        await expectLater(
          _client(
            store,
            service,
          ).getJsonAuthorized('/api/private-read', authority: _authority()),
          throwsA(
            isA<NativeAuthorityVerificationException>()
                .having((error) => error.statusCode, 'statusCode', isNull)
                .having((error) => error.responseData, 'responseData', isNull),
          ),
        );
        expect(service.validatedTokens, ['Bearer access-one']);
        expect(service.posts, isEmpty);
        expect(service.refreshes, 0);
      },
    );
  }

  test(
    'bootstrap transport failure is unavailable rather than authority refusal',
    () async {
      final store = await _store(), service = _Service()..bootstrapStatus = 500;
      await expectLater(
        _client(
          store,
          service,
        ).getJsonAuthorized('/api/private-read', authority: _authority()),
        throwsA(
          isA<ApiException>().having(
            (error) => error is NativeAuthorityVerificationException,
            'authority refusal',
            isFalse,
          ),
        ),
      );
      expect(service.posts, isEmpty);
      expect(service.refreshes, 0);
    },
  );

  test(
    'ordinary cancellation during bootstrap does not become authority refusal',
    () async {
      final store = await _store(), service = _Service();
      final arrived = Completer<void>(), release = Completer<void>();
      service.beforeBootstrap = () {
        arrived.complete();
        return release.future;
      };
      final cancel = CancelToken();
      final request = _client(store, service).getJsonAuthorized(
        '/api/private-read',
        authority: _authority(),
        cancelToken: cancel,
      );
      final failed = expectLater(
        request,
        throwsA(
          isA<ApiException>().having(
            (error) => error is NativeAuthorityVerificationException,
            'authority refusal',
            isFalse,
          ),
        ),
      );
      await arrived.future;
      cancel.cancel('View hidden');
      release.complete();
      await failed;
      expect(service.posts, isEmpty);
      expect(service.refreshes, 0);
    },
  );

  test('a scoped form dispatches the exact validated token after storage replacement', () async {
    final store = await _store(), service = _Service();
    final arrived = Completer<void>(), release = Completer<void>();
    service.beforeBootstrap = () {
      arrived.complete();
      return release.future;
    };
    final request = _upload(_client(store, service), _authority());
    await arrived.future;
    await _replace(store, 'access-other');
    release.complete();
    await request;
    expect(service.validatedTokens, ['Bearer access-one']);
    expect(service.posts.single.token, 'Bearer access-one');
    expect(service.posts.single.key, 'capture-offline-retained');
    expect(service.posts.single.body, contains('private original'));
  });

  test(
    'a held bootstrap cannot dispatch after the local authority changes',
    () async {
      final store = await _store(), service = _Service();
      final arrived = Completer<void>(), release = Completer<void>();
      var current = true;
      service.beforeBootstrap = () {
        arrived.complete();
        return release.future;
      };
      final request = _upload(
        _client(store, service),
        _authority(current: () => current),
      );
      final failed = expectLater(request, throwsA(isA<ApiException>()));
      await arrived.future;
      current = false;
      release.complete();
      await failed;
      expect(service.posts, isEmpty);
    },
  );

  test(
    'a recreated same-email account cannot receive an earlier private request',
    () async {
      final store = await _store(), service = _Service();
      await _replace(store, 'access-other');
      await expectLater(
        _upload(_client(store, service), _authority()),
        throwsA(isA<ApiException>()),
      );
      expect(service.validatedTokens, ['Bearer access-other']);
      expect(service.posts, isEmpty);
    },
  );

  test(
    'a role or API replacement during a held refresh prevents the initial POST',
    () async {
      for (final replaceApi in [false, true]) {
        final store = await _store(expired: true), service = _Service();
        final arrived = Completer<void>(), release = Completer<void>();
        var current = true;
        service.beforeRefresh = () {
          arrived.complete();
          return release.future;
        };
        final dio = _dio(service),
            api = createApiClient(store, dio: dio, refreshDio: _dio(service));
        final request = _upload(api, _authority(current: () => current));
        final failed = expectLater(request, throwsA(isA<ApiException>()));
        await arrived.future;
        if (replaceApi) {
          dio.options.baseUrl = 'https://replacement.test';
        } else {
          current = false;
        }
        release.complete();
        await failed;
        expect(service.validatedTokens, isEmpty);
        expect(service.posts, isEmpty);
      }
    },
  );

  test('one-shot secret POST never refreshes or replays after a 401', () async {
    final store = await _store(), service = _Service()..refuseFirstPost = true;
    await expectLater(
      _client(store, service).postJsonAuthorizedOnce(
        '/api/connectors/native/credential-preparations',
        authority: _authority(),
        data: {
          'payload': {'bearerToken': 'synthetic-one-shot'},
        },
        headers: {'Idempotency-Key': 'preparation-one'},
        receiveTimeout: const Duration(seconds: 55),
      ),
      throwsA(isA<ApiException>()),
    );
    expect(service.posts, hasLength(1));
    expect(service.posts.single.key, 'preparation-one');
    expect(service.validatedTokens, ['Bearer access-one']);
    expect(service.refreshes, 0);
    expect(service.receiveTimeouts, [const Duration(seconds: 55)]);
  });

  test(
    'one-shot receive timeout is bounded per call and preserves the default',
    () async {
      final store = await _store(), service = _Service();
      final dio = _dio(service)
        ..options.receiveTimeout = const Duration(seconds: 30);
      final api = createApiClient(store, dio: dio, refreshDio: _dio(service));
      for (final timeout in [Duration.zero, const Duration(seconds: 56)]) {
        expect(
          () => api.postJsonAuthorizedOnce(
            '/api/connectors/native/openapi-import-preparations',
            authority: _authority(),
            receiveTimeout: timeout,
          ),
          throwsArgumentError,
        );
      }
      expect(service.posts, isEmpty);
      expect(service.validatedTokens, isEmpty);
      await api.postJsonAuthorizedOnce(
        '/api/connectors/native/openapi-import-preparations',
        authority: _authority(),
        receiveTimeout: const Duration(seconds: 55),
      );
      await api.postJsonAuthorizedOnce(
        '/api/connectors/native/credential-preparations',
        authority: _authority(),
      );
      expect(service.receiveTimeouts, [
        const Duration(seconds: 55),
        const Duration(seconds: 30),
      ]);
      expect(dio.options.receiveTimeout, const Duration(seconds: 30));
    },
  );

  test('401 replay validates the replacement token before resending original bytes with the same key', () async {
    final store = await _store(), service = _Service()..refuseFirstPost = true;
    await _upload(_client(store, service), _authority());
    expect(service.validatedTokens, [
      'Bearer access-one',
      'Bearer access-rotated',
    ]);
    expect(service.posts.map((post) => post.token), [
      'Bearer access-one',
      'Bearer access-rotated',
    ]);
    expect(
      service.posts.map((post) => post.key),
      everyElement('capture-offline-retained'),
    );
    expect(service.posts[1].body, service.posts[0].body);
    expect(service.refreshes, 1);
  });

  test(
    '401 replay refuses a rotated token for another canonical user',
    () async {
      final store = await _store(),
          service = _Service()
            ..refuseFirstPost = true
            ..rotatedOwner = _replacementId;
      await expectLater(
        _upload(_client(store, service), _authority()),
        throwsA(isA<ApiException>()),
      );
      expect(service.validatedTokens, [
        'Bearer access-one',
        'Bearer access-rotated',
      ]);
      expect(service.posts, hasLength(1));
      expect(service.posts.single.token, 'Bearer access-one');
    },
  );

  test(
    'scope loss during the 401 refresh cannot replay an already admitted form',
    () async {
      final store = await _store(),
          service = _Service()..refuseFirstPost = true;
      final arrived = Completer<void>(), release = Completer<void>();
      var current = true;
      service.beforeRefresh = () {
        arrived.complete();
        return release.future;
      };
      final request = _upload(
        _client(store, service),
        _authority(current: () => current),
      );
      final failed = expectLater(request, throwsA(isA<ApiException>()));
      await arrived.future;
      current = false;
      release.complete();
      await failed;
      expect(service.posts, hasLength(1));
      expect(service.validatedTokens, ['Bearer access-one']);
    },
  );

  test(
    'unavailable or malformed current owner never permits a private POST',
    () async {
      for (final replacement in <Object?>[
        null,
        {},
        {'authenticated': true},
        {
          ..._bootstrap(_ownerId),
          'membership': {'role': 'viewer'},
        },
        {
          ..._bootstrap(_ownerId),
          'context': {
            'tenantId': 'other',
            'actorId': 'same@example.test',
            'role': 'operator',
          },
        },
      ]) {
        final store = await _store(),
            service = _Service()..bootstrapOverride = () => replacement;
        await expectLater(
          _upload(_client(store, service), _authority()),
          throwsA(isA<ApiException>()),
        );
        expect(service.posts, isEmpty);
      }
      for (final status in [401, 500, 302]) {
        final store = await _store(),
            service = _Service()..bootstrapStatus = status;
        await expectLater(
          _upload(_client(store, service), _authority()),
          throwsA(isA<ApiException>()),
        );
        expect(service.posts, isEmpty);
      }
    },
  );

  test(
    'JSON private writes use the same exact-token authority boundary',
    () async {
      final store = await _store(), service = _Service();
      await _client(store, service).postJsonAuthorized(
        '/api/private-write',
        authority: _authority(),
        data: {'prompt': 'private prompt'},
        headers: {'idempotency-key': 'prepared-intent'},
      );
      expect(service.validatedTokens, ['Bearer access-one']);
      expect(service.posts.single.token, 'Bearer access-one');
      expect(service.posts.single.key, 'prepared-intent');
      expect(service.posts.single.body, contains('private prompt'));
    },
  );

  test(
    'PATCH retains its reviewed body and key under the exact-token boundary',
    () async {
      final store = await _store(), service = _Service();
      final api = _client(store, service);
      await api.patchJsonAuthorized(
        '/api/responsibilities/exact',
        authority: _authority(),
        data: {
          'action': 'update',
          'expectedRevision': 3,
          'draft': 'private draft',
        },
        headers: {'idempotency-key': 'exact-draft-change'},
      );
      expect(service.validatedTokens, ['Bearer access-one']);
      expect(service.posts.single.method, 'PATCH');
      expect(service.posts.single.token, 'Bearer access-one');
      expect(service.posts.single.key, 'exact-draft-change');
      expect(jsonDecode(service.posts.single.body), {
        'action': 'update',
        'expectedRevision': 3,
        'draft': 'private draft',
      });
      await _replace(store, 'access-other');
      await expectLater(
        api.patchJsonAuthorized(
          '/api/responsibilities/exact',
          authority: _authority(),
          data: {'action': 'update'},
          headers: {'idempotency-key': 'exact-draft-change'},
        ),
        throwsA(isA<ApiException>()),
      );
      expect(service.posts, hasLength(1));
    },
  );

  test('ordinary requests keep their existing transport and never require bootstrap', () async {
    final store = await _store(), service = _Service();
    await _client(
      store,
      service,
    ).postJson('/api/ordinary', data: {'note': 'ordinary'});
    expect(service.validatedTokens, isEmpty);
    expect(service.posts, hasLength(1));
  });

  test(
    'a bare injected client cannot silently omit scoped request validation',
    () async {
      final store = await _store(), service = _Service();
      final api = ApiClient(_dio(service), _dio(service), store);
      await expectLater(
        _upload(api, _authority()),
        throwsA(isA<ApiException>()),
      );
      expect(service.posts, isEmpty);
    },
  );
}

NativeRequestAuthority _authority({bool Function()? current}) =>
    NativeRequestAuthority(
      tenantId: 'tenant-one',
      actorId: 'same@example.test',
      canonicalUserId: _ownerId,
      role: 'operator',
      apiBaseUrl: _base,
      isCurrent: current ?? () => true,
    );

Future<Map<String, dynamic>> _upload(
  ApiClient api,
  NativeRequestAuthority authority,
) => api.postMultipart(
  '/api/capture',
  fields: {'title': 'Original'},
  bytes: Uint8List.fromList(utf8.encode('private original')),
  filename: 'original.txt',
  contentType: 'text/plain',
  headers: {'idempotency-key': 'capture-offline-retained'},
  authority: authority,
);

Future<SecureSessionStore> _store({bool expired = false}) async {
  final store = SecureSessionStore(const FlutterSecureStorage());
  await _replace(store, 'access-one', expired: expired);
  return store;
}

Future<void> _replace(
  SecureSessionStore store,
  String token, {
  bool expired = false,
}) => store.writeTokens(
  accessToken: token,
  refreshToken: 'refresh-one',
  accessExpiresAt: DateTime.now()
      .toUtc()
      .add(Duration(minutes: expired ? -1 : 15))
      .toIso8601String(),
);
Dio _dio(_Service service) =>
    Dio(BaseOptions(baseUrl: _base))..httpClientAdapter = service;
ApiClient _client(SecureSessionStore store, _Service service) =>
    createApiClient(store, dio: _dio(service), refreshDio: _dio(service));
Map<String, Object?> _bootstrap(String user) => {
  'authenticated': true,
  'context': {
    'tenantId': 'tenant-one',
    'actorId': 'same@example.test',
    'role': 'operator',
  },
  'user': {'id': user, 'email': 'same@example.test'},
  'membership': {'role': 'operator'},
};

class _Service implements HttpClientAdapter {
  Future<void> Function()? beforeBootstrap, beforeRefresh;
  Object? Function()? bootstrapOverride;
  int bootstrapStatus = 200, refreshes = 0;
  bool refuseFirstPost = false;
  String rotatedOwner = _ownerId;
  final validatedTokens = <Object?>[];
  final receiveTimeouts = <Duration?>[];
  final posts = <({Object? token, Object? key, String body, String method})>[];
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final token = options.headers['Authorization'];
    if (options.uri.path == NativePaths.bootstrapGet) {
      validatedTokens.add(token);
      final owner = token == 'Bearer access-other'
          ? _replacementId
          : token == 'Bearer access-rotated'
          ? rotatedOwner
          : _ownerId;
      final body = bootstrapOverride == null
          ? _bootstrap(owner)
          : bootstrapOverride!();
      await beforeBootstrap?.call();
      return _response(bootstrapStatus, body);
    }
    if (options.uri.path == NativePaths.authRefresh) {
      refreshes++;
      await beforeRefresh?.call();
      return _response(200, {
        'tokens': {
          'accessToken': 'access-rotated',
          'refreshToken': 'refresh-rotated',
          'accessExpiresAt': DateTime.now()
              .toUtc()
              .add(const Duration(minutes: 15))
              .toIso8601String(),
        },
      });
    }
    final body = options.data is FormData
        ? utf8.decode(await requestStream!.expand((chunk) => chunk).toList())
        : jsonEncode(options.data);
    receiveTimeouts.add(options.receiveTimeout);
    posts.add((
      token: token,
      key: options.headers['idempotency-key'],
      body: body,
      method: options.method,
    ));
    return _response(refuseFirstPost && posts.length == 1 ? 401 : 200, {
      'ok': true,
    });
  }

  ResponseBody _response(int status, Object? body) => ResponseBody.fromString(
    jsonEncode(body),
    status,
    headers: {
      Headers.contentTypeHeader: ['application/json'],
    },
  );
  @override
  void close({bool force = false}) {}
}
