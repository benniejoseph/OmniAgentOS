import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/app_config.dart';
import '../storage/secure_session_store.dart';
import 'api_exception.dart';

final dioProvider = Provider<Dio>((ref) {
  final store = ref.watch(secureSessionStoreProvider);
  final dio = Dio(
    BaseOptions(
      baseUrl: AppConfig.apiBaseUrl,
      connectTimeout: const Duration(seconds: 12),
      receiveTimeout: const Duration(seconds: 30),
      headers: const {'Accept': 'application/json'},
    ),
  );
  dio.interceptors.add(
    InterceptorsWrapper(
      onRequest: (options, handler) async {
        final token = await store.readToken();
        if (token != null) options.headers['Authorization'] = 'Bearer $token';
        handler.next(options);
      },
    ),
  );
  return dio;
});

class ApiClient {
  const ApiClient(this._dio);
  final Dio _dio;

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
  }) => _json(() => _dio.patch<Object?>(path, data: data));

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
    Map<String, dynamic>? headers,
  }) async {
    final values = <String, dynamic>{...fields};
    if (bytes != null) {
      values['file'] = MultipartFile.fromBytes(
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

final apiClientProvider = Provider<ApiClient>(
  (ref) => ApiClient(ref.watch(dioProvider)),
);
