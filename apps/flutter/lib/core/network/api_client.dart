import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/native_client_info.dart';
import '../config/app_config.dart';
import '../storage/offline_projection_store.dart';
import '../storage/secure_session_store.dart';
import '../../generated/native_contract.g.dart';
import 'api_exception.dart';

typedef NativeSessionRefresh = Future<void> Function({
  String? rejectedAccessToken,
});

const _requestAuthorityKey = 'asaelNativeRequestAuthority';

/// Runtime authority for one private write, never an authorization grant stored
/// with an offline draft. The server still authorizes the selected bearer token.
class NativeRequestAuthority {
  const NativeRequestAuthority({
    required this.tenantId,
    required this.actorId,
    required this.canonicalUserId,
    required this.role,
    required this.apiBaseUrl,
    required this.isCurrent,
  });

  final String tenantId, actorId, canonicalUserId, role, apiBaseUrl;
  final bool Function() isCurrent;

  static String normalizeApiBaseUrl(String value) {
    final uri = Uri.tryParse(value);
    if (uri == null ||
        !const {'http', 'https'}.contains(uri.scheme) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment) {
      throw const FormatException('The request API address is invalid.');
    }
    return uri
        .replace(
          host: uri.host.toLowerCase(),
          path: uri.path.replaceFirst(RegExp(r'/+$'), ''),
        )
        .toString();
  }

  void requireCurrent(String currentApiBaseUrl) {
    if (tenantId.trim().isEmpty ||
        actorId.trim().isEmpty ||
        canonicalUserId.trim().isEmpty ||
        role.trim().isEmpty ||
        normalizeApiBaseUrl(currentApiBaseUrl) !=
            normalizeApiBaseUrl(apiBaseUrl) ||
        !isCurrent()) {
      throw const ApiException(
        'The request authority changed. Reload before retrying.',
      );
    }
  }

  void verifyBootstrap(Object? value) {
    if (value is! Map) {
      throw const FormatException('The current request owner is unavailable.');
    }
    final context = value['context'],
        user = value['user'],
        membership = value['membership'];
    if (value['authenticated'] != true ||
        context is! Map ||
        user is! Map ||
        membership is! Map ||
        context['tenantId'] != tenantId ||
        context['actorId'] != actorId ||
        context['role'] != role ||
        membership['role'] != role ||
        user['id'] != canonicalUserId) {
      throw const FormatException(
        'The current request owner does not match the admitted owner.',
      );
    }
    NativeContract.verifyBootstrap(Map<String, dynamic>.from(value));
  }
}

final apiClientProvider = Provider<ApiClient>(
  (ref) => createApiClient(ref.watch(secureSessionStoreProvider)),
);

