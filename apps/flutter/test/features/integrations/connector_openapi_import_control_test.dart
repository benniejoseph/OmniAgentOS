import 'dart:async';
import 'dart:convert';

import 'package:asael/features/integrations/connector_openapi_import_contracts.dart';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_openapi_import_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_openapi_import_fixtures.dart';
import 'connector_fixtures.dart';

Future<ConnectorOpenApiImportController> readyImport(
  ImportFixtureRepository repository,
  ImportFixtureStore store, {
  DateTime Function()? now,
}) async {
  final c = ConnectorOpenApiImportController(
    repository,
    store,
    now: now ?? () => importNow,
  );
  await c.initialize();
  return c;
}

Future<void> prepareImport(ConnectorOpenApiImportController c) => c.prepare(
  importDeclaration(),
  importPayload(),
  () => true,
  clearSecret: () {},
);

void main() {
  test('prepare is one source attempt, journals only safe evidence, and final save is separately confirmed', () async {
    final repository = ImportFixtureRepository(), store = ImportFixtureStore();
    final c = await readyImport(repository, store);
    var cleared = false;
    repository.onPrepare = () {
      expect(cleared, isTrue);
      expect(store.value!['sequence']['prepareDispatched'], isTrue);
      expect(jsonEncode(store.value), isNot(contains(importText)));
      expect(jsonEncode(store.value), isNot(contains('specText')));
      expect(
        jsonEncode(store.value),
        isNot(contains('synthetic-private-query')),
      );
      expect(jsonEncode(store.value), isNot(contains('synthetic-fragment')));
    };
    await c.prepare(
      importDeclaration(),
      importPayload(),
      () => true,
      clearSecret: () => cleared = true,
    );
    expect(repository.prepares, 1);
    expect(repository.submits, 0);
    expect(c.canConfirm, isTrue);
    expect(c.summary, isNotNull);
    expect(jsonEncode(store.value), isNot(contains('"operations"')));
    expect(jsonEncode(store.value), isNot(contains('"summary"')));
    repository.onSubmit = () =>
        expect(store.value!['sequence']['finalIntent'], isNotNull);
    await c.confirm(c.sequence!, () => true);
    expect(repository.submits, 1);
    expect(c.sequence!.action!.settled, isTrue);
    expect(c.storageUnconfirmed, isFalse);
    expect(jsonEncode(store.value), isNot(contains(importText)));
    expect(jsonEncode(store.value), isNot(contains('specText')));
    expect(jsonEncode(store.value), isNot(contains('synthetic-private-query')));
    expect(jsonEncode(store.value), isNot(contains('synthetic-fragment')));
    c.dispose();
  });

  for (final auth in ['none', 'bearer_env', 'api_key_header_env']) {
    test(
      '$auth creates only disabled local state with captured operations pending review after confirmation',
      () async {
        final repository = ImportFixtureRepository(),
            store = ImportFixtureStore();
        final c = await readyImport(repository, store);
        await c.prepare(
          importDeclaration(authType: auth),
          importPayload(),
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
        expect(result['contractCount'], 2);
        expect(result['credentialVersion'], 0);
        expect(
          jsonEncode(store.value),
          isNot(contains('synthetic-private-query')),
        );
        expect(jsonEncode(store.value), isNot(contains(importText)));
        c.dispose();
      },
    );
  }

  test('hide during the first safe write prevents possible prepare dispatch and clears input', () async {
    final repo = ImportFixtureRepository(), store = ImportFixtureStore();
    final c = await readyImport(repo, store);
    var visible = true, cleared = false;
    store.beforeWrite = (count) {
      if (count == 1) {
        visible = false;
      }
    };
    await c.prepare(
      importDeclaration(),
      importPayload(),
      () => visible,
      clearSecret: () => cleared = true,
    );
    expect(cleared, isTrue);
    expect(c.sequence!.prepareDispatched, isFalse);
    expect(repo.prepares, 0);
    c.dispose();
  });

  test('hide during exact proof reread prevents the final possible-dispatch marker', () async {
    final c = await readyImport(
      ImportFixtureRepository(),
      ImportFixtureStore(),
    );
    await prepareImport(c);
    final actual = c.repository as ImportFixtureRepository;
    actual.preparationGate = Completer<ConnectorOpenApiImportPreparationRead>();
    var visible = true;
    final confirming = c.confirm(c.sequence!, () => visible);
    visible = false;
    actual.preparationGate!.complete(
      await importPreparation(c.sequence!.intent),
    );
    await confirming;
    expect(actual.submits, 0);
    expect(c.sequence!.finalIntent, isNull);
    c.dispose();
  });

  test('lost prepare and null exact GET retain the original key across restart without POST', () async {
    final store = ImportFixtureStore(),
        repository = ImportFixtureRepository()..losePrepare = true;
    final c = await readyImport(repository, store);
    await prepareImport(c);
    final key = c.sequence!.intent.key;
    expect(c.sequence!.prepareDispatched, isTrue);
    c.dispose();
    final nextRepository = ImportFixtureRepository()..missingPreparation = true;
    final next = ConnectorOpenApiImportController(
      nextRepository,
      store,
      now: () => importNow,
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
    final repository = ImportFixtureRepository()
      ..losePrepare = true
      ..loseAbandon = true;
    final store = ImportFixtureStore(),
        c = await readyImport(repository, ImportFixtureStore());
    // Use the controller's actual protected store for restart below.
    await prepareImport(c);
    await c.abandon(() => true);
    expect(c.sequence!.abandonDispatched, isTrue);
    expect(repository.abandons, 1);
    store.value = (c.store as ImportFixtureStore).value;
    final key = c.sequence!.intent.key;
    c.dispose();
    final nextRepository = ImportFixtureRepository()
      ..availability = 'abandoned'
      ..losePrepare = true;
    final next = ConnectorOpenApiImportController(
      nextRepository,
      store,
      now: () => importNow,
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
    final repository = ImportFixtureRepository()..loseSubmit = true;
    final store = ImportFixtureStore(),
        c = await readyImport(repository, ImportFixtureStore());
    await prepareImport(c);
    await c.confirm(c.sequence!, () => true);
    final finalIntent = c.sequence!.finalIntent!;
    store.value = (c.store as ImportFixtureStore).value;
    c.dispose();
    final nextRepository = ImportFixtureRepository()
      ..availability = 'abandoned'
      ..missingAction = true;
    final next = ConnectorOpenApiImportController(
      nextRepository,
      store,
      now: () => importNow.add(const Duration(days: 5)),
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
    final repository = ImportFixtureRepository()..losePrepare = true;
    final store = ImportFixtureStore(),
        c = await readyImport(repository, ImportFixtureStore());
    await prepareImport(c);
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
    store.value = (c.store as ImportFixtureStore).value;
    c.dispose();
    final nextRepository = ImportFixtureRepository();
    final next = ConnectorOpenApiImportController(
      nextRepository,
      store,
      now: () => importNow,
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
      var now = importNow;
      final repository = ImportFixtureRepository(),
          c = await readyImport(
            repository,
            ImportFixtureStore(),
            now: () => now,
          );
      await prepareImport(c);
      now = now.add(const Duration(minutes: 15));
      await c.confirm(c.sequence!, () => true);
      expect(repository.submits, 0);
      now = importNow;
      repository.proofAt = importNow.subtract(const Duration(minutes: 1));
      await c.confirm(c.sequence!, () => true);
      expect(repository.submits, 0);
      expect(c.sequence!.finalIntent, isNull);
      c.dispose();
    },
  );

  test('active original owner after management loss can recover and explicitly abandon staging only', () async {
    final firstRepository = ImportFixtureRepository(),
        store = ImportFixtureStore();
    final first = await readyImport(firstRepository, store);
    await prepareImport(first);
    first.dispose();
    final viewer = ConnectorOwner(
      tenantId: connectorOwner.tenantId,
      actorId: connectorOwner.actorId,
      userId: connectorOwner.userId,
      role: 'viewer',
      apiBaseUrl: connectorOwner.apiBaseUrl,
    );
    final repository = ImportFixtureRepository()..owner = viewer;
    final next = ConnectorOpenApiImportController(
      repository,
      store,
      now: () => importNow,
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
    final repository = ImportFixtureRepository(), store = ImportFixtureStore();
    final real = await readyImport(repository, store);
    store.failNext = true;
    await prepareImport(real);
    expect(real.sequence!.prepareDispatched, isFalse);
    expect(repository.prepares, 0);
    await real.reloadProtected();
    expect(real.sequence, isNull);
    expect(real.storageUnconfirmed, isFalse);
    repository.losePrepare = true;
    await prepareImport(real);
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
      final repository = ImportFixtureRepository(),
          store = ImportFixtureStore();
      final controller = await readyImport(repository, store);
      await prepareImport(controller);
      await controller.confirm(controller.sequence!, () => true);
      final settledKey = controller.sequence!.finalIntent!.keySha256;
      store.failNext = true;
      await prepareImport(controller);
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
    final repository = ImportFixtureRepository(), store = ImportFixtureStore();
    final real = await readyImport(repository, store);
    await prepareImport(real);
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

  for (final availability in ['preparing', 'failed', 'expired']) {
    test(
      '$availability never permits a new draft or final POST before exact abandonment',
      () async {
        final repo = ImportFixtureRepository()..availability = availability;
        final c = await readyImport(repo, ImportFixtureStore());
        await prepareImport(c);
        expect(c.sequence!.prepared!.availability, availability);
        expect(c.canConfirm, isFalse);
        expect(c.canPrepare, isFalse);
        expect(c.summary, isNull);
        await c.recover();
        expect(repo.prepares, 1);
        expect(repo.submits, 0);
        await c.abandon(() => true);
        expect(c.sequence!.terminal, isTrue);
        expect(c.canPrepare, isTrue);
        c.dispose();
      },
    );
  }

  test('summary is absent after restart and stale hidden GET cannot revive visible confirmation', () async {
    final store = ImportFixtureStore();
    final first = await readyImport(ImportFixtureRepository(), store);
    await prepareImport(first);
    final id = first.sequence!.intent.id;
    first.dispose();
    final repo = ImportFixtureRepository();
    final next = await readyImport(repo, store);
    expect(next.sequence!.intent.id, id);
    expect(next.summary, isNull);
    expect(next.canConfirm, isFalse);
    repo.preparationGate = Completer<ConnectorOpenApiImportPreparationRead>();
    final recovery = next.recover();
    next.hideReview();
    repo.preparationGate!.complete(
      await importPreparation(next.sequence!.intent),
    );
    await recovery;
    expect(next.summary, isNull);
    expect(next.canConfirm, isFalse);
    expect(repo.readCancellations, 1);
    repo.preparationGate = null;
    await next.recover();
    expect(next.summary, isNotNull);
    expect(next.canConfirm, isTrue);
    expect(repo.prepares + repo.submits, 0);
    next.dispose();
  });

  test('late prepare response may preserve compact evidence but cannot revive a hidden summary', () async {
    final repo = ImportFixtureRepository()..prepareGate = Completer<void>();
    final arrived = Completer<void>();
    repo.onPrepare = arrived.complete;
    final store = ImportFixtureStore();
    final c = await readyImport(repo, store);
    final preparing = prepareImport(c);
    await arrived.future;
    c.hideReview();
    repo.prepareGate!.complete();
    await preparing;
    expect(c.sequence!.prepared!.availability, 'ready');
    expect(c.summary, isNull);
    expect(c.canConfirm, isFalse);
    expect(jsonEncode(store.value), isNot(contains('"operations"')));
    expect(repo.submits, 0);
    c.dispose();
  });
}
