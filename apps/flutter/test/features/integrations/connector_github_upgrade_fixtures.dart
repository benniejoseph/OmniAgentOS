import 'dart:async';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_github_upgrade_contracts.dart';
import 'package:asael/features/integrations/connector_github_upgrade_recovery_store.dart';
import 'package:asael/features/integrations/connector_github_upgrade_repository.dart';

import 'connector_fixtures.dart';

final githubUpgradeStarted = DateTime.utc(2026, 10, 6, 12);

Future<ConnectorJson> githubUpgradeReviewEnvelope(
  ConnectorJson? upgradeReview, {
  ConnectorOwner? owner,
}) async {
  final scope = owner ?? connectorOwner;
  final wire = {
    'contract': connectorControlContract,
    'scope': scope.scope,
    'upgradeReview': upgradeReview,
  };
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': 'app.connectors.native.githubUpgrades.review',
    'action': 'manage.connector',
    'resourceType': 'connector_native_upgrade',
    'accessMode': 'read',
    'eventContract': 'read_only:no_domain_mutation',
    'authoritySha256': await connectorSha({
      'boundaryVersion': 'p9.1-app-service-boundary:1',
      'tenantId': scope.tenantId,
      'actorId': scope.actorId,
      'role': scope.role,
      'executionScope': null,
    }),
    'idempotencyKeySha256': null,
    'outcomeSha256': await connectorSha(wire),
    'resourceCount': upgradeReview == null ? 0 : 1,
    'occurredAt': githubUpgradeStarted.toIso8601String(),
  };
  return {
    ...wire,
    'serviceReceipt': {
      ...receipt,
      'receiptSha256': await connectorSha(receipt),
    },
  };
}

Future<ConnectorGithubUpgradeReview> githubUpgradeReviewFixture(
  String id, {
  ConnectorOwner? owner,
  bool eligible = true,
  bool missing = false,
  bool pinChanged = false,
}) async {
  final scope = owner ?? connectorOwner;
  final review = await connectorReviewFixture(
    id: id,
    endpoint: 'https://api.githubcopilot.com/mcp',
    endpointRedacted: false,
    owner: scope,
  );
  final pin = connectorMap(review.pin);
  if (pinChanged) {
    pin['configurationSha256'] = 'f' * 64;
    pin['reviewSha256'] = await connectorSha({...pin}..remove('reviewSha256'));
  }
  final proof = missing
      ? null
      : {
          'connectorId': id,
          'eligible': eligible,
          'reason': eligible ? 'eligible' : 'unavailable',
          'review': pin,
        };
  return ConnectorGithubUpgradeReview.parse(
    await githubUpgradeReviewEnvelope(proof, owner: scope),
    scope,
    id,
  );
}

Future<ConnectorJson> githubUpgradeEnvelope(
  ConnectorJson? upgrade,
  ConnectorGithubUpgradeIntent intent, {
  String kind = 'read',
  ConnectorOwner? owner,
}) async {
  final scope = owner ?? connectorOwner, mutation = kind != 'read';
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
          'purpose': kind == 'close'
              ? 'api.connectors.native.github_upgrade_close'
              : 'api.connectors.native.github_upgrade',
        }
      : null;
  final wire = {
    'contract': connectorControlContract,
    'scope': scope.scope,
    'upgrade': upgrade,
    if (mutation) 'replayed': false,
  };
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': 'app.connectors.native.githubUpgrades.$kind',
    'action': kind == 'submit' ? 'manage.connector' : 'read',
    'resourceType': 'connector_native_upgrade',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? 'connector-native-github-upgrade-events.v1'
        : 'read_only:no_domain_mutation',
    'authoritySha256': await connectorSha({
      'boundaryVersion': 'p9.1-app-service-boundary:1',
      'tenantId': scope.tenantId,
      'actorId': scope.actorId,
      'role': scope.role,
      'executionScope': execution,
    }),
    'idempotencyKeySha256': mutation ? intent.keySha256 : null,
    'outcomeSha256': await connectorSha(wire),
    'resourceCount': upgrade == null ? 0 : 1,
    'occurredAt': githubUpgradeStarted.toIso8601String(),
  };
  return {
    ...wire,
    'serviceReceipt': {
      ...receipt,
      'receiptSha256': await connectorSha(receipt),
    },
  };
}

