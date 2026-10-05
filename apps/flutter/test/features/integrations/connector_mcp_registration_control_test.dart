import 'dart:async';
import 'dart:convert';

import 'package:asael/features/integrations/connector_mcp_registration_contracts.dart';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_mcp_registration_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_mcp_registration_fixtures.dart';
import 'connector_fixtures.dart';

Future<ConnectorMcpRegistrationController> readyRegistration(
  RegistrationFixtureRepository repository,
  RegistrationFixtureStore store, {
  DateTime Function()? now,
}) async {
  final c = ConnectorMcpRegistrationController(
    repository,
    store,
    now: now ?? () => registrationNow,
  );
  await c.initialize();
  return c;
}

Future<void> prepareRegistration(ConnectorMcpRegistrationController c) =>
    c.prepare(
      registrationDeclaration(),
      registrationEndpoint,
      registrationToken,
      () => true,
      clearSecret: () {},
    );

void main() {
  test('prepare is one secret attempt, journals only safe evidence, and final save is separately confirmed', () async {
    final repository = RegistrationFixtureRepository(),
        store = RegistrationFixtureStore();
    final c = await readyRegistration(repository, store);
    var cleared = false;
    repository.onPrepare = () {
      expect(cleared, isTrue);
      expect(store.value!['sequence']['prepareDispatched'], isTrue);
      expect(jsonEncode(store.value), isNot(contains(registrationToken)));
      expect(jsonEncode(store.value), isNot(contains('bearerToken')));
      expect(
        jsonEncode(store.value),
        isNot(contains('synthetic-private-query')),
      );
      expect(jsonEncode(store.value), isNot(contains('synthetic-fragment')));
    };
    await c.prepare(
      registrationDeclaration(),
      registrationEndpoint,
      registrationToken,
      () => true,
      clearSecret: () => cleared = true,
    );
    expect(repository.prepares, 1);
    expect(repository.submits, 0);
    expect(c.canConfirm, isTrue);
    repository.onSubmit = () =>
        expect(store.value!['sequence']['finalIntent'], isNotNull);
    await c.confirm(c.sequence!, () => true);
    expect(repository.submits, 1);
    expect(c.sequence!.action!.settled, isTrue);
    expect(c.storageUnconfirmed, isFalse);
    expect(jsonEncode(store.value), isNot(contains(registrationToken)));
    expect(jsonEncode(store.value), isNot(contains('bearerToken')));
    expect(jsonEncode(store.value), isNot(contains('synthetic-private-query')));
    expect(jsonEncode(store.value), isNot(contains('synthetic-fragment')));
    c.dispose();
  });

  for (final auth in ['none', 'bearer_env', 'bearer_vault']) {
    test(
      '$auth creates only disabled local state with no tools after confirmation',
      () async {
        final repository = RegistrationFixtureRepository(),
            store = RegistrationFixtureStore();
        final c = await readyRegistration(repository, store);
        await c.prepare(
          registrationDeclaration(authType: auth),
          registrationEndpoint,
          auth == 'bearer_vault' ? registrationToken : null,
          () => true,
          clearSecret: () {},
        );
        expect(repository.prepares, 1);
        expect(repository.submits, 0);
        expect(c.sequence!.intent.identity['review'], isNull);
        await c.confirm(c.sequence!, () => true);
        expect(repository.preparationReads, 1);
        expect(repository.submits, 1);
        final result = c.sequence!.action!.action!['settlement']['result'];
        expect(result['connectorStatus'], 'disabled');
        expect(result['contractCount'], 0);
        expect(result['credentialVersion'], auth == 'bearer_vault' ? 1 : 0);
        expect(
          jsonEncode(store.value),
          isNot(contains('synthetic-private-query')),
        );
        expect(jsonEncode(store.value), isNot(contains(registrationToken)));
        c.dispose();
      },
    );
  }

  test('hide during the first safe write prevents possible prepare dispatch and clears input', () async {
    final repo = RegistrationFixtureRepository(),
        store = RegistrationFixtureStore();
    final c = await readyRegistration(repo, store);
    var visible = true, cleared = false;
    store.beforeWrite = (count) {
      if (count == 1) {
        visible = false;
      }
    };
    await c.prepare(
      registrationDeclaration(),
      registrationEndpoint,
      registrationToken,
      () => visible,
      clearSecret: () => cleared = true,
    );
    expect(cleared, isTrue);
    expect(c.sequence!.prepareDispatched, isFalse);
    expect(repo.prepares, 0);
    c.dispose();
  });

  test('hide during exact proof reread prevents the final possible-dispatch marker', () async {
    final c = await readyRegistration(
      RegistrationFixtureRepository(),
      RegistrationFixtureStore(),
    );
    await prepareRegistration(c);
    final actual = c.repository as RegistrationFixtureRepository;
    actual.preparationGate =
        Completer<ConnectorMcpRegistrationPreparationRead>();
    var visible = true;
    final confirming = c.confirm(c.sequence!, () => visible);
    visible = false;
    actual.preparationGate!.complete(
      await registrationPreparation(c.sequence!.intent),
    );
    await confirming;
    expect(actual.submits, 0);
    expect(c.sequence!.finalIntent, isNull);
    c.dispose();
  });

  test('lost prepare and null exact GET retain the original key across restart without POST', () async {
    final store = RegistrationFixtureStore(),
        repository = RegistrationFixtureRepository()..losePrepare = true;
    final c = await readyRegistration(repository, store);
    await prepareRegistration(c);
    final key = c.sequence!.intent.key;
    expect(c.sequence!.prepareDispatched, isTrue);
    c.dispose();
    final nextRepository = RegistrationFixtureRepository()
      ..missingPreparation = true;
    final next = ConnectorMcpRegistrationController(
      nextRepository,
      store,
      now: () => registrationNow,
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
    expect(next.canConfirm, isTrue);
    expect(nextRepository.submits, 0);
    next.dispose();
  });

  test('lost explicit abandonment resolves by preparation GET and permanently closes the same attempt', () async {
    final repository = RegistrationFixtureRepository()
      ..losePrepare = true
      ..loseAbandon = true;
    final store = RegistrationFixtureStore(),
        c = await readyRegistration(repository, RegistrationFixtureStore());
    // Use the controller's actual protected store for restart below.
    await prepareRegistration(c);
    await c.abandon(() => true);
    expect(c.sequence!.abandonDispatched, isTrue);
    expect(repository.abandons, 1);
    store.value = (c.store as RegistrationFixtureStore).value;
    final key = c.sequence!.intent.key;
    c.dispose();
    final nextRepository = RegistrationFixtureRepository()
      ..availability = 'abandoned'
      ..losePrepare = true;
    final next = ConnectorMcpRegistrationController(
      nextRepository,
      store,
      now: () => registrationNow,
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
    final repository = RegistrationFixtureRepository()..loseSubmit = true;
    final store = RegistrationFixtureStore(),
        c = await readyRegistration(repository, RegistrationFixtureStore());
    await prepareRegistration(c);
    await c.confirm(c.sequence!, () => true);
    final finalIntent = c.sequence!.finalIntent!;
    store.value = (c.store as RegistrationFixtureStore).value;
    c.dispose();
    final nextRepository = RegistrationFixtureRepository()
      ..availability = 'abandoned'
      ..missingAction = true;
    final next = ConnectorMcpRegistrationController(
      nextRepository,
      store,
      now: () => registrationNow.add(const Duration(days: 5)),
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
    final repository = RegistrationFixtureRepository()..losePrepare = true;
    final store = RegistrationFixtureStore(),
        c = await readyRegistration(repository, RegistrationFixtureStore());
    await prepareRegistration(c);
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
    store.value = (c.store as RegistrationFixtureStore).value;
    c.dispose();
    final nextRepository = RegistrationFixtureRepository();
    final next = ConnectorMcpRegistrationController(
      nextRepository,
      store,
      now: () => registrationNow,
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
    'expired preparation and changed exact proof cannot authorize final POST',
    () async {
      var now = registrationNow;
      final repository = RegistrationFixtureRepository(),
          c = await readyRegistration(
            repository,
            RegistrationFixtureStore(),
            now: () => now,
          );
      await prepareRegistration(c);
      now = now.add(const Duration(minutes: 15));
      await c.confirm(c.sequence!, () => true);
      expect(repository.submits, 0);
      now = registrationNow;
      repository.proofAt = registrationNow.subtract(const Duration(minutes: 1));
      await c.confirm(c.sequence!, () => true);
      expect(repository.submits, 0);
      expect(c.sequence!.finalIntent, isNull);
      c.dispose();
    },
  );

  test('active original owner after management loss can recover and explicitly abandon staging only', () async {
    final firstRepository = RegistrationFixtureRepository(),
        store = RegistrationFixtureStore();
    final first = await readyRegistration(firstRepository, store);
    await prepareRegistration(first);
    first.dispose();
    final viewer = ConnectorOwner(
      tenantId: connectorOwner.tenantId,
      actorId: connectorOwner.actorId,
      userId: connectorOwner.userId,
      role: 'viewer',
      apiBaseUrl: connectorOwner.apiBaseUrl,
    );
    final repository = RegistrationFixtureRepository()..owner = viewer;
    final next = ConnectorMcpRegistrationController(
      repository,
      store,
      now: () => registrationNow,
    );
    await next.initialize();
    await next.recover();
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

  test('failed first safe save is reconciled by authenticated absence; possible dispatch is not', () async {
    final repository = RegistrationFixtureRepository(),
        store = RegistrationFixtureStore();
    final real = await readyRegistration(repository, store);
    store.failNext = true;
    await prepareRegistration(real);
    expect(real.sequence!.prepareDispatched, isFalse);
    expect(repository.prepares, 0);
    await real.reloadProtected();
    expect(real.sequence, isNull);
    expect(real.storageUnconfirmed, isFalse);
    repository.losePrepare = true;
    await prepareRegistration(real);
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
      final repository = RegistrationFixtureRepository(),
          store = RegistrationFixtureStore();
      final controller = await readyRegistration(repository, store);
      await prepareRegistration(controller);
      await controller.confirm(controller.sequence!, () => true);
      final settledKey = controller.sequence!.finalIntent!.keySha256;
      store.failNext = true;
      await prepareRegistration(controller);
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
    final repository = RegistrationFixtureRepository(),
        store = RegistrationFixtureStore();
    final real = await readyRegistration(repository, store);
    await prepareRegistration(real);
    repository.onSubmit = () => store.commitThenFail = true;
    await real.confirm(real.sequence!, () => true);
    expect(real.sequence!.action!.settled, isTrue);
    expect(real.storageUnconfirmed, isTrue);
    await real.reloadProtected();
    expect(real.sequence!.action!.settled, isTrue);
    expect(real.storageUnconfirmed, isFalse);
    expect(repository.submits, 1);
    real.dispose();
  });
}
