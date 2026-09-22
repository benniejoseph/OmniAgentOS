import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/talk/talk.dart';
import 'package:asael/features/talk/talk_api_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    FlutterSecureStorage.setMockInitialValues({});
  });

  tearDown(() => debugDefaultTargetPlatformOverride = null);

  test(
    'recovers an unambiguous completed run after the live stream disconnects',
    () async {
      final api = _DisconnectingStreamApiClient();
      final history = _RecoveryHistoryRepository();
      final repository = ApiTalkRepository(
        api,
        history: history,
        recoveryPollInterval: Duration.zero,
        recoveryPollLimit: 3,
      );

      final events = await repository
          .send(
            message: 'Open example.com read only',
            mode: 'orchestrate',
            executionTarget: TalkExecutionTarget.thisMac,
          )
          .toList();

      expect(api.sendCount, 1);
      expect(api.lastData?['computerUseTarget'], 'local_macos');
      expect(api.lastData?.containsKey('agentId'), isFalse);
      expect(events.map((event) => event.event), ['status', 'run', 'done']);
      expect(events.last.data['threadId'], 'thread-recovered');
      expect(events.last.data['response'], 'Example Domain');
      expect(history.threadReads, 1);
    },
  );

  test(
    'fails closed instead of adopting concurrent history for an assigned Agent',
    () async {
      final api = _DisconnectingStreamApiClient();
      final history = _RecoveryHistoryRepository();
      final repository = ApiTalkRepository(
        api,
        history: history,
        recoveryPollInterval: Duration.zero,
        recoveryPollLimit: 3,
      );

      await expectLater(
        repository
            .send(
              message: 'Open example.com read only',
              agentId: 'agent-moltbook',
            )
            .toList(),
        throwsA(isA<ApiException>()),
      );

      expect(api.sendCount, 1);
      expect(api.lastData?['agentId'], 'agent-moltbook');
      expect(history.listReads, 1, reason: 'only the preflight anchor is read');
      expect(history.threadReads, 0);
    },
  );

  test(
    'anchors a disconnected accepted request to its exact streamed run',
    () async {
      final api = _AcceptedRunDisconnectingApiClient();
      final history = _RecoveryHistoryRepository();
      final repository = ApiTalkRepository(api, history: history);

      final events = await repository
          .send(message: 'Open the chart', mode: 'orchestrate')
          .toList();

      expect(api.sendCount, 1);
      expect(events.map((event) => event.event), ['run', 'status']);
      expect(events.first.data['runId'], 'run-accepted-exact');
      expect(events.last.data, containsPair('runId', 'run-accepted-exact'));
      expect(events.last.data['label'], 'Reconnecting to this run');
      expect(history.threadReads, 0);
    },
  );

  test('rejects an invalid assigned Agent before network I/O', () async {
    final api = _DisconnectingStreamApiClient();
    final repository = ApiTalkRepository(api);

    await expectLater(
      repository
          .send(message: 'Read the feed', agentId: '../another-owner')
          .toList(),
      throwsArgumentError,
    );
    expect(api.sendCount, 0);
  });

  test('parses bounded exact-run recovery state', () async {
    final api = _RunProjectionApiClient({
      'run': {
        'id': 'run-waiting',
        'threadId': 'thread-waiting',
        'status': 'waiting_approval',
        'response': 'Review this exact action.\nNothing was sent twice.',
        'error': List.filled(3000, 'x').join(),
        'waitingApproval': {
          'executionId': 'execution-waiting',
          'toolId': 'local.macos.click',
          'toolName': 'Click chart',
        },
      },
    });
    final repository = ApiTalkRepository(api);

    final inspection = await repository.inspectRun('run-waiting');

    expect(api.readPaths, ['/api/runs/run-waiting']);
    expect(inspection.threadId, 'thread-waiting');
    expect(
      inspection.response,
      'Review this exact action.\nNothing was sent twice.',
    );
    expect(inspection.error, hasLength(2000));
    expect(inspection.error, endsWith('\u2026'));
    expect(inspection.waitingApproval?.executionId, 'execution-waiting');
    expect(inspection.waitingApproval?.toolId, 'local.macos.click');
    expect(inspection.waitingApproval?.toolName, 'Click chart');
    expect(inspection.terminal, isFalse);
  });

  test('fails closed before fetching a retired computer frame', () async {
    final api = _ArtifactApiClient();
    final repository = ApiTalkRepository(api);

    await expectLater(
      repository.loadArtifact(
        const TalkMediaArtifactSummary(
          assetId: 'computer_frame_legacy',
          kind: 'computer',
          operation: 'observe',
          filename: 'computer-use.png',
          mediaType: 'image/png',
          byteCount: 1024,
          status: 'stored',
          sourceRunId: 'run_legacy',
        ),
      ),
      throwsA(isA<LegacyComputerPreviewRetired>()),
    );
    expect(api.byteReads, isEmpty);
  });

  test(
    'accepts only bounded ready presentation artifacts from run evidence',
    () {
      final inspection = TalkRunInspection.fromJson({
        'run': {'id': 'run-presentation', 'status': 'completed'},
        'fileArtifacts': [
          {
            'artifactId': 'artifact_pitch_deck',
            'version': 3,
            'kind': 'presentation',
            'title': 'Service Cloud AI transformation',
            'filename': 'service-cloud-ai.pptx',
            'mediaType': TalkMediaArtifactSummary.powerPointMediaType,
            'byteCount': 2048,
            'status': 'ready',
            'slideCount': 12,
            'theme': 'aurora',
            'contentUrl': 'https://untrusted.example/private.pptx',
          },
          {
            'artifactId': '../cross-actor',
            'version': 1,
            'kind': 'presentation',
            'title': 'Unsafe',
            'filename': 'unsafe.pptx',
            'mediaType': TalkMediaArtifactSummary.powerPointMediaType,
            'byteCount': 20,
            'status': 'ready',
          },
          {
            'artifactId': 'artifact_not_ready',
            'version': 1.5,
            'kind': 'presentation',
            'title': 'Invalid version',
            'filename': 'invalid.pptx',
            'mediaType': TalkMediaArtifactSummary.powerPointMediaType,
            'byteCount': 20,
            'status': 'ready',
          },
        ],
      });

      expect(inspection.fileArtifacts, hasLength(1));
      final artifact = inspection.fileArtifacts.single;
      expect(artifact.assetId, 'artifact_pitch_deck');
      expect(artifact.artifactVersion, 3);
      expect(artifact.title, 'Service Cloud AI transformation');
      expect(artifact.slideCount, 12);
      expect(artifact.theme, 'aurora');
      expect(artifact.isPresentation, isTrue);
      expect(artifact.contextLabel, 'PowerPoint presentation · Private');
    },
  );

  test(
    'downloads an exact presentation version through the native route',
    () async {
      final api = _ArtifactApiClient();
      final repository = ApiTalkRepository(api);
      const artifact = TalkMediaArtifactSummary(
        assetId: 'artifact_pitch_deck',
        kind: 'presentation',
        operation: 'create',
        filename: 'pitch.pptx',
        mediaType: TalkMediaArtifactSummary.powerPointMediaType,
        byteCount: 1,
        status: 'ready',
        artifactVersion: 4,
        title: 'Pitch deck',
        slideCount: 9,
      );

      final content = await repository.loadArtifact(artifact);

      expect(content.assetId, 'artifact_pitch_deck');
      expect(content.bytes, [1]);
      expect(api.byteReads, [
        '/api/artifacts/artifact_pitch_deck/content?version=4',
      ]);
    },
  );

  test('reconciles offline prompt creation and edits exactly once', () async {
    final api = _PromptQueueApiClient()..online = false;
    final repository = ApiTalkRepository(api);
    const local = TalkQueuedPrompt(
      id: 'local-correlation-offline-one',
      clientCorrelationId: 'correlation-offline-one',
      input: 'Draft while offline',
      mode: 'orchestrate',
      strategy: 'direct',
      executionTarget: TalkExecutionTarget.agent,
      assignedAgent: TalkAssignedAgent(id: 'atlas', name: 'Asael'),
      syncState: TalkPromptQueueSyncState.pending,
    );

    final created = await repository.createPromptQueueItem(local);
    final edited = await repository.updatePromptQueueItem(
      created,
      input: 'Edited while offline',
    );
    expect(edited.syncState, TalkPromptQueueSyncState.pending);
    expect(api.outboxOperations, hasLength(2));

    api.online = true;
    final reconciled = await repository.reconcilePromptQueue();

    expect(api.createCalls, 1);
    expect(api.updateCalls, 1);
    expect(api.outboxOperations, isEmpty);
    expect(reconciled, hasLength(1));
    expect(reconciled.single.input, 'Edited while offline');
    expect(reconciled.single.lifecycleRevision, 1);
    expect(reconciled.single.syncState, TalkPromptQueueSyncState.synced);
  });

  test(
    'keeps stale offline prompt work visible as an explicit conflict',
    () async {
      final api = _PromptQueueApiClient()
        ..online = false
        ..conflictNextCreate = true;
      final repository = ApiTalkRepository(api);
      const local = TalkQueuedPrompt(
        id: 'local-correlation-conflict',
        clientCorrelationId: 'correlation-conflict',
        input: 'Do not lose this prompt',
        mode: 'research',
        strategy: 'direct',
        executionTarget: TalkExecutionTarget.agent,
        assignedAgent: TalkAssignedAgent(id: 'atlas', name: 'Asael'),
        syncState: TalkPromptQueueSyncState.pending,
      );

      await repository.createPromptQueueItem(local);
      api.online = true;
      final reconciled = await repository.reconcilePromptQueue();

      expect(api.outboxOperations, hasLength(1));
      expect(reconciled.single.input, 'Do not lose this prompt');
      expect(reconciled.single.syncState, TalkPromptQueueSyncState.conflict);
    },
  );

  test('replays a complete offline reorder deterministically', () async {
    final api = _PromptQueueApiClient()
      ..serverItems.addAll([
        _promptQueueProjection(
          id: '00000000-0000-4000-8000-000000000001',
          correlation: 'correlation-first',
          prompt: 'First',
        ),
        _promptQueueProjection(
          id: '00000000-0000-4000-8000-000000000002',
          correlation: 'correlation-second',
          prompt: 'Second',
        ),
      ])
      ..online = false;
    final repository = ApiTalkRepository(api);
    final current = await repository.listPromptQueue();

    await repository.reorderPromptQueue([current[1], current[0]]);
    expect(api.outboxOperations, hasLength(1));

    api.online = true;
    final reconciled = await repository.reconcilePromptQueue();

    expect(api.reorderCalls, 1);
    expect(api.outboxOperations, isEmpty);
    expect(reconciled.map((item) => item.input), ['Second', 'First']);
    expect(reconciled.map((item) => item.lifecycleRevision), [1, 1]);
  });
}

