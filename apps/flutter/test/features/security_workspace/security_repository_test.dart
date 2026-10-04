import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/security/security_controller.dart';
import 'package:asael/features/security/security_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'security_test_support.dart';

void main() {
  test(
    'four existing GETs bind exact current authority without effect parameters',
    () async {
      final api = SecurityTestApi();
      final access = securityAccess(api),
          repo = ApiSecurityRepository(securityAccess(api));
      addTearDown(repo.dispose);
      await repo.context(CancelToken());
      await repo.audits(CancelToken());
      await repo.isolation(CancelToken());
      await repo.retention(CancelToken());
      expect(api.paths, [
        '/api/security/context',
        '/api/security/audits',
        '/api/security/isolation-report',
        '/api/security/retention',
      ]);
      expect(api.queries, everyElement(isNull));
      expect(
        api.authorities.map(
          (authority) => (
            authority.apiBaseUrl,
            authority.tenantId,
            authority.actorId,
            authority.canonicalUserId,
            authority.role,
          ),
        ),
        everyElement((
          access.authority.apiBaseUrl,
          access.authority.tenantId,
          'owner@example.test',
          securityUser,
          'admin',
        )),
      );
    },
  );
  test('operator context dispatches alone and viewer is gated before any transport', () async {
    final api = SecurityTestApi()
      ..reader = (_) async => securityContextJson(role: 'operator');
    final repo = ApiSecurityRepository(securityAccess(api, role: 'operator'));
    addTearDown(repo.dispose);
    expect((await repo.context(CancelToken())).role.name, 'operator');
    for (final read in [repo.audits, repo.isolation, repo.retention]) {
      await expectLater(
        read(CancelToken()),
        throwsA(
          isA<ApiException>().having(
            (error) => error.statusCode,
            'status',
            403,
          ),
        ),
      );
    }
    expect(api.paths, ['/api/security/context']);
    final viewer = ApiSecurityRepository(securityAccess(api, role: 'viewer'));
    addTearDown(viewer.dispose);
    await expectLater(viewer.context(CancelToken()), throwsStateError);
    expect(api.paths, hasLength(1));
  });
  test('repository disposal synchronously silently clears outgoing data and cancels late reads', () async {
    final api = SecurityTestApi();
    final repository = ApiSecurityRepository(securityAccess(api));
    final controller = SecurityController(repository);
    final detach = repository.observeInvalidation(
      () => controller.invalidate(notify: false),
    );
    addTearDown(() {
      detach();
      controller.dispose();
      repository.dispose();
    });
    await controller.refresh();
    controller.select('read.security');
    final held = Completer<Map<String, dynamic>>();
    api.reader = (_) => held.future;
    final pending = controller.refreshSource(SecuritySource.audits);
    await Future<void>.value();
    var notifications = 0;
    controller.addListener(() => notifications++);
    repository.dispose();
    expect(controller.context.data, isNull);
    expect(controller.isolation.data, isNull);
    expect(controller.selectedId, isNull);
    expect(controller.available, isFalse);
    expect(api.tokens.last.isCancelled, isTrue);
    expect(notifications, 0);
    held.complete(securityAuditsJson());
    await pending;
    expect(controller.audits.data, isNull);
  });
  test('disposal during authority probe cannot dispatch transport', () async {
    final api = SecurityTestApi();
    late ApiSecurityRepository repo;
    repo = ApiSecurityRepository(
      securityAccess(
        api,
        current: () {
          repo.dispose();
          return true;
        },
      ),
    );
    await expectLater(repo.context(CancelToken()), throwsStateError);
    expect(api.paths, isEmpty);
  });
  test(
    'scope change before response decoding discards the fetched evidence',
    () async {
      var current = true;
      final api = SecurityTestApi();
      final repo = ApiSecurityRepository(
        securityAccess(api, current: () => current),
      );
      addTearDown(repo.dispose);
      api.reader = (path) async {
        current = false;
        return securityResponse(path);
      };
      await expectLater(repo.audits(CancelToken()), throwsStateError);
    },
  );
}