/// Builds the client whose requests and [ApiClient.ensureRefreshed] share this
/// engine's one refresh of the native session.
@visibleForTesting
ApiClient createApiClient(
  SecureSessionStore store, {
  Dio? dio,
  Dio? refreshDio,
}) {
  final client = dio ?? Dio(_baseOptions());
  final refreshClient = refreshDio ?? Dio(_baseOptions());
  final projectionStore = EncryptedOfflineProjectionStore(
    store.readOrCreateOfflineProjectionSecret,
  );
  Future<void>? refreshInFlight;
  final sessionEnded = StreamController<void>.broadcast();

  Future<void> refreshSession(String? rejectedAccessToken) async {
    // Another engine, such as a second macOS window, may have rotated the pair
    // since this one cached it. The token that rotation replaced is reuse to
    // the service once its retry window closes.
    await store.reloadCredentials();
    final accessToken = await store.readToken();
    if (accessToken != null &&
        accessToken != rejectedAccessToken &&
        !await store.accessTokenNeedsRefresh()) {
      return;
    }
    final refreshToken = await store.readRefreshToken();
    if (refreshToken == null || refreshToken.isEmpty) {
      throw StateError('No native refresh credential is available.');
    }
    final deviceId = await store.readOrCreateDeviceId();
    Response<Object?> response;
    try {
      try {
        response = await refreshClient.post<Object?>(
          NativePaths.authRefresh,
          data: {
            'refreshToken': refreshToken,
            'deviceId': deviceId,
            'client': NativeClientInfo.attestation(),
          },
        );
      } on DioException catch (error) {
        if (error.response?.statusCode != 400) rethrow;
        response = await refreshClient.post<Object?>(
          NativePaths.authRefresh,
          data: {'refreshToken': refreshToken, 'deviceId': deviceId},
        );
      }
      await _persistNativeTokens(store, response.data);
    } on DioException catch (error) {
      if (error.response?.statusCode != 401 ||
          await _clearAndAcknowledgeRemoteWipe(refreshClient, store) ||
          await store.clearUnlessReplaced(refreshToken)) {
        rethrow;
      }
      // Another engine stored a pair while this one was refused, so whoever
      // is waiting for the refresh continues with that pair.
      await store.reloadCredentials();
    }
  }

  Future<void> ensureRefreshed({String? rejectedAccessToken}) async {
    final existing = refreshInFlight;
    if (existing != null) return existing;
    final created = refreshSession(rejectedAccessToken);
    refreshInFlight = created;
    try {
      await created;
    } finally {
      if (identical(refreshInFlight, created)) refreshInFlight = null;
    }
  }

  // A refused request that leaves nothing stored has ended the session,
  // whether this engine's refresh cleared it or another engine signed out.
  Future<void> reportIfSessionEnded() async {
    try {
      if (!await store.hasStoredCredentials()) sessionEnded.add(null);
    } catch (_) {
      // An unreadable Keychain does not show that the session is over.
    }
  }

  client.interceptors.add(
    InterceptorsWrapper(
      onRequest: (options, handler) async {
        options.headers.addAll(NativeClientInfo.attestationHeaders());
        final authority = options.extra[_requestAuthorityKey];
        if (authority is NativeRequestAuthority) {
          try {
            authority.requireCurrent(client.options.baseUrl);
            authority.requireCurrent(options.baseUrl);
            final expectedOrigin = Uri.parse(authority.apiBaseUrl).origin;
            if (options.uri.origin != expectedOrigin) {
              throw const FormatException(
                'The private request changed API origin.',
              );
            }
            if (await store.accessTokenNeedsRefresh()) await ensureRefreshed();
            final token = await store.readToken();
            authority.requireCurrent(client.options.baseUrl);
            if (token == null || token.isEmpty) {
              throw const FormatException(
                'A current native credential is required.',
              );
            }
            // The raw client has no mutable credential interceptor. Validate and
            // dispatch the same literal token even if storage changes meanwhile.
            final bootstrap = await refreshClient.get<Object?>(
              RequestOptions(
                baseUrl: options.baseUrl,
                path: NativePaths.bootstrapGet,
              ).uri.toString(),
              options: Options(
                headers: {
                  ...NativeClientInfo.attestationHeaders(),
                  'Authorization': 'Bearer $token',
                  'Cache-Control': 'no-store',
                },
                followRedirects: false,
              ),
              cancelToken: options.cancelToken,
            );
            if (bootstrap.statusCode != 200 ||
                bootstrap.requestOptions.headers['Authorization'] !=
                    'Bearer $token' ||
                bootstrap.requestOptions.uri.origin != expectedOrigin) {
              throw const FormatException(
                'The current request owner could not be verified.',
              );
            }
            authority.verifyBootstrap(bootstrap.data);
            authority.requireCurrent(options.baseUrl);
            authority.requireCurrent(client.options.baseUrl);
            options.headers['Authorization'] = 'Bearer $token';
            options.followRedirects = false;
            handler.next(options);
          } catch (_) {
            handler.reject(
              DioException(
                requestOptions: options,
                type: DioExceptionType.cancel,
                error: const ApiException(
                  'The request owner could not be verified. The original request can be retried after reloading.',
                ),
              ),
            );
          }
          return;
        }
        if (!_isCredentialRoute(options.path) &&
            await store.accessTokenNeedsRefresh()) {
          try {
            await ensureRefreshed();
          } catch (_) {
            // Continue with any still-valid access token. A real 401 takes the
            // single-flight retry path below; transport failures remain visible.
          }
        }
        final token = await store.readToken();
        if (token != null) options.headers['Authorization'] = 'Bearer $token';
        handler.next(options);
      },
      onError: (error, handler) async {
        final request = error.requestOptions;
        if (error.response?.statusCode != 401 ||
            _isCredentialRoute(request.path) ||
            request.extra['asaelNativeRefreshRetried'] == true) {
          handler.next(error);
          return;
        }
        try {
          final authority = request.extra[_requestAuthorityKey];
          if (authority is NativeRequestAuthority) {
            authority.requireCurrent(client.options.baseUrl);
            await ensureRefreshed(
              rejectedAccessToken: _bearerToken(
                request.headers['Authorization'],
              ),
            );
            authority.requireCurrent(client.options.baseUrl);
            request.extra['asaelNativeRefreshRetried'] = true;
            final data = request.data;
            if (data is FormData) request.data = data.clone();
            // onRequest validates the exact replacement token before any replay.
            handler.resolve(await client.fetch<Object?>(request));
            return;
          }
          await ensureRefreshed(
            rejectedAccessToken: _bearerToken(request.headers['Authorization']),
          );
          final token = await store.readToken();
          if (token != null) {
            request.headers['Authorization'] = 'Bearer $token';
            request.extra['asaelNativeRefreshRetried'] = true;
            // Dio sends a form once, so the retry sends a copy of it.
            final data = request.data;
            if (data is FormData) request.data = data.clone();
            handler.resolve(await client.fetch<Object?>(request));
            return;
          }
        } catch (_) {
          // The request fails with the service's refusal.
        }
        await reportIfSessionEnded();
        handler.next(error);
      },
    ),
  );
  return ApiClient(
    client,
    refreshClient,
    store,
    projectionStore,
    ensureRefreshed,
    sessionEnded.stream,
    true,
  );
}