class _PromptQueueApiClient extends ApiClient {
  _PromptQueueApiClient()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  bool online = true;
  bool conflictNextCreate = false;
  int createCalls = 0;
  int updateCalls = 0;
  int reorderCalls = 0;
  final serverItems = <Map<String, dynamic>>[];
  final projections = <String, Map<String, dynamic>>{};

  List<dynamic> get outboxOperations =>
      projections['asael://prompt-queue-outbox-v1']?['operations'] as List? ??
      const [];

  @override
  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    if (online) return _serverProjection;
    return projections[path] ?? _serverProjection;
  }

  @override
  Future<Map<String, dynamic>> getJsonFresh(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    if (!online) throw const ApiException('offline');
    return _serverProjection;
  }

  @override
  Future<Map<String, dynamic>?> readOfflineProjection(
    String path, {
    Map<String, dynamic>? query,
  }) async => projections[path];

  @override
  Future<void> seedOfflineProjection(
    String path,
    Map<String, dynamic> payload, {
    Map<String, dynamic>? query,
  }) async {
    projections[path] = Map<String, dynamic>.from(payload);
  }

  @override
  Future<Map<String, dynamic>> postJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    if (!online) throw const ApiException('offline');
    if (path == '/api/command/prompt-queue') {
      if (conflictNextCreate) {
        conflictNextCreate = false;
        throw const ApiConflictException('correlation changed');
      }
      createCalls += 1;
      final correlation = data?['clientCorrelationId']?.toString() ?? '';
      final existingIndex = serverItems.indexWhere(
        (item) => item['clientCorrelationId'] == correlation,
      );
      if (existingIndex >= 0) {
        return {'item': serverItems[existingIndex], 'created': false};
      }
      final created = _promptQueueProjection(
        id: '00000000-0000-4000-8000-${(serverItems.length + 100).toString().padLeft(12, '0')}',
        correlation: correlation,
        prompt: data?['prompt']?.toString() ?? '',
        mode: data?['mode']?.toString() ?? 'orchestrate',
        strategy: data?['strategy']?.toString() ?? 'direct',
        executionTarget:
            (data?['target'] as Map?)?['executionTarget']?.toString() ??
            'asael',
      );
      serverItems.add(created);
      return {'item': created, 'created': true};
    }
    if (path == '/api/command/prompt-queue/reorder') {
      reorderCalls += 1;
      final requested = data?['items'] as List? ?? const [];
      final reordered = <Map<String, dynamic>>[];
      for (final value in requested) {
        final request = Map<String, dynamic>.from(value as Map);
        final index = serverItems.indexWhere(
          (item) => item['id'] == request['id'],
        );
        if (index < 0 ||
            serverItems[index]['lifecycleRevision'] !=
                request['expectedRevision']) {
          throw const ApiConflictException('stale reorder');
        }
        reordered.add({
          ...serverItems[index],
          'lifecycleRevision':
              (serverItems[index]['lifecycleRevision'] as int) + 1,
        });
      }
      serverItems
        ..clear()
        ..addAll(reordered);
      return {'items': serverItems};
    }
    throw StateError('Unexpected POST $path');
  }

  @override
  Future<Map<String, dynamic>> patchJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    if (!online) throw const ApiException('offline');
    updateCalls += 1;
    final id = Uri.decodeComponent(path.split('/').last);
    final index = serverItems.indexWhere((item) => item['id'] == id);
    if (index < 0 ||
        serverItems[index]['lifecycleRevision'] != data?['expectedRevision']) {
      throw const ApiConflictException('stale update');
    }
    final current = serverItems[index];
    serverItems[index] = {
      ...current,
      if (data?['prompt'] != null) 'prompt': data?['prompt'],
      if (data?['state'] != null) 'state': data?['state'],
      'lifecycleRevision': (current['lifecycleRevision'] as int) + 1,
    };
    return {'item': serverItems[index]};
  }

  @override
  Future<Map<String, dynamic>> deleteJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? query,
    Map<String, dynamic>? headers,
  }) async {
    if (!online) throw const ApiException('offline');
    final id = Uri.decodeComponent(path.split('/').last);
    serverItems.removeWhere((item) => item['id'] == id);
    return {'deleted': true, 'id': id};
  }

  Map<String, dynamic> get _serverProjection => {
    'schemaVersion': 1,
    'items': serverItems,
    'serverTime': '2026-09-22T10:00:00.000Z',
  };
}

