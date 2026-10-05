import 'dart:convert';
import 'dart:io';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_trash_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_credential_removal_fixtures.dart';
import 'connector_trash_fixtures.dart';
import 'connector_fixtures.dart';

void main() {
  // Exported and validated with the TypeScript Trash contracts and canonical
  // SHA-256 implementation. All records are synthetic historical evidence.
  final server = connectorMap(
    jsonDecode(
      File('test/fixtures/connector_trash/server.json').readAsStringSync(),
    ),
  );
  for (final item in server['cases'] as List) {
    final fixture = connectorMap(item);
    test(
      'server Trash ${fixture['name']} preserves exact preview, intent and receipt identities in Dart',
      () async {
        final scope = connectorMap(fixture['scope']);
        final owner = ConnectorOwner(
          tenantId: scope['tenantId'] as String,
          actorId: scope['ownerActorId'] as String,
          userId: (scope['canonicalActorId'] as String).substring(
            'actor:'.length,
          ),
          role: 'admin',
          apiBaseUrl: 'https://example.test',
        );
        final preview = await ConnectorTrashPreview.parse(
          await trashEnvelope(
            connectorMap(fixture['previewResponse']),
            'preview',
            owner: owner,
          ),
          owner,
          'connector-one',
        );
        expect(preview.review.value, fixture['review']);
        expect(preview.preview, fixture['preview']);
        expect(preview.compensation, fixture['compensation']);
        final fresh = DateTime.parse(fixture['preview']['issuedAt'] as String)
            .add(const Duration(seconds: 1));
        final intent = await ConnectorTrashIntent.prepare(
          owner,
          preview,
          key: fixture['key'] as String,
          now: fresh,
        );
        expect(intent.request, fixture['request']);
        expect(intent.identity, fixture['intent']);
        expect(intent.keySha256, fixture['acceptance']['keySha256']);
        expect(intent.requestSha256, fixture['acceptance']['requestSha256']);
        final historical = await ConnectorTrashIntent.restore({
          'owner': owner.json,
          'key': fixture['key'],
          'identity': fixture['intent'],
          'requestSha256': fixture['acceptance']['requestSha256'],
        }, owner);
        expect(historical.identity, intent.identity);
        final expired = DateTime.parse(
          fixture['preview']['expiresAt'] as String,
        );
        expect(preview.freshAt(expired), isFalse);
        await expectLater(
          ConnectorTrashIntent.prepare(
            owner,
            preview,
            key: fixture['key'] as String,
            now: expired,
          ),
          throwsFormatException,
        );
        for (final field in ['pendingAction', 'action']) {
          for (final kind in ['submit', 'read']) {
            final response = await ConnectorTrashRead.parse(
              await trashEnvelope(
                {
                  'action': fixture[field],
                  if (kind == 'submit') 'replayed': true,
                },
                kind,
                intent: kind == 'submit' ? historical : null,
                owner: owner,
              ),
              owner,
              kind: kind,
              intent: historical,
            );
            expect(response.action, fixture[field]);
            expect(response.acceptance, fixture['acceptance']);
            expect(response.settled, field == 'action');
            if (response.settled) {
              expect(response.action!['settlement'], fixture['settlement']);
            }
          }
        }
      },
    );
  }
  test(
    'server missing-target preview preserves authenticated absence',
    () async {
      final preview = await ConnectorTrashPreview.parse(
        await trashEnvelope(connectorMap(server['missing']), 'preview'),
        connectorOwner,
        'connector-one',
      );
      expect(preview.review.value, isNull);
      expect(preview.preview, isNull);
      expect(preview.compensation, isNull);
    },
  );

  test(
    'shared nested review validation never bypasses the v40 envelope authority',
    () async {
      final review = await removalReviewFixture();
      expect(
        await ConnectorReview.parseValue(review.value, 'mcp', 'mcp:one'),
        review.value,
      );
      final proof = connectorMap(review.raw['serviceReceipt']);
      for (final changed in <ConnectorJson>[
        {
          'scope': {
            ...connectorOwner.scope,
            'ownerActorId': 'another@example.test',
          },
        },
        {
          'serviceReceipt': {...proof, 'authoritySha256': '0' * 64},
        },
        {
          'serviceReceipt': {
            ...proof,
            'operation': 'app.connectors.native.trash.preview',
          },
        },
      ]) {
        await expectLater(
          ConnectorReview.parse(
            {...review.raw, ...changed},
            connectorOwner,
            'mcp',
            'mcp:one',
          ),
          throwsFormatException,
        );
      }
    },
  );

  test('even resealed previews reject changed target, duration, effect, compensation and receipt authority', () async {
    final reviewed = await trashPreviewFixture();
    for (final change in <ConnectorJson>[
      {'resourceId': 'mcp:other'},
      {'resourceType': 'openapi_connector'},
      {
        'expiresAt': trashNow
            .add(const Duration(minutes: 11))
            .toIso8601String(),
      },
      {'targetSha256': 'f' * 64},
      {'effectSummary': 'Move a different connection.'},
      {'trashId': trashId},
      {'reversible': false},
      {'unexpected': true},
    ]) {
      final preview = {...reviewed.preview!, ...change}
        ..remove('previewSha256');
      final raw = await trashEnvelope({
        'review': reviewed.review.value,
        'preview': {...preview, 'previewSha256': await connectorSha(preview)},
        'compensation': reviewed.compensation,
      }, 'preview');
      await expectLater(
        ConnectorTrashPreview.parse(raw, connectorOwner, 'mcp:one'),
        throwsFormatException,
      );
    }
    final changedCompensation = await trashEnvelope({
      'review': reviewed.review.value,
      'preview': reviewed.preview,
      'compensation': {
        'kind': 'exact_restore',
        'handlerId': 'trash.restore.mcp_connector',
        'limitation': null,
      },
    }, 'preview');
    await expectLater(
      ConnectorTrashPreview.parse(
        changedCompensation,
        connectorOwner,
        'mcp:one',
      ),
      throwsFormatException,
    );
    for (final field in ['authoritySha256', 'outcomeSha256']) {
      final receipt = {
        ...connectorMap(reviewed.raw['serviceReceipt']),
        field: 'a' * 64,
      }..remove('receiptSha256');
      await expectLater(
        ConnectorTrashPreview.parse(
          {
            ...reviewed.raw,
            'serviceReceipt': {
              ...receipt,
              'receiptSha256': await connectorSha(receipt),
            },
          },
          connectorOwner,
          'mcp:one',
        ),
        throwsFormatException,
      );
    }
    final receipt = {
      ...connectorMap(reviewed.raw['serviceReceipt']),
      'action': 'read',
    }..remove('receiptSha256');
    await expectLater(
      ConnectorTrashPreview.parse(
        {
          ...reviewed.raw,
          'serviceReceipt': {
            ...receipt,
            'receiptSha256': await connectorSha(receipt),
          },
        },
        connectorOwner,
        'mcp:one',
      ),
      throwsFormatException,
    );
  });

  test('historical parsing preserves expired preview identity while fresh preparation refuses', () async {
    final preview = await trashPreviewFixture();
    final intent = await ConnectorTrashIntent.prepare(
      connectorOwner,
      preview,
      key: 'historical-trash',
      now: trashNow,
    );
    await expectLater(
      ConnectorTrashIntent.prepare(
        connectorOwner,
        preview,
        now: trashNow.add(const Duration(minutes: 10)),
      ),
      throwsFormatException,
    );
    final restored = await ConnectorTrashIntent.restore(
      intent.stored,
      connectorOwner,
    );
    expect(restored.identity, intent.identity);
    expect(restored.requestSha256, intent.requestSha256);
    expect(
      (await trashActionFixture(restored, mutation: false)).settled,
      isTrue,
    );
    final missing = await trashPreviewFixture(missing: true);
    expect(missing.review.value, isNull);
    expect(missing.preview, isNull);
    final noVault = await trashPreviewFixture(vault: false, version: 0);
    expect(noVault.compensation!['kind'], 'exact_restore');
    expect(noVault.compensation!['limitation'], isNull);
  });

  test('resealed settlements refuse live-state claims, changed family, invalid proof and false restore promise', () async {
    final intent = await ConnectorTrashIntent.prepare(
      connectorOwner,
      await trashPreviewFixture(),
      now: trashNow,
      key: 'effect',
    );
    final response = await trashActionFixture(intent);
    final old = connectorMap(response.action!['settlement']);
    final originalResult = connectorMap(old['result']);
    final proof = connectorMap(originalResult['trash']);
    for (final change in <ConnectorJson>[
      {'credentialVersion': 4},
      {'connectorStatus': 'disabled'},
      {'contractCount': 0},
      {'connectorSha256': 'b' * 64},
      {'operation': 'remove_credential'},
      {'failureCode': 'failed'},
      {'unexpected': true},
      {
        'trash': {...proof, 'proofSha256': 'bad'},
      },
      {
        'trash': {...proof, 'restoreUntil': old['settledAt']},
      },
      {
        'trash': {...proof, 'restoreUntil': '2026-11-05T12:00:00+00:00'},
      },
      {
        'trash': {...proof, 'compensation': 'exact_restore'},
      },
      {
        'trash': {...proof, 'compensation': 'unavailable'},
      },
      {
        'trash': {...proof, 'limitation': 'Token automatically reconnected'},
      },
    ]) {
      final settlement = {
        ...old,
        'result': {...originalResult, ...change},
      }..remove('settlementSha256');
      final raw = await trashEnvelope(
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
        ConnectorTrashRead.parse(
          raw,
          connectorOwner,
          kind: 'submit',
          intent: intent,
        ),
        throwsFormatException,
      );
    }
    final other = await ConnectorTrashIntent.prepare(
      connectorOwner,
      await trashPreviewFixture(),
      now: trashNow,
      key: 'other',
    );
    await expectLater(
      ConnectorTrashRead.parse(
        response.raw,
        connectorOwner,
        kind: 'submit',
        intent: other,
      ),
      throwsFormatException,
    );
  });
}
