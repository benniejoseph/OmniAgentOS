import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/ciphertext_recovery_broker.dart';
import 'package:asael/features/responsibilities/responsibility_contracts.dart';
import 'package:asael/features/responsibilities/responsibility_controller.dart';
import 'package:asael/features/responsibilities/responsibility_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'responsibility_test_support.dart';

class _FailingStore extends MemoryResponsibilityRecoveryStore {
  bool fail = true;
  @override
  Future<void> write(
    ResponsibilityOwner owner,
    ResponsibilityJson value, {
    required bool Function() isCurrent,
  }) async {
    if (fail) throw StateError('Disk is unavailable.');
    await super.write(owner, value, isCurrent: isCurrent);
  }
}

class _CommittedUnknownStore extends MemoryResponsibilityRecoveryStore {
  bool unknown = true;
  @override
  Future<void> write(
    ResponsibilityOwner owner,
    ResponsibilityJson value, {
    required bool Function() isCurrent,
  }) async {
    await super.write(owner, value, isCurrent: isCurrent);
    if (unknown && value['pending'] != null) {
      unknown = false;
      throw const RecoveryStorageUnknown();
    }
  }
}

void main() {
  test('unknown local commit reloads exact protected intent without dispatching or creating another key', () async {
    final repository = TestResponsibilityRepository(),
        store = _CommittedUnknownStore();
    final controller = ResponsibilityController(repository, store);
    addTearDown(controller.dispose);
    await controller.initialize();
    controller.edit(fullDraft);
    await controller.saveDraft();
    final original = responsibilityMap(store.values[testOwner.key]!['pending']);
    expect(controller.recoveryReady, isFalse);
    expect(repository.writes, isEmpty);
    await controller.saveDraft();
    expect(repository.writes, isEmpty);
    await controller.retryProtectedRecovery();
    expect(controller.pending!.key, original['key']);
    expect(repository.writes, isEmpty);
    await controller.recoverPending();
    expect(repository.writes.single.$3, original['key']);
  });
  test('intent is durable before dispatch and uncertain recovery keeps the exact original key', () async {
    final repository = TestResponsibilityRepository(),
        store = MemoryResponsibilityRecoveryStore();
    final controller = ResponsibilityController(repository, store);
    addTearDown(controller.dispose);
    await controller.initialize();
    controller.edit(fullDraft);
    repository.onMutation = (lane, input, key, id) async {
      expect(
        responsibilityMap(store.values[testOwner.key]!['pending'])['key'],
        key,
      );
      throw const ApiException('Response lost');
    };
    await controller.saveDraft();
    final original = controller.pending!;
    expect(controller.uncertain, isTrue);
    expect(repository.writes, hasLength(1));
    await controller.saveDraft();
    await controller.lifecycle('activate');
    await controller.notification('enable');
    await controller.refresh();
    expect(repository.writes, hasLength(1));
    final restartedRepository = TestResponsibilityRepository(),
        restarted = ResponsibilityController(restartedRepository, store);
    addTearDown(restarted.dispose);
    await restarted.initialize();
    expect(restarted.pending!.key, original.key);
    expect(restartedRepository.writes, isEmpty);
    await restarted.recoverPending();
    expect(restartedRepository.writes.single.$3, original.key);
    expect(
      responsibilitySame(restartedRepository.writes.single.$2, original.body),
      isTrue,
    );
    expect(restarted.pending, isNull);
    expect(restarted.accepted, hasLength(1));
  });
  test(
    'protected-save failure prevents dispatch and preserves draft',
    () async {
      final repository = TestResponsibilityRepository(),
          store = _FailingStore();
      final actual = ResponsibilityController(repository, store);
      addTearDown(actual.dispose);
      await actual.initialize();
      actual.edit(fullDraft);
      await actual.saveDraft();
      expect(repository.writes, isEmpty);
      expect(actual.pending, isNull);
      expect(actual.draft['purpose'], fullDraft['purpose']);
      expect(actual.recoveryError, contains('not submitted'));
      store.fail = false;
      await actual.saveDraft();
      expect(repository.writes, hasLength(1));
    },
  );
  test('accepted receipt survives every failed follow-up read without claiming freshness', () async {
    final repository = TestResponsibilityRepository();
    final actual = ResponsibilityController(
      repository,
      MemoryResponsibilityRecoveryStore(),
    );
    addTearDown(actual.dispose);
    await actual.initialize();
    actual.edit(fullDraft);
    repository.onMutation = (lane, input, key, id) async {
      repository.failReads = true;
      return draftResult(input, key, id: id);
    };
    await actual.saveDraft();
    expect(actual.accepted, hasLength(1));
    expect(actual.pending, isNull);
    expect(actual.notice, contains('Accepted'));
    expect(actual.record!.draft['purpose'], fullDraft['purpose']);
    expect(actual.isFresh(ResponsibilityRead.detail), isFalse);
    await actual.saveDraft();
    expect(repository.writes, hasLength(1));
  });
  test('immediate authority probe blocks a stale callback before provider notifications flush', () async {
    final repository = TestResponsibilityRepository();
    final actual = ResponsibilityController(
      repository,
      MemoryResponsibilityRecoveryStore(),
    );
    addTearDown(actual.dispose);
    await actual.initialize();
    actual.edit(fullDraft);
    repository.probe = false;
    await actual.saveDraft();
    expect(repository.writes, isEmpty);
    expect(actual.available, isFalse);
  });
  test('owner change clears visible private state and ignores a late accepted response', () async {
    final repository = TestResponsibilityRepository(),
        store = MemoryResponsibilityRecoveryStore(),
        response = Completer<ResponsibilityJson>();
    final controller = ResponsibilityController(repository, store);
    addTearDown(controller.dispose);
    await controller.initialize();
    controller.edit(fullDraft);
    repository.onMutation = (lane, input, key, id) => response.future;
    final submitting = controller.saveDraft();
    while (repository.writes.isEmpty) {
      await Future<void>.delayed(Duration.zero);
    }
    final write = repository.writes.single;
    repository.access.update(null, available: false);
    response.complete(await draftResult(write.$2, write.$3));
    await submitting;
    expect(controller.record, isNull);
    expect(controller.accepted, isEmpty);
    expect(controller.pending, isNull);
    expect(store.values[testOwner.key]!['pending'], isNotNull);
  });
  test(
    'new selection and newest per-kind read fence late previous responses',
    () async {
      final repository = TestResponsibilityRepository();
      final actual = ResponsibilityController(
        repository,
        MemoryResponsibilityRecoveryStore(),
      );
      addTearDown(actual.dispose);
      await actual.initialize();
      final older = Completer<ResponsibilityJson>(),
          newer = Completer<ResponsibilityJson>();
      var exactReads = 0;
      repository.onRead = (kind, id, preview) =>
          kind == ResponsibilityRead.detail
          ? (++exactReads == 1 ? older.future : newer.future)
          : repository.defaultRead(kind, id);
      final first = actual.select(testId), second = actual.refreshDetail();
      newer.complete({
        ...draftEnvelope,
        'record': await draftRecord(revision: 3),
        'readiness': {'state': 'not_checked', 'issues': <String>[]},
      });
      await second;
      older.complete({
        ...draftEnvelope,
        'record': await draftRecord(revision: 1),
        'readiness': {'state': 'not_checked', 'issues': <String>[]},
      });
      await first;
      expect(actual.record!.revision, 3);
    },
  );
  test(
    'local edits keep their original revision until explicit rebase',
    () async {
      final repository = TestResponsibilityRepository(),
          controller = ResponsibilityController(
            repository,
            MemoryResponsibilityRecoveryStore(),
          );
      addTearDown(controller.dispose);
      await controller.initialize(focusId: testId);
      controller.edit({
        ...controller.draft,
        'purpose': 'Locally edited purpose',
      });
      repository.onRead = (kind, id, preview) async =>
          kind == ResponsibilityRead.detail
          ? {
              ...draftEnvelope,
              'record': await draftRecord(revision: 4),
              'readiness': {'state': 'not_checked', 'issues': <String>[]},
            }
          : repository.defaultRead(kind, id);
      await controller.refreshDetail();
      expect(controller.draftRevisionConflict, isTrue);
      expect(controller.draft['purpose'], 'Locally edited purpose');
      await controller.saveDraft();
      expect(repository.writes, isEmpty);
      controller.rebaseDraft();
      await controller.saveDraft();
      expect(repository.writes.single.$2['expectedRevision'], 4);
    },
  );
  test('confirmed initial rejection releases slot but uncertain replay rejection does not', () async {
    final repository = TestResponsibilityRepository(),
        controller = ResponsibilityController(
          repository,
          MemoryResponsibilityRecoveryStore(),
        );
    addTearDown(controller.dispose);
    await controller.initialize();
    controller.edit(fullDraft);
    repository.onMutation = (_, _, _, _) async =>
        throw const ApiException('Conflict', statusCode: 409);
    await controller.saveDraft();
    expect(controller.pending, isNull);
    repository.onMutation = (_, _, _, _) async =>
        throw const ApiException('Timeout');
    await controller.saveDraft();
    final key = controller.pending!.key;
    repository.onMutation = (_, _, _, _) async =>
        throw const ApiException('Conflict', statusCode: 409);
    await controller.recoverPending();
    expect(controller.pending!.key, key);
    expect(controller.accepted, isEmpty);
  });
  test(
    'one mutation slot sends exact current runtime revision and generation',
    () async {
      final repository = TestResponsibilityRepository(),
          controller = ResponsibilityController(
            repository,
            MemoryResponsibilityRecoveryStore(),
          );
      addTearDown(controller.dispose);
      repository.onRead = (kind, id, preview) async =>
          kind == ResponsibilityRead.runtime
          ? runtimeView(await runtimeHead(revision: 9, generation: 3))
          : repository.defaultRead(kind, id);
      await controller.initialize(focusId: testId);
      await controller.lifecycle('pause');
      expect(repository.writes.single.$1, ResponsibilityLane.runtime);
      expect(repository.writes.single.$2, {
        'action': 'pause',
        'expectedRevision': 9,
        'expectedGeneration': 3,
      });
      expect(controller.accepted, hasLength(1));
    },
  );
  test('notification stop uses admission revision and generation, not runtime coordinates', () async {
    final repository = TestResponsibilityRepository(),
        controller = ResponsibilityController(
          repository,
          MemoryResponsibilityRecoveryStore(),
        );
    addTearDown(controller.dispose);
    repository.onRead = (kind, id, preview) async =>
        kind == ResponsibilityRead.notifications
        ? notificationView(
            await notificationHead(
              revision: 7,
              generation: 2,
              state: 'draining',
              reason: 'checks_exhausted',
            ),
          )
        : kind == ResponsibilityRead.runtime
        ? runtimeView(
            await runtimeHead(
              revision: 18,
              generation: 4,
              state: 'ended',
              reason: 'budget_exhausted',
            ),
          )
        : repository.defaultRead(kind, id);
    await controller.initialize(focusId: testId);
    await controller.notification('stop');
    expect(repository.writes.single.$2, {
      'action': 'stop',
      'expectedRevision': 7,
      'expectedGeneration': 2,
    });
    expect(repository.writes.single.$1, ResponsibilityLane.notifications);
  });
  test('account recreation, role or deployment changes cannot restore another recovery record', () async {
    final store = MemoryResponsibilityRecoveryStore(),
        repository = TestResponsibilityRepository(),
        controller = ResponsibilityController(repository, store);
    addTearDown(controller.dispose);
    await controller.initialize();
    controller.edit(fullDraft);
    repository.onMutation = (_, _, _, _) async =>
        throw const ApiException('Lost');
    await controller.saveDraft();
    for (final owner in [
      const ResponsibilityOwner(
        userId: '22222222-2222-4222-8222-222222222222',
        tenantId: 'tenant-a',
        requestActorId: 'owner@example.test',
        role: 'operator',
        apiBaseUrl: 'https://example.test',
      ),
      const ResponsibilityOwner(
        userId: '11111111-1111-4111-8111-111111111111',
        tenantId: 'tenant-a',
        requestActorId: 'owner@example.test',
        role: 'viewer',
        apiBaseUrl: 'https://example.test',
      ),
      const ResponsibilityOwner(
        userId: '11111111-1111-4111-8111-111111111111',
        tenantId: 'tenant-a',
        requestActorId: 'owner@example.test',
        role: 'operator',
        apiBaseUrl: 'https://other.test',
      ),
    ]) {
      final next = ResponsibilityController(
        TestResponsibilityRepository(owner: owner),
        store,
      );
      await next.initialize();
      expect(next.pending, isNull);
      expect(next.draft['purpose'], '');
      next.dispose();
    }
  });
  test('invalid local field blocks mutation even when last valid DTO remains available', () async {
    final repository = TestResponsibilityRepository(),
        controller = ResponsibilityController(
          repository,
          MemoryResponsibilityRecoveryStore(),
        );
    addTearDown(controller.dispose);
    await controller.initialize();
    controller.edit(fullDraft);
    controller.draftInputValidity('checks', false);
    await controller.saveDraft();
    expect(repository.writes, isEmpty);
    controller.draftInputValidity('checks', true);
    await controller.saveDraft();
    expect(repository.writes, hasLength(1));
  });
}