BaseOptions _baseOptions() => BaseOptions(
  baseUrl: AppConfig.apiBaseUrl,
  connectTimeout: const Duration(seconds: 12),
  receiveTimeout: const Duration(seconds: 30),
  headers: const {'Accept': 'application/json'},
);

String? _bearerToken(Object? header) =>
    header is String && header.startsWith('Bearer ')
    ? header.substring('Bearer '.length)
    : null;

bool _isCredentialRoute(String value) {
  final path = Uri.tryParse(value)?.path ?? value;
  return path == NativePaths.authLogin || path == NativePaths.authRefresh;
}

Future<void> _persistNativeTokens(
  SecureSessionStore store,
  Object? response,
) async {
  if (response is! Map || response['tokens'] is! Map) {
    throw StateError('The service returned an invalid native session.');
  }
  final tokens = Map<String, dynamic>.from(response['tokens'] as Map);
  final accessToken = tokens['accessToken']?.toString();
  final refreshToken = tokens['refreshToken']?.toString();
  final accessExpiresAt = tokens['accessExpiresAt']?.toString();
  if (accessToken == null ||
      accessToken.isEmpty ||
      refreshToken == null ||
      refreshToken.isEmpty ||
      accessExpiresAt == null ||
      DateTime.tryParse(accessExpiresAt) == null) {
    throw StateError('The service issued an incomplete native session.');
  }
  await store.writeTokens(
    accessToken: accessToken,
    refreshToken: refreshToken,
    accessExpiresAt: accessExpiresAt,
  );
}

class ApiClient {
  const ApiClient(
    this._dio,
    this._rawDio,
    this._store, [
    this._projectionStore,
    this._refreshSession,
    this._sessionEnded,
    this._supportsRequestAuthority = false,
  ]);
  final Dio _dio;
  final Dio _rawDio;
  final SecureSessionStore _store;
  final OfflineProjectionStore? _projectionStore;
  final NativeSessionRefresh? _refreshSession;
  final Stream<void>? _sessionEnded;
  final bool _supportsRequestAuthority;

  /// The configured API address, for binding retained local data to this server.
  /// Callers must validate and normalize it before using it as an identity.
  String get apiBaseUrl => _dio.options.baseUrl;

  /// Fires when a refused request finds no session stored any more, so the
  /// app can sign out instead of showing a session every request fails.
  Stream<void> get sessionEnded => _sessionEnded ?? const Stream<void>.empty();

  Future<bool> clearAndAcknowledgeRemoteWipe() =>
      _clearAndAcknowledgeRemoteWipe(_rawDio, _store);

