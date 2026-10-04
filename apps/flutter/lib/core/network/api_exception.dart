import 'dart:convert';

import 'package:dio/dio.dart';

class ApiException implements Exception {
  const ApiException(
    this.message, {
    this.statusCode,
    this.diagnosticCode,
    this.responseData,
  });

  factory ApiException.fromDio(DioException error) {
    // This marker is created locally before dispatch. A response body cannot
    // manufacture it, and it deliberately carries no synthetic HTTP status.
    final localRefusal = error.error;
    if (error.type == DioExceptionType.cancel &&
        error.response == null &&
        localRefusal is NativeAuthorityVerificationException) {
      return localRefusal;
    }
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
    final responseData = _boundedResponseData(data);
    if (statusCode == 409) {
      return ApiConflictException(
        resolvedMessage,
        serverState: data is Map && data['current'] is Map
            ? Map<String, dynamic>.from(data['current'] as Map)
            : null,
        diagnosticCode: error.type.name,
        responseData: responseData,
      );
    }
    return ApiException(
      resolvedMessage,
      statusCode: statusCode,
      diagnosticCode: error.type.name,
      responseData: responseData,
    );
  }

  final String message;
  final int? statusCode;
  final String? diagnosticCode;

  /// Untrusted response evidence. Consumers must validate the complete contract
  /// and request identity before interpreting a refusal as proof of no effect.
  /// The Dio factory retains only bounded, deeply immutable JSON objects.
  final Map<String, dynamic>? responseData;

  @override
  String toString() => message;
}

/// The current private-request authority was refused before dispatch. This is
/// distinct from a canceled request or an unavailable bootstrap transport.
class NativeAuthorityVerificationException extends ApiException {
  const NativeAuthorityVerificationException([
    super.message = 'Current workspace access could not be verified. Reopen the workspace or sign in again.',
  ]) : super(diagnosticCode: 'native_authority_refused');
}

class ApiConflictException extends ApiException {
  const ApiConflictException(
    super.message, {
    this.serverState,
    super.diagnosticCode,
    super.responseData,
  }) : super(statusCode: 409);

  final Map<String, dynamic>? serverState;
}

Map<String, dynamic>? _boundedResponseData(Object? data) {
  const maximumBytes = 32 * 1024;
  var remainingNodes = 1024;
  var remainingStringBytes = maximumBytes;
  void countString(String value) {
    if (value.length > maximumBytes ||
        (remainingStringBytes -= utf8.encode(value).length) < 0) {
      throw const FormatException('Response evidence exceeds its byte bound.');
    }
  }

  Object? copy(Object? value, int depth) {
    if (--remainingNodes < 0 || depth > 16) {
      throw const FormatException('Response evidence exceeds its bounds.');
    }
    if (value == null || value is bool || value is int) return value;
    if (value is double && value.isFinite) return value;
    if (value is String) {
      countString(value);
      return value;
    }
    if (value is List && value.length <= 256) {
      return List<Object?>.unmodifiable(
        value.map((item) => copy(item, depth + 1)),
      );
    }
    if (value is Map && value.length <= 256) {
      final result = <String, dynamic>{};
      for (final entry in value.entries) {
        final key = entry.key;
        if (key is! String || key.length > maximumBytes) {
          throw const FormatException('Response evidence has an invalid key.');
        }
        countString(key);
        result[key] = copy(entry.value, depth + 1);
      }
      return Map<String, dynamic>.unmodifiable(result);
    }
    throw const FormatException('Response evidence is not bounded JSON.');
  }

  try {
    if (data is! Map) return null;
    final result = copy(data, 0) as Map<String, dynamic>;
    if (utf8.encode(jsonEncode(result)).length > maximumBytes) return null;
    return result;
  } on FormatException {
    return null;
  }
}