Future<ConnectorGithubUpgradeRead> githubUpgradeFixture(
  ConnectorGithubUpgradeIntent intent, {
  String state = 'settled',
  String kind = 'read',
  String? failure,
  bool absent = false,
  bool missing = false,
  ConnectorOwner? owner,
}) async {
  final started = githubUpgradeStarted,
      expires = started.add(const Duration(seconds: 45));
  final attemptBody = {
    'contract': 'asael-github-upgrade-attempt:1',
    'id':
        'github-upgrade-attempt:${await connectorSha({'family': 'github-upgrade-attempt:1', 'scope': intent.owner.scope, 'keySha256': intent.keySha256})}',
    'scope': intent.owner.scope,
    'keySha256': intent.keySha256,
    'intentSha256': intent.requestSha256,
    'connectorId': intent.id,
    'reviewSha256': intent.review['reviewSha256'],
    'targetEndpoint': githubExpandedMcpEndpoint,
    'startedAt': started.toIso8601String(),
    'expiresAt': expires.toIso8601String(),
  };
  final attempt = {
    ...attemptBody,
    'attemptSha256': await connectorSha(attemptBody),
  };
  final pinBody = {...intent.review}..remove('reviewSha256');
  pinBody['connectorSha256'] = 'c' * 64;
  pinBody['contractsSha256'] = 'd' * 64;
  final settlementBody = {
    'contract': 'asael-github-upgrade-settlement:1',
    'attemptId': attempt['id'],
    'attemptSha256': attempt['attemptSha256'],
    'settledAt':
        (failure == 'deadline_exceeded'
                ? expires
                : started.add(const Duration(seconds: 1)))
            .toIso8601String(),
    'result': failure == null
        ? {
            'status': 'complete',
            'kind': 'mcp',
            'connectorId': intent.id,
            'connectorStatus': 'disabled',
            'endpoint': githubExpandedMcpEndpoint,
            'defaultRiskLevel': 2,
            'approvalRequired': false,
            'contractCount': 2,
            'pendingCount': 2,
            'credentialVersion': intent.review['credentialVersion'],
            'review': {...pinBody, 'reviewSha256': await connectorSha(pinBody)},
          }
        : {
            'status': 'failed',
            'kind': 'mcp',
            'connectorId': intent.id,
            'failureCode': failure,
          },
  };
  final closureBody = {
    'contract': 'asael-github-upgrade-closure:1',
    'scope': intent.owner.scope,
    'keySha256': intent.keySha256,
    'intentSha256': intent.requestSha256,
    'attemptId': absent ? null : attempt['id'],
    'attemptSha256': absent ? null : attempt['attemptSha256'],
    'closedAt': started.add(const Duration(seconds: 2)).toIso8601String(),
  };
  final upgrade = missing
      ? null
      : {
          'state': state,
          'intent': intent.identity,
          'attempt': state == 'closed' && absent ? null : attempt,
          if (state == 'settled')
            'settlement': {
              ...settlementBody,
              'settlementSha256': await connectorSha(settlementBody),
            },
          if (state == 'closed')
            'closure': {
              ...closureBody,
              'closureSha256': await connectorSha(closureBody),
            },
        };
  return ConnectorGithubUpgradeRead.parse(
    await githubUpgradeEnvelope(upgrade, intent, kind: kind, owner: owner),
    owner ?? connectorOwner,
    intent: intent,
    kind: kind,
  );
}

class GithubUpgradeFixtureRepository
    implements ConnectorGithubUpgradeRepository {
  @override
  ConnectorOwner owner = connectorOwner;
  bool open = true,
      loseSubmit = false,
      loseClose = false,
      missing = false,
      missingTarget = false,
      settledOnClose = false,
      eligible = true,
      pinChanged = false;
  String state = 'settled';
  int submits = 0,
      reads = 0,
      closes = 0,
      reviews = 0,
      proofReads = 0,
      cancelled = 0;
  void Function()? onSubmit;
  Completer<ConnectorReview>? reviewGate;

  @override
  bool get current => open;

  @override
  Future<ConnectorReview> review(String id) {
    reviews++;
    if (missingTarget) {
      return connectorEnvelope(
        {'review': null},
        'review',
        owner: owner,
      ).then((value) => ConnectorReview.parse(value, owner, 'mcp', id));
    }
    return reviewGate?.future ??
        connectorReviewFixture(
          id: id,
          endpoint: 'https://api.githubcopilot.com/mcp',
          endpointRedacted: false,
          owner: owner,
        );
  }

  @override
  Future<ConnectorGithubUpgradeReview> eligibility(String id) {
    proofReads++;
    return githubUpgradeReviewFixture(
      id,
      owner: owner,
      eligible: eligible,
      missing: missingTarget,
      pinChanged: pinChanged,
    );
  }

  @override
  Future<ConnectorGithubUpgradeRead> submit(
    ConnectorGithubUpgradeIntent intent,
    bool Function() admission,
  ) {
    connectorRequire(open && admission());
    submits++;
    onSubmit?.call();
    if (loseSubmit) throw StateError('Lost submit response');
    return githubUpgradeFixture(
      intent,
      state: state,
      kind: 'submit',
      owner: owner,
    );
  }

  @override
  Future<ConnectorGithubUpgradeRead> recover(
    ConnectorGithubUpgradeIntent intent,
  ) {
    reads++;
    return githubUpgradeFixture(
      intent,
      state: state,
      missing: missing,
      owner: owner,
    );
  }

  @override
  Future<ConnectorGithubUpgradeRead> closeAttempt(
    ConnectorGithubUpgradeIntent intent,
    bool Function() admission,
  ) {
    connectorRequire(open && admission());
    closes++;
    if (loseClose) throw StateError('Lost close response');
    return githubUpgradeFixture(
      intent,
      state: settledOnClose ? 'settled' : 'closed',
      kind: 'close',
      absent: missing,
      missing: false,
      owner: owner,
    );
  }

  @override
  void cancelReads() => cancelled++;

  @override
  void close() => open = false;
}

class GithubUpgradeFixtureStore
    extends MemoryConnectorGithubUpgradeRecoveryStore {
  int writes = 0;
  bool failNext = false, commitThenFail = false;
  void Function(int)? beforeWrite;

  @override
  Future<void> write(ConnectorJson next, bool Function() current) async {
    writes++;
    beforeWrite?.call(writes);
    if (failNext) {
      failNext = false;
      throw StateError('Protected save failed');
    }
    await super.write(next, current);
    if (commitThenFail) {
      commitThenFail = false;
      throw StateError('Protected save acknowledgement lost');
    }
  }
}