  /// Joins or starts the refresh a request that gets a 401 waits for, so the
  /// session is rotated in one place per engine. [rejectedAccessToken] is the
  /// token the service refused; a different stored token that is still fresh
  /// was rotated by another engine and is used without a refresh.
  Future<void> ensureRefreshed({String? rejectedAccessToken}) async {
    final refreshSession = _refreshSession;
    if (refreshSession == null) {
      throw StateError('This client cannot refresh the native session.');
    }
    try {
      await refreshSession(rejectedAccessToken: rejectedAccessToken);
    } on DioException catch (error) {
      throw ApiException.fromDio(error);
    }
  }

  Future<void> seedOfflineProjection(
    String path,
    Map<String, dynamic> payload, {
    Map<String, dynamic>? query,
  }) async {
    final projectionStore = _projectionStore;
    final ownerValue = await _store.readOfflineProjectionOwner();
    if (projectionStore == null || ownerValue == null) return;
    await projectionStore.write(
      ProjectionOwnerBinding(
        tenantId: ownerValue.tenantId,
        actorId: ownerValue.actorId,
      ),
      offlineProjectionKey(path, query: query),
      payload,
    );
  }

  /// Reads one actor-bound encrypted local projection without attempting a
  /// network request. Feature outboxes use this for bounded reconnect replay.
  Future<Map<String, dynamic>?> readOfflineProjection(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    final projectionStore = _projectionStore;
    final ownerValue = await _store.readOfflineProjectionOwner();
    if (projectionStore == null || ownerValue == null) return null;
    final projection = await projectionStore.read(
      ProjectionOwnerBinding(
        tenantId: ownerValue.tenantId,
        actorId: ownerValue.actorId,
      ),
      offlineProjectionKey(path, query: query),
    );
    return projection?.payload;
  }

  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    final maximumOfflineAge = _offlineProjectionMaxAge(path);
    if (maximumOfflineAge == null) {
      return _json(() => _dio.get<Object?>(path, queryParameters: query));
    }
    final ownerValue = await _store.readOfflineProjectionOwner();
    final owner = ownerValue == null
        ? null
        : ProjectionOwnerBinding(
            tenantId: ownerValue.tenantId,
            actorId: ownerValue.actorId,
          );
    final key = offlineProjectionKey(path, query: query);
    try {
      final payload = await _json(
        () => _dio.get<Object?>(path, queryParameters: query),
      );
      final projectionStore = _projectionStore;
      if (projectionStore != null && owner != null) {
        unawaited(
          projectionStore.write(owner, key, payload).catchError((Object _) {}),
        );
      }
      return payload;
    } on ApiException catch (error) {
      final projectionStore = _projectionStore;
      if (!_canUseOfflineProjection(error) ||
          projectionStore == null ||
          owner == null) {
        rethrow;
      }
      try {
        final projection = await projectionStore.read(owner, key);
        final age = projection == null
            ? null
            : DateTime.now().toUtc().difference(projection.writtenAt);
        if (projection != null &&
            age != null &&
            !age.isNegative &&
            age <= maximumOfflineAge) {
          return projection.payload;
        }
      } catch (_) {
        // Corrupt, expired, or unavailable entries cannot mask the real
        // transport failure or widen the active actor scope.
      }
      rethrow;
    }
  }

  /// Reads a live private control-plane projection without writing or falling
  /// back to the general offline projection cache.
  Future<Map<String, dynamic>> getJsonFresh(
    String path, {
    Map<String, dynamic>? query,
  }) => _json(() => _dio.get<Object?>(path, queryParameters: query));

  /// A cancellable live read through the same authenticated client, with no
  /// offline fallback. Kept separate to preserve existing repository adapters.
  Future<Map<String, dynamic>> getJsonFreshCancelable(
    String path, {
    Map<String, dynamic>? query,
    Map<String, dynamic>? headers,
    required CancelToken cancelToken,
  }) => _json(
    () => _dio.get<Object?>(
      path,
      queryParameters: query,
      cancelToken: cancelToken,
      options: Options(headers: headers),
    ),
  );

  Future<Map<String, dynamic>> postJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) => _json(
    () => _dio.post<Object?>(
      path,
      data: data,
      options: Options(headers: headers),
    ),
  );

  Future<Map<String, dynamic>> postJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) {
    _requireAuthorityTransport(authority);
    return _json(
      () => _dio.post<Object?>(
        path,
        data: data,
        options: Options(
          headers: headers,
          extra: {_requestAuthorityKey: authority},
        ),
      ),
    );
  }

  Future<Map<String, dynamic>> patchJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) {
    _requireAuthorityTransport(authority);
    return _json(
      () => _dio.patch<Object?>(
        path,
        data: data,
        options: Options(
          headers: headers,
          extra: {_requestAuthorityKey: authority},
        ),
      ),
    );
  }

  void _requireAuthorityTransport(NativeRequestAuthority authority) {
    if (!_supportsRequestAuthority) {
      throw const ApiException(
        'This client cannot verify a private request owner.',
      );
    }
    authority.requireCurrent(apiBaseUrl);
  }

  Future<Map<String, dynamic>> patchJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) => _json(
    () => _dio.patch<Object?>(
      path,
      data: data,
      options: Options(headers: headers),
    ),
  );

  Future<Map<String, dynamic>> putJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) => _json(
    () => _dio.put<Object?>(
      path,
      data: data,
      options: Options(headers: headers),
    ),
  );

  Future<Map<String, dynamic>> deleteJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? query,
    Map<String, dynamic>? headers,
  }) => _json(
    () => _dio.delete<Object?>(
      path,
      data: data,
      queryParameters: query,
      options: Options(headers: headers),
    ),
  );

  Future<Map<String, dynamic>> postMultipart(
    String path, {
    required Map<String, dynamic> fields,
    Uint8List? bytes,
    String? filename,
    String? contentType,
    String fileField = 'file',
    Map<String, dynamic>? headers,
    Duration? receiveTimeout,
    NativeRequestAuthority? authority,
  }) async {
    if (authority != null) _requireAuthorityTransport(authority);
    final values = <String, dynamic>{...fields};
    if (bytes != null) {
      values[fileField] = MultipartFile.fromBytes(
        bytes,
        filename: filename ?? 'capture.bin',
        contentType: contentType == null
            ? null
            : DioMediaType.parse(contentType),
      );
    }
    return _json(
      () => _dio.post<Object?>(
        path,
        data: FormData.fromMap(values),
        options: Options(
          headers: headers,
          receiveTimeout: receiveTimeout,
          extra: authority == null ? null : {_requestAuthorityKey: authority},
        ),
      ),
    );
  }

  Future<ResponseBody> getStream(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    try {
      final response = await _dio.get<ResponseBody>(
        path,
        queryParameters: query,
        options: Options(responseType: ResponseType.stream),
      );
      final body = response.data;
      if (body == null) throw const ApiException('The stream was empty.');
      return body;
    } on DioException catch (error) {
      throw await _streamApiException(error);
    }
  }

  Future<Uint8List> getBytes(
    String path, {
    Map<String, dynamic>? query,
    int maximumBytes = 64 * 1024 * 1024,
  }) async {
    if (maximumBytes <= 0 || maximumBytes > 64 * 1024 * 1024) {
      throw ArgumentError.value(maximumBytes, 'maximumBytes');
    }
    final body = await getStream(path, query: query);
    final builder = BytesBuilder(copy: false);
    await for (final chunk in body.stream) {
      if (builder.length + chunk.length > maximumBytes) {
        throw const ApiException(
          'This artifact is too large for the in-app preview.',
        );
      }
      builder.add(chunk);
    }
    return builder.takeBytes();
  }

  Future<ResponseBody> postStream(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
    Duration? receiveTimeout,
  }) async {
    try {
      final response = await _dio.post<ResponseBody>(
        path,
        data: data,
        options: Options(
          responseType: ResponseType.stream,
          headers: headers,
          receiveTimeout: receiveTimeout,
        ),
      );
      final body = response.data;
      if (body == null) throw const ApiException('The stream was empty.');
      return body;
    } on DioException catch (error) {
      throw await _streamApiException(error);
    }
  }

  Future<Map<String, dynamic>> _json(
    Future<Response<Object?>> Function() request,
  ) async {
    try {
      final response = await request();
      final value = response.data;
      if (value is Map<String, dynamic>) return value;
      if (value is Map) return Map<String, dynamic>.from(value);
      throw const ApiException('The service returned an invalid response.');
    } on DioException catch (error) {
      throw ApiException.fromDio(error);
    }
  }
}

