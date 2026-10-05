import 'dart:async';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/google_personal_contracts.dart';
import 'package:asael/features/integrations/google_personal_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'google_personal_fixtures.dart';

Future<GooglePersonalController> _ready(
  GoogleFixtureRepository repository,
  GoogleFixtureStore store,
) async {
  final controller = GooglePersonalController(repository, store);
  await controller.initialize();
  return controller;
}

void main() {
  test(
    'preflight refuses a changed account, permission generation or source set',
    () async {
      final changed = [
        await googleReviewFixture(email: 'other@example.test'),
        await googleReviewFixture(generation: 3),
        await googleReviewFixture(sources: ['mail']),
      ];
      for (final review in changed) {
        final repository = GoogleFixtureRepository(),
            store = GoogleFixtureStore();
        final controller = await _ready(repository, store);
        repository.reviewGate = Completer<GooglePersonalRead>()
          ..complete(review);
        await controller.act(controller.reviewed!, 'sync', () => true);
        expect(repository.posts, 0);
        expect(store.writes, 0);
        expect(controller.pending, isNull);
        expect(controller.reviewed, isNull);
        controller.dispose();
      }
    },
  );

  test(
    'hiding during preflight prevents both protected preparation and POST',
    () async {
      final repository = GoogleFixtureRepository(),
          store = GoogleFixtureStore();
      final controller = await _ready(repository, store);
      var visible = true;
      final gate = Completer<GooglePersonalRead>();
      repository.reviewGate = gate;
      final operation = controller.act(
        controller.reviewed!,
        'sync',
        () => visible,
      );
      visible = false;
      gate.complete(await googleReviewFixture());
      await operation;
      expect(repository.posts, 0);
      expect(store.writes, 0);
      expect(controller.pending, isNull);
      expect(controller.busy, isFalse);
      controller.dispose();
    },
  );

  test(
    'lost response and replacement recover by exact GET without another POST',
    () async {
      final repository = GoogleFixtureRepository()..loseResponse = true;
      final store = GoogleFixtureStore();
      final controller = await _ready(repository, store);
      await controller.act(controller.reviewed!, 'disconnect', () => true);
      final original = controller.pending!.intent;
      expect(controller.pending!.dispatched, isTrue);
      expect(repository.posts, 1);
      controller.dispose();

      final nextRepository = GoogleFixtureRepository();
      final next = await _ready(nextRepository, store);
      expect(next.pending!.intent.requestSha256, original.requestSha256);
      expect(nextRepository.posts, 0);
      await next.recover();
      expect(nextRepository.gets, 1);
      expect(nextRepository.posts, 0);
      expect(next.pending, isNull);
      expect(next.accepted!.response.acceptance!['localRevoked'], isTrue);
      expect(
        next.accepted!.response.action!['settlement']['providerRevocation'],
        'unconfirmed',
      );
      next.dispose();
    },
  );

  test(
    'authenticated absence clears an unknown never-dispatched preparation',
    () async {
      final repository = GoogleFixtureRepository(),
          store = GoogleFixtureStore();
      final controller = await _ready(repository, store);
      store.failNext = true;
      await controller.act(controller.reviewed!, 'sync', () => true);
      expect(controller.pending!.dispatched, isFalse);
      expect(controller.storageUnconfirmed, isTrue);
      expect(repository.posts, 0);
      await controller.reloadProtected();
      expect(controller.pending, isNull);
      expect(controller.storageUnconfirmed, isFalse);
      await controller.refresh();
      expect(controller.canAct, isTrue);
      controller.dispose();
    },
  );

  test(
    'authenticated empty slot reconciles a lost local discard response',
    () async {
      final repository = GoogleFixtureRepository(),
          store = GoogleFixtureStore();
      final controller = await _ready(repository, store);
      var visible = true;
      store.beforeWrite = (_) => visible = false;
      await controller.act(controller.reviewed!, 'sync', () => visible);
      expect(controller.pending!.dispatched, isFalse);
      expect(repository.posts, 0);
      store.beforeWrite = null;
      store.commitThenFail = true;
      await controller.discardPrepared();
      expect(controller.pending, isNotNull);
      expect(controller.storageUnconfirmed, isTrue);
      await controller.reloadProtected();
      expect(controller.pending, isNull);
      expect(controller.storageUnconfirmed, isFalse);
      controller.dispose();
    },
  );

  test(
    'missing GET or protected record never clears dispatched uncertainty',
    () async {
      final repository = GoogleFixtureRepository()..loseResponse = true;
      final store = GoogleFixtureStore();
      final controller = await _ready(repository, store);
      await controller.act(controller.reviewed!, 'sync', () => true);
      final original = controller.pending!.intent;
      repository.missingReceipt = true;
      await controller.recover();
      expect(controller.pending!.intent.key, original.key);
      store.value = null;
      await controller.reloadProtected();
      expect(controller.pending!.intent.key, original.key);
      expect(controller.storageUnconfirmed, isTrue);
      expect(controller.canAct, isFalse);
      expect(repository.posts, 1);
      controller.dispose();
    },
  );

  test(
    'new verified B survives stored A when saving B settlement fails',
    () async {
      final repository = GoogleFixtureRepository(),
          store = GoogleFixtureStore();
      final controller = await _ready(repository, store);
      await controller.act(controller.reviewed!, 'sync', () => true);
      final first = controller.accepted!.intent.key;
      await controller.refresh();
      repository.afterSubmit = () => store.failNext = true;
      await controller.act(controller.reviewed!, 'disconnect', () => true);
      final second = controller.accepted!.intent.key;
      expect(second, isNot(first));
      expect(controller.storageUnconfirmed, isTrue);
      await controller.reloadProtected();
      expect(controller.accepted!.intent.key, second);
      expect(controller.pending, isNull);
      expect(controller.storageUnconfirmed, isTrue);
      await controller.saveAcceptedLocally();
      expect(controller.storageUnconfirmed, isFalse);
      expect(repository.posts, 2);
      controller.dispose();
    },
  );

  test(
    'saving retained A cannot overwrite another window pending C beside A',
    () async {
      final repository = GoogleFixtureRepository(),
          store = GoogleFixtureStore();
      final controller = await _ready(repository, store);
      repository.afterSubmit = () => store.failNext = true;
      await controller.act(controller.reviewed!, 'sync', () => true);
      final known = controller.accepted!;
      final competing = await GooglePersonalIntent.prepare(
        googleOwner,
        await googleReviewFixture(),
        'disconnect',
        key: 'another-window',
      );
      store.value = connectorFreeze({
        'schemaVersion': 1,
        'pending': GooglePersonalPending(competing, dispatched: true).stored,
        'accepted': known.stored,
      });
      final writes = store.writes;
      await controller.saveAcceptedLocally();
      expect(store.writes, writes);
      expect(controller.storageUnconfirmed, isTrue);
      expect(controller.accepted!.intent.key, known.intent.key);
      expect((store.value!['pending']['intent'] as Map)['key'], competing.key);
      controller.dispose();
    },
  );

  test(
    'an authority probe disposing its controller admits no further operation',
    () async {
      final repository = GoogleFixtureRepository(),
          store = GoogleFixtureStore();
      final controller = await _ready(repository, store);
      final reviewed = controller.reviewed!;
      repository.accessProbe = () {
        controller.close();
        return true;
      };
      await controller.act(reviewed, 'sync', () => true);
      expect(repository.posts, 0);
      expect(store.writes, 0);
      expect(controller.reviewed, isNull);
      expect(controller.current, isFalse);
      controller.dispose();
    },
  );

  test(
    'late preflight response cannot repopulate a replaced controller',
    () async {
      final repository = GoogleFixtureRepository(),
          store = GoogleFixtureStore();
      final controller = await _ready(repository, store);
      final gate = Completer<GooglePersonalRead>();
      repository.reviewGate = gate;
      final operation = controller.act(
        controller.reviewed!,
        'sync',
        () => true,
      );
      controller.close();
      gate.complete(await googleReviewFixture());
      await operation;
      expect(repository.posts, 0);
      expect(store.writes, 0);
      expect(controller.reviewed, isNull);
      expect(controller.pending, isNull);
      controller.dispose();
    },
  );

  test('another device acceptance gives an exact GET target with no successor authority', () async {
    final intent = await GooglePersonalIntent.prepare(
      googleOwner,
      await googleReviewFixture(),
      'sync',
      key: 'other-device',
    );
    final accepted = await googleActionFixture(intent, settled: false);
    final review = await googleReviewFixture(blocked: accepted.action);
    final repository = GoogleFixtureRepository()
      ..otherDeviceIntent = intent
      ..reviewGate = (Completer<GooglePersonalRead>()..complete(review));
    final controller = await _ready(repository, GoogleFixtureStore());
    await controller.recoverBlocked();
    expect(repository.gets, 1);
    expect(repository.posts, 0);
    expect(controller.observedReceipt!.settled, isTrue);
    expect(controller.reviewed, same(review));
    expect(controller.reviewed!.actions, isEmpty);
    expect(controller.pending, isNull);
    controller.dispose();
  });

  test('receipt parsing rejects another exact intent and restoration rejects another actor', () async {
    final review = await googleReviewFixture();
    final intent = await GooglePersonalIntent.prepare(
      googleOwner,
      review,
      'sync',
      key: 'one',
    );
    final other = await GooglePersonalIntent.prepare(
      googleOwner,
      review,
      'disconnect',
      key: 'two',
    );
    final response = await googleActionFixture(other, mutation: false);
    await expectLater(
      GooglePersonalRead.parse(
        response.raw,
        googleOwner,
        kind: 'read',
        keySha256: intent.keySha256,
        intent: intent,
      ),
      throwsFormatException,
    );
    final otherActor = ConnectorOwner(
      tenantId: googleOwner.tenantId,
      actorId: googleOwner.canonicalActorId,
      userId: googleOwner.userId,
      role: googleOwner.role,
      apiBaseUrl: googleOwner.apiBaseUrl,
    );
    await expectLater(
      GooglePersonalIntent.restore(intent.stored, otherActor),
      throwsFormatException,
    );
  });
}