Map<String, dynamic> _promptQueueProjection({
  required String id,
  required String correlation,
  required String prompt,
  String mode = 'orchestrate',
  String strategy = 'direct',
  String executionTarget = 'asael',
}) => {
  'schemaVersion': 1,
  'id': id,
  'clientCorrelationId': correlation,
  'originSessionId': 'session-queue',
  'lastModifiedSessionId': 'session-queue',
  'prompt': prompt,
  'promptSha256': _queueDigest('a'),
  'mode': mode,
  'strategy': strategy,
  'target': {
    'threadId': null,
    'missionId': null,
    'projectId': null,
    'executionTarget': executionTarget,
  },
  'targetSha256': _queueDigest('b'),
  'agent': {
    'logicalAgentId': 'atlas',
    'definitionId': 'definition:atlas',
    'definitionVersion': 1,
    'definitionVersionId': 'definition:atlas:v1',
    'definitionSha256': _queueDigest('c'),
    'principalId': 'principal:atlas',
    'principalGeneration': 1,
    'principalVersionId': 'principal:atlas:v1',
    'principalSha256': _queueDigest('d'),
  },
  'model': {
    'providerId': 'openai',
    'modelId': 'gpt-test',
    'tier': 'reasoning',
    'assignmentId': null,
    'assignmentRevision': null,
    'assignmentConfigurationSha256': null,
    'routingPolicySha256': _queueDigest('e'),
  },
  'state': 'queued',
  'position': 1024,
  'lifecycleRevision': 0,
  'runId': null,
  'resultThreadId': null,
  'progressLabel': null,
  'failureCode': null,
  'createdAt': '2026-09-22T10:00:00.000Z',
  'updatedAt': '2026-09-22T10:00:00.000Z',
  'dispatchedAt': null,
  'terminalAt': null,
  'queueGrantsAuthority': false,
};

