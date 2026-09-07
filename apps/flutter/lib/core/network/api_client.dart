import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/native_client_info.dart';
import '../config/app_config.dart';
import '../storage/secure_session_store.dart';
import '../../generated/native_contract.g.dart';
import 'api_exception.dart';

final apiClientProvider = Provider<ApiClient>((ref) {
  final store = ref.watch(secureSessionStoreProvider);
  final dio = Dio(_baseOptions());
  final refreshDio = Dio(_baseOptions());
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
  return ApiClient(dio, refreshDio, store);
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
  const ApiClient(this._dio, this._rawDio, this._store);
  final Dio _dio;
  final Dio _rawDio;
  final SecureSessionStore _store;

  Future<bool> clearAndAcknowledgeRemoteWipe() =>
      _clearAndAcknowledgeRemoteWipe(_rawDio, _store);

  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, dynamic>? query,
  }) => _json(() => _dio.get<Object?>(path, queryParameters: query));

  Future<Map<String, dynamic>> postJson(
    String path, {
    Map<String, dynamic>? data,
  }) => _json(() => _dio.post<Object?>(path, data: data));

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

  Future<Map<String, dynamic>> deleteJson(
    String path, {
    Map<String, dynamic>? query,
  }) => _json(() => _dio.delete<Object?>(path, queryParameters: query));

  Future<Map<String, dynamic>> postMultipart(
    String path, {
    required Map<String, dynamic> fields,
    Uint8List? bytes,
    String? filename,
    String? contentType,
    String fileField = 'file',
    Map<String, dynamic>? headers,
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
        options: Options(headers: headers),
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
      throw ApiException.fromDio(error);
    }
  }

  Future<ResponseBody> postStream(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    try {
      final response = await _dio.post<ResponseBody>(
        path,
        data: data,
        options: Options(responseType: ResponseType.stream, headers: headers),
      );
      final body = response.data;
      if (body == null) throw const ApiException('The stream was empty.');
      return body;
    } on DioException catch (error) {
      throw ApiException.fromDio(error);
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