Future<ApiException> _streamApiException(DioException error) async {
  final statusCode = error.response?.statusCode;
  final body = error.response?.data;
  if (statusCode == null || body is! ResponseBody) {
    return ApiException.fromDio(error);
  }
  Map<String, dynamic>? payload;
  try {
    const maximumBytes = 32 * 1024;
    final bytes = BytesBuilder(copy: false);
    await for (final chunk in body.stream) {
      if (bytes.length + chunk.length > maximumBytes) {
        payload = null;
        break;
      }
      bytes.add(chunk);
    }
    if (bytes.length > 0) {
      final decoded = jsonDecode(utf8.decode(bytes.takeBytes()));
      if (decoded is Map) payload = Map<String, dynamic>.from(decoded);
    }
  } catch (_) {
    payload = null;
  }
  final nestedError = payload?['error'];
  final message = nestedError is Map
      ? (nestedError['message'] ?? nestedError['code'])?.toString()
      : (payload?['message'] ?? nestedError)?.toString();
  if (statusCode == 409) {
    return ApiConflictException(
      message ?? 'The requested state changed. Refresh and try again.',
      serverState: payload?['current'] is Map
          ? Map<String, dynamic>.from(payload!['current'] as Map)
          : null,
      diagnosticCode: error.type.name,
    );
  }
  final fallback = ApiException.fromDio(error);
  return ApiException(
    message ?? fallback.message,
    statusCode: statusCode,
    diagnosticCode: error.type.name,
  );
}

