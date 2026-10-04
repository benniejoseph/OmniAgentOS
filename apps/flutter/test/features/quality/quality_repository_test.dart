import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/quality/quality_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'quality_test_fixtures.dart';
import 'quality_test_support.dart';

void main() {
  test('the two authorized reads use fixed paths, exact authority and no force flags', () async {
    final api = QualityTestApi();
    api.reader = (path) async => path == '/api/evaluations'
        ? qualityEvaluationsJson()
        : qualityReleaseJson();
    final access = qualityAccess(api), cancel = CancelToken();
    final repo = ApiQualityRepository(access);
    await repo.evaluations(cancel);
    await repo.release(cancel);
    expect(api.paths, ['/api/evaluations', '/api/release/evidence']);
    expect(
      api.authorities.every((value) => identical(value, access.authority)),
      isTrue,
    );
    expect(api.tokens.every((value) => identical(value, cancel)), isTrue);
    repo.dispose();
  });

  test('operators retain evaluations but release and viewer reads dispatch nothing', () async {
    final api = QualityTestApi()
      ..reader = (_) async => qualityEvaluationsJson();
    final operator = ApiQualityRepository(qualityAccess(api, role: 'operator'));
    await operator.evaluations(CancelToken());
    await expectLater(
      operator.release(CancelToken()),
      throwsA(isA<ApiException>().having((e) => e.statusCode, 'status', 403)),
    );
    final viewer = ApiQualityRepository(qualityAccess(api, role: 'viewer'));
    await expectLater(viewer.evaluations(CancelToken()), throwsStateError);
    expect(api.paths, ['/api/evaluations']);
    operator.dispose();
    viewer.dispose();
  });

  test(
    'read admission and late completion recheck the exact live authority',
    () async {
      final api = QualityTestApi();
      final held = Completer<Map<String, dynamic>>();
      api.reader = (_) => held.future;
      var active = true;
      final repo = ApiQualityRepository(
        qualityAccess(api, current: () => active),
      );
      final read = repo.evaluations(CancelToken());
      final rejected = expectLater(read, throwsStateError);
      active = false;
      held.complete(qualityEvaluationsJson());
      await rejected;
      await expectLater(repo.evaluations(CancelToken()), throwsStateError);
      expect(api.paths, hasLength(1));
      repo.dispose();
      late ApiQualityRepository outgoing;
      outgoing = ApiQualityRepository(
        qualityAccess(
          api,
          current: () {
            outgoing.dispose();
            return true;
          },
        ),
      );
      await expectLater(outgoing.evaluations(CancelToken()), throwsStateError);
      expect(api.paths, hasLength(1));
    },
  );

  test('repository teardown synchronously invalidates observers and cancels held transport', () async {
    final api = QualityTestApi();
    final held = Completer<Map<String, dynamic>>();
    api.reader = (_) => held.future;
    final repo = ApiQualityRepository(qualityAccess(api));
    var invalidations = 0;
    repo.observeInvalidation(() => invalidations++);
    final read = repo.release(CancelToken());
    final rejected = expectLater(read, throwsStateError);
    repo.dispose();
    expect(invalidations, 1);
    expect(api.tokens.single.isCancelled, isTrue);
    held.complete(qualityReleaseJson());
    await rejected;
    repo.dispose();
    expect(invalidations, 1);
  });

  test('wrong-tenant response cannot become typed evidence', () async {
    final api = QualityTestApi();
    api.reader = (path) async => path == '/api/evaluations'
        ? qualityEvaluationsJson(tenantId: 'other')
        : qualityReleaseJson(tenantId: 'other');
    final repo = ApiQualityRepository(qualityAccess(api));
    await expectLater(repo.evaluations(CancelToken()), throwsFormatException);
    await expectLater(repo.release(CancelToken()), throwsFormatException);
    repo.dispose();
  });
}
