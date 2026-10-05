import 'dart:async';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_credential_removal_contracts.dart';
import 'package:asael/features/integrations/connector_credential_removal_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_credential_removal_fixtures.dart';
import 'connector_fixtures.dart';

Future<ConnectorCredentialRemovalController> _ready(
  RemovalFixtureRepository repository,
  RemovalFixtureStore store,
) async {
  final controller = ConnectorCredentialRemovalController(
    repository,
    store,
    'mcp:one',
  );
  await controller.initialize();
  return controller;
}

void main() {
  test('origin mismatch allows local removal; empty and exhausted credentials do not', () async {
    final mismatched = await removalReviewFixture(originMatch: false);
    expect(credentialRemovalEligible(mismatched), isTrue);
    expect(
      (await ConnectorCredentialRemovalIntent.prepare(
        connectorOwner,
        mismatched,
      )).request['action'],
      'remove_credential',
    );
    for (final review in [
      await removalReviewFixture(configured: false),
      await removalReviewFixture(version: 0),
      await removalReviewFixture(version: 2147483647),
    ]) {
      expect(credentialRemovalEligible(review), isFalse);
      await expectLater(
        ConnectorCredentialRemovalIntent.prepare(connectorOwner, review),
        throwsFormatException,
      );
    }
  });

  test('preflight requires the same configured credential version and exact target', () async {
    for (final review in [
      await removalReviewFixture(version: 4),
      await removalReviewFixture(id: 'mcp:other'),
      await removalReviewFixture(configured: false),
    ]) {
      final repository = RemovalFixtureRepository(),
          store = RemovalFixtureStore();
      final controller = await _ready(repository, store);
      repository.reviewGate = Completer<ConnectorReview>()..complete(review);
      await controller.act(controller.reviewed!, () => true);
      expect(repository.posts, 0);
      expect(store.writes, 0);
      expect(controller.pending, isNull);
      expect(controller.reviewed, isNull);
      controller.dispose();
    }
  });

  test(
    'hiding during preflight prevents both preparation and submission',
    () async {
      final repository = RemovalFixtureRepository(),
          store = RemovalFixtureStore();
      final controller = await _ready(repository, store);
      var visible = true;
      final gate = Completer<ConnectorReview>();
      repository.reviewGate = gate;
      final operation = controller.act(controller.reviewed!, () => visible);
      visible = false;
      gate.complete(await removalReviewFixture());
      await operation;
      expect(repository.posts, 0);
      expect(store.writes, 0);
      expect(controller.pending, isNull);
      expect(controller.busy, isFalse);
      controller.dispose();
    },
  );

  test('lost response and restart recover the disabled empty-tool result by exact GET only', () async {
    final repository = RemovalFixtureRepository()..loseResponse = true;
    final store = RemovalFixtureStore();
    final first = await _ready(repository, store);
    await first.act(first.reviewed!, () => true);
    final original = first.pending!.intent;
    expect(first.pending!.dispatched, isTrue);
    expect(repository.posts, 1);
    first.dispose();
    final nextRepository = RemovalFixtureRepository();
    final next = await _ready(nextRepository, store);
    // A replacement reads protected evidence and never creates a successor POST.
    expect(next.pending!.intent.requestSha256, original.requestSha256);
    await next.recover();
    final result = next.accepted!.response.action!['settlement']['result'];
    expect(result['connectorStatus'], 'disabled');
    expect(result['contractCount'], 0);
    expect(result['credentialVersion'], 4);
    expect(next.pending, isNull);
    expect(nextRepository.gets, 1);
    expect(nextRepository.posts, 0);
    next.dispose();
  });

  test('authenticated absence reconciles only a never-dispatched preparation or discard', () async {
    final repository = RemovalFixtureRepository(),
        store = RemovalFixtureStore();
    final controller = await _ready(repository, store);
    store.failNext = true;
    await controller.act(controller.reviewed!, () => true);
    expect(controller.pending!.dispatched, isFalse);
    expect(controller.storageUnconfirmed, isTrue);
    await controller.reloadProtected();
    expect(controller.pending, isNull);
    expect(controller.storageUnconfirmed, isFalse);
    await controller.refresh();
    var visible = true;
    store.beforeWrite = (_) => visible = false;
    await controller.act(controller.reviewed!, () => visible);
    expect(controller.pending!.dispatched, isFalse);
    store.beforeWrite = null;
    store.commitThenFail = true;
    await controller.discardPrepared();
    expect(controller.pending, isNotNull);
    expect(controller.storageUnconfirmed, isTrue);
    await controller.reloadProtected();
    expect(controller.pending, isNull);
    expect(controller.storageUnconfirmed, isFalse);
    expect(repository.posts, 0);
    controller.dispose();
  });

  test('missing GET and missing protected slot cannot disprove a dispatched removal', () async {
    final repository = RemovalFixtureRepository()..loseResponse = true;
    final store = RemovalFixtureStore();
    final active = await _ready(repository, store);
    await active.act(active.reviewed!, () => true);
    final original = active.pending!.intent;
    repository.missingReceipt = true;
    await active.recover();
    expect(active.pending!.intent.key, original.key);
    store.value = null;
    await active.reloadProtected();
    expect(active.pending!.intent.key, original.key);
    expect(active.storageUnconfirmed, isTrue);
    expect(active.canAct, isFalse);
    expect(repository.posts, 1);
    active.dispose();
  });

  test('verified B survives stored A and saves only over its own pending record', () async {
    final repository = RemovalFixtureRepository(),
        store = RemovalFixtureStore();
    final controller = await _ready(repository, store);
    await controller.act(controller.reviewed!, () => true);
    final first = controller.accepted!.intent.key;
    // A new configured credential has been explicitly reviewed after removal A.
    repository.reviewGate = Completer<ConnectorReview>()
      ..complete(await removalReviewFixture(version: 5));
    await controller.refresh();
    repository.afterSubmit = () => store.failNext = true;
    await controller.act(controller.reviewed!, () => true);
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
  });

  test(
    'retained receipt A cannot overwrite another window pending C beside A',
    () async {
      final repository = RemovalFixtureRepository(),
          store = RemovalFixtureStore();
      final controller = await _ready(repository, store);
      repository.afterSubmit = () => store.failNext = true;
      await controller.act(controller.reviewed!, () => true);
      final known = controller.accepted!;
      final competing = await ConnectorCredentialRemovalIntent.prepare(
        connectorOwner,
        await removalReviewFixture(version: 5),
        key: 'another-window',
      );
      store.value = connectorFreeze({
        'schemaVersion': 'connector-credential-removal:1',
        'pending': ConnectorCredentialRemovalPending(
          competing,
          dispatched: true,
        ).stored,
        'accepted': known.stored,
      });
      final writes = store.writes;
      await controller.saveAcceptedLocally();
      expect(store.writes, writes);
      expect(controller.storageUnconfirmed, isTrue);
      expect(controller.accepted!.intent.key, known.intent.key);
      expect(store.value!['pending']['intent']['key'], competing.key);
      controller.dispose();
    },
  );

  test('authority reentrancy and late preflight data cannot revive a retired controller', () async {
    final repository = RemovalFixtureRepository(),
        store = RemovalFixtureStore();
    final controller = await _ready(repository, store);
    final reviewed = controller.reviewed!;
    repository.accessProbe = () {
      controller.close();
      return true;
    };
    await controller.act(reviewed, () => true);
    expect(repository.posts, 0);
    expect(store.writes, 0);
    expect(controller.reviewed, isNull);
    controller.dispose();

    final nextRepository = RemovalFixtureRepository();
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
  });

  test('restoration rejects wrong actor, target or recovery schema; role loss permits only recovery', () async {
    final review = await removalReviewFixture();
    final intent = await ConnectorCredentialRemovalIntent.prepare(
      connectorOwner,
      review,
      key: 'held-removal',
    );
    final otherActor = ConnectorOwner(
      tenantId: connectorOwner.tenantId,
      actorId: connectorOwner.canonicalActorId,
      userId: connectorOwner.userId,
      role: connectorOwner.role,
      apiBaseUrl: connectorOwner.apiBaseUrl,
    );
    await expectLater(
      ConnectorCredentialRemovalIntent.restore(intent.stored, otherActor),
      throwsFormatException,
    );
    final journal = connectorFreeze({
      'schemaVersion': 'connector-credential-removal:1',
      'pending': ConnectorCredentialRemovalPending(
        intent,
        dispatched: true,
      ).stored,
      'accepted': null,
    });
    final store = RemovalFixtureStore()..value = journal;
    final otherTarget = ConnectorCredentialRemovalController(
      RemovalFixtureRepository(),
      store,
      'mcp:other',
    );
    await otherTarget.initialize();
    expect(otherTarget.loaded, isFalse);
    expect(otherTarget.storageUnconfirmed, isTrue);
    expect(otherTarget.pending, isNull);
    otherTarget.dispose();
    store.value = connectorFreeze({...journal, 'schemaVersion': 1});
    final wrongSchema = await _ready(RemovalFixtureRepository(), store);
    expect(wrongSchema.loaded, isFalse);
    expect(wrongSchema.storageUnconfirmed, isTrue);
    wrongSchema.dispose();

    store.value = journal;
    final reader = ConnectorOwner(
      tenantId: connectorOwner.tenantId,
      actorId: connectorOwner.actorId,
      userId: connectorOwner.userId,
      role: 'viewer',
      apiBaseUrl: connectorOwner.apiBaseUrl,
    );
    final repository = RemovalFixtureRepository()..owner = reader;
    final controller = await _ready(repository, store);
    expect(controller.mayChange, isFalse);
    expect(controller.canAct, isFalse);
    await controller.recover();
    expect(repository.gets, 1);
    expect(repository.posts, 0);
    expect(controller.accepted!.settled, isTrue);
    controller.dispose();
  });

  test(
    'even internally rehashed removal receipts reject changed effect semantics',
    () async {
      final intent = await ConnectorCredentialRemovalIntent.prepare(
        connectorOwner,
        await removalReviewFixture(),
        key: 'effect',
      );
      final response = await removalActionFixture(intent);
      for (final change in <ConnectorJson>[
        {'credentialVersion': 9},
        {'contractCount': 1},
        {'connectorStatus': 'active'},
        {'contractsSha256': 'a' * 64},
        {'operation': 'disconnect'},
        {'failureCode': 'failed'},
        {'unexpected': true},
      ]) {
        final old = connectorMap(response.action!['settlement']);
        final settlement = {
          ...old,
          'result': {...connectorMap(old['result']), ...change},
        }..remove('settlementSha256');
        final raw = await removalEnvelope(
          {
            'action': {
              ...response.action!,
              'settlement': {
                ...settlement,
                'settlementSha256': await connectorSha(settlement),
              },
            },
            'replayed': false,
          },
          'submit',
          intent: intent,
        );
        await expectLater(
          ConnectorCredentialRemovalRead.parse(
            raw,
            connectorOwner,
            kind: 'submit',
            intent: intent,
          ),
          throwsFormatException,
        );
      }
      final other = await ConnectorCredentialRemovalIntent.prepare(
        connectorOwner,
        await removalReviewFixture(),
        key: 'other',
      );
      await expectLater(
        ConnectorCredentialRemovalRead.parse(
          response.raw,
          connectorOwner,
          kind: 'submit',
          intent: other,
        ),
        throwsFormatException,
      );
    },
  );
}