bool _canUseOfflineProjection(ApiException error) =>
    error.statusCode == null ||
    const {408, 429, 500, 502, 503, 504}.contains(error.statusCode);

/// Offline fallback is deliberately allowlisted. Private control-plane reads
/// (approvals, settings, device state, operations, push, payments, and agent
/// governance) must never silently receive a generic month-old response.
Duration? _offlineProjectionMaxAge(String value) {
  final path = Uri.tryParse(value)?.path ?? value.split('?').first;
  if (path == NativePaths.bootstrapGet) return const Duration(hours: 1);
  if (_isPathWithin(path, '/api/market')) return const Duration(minutes: 15);
  if (_isPathWithin(path, '/api/today')) return const Duration(hours: 6);
  if (_isPathWithin(path, '/api/meetings')) return const Duration(hours: 12);
  if (const <String>{
    '/api/projects',
    '/api/memory',
    '/api/knowledge',
    '/api/missions',
    '/api/customer-accounts',
    '/api/threads',
    '/api/artifacts',
  }.any((prefix) => _isPathWithin(path, prefix))) {
    return const Duration(hours: 24);
  }
  return null;
}

bool _isPathWithin(String path, String prefix) =>
    path == prefix || path.startsWith('$prefix/');

Future<bool> _clearAndAcknowledgeRemoteWipe(
  Dio dio,
  SecureSessionStore store,
) async {
  final accessToken = await store.readTokenForRemoteWipe();
  final expectedDeviceId = await store.readExistingDeviceId();
  if (accessToken == null || expectedDeviceId == null) return false;

  Map<String, dynamic> challenge;
  try {
    final response = await dio.get<Object?>(
      NativePaths.wipeChallenge,
      options: Options(
        headers: {
          ...NativeClientInfo.attestationHeaders(),
          'Authorization': 'Bearer $accessToken',
        },
        receiveTimeout: const Duration(seconds: 5),
      ),
    );
    if (response.data is! Map) return false;
    challenge = Map<String, dynamic>.from(response.data as Map);
  } on DioException {
    return false;
  }

  final deviceId = challenge['deviceId']?.toString();
  final acknowledgementToken = challenge['acknowledgementToken']?.toString();
  if (challenge['wipeRequired'] != true ||
      deviceId != expectedDeviceId ||
      acknowledgementToken == null ||
      acknowledgementToken.length < 32) {
    return false;
  }

  // Local erasure is the security boundary. Acknowledgement is best effort and
  // never restores credentials if the follow-up request cannot be delivered.
  await store.clearForRemoteWipe();
  try {
    await dio.post<Object?>(
      NativePaths.wipeAcknowledge,
      data: {
        'acknowledgementToken': acknowledgementToken,
        'deviceId': deviceId,
      },
      options: Options(
        headers: NativeClientInfo.attestationHeaders(),
        receiveTimeout: const Duration(seconds: 5),
      ),
    );
  } on DioException {
    // The server truthfully remains wipe_pending until a later acknowledgement.
  }
  return true;
}
