import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/security/security_contracts.dart';
import 'package:asael/features/security/security_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'security_test_support.dart';

void main() {
  test('coalesced refreshes isolate ordinary source failures', () async {
    final repo = SecurityTestRepository();
    final controller = SecurityController(repo);
    addTearDown(controller.dispose);
    final first = controller.refresh(), repeated = controller.refresh();
    await Future<void>.value();
    expect(repo.contextRequests, hasLength(1));
    expect(repo.auditRequests, hasLength(1));
    expect(repo.isolationRequests, hasLength(1));
    expect(repo.retentionRequests, hasLength(1));
    repo.isolationRequests.single.result.completeError(
      const FormatException('Malformed evidence'),
    );
    repo.completeAll();
    await Future.wait([first, repeated]);
    expect(controller.isolation.state, SecurityLoadState.failed);
    expect(controller.context.data, isNotNull);
    expect(controller.audits.data, isNotNull);
    expect(controller.retention.data, isNotNull);
    expect(controller.loading, isFalse);
  });
  test(
    'synchronous failures settle registered pending reads and permit retry',
    () async {
      final repo = SecurityTestRepository()
        ..synchronousFailure = const ApiException('No connection');
      final c = SecurityController(repo);
      addTearDown(c.dispose);
      await c.refresh();
      expect(c.loading, isFalse);
      expect(c.context.state, SecurityLoadState.failed);
      repo.synchronousFailure = null;
      final pending = c.refresh();
      await Future<void>.value();
      repo.completeAll();
      await pending;
      expect(c.context.state, SecurityLoadState.ready);
    },
  );
  test('operator receives context and explicit private restrictions without dispatch', () async {
    final repo = SecurityTestRepository()..privateAllowed = false;
    final c = SecurityController(repo);
    addTearDown(c.dispose);
    final pending = c.refresh();
    await Future<void>.value();
    repo.completeAll();
    await pending;
    expect(c.context.data!.role, SecurityRole.operator);
    for (final source in [
      SecuritySource.audits,
      SecuritySource.isolation,
      SecuritySource.retention,
    ]) {
      expect(c.lane(source).state, SecurityLoadState.restricted);
    }
    expect(repo.auditRequests, isEmpty);
    expect(repo.isolationRequests, isEmpty);
    expect(repo.retentionRequests, isEmpty);
    expect(c.loading, isFalse);
  });
  test('private403 cancels and clears all private evidence while context remains current', () async {
    final repo = SecurityTestRepository();
    final controller = SecurityController(repo);
    addTearDown(controller.dispose);
    final initial = controller.refresh();
    await Future<void>.value();
    repo.completeAll();
    await initial;
    controller.selectSection(SecuritySection.audits);
    controller.select('audit-1');
    final denied = controller.refreshSource(SecuritySource.retention),
        held = controller.refreshSource(SecuritySource.isolation);
    await Future<void>.value();
    repo.retentionRequests.last.result.completeError(
      const ApiException('Forbidden', statusCode: 403),
    );
    await denied;
    expect(controller.context.data, isNotNull);
    expect(controller.audits.data, isNull);
    expect(controller.selectedId, isNull);
    expect(repo.isolationRequests.last.cancel.isCancelled, isTrue);
    repo.completeAll();
    await held;
    expect(controller.isolation.data, isNull);
    await controller.refreshSource(SecuritySource.audits);
    expect(repo.auditRequests, hasLength(1));
    expect(controller.loading, isFalse);
  });
  for (final failure in [
    const ApiException('Expired', statusCode: 401),
    const SecurityIdentityMismatch(),
    const NativeAuthorityVerificationException(),
  ]) {
    test(
      '${failure.runtimeType} clears every lane and fences later completions',
      () async {
        final repo = SecurityTestRepository();
        final controller = SecurityController(repo);
        addTearDown(controller.dispose);
        final pending = controller.refresh();
        await Future<void>.value();
        repo.contextRequests.single.result.completeError(failure);
        await Future<void>.value();
        repo.completeAll();
        await pending;
        expect(controller.authorizationDenied, isTrue);
        expect(controller.available, isFalse);
        expect(controller.selectedId, isNull);
        for (final source in SecuritySource.values) {
          expect(controller.lane(source).data, isNull);
        }
        await controller.refresh();
        expect(repo.contextRequests, hasLength(1));
      },
    );
  }
  test('hidden evidence and selection clear synchronously and late responses cannot reappear', () async {
    final repo = SecurityTestRepository();
    final c = SecurityController(repo);
    addTearDown(c.dispose);
    final pending = c.refresh();
    await Future<void>.value();
    c.select('read.security');
    c.setVisible(false);
    expect(c.selectedId, isNull);
    expect(repo.contextRequests.single.cancel.isCancelled, isTrue);
    expect(repo.retentionRequests.single.cancel.isCancelled, isTrue);
    repo.completeAll();
    await pending;
    expect(c.context.data, isNull);
    expect(c.retention.data, isNull);
    c.setVisible(true);
    final next = c.refresh();
    await Future<void>.value();
    repo.completeAll();
    await next;
    expect(repo.contextRequests, hasLength(2));
    expect(c.context.data, isNotNull);
  });
}
