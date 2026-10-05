import 'dart:convert';
import 'dart:io';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_mcp_discovery_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_fixtures.dart';
import 'connector_mcp_discovery_fixtures.dart';

Future<ConnectorMcpDiscoveryIntent> _intent() async =>
    ConnectorMcpDiscoveryIntent.prepare(
      connectorOwner,
      await connectorReviewFixture(),
      key: 'synthetic-discovery-contract',
    );

Future<ConnectorJson> _reseal(
  ConnectorJson row,
  ConnectorMcpDiscoveryIntent intent,
) async {
  for (final field in ['attempt', 'settlement', 'closure']) {
    if (row[field] != null) {
      final body = connectorMap(row[field])..remove('${field}Sha256');
      row[field] = {...body, '${field}Sha256': await connectorSha(body)};
    }
  }
  return discoveryEnvelope(row, intent);
}

void main() {
  test('independent TS evidence preserves every auth mode, catalog bound and terminal branch in Dart', () async {
    final fixture = connectorMap(
      jsonDecode(
        File('test/fixtures/native_mcp_discovery.json').readAsStringSync(),
      ),
    );
    expect(fixture['schemaVersion'], 1);
    final matrix = <String>{};
    for (final raw in fixture['cases'] as List) {
      final source = connectorMap(raw), scope = connectorMap(source['scope']);
      final canonical = scope['canonicalActorId'] as String;
      expect(canonical.startsWith('actor:'), isTrue);
      final owner = ConnectorOwner(
        tenantId: scope['tenantId'] as String,
        actorId: scope['ownerActorId'] as String,
        userId: canonical.substring(6),
        role: 'admin',
        apiBaseUrl: 'https://discovery-fixture.example.test',
      );
      // These domain digests and identities were independently produced and
      // validated by the server schemas; only the authenticated wrapper is local.
      final intent = await ConnectorMcpDiscoveryIntent.restore({
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
        final read = await ConnectorMcpDiscoveryRead.parse(
          await discoveryEnvelope(
            connectorMap(source[field]),
            intent,
            owner: owner,
          ),
          owner,
          intent: intent,
        );
        expect(read.discovery, source[field]);
      }
      for (final rawFailure in source['failed'] as List) {
        final read = await ConnectorMcpDiscoveryRead.parse(
          await discoveryEnvelope(
            connectorMap(rawFailure),
            intent,
            owner: owner,
          ),
          owner,
          intent: intent,
        );
        expect(read.result!['status'], 'failed');
      }
      for (final field in ['closedAttempt', 'closedAbsent', 'closeSettled']) {
        final read = await ConnectorMcpDiscoveryRead.parse(
          await discoveryEnvelope(
            connectorMap(source[field]),
            intent,
            kind: 'close',
            owner: owner,
          ),
          owner,
          intent: intent,
          kind: 'close',
        );
        expect(read.terminal, isTrue);
        expect(read.discovery, source[field]);
      }
      final result = source['settled']['settlement']['result'] as Map;
      expect(
        result['credentialVersion'],
        source['authType'] == 'bearer_vault' ? 7 : 0,
      );
      matrix.add('${source['authType']}/${result['contractCount']}');
    }
    expect(matrix, {
      for (final mode in ['none', 'bearer_env', 'bearer_vault'])
        for (final count in [0, 2, 200]) '$mode/$count',
    });
  });

  test('all historical states and bounded static failures bind the original intent', () async {
    final intent = await _intent();
    for (final state in ['pending', 'expired', 'settled', 'closed']) {
      final read = await discoveryFixture(intent, state: state);
      expect(read.state, state);
      expect(read.terminal, state == 'settled' || state == 'closed');
    }
    for (final failure in [
      'discovery_failed',
      'catalog_unreviewable',
      'target_changed',
      'deadline_exceeded',
    ]) {
      final read = await discoveryFixture(intent, failure: failure);
      expect(read.result!['failureCode'], failure);
      expect(read.result!.containsKey('connectorStatus'), isFalse);
    }
    expect(
      (await discoveryFixture(intent, state: 'closed', absent: true)).attempt,
      isNull,
    );
    expect(
      (await discoveryFixture(intent, count: 0)).result!['contractCount'],
      0,
    );
  });

  test('correctly resealed result still rejects changed credential generation and empty-catalog mismatch', () async {
    final intent = await _intent();
    final fixture = await discoveryFixture(intent);
    for (final invalid in ['generation', 'empty', 'unknown']) {
      final row = connectorMap(jsonDecode(jsonEncode(fixture.discovery)));
      final result = row['settlement']['result'] as Map<String, dynamic>;
      if (invalid == 'generation') {
        result['credentialVersion'] = 4;
      } else if (invalid == 'empty') {
        result['contractCount'] = 0;
        result['pendingCount'] = 0;
      } else {
        result['unreviewedExtra'] = true;
      }
      await expectLater(
        ConnectorMcpDiscoveryRead.parse(
          await _reseal(row, intent),
          connectorOwner,
          intent: intent,
        ),
        throwsFormatException,
      );
    }
  });

  test(
    'deadline failure cannot predate expiry and complete cannot reach expiry',
    () async {
      final intent = await _intent();
      for (final failed in [true, false]) {
        final fixture = await discoveryFixture(
          intent,
          failure: failed ? 'deadline_exceeded' : null,
        );
        final row = connectorMap(jsonDecode(jsonEncode(fixture.discovery)));
        row['settlement']['settledAt'] =
            row['attempt'][failed ? 'startedAt' : 'expiresAt'];
        await expectLater(
          ConnectorMcpDiscoveryRead.parse(
            await _reseal(row, intent),
            connectorOwner,
            intent: intent,
          ),
          throwsFormatException,
        );
      }
    },
  );

  test(
    'an admitted closure cannot be relabelled an absent-key tombstone',
    () async {
      final intent = await _intent();
      final row = connectorMap(
        jsonDecode(
          jsonEncode(
            (await discoveryFixture(intent, state: 'closed')).discovery,
          ),
        ),
      );
      row['attempt'] = null;
      await expectLater(
        ConnectorMcpDiscoveryRead.parse(
          await _reseal(row, intent),
          connectorOwner,
          intent: intent,
        ),
        throwsFormatException,
      );
    },
  );

  test('close validates owner read-mutation receipt and cannot return pending evidence', () async {
    final intent = await _intent();
    final closed = await discoveryFixture(
      intent,
      state: 'closed',
      kind: 'close',
    );
    expect(closed.terminal, isTrue);
    final pending = await discoveryFixture(intent, state: 'pending');
    await expectLater(
      ConnectorMcpDiscoveryRead.parse(
        await discoveryEnvelope(pending.discovery, intent, kind: 'close'),
        connectorOwner,
        intent: intent,
        kind: 'close',
      ),
      throwsFormatException,
    );
  });
}
