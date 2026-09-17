import 'package:asael/core/network/api_client.dart';
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
      expect(events.map((event) => event.event), ['status', 'run', 'done']);
      expect(events.last.data['threadId'], 'thread-recovered');
      expect(events.last.data['response'], 'Example Domain');
      expect(history.threadReads, 1);
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
}

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
