import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_trash_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_credential_removal_fixtures.dart';
import 'connector_trash_fixtures.dart';
import 'connector_fixtures.dart';

void main() {
  test('shared nested review validation never bypasses the v40 envelope authority', () async {
    final review = await removalReviewFixture();
    expect(await ConnectorReview.parseValue(review.value, 'mcp', 'mcp:one'), review.value);
    final proof = connectorMap(review.raw['serviceReceipt']);
    for (final changed in <ConnectorJson>[
      {'scope': {...connectorOwner.scope, 'ownerActorId': 'another@example.test'}},
      {'serviceReceipt': {...proof, 'authoritySha256': '0' * 64}},
      {'serviceReceipt': {...proof, 'operation': 'app.connectors.native.trash.preview'}},
    ]) {
      await expectLater(ConnectorReview.parse({...review.raw, ...changed},
        connectorOwner, 'mcp', 'mcp:one'), throwsFormatException);
    }
  });

  test('even resealed previews reject changed target, duration, effect, compensation and receipt authority', () async {
    final reviewed = await trashPreviewFixture();
    for (final change in <ConnectorJson>[
      {'resourceId': 'mcp:other'},
      {'resourceType': 'openapi_connector'},
      {'expiresAt': trashNow.add(const Duration(minutes: 11)).toIso8601String()},
      {'targetSha256': 'f' * 64},
      {'effectSummary': 'Move a different connection.'},
      {'trashId': trashId},
      {'reversible': false},
      {'unexpected': true},
    ]) {
      final preview = {...reviewed.preview!, ...change}..remove('previewSha256');
      final raw = await trashEnvelope({'review': reviewed.review.value,
        'preview': {...preview, 'previewSha256': await connectorSha(preview)},
        'compensation': reviewed.compensation}, 'preview');
      await expectLater(ConnectorTrashPreview.parse(raw, connectorOwner, 'mcp:one'), throwsFormatException);
    }
    final changedCompensation = await trashEnvelope({'review': reviewed.review.value,
      'preview': reviewed.preview, 'compensation': {'kind': 'exact_restore',
      'handlerId': 'trash.restore.mcp_connector', 'limitation': null}}, 'preview');
    await expectLater(ConnectorTrashPreview.parse(changedCompensation, connectorOwner, 'mcp:one'), throwsFormatException);
    for (final field in ['authoritySha256', 'outcomeSha256']) {
      final receipt = {...connectorMap(reviewed.raw['serviceReceipt']), field: 'a' * 64}..remove('receiptSha256');
      await expectLater(ConnectorTrashPreview.parse({...reviewed.raw,
        'serviceReceipt': {...receipt, 'receiptSha256': await connectorSha(receipt)}},
        connectorOwner, 'mcp:one'), throwsFormatException);
    }
    final receipt = {...connectorMap(reviewed.raw['serviceReceipt']), 'action': 'read'}..remove('receiptSha256');
    await expectLater(ConnectorTrashPreview.parse({...reviewed.raw,
      'serviceReceipt': {...receipt, 'receiptSha256': await connectorSha(receipt)}},
      connectorOwner, 'mcp:one'), throwsFormatException);
  });

  test('historical parsing preserves expired preview identity while fresh preparation refuses', () async {
    final preview = await trashPreviewFixture();
    final intent = await ConnectorTrashIntent.prepare(connectorOwner, preview,
      key: 'historical-trash', now: trashNow);
    await expectLater(ConnectorTrashIntent.prepare(connectorOwner, preview,
      now: trashNow.add(const Duration(minutes: 10))), throwsFormatException);
    final restored = await ConnectorTrashIntent.restore(intent.stored, connectorOwner);
    expect(restored.identity, intent.identity);
    expect(restored.requestSha256, intent.requestSha256);
    expect((await trashActionFixture(restored, mutation: false)).settled, isTrue);
    final missing = await trashPreviewFixture(missing: true);
    expect(missing.review.value, isNull);
    expect(missing.preview, isNull);
    final noVault = await trashPreviewFixture(vault: false, version: 0);
    expect(noVault.compensation!['kind'], 'exact_restore');
    expect(noVault.compensation!['limitation'], isNull);
  });

  test('resealed settlements refuse live-state claims, changed family, invalid proof and false restore promise', () async {
    final intent = await ConnectorTrashIntent.prepare(connectorOwner,
      await trashPreviewFixture(), now: trashNow, key: 'effect');
    final response = await trashActionFixture(intent);
    final old = connectorMap(response.action!['settlement']);
    final originalResult = connectorMap(old['result']);
    final proof = connectorMap(originalResult['trash']);
    for (final change in <ConnectorJson>[
      {'credentialVersion': 4}, {'connectorStatus': 'disabled'}, {'contractCount': 0},
      {'connectorSha256': 'b' * 64}, {'operation': 'remove_credential'},
      {'failureCode': 'failed'}, {'unexpected': true},
      {'trash': {...proof, 'proofSha256': 'bad'}},
      {'trash': {...proof, 'restoreUntil': old['settledAt']}},
      {'trash': {...proof, 'restoreUntil': '2026-11-05T12:00:00+00:00'}},
      {'trash': {...proof, 'compensation': 'exact_restore'}},
      {'trash': {...proof, 'compensation': 'unavailable'}},
      {'trash': {...proof, 'limitation': 'Token automatically reconnected'}},
    ]) {
      final settlement = {...old, 'result': {...originalResult, ...change}}..remove('settlementSha256');
      final raw = await trashEnvelope({'action': {...response.action!,
        'settlement': {...settlement, 'settlementSha256': await connectorSha(settlement)}},
        'replayed': false}, 'submit', intent: intent);
      await expectLater(ConnectorTrashRead.parse(raw, connectorOwner,
        kind: 'submit', intent: intent), throwsFormatException);
    }
    final other = await ConnectorTrashIntent.prepare(connectorOwner,
      await trashPreviewFixture(), now: trashNow, key: 'other');
    await expectLater(ConnectorTrashRead.parse(response.raw, connectorOwner,
      kind: 'submit', intent: other), throwsFormatException);
  });
}
