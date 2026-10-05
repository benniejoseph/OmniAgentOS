import 'dart:async';
import 'dart:convert';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_mcp_discovery_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_fixtures.dart';
import 'connector_mcp_discovery_fixtures.dart';

Future<ConnectorMcpDiscoveryController> readyDiscovery(
  DiscoveryFixtureRepository repository,
  DiscoveryFixtureStore store,
) async {
  final controller = ConnectorMcpDiscoveryController(repository, store);
  await controller.initialize();
  await controller.select('mcp:one');
  return controller;
}

void main() {
  test('one visible attempt freezes intent before POST and journals no schemas or endpoint', () async {
    final repository = DiscoveryFixtureRepository(),
        store = DiscoveryFixtureStore();
    final c = await readyDiscovery(repository, store);
    repository.onSubmit = () {
      expect(store.value!['sequence']['dispatched'], isTrue);
      expect(store.writes, 2);
    };
    await c.act(c.reviewed!, () => true);
    expect(repository.submits, 1);
    expect(repository.reviews, 2);
    expect(c.sequence!.terminal, isTrue);
    expect(c.sequence!.response!.result!['connectorStatus'], 'disabled');
    expect(c.storageUnconfirmed, isFalse);
    expect(c.reviewed, isNull);
    expect(c.canAct, isFalse);
    for (final private in [
      'Read a selected item',
      'tools.example.test',
      'inputSchema',
    ]) {
      expect(jsonEncode(store.value), isNot(contains(private)));
    }
    await c.refresh();
    expect(c.canAct, isTrue);
    c.dispose();
  });

  test(
    'fresh exact pin drift refuses before any protected dispatch or POST',
    () async {
      final repository = DiscoveryFixtureRepository(),
          store = DiscoveryFixtureStore();
      final c = await readyDiscovery(repository, store);
      repository.reviewGate = Completer<ConnectorReview>()
        ..complete(
          await connectorReviewFixture(
            endpoint: 'https://changed.example.test/mcp',
          ),
        );
      await c.act(c.reviewed!, () => true);
      expect(repository.submits, 0);
      expect(store.value, isNull);
      expect(c.reviewed, isNull);
      c.dispose();
    },
  );

  for (final write in [1, 2]) {
    test(
      'hide at protected write $write prevents POST and retains the honest dispatch boundary',
      () async {
        final repository = DiscoveryFixtureRepository(),
            store = DiscoveryFixtureStore();
        final c = await readyDiscovery(repository, store);
        store.beforeWrite = (count) {
          if (count == write) {
            c.hideReview();
          }
        };
        await c.act(c.reviewed!, () => true);
        expect(repository.submits, 0);
        expect(c.sequence!.dispatched, write == 2);
        expect(c.reviewed, isNull);
        expect(c.canAct, isFalse);
        c.dispose();
      },
    );
  }

  test('lost submit, null and expired GET survive restart without successor or replay', () async {
    final repository = DiscoveryFixtureRepository()..loseSubmit = true;
    final store = DiscoveryFixtureStore(),
        c = await readyDiscovery(repository, DiscoveryFixtureStore());
    await c.act(c.reviewed!, () => true);
    store.value = (c.store as DiscoveryFixtureStore).value;
    final key = c.sequence!.intent.key;
    c.dispose();
    final recovery = DiscoveryFixtureRepository()..missing = true;
    final next = await readyDiscovery(recovery, store);
    await next.recover();
    expect(next.sequence!.intent.key, key);
    expect(next.canAct, isFalse);
    expect(next.canCloseAttempt, isTrue);
    recovery.missing = false;
    recovery.state = 'expired';
    await next.recover();
    expect(next.sequence!.response!.state, 'expired');
    expect(next.sequence!.terminal, isFalse);
    expect(next.canAct, isFalse);
    expect(recovery.submits + recovery.closes, 0);
    await next.closeAttempt(() => true);
    expect(recovery.closes, 1);
    expect(next.sequence!.response!.state, 'closed');
    expect(next.reviewed, isNull);
    expect(next.canAct, isFalse);
    await next.refresh();
    expect(next.canAct, isTrue);
    next.dispose();
  });

  test('uncertain close retains its marker and only explicit same-key close can repeat', () async {
    final repository = DiscoveryFixtureRepository()
      ..state = 'pending'
      ..loseClose = true;
    final store = DiscoveryFixtureStore(),
        c = await readyDiscovery(repository, DiscoveryFixtureStore());
    await c.act(c.reviewed!, () => true);
    await c.closeAttempt(() => true);
    final key = c.sequence!.intent.key;
    expect(c.sequence!.closeDispatched, isTrue);
    store.value = (c.store as DiscoveryFixtureStore).value;
    c.dispose();
    final recovery = DiscoveryFixtureRepository()..missing = true;
    final next = await readyDiscovery(recovery, store);
    await next.recover();
    expect(recovery.closes, 0);
    expect(next.sequence!.closeDispatched, isTrue);
    expect(next.canAct, isFalse);
    await next.closeAttempt(() => true);
    expect(next.sequence!.intent.key, key);
    expect(next.sequence!.terminal, isTrue);
    expect(recovery.closes, 1);
    expect(recovery.submits, 0);
    next.dispose();
  });

  test('settlement winning explicit close is final and never replaced with closure', () async {
    final repository = DiscoveryFixtureRepository()
      ..state = 'pending'
      ..settledOnClose = true;
    final c = await readyDiscovery(repository, DiscoveryFixtureStore());
    await c.act(c.reviewed!, () => true);
    await c.closeAttempt(() => true);
    expect(c.sequence!.response!.state, 'settled');
    final evidence = c.sequence!.response!.discovery;
    repository.state = 'closed';
    await c.recover();
    expect(c.sequence!.response!.discovery, evidence);
    expect(c.error, isNotNull);
    expect(c.canCloseAttempt, isFalse);
    c.dispose();
  });

  test('the same active owner can close after role loss without gaining discovery authority', () async {
    final store = DiscoveryFixtureStore();
    final first = await readyDiscovery(
      DiscoveryFixtureRepository()..loseSubmit = true,
      store,
    );
    await first.act(first.reviewed!, () => true);
    first.dispose();
    final repository = DiscoveryFixtureRepository()
      ..owner = ConnectorOwner(
        tenantId: connectorOwner.tenantId,
        actorId: connectorOwner.actorId,
        userId: connectorOwner.userId,
        apiBaseUrl: connectorOwner.apiBaseUrl,
        role: 'viewer',
      );
    final next = await readyDiscovery(repository, store);
    expect(next.canAct, isFalse);
    expect(next.canCloseAttempt, isTrue);
    await next.closeAttempt(() => true);
    expect(next.sequence!.response!.state, 'closed');
    expect(repository.submits, 0);
    expect(repository.closes, 1);
    next.dispose();
  });

  test('a verified old receipt cannot overwrite a competing protected pending sequence', () async {
    final store = DiscoveryFixtureStore(),
        repository = DiscoveryFixtureRepository();
    final first = await readyDiscovery(repository, store);
    store.beforeWrite = (count) {
      if (count == 3) {
        store.failNext = true;
      }
    };
    await first.act(first.reviewed!, () => true);
    expect(first.sequence!.terminal, isTrue);
    expect(first.storageUnconfirmed, isTrue);
    final secondRepository = DiscoveryFixtureRepository();
    final second = await readyDiscovery(secondRepository, store);
    await second.recover();
    secondRepository.loseSubmit = true;
    await second.refresh();
    await second.act(second.reviewed!, () => true);
    final protected = connectorFreeze(store.value!);
    expect(protected['sequence']['dispatched'], isTrue);
    expect(protected['sequence']['response'], isNull);
    await first.saveLocally();
    expect(connectorSame(store.value, protected), isTrue);
    expect(first.storageUnconfirmed, isTrue);
    expect(first.sequence!.terminal, isTrue);
    first.dispose();
    second.dispose();
  });

  test('lost terminal receipt save retains evidence until exact journal save reconciles', () async {
    final repository = DiscoveryFixtureRepository(),
        store = DiscoveryFixtureStore();
    final c = await readyDiscovery(repository, store);
    store.beforeWrite = (count) {
      if (count == 3) {
        store.failNext = true;
      }
    };
    await c.act(c.reviewed!, () => true);
    expect(c.sequence!.terminal, isTrue);
    expect(c.storageUnconfirmed, isTrue);
    await c.saveLocally();
    expect(c.storageUnconfirmed, isFalse);
    expect(
      store.value!['sequence']['response']['discovery']['state'],
      'settled',
    );
    expect(repository.submits, 1);
    c.dispose();
  });

  test(
    'authenticated absence reconciles a lost never-dispatched local discard',
    () async {
      final c = await readyDiscovery(
        DiscoveryFixtureRepository(),
        DiscoveryFixtureStore(),
      );
      final actual = c.store as DiscoveryFixtureStore;
      actual.beforeWrite = (count) {
        if (count == 1) {
          c.hideReview();
        }
      };
      await c.act(c.reviewed!, () => true);
      expect(c.sequence!.dispatched, isFalse);
      actual.commitThenFail = true;
      await c.discardLocal();
      expect(c.sequence, isNotNull);
      await c.reloadProtected();
      expect(c.sequence, isNull);
      expect(c.storageUnconfirmed, isFalse);
      c.dispose();
    },
  );

  test(
    'hide consumes held private review and a late response cannot revive it',
    () async {
      final repository = DiscoveryFixtureRepository();
      final c = await readyDiscovery(repository, DiscoveryFixtureStore());
      repository.reviewGate = Completer<ConnectorReview>();
      final pending = c.refresh();
      c.hideReview();
      repository.reviewGate!.complete(await connectorReviewFixture());
      await pending;
      expect(c.reviewed, isNull);
      expect(c.reading, isFalse);
      expect(c.canAct, isFalse);
      c.dispose();
    },
  );
}
