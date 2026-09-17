import 'package:dio/dio.dart';

class ApiException implements Exception {
  const ApiException(this.message, {this.statusCode, this.diagnosticCode});

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
        message ??
        switch (error.type) {
          DioExceptionType.connectionTimeout =>
            'Asael could not establish the live connection in time.',
          DioExceptionType.sendTimeout =>
            'Asael could not finish sending the command in time.',
          DioExceptionType.receiveTimeout => 'The live response paused before the governed run completed. The run may still finish in History.',
          DioExceptionType.connectionError => 'The live connection ended before the governed run completed. The run may still finish in History.',
          DioExceptionType.cancel => 'The live response was canceled.',
          _ => 'The command service could not be reached.',
        };
    final statusCode = error.response?.statusCode;
    if (statusCode == 409) {
      return ApiConflictException(
        resolvedMessage,
        serverState: data is Map && data['current'] is Map
            ? Map<String, dynamic>.from(data['current'] as Map)
            : null,
        diagnosticCode: error.type.name,
      );
    }
    return ApiException(
      resolvedMessage,
      statusCode: statusCode,
      diagnosticCode: error.type.name,
    );
  }

  final String message;
  final int? statusCode;
  final String? diagnosticCode;

  @override
  String toString() => message;
}

class ApiConflictException extends ApiException {
  const ApiConflictException(
    super.message, {
    this.serverState,
    super.diagnosticCode,
  }) : super(statusCode: 409);

  final Map<String, dynamic>? serverState;
}
