import 'dart:convert';
import 'dart:io';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_github_upgrade_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_fixtures.dart';
import 'connector_github_upgrade_fixtures.dart';

Future<ConnectorGithubUpgradeIntent> _intent() async =>
    ConnectorGithubUpgradeIntent.prepare(
      connectorOwner,
      await connectorReviewFixture(
        endpoint: 'https://api.githubcopilot.com/mcp',
        endpointRedacted: false,
      ),
      eligibility: await githubUpgradeReviewFixture('mcp:one'),
      key: 'synthetic-github-upgrade-contract',
    );

Future<ConnectorJson> _reseal(
  ConnectorJson upgrade,
  ConnectorGithubUpgradeIntent intent,
) async {
  for (final field in ['attempt', 'settlement', 'closure']) {
    if (upgrade[field] != null) {
      final body = connectorMap(upgrade[field])..remove('${field}Sha256');
      upgrade[field] = {...body, '${field}Sha256': await connectorSha(body)};
    }
  }
  return githubUpgradeEnvelope(upgrade, intent);
}

void main() {
  test('independent TS evidence validates original intent and every terminal branch', () async {
    final source = connectorMap(
      jsonDecode(
        File('test/fixtures/native_github_upgrade.json').readAsStringSync(),
      ),
    );
    final scope = connectorMap(source['scope']);
    final canonicalActor = scope['canonicalActorId'] as String;
    final owner = ConnectorOwner(
      tenantId: scope['tenantId'] as String,
      actorId: scope['ownerActorId'] as String,
      userId: canonicalActor.substring(6),
      role: 'admin',
      apiBaseUrl: 'https://github-upgrade-fixture.example.test',
    );
    final intent = await ConnectorGithubUpgradeIntent.restore({
      'owner': owner.json,
      'key': source['key'],
      'identity': source['intent'],
      'requestSha256': await connectorSha(source['intent']),
    }, owner);
    expect(intent.identity, source['intent']);
    expect(intent.request, source['request']);
    expect(intent.closeRequest, source['closeRequest']);
    for (final field in [
      'pending',
      'expired',
      'settled',
      'closedAttempt',
      'closedAbsent',
    ]) {
      final raw = connectorMap(source[field]);
      final read = await ConnectorGithubUpgradeRead.parse(
        await githubUpgradeEnvelope(raw, intent, owner: owner),
        owner,
        intent: intent,
      );
      expect(read.upgrade, raw, reason: field);
    }
    for (final raw in source['failed'] as List) {
      final value = connectorMap(raw);
      final read = await ConnectorGithubUpgradeRead.parse(
        await githubUpgradeEnvelope(value, intent, owner: owner),
        owner,
        intent: intent,
      );
      expect(read.result!['status'], 'failed');
    }
    for (final field in ['closedAttempt', 'closedAbsent', 'closeSettled']) {
      final raw = connectorMap(source[field]);
      final read = await ConnectorGithubUpgradeRead.parse(
        await githubUpgradeEnvelope(raw, intent, kind: 'close', owner: owner),
        owner,
        intent: intent,
        kind: 'close',
      );
      expect(read.terminal, isTrue);
      expect(read.upgrade, raw);
    }
  });

  test('only exact legacy official endpoint with a complete native review is eligible', () async {
    for (final state in ['active', 'disabled', 'error']) {
      final review = await connectorReviewFixture(
        endpoint: 'https://api.githubcopilot.com/mcp/',
        endpointRedacted: false,
        status: state,
      );
      expect(githubUpgradeEligible(review), isTrue);
    }
    for (final endpoint in [
      'https://api.githubcopilot.com/mcp/x/all',
      'https://api.githubcopilot.com/mcp/other',
      'https://github.example.test/mcp',
      'http://api.githubcopilot.com/mcp',
      'https://api.githubcopilot.com:444/mcp',
      'https://api.githubcopilot.com:443/mcp',
      'https://API.githubcopilot.com/mcp',
      'https://api.githubcopilot.com/mcp//',
      'https://api.githubcopilot.com/mcp?token=private',
      'https://user@api.githubcopilot.com/mcp',
    ]) {
      expect(
        legacyOfficialGithubMcpEndpoint(endpoint),
        isFalse,
        reason: endpoint,
      );
    }
    expect(
      githubUpgradeEligible(
        await connectorReviewFixture(
          endpoint: 'https://api.githubcopilot.com/mcp',
          endpointRedacted: true,
        ),
      ),
      isFalse,
    );
    expect(
      githubUpgradeEligible(
        await connectorReviewFixture(
          endpoint: 'https://api.githubcopilot.com/mcp',
          endpointRedacted: false,
          credentialOriginMatch: false,
        ),
      ),
      isFalse,
    );
  });

  test(
    'normalized public URL never substitutes for raw stored endpoint proof',
    () async {
      final review = await connectorReviewFixture(
        endpoint: 'https://api.githubcopilot.com/mcp',
        endpointRedacted: false,
      );
      final denied = await githubUpgradeReviewFixture(
        'mcp:one',
        eligible: false,
      );
      expect(githubUpgradeEligible(review), isTrue);
      expect(denied.matches(review), isFalse);
      expect(
        () => ConnectorGithubUpgradeIntent.prepare(
          connectorOwner,
          review,
          eligibility: denied,
        ),
        throwsFormatException,
      );
      final changed = await githubUpgradeReviewFixture(
        'mcp:one',
        pinChanged: true,
      );
      expect(changed.matches(review), isFalse);
      final accepted = await githubUpgradeReviewFixture('mcp:one');
      expect(accepted.matches(review), isTrue);
    },
  );

  test('original key and review pin survive a protected restore', () async {
    final intent = await _intent();
    final restored = await ConnectorGithubUpgradeIntent.restore(
      intent.stored,
      connectorOwner,
    );
    expect(restored.identity, intent.identity);
    expect(restored.request, {
      'contract': 'asael-connector-lifecycle-action:1',
      'kind': 'mcp',
      'connectorId': 'mcp:one',
      'action': 'upgrade_github',
      'review': intent.review,
      'preview': null,
    });
    expect(restored.closeRequest, {
      'contract': 'asael-github-upgrade-close:1',
      'intent': intent.identity,
    });
  });

  test('pending, expiry, completion, failure and both closures bind original intent', () async {
    final intent = await _intent();
    for (final state in ['pending', 'expired', 'settled', 'closed']) {
      final read = await githubUpgradeFixture(intent, state: state);
      expect(read.state, state);
      expect(read.terminal, state == 'settled' || state == 'closed');
      expect(read.attempt!['reviewSha256'], intent.review['reviewSha256']);
    }
    for (final failure in [
      'discovery_failed',
      'catalog_unreviewable',
      'target_changed',
      'deadline_exceeded',
    ]) {
      final read = await githubUpgradeFixture(intent, failure: failure);
      expect(read.result!['failureCode'], failure);
    }
    expect(
      (await githubUpgradeFixture(
        intent,
        state: 'closed',
        absent: true,
      )).attempt,
      isNull,
    );
    expect(
      (await githubUpgradeFixture(
        intent,
        state: 'closed',
        kind: 'close',
      )).terminal,
      isTrue,
    );
    expect(
      (await githubUpgradeFixture(
        intent,
        state: 'settled',
        kind: 'close',
      )).result!['connectorStatus'],
      'disabled',
    );
  });

  test('GET recovery accepts only a read-only service receipt', () async {
    final intent = await _intent();
    final pending = await githubUpgradeFixture(intent, state: 'pending');
    final envelope = await githubUpgradeEnvelope(pending.upgrade, intent);
    expect(envelope['serviceReceipt']['action'], 'read');
    expect(
      (await ConnectorGithubUpgradeRead.parse(
        envelope,
        connectorOwner,
        intent: intent,
      )).state,
      'pending',
    );
    final forged = connectorMap(jsonDecode(jsonEncode(envelope)));
    forged['serviceReceipt']['action'] = 'manage.connector';
    await expectLater(
      ConnectorGithubUpgradeRead.parse(forged, connectorOwner, intent: intent),
      throwsFormatException,
    );
  });

  test('a resealed but changed result cannot claim activation or incomplete review', () async {
    final intent = await _intent();
    final fixture = await githubUpgradeFixture(intent);
    for (final changed in ['active', 'partial', 'generation', 'extra']) {
      final upgrade = connectorMap(jsonDecode(jsonEncode(fixture.upgrade)));
      final result = upgrade['settlement']['result'] as Map<String, dynamic>;
      switch (changed) {
        case 'active':
          result['connectorStatus'] = 'active';
        case 'partial':
          result['pendingCount'] = 1;
        case 'generation':
          result['credentialVersion'] = 99;
        case 'extra':
          result['secret'] = 'not public';
      }
      await expectLater(
        ConnectorGithubUpgradeRead.parse(
          await _reseal(upgrade, intent),
          connectorOwner,
          intent: intent,
        ),
        throwsFormatException,
      );
    }
  });

  test(
    'close must retain admitted attempt or an honest absent-key tombstone',
    () async {
      final intent = await _intent();
      final fixture = await githubUpgradeFixture(intent, state: 'closed');
      final upgrade = connectorMap(jsonDecode(jsonEncode(fixture.upgrade)));
      upgrade['attempt'] = null;
      await expectLater(
        ConnectorGithubUpgradeRead.parse(
          await _reseal(upgrade, intent),
          connectorOwner,
          intent: intent,
        ),
        throwsFormatException,
      );
      final pending = await githubUpgradeFixture(intent, state: 'pending');
      await expectLater(
        ConnectorGithubUpgradeRead.parse(
          await githubUpgradeEnvelope(pending.upgrade, intent, kind: 'close'),
          connectorOwner,
          intent: intent,
          kind: 'close',
        ),
        throwsFormatException,
      );
    },
  );
}
