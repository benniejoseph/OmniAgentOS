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

  test('rejects a Council route response without the map projection', () async {
    final api = _CouncilApiClient()..omitMap = true;
    final repository = ApiAgentCouncilRepository(api);

    await expectLater(repository.load(), throwsFormatException);
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

  test(
    'reads exact immutable delegated authority without broadening controls',
    () async {
      final api = _CouncilApiClient();
      final repository = ApiAgentCouncilRepository(api);

      final detail = await repository.loadTaskDetail('execution/one');

      expect(detail.executionId, 'execution/one');
      expect(detail.grantsImmutable, isTrue);
      expect(detail.allowedActions, ['cancel']);
      expect(detail.authority.validation.status, 'current');
      expect(
        detail.authority.nativeReadTools.single.toolId,
        'knowledge.search',
      );
      expect(
        detail.authority.skills.single.skillVersionId,
        'skill:research:v3',
      );
      expect(
        detail.authority.skills.single.capabilityGrantId,
        'grant-skill-one',
      );
      expect(detail.authority.plugins.single.installationRevision, 4);
      expect(
        detail.authority.plugins.single.capabilityGrantId,
        'grant-plugin-one',
      );
      expect(detail.authority.plugins.single.installationSha256, _digest('d'));
      expect(detail.authority.plugins.single.componentIds, ['skill.research']);
      expect(detail.authority.mcpServers.single.serverId, 'market-research');
      expect(
        detail.authority.mcpServers.single.capabilityGrantId,
        'grant-mcp-one',
      );
      expect(detail.authority.mcpServers.single.governedToolIds, [
        'market.news.search',
      ]);
      expect(detail.authority.mcpServers.single.connectorTargetIds, [
        'twelve-data',
      ]);
      expect(api.freshReads.last, '/api/agents/tasks/execution%2Fone');

      expect(
        () => AgentTaskDetail.fromJson({
          ..._taskDetailResponse(),
          'task': {
            ...(_taskDetailResponse()['task']! as Map),
            'controls': {
              'grantsImmutable': true,
              'allowedActions': ['cancel', 'edit_grant'],
            },
          },
        }),
        throwsFormatException,
      );
      expect(
        () => AgentTaskDetail.fromJson({
          ..._taskDetailResponse(),
          'task': {
            ...(_taskDetailResponse()['task']! as Map),
            'executionScope': {'private': true},
          },
        }),
        throwsFormatException,
      );
      final invalidValidation = _taskDetailResponse();
      final invalidTask = Map<String, dynamic>.from(
        invalidValidation['task']! as Map,
      );
      final invalidAuthority = Map<String, dynamic>.from(
        invalidTask['authority']! as Map,
      );
      invalidAuthority['validation'] = {
        'status': 'current',
        'category': null,
        'validatedAt': '2026-09-22T10:00:00.000Z',
      };
      invalidTask['authority'] = invalidAuthority;
      invalidValidation['task'] = invalidTask;
      expect(
        () => AgentTaskDetail.fromJson(invalidValidation),
        throwsFormatException,
      );
    },
  );
}

class _CouncilApiClient extends ApiClient {
  _CouncilApiClient()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  final freshReads = <String>[];
  bool omitMap = false;
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
    if (path.startsWith('/api/agents/tasks/')) {
      return _taskDetailResponse(executionId: 'execution/one');
    }
    if (omitMap) {
      return const {
        'serviceReceipt': {'operation': 'app.agents.council.show'},
      };
    }
    return {
      'map': agentCouncilFixtureJson(),
      'serviceReceipt': const {'operation': 'app.agents.council.show'},
    };
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

Map<String, dynamic> _taskDetailResponse({
  String executionId = 'execution/one',
}) => {
  'task': {
    'executionId': executionId,
    'authority': {
      'immutable': true,
      'contractSha256': _digest('a'),
      'grantRequestSha256': _digest('b'),
      'validation': {
        'status': 'current',
        'category': 'all_grants',
        'validatedAt': '2026-09-22T10:00:00.000Z',
      },
      'nativeReadTools': [
        {'toolId': 'knowledge.search'},
      ],
      'skills': [
        {
          'capabilityGrantId': 'grant-skill-one',
          'skillId': 'research',
          'skillVersion': 3,
          'skillVersionId': 'skill:research:v3',
          'skillSha256': _digest('c'),
        },
      ],
      'plugins': [
        {
          'capabilityGrantId': 'grant-plugin-one',
          'installationId': 'installation-one',
          'installationRevision': 4,
          'installationSha256': _digest('d'),
          'pluginId': 'project-kit',
          'pluginVersion': '1.0.0',
          'manifestSha256': _digest('e'),
          'componentIds': ['skill.research'],
        },
      ],
      'mcpServers': [
        {
          'capabilityGrantId': 'grant-mcp-one',
          'serverId': 'market-research',
          'serverVersionId': 'mcp:market-research:v2',
          'serverContractSha256': _digest('f'),
          'governedToolIds': ['market.news.search'],
          'connectorTargetIds': ['twelve-data'],
        },
      ],
    },
    'controls': {
      'grantsImmutable': true,
      'allowedActions': ['cancel'],
    },
  },
};

String _digest(String character) => List.filled(64, character).join();