String _queueDigest(String character) => List.filled(64, character).join();

class _ArtifactApiClient extends ApiClient {
  _ArtifactApiClient()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  final byteReads = <String>[];

  @override
  Future<Uint8List> getBytes(
    String path, {
    Map<String, dynamic>? query,
    int maximumBytes = 64 * 1024 * 1024,
  }) async {
    byteReads.add(path);
    return Uint8List.fromList([1]);
  }
}

class _DisconnectingStreamApiClient extends ApiClient {
  _DisconnectingStreamApiClient()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  int sendCount = 0;
  Map<String, dynamic>? lastData;

  @override
  Future<ResponseBody> postStream(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
    Duration? receiveTimeout,
  }) async {
    sendCount += 1;
    lastData = data;
    final error = DioException(
      requestOptions: RequestOptions(path: path),
      type: DioExceptionType.connectionError,
    );
    return ResponseBody(Stream<Uint8List>.error(error), 200);
  }
}

class _AcceptedRunDisconnectingApiClient extends ApiClient {
  _AcceptedRunDisconnectingApiClient()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  int sendCount = 0;

  @override
  Future<ResponseBody> postStream(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
    Duration? receiveTimeout,
  }) async {
    sendCount += 1;
    return ResponseBody.fromString(
      'event: run\ndata: {"type":"run","runId":"run-accepted-exact","threadId":"thread-accepted"}\n\n',
      200,
      headers: {
        Headers.contentTypeHeader: ['text/event-stream'],
      },
    );
  }
}

