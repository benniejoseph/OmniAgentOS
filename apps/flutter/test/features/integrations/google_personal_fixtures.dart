import 'dart:async';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/google_personal_contracts.dart';
import 'package:asael/features/integrations/google_personal_recovery_store.dart';
import 'package:asael/features/integrations/google_personal_repository.dart';

final googleOwner = ConnectorOwner(
  tenantId: 'tenant',
  actorId: 'owner@example.test',
  userId: '00000000-0000-4000-8000-000000000001',
  role: 'operator',
  apiBaseUrl: 'https://example.test',
);
const googleAt = '2026-10-05T12:00:00.000Z';

Future<ConnectorJson> googleEnvelope(
  ConnectorJson body,
  String kind, {
  GooglePersonalIntent? intent,
  ConnectorOwner? owner,
}) async {
  final scope = owner ?? googleOwner, mutation = kind == 'submit';
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
          'causationId': intent.connectionId,
          'contextGrantIds': <String>[],
          'capabilityGrantIds': <String>[],
          'purpose': 'api.google.personal.action',
        }
      : null;
  final wire = <String, dynamic>{
    'contract': googlePersonalReadContract,
    'scope': scope.scope,
    ...body,
  };
  final proof = <String, dynamic>{
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': 'app.google.personal.actions.$kind',
    'action': mutation ? 'write.memory' : 'read',
    'resourceType': 'oauth_grant',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? 'google-personal-native-events.v1'
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
    'resourceCount': kind == 'review'
        ? ((body['current'] as Map)['connection'] == null ? 0 : 1)
        : (body['action'] == null ? 0 : 1),
    'occurredAt': googleAt,
  };
  return {
    ...wire,
    'serviceReceipt': {...proof, 'receiptSha256': await connectorSha(proof)},
  };
}

Future<GooglePersonalRead> googleReviewFixture({
  ConnectorOwner? owner,
  String email = 'personal@example.test',
  int generation = 2,
  List<String> sources = const ['mail', 'calendar', 'drive'],
  ConnectorJson? blocked,
}) async {
  final review = <String, dynamic>{
    'connectionId': 'google:personal',
    'accountEmail': email,
    'authorizationGeneration': generation,
    'status': 'active',
    'sourceScopeSha256': 'a' * 64,
    'permittedSources': sources,
  };
  return GooglePersonalRead.parse(
    await googleEnvelope(
      {
        'current': {
          'connection': {...review, 'reviewSha256': await connectorSha(review)},
          'availableActions': blocked == null
              ? [if (sources.isNotEmpty) 'sync', 'disconnect']
              : <String>[],
          'blockedAction': blocked,
          'busy': false,
        },
        'action': null,
      },
      'review',
      owner: owner,
    ),
    owner ?? googleOwner,
  );
}

Future<GooglePersonalRead> googleActionFixture(
  GooglePersonalIntent intent, {
  bool mutation = true,
  bool settled = true,
  bool missing = false,
  ConnectorOwner? owner,
}) async {
  final accepted = <String, dynamic>{
    'contract': 'asael-google-personal-acceptance:1',
    'id':
        'google-personal-action:${await connectorSha({'scope': intent.owner.scope, 'idempotencyKeySha256': intent.keySha256})}',
    'scope': intent.owner.scope,
    'action': intent.action,
    'idempotencyKeySha256': intent.keySha256,
    'requestSha256': intent.requestSha256,
    'review': intent.review,
    'acceptedAt': googleAt,
    'localRevoked': intent.action == 'disconnect',
  };
  final sources = (intent.review['permittedSources'] as List)
      .map(
        (source) => {
          'source': source,
          'status': 'healthy',
          'backfillState': 'complete',
          'imported': 1,
          'removed': 0,
          'lastAttemptedAt': googleAt,
          'lastSuccessfulAt': googleAt,
        },
      )
      .toList();
  final settlement = intent.action == 'disconnect'
      ? {
          'action': 'disconnect',
          'status': 'local_revoked',
          'providerRevocation': 'unconfirmed',
          'settledAt': googleAt,
        }
      : {
          'action': 'sync',
          'status': 'healthy',
          'imported': sources.length,
          'removed': 0,
          'cursorAdvanced': true,
          'sources': sources,
          'settledAt': googleAt,
        };
  final action = missing
      ? null
      : {
          'acceptance': {
            ...accepted,
            'acceptanceSha256': await connectorSha(accepted),
          },
          'state': settled ? 'settled' : 'accepted',
          'settlement': settled ? settlement : null,
        };
  final kind = mutation ? 'submit' : 'read';
  return GooglePersonalRead.parse(
    await googleEnvelope(
      {
        'current': {
          'connection': intent.review,
          'availableActions': <String>[],
          'blockedAction': settled ? null : action,
          'busy': false,
        },
        'action': action,
        if (mutation) 'replayed': false,
      },
      kind,
      intent: mutation ? intent : null,
      owner: owner,
    ),
    owner ?? googleOwner,
    kind: kind,
    keySha256: intent.keySha256,
    intent: intent,
  );
}

class GoogleFixtureRepository implements GooglePersonalRepository {
  @override
  ConnectorOwner owner = googleOwner;
  bool open = true, loseResponse = false, missingReceipt = false;
  int posts = 0, gets = 0;
  Completer<GooglePersonalRead>? reviewGate;
  GooglePersonalIntent? otherDeviceIntent;
  void Function()? afterSubmit;
  bool Function()? accessProbe;
  @override
  bool get current => open && (accessProbe?.call() ?? true);
  @override
  Future<GooglePersonalRead> review() =>
      reviewGate?.future ?? googleReviewFixture(owner: owner);
  @override
  Future<GooglePersonalRead> submit(
    GooglePersonalIntent intent,
    bool Function() admission,
  ) async {
    connectorRequire(current && admission());
    posts++;
    afterSubmit?.call();
    if (loseResponse) throw StateError('Lost response');
    return googleActionFixture(intent, owner: owner);
  }

  @override
  Future<GooglePersonalRead> recover(
    String keySha256, {
    GooglePersonalIntent? intent,
  }) async {
    gets++;
    final exact = intent ?? otherDeviceIntent!;
    connectorRequire(exact.keySha256 == keySha256);
    return googleActionFixture(
      exact,
      owner: owner,
      mutation: false,
      missing: missingReceipt,
    );
  }

  @override
  void close() => open = false;
}

class GoogleFixtureStore extends MemoryGooglePersonalRecoveryStore {
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
