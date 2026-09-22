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
}

class _CouncilApiClient extends ApiClient {
  _CouncilApiClient()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  final freshReads = <String>[];

  @override
  Future<Map<String, dynamic>> getJsonFresh(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    freshReads.add(path);
    return agentCouncilFixtureJson();
  }
}

class _CouncilRepository implements AgentCouncilRepository {
  bool fail = false;

  @override
  Future<AgentCouncilProjection> load({int limit = 60}) async {
    if (fail) throw StateError('The connection is offline.');
    return AgentCouncilProjection.fromJson(agentCouncilFixtureJson());
  }
}
