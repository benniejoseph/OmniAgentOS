import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/computer_use/local_computer.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

const _commandId =
    'local_computer_command_0123456789abcdef0123456789abcdef0123456789abcdef';
const _claimToken = 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789';
const _failure = {
  'schemaVersion': 1,
  'code': 'click_target_covered',
  'phase': 'element_hit_test',
  'reason': 'hit_outside_chosen_element',
};
const _legacySchemaRefusal = ApiException(
  'The local Computer Use completion is invalid.',
  statusCode: 400,
  responseData: {
    'error': {
      'code': 'invalid_request',
      'message': 'The local Computer Use completion is invalid.',
    },
  },
);

void main() {
  test('a supporting server receives the exact refusal receipt once', () async {
    final api = _Api();
    final completion = _completion();
    await ApiLocalComputerRepository(api).complete(completion);
    expect(api.requests.single.data, completion.payload);
    expect(
      api.requests.single.path,
      NativePaths.localComputerCommandComplete(_commandId),
    );
    expect(api.requests.single.headers, {
      'idempotency-key': 'local-computer-complete-$_commandId-1',
    });
  });

  test(
    'claim then server rollback removes only unsupported receipt metadata',
    () async {
      final api = _Api()..failures.add(_legacySchemaRefusal);
      final completion = _completion();
      await ApiLocalComputerRepository(api).complete(completion);
      expect(api.requests, hasLength(2));
      expect(api.requests.first.data, completion.payload);
      expect(api.requests.last.data, _legacyPayload(completion));
      expect(api.requests.last.path, api.requests.first.path);
      expect(api.requests.last.headers, api.requests.first.headers);
      expect(completion.payload['failure'], _failure);
    },
  );

  test(
    'a transient fallback failure retries the same legacy receipt identity',
    () async {
      final api = _Api()
        ..failures.addAll([
          _legacySchemaRefusal,
          const ApiException('Transport interrupted.'),
        ]);
      final repository = ApiLocalComputerRepository(api);
      final completion = _completion();
      await expectLater(
        repository.complete(completion),
        throwsA(isA<ApiException>()),
      );
      await repository.complete(completion);
      expect(api.requests, hasLength(3));
      expect(api.requests[1].data, _legacyPayload(completion));
      expect(api.requests[2].data, api.requests[1].data);
      expect(api.requests[2].headers, api.requests[0].headers);
      expect(api.requests[2].path, api.requests[0].path);
    },
  );

  test(
    'an ambiguous earlier completion never downgrades an accepted receipt',
    () async {
      final api = _Api()
        ..failures.addAll([
          const ApiException('Response lost after a possible write.'),
          _legacySchemaRefusal,
        ]);
      final repository = ApiLocalComputerRepository(api);
      final completion = _completion();
      await expectLater(
        repository.complete(completion),
        throwsA(isA<ApiException>()),
      );
      await expectLater(
        repository.complete(completion),
        throwsA(isA<ApiException>()),
      );
      expect(api.requests, hasLength(2));
      for (final request in api.requests) {
        expect(request.data, completion.payload);
        expect(request.headers, api.requests.first.headers);
      }
    },
  );

  test(
    'a malformed acknowledgement also pins the exact attempted receipt',
    () async {
      final api = _Api()..receipt = {'accepted': true};
      final repository = ApiLocalComputerRepository(api);
      final completion = _completion();
      await expectLater(repository.complete(completion), throwsFormatException);
      api.failures.add(_legacySchemaRefusal);
      await expectLater(
        repository.complete(completion),
        throwsA(isA<ApiException>()),
      );
      expect(api.requests, hasLength(2));
      expect(api.requests.last.data, completion.payload);
    },
  );

  test(
    'unrelated HTTP errors never remove refusal evidence or resend immediately',
    () async {
      for (final refusal in [
        const ApiException('Unavailable.', statusCode: 503),
        const ApiException('Invalid.', statusCode: 400),
        const ApiException(
          'Different invalid request.',
          statusCode: 400,
          responseData: {
            'error': {
              'code': 'invalid_request',
              'message': 'Something else is invalid.',
            },
          },
        ),
        const ApiException(
          'Forbidden.',
          statusCode: 403,
          responseData: {
            'error': {'code': 'forbidden'},
          },
        ),
      ]) {
        final api = _Api()..failures.add(refusal);
        final completion = _completion();
        await expectLater(
          ApiLocalComputerRepository(api).complete(completion),
          throwsA(same(refusal)),
        );
        expect(api.requests, hasLength(1));
        expect(api.requests.single.data, completion.payload);
      }
    },
  );

  test('a legacy completion never performs compatibility fallback', () async {
    final api = _Api()..failures.add(_legacySchemaRefusal);
    final completion = _completion(includeFailure: false);
    await expectLater(
      ApiLocalComputerRepository(api).complete(completion),
      throwsA(same(_legacySchemaRefusal)),
    );
    expect(api.requests, hasLength(1));
  });
}

LocalComputerCompletion _completion({bool includeFailure = true}) =>
    LocalComputerCompletion(
      commandId: _commandId,
      runId: 'run-native-refusal',
      executionId: 'run-native-refusal:click',
      claimToken: _claimToken,
      claimGeneration: 1,
      expiresAt: DateTime.now().toUtc().add(const Duration(seconds: 30)),
      payload: {
        'schemaVersion': 1,
        'claimToken': _claimToken,
        'outcome': 'failed',
        'errorCode': 'click_target_covered',
        if (includeFailure) 'failure': _failure,
      },
    );

Map<String, dynamic> _legacyPayload(LocalComputerCompletion completion) =>
    Map<String, dynamic>.from(completion.payload)..remove('failure');

class _Api extends ApiClient {
  _Api()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  final failures = <ApiException>[];
  final requests =
      <
        ({
          String path,
          Map<String, dynamic>? data,
          Map<String, dynamic>? headers,
        })
      >[];
  Map<String, dynamic> receipt = {
    'schemaVersion': 1,
    'accepted': true,
    'commandId': _commandId,
  };

  @override
  Future<Map<String, dynamic>> postJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    requests.add((path: path, data: data, headers: headers));
    if (failures.isNotEmpty) throw failures.removeAt(0);
    return receipt;
  }
}
