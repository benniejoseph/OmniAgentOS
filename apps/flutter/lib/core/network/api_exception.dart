import 'package:dio/dio.dart';

class ApiException implements Exception {
  const ApiException(this.message, {this.statusCode});

  factory ApiException.fromDio(DioException error) {
    final data = error.response?.data;
    final message = data is Map
        ? (data['message'] ?? data['error'])?.toString()
        : null;
    return ApiException(
      message ?? 'The command service could not be reached.',
      statusCode: error.response?.statusCode,
    );
  }

  final String message;
  final int? statusCode;

  @override
  String toString() => message;
}
