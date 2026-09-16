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
    final resolvedMessage =
        message ?? 'The command service could not be reached.';
    final statusCode = error.response?.statusCode;
    if (statusCode == 409) {
      return ApiConflictException(
        resolvedMessage,
        serverState: data is Map && data['current'] is Map
            ? Map<String, dynamic>.from(data['current'] as Map)
            : null,
      );
    }
    return ApiException(resolvedMessage, statusCode: statusCode);
  }

  final String message;
  final int? statusCode;

  @override
  String toString() => message;
}

class ApiConflictException extends ApiException {
  const ApiConflictException(super.message, {this.serverState})
    : super(statusCode: 409);

  final Map<String, dynamic>? serverState;
}
