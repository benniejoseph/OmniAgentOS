import 'dart:convert';
import 'dart:io';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_mcp_registration_contracts.dart';
import 'package:asael/features/integrations/connector_openapi_import_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_fixtures.dart';
import 'connector_openapi_import_fixtures.dart';

void main() {
  test('preparation nonce matches strict server UUID versions, variant, nil and max', () async {
    for (final nonce in [
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      '11111111-1111-8111-B111-111111111111',
    ]) {
      final intent = await ConnectorOpenApiImportPreparationIntent.prepare(
        connectorOwner,
        importDeclaration(),
        nonce: nonce,
      );
      expect(intent.identity['nonce'], nonce);
      expect(
        (await ConnectorOpenApiImportPreparationIntent.restore(
          intent.stored,
          connectorOwner,
        )).identity,
        intent.identity,
      );
    }
    for (final nonce in [
      '11111111-1111-9111-8111-111111111111',
      '11111111-1111-4111-7111-111111111111',
      'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
    ]) {
      await expectLater(
        ConnectorOpenApiImportPreparationIntent.prepare(
          connectorOwner,
          importDeclaration(),
          nonce: nonce,
        ),
        throwsFormatException,
      );
    }
  });
  // Domain values and digests come from the independent TypeScript schemas.
  final server = connectorMap(
    jsonDecode(
      File('test/fixtures/native_openapi_import.json').readAsStringSync(),
    ),
  );
  for (final entry in server['cases'] as List) {
    final row = connectorMap(entry), f = connectorMap(row['fixture']);
    test(
      'TypeScript ${row['source']}/${row['authType']} private=${row['privateSource']} preserves every identity and tagged state',
      () async {
        final scope = connectorMap(f['scope']);
        final owner = ConnectorOwner(
          tenantId: scope['tenantId'] as String,
          actorId: scope['ownerActorId'] as String,
          userId: (scope['canonicalActorId'] as String).substring(
            'actor:'.length,
          ),
          role: 'admin',
          apiBaseUrl: 'https://example.test',
        );
        final request = connectorMap(f['prepareRequest']);
        final intent = await ConnectorOpenApiImportPreparationIntent.prepare(
          owner,
          connectorMap(request['declaration']),
          key: f['preparationKey'] as String,
          nonce: f['nonce'] as String,
        );
        expect(intent.identity, f['intent']);
        expect(
          intent.privateRequest(connectorMap(request['payload'])),
          request,
        );
        expect(intent.abandonRequest, f['abandonRequest']);
        final proof = await ConnectorOpenApiImportPreparationProof.parse(
          f['preparation'],
          intent,
          f['attempt'],
        );
        expect(proof.raw, f['preparation']);
        expect(
          proof.freshAt(DateTime.parse(proof.raw['expiresAt'] as String)),
          isFalse,
        );
        for (final field in [
          'preparing',
          'ready',
          'expired',
          'expiredAttempt',
          'failed',
          'consumed',
          'abandonedAbsent',
          'abandonedAttempt',
          'abandonedPrepared',
        ]) {
          for (final kind in [
            'read',
            field.startsWith('abandoned') ? 'abandon' : 'submit',
          ]) {
            final parsed = await ConnectorOpenApiImportPreparationRead.parse(
              await importEnvelope(
                {'prepared': f[field], if (kind != 'read') 'replayed': true},
                'openapiImportPreparations',
                kind,
                owner: owner,
                key: kind == 'read' ? null : intent.key,
                id: intent.id,
              ),
              owner,
              intent: intent,
              kind: kind,
            );
            expect(
              parsed.prepared,
              {...connectorMap(f[field])}..remove('summary'),
            );
            expect(parsed.summary, field == 'ready' ? f['summary'] : null);
            expect(parsed.stored!.containsKey('summary'), isFalse);
            final restored =
                await ConnectorOpenApiImportPreparationRead.restore(
                  parsed.stored,
                  intent,
                );
            expect(restored.prepared, parsed.prepared);
            expect(restored.summary, isNull);
          }
        }
        final finalIntent = await ConnectorOpenApiImportIntent.create(
          intent,
          proof,
          key: f['finalKey'] as String,
        );
        expect(finalIntent.identity, f['actionIntent']);
        expect(finalIntent.request, f['request']);
        final linked = await ConnectorOpenApiImportIntent.create(
          intent,
          proof,
          consumedKeySha256: f['consumed']['consumedKeySha256'] as String,
        );
        expect(linked.key, isNull);
        expect(linked.identity, finalIntent.identity);
        expect(
          (await ConnectorOpenApiImportIntent.restore(
            linked.stored,
            owner,
          )).identity,
          linked.identity,
        );
        for (final kind in ['submit', 'read']) {
          final read = await ConnectorOpenApiImportRead.parse(
            await importEnvelope(
              {'action': f['action'], if (kind == 'submit') 'replayed': true},
              'openapiImports',
              kind,
              owner: owner,
              key: kind == 'submit' ? finalIntent.key : null,
              id: intent.id,
            ),
            owner,
            intent: kind == 'submit' ? finalIntent : linked,
            kind: kind,
          );
          expect(read.action, f['action']);
          expect(read.settled, isTrue);
        }
      },
    );
  }

  test('source and API base URL normalize independently including empty delimiters', () {
    for (final value in server['normalization'] as List) {
      final f = connectorMap(value), input = f['input'] as String;
      expect(normalizeMcpRegistrationEndpoint(input), f['source']);
      expect(mcpRegistrationEndpointProjection(input), {
        'endpoint': f['specUrl'],
        'endpointRedacted': f['specUrlRedacted'],
      });
      if (f['base'] == null) {
        expect(() => normalizeOpenApiImportBase(input), throwsFormatException);
      } else {
        expect(normalizeOpenApiImportBase(input), f['base']);
      }
    }
    for (final bad in [
      'authorization',
      'Cookie',
      'proxy-secret',
      'x-forwarded-key',
      'x-api-key\r\nother',
    ]) {
      expect(openApiImportHeaderValid(bad), isFalse);
    }
    expect(openApiImportHeaderValid('x-api-key'), isTrue);
    for (final bad in [
      '/../private',
      '/%2e%2e/private',
      '/%252e/private',
      '/%2fprivate',
      '/items?key',
      '/%5cprivate',
      '/bad%',
    ]) {
      expect(openApiImportPathValid(bad), isFalse);
    }
    expect(openApiImportPathValid('/items/{id}'), isTrue);
  });

  test('complete summary order, write risk floor and service authority cannot be bypassed', () async {
    final intent = await ConnectorOpenApiImportPreparationIntent.prepare(
      connectorOwner,
      importDeclaration(),
    );
    final proof = await importProof(intent);
    final summary = await importSummary(intent);
    final prepared = {
      'availability': 'ready',
      'intent': intent.identity,
      'attempt': proof.attempt,
      'preparation': proof.raw,
      'summary': summary,
    };
    final reordered = {
      ...summary,
      'operations': (summary['operations'] as List).reversed.toList(),
    };
    await expectLater(
      ConnectorOpenApiImportPreparationRead.parse(
        await importEnvelope(
          {
            'prepared': {...prepared, 'summary': reordered},
          },
          'openapiImportPreparations',
          'read',
          id: intent.id,
        ),
        connectorOwner,
        intent: intent,
      ),
      throwsFormatException,
    );
    final envelope = await importEnvelope(
      {'prepared': prepared},
      'openapiImportPreparations',
      'read',
      id: intent.id,
    );
    envelope['serviceReceipt']['authoritySha256'] = 'a' * 64;
    await expectLater(
      ConnectorOpenApiImportPreparationRead.parse(
        envelope,
        connectorOwner,
        intent: intent,
      ),
      throwsFormatException,
    );
    final lowRisk = {
      ...summary,
      'operations': [
        (summary['operations'] as List).first,
        {...connectorMap((summary['operations'] as List).last), 'riskLevel': 1},
      ],
    };
    final changedProofBody = {
      ...proof.raw,
      'summarySha256': await connectorSha(lowRisk),
    }..remove('preparationSha256');
    final changedProof = {
      ...changedProofBody,
      'preparationSha256': await connectorSha(changedProofBody),
    };
    await expectLater(
      ConnectorOpenApiImportPreparationRead.parse(
        await importEnvelope(
          {
            'prepared': {
              ...prepared,
              'preparation': changedProof,
              'summary': lowRisk,
            },
          },
          'openapiImportPreparations',
          'read',
          id: intent.id,
        ),
        connectorOwner,
        intent: intent,
      ),
      throwsFormatException,
    );
  });

  test('validly resealed settlement cannot change issued count or configuration binding', () async {
    final p = await ConnectorOpenApiImportPreparationIntent.prepare(
      connectorOwner,
      importDeclaration(),
    );
    final intent = await ConnectorOpenApiImportIntent.create(
      p,
      await importProof(p),
    );
    final valid = await importAction(intent);
    for (final field in ['contractCount', 'configurationSha256']) {
      final action = connectorMap(jsonDecode(jsonEncode(valid.action)));
      final settlement = connectorMap(action['settlement']);
      settlement['result'][field] = field == 'contractCount' ? 1 : 'a' * 64;
      settlement['settlementSha256'] = await connectorSha(
        {...settlement}..remove('settlementSha256'),
      );
      action['settlement'] = settlement;
      await expectLater(
        ConnectorOpenApiImportRead.parse(
          await importEnvelope(
            {'action': action},
            'openapiImports',
            'read',
            id: p.id,
          ),
          connectorOwner,
          intent: intent,
        ),
        throwsFormatException,
      );
    }
  });

  test('text byte bound rejects oversized multibyte source before durable intent dispatch', () async {
    final intent = await ConnectorOpenApiImportPreparationIntent.prepare(
      connectorOwner,
      importDeclaration(source: 'text'),
    );
    expect(
      () => intent.privateRequest({
        'endpoint': null,
        'specUrl': null,
        'specText': 'é' * 1000001,
      }),
      throwsFormatException,
    );
    expect(jsonEncode(intent.stored), isNot(contains('specText')));
  });
}
