import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/native_client_info.dart';
import '../config/app_config.dart';
import '../storage/offline_projection_store.dart';
import '../storage/secure_session_store.dart';
import '../../generated/native_contract.g.dart';
import 'api_exception.dart';

final apiClientProvider = Provider<ApiClient>((ref) {
  final store = ref.watch(secureSessionStoreProvider);
  final dio = Dio(_baseOptions());
  final refreshDio = Dio(_baseOptions());
  final projectionStore = EncryptedOfflineProjectionStore(
    store.readOrCreateOfflineProjectionSecret,
  );
  Future<void>? refreshInFlight;

  Future<void> refreshSession() async {
    final refreshToken = await store.readRefreshToken();
    if (refreshToken == null || refreshToken.isEmpty) {
      throw StateError('No native refresh credential is available.');
    }
    final deviceId = await store.readOrCreateDeviceId();
    Response<Object?> response;
    try {
      try {
        response = await refreshDio.post<Object?>(
          NativePaths.authRefresh,
          data: {
            'refreshToken': refreshToken,
            'deviceId': deviceId,
            'client': NativeClientInfo.attestation(),
          },
        );
      } on DioException catch (error) {
        if (error.response?.statusCode != 400) rethrow;
        response = await refreshDio.post<Object?>(
          NativePaths.authRefresh,
          data: {'refreshToken': refreshToken, 'deviceId': deviceId},
        );
      }
      await _persistNativeTokens(store, response.data);
    } on DioException catch (error) {
      if (error.response?.statusCode == 401) {
        final wiped = await _clearAndAcknowledgeRemoteWipe(refreshDio, store);
        if (!wiped) await store.clear();
      }
      rethrow;
    }
  }

  Future<void> ensureRefreshed() async {
    final existing = refreshInFlight;
    if (existing != null) return existing;
    final created = refreshSession();
    refreshInFlight = created;
    try {
      await created;
    } finally {
      if (identical(refreshInFlight, created)) refreshInFlight = null;
    }
  }

  dio.interceptors.add(
    InterceptorsWrapper(
      onRequest: (options, handler) async {
        options.headers.addAll(NativeClientInfo.attestationHeaders());
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
          await ensureRefreshed();
          final token = await store.readToken();
          if (token == null) {
            handler.next(error);
            return;
          }
          request.headers['Authorization'] = 'Bearer $token';
          request.extra['asaelNativeRefreshRetried'] = true;
          handler.resolve(await dio.fetch<Object?>(request));
        } catch (_) {
          handler.next(error);
        }
      },
    ),
  );
  return ApiClient(dio, refreshDio, store, projectionStore);
});

BaseOptions _baseOptions() => BaseOptions(
  baseUrl: AppConfig.apiBaseUrl,
  connectTimeout: const Duration(seconds: 12),
  receiveTimeout: const Duration(seconds: 30),
  headers: const {'Accept': 'application/json'},
);

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
  ]);
  final Dio _dio;
  final Dio _rawDio;
  final SecureSessionStore _store;
  final OfflineProjectionStore? _projectionStore;

  Future<bool> clearAndAcknowledgeRemoteWipe() =>
      _clearAndAcknowledgeRemoteWipe(_rawDio, _store);

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
  }) async {
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
        options: Options(headers: headers, receiveTimeout: receiveTimeout),
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
