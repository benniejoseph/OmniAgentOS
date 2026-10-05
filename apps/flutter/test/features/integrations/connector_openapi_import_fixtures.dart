import 'dart:async';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_openapi_import_contracts.dart';
import 'package:asael/features/integrations/connector_openapi_import_recovery_store.dart';
import 'package:asael/features/integrations/connector_openapi_import_repository.dart';

import 'connector_fixtures.dart';

final importNow = DateTime.utc(2026, 10, 6, 12);
const importUrl =
    'https://example.test/spec.json?synthetic-private-query#synthetic-fragment';
const importText = '{"openapi":"3.0.0","private":"synthetic-private-spec"}';
ConnectorJson importDeclaration({
  String authType = 'none',
  String source = 'url',
}) => openApiImportDeclaration(
  name: 'Synthetic OpenAPI import',
  source: source,
  specUrl: source == 'url' ? importUrl : null,
  authType: authType,
  authTokenEnv: authType == 'none' ? null : 'OMNIAGENT_CONNECTOR_TEST_TOKEN',
  authHeaderName: authType == 'api_key_header_env' ? 'x-api-key' : null,
);
ConnectorJson importPayload({String source = 'url'}) => {
  'endpoint': null,
  'specUrl': source == 'url' ? importUrl : null,
  'specText': source == 'text' ? importText : null,
};

Future<ConnectorJson> importEnvelope(
  ConnectorJson body,
  String family,
  String kind, {
  ConnectorOwner? owner,
  String? key,
  String id = 'mcp:one',
}) async {
  final scope = owner ?? connectorOwner, mutation = kind != 'read';
  final preparation = family == 'openapiImportPreparations';
  final execution = mutation
      ? {
          'version': 1,
          'tenantId': scope.tenantId,
          'initiatingActorId': scope.actorId,
          'executingPrincipalType': 'user',
          'executingPrincipalId': scope.actorId,
          'workspaceId': null,
          'projectId': null,
          'missionId': null,
          'delegationId': null,
          'correlationId': key!.length <= 256
              ? key
              : 'idempotency-key:${await connectorSha(key)}',
          'causationId': id,
          'contextGrantIds': <String>[],
          'capabilityGrantIds': <String>[],
          'purpose': kind == 'abandon'
              ? 'api.connectors.native.openapi_import_preparation.abandon'
              : 'api.connectors.native.action',
        }
      : null;
  final wire = {
    'contract': connectorControlContract,
    'scope': scope.scope,
    ...body,
  };
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': 'app.connectors.native.$family.$kind',
    'action': kind == 'read' || kind == 'abandon' ? 'read' : 'manage.connector',
    'resourceType': preparation
        ? 'connector_native_preparation'
        : 'connector_native_action',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? (preparation
              ? 'connector-native-openapi-import-preparation-events.v1'
              : 'connector-native-openapi-import-events.v1')
        : 'read_only:no_domain_mutation',
    'authoritySha256': await connectorSha({
      'boundaryVersion': 'p9.1-app-service-boundary:1',
      'tenantId': scope.tenantId,
      'actorId': scope.actorId,
      'role': scope.role,
      'executionScope': execution,
    }),
    'idempotencyKeySha256': mutation
        ? await connectorRawSha('${scope.tenantId}\u0000$key')
        : null,
    'outcomeSha256': await connectorSha(wire),
    'resourceCount': body[preparation ? 'prepared' : 'action'] == null ? 0 : 1,
    'occurredAt': importNow.toIso8601String(),
  };
  return {
    ...wire,
    'serviceReceipt': {
      ...receipt,
      'receiptSha256': await connectorSha(receipt),
    },
  };
}

Future<ConnectorJson> importSummary(
  ConnectorOpenApiImportPreparationIntent intent,
) async => {
  'contract': 'asael-openapi-import-summary:1',
  'connectorId': intent.id,
  'operations': [
    for (final method in ['GET', 'POST'])
      {
        'id': 'openapi:${intent.id}:${method.toLowerCase()}_items',
        'operationId': '${method.toLowerCase()}_items',
        'method': method,
        'path': '/items',
        'riskLevel':
            (intent.declaration['defaultRiskLevel'] as int) < 2 &&
                method == 'POST'
            ? 2
            : intent.declaration['defaultRiskLevel'],
        'approvalRequired': intent.declaration['approvalRequired'],
        'definitionSha256': 'd' * 64,
      },
  ],
};

