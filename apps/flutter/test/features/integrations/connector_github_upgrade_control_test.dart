import 'dart:async';
import 'dart:convert';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_github_upgrade_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_fixtures.dart';
import 'connector_github_upgrade_fixtures.dart';

Future<ConnectorGithubUpgradeController> readyGithubUpgrade(
  GithubUpgradeFixtureRepository repository,
  GithubUpgradeFixtureStore store,
) async {
  final controller = ConnectorGithubUpgradeController(repository, store);
  await controller.initialize();
  await controller.select('mcp:one');
  return controller;
}

void main() {
  test('one confirmed upgrade journals original intent and dispatch before provider work', () async {
    final repository = GithubUpgradeFixtureRepository(),
        store = GithubUpgradeFixtureStore();
    final c = await readyGithubUpgrade(repository, store);
    repository.onSubmit = () {
      expect(store.value!['sequence']['dispatched'], isTrue);
      expect(store.writes, 2);
    };
    await c.act(c.reviewed!, () => true);
    expect(repository.submits, 1);
    expect(repository.reviews, 2);
    expect(c.sequence!.terminal, isTrue);
    expect(c.sequence!.response!.result!['connectorStatus'], 'disabled');
    expect(c.reviewed, isNull);
    final protected = jsonEncode(store.value);
    expect(protected, isNot(contains('inputSchema')));
    expect(protected, isNot(contains('bearerToken')));
    await c.refresh();
    expect(c.canAct, isTrue);
    c.dispose();
  });

  test('changed current pin refuses before protected dispatch', () async {
    final repository = GithubUpgradeFixtureRepository(),
        store = GithubUpgradeFixtureStore();
    final c = await readyGithubUpgrade(repository, store);
    repository.reviewGate = Completer<ConnectorReview>()
      ..complete(
        await connectorReviewFixture(
          endpoint: 'https://api.githubcopilot.com/mcp',
          endpointRedacted: false,
          status: 'error',
        ),
      );
    await c.act(c.reviewed!, () => true);
    expect(repository.submits, 0);
    expect(store.value, isNull);
    expect(c.reviewed, isNull);
    c.dispose();
  });

  for (final write in [1, 2]) {
    test('hiding review during protected write $write prevents POST', () async {
      final repository = GithubUpgradeFixtureRepository(),
          store = GithubUpgradeFixtureStore();
      final c = await readyGithubUpgrade(repository, store);
      store.beforeWrite = (count) {
        if (count == write) c.hideReview();
      };
      await c.act(c.reviewed!, () => true);
      expect(repository.submits, 0);
      expect(c.sequence!.dispatched, write == 2);
      expect(c.canAct, isFalse);
      c.dispose();
    });
  }

  test(
    'lost POST and null/expired GET cannot start a successor until exact close',
    () async {
      final store = GithubUpgradeFixtureStore(),
          repository = GithubUpgradeFixtureRepository()..loseSubmit = true;
      final c = await readyGithubUpgrade(repository, store);
      await c.act(c.reviewed!, () => true);
      final key = c.sequence!.intent.key;
      expect(repository.submits, 1);
      c.dispose();

      final recovery = GithubUpgradeFixtureRepository()..missing = true;
      final next = await readyGithubUpgrade(recovery, store);
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
      expect(next.canAct, isFalse);
      await next.refresh();
      expect(next.canAct, isTrue);
      next.dispose();
    },
  );

  test('lost close acknowledgement retains only the original key and exact close path', () async {
    final repository = GithubUpgradeFixtureRepository()
      ..state = 'pending'
      ..loseClose = true;
    final store = GithubUpgradeFixtureStore();
    final c = await readyGithubUpgrade(repository, store);
    await c.act(c.reviewed!, () => true);
    await c.closeAttempt(() => true);
    final key = c.sequence!.intent.key;
    expect(c.sequence!.closeDispatched, isTrue);
    c.dispose();

    final recovery = GithubUpgradeFixtureRepository()..state = 'pending';
    final next = await readyGithubUpgrade(recovery, store);
    await next.recover();
    expect(recovery.submits, 0);
    expect(next.sequence!.closeDispatched, isTrue);
    expect(next.canAct, isFalse);
    await next.closeAttempt(() => true);
    expect(next.sequence!.intent.key, key);
    expect(next.sequence!.response!.state, 'closed');
    expect(recovery.closes, 1);
    next.dispose();
  });

  test(
    'settlement winning close remains final and cannot be relabelled closure',
    () async {
      final repository = GithubUpgradeFixtureRepository()
        ..state = 'pending'
        ..settledOnClose = true;
      final c = await readyGithubUpgrade(
        repository,
        GithubUpgradeFixtureStore(),
      );
      await c.act(c.reviewed!, () => true);
      await c.closeAttempt(() => true);
      expect(c.sequence!.response!.state, 'settled');
      final evidence = c.sequence!.response!.upgrade;
      repository.state = 'closed';
      await c.recover();
      expect(c.sequence!.response!.upgrade, evidence);
      expect(c.error, isNotNull);
      expect(c.canCloseAttempt, isFalse);
      c.dispose();
    },
  );

  test('same active owner can close after role loss without gaining upgrade authority', () async {
    final store = GithubUpgradeFixtureStore();
    final first = await readyGithubUpgrade(
      GithubUpgradeFixtureRepository()..loseSubmit = true,
      store,
    );
    await first.act(first.reviewed!, () => true);
    first.dispose();
    final repository = GithubUpgradeFixtureRepository()
      ..owner = ConnectorOwner(
        tenantId: connectorOwner.tenantId,
        actorId: connectorOwner.actorId,
        userId: connectorOwner.userId,
        apiBaseUrl: connectorOwner.apiBaseUrl,
        role: 'viewer',
      );
    final next = await readyGithubUpgrade(repository, store);
    expect(next.canAct, isFalse);
    expect(next.canCloseAttempt, isTrue);
    await next.closeAttempt(() => true);
    expect(next.sequence!.response!.state, 'closed');
    expect(repository.submits, 0);
    expect(repository.closes, 1);
    next.dispose();
  });
}
