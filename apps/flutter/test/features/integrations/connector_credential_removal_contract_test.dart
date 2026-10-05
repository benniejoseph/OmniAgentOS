import 'dart:convert';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_credential_removal_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_credential_removal_fixtures.dart';

// Produced by the server's canonical JSON/SHA-256 implementation. Target-state
// digests are synthetic; envelope digests are shared independently with Dart.
const _serverFixture = r'''
{
  "idempotencyKey": "remove-credential-fixture",
  "intent": {
    "contract": "asael-connector-action-intent:1",
    "scope": {
      "tenantId": "connector-removal-fixture",
      "ownerActorId": "owner@example.test",
      "canonicalActorId": "actor:11111111-1111-4111-8111-111111111111"
    },
    "keySha256": "9ae0ab594d16f617547aa4e8d0837bf042d1f98b8283f1fdbd2d45557f4a2226",
    "request": {
      "contract": "asael-connector-lifecycle-action:1",
      "kind": "mcp",
      "connectorId": "connector-one",
      "action": "remove_credential",
      "review": {
        "kind": "mcp",
        "connectorId": "connector-one",
        "connectorSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "contractsSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "configurationSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "reviewFingerprint": null,
        "credentialVersion": 2,
        "reviewSha256": "59acb12566246465c1af4cdec73d618c4e446e3c7e2e6e0faec52348fa7e70e4"
      },
      "preview": null
    }
  },
  "settledAction": {
    "acceptance": {
      "contract": "asael-connector-acceptance:1",
      "id": "connector-acceptance:fc92a297d6d2167ddbd552ad2beaa204ed35de599c96cc22b968db68d38c827c",
      "scope": {
        "tenantId": "connector-removal-fixture",
        "ownerActorId": "owner@example.test",
        "canonicalActorId": "actor:11111111-1111-4111-8111-111111111111"
      },
      "keySha256": "9ae0ab594d16f617547aa4e8d0837bf042d1f98b8283f1fdbd2d45557f4a2226",
      "requestSha256": "631441dfbeff8f227f95726ecf6b988c9f9f234c4138b6db7c3cacac719205ce",
      "kind": "mcp",
      "connectorId": "connector-one",
      "action": "remove_credential",
      "reviewSha256": "59acb12566246465c1af4cdec73d618c4e446e3c7e2e6e0faec52348fa7e70e4",
      "acceptedAt": "2026-10-05T01:00:00.000Z",
      "acceptanceSha256": "7cbc3f634870b1a32af37ea2aba92cfa05d4a3ee3ac20e1c9e06ef7a2adc57b3"
    },
    "state": "settled",
    "settlement": {
      "contract": "asael-connector-settlement:2",
      "acceptanceId": "connector-acceptance:fc92a297d6d2167ddbd552ad2beaa204ed35de599c96cc22b968db68d38c827c",
      "settledAt": "2026-10-05T01:00:00.001Z",
      "result": {
        "kind": "mcp",
        "connectorId": "connector-one",
        "operation": "remove_credential",
        "status": "complete",
        "connectorStatus": "disabled",
        "contractCount": 0,
        "credentialVersion": 3,
        "connectorSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        "contractsSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        "configurationSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "trash": null,
        "failureCode": null
      },
      "settlementSha256": "5b27a5625420cffa351ba185615943bd0bf46d0abd29d72daf6058af327f6ce9"
    }
  }
}
''';

void main() {
  test('server removal intent and v2 settlement retain identical canonical identities in Dart', () async {
    final fixture = connectorMap(jsonDecode(_serverFixture));
    final owner = ConnectorOwner(
      tenantId: 'connector-removal-fixture',
      actorId: 'owner@example.test',
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'admin',
      apiBaseUrl: 'https://example.test',
    );
    final action = connectorMap(fixture['settledAction']);
    final intent = await ConnectorCredentialRemovalIntent.restore({
      'owner': owner.json,
      'key': fixture['idempotencyKey'],
      'identity': fixture['intent'],
      'requestSha256': action['acceptance']['requestSha256'],
    }, owner);
    expect(
      intent.keySha256,
      '9ae0ab594d16f617547aa4e8d0837bf042d1f98b8283f1fdbd2d45557f4a2226',
    );
    expect(
      intent.requestSha256,
      '631441dfbeff8f227f95726ecf6b988c9f9f234c4138b6db7c3cacac719205ce',
    );
    final raw = await removalEnvelope(
      {'action': action, 'replayed': false},
      'submit',
      intent: intent,
      owner: owner,
    );
    final parsed = await ConnectorCredentialRemovalRead.parse(
      raw,
      owner,
      kind: 'submit',
      intent: intent,
    );
    expect(parsed.settled, isTrue);
    expect(
      parsed.action!['settlement']['settlementSha256'],
      '5b27a5625420cffa351ba185615943bd0bf46d0abd29d72daf6058af327f6ce9',
    );
    final read = await removalEnvelope(
      {'action': action},
      'read',
      owner: owner,
    );
    expect(
      (await ConnectorCredentialRemovalRead.parse(
        read,
        owner,
        intent: intent,
      )).settled,
      isTrue,
    );
    final wrongRequest = connectorMap(intent.identity['request']);
    await expectLater(
      ConnectorCredentialRemovalIntent.restore({
        ...intent.stored,
        'identity': {
          ...intent.identity,
          'request': {...wrongRequest, 'action': 'archive'},
        },
      }, owner),
      throwsFormatException,
    );
  });
}
