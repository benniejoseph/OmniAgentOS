import '../../core/network/api_client.dart';
import 'talk.dart';

class ApiTalkRepository implements TalkRepository {
  const ApiTalkRepository(this.api);
  final ApiClient api;
  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
  }) async* {
    final body = await api.postStream(
      '/api/agent',
      data: {
        'message': message,
        'threadId': ?threadId,
        'mode': mode,
        'strategy': strategy,
        'requestId': 'flutter-${DateTime.now().microsecondsSinceEpoch}',
      },
      headers: const {'Accept': 'text/event-stream'},
    );
    yield* parseSse(body.stream);
  }
}
