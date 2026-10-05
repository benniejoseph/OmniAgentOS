import 'dart:async';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_credential_rotation_contracts.dart';
import 'package:asael/features/integrations/connector_credential_rotation_recovery_store.dart';
import 'package:asael/features/integrations/connector_credential_rotation_repository.dart';

import 'connector_credential_removal_fixtures.dart';
import 'connector_fixtures.dart';

final rotationNow = DateTime.utc(2026, 10, 6, 12);
const rotationToken = 'synthetic-not-a-live-token';

Future<ConnectorJson> rotationEnvelope(
  ConnectorJson body,
  String family,
  String kind, {
  ConnectorOwner? owner,
  String? key,
  String id = 'mcp:one',
}) async {
  final scope = owner ?? connectorOwner, mutation = kind != 'read';
  final preparation = family == 'credentialPreparations';
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
              ? 'api.connectors.native.preparation.abandon'
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
              ? 'connector-native-credential-preparation-events.v1'
              : 'connector-native-credential-rotation-events.v1')
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
    'occurredAt': rotationNow.toIso8601String(),
  };
  return {
    ...wire,
    'serviceReceipt': {
      ...receipt,
      'receiptSha256': await connectorSha(receipt),
    },
  };
}

Future<ConnectorCredentialPreparationProof> rotationProof(
  ConnectorCredentialPreparationIntent intent, {
  DateTime? at,
}) async {
  final issued = at ?? rotationNow;
  final body = {
    ...intent.identity,
    'contract': 'asael-connector-preparation:1',
    'id':
        'connector-preparation:${await connectorSha({'scope': intent.owner.scope, 'keySha256': intent.keySha256})}',
    'intentSha256': intent.intentSha256,
    'configurationSha256': intent.review['configurationSha256'],
    'preparedAt': issued.toIso8601String(),
    'expiresAt': issued.add(const Duration(minutes: 15)).toIso8601String(),
  };
  return ConnectorCredentialPreparationProof.parse({
    ...body,
    'preparationSha256': await connectorSha(body),
  }, intent);
}

Future<ConnectorCredentialPreparationRead> rotationPreparation(
  ConnectorCredentialPreparationIntent intent, {
  String kind = 'read',
  String availability = 'ready',
  bool missing = false,
  bool tombstone = false,
  String? consumedKey,
  ConnectorOwner? owner,
}) async {
  final proof = tombstone ? null : await rotationProof(intent);
  final abandonment = {
    'contract': 'asael-connector-credential-preparation-abandonment:1',
    'id':
        'connector-preparation-abandonment:${await connectorSha({'scope': intent.owner.scope, 'keySha256': intent.keySha256})}',
    'scope': intent.owner.scope,
    'keySha256': intent.keySha256,
    'intentSha256': intent.intentSha256,
    'preparationSha256': proof?.sha256,
    'abandonedAt': rotationNow.toIso8601String(),
  };
  final consumed = availability == 'consumed';
  final prepared = missing
      ? null
      : {
          'preparation': proof?.raw,
          'availability': availability,
          'consumedBy': consumed
              ? 'connector-acceptance:${await connectorSha({'scope': intent.owner.scope, 'keySha256': consumedKey})}'
              : null,
          'consumedKeySha256': consumed ? consumedKey : null,
          if (availability == 'abandoned') 'intent': intent.identity,
          if (availability == 'abandoned')
            'abandonment': {
              ...abandonment,
              'abandonmentSha256': await connectorSha(abandonment),
            },
        };
  return ConnectorCredentialPreparationRead.parse(
    await rotationEnvelope(
      {'prepared': prepared, if (kind != 'read') 'replayed': false},
      'credentialPreparations',
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

Future<ConnectorCredentialRotationRead> rotationAction(
  ConnectorCredentialRotationIntent intent, {
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
    'kind': 'mcp',
    'connectorId': intent.id,
    'action': 'rotate_mcp',
    'reviewSha256': intent.proof.sha256,
    'acceptedAt': rotationNow.toIso8601String(),
  };
  final s = {
    'contract': 'asael-connector-settlement:2',
    'acceptanceId': a['id'],
    'settledAt': rotationNow.toIso8601String(),
    'result': {
      'kind': 'mcp',
      'connectorId': intent.id,
      'operation': 'rotate_mcp',
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
          'acceptance': {...a, 'acceptanceSha256': await connectorSha(a)},
          'state': settled ? 'settled' : 'accepted',
          'settlement': settled
              ? {...s, 'settlementSha256': await connectorSha(s)}
              : null,
        };
  final kind = mutation ? 'submit' : 'read';
  return ConnectorCredentialRotationRead.parse(
    await rotationEnvelope(
      {'action': action, if (mutation) 'replayed': false},
      'credentialRotations',
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

class RotationFixtureRepository
    implements ConnectorCredentialRotationRepository {
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
      actionReads = 0,
      reviewReads = 0;
  Completer<ConnectorReview>? reviewGate;
  Completer<void>? prepareGate;
  bool Function()? probe;
  void Function()? onPrepare, onSubmit;
  @override
  bool get current => open && (probe?.call() ?? true);
  @override
  Future<ConnectorReview> review(String id) {
    reviewReads++;
    return reviewGate?.future ?? removalReviewFixture(id: id, owner: owner);
  }

  @override
  Future<ConnectorCredentialPreparationRead> prepare(
    ConnectorCredentialPreparationIntent intent,
    String token,
    bool Function() admission,
  ) async {
    connectorRequire(
      current && admission() && credentialRotationTokenValid(token),
    );
    prepares++;
    onPrepare?.call();
    await prepareGate?.future;
    if (losePrepare) {
      throw StateError('Lost preparation response');
    }
    return rotationPreparation(intent, kind: 'submit', owner: owner);
  }

  @override
  Future<ConnectorCredentialPreparationRead> readPreparation(
    ConnectorCredentialPreparationIntent intent,
  ) {
    preparationReads++;
    return rotationPreparation(
      intent,
      owner: owner,
      availability: availability,
      missing: missingPreparation,
      consumedKey: consumedKey,
      tombstone: availability == 'abandoned' && losePrepare,
    );
  }

  @override
  Future<ConnectorCredentialPreparationRead> abandon(
    ConnectorCredentialPreparationIntent intent,
    bool Function() admission,
  ) async {
    connectorRequire(current && admission());
    abandons++;
    availability = 'abandoned';
    if (loseAbandon) {
      throw StateError('Lost abandonment response');
    }
    return rotationPreparation(
      intent,
      kind: 'abandon',
      availability: 'abandoned',
      tombstone: losePrepare,
      owner: owner,
    );
  }

  @override
  Future<ConnectorCredentialRotationRead> submit(
    ConnectorCredentialRotationIntent intent,
    bool Function() admission,
  ) async {
    connectorRequire(current && admission() && intent.key != null);
    submits++;
    onSubmit?.call();
    if (loseSubmit) {
      throw StateError('Lost action response');
    }
    return rotationAction(intent, mutation: true, owner: owner);
  }

  @override
  Future<ConnectorCredentialRotationRead> readAction(
    ConnectorCredentialRotationIntent intent,
  ) {
    actionReads++;
    return rotationAction(intent, missing: missingAction, owner: owner);
  }

  @override
  void close() {
    open = false;
  }
}

class RotationFixtureStore
    extends MemoryConnectorCredentialRotationRecoveryStore {
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
