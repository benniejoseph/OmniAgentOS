import 'package:dio/dio.dart';

class ApiException implements Exception {
  const ApiException(this.message, {this.statusCode});

  factory ApiException.fromDio(DioException error) {
    final data = error.response?.data;
    String? message;
    if (data is Map) {
      final nestedError = data['error'];
      if (nestedError is Map) {
        message = (nestedError['message'] ?? nestedError['code'])?.toString();
      } else {
        message = (data['message'] ?? nestedError)?.toString();
      }
    }
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
