import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/talk/talk.dart';
import 'package:asael/features/talk/talk_api_repository.dart';
import 'package:asael/features/talk/talk_history.dart';
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
          .send(message: 'Open example.com read only', mode: 'orchestrate')
          .toList();

      expect(api.sendCount, 1);
      expect(events.map((event) => event.event), ['status', 'run', 'done']);
      expect(events.last.data['threadId'], 'thread-recovered');
      expect(events.last.data['response'], 'Example Domain');
      expect(history.threadReads, 1);
    },
  );
}

class _DisconnectingStreamApiClient extends ApiClient {
  _DisconnectingStreamApiClient()
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
    final error = DioException(
      requestOptions: RequestOptions(path: path),
      type: DioExceptionType.connectionError,
    );
    return ResponseBody(Stream<Uint8List>.error(error), 200);
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
