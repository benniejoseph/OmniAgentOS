import 'dart:async';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_trash_contracts.dart';
import 'package:asael/features/integrations/connector_trash_recovery_store.dart';
import 'package:asael/features/integrations/connector_trash_repository.dart';

import 'connector_credential_removal_fixtures.dart';
import 'connector_fixtures.dart';

final trashNow = DateTime.utc(2026, 10, 6, 12);
const trashId = 'trash:00000000-0000-4000-8000-000000000001';

Future<ConnectorJson> trashEnvelope(
  ConnectorJson body,
  String kind, {
  ConnectorTrashIntent? intent,
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
          'correlationId': intent!.key,
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
    'operation': 'app.connectors.native.trash.$kind',
    'action': kind == 'read' ? 'read' : 'manage.connector',
    'resourceType': 'connector_native_action',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? 'connector-native-trash-events.v1'
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
    'resourceCount': body[kind == 'preview' ? 'review' : 'action'] == null
        ? 0
        : 1,
    'occurredAt': trashNow.toIso8601String(),
  };
  return {
    ...wire,
    'serviceReceipt': {...proof, 'receiptSha256': await connectorSha(proof)},
  };
}

Future<ConnectorTrashPreview> trashPreviewFixture({
  String id = 'mcp:one',
  String name = 'Reviewed tools',
  int version = 3,
  bool configured = true,
  bool originMatch = true,
  bool vault = true,
  ConnectorOwner? owner,
  DateTime? issuedAt,
  bool missing = false,
}) async {
  var review = await removalReviewFixture(
    id: id,
    name: name,
    version: version,
    configured: configured,
    originMatch: originMatch,
    owner: owner,
  );
  if (!vault) {
    final summary = {
      ...review.connector!,
      'authType': 'none',
      'credentialConfigured': false,
    };
    final pin = {...review.pin!, 'connectorSha256': await connectorSha(summary)}
      ..remove('reviewSha256');
    review = await ConnectorReview.parse(
      await connectorEnvelope(
        {
          'review': {
            ...review.value!,
            'connector': summary,
            'pin': {...pin, 'reviewSha256': await connectorSha(pin)},
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
  final issued = issuedAt ?? trashNow;
  final preview = <String, dynamic>{
    'version': 'p9.3-trash-preview:1',
    'action': 'trash',
    'trashId': null,
    'resourceType': 'mcp_connector',
    'resourceId': id,
    'lifecycleRevision': 0,
    'targetSha256': await connectorSha({
      'kind': 'mcp',
      'connectorId': id,
      'reviewSha256': review.pin!['reviewSha256'],
    }),
    'effectSummary':
        'Move MCP connector $name and ${(review.value!['contracts'] as List).length} contract(s) to Trash.',
    'reversible': true,
    'issuedAt': issued.toIso8601String(),
    'expiresAt': issued.add(const Duration(minutes: 10)).toIso8601String(),
  };
  return ConnectorTrashPreview.parse(
    await trashEnvelope(
      {
        'review': missing ? null : review.value,
        'preview': missing
            ? null
            : {...preview, 'previewSha256': await connectorSha(preview)},
        'compensation': missing ? null : connectorTrashCompensation(review),
      },
      'preview',
      owner: owner,
    ),
    owner ?? connectorOwner,
    id,
  );
}

Future<ConnectorTrashRead> trashActionFixture(
  ConnectorTrashIntent intent, {
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
    'action': 'trash',
    'reviewSha256': intent.review['reviewSha256'],
    'acceptedAt': trashNow.toIso8601String(),
  };
  final settlement = <String, dynamic>{
    'contract': 'asael-connector-settlement:2',
    'acceptanceId': acceptance['id'],
    'settledAt': trashNow.toIso8601String(),
    'result': {
      'kind': 'mcp',
      'connectorId': intent.id,
      'operation': 'trash',
      'status': 'complete',
      'connectorStatus': null,
      'contractCount': null,
      'credentialVersion': null,
      'connectorSha256': null,
      'contractsSha256': null,
      'configurationSha256': null,
      'failureCode': null,
      'trash': {
        'trashId': trashId,
        'proofSha256': 'a' * 64,
        'restoreUntil': trashNow
            .add(const Duration(days: 30))
            .toIso8601String(),
        'compensation': 'equivalent_action',
        'limitation': connectorTrashReconnectLimitation,
      },
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
  return ConnectorTrashRead.parse(
    await trashEnvelope(
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

class TrashFixtureRepository implements ConnectorTrashRepository {
  @override
  ConnectorOwner owner = connectorOwner;
  bool open = true, loseResponse = false, missingReceipt = false;
  int posts = 0, gets = 0, previewReads = 0, reviewReads = 0;
  Completer<ConnectorReview>? reviewGate;
  Completer<ConnectorTrashPreview>? previewGate;
  void Function()? afterSubmit;
  bool Function()? accessProbe;
  ConnectorTrashIntent? submitted;
  @override
  bool get current => open && (accessProbe?.call() ?? true);
  @override
  Future<ConnectorReview> review(String id) {
    reviewReads++;
    return reviewGate?.future ?? removalReviewFixture(id: id, owner: owner);
  }

  @override
  Future<ConnectorTrashPreview> preview(String id) {
    previewReads++;
    return previewGate?.future ?? trashPreviewFixture(id: id, owner: owner);
  }

  @override
  Future<ConnectorTrashRead> submit(
    ConnectorTrashIntent intent,
    bool Function() admission,
  ) async {
    connectorRequire(current && admission());
    posts++;
    submitted = intent;
    afterSubmit?.call();
    if (loseResponse) throw StateError('Lost response');
    return trashActionFixture(intent, owner: owner);
  }

  @override
  Future<ConnectorTrashRead> recover(
    String keySha256, {
    required ConnectorTrashIntent intent,
  }) async {
    connectorRequire(keySha256 == intent.keySha256);
    gets++;
    return trashActionFixture(
      intent,
      owner: owner,
      mutation: false,
      missing: missingReceipt,
    );
  }

  @override
  void close() => open = false;
}

class TrashFixtureStore extends MemoryConnectorTrashRecoveryStore {
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