Future<ConnectorOpenApiImportPreparationProof> importProof(
  ConnectorOpenApiImportPreparationIntent intent, {
  DateTime? at,
}) async {
  final issued = at ?? importNow;
  final attemptBody = {
    'contract': 'asael-openapi-import-attempt:1',
    'id':
        'connector-openapi-import-attempt:${await connectorSha({'operation': 'import_openapi', 'scope': intent.owner.scope, 'keySha256': intent.keySha256})}',
    'scope': intent.owner.scope,
    'keySha256': intent.keySha256,
    'intentSha256': intent.intentSha256,
    'startedAt': issued.subtract(const Duration(seconds: 1)).toIso8601String(),
    'expiresAt': issued.add(const Duration(seconds: 44)).toIso8601String(),
  };
  final attempt = {
    ...attemptBody,
    'attemptSha256': await connectorSha(attemptBody),
  };
  final body = {
    ...intent.identity,
    'contract': 'asael-openapi-import-preparation:1',
    'id':
        'connector-preparation:${await connectorSha({'operation': 'import_openapi', 'scope': intent.owner.scope, 'keySha256': intent.keySha256})}',
    'intentSha256': intent.intentSha256,
    'resolvedDeclaration': {
      ...intent.declaration,
      'endpoint': intent.declaration['endpoint'] ?? 'https://example.test/api',
    },
    'attemptSha256': attempt['attemptSha256'],
    'configurationSha256': 'c' * 64,
    'snapshotSha256': 'e' * 64,
    'reviewProjectionSha256': 'f' * 64,
    'summarySha256': await connectorSha(await importSummary(intent)),
    'contractCount': 2,
    'preparedAt': issued.toIso8601String(),
    'expiresAt': issued.add(const Duration(minutes: 15)).toIso8601String(),
  };
  return ConnectorOpenApiImportPreparationProof.parse(
    {...body, 'preparationSha256': await connectorSha(body)},
    intent,
    attempt,
  );
}

Future<ConnectorOpenApiImportPreparationRead> importPreparation(
  ConnectorOpenApiImportPreparationIntent intent, {
  String kind = 'read',
  String availability = 'ready',
  bool missing = false,
  bool tombstone = false,
  bool expiredAttempt = false,
  String? consumedKey,
  ConnectorOwner? owner,
  DateTime? proofAt,
}) async {
  final proof = await importProof(intent, at: proofAt);
  final hasProof =
      !tombstone &&
      !expiredAttempt &&
      !const ['preparing', 'failed'].contains(availability);
  final abandonment = {
    'contract': 'asael-openapi-import-preparation-abandonment:1',
    'id':
        'connector-preparation-abandonment:${await connectorSha({'operation': 'import_openapi', 'scope': intent.owner.scope, 'keySha256': intent.keySha256})}',
    'scope': intent.owner.scope,
    'keySha256': intent.keySha256,
    'intentSha256': intent.intentSha256,
    'attemptSha256': tombstone ? null : proof.attempt['attemptSha256'],
    'preparationSha256': hasProof ? proof.sha256 : null,
    'abandonedAt': importNow.toIso8601String(),
  };
  final prepared = missing
      ? null
      : {
          'availability': availability,
          'intent': intent.identity,
          'attempt': tombstone ? null : proof.attempt,
          if (const [
            'ready',
            'expired',
            'consumed',
            'abandoned',
          ].contains(availability))
            'preparation': hasProof ? proof.raw : null,
          if (availability == 'ready') 'summary': await importSummary(intent),
          if (availability == 'failed')
            'failure': {
              'code': 'unsupported_spec',
              'failedAt': importNow.toIso8601String(),
            },
          if (availability == 'consumed') ...{
            'consumedBy':
                'connector-acceptance:${await connectorSha({'scope': intent.owner.scope, 'keySha256': consumedKey})}',
            'consumedKeySha256': consumedKey,
          },
          if (availability == 'abandoned')
            'abandonment': {
              ...abandonment,
              'abandonmentSha256': await connectorSha(abandonment),
            },
        };
  return ConnectorOpenApiImportPreparationRead.parse(
    await importEnvelope(
      {'prepared': prepared, if (kind != 'read') 'replayed': false},
      'openapiImportPreparations',
      kind,
      owner: owner,
      key: kind != 'read' ? intent.key : null,
      id: intent.id,
    ),
    owner ?? connectorOwner,
    intent: intent,
    kind: kind,
  );
}

