import 'dart:async';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_credential_removal_contracts.dart';
import 'package:asael/features/integrations/connector_credential_removal_recovery_store.dart';
import 'package:asael/features/integrations/connector_credential_removal_repository.dart';

import 'connector_fixtures.dart';

Future<ConnectorReview> removalReviewFixture({
  String id = 'mcp:one',
  String name = 'Reviewed tools',
  int version = 3,
  bool configured = true,
  bool originMatch = true,
  ConnectorOwner? owner,
}) async {
  final review = await connectorReviewFixture(id: id, owner: owner);
  final summary = {
    ...review.connector!,
    'name': name,
    'credentialVersion': version,
    'credentialConfigured': configured,
    'credentialOriginMatch': originMatch,
  };
  final pin = {
    ...review.pin!,
    'credentialVersion': version,
    'connectorSha256': await connectorSha(summary),
  }..remove('reviewSha256');
  return ConnectorReview.parse(
    await connectorEnvelope(
      {
        'review': {
          ...review.value!,
          'connector': summary,
          'pin': {...pin, 'reviewSha256': await connectorSha(pin)},
          'availableActions': <String>[],
        },
      },
      'review',
      owner: owner,
    ),
    owner ?? connectorOwner,
    'mcp',
    id,
  );
}

Future<ConnectorJson> removalEnvelope(
  ConnectorJson body,
  String kind, {
  ConnectorCredentialRemovalIntent? intent,
  ConnectorOwner? owner,
}) async {
  final scope = owner ?? connectorOwner, mutation = kind == 'submit';
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
          'correlationId': intent!.key.length <= 256
              ? intent.key
              : 'idempotency-key:${await connectorSha(intent.key)}',
          'causationId': intent.id,
          'contextGrantIds': <String>[],
          'capabilityGrantIds': <String>[],
          'purpose': 'api.connectors.native.action',
        }
      : null;
  final wire = <String, dynamic>{
    'contract': connectorControlContract,
    'scope': scope.scope,
    ...body,
  };
  final proof = <String, dynamic>{
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': 'app.connectors.native.credentialRemovals.$kind',
    'action': mutation ? 'manage.connector' : 'read',
    'resourceType': 'connector_native_action',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? 'connector-native-credential-removal-events.v1'
        : 'read_only:no_domain_mutation',
    'authoritySha256': await connectorSha({
      'boundaryVersion': 'p9.1-app-service-boundary:1',
      'tenantId': scope.tenantId,
      'actorId': scope.actorId,
      'role': scope.role,
      'executionScope': execution,
    }),
    'idempotencyKeySha256': mutation ? intent!.keySha256 : null,
    'outcomeSha256': await connectorSha(wire),
    'resourceCount': body['action'] == null ? 0 : 1,
    'occurredAt': connectorAt,
  };
  return {
    ...wire,
    'serviceReceipt': {...proof, 'receiptSha256': await connectorSha(proof)},
  };
}

Future<ConnectorCredentialRemovalRead> removalActionFixture(
  ConnectorCredentialRemovalIntent intent, {
  bool mutation = true,
  bool settled = true,
  bool missing = false,
  ConnectorOwner? owner,
}) async {
  final acceptance = <String, dynamic>{
    'contract': 'asael-connector-acceptance:1',
    'id':
        'connector-acceptance:${await connectorSha({'scope': intent.owner.scope, 'keySha256': intent.keySha256})}',
    'scope': intent.owner.scope,
    'keySha256': intent.keySha256,
    'requestSha256': intent.requestSha256,
    'kind': 'mcp',
    'connectorId': intent.id,
    'action': 'remove_credential',
    'reviewSha256': intent.review['reviewSha256'],
    'acceptedAt': connectorAt,
  };
  final settlement = <String, dynamic>{
    'contract': 'asael-connector-settlement:2',
    'acceptanceId': acceptance['id'],
    'settledAt': connectorAt,
    'result': {
      'kind': 'mcp',
      'connectorId': intent.id,
      'operation': 'remove_credential',
      'status': 'complete',
      'connectorStatus': 'disabled',
      'contractCount': 0,
      'credentialVersion': (intent.review['credentialVersion'] as int) + 1,
      'connectorSha256': 'd' * 64,
      'contractsSha256': await connectorSha(<Object?>[]),
      'configurationSha256': 'e' * 64,
      'trash': null,
      'failureCode': null,
    },
  };
  final action = missing
      ? null
      : {
          'acceptance': {
            ...acceptance,
            'acceptanceSha256': await connectorSha(acceptance),
          },
          'state': settled ? 'settled' : 'accepted',
          'settlement': settled
              ? {
                  ...settlement,
                  'settlementSha256': await connectorSha(settlement),
                }
              : null,
        };
  final kind = mutation ? 'submit' : 'read';
  return ConnectorCredentialRemovalRead.parse(
    await removalEnvelope(
      {'action': action, if (mutation) 'replayed': false},
      kind,
      intent: mutation ? intent : null,
      owner: owner,
    ),
    owner ?? connectorOwner,
    kind: kind,
    intent: intent,
  );
}

class RemovalFixtureRepository implements ConnectorCredentialRemovalRepository {
  @override
  ConnectorOwner owner = connectorOwner;
  bool open = true, loseResponse = false, missingReceipt = false;
  int posts = 0, gets = 0;
  Completer<ConnectorReview>? reviewGate;
  void Function()? afterSubmit;
  bool Function()? accessProbe;
  @override
  bool get current => open && (accessProbe?.call() ?? true);
  @override
  Future<ConnectorReview> review(String id) =>
      reviewGate?.future ?? removalReviewFixture(id: id, owner: owner);
  @override
  Future<ConnectorCredentialRemovalRead> submit(
    ConnectorCredentialRemovalIntent intent,
    bool Function() admission,
  ) async {
    connectorRequire(current && admission());
    posts++;
    afterSubmit?.call();
    if (loseResponse) throw StateError('Lost response');
    return removalActionFixture(intent, owner: owner);
  }

  @override
  Future<ConnectorCredentialRemovalRead> recover(
    String keySha256, {
    required ConnectorCredentialRemovalIntent intent,
  }) async {
    connectorRequire(keySha256 == intent.keySha256);
    gets++;
    return removalActionFixture(
      intent,
      owner: owner,
      mutation: false,
      missing: missingReceipt,
    );
  }

  @override
  void close() => open = false;
}

class RemovalFixtureStore
    extends MemoryConnectorCredentialRemovalRecoveryStore {
  bool failNext = false, commitThenFail = false;
  int writes = 0;
  void Function(int)? beforeWrite;
  @override
  Future<void> write(ConnectorJson next, bool Function() current) async {
    writes++;
    beforeWrite?.call(writes);
    if (failNext) {
      failNext = false;
      throw StateError('Unconfirmed save');
    }
    await super.write(next, current);
    if (commitThenFail) {
      commitThenFail = false;
      throw StateError('Lost save response');
    }
  }
}
