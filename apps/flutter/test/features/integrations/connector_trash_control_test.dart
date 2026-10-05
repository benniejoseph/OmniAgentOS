import 'dart:async';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_trash_contracts.dart';
import 'package:asael/features/integrations/connector_trash_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_credential_removal_fixtures.dart';
import 'connector_trash_fixtures.dart';
import 'connector_fixtures.dart';

Future<ConnectorTrashController> _ready(
  TrashFixtureRepository repository,
  TrashFixtureStore store, {
  DateTime Function()? now,
}) async {
  final controller = ConnectorTrashController(
    repository,
    store,
    now: now ?? () => trashNow,
  );
  await controller.initialize();
  await controller.select('mcp:one');
  return controller;
}

void main() {
  test('Trash permits supported unconfigured, origin-mismatched and maximum-version targets', () async {
    for (final review in [
      await trashPreviewFixture(originMatch: false),
      await trashPreviewFixture(configured: false, version: 0),
      await trashPreviewFixture(version: 2147483647),
    ]) {
      final intent = await ConnectorTrashIntent.prepare(
        connectorOwner,
        review,
        now: trashNow,
      );
      expect(intent.request['action'], 'trash');
      expect(intent.request['preview'], review.preview);
    }
  });

  test('expired or replaced exact review cannot prepare a move', () async {
    for (final fresh in [
      await removalReviewFixture(version: 4),
      await removalReviewFixture(id: 'mcp:other'),
    ]) {
      final repository = TrashFixtureRepository(), store = TrashFixtureStore();
      final controller = await _ready(repository, store);
      repository.reviewGate = Completer<ConnectorReview>()..complete(fresh);
      await controller.act(controller.reviewed!, () => true);
      expect(repository.posts, 0);
      expect(store.writes, 0);
      expect(controller.pending, isNull);
      controller.dispose();
    }
    var now = trashNow;
    final repository = TrashFixtureRepository(), store = TrashFixtureStore();
    final controller = await _ready(repository, store, now: () => now);
    now = now.add(const Duration(minutes: 10));
    await controller.act(controller.reviewed!, () => true);
    expect(repository.reviewReads, 0);
    expect(repository.posts, 0);
    expect(store.writes, 0);
    controller.dispose();
  });

  for (final afterPrepare in [false, true]) {
    test(
      'preview expiry ${afterPrepare ? 'after protected preparation' : 'during preflight'} never submits or refreshes authority',
      () async {
        var now = trashNow;
        final repository = TrashFixtureRepository(),
            store = TrashFixtureStore();
        final controller = await _ready(repository, store, now: () => now);
        if (afterPrepare) {
          store.beforeWrite = (_) =>
              now = trashNow.add(const Duration(minutes: 10));
          await controller.act(controller.reviewed!, () => true);
          expect(controller.pending!.dispatched, isFalse);
          expect(
            controller.pending!.intent.request['preview']['issuedAt'],
            trashNow.toIso8601String(),
          );
        } else {
          final gate = Completer<ConnectorReview>();
          repository.reviewGate = gate;
          final operation = controller.act(controller.reviewed!, () => true);
          now = trashNow.add(const Duration(minutes: 10));
          gate.complete(await removalReviewFixture());
          await operation;
          expect(controller.pending, isNull);
        }
        expect(repository.posts, 0);
        expect(repository.previewReads, 1);
        expect(store.writes, afterPrepare ? 1 : 0);
        controller.dispose();
      },
    );
  }

  test('expired preview and deleted inventory do not prevent exact GET-only restart recovery', () async {
    final repository = TrashFixtureRepository()..loseResponse = true;
    final store = TrashFixtureStore();
    final first = await _ready(repository, store);
    final originalPreview = first.reviewed!.preview;
    await first.act(first.reviewed!, () => true);
    final original = first.pending!.intent;
    expect(original.request['preview'], originalPreview);
    expect(first.pending!.dispatched, isTrue);
    expect(repository.posts, 1);
    first.dispose();
    final nextRepository = TrashFixtureRepository();
    final next = ConnectorTrashController(
      nextRepository,
      store,
      now: () => trashNow.add(const Duration(days: 100)),
    );
    await next.initialize();
    expect(next.selectedId, isNull);
    expect(nextRepository.previewReads, 0);
    expect(nextRepository.reviewReads, 0);
    expect(next.pending!.intent.requestSha256, original.requestSha256);
    await next.recover();
    expect(
      next
          .accepted!
          .response
          .action!['settlement']['result']['trash']['trashId'],
      trashId,
    );
    expect(next.pending, isNull);
    expect(nextRepository.gets, 1);
    expect(nextRepository.posts, 0);
    next.dispose();
  });

  test('authenticated absence clears only never-dispatched preparation, while missing GET retains dispatch', () async {
    final repository = TrashFixtureRepository(), store = TrashFixtureStore();
    final controller = await _ready(repository, store);
    store.failNext = true;
    await controller.act(controller.reviewed!, () => true);
    expect(controller.pending!.dispatched, isFalse);
    await controller.reloadProtected();
    expect(controller.pending, isNull);
    expect(controller.storageUnconfirmed, isFalse);
    await controller.refresh();
    repository.loseResponse = true;
    await controller.act(controller.reviewed!, () => true);
    final held = controller.pending!.intent;
    repository.missingReceipt = true;
    await controller.recover();
    store.value = null;
    await controller.reloadProtected();
    expect(controller.pending!.intent.key, held.key);
    expect(controller.storageUnconfirmed, isTrue);
    expect(controller.canAct, isFalse);
    expect(repository.posts, 1);
    expect(repository.gets, 1);
    controller.dispose();
  });

  test(
    'verified B survives stored A and cannot overwrite a competing target C',
    () async {
      final repository = TrashFixtureRepository(), store = TrashFixtureStore();
      final controller = await _ready(repository, store);
      await controller.act(controller.reviewed!, () => true);
      final first = controller.accepted!.intent.key;
      await controller.select('mcp:two');
      repository.afterSubmit = () => store.failNext = true;
      await controller.act(controller.reviewed!, () => true);
      final known = controller.accepted!;
      expect(known.intent.key, isNot(first));
      await controller.reloadProtected();
      expect(controller.accepted!.intent.key, known.intent.key);
      expect(controller.storageUnconfirmed, isTrue);
      await controller.saveAcceptedLocally();
      expect(controller.storageUnconfirmed, isFalse);
      final competing = await ConnectorTrashIntent.prepare(
        connectorOwner,
        await trashPreviewFixture(id: 'mcp:three'),
        key: 'another-window',
        now: trashNow,
      );
      store.value = connectorFreeze({
        'schemaVersion': 'connector-trash:1',
        'pending': ConnectorTrashPending(competing, dispatched: true).stored,
        'accepted': known.stored,
      });
      controller.storageUnconfirmed = true;
      final writes = store.writes;
      await controller.saveAcceptedLocally();
      expect(store.writes, writes);
      expect(controller.storageUnconfirmed, isTrue);
      expect(controller.accepted!.intent.key, known.intent.key);
      expect(store.value!['pending']['intent']['key'], competing.key);
      expect(repository.posts, 2);
      controller.dispose();
    },
  );

  test(
    'reentrant authority loss and late preflight cannot revive private state',
    () async {
      final repository = TrashFixtureRepository(), store = TrashFixtureStore();
      final controller = await _ready(repository, store);
      final reviewed = controller.reviewed!;
      repository.accessProbe = () {
        controller.close();
        return true;
      };
      await controller.act(reviewed, () => true);
      expect(controller.reviewed, isNull);
      expect(repository.posts, 0);
      controller.dispose();
      final nextRepository = TrashFixtureRepository();
      final next = await _ready(nextRepository, store);
      final gate = Completer<ConnectorReview>();
      nextRepository.reviewGate = gate;
      final operation = next.act(next.reviewed!, () => true);
      next.close();
      gate.complete(await removalReviewFixture());
      await operation;
      expect(nextRepository.posts, 0);
      expect(store.writes, 0);
      expect(next.reviewed, isNull);
      expect(next.pending, isNull);
      next.dispose();
    },
  );

  test('role loss can recover the historical action but wrong actor and journal family refuse', () async {
    final intent = await ConnectorTrashIntent.prepare(
      connectorOwner,
      await trashPreviewFixture(),
      now: trashNow,
      key: 'held-trash',
    );
    final otherActor = ConnectorOwner(
      tenantId: connectorOwner.tenantId,
      actorId: connectorOwner.canonicalActorId,
      userId: connectorOwner.userId,
      role: connectorOwner.role,
      apiBaseUrl: connectorOwner.apiBaseUrl,
    );
    await expectLater(
      ConnectorTrashIntent.restore(intent.stored, otherActor),
      throwsFormatException,
    );
    final journal = connectorFreeze({
      'schemaVersion': 'connector-trash:1',
      'pending': ConnectorTrashPending(intent, dispatched: true).stored,
      'accepted': null,
    });
    final store = TrashFixtureStore()
      ..value = connectorFreeze({
        ...journal,
        'schemaVersion': 'connector-credential-removal:1',
      });
    final wrong = ConnectorTrashController(TrashFixtureRepository(), store);
    await wrong.initialize();
    expect(wrong.loaded, isFalse);
    expect(wrong.storageUnconfirmed, isTrue);
    wrong.dispose();
    store.value = journal;
    final reader = ConnectorOwner(
      tenantId: connectorOwner.tenantId,
      actorId: connectorOwner.actorId,
      userId: connectorOwner.userId,
      role: 'viewer',
      apiBaseUrl: connectorOwner.apiBaseUrl,
    );
    final repository = TrashFixtureRepository()..owner = reader;
    final controller = ConnectorTrashController(repository, store);
    await controller.initialize();
    expect(controller.canAct, isFalse);
    await controller.select('mcp:one');
    expect(repository.previewReads, 0);
    await controller.recover();
    expect(repository.gets, 1);
    expect(repository.posts, 0);
    expect(controller.accepted!.settled, isTrue);
    controller.dispose();
  });
}
