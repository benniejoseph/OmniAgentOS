import 'dart:async';
import 'dart:convert';

import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_credential_rotation_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_credential_removal_fixtures.dart';
import 'connector_credential_rotation_fixtures.dart';
import 'connector_fixtures.dart';

Future<ConnectorCredentialRotationController> readyRotation(
  RotationFixtureRepository repository,
  RotationFixtureStore store, {
  DateTime Function()? now,
}) async {
  final c = ConnectorCredentialRotationController(
    repository,
    store,
    now: now ?? () => rotationNow,
  );
  await c.initialize();
  await c.select('mcp:one');
  return c;
}

Future<void> prepareRotation(ConnectorCredentialRotationController c) =>
    c.prepare(c.reviewed!, rotationToken, () => true, clearSecret: () {});

void main() {
  test('prepare is one secret attempt, journals only safe evidence, and final save is separately confirmed', () async {
    final repository = RotationFixtureRepository(),
        store = RotationFixtureStore();
    final c = await readyRotation(repository, store);
    var cleared = false;
    repository.onPrepare = () {
      expect(cleared, isTrue);
      expect(store.value!['sequence']['prepareDispatched'], isTrue);
      expect(jsonEncode(store.value), isNot(contains(rotationToken)));
      expect(jsonEncode(store.value), isNot(contains('bearerToken')));
    };
    await c.prepare(
      c.reviewed!,
      rotationToken,
      () => true,
      clearSecret: () => cleared = true,
    );
    expect(repository.prepares, 1);
    expect(repository.submits, 0);
    expect(c.canConfirm, isTrue);
    repository.onSubmit = () =>
        expect(store.value!['sequence']['finalIntent'], isNotNull);
    await c.confirm(c.reviewed!, () => true);
    expect(repository.submits, 1);
    expect(c.sequence!.action!.settled, isTrue);
    expect(c.storageUnconfirmed, isFalse);
    expect(jsonEncode(store.value), isNot(contains(rotationToken)));
    expect(jsonEncode(store.value), isNot(contains('bearerToken')));
    c.dispose();
  });

  test('lost prepare and null exact GET retain the original key across restart without POST', () async {
    final store = RotationFixtureStore(),
        repository = RotationFixtureRepository()..losePrepare = true;
    final c = await readyRotation(repository, store);
    await prepareRotation(c);
    final key = c.sequence!.intent.key;
    expect(c.sequence!.prepareDispatched, isTrue);
    c.dispose();
    final nextRepository = RotationFixtureRepository()
      ..missingPreparation = true;
    final next = ConnectorCredentialRotationController(
      nextRepository,
      store,
      now: () => rotationNow,
    );
    await next.initialize();
    await next.recover();
    expect(next.sequence!.intent.key, key);
    expect(next.canPrepare, isFalse);
    expect(nextRepository.prepares, 0);
    expect(nextRepository.submits, 0);
    expect(nextRepository.preparationReads, 1);
    nextRepository.missingPreparation = false;
    await next.recover();
    expect(next.sequence!.prepared!.availability, 'ready');
    expect(next.canConfirm, isFalse);
    await next.refresh();
    expect(next.canConfirm, isTrue);
    expect(nextRepository.submits, 0);
    next.dispose();
  });

  test('lost explicit abandonment resolves by preparation GET and permanently closes the same attempt', () async {
    final repository = RotationFixtureRepository()
      ..losePrepare = true
      ..loseAbandon = true;
    final store = RotationFixtureStore(),
        c = await readyRotation(repository, RotationFixtureStore());
    // Use the controller's actual protected store for restart below.
    await prepareRotation(c);
    await c.abandon(() => true);
    expect(c.sequence!.abandonDispatched, isTrue);
    expect(repository.abandons, 1);
    store.value = (c.store as RotationFixtureStore).value;
    final key = c.sequence!.intent.key;
    c.dispose();
    final nextRepository = RotationFixtureRepository()
      ..availability = 'abandoned'
      ..losePrepare = true;
    final next = ConnectorCredentialRotationController(
      nextRepository,
      store,
      now: () => rotationNow,
    );
    await next.initialize();
    await next.recover();
    expect(next.sequence!.intent.key, key);
    expect(next.sequence!.terminal, isTrue);
    expect(next.sequence!.prepared!.proof, isNull);
    expect(next.storageUnconfirmed, isFalse);
    expect(
      nextRepository.abandons +
          nextRepository.prepares +
          nextRepository.submits,
      0,
    );
    next.dispose();
  });

  test('uncertain final action ignores expired or abandoned preparation and null cannot clear it', () async {
    final repository = RotationFixtureRepository()..loseSubmit = true;
    final store = RotationFixtureStore(),
        c = await readyRotation(repository, RotationFixtureStore());
    await prepareRotation(c);
    await c.confirm(c.reviewed!, () => true);
    final finalIntent = c.sequence!.finalIntent!;
    store.value = (c.store as RotationFixtureStore).value;
    c.dispose();
    final nextRepository = RotationFixtureRepository()
      ..availability = 'abandoned'
      ..missingAction = true;
    final next = ConnectorCredentialRotationController(
      nextRepository,
      store,
      now: () => rotationNow.add(const Duration(days: 5)),
    );
    await next.initialize();
    await next.recover();
    await next.abandon(() => true);
    await next.discardLocal();
    expect(next.sequence!.finalIntent!.key, finalIntent.key);
    expect(next.sequence!.terminal, isFalse);
    expect(nextRepository.actionReads, 1);
    expect(nextRepository.preparationReads, 0);
    expect(
      nextRepository.prepares +
          nextRepository.submits +
          nextRepository.abandons,
      0,
    );
    expect(next.canAbandon, isFalse);
    nextRepository.missingAction = false;
    await next.recover();
    expect(next.sequence!.action!.settled, isTrue);
    expect(next.storageUnconfirmed, isFalse);
    next.dispose();
  });

  test('consumption on another device reconstructs a durable GET-only action identity without raw key', () async {
    final repository = RotationFixtureRepository()..losePrepare = true;
    final store = RotationFixtureStore(),
        c = await readyRotation(repository, RotationFixtureStore());
    await prepareRotation(c);
    repository.availability = 'consumed';
    repository.consumedKey = 'a' * 64;
    repository.missingAction = true;
    await c.recover();
    final linked = c.sequence!.finalIntent!;
    expect(linked.key, isNull);
    expect(linked.keySha256, 'a' * 64);
    expect(
      linked.request['preparationSha256'],
      c.sequence!.prepared!.proof!.sha256,
    );
    expect(repository.actionReads, 1);
    expect(repository.submits, 0);
    expect(c.canAbandon, isFalse);
    store.value = (c.store as RotationFixtureStore).value;
    c.dispose();
    final nextRepository = RotationFixtureRepository();
    final next = ConnectorCredentialRotationController(
      nextRepository,
      store,
      now: () => rotationNow,
    );
    await next.initialize();
    await next.recover();
    expect(next.sequence!.finalIntent!.key, isNull);
    expect(next.sequence!.action!.settled, isTrue);
    expect(nextRepository.preparationReads, 0);
    expect(nextRepository.actionReads, 1);
    expect(nextRepository.submits, 0);
    next.dispose();
  });

  test(
    'expired preparation and changed current pin cannot authorize final POST',
    () async {
      var now = rotationNow;
      final repository = RotationFixtureRepository(),
          c = await readyRotation(
            repository,
            RotationFixtureStore(),
            now: () => now,
          );
      await prepareRotation(c);
      now = now.add(const Duration(minutes: 15));
      await c.confirm(c.reviewed!, () => true);
      expect(repository.submits, 0);
      now = rotationNow;
      repository.reviewGate = Completer<ConnectorReview>()
        ..complete(await removalReviewFixture(version: 4));
      await c.confirm(c.reviewed!, () => true);
      expect(repository.submits, 0);
      expect(c.sequence!.finalIntent, isNull);
      c.dispose();
    },
  );

  test('active original owner after management loss can recover and explicitly abandon staging only', () async {
    final firstRepository = RotationFixtureRepository(),
        store = RotationFixtureStore();
    final first = await readyRotation(firstRepository, store);
    await prepareRotation(first);
    first.dispose();
    final viewer = ConnectorOwner(
      tenantId: connectorOwner.tenantId,
      actorId: connectorOwner.actorId,
      userId: connectorOwner.userId,
      role: 'viewer',
      apiBaseUrl: connectorOwner.apiBaseUrl,
    );
    final repository = RotationFixtureRepository()..owner = viewer;
    final next = ConnectorCredentialRotationController(
      repository,
      store,
      now: () => rotationNow,
    );
    await next.initialize();
    await next.recover();
    await next.refresh();
    expect(next.canPrepare, isFalse);
    expect(next.canConfirm, isFalse);
    expect(next.canAbandon, isTrue);
    await next.abandon(() => true);
    expect(next.sequence!.prepared!.availability, 'abandoned');
    expect(next.storageUnconfirmed, isFalse);
    expect(repository.abandons, 1);
    expect(repository.prepares + repository.submits, 0);
    next.dispose();
  });

  test(
    'hide during held review clears input and prevents preparation dispatch',
    () async {
      final repository = RotationFixtureRepository(),
          c = await readyRotation(repository, RotationFixtureStore());
      repository.reviewGate = Completer<ConnectorReview>();
      var visible = true, cleared = false;
      final future = c.prepare(
        c.reviewed!,
        rotationToken,
        () => visible,
        clearSecret: () => cleared = true,
      );
      visible = false;
      repository.reviewGate!.complete(await removalReviewFixture());
      await future;
      expect(cleared, isTrue);
      expect(repository.prepares, 0);
      expect(c.sequence, isNull);
      c.dispose();
    },
  );

  test('failed first safe save is reconciled by authenticated absence; possible dispatch is not', () async {
    final repository = RotationFixtureRepository(),
        store = RotationFixtureStore();
    final real = await readyRotation(repository, store);
    store.failNext = true;
    await prepareRotation(real);
    expect(real.sequence!.prepareDispatched, isFalse);
    expect(repository.prepares, 0);
    await real.reloadProtected();
    expect(real.sequence, isNull);
    expect(real.storageUnconfirmed, isFalse);
    repository.losePrepare = true;
    await prepareRotation(real);
    store.value = null;
    await real.reloadProtected();
    expect(real.sequence!.prepareDispatched, isTrue);
    expect(real.storageUnconfirmed, isTrue);
    expect(real.canAbandon, isFalse);
    real.dispose();
  });

  test(
    'failed unsent successor restores the authenticated older settled journal',
    () async {
      final repository = RotationFixtureRepository(),
          store = RotationFixtureStore();
      final controller = await readyRotation(repository, store);
      await prepareRotation(controller);
      await controller.confirm(controller.reviewed!, () => true);
      final settledKey = controller.sequence!.finalIntent!.keySha256;
      await controller.refresh();
      store.failNext = true;
      await prepareRotation(controller);
      expect(controller.sequence!.prepareDispatched, isFalse);
      expect(repository.prepares, 1);
      await controller.reloadProtected();
      expect(controller.sequence!.finalIntent!.keySha256, settledKey);
      expect(controller.sequence!.action!.settled, isTrue);
      expect(controller.storageUnconfirmed, isFalse);
      expect(repository.prepares, 1);
      controller.dispose();
    },
  );

  test('a lost verified receipt save requires exact durable reconciliation before another prepare', () async {
    final repository = RotationFixtureRepository(),
        store = RotationFixtureStore();
    final real = await readyRotation(repository, store);
    await prepareRotation(real);
    repository.onSubmit = () => store.commitThenFail = true;
    await real.confirm(real.reviewed!, () => true);
    expect(real.sequence!.action!.settled, isTrue);
    expect(real.storageUnconfirmed, isTrue);
    await real.reloadProtected();
    expect(real.sequence!.action!.settled, isTrue);
    expect(real.storageUnconfirmed, isFalse);
    expect(repository.submits, 1);
    real.dispose();
  });
}
