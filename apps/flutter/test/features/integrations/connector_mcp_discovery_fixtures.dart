import 'dart:async';

import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_mcp_discovery_contracts.dart';
import 'package:asael/features/integrations/connector_mcp_discovery_recovery_store.dart';
import 'package:asael/features/integrations/connector_mcp_discovery_repository.dart';

import 'connector_fixtures.dart';

final discoveryStarted = DateTime.utc(2026, 10, 6, 12);

Future<ConnectorJson> discoveryEnvelope(
  ConnectorJson? discovery,
  ConnectorMcpDiscoveryIntent intent, {
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
              ? 'api.connectors.native.mcp_discovery_close'
              : 'api.connectors.native.mcp_discovery',
        }
      : null;
  final wire = {
    'contract': connectorControlContract,
    'scope': scope.scope,
    'discovery': discovery,
    if (mutation) 'replayed': false,
  };
  final receipt = {
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': 'app.connectors.native.mcpDiscoveries.$kind',
    'action': kind == 'submit' ? 'manage.connector' : 'read',
    'resourceType': 'connector_native_discovery',
    'accessMode': mutation ? 'mutation' : 'read',
    'eventContract': mutation
        ? 'connector-native-mcp-discovery-events.v1'
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
    'resourceCount': discovery == null ? 0 : 1,
    'occurredAt': discoveryStarted.toIso8601String(),
  };
  return {
    ...wire,
    'serviceReceipt': {
      ...receipt,
      'receiptSha256': await connectorSha(receipt),
    },
  };
}

Future<ConnectorMcpDiscoveryRead> discoveryFixture(
  ConnectorMcpDiscoveryIntent intent, {
  String state = 'settled',
  String kind = 'read',
  String? failure,
  int count = 1,
  bool absent = false,
  bool missing = false,
  ConnectorOwner? owner,
}) async {
  final at = discoveryStarted, expires = at.add(const Duration(seconds: 45));
  final attemptBody = {
    'contract': 'asael-mcp-discovery-attempt:1',
    'id':
        'mcp-discovery-attempt:${await connectorSha({'family': 'mcp-discovery-attempt:1', 'scope': intent.owner.scope, 'keySha256': intent.keySha256})}',
    'scope': intent.owner.scope,
    'keySha256': intent.keySha256,
    'intentSha256': intent.requestSha256,
    'kind': 'mcp',
    'connectorId': intent.id,
    'reviewSha256': intent.review['reviewSha256'],
    'startedAt': at.toIso8601String(),
    'expiresAt': expires.toIso8601String(),
  };
  final attempt = {
    ...attemptBody,
    'attemptSha256': await connectorSha(attemptBody),
  };
  final pinBody = {...intent.review}..remove('reviewSha256');
  pinBody['contractsSha256'] = count == 0
      ? await connectorSha(<Object?>[])
      : 'd' * 64;
  final settlementBody = {
    'contract': 'asael-mcp-discovery-settlement:1',
    'attemptId': attempt['id'],
    'attemptSha256': attempt['attemptSha256'],
    'settledAt':
        (failure == 'deadline_exceeded'
                ? expires
                : at.add(const Duration(seconds: 1)))
            .toIso8601String(),
    'result': failure == null
        ? {
            'status': 'complete',
            'kind': 'mcp',
            'connectorId': intent.id,
            'connectorStatus': 'disabled',
            'contractCount': count,
            'pendingCount': count,
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
    'contract': 'asael-mcp-discovery-closure:1',
    'scope': intent.owner.scope,
    'keySha256': intent.keySha256,
    'intentSha256': intent.requestSha256,
    'attemptId': absent ? null : attempt['id'],
    'attemptSha256': absent ? null : attempt['attemptSha256'],
    'closedAt': at.add(const Duration(seconds: 2)).toIso8601String(),
  };
  final discovery = missing
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
  return ConnectorMcpDiscoveryRead.parse(
    await discoveryEnvelope(discovery, intent, kind: kind, owner: owner),
    owner ?? connectorOwner,
    intent: intent,
    kind: kind,
  );
}

class DiscoveryFixtureRepository implements ConnectorMcpDiscoveryRepository {
  @override
  ConnectorOwner owner = connectorOwner;
  bool open = true,
      loseSubmit = false,
      loseClose = false,
      missing = false,
      settledOnClose = false,
      missingTarget = false;
  String state = 'settled';
  int submits = 0, reads = 0, closes = 0, reviews = 0, cancelled = 0;
  void Function()? onSubmit, onReview;
  Completer<ConnectorReview>? reviewGate;
  Completer<ConnectorMcpDiscoveryRead>? readGate;
  @override
  bool get current => open;
  @override
  Future<ConnectorReview> review(String id) {
    reviews++;
    onReview?.call();
    if (missingTarget) {
      return connectorEnvelope(
        {'review': null},
        'review',
        owner: owner,
      ).then((value) => ConnectorReview.parse(value, owner, 'mcp', id));
    }
    return reviewGate?.future ?? connectorReviewFixture(id: id, owner: owner);
  }

  @override
  Future<ConnectorMcpDiscoveryRead> submit(
    ConnectorMcpDiscoveryIntent intent,
    bool Function() admission,
  ) {
    connectorRequire(open && admission());
    submits++;
    onSubmit?.call();
    if (loseSubmit) {
      throw StateError('Lost submit response');
    }
    return discoveryFixture(intent, state: state, kind: 'submit', owner: owner);
  }

  @override
  Future<ConnectorMcpDiscoveryRead> recover(
    ConnectorMcpDiscoveryIntent intent,
  ) {
    reads++;
    return readGate?.future ??
        discoveryFixture(intent, state: state, missing: missing, owner: owner);
  }

  @override
  Future<ConnectorMcpDiscoveryRead> closeAttempt(
    ConnectorMcpDiscoveryIntent intent,
    bool Function() admission,
  ) {
    connectorRequire(open && admission());
    closes++;
    if (loseClose) {
      throw StateError('Lost close response');
    }
    return discoveryFixture(
      intent,
      state: settledOnClose ? 'settled' : 'closed',
      kind: 'close',
      owner: owner,
    );
  }

  @override
  void cancelReads() {
    cancelled++;
  }

  @override
  void close() {
    open = false;
    cancelled++;
  }
}

class DiscoveryFixtureStore extends MemoryConnectorMcpDiscoveryRecoveryStore {
  bool failNext = false, commitThenFail = false;
  int writes = 0;
  void Function(int)? beforeWrite;
  @override
  Future<void> write(ConnectorJson next, bool Function() current) async {
    writes++;
    beforeWrite?.call(writes);
    if (failNext) {
      failNext = false;
      throw StateError('Protected save unconfirmed');
    }
    await super.write(next, current);
    if (commitThenFail) {
      commitThenFail = false;
      throw StateError('Protected acknowledgement lost');
    }
  }
}
