import 'dart:async';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_recovery_store.dart';
import 'package:asael/features/integrations/connector_repository.dart';

final connectorOwner = ConnectorOwner(
  tenantId: 'tenant',
  actorId: 'admin@example.test',
  userId: '00000000-0000-4000-8000-000000000001',
  role: 'admin',
  apiBaseUrl: 'https://example.test',
);
const connectorAt = '2026-10-04T12:00:00.000Z';

Future<ConnectorJson> connectorEnvelope(
  ConnectorJson body,
  String suffix, {
  ConnectorIntent? intent,
  ConnectorOwner? owner,
}) async {
  final scope = owner ?? connectorOwner, mutation = intent != null;
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
          'correlationId': intent.key.length <= 256
              ? intent.key
              : 'idempotency-key:${await connectorSha(intent.key)}',
          'causationId': intent.id,
          'contextGrantIds': <String>[],
          'capabilityGrantIds': <String>[],
          'purpose': 'api.connectors.native.action',
        }
      : null;
  final wire = {
    'contract': connectorControlContract,
    'scope': scope.scope,
    ...body,
  };
  final proof = <String, dynamic>{
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': 'app.connectors.native.$suffix',
    'action': mutation ? 'manage.connector' : 'read',
    'resourceType': 'connector_native_action',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? 'connector-native-events.v1'
        : 'read_only:no_domain_mutation',
    'authoritySha256': await connectorSha({
      'boundaryVersion': 'p9.1-app-service-boundary:1',
      'tenantId': scope.tenantId,
      'actorId': scope.actorId,
      'role': scope.role,
      'executionScope': execution,
    }),
    'idempotencyKeySha256': intent?.keySha256,
    'outcomeSha256': await connectorSha(wire),
    'resourceCount': suffix == 'list'
        ? (body['connectors'] as List).length
        : (body[suffix == 'review' ? 'review' : 'action'] == null ? 0 : 1),
    'occurredAt': connectorAt,
  };
  return {
    ...wire,
    'serviceReceipt': {...proof, 'receiptSha256': await connectorSha(proof)},
  };
}

Future<ConnectorReview> connectorReviewFixture({
  String id = 'mcp:one',
  String endpoint = 'https://tools.example.test/mcp',
  ConnectorOwner? owner,
}) async {
  final summary = <String, dynamic>{
    'kind': 'mcp',
    'id': id,
    'name': 'Reviewed tools',
    'endpoint': endpoint,
    'endpointRedacted': true,
    'status': 'disabled',
    'authType': 'bearer_vault',
    'authTokenEnv': null,
    'authHeaderName': null,
    'credentialConfigured': true,
    'credentialVersion': 3,
    'credentialOriginMatch': true,
    'defaultRiskLevel': 2,
    'approvalRequired': true,
    'contractCount': 1,
    'discoveredAt': connectorAt,
    'updatedAt': connectorAt,
  };
  final contracts = [
    {
      'id': 'tool:read',
      'name': 'Read a selected item',
      'description': 'Reads the exact governed target.',
      'status': 'pending_review',
      'riskLevel': 2,
      'approvalRequired': true,
      'fingerprint': 'a' * 43,
      'definition': {
        'inputSchema': {
          'type': 'object',
          'properties': {
            'id': {'type': 'string'},
          },
        },
      },
    },
  ];
  final pin = {
    'kind': 'mcp',
    'connectorId': id,
    'connectorSha256': await connectorSha(summary),
    'contractsSha256': await connectorSha(contracts),
    'configurationSha256': 'b' * 64,
    'reviewFingerprint': 'c' * 43,
    'credentialVersion': 3,
  };
  final body = {
    'review': {
      'connector': summary,
      'contracts': contracts,
      'pin': {...pin, 'reviewSha256': await connectorSha(pin)},
      'availableActions': ['review_contracts', 'enable'],
      'unavailableReason': null,
    },
  };
  return ConnectorReview.parse(
    await connectorEnvelope(body, 'review', owner: owner),
    owner ?? connectorOwner,
    'mcp',
    id,
  );
}

Future<ConnectorActionRead> connectorActionFixture(
  ConnectorIntent intent, {
  bool mutation = true,
  bool settled = true,
  ConnectorOwner? owner,
}) async {
  final accepted = {
    'contract': 'asael-connector-acceptance:1',
    'id':
        'connector-acceptance:${await connectorSha({'scope': intent.owner.scope, 'keySha256': intent.keySha256})}',
    'scope': intent.owner.scope,
    'keySha256': intent.keySha256,
    'requestSha256': intent.requestSha256,
    'kind': intent.kind,
    'connectorId': intent.id,
    'action': intent.action,
    'reviewSha256': (intent.request['review'] as Map)['reviewSha256'],
    'acceptedAt': connectorAt,
  };
  final settlement = {
    'contract': 'asael-connector-settlement:1',
    'acceptanceId': accepted['id'],
    'settledAt': connectorAt,
    'result': {
      'kind': intent.kind,
      'connectorId': intent.id,
      'status': 'active',
      'contractCount': 1,
      'promotedCount': 1,
      'connectorSha256': 'd' * 64,
      'contractsSha256': 'e' * 64,
    },
  };
  final body = {
    'action': {
      'acceptance': {
        ...accepted,
        'acceptanceSha256': await connectorSha(accepted),
      },
      'state': settled ? 'settled' : 'accepted',
      'settlement': settled
          ? {...settlement, 'settlementSha256': await connectorSha(settlement)}
          : null,
    },
    if (mutation) 'replayed': false,
  };
  return ConnectorActionRead.parse(
    await connectorEnvelope(
      body,
      mutation ? 'act' : 'show',
      intent: mutation ? intent : null,
      owner: owner,
    ),
    owner ?? connectorOwner,
    intent.keySha256,
    intent: intent,
    mutation: mutation,
  );
}

class ConnectorFixtureRepository implements ConnectorRepository {
  @override
  ConnectorOwner owner = connectorOwner;
  bool open = true, loseResponse = false, missingReceipt = false;
  int posts = 0, gets = 0;
  ConnectorIntent? sent;
  Completer<ConnectorReview>? reviewGate;
  void Function()? afterSubmit;
  @override
  bool get current => open;
  @override
  Future<ConnectorInventory> list() async => ConnectorInventory([
    (await connectorReviewFixture(owner: owner)).connector!,
  ], false);
  @override
  Future<ConnectorReview> review(String kind, String id) =>
      reviewGate?.future ?? connectorReviewFixture(id: id, owner: owner);
  @override
  Future<ConnectorActionRead> submit(
    ConnectorIntent intent,
    bool Function() admission,
  ) async {
    connectorRequire(open && admission());
    posts++;
    sent = intent;
    afterSubmit?.call();
    if (loseResponse) {
      throw StateError('Lost response');
    }
    return connectorActionFixture(intent, owner: owner);
  }

  @override
  Future<ConnectorActionRead> recover(ConnectorIntent intent) async {
    gets++;
    if (missingReceipt) {
      return ConnectorActionRead.parse(
        await connectorEnvelope({'action': null}, 'show', owner: owner),
        owner,
        intent.keySha256,
        intent: intent,
      );
    }
    return connectorActionFixture(intent, mutation: false, owner: owner);
  }

  @override
  void close() {
    open = false;
  }
}

class ConnectorFixtureStore extends MemoryConnectorRecoveryStore {
  bool failNext = false;
  int writes = 0;
  @override
  Future<void> write(ConnectorJson next, bool Function() current) async {
    writes++;
    if (failNext) {
      failNext = false;
      throw StateError('Unconfirmed storage');
    }
    await super.write(next, current);
  }
}