Future<ConnectorOpenApiImportRead> importAction(
  ConnectorOpenApiImportIntent intent, {
  bool mutation = false,
  bool missing = false,
  bool settled = true,
  ConnectorOwner? owner,
}) async {
  final a = {
    'contract': 'asael-connector-acceptance:1',
    'id':
        'connector-acceptance:${await connectorSha({'scope': intent.owner.scope, 'keySha256': intent.keySha256})}',
    'scope': intent.owner.scope,
    'keySha256': intent.keySha256,
    'requestSha256': intent.requestSha256,
    'kind': 'openapi',
    'connectorId': intent.id,
    'action': 'import_openapi',
    'reviewSha256': intent.proof.sha256,
    'acceptedAt': importNow.toIso8601String(),
  };
  final s = {
    'contract': 'asael-connector-settlement:2',
    'acceptanceId': a['id'],
    'settledAt': importNow.toIso8601String(),
    'result': {
      'kind': 'openapi',
      'connectorId': intent.id,
      'operation': 'import_openapi',
      'status': 'complete',
      'connectorStatus': 'disabled',
      'contractCount': intent.proof.contractCount,
      'credentialVersion': 0,
      'connectorSha256': 'd' * 64,
      'contractsSha256': await connectorSha(<Object?>[]),
      'configurationSha256': intent.proof.raw['configurationSha256'],
      'trash': null,
      'failureCode': null,
    },
  };
  final action = missing
      ? null
      : {
          'acceptance': {...a, 'acceptanceSha256': await connectorSha(a)},
          'state': settled ? 'settled' : 'accepted',
          'settlement': settled
              ? {...s, 'settlementSha256': await connectorSha(s)}
              : null,
        };
  final kind = mutation ? 'submit' : 'read';
  return ConnectorOpenApiImportRead.parse(
    await importEnvelope(
      {'action': action, if (mutation) 'replayed': false},
      'openapiImports',
      kind,
      owner: owner,
      key: mutation ? intent.key : null,
      id: intent.id,
    ),
    owner ?? connectorOwner,
    intent: intent,
    kind: kind,
  );
}

class ImportFixtureRepository implements ConnectorOpenApiImportRepository {
  @override
  ConnectorOwner owner = connectorOwner;
  bool open = true,
      losePrepare = false,
      loseSubmit = false,
      loseAbandon = false;
  bool missingPreparation = false, missingAction = false;
  String availability = 'ready';
  String? consumedKey;
  int prepares = 0,
      submits = 0,
      abandons = 0,
      preparationReads = 0,
      actionReads = 0;
  Completer<ConnectorOpenApiImportPreparationRead>? preparationGate;
  DateTime? proofAt;
  Completer<void>? prepareGate;
  bool Function()? probe;
  void Function()? onPrepare, onSubmit;
  @override
  bool get current => open && (probe?.call() ?? true);
  @override
  Future<ConnectorOpenApiImportPreparationRead> prepare(
    ConnectorOpenApiImportPreparationIntent intent,
    ConnectorJson payload,
    bool Function() admission,
  ) async {
    connectorRequire(current && admission());
    intent.privateRequest(payload);
    prepares++;
    onPrepare?.call();
    await prepareGate?.future;
    if (losePrepare) {
      throw StateError('Lost preparation response');
    }
    return importPreparation(
      intent,
      kind: 'submit',
      owner: owner,
      availability: availability,
    );
  }

  @override
  Future<ConnectorOpenApiImportPreparationRead> readPreparation(
    ConnectorOpenApiImportPreparationIntent intent,
  ) {
    preparationReads++;
    return preparationGate?.future ??
        importPreparation(
          intent,
          proofAt: proofAt,
          owner: owner,
          availability: availability,
          missing: missingPreparation,
          consumedKey: consumedKey,
          tombstone: availability == 'abandoned' && losePrepare,
        );
  }

  @override
  Future<ConnectorOpenApiImportPreparationRead> abandon(
    ConnectorOpenApiImportPreparationIntent intent,
    bool Function() admission,
  ) async {
    connectorRequire(current && admission());
    abandons++;
    availability = 'abandoned';
    if (loseAbandon) {
      throw StateError('Lost abandonment response');
    }
    return importPreparation(
      intent,
      kind: 'abandon',
      availability: 'abandoned',
      tombstone: losePrepare,
      owner: owner,
    );
  }

  @override
  Future<ConnectorOpenApiImportRead> submit(
    ConnectorOpenApiImportIntent intent,
    bool Function() admission,
  ) async {
    connectorRequire(current && admission() && intent.key != null);
    submits++;
    onSubmit?.call();
    if (loseSubmit) {
      throw StateError('Lost action response');
    }
    return importAction(intent, mutation: true, owner: owner);
  }

  @override
  Future<ConnectorOpenApiImportRead> readAction(
    ConnectorOpenApiImportIntent intent,
  ) {
    actionReads++;
    return importAction(intent, missing: missingAction, owner: owner);
  }

  int readCancellations = 0;
  @override
  void cancelReads() {
    readCancellations++;
  }

  @override
  void close() {
    open = false;
  }
}

class ImportFixtureStore extends MemoryConnectorOpenApiImportRecoveryStore {
  bool failNext = false, commitThenFail = false;
  int writes = 0;
  void Function(int)? beforeWrite;
  @override
  Future<void> write(ConnectorJson value, bool Function() current) async {
    writes++;
    beforeWrite?.call(writes);
    if (failNext) {
      failNext = false;
      throw StateError('Unconfirmed save');
    }
    await super.write(value, current);
    if (commitThenFail) {
      commitThenFail = false;
      throw StateError('Lost save response');
    }
  }
}
