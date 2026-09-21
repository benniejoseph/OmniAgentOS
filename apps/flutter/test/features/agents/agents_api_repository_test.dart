import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/agents/agents_api_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'creates and updates Agents through only the v19 native mutations',
    () async {
      final api = _RecordingApiClient();
      final repository = ApiAgentsRepository(api);
      final input = <String, dynamic>{
        'name': 'Moltbook Steward',
        'role': 'Community observer',
      };

      final created = await repository.saveAgent(input);
      final updated = await repository.saveAgent(input, id: 'custom agent/one');

      expect(created.id, 'created-agent');
      expect(updated.id, 'updated-agent');
      expect(api.posts.single.path, '/api/agents');
      expect(api.posts.single.data, input);
      expect(
        api.posts.single.headers?['idempotency-key'],
        startsWith('native-agent-create-'),
      );
      expect(api.patches.single.path, '/api/agents/custom%20agent%2Fone');
      expect(
        api.patches.single.headers?['idempotency-key'],
        startsWith('native-agent-update-'),
      );
      await expectLater(
        repository.deleteAgent('created-agent'),
        throwsA(isA<UnsupportedError>()),
      );
    },
  );

  test(
    'uses a fresh private projection for Moltbook health and activity',
    () async {
      final api = _RecordingApiClient();
      final repository = ApiAgentsRepository(api);

      final projection = await repository.loadMoltbook(
        'agent/one',
        cursor: 'page one',
        limit: 25,
      );

      expect(projection.connection?.health, 'healthy');
      expect(projection.activities.single.summary, 'Heartbeat completed.');
      expect(api.freshReads, [
        '/api/agents/agent%2Fone/moltbook?cursor=page+one&limit=25',
      ]);
      await expectLater(
        repository.loadMoltbook('agent', limit: 0),
        throwsA(isA<RangeError>()),
      );
      expect(api.freshReads, hasLength(1));
    },
  );

  test(
    'sends Moltbook actions to the exact Agent route with idempotency',
    () async {
      final api = _RecordingApiClient();
      final repository = ApiAgentsRepository(api);

      await repository.changeMoltbook('agent/one', const {'action': 'pause'});

      final call = api.posts.single;
      expect(call.path, '/api/agents/agent%2Fone/moltbook');
      expect(call.data, const {'action': 'pause'});
      expect(
        call.headers?['idempotency-key'],
        startsWith('native-agent-moltbook-'),
      );
    },
  );
}

class _RecordingApiClient extends ApiClient {
  _RecordingApiClient()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  final posts = <_ApiCall>[];
  final patches = <_ApiCall>[];
  final freshReads = <String>[];

  @override
  Future<Map<String, dynamic>> postJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    posts.add(_ApiCall(path, data, headers));
    if (path == '/api/agents') {
      return {
        'agent': {'id': 'created-agent', ...?data},
      };
    }
    return const {'connection': null};
  }

  @override
  Future<Map<String, dynamic>> patchJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    patches.add(_ApiCall(path, data, headers));
    return {
      'agent': {'id': 'updated-agent', ...?data},
    };
  }

  @override
  Future<Map<String, dynamic>> getJsonFresh(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    freshReads.add(path);
    return {
      'connection': {
        'status': 'claimed',
        'health': 'healthy',
        'externalName': 'AsaelResearcher',
        'claimState': 'claimed',
        'heartbeatEnabled': true,
        'consecutiveFailures': 0,
        'credentialConfigured': true,
      },
      'activities': [
        {
          'id': 'activity-one',
          'kind': 'heartbeat',
          'status': 'succeeded',
          'summary': 'Heartbeat completed.',
          'createdAt': '2026-09-21T08:00:00.000Z',
        },
      ],
    };
  }
}

class _ApiCall {
  const _ApiCall(this.path, this.data, this.headers);

  final String path;
  final Map<String, dynamic>? data, headers;
}