class _RunProjectionApiClient extends ApiClient {
  _RunProjectionApiClient(this.projection)
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  final Map<String, dynamic> projection;
  final readPaths = <String>[];

  @override
  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    readPaths.add(path);
    return projection;
  }
}

class _RecoveryHistoryRepository implements TalkHistoryRepository {
  int listReads = 0;
  int threadReads = 0;

  @override
  Future<List<TalkThreadSummary>> listThreads({int limit = 30}) async {
    listReads += 1;
    const baseline = TalkThreadSummary(
      id: 'thread-existing',
      title: 'Earlier work',
      mode: 'orchestrate',
    );
    if (listReads == 1) return const [baseline];
    return const [
      TalkThreadSummary(
        id: 'thread-recovered',
        title: 'Open example.com read only',
        mode: 'orchestrate',
      ),
      baseline,
    ];
  }

  @override
  Future<TalkThreadDetail> getThread(String threadId) async {
    threadReads += 1;
    return TalkThreadDetail(
      thread: const TalkThreadSummary(
        id: 'thread-recovered',
        title: 'Open example.com read only',
        mode: 'orchestrate',
      ),
      turns: const [
        TalkThreadTurn(
          role: TalkThreadRole.user,
          text: 'Open example.com read only',
        ),
        TalkThreadTurn(
          role: TalkThreadRole.assistant,
          text: 'Example Domain',
          runId: 'run-recovered',
        ),
      ],
    );
  }

  @override
  Future<List<TalkThreadMemorySummary>> listThreadMemories(
    String threadId, {
    int limit = 24,
  }) async => const [];
}
