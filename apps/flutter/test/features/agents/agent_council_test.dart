import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/agents/agent_council.dart';
import 'package:asael/features/agents/agent_council_api_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'agent_council_fixture.dart';

void main() {
  test(
    'parses canonical delegated work without inventing missing evidence',
    () {
      final projection = AgentCouncilProjection.fromJson(
        agentCouncilFixtureJson(),
      );

      expect(projection.authority, 'canonical_delegation_ledger');
      expect(projection.summary.activeMemberCount, 1);
      expect(projection.executions.single.status, 'running');
      expect(projection.executions.single.members, hasLength(2));
      expect(projection.executions.single.members.first.confidence, .82);
      expect(projection.executions.single.members.last.confidence, isNull);
      expect(projection.executions.single.members.last.verifier.score, isNull);
      expect(
        projection.executions.single.members.first.runtime?.modelId,
        'gpt-6-astra',
      );
      expect(
        projection.executions.single.members.first.verifier.runtime?.modelTier,
        'reasoning',
      );
    },
  );

  test('rejects a projection from a different contract version', () {
    final value = agentCouncilFixtureJson()..['version'] = 'invented:9';
    expect(() => AgentCouncilProjection.fromJson(value), throwsFormatException);
  });

  test('reads the fresh private Council route with a bounded limit', () async {
    final api = _CouncilApiClient();
    final repository = ApiAgentCouncilRepository(api);

    final projection = await repository.load(limit: 25);

    expect(projection.executions.single.parentExecutionId, 'run-council-one');
    expect(api.freshReads, ['/api/agents/council?limit=25']);
    await expectLater(repository.load(limit: 101), throwsA(isA<RangeError>()));
  });

  test(
    'retains the last verified projection after a refresh failure',
    () async {
      final repository = _CouncilRepository();
      final controller = AgentCouncilController(repository);
      addTearDown(controller.dispose);

      await controller.refresh();
      repository.fail = true;
      await controller.refresh();

      expect(controller.projection?.state, 'ready');
      expect(controller.error, isA<StateError>());
      expect(controller.loading, isFalse);
    },
  );

  test(
    'cancels an exact task with stable idempotency and no private fields',
    () async {
      final api = _CouncilApiClient();
      final repository = ApiAgentCouncilRepository(api);

      final result = await repository.cancel(
        executionId: 'execution/one',
        expectedRevision: 3,
        reason: 'No longer needed.',
        idempotencyKey: 'native-agent-task-cancel-v1-abc123',
      );

      expect(result.executionId, 'execution/one');
      expect(result.lifecycleRevision, 4);
      expect(api.posts.single.path, '/api/agents/tasks/execution%2Fone/cancel');
      expect(api.posts.single.data, {
        'expectedRevision': 3,
        'reason': 'No longer needed.',
      });
      expect(api.posts.single.headers, {
        'idempotency-key': 'native-agent-task-cancel-v1-abc123',
      });
      expect(
        () => AgentCouncilCancellation.fromJson({
          ..._cancellationResponse(),
          'task': {
            ...(_cancellationResponse()['task']! as Map),
            'contract': {'private': true},
          },
        }),
        throwsFormatException,
      );
    },
  );

  test(
    'controller applies cancellation and reuses a deterministic request key',
    () async {
      final repository = _CouncilRepository();
      final controller = AgentCouncilController(
        repository,
        controlAvailable: true,
      );
      addTearDown(controller.dispose);
      await controller.refresh();
      final member = controller.projection!.executions.single.members.first;

      await controller.cancelTask(member, reason: 'No longer needed.');

      expect(repository.cancellations, hasLength(1));
      expect(
        repository.cancellations.single.idempotencyKey,
        startsWith('native-agent-task-cancel-v1-'),
      );
      expect(
        controller.projection!.executions.single.members.first.state,
        'canceled',
      );
      expect(controller.projection!.summary.activeMemberCount, 0);
      expect(
        stableAgentTaskCancellationKey(
          executionId: member.taskId,
          expectedRevision: member.lifecycleRevision,
          reason: 'No longer needed.',
        ),
        repository.cancellations.single.idempotencyKey,
      );
    },
  );
}

class _CouncilApiClient extends ApiClient {
  _CouncilApiClient()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  final freshReads = <String>[];
  final posts =
      <
        ({
          String path,
          Map<String, dynamic>? data,
          Map<String, dynamic>? headers,
        })
      >[];

  @override
  Future<Map<String, dynamic>> getJsonFresh(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    freshReads.add(path);
    return agentCouncilFixtureJson();
  }

  @override
  Future<Map<String, dynamic>> postJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    posts.add((path: path, data: data, headers: headers));
    return _cancellationResponse(executionId: 'execution/one');
  }
}

class _CouncilRepository
    implements AgentCouncilRepository, AgentCouncilControlRepository {
  bool fail = false;
  final cancellations =
      <
        ({
          String executionId,
          int expectedRevision,
          String reason,
          String idempotencyKey,
        })
      >[];

  @override
  Future<AgentCouncilProjection> load({int limit = 60}) async {
    if (fail) throw StateError('The connection is offline.');
    return AgentCouncilProjection.fromJson(agentCouncilFixtureJson());
  }

  @override
  Future<AgentCouncilCancellation> cancel({
    required String executionId,
    required int expectedRevision,
    required String reason,
    required String idempotencyKey,
  }) async {
    cancellations.add((
      executionId: executionId,
      expectedRevision: expectedRevision,
      reason: reason,
      idempotencyKey: idempotencyKey,
    ));
    return AgentCouncilCancellation.fromJson(
      _cancellationResponse(
        executionId: executionId,
        lifecycleRevision: expectedRevision + 1,
      ),
    );
  }
}

Map<String, dynamic> _cancellationResponse({
  String executionId = 'task-scout-one',
  int lifecycleRevision = 4,
}) => {
  'task': {
    'executionId': executionId,
    'state': 'canceled',
    'lifecycleRevision': lifecycleRevision,
    'canCancel': false,
    'updatedAt': '2026-09-22T08:31:00.000Z',
    'terminalAt': '2026-09-22T08:31:00.000Z',
  },
  'canceledChildRun': true,
  'canceledDeliveryCount': 1,
  'idempotent': false,
};
