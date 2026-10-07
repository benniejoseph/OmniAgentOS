import 'package:asael/core/network/api_exception.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

ApiException responseError(Object? data, {int status = 409}) {
  final request = RequestOptions(path: '/api/projects/project-one');
  return ApiException.fromDio(
    DioException(
      requestOptions: request,
      response: Response<Object?>(
        requestOptions: request,
        statusCode: status,
        data: data,
      ),
      type: DioExceptionType.badResponse,
    ),
  );
}

void main() {
  test(
    'only a local pre-dispatch cancellation preserves authority refusal',
    () {
      const refusal = NativeAuthorityVerificationException();
      final request = RequestOptions(path: '/private');
      expect(
        ApiException.fromDio(
          DioException(
            requestOptions: request,
            type: DioExceptionType.cancel,
            error: refusal,
          ),
        ),
        same(refusal),
      );
      expect(refusal.statusCode, isNull);
      expect(refusal.responseData, isNull);
      for (final type in [
        DioExceptionType.badResponse,
        DioExceptionType.unknown,
      ]) {
        expect(
          ApiException.fromDio(
            DioException(requestOptions: request, type: type, error: refusal),
          ),
          isNot(isA<NativeAuthorityVerificationException>()),
        );
      }
      expect(
        ApiException.fromDio(
          DioException(
            requestOptions: request,
            type: DioExceptionType.cancel,
            error: refusal,
            response: Response<Object?>(
              requestOptions: request,
              statusCode: 403,
            ),
          ),
        ),
        isNot(isA<NativeAuthorityVerificationException>()),
      );
      expect(
        responseError({
          'error': 'native_authority_refused',
          'diagnosticCode': 'native_authority_refused',
          'type': 'NativeAuthorityVerificationException',
        }, status: 503),
        isNot(isA<NativeAuthorityVerificationException>()),
      );
    },
  );

  test(
    'retains exact conflict evidence as a detached deeply immutable JSON map',
    () {
      final body = <String, dynamic>{
        'error': 'The reviewed project changed.',
        'admission': 'not_admitted',
        'evaluationId': 'evaluation-one',
        'requestSha256': 'digest-one',
        'current': <String, dynamic>{'revision': 4},
        'details': <Object?>[
          <String, dynamic>{'code': 'changed'},
        ],
      };
      final error = responseError(body);
      expect(error, isA<ApiConflictException>());
      expect(error.statusCode, 409);
      expect(error.responseData, body);
      expect((error as ApiConflictException).serverState, {'revision': 4});
      body['admission'] = 'changed after parsing';
      (body['details'] as List).clear();
      expect(error.responseData!['admission'], 'not_admitted');
      final details = error.responseData!['details'] as List;
      expect(details, [
        {'code': 'changed'},
      ]);
      expect(
        () => error.responseData!['admission'] = 'changed',
        throwsUnsupportedError,
      );
      expect(() => details.add('changed'), throwsUnsupportedError);
      expect(
        () => (details.first as Map)['code'] = 'changed',
        throwsUnsupportedError,
      );
    },
  );

  test(
    'retains bounded error evidence without changing non-conflict status',
    () {
      final error = responseError({
        'error': 'Unavailable',
        'code': 'unavailable',
      }, status: 503);
      expect(error, isNot(isA<ApiConflictException>()));
      expect(error.statusCode, 503);
      expect(error.responseData, {
        'error': 'Unavailable',
        'code': 'unavailable',
      });
    },
  );

  test(
    'drops oversized, non-JSON, cyclic and deeply nested response evidence',
    () {
      final cyclic = <String, dynamic>{};
      cyclic['cycle'] = cyclic;
      Object? nested = 'leaf';
      for (var i = 0; i < 18; i++) {
        nested = {'next': nested};
      }
      for (final body in <Object?>[
        {'text': 'x' * 32769},
        {'text': 'é' * 20000},
        {'value': double.infinity},
        {'value': Object()},
        {1: 'invalid key'},
        {'items': List.filled(257, null)},
        cyclic,
        nested,
        ['not an object'],
      ]) {
        expect(responseError(body).responseData, isNull);
      }
    },
  );
}
