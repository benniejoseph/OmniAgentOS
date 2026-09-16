import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'talk_history.dart';

class ApiTalkHistoryRepository implements TalkHistoryRepository {
  const ApiTalkHistoryRepository(this.api);

  final ApiClient api;

  @override
  Future<List<TalkThreadSummary>> listThreads({int limit = 30}) async {
    final boundedLimit = limit.clamp(1, 100);
    final json = await api.getJson(
      NativePaths.threadsList(limit: boundedLimit),
    );
    final rawThreads = json['threads'];
    if (rawThreads is! List) {
      throw const FormatException('Conversation history is unavailable.');
    }
    final threads = <TalkThreadSummary>[];
    final seen = <String>{};
    for (final raw in rawThreads.take(boundedLimit)) {
      if (raw is! Map) continue;
      try {
        final thread = TalkThreadSummary.fromJson(
          Map<String, dynamic>.from(raw),
        );
        if (seen.add(thread.id)) threads.add(thread);
      } on FormatException {
        // One malformed untrusted projection cannot hide valid conversations.
      }
    }
    return List.unmodifiable(threads);
  }

  @override
  Future<TalkThreadDetail> getThread(String threadId) async {
    final detail = TalkThreadDetail.fromJson(
      await api.getJson(NativePaths.threadsGet(threadId)),
    );
    if (detail.thread.id != threadId) {
      throw StateError(
        'The conversation projection did not match the request.',
      );
    }
    return detail;
  }

  @override
  Future<List<TalkThreadMemorySummary>> listThreadMemories(
    String threadId, {
    int limit = 24,
  }) async {
    final boundedLimit = limit.clamp(1, 100);
    final json = await api.getJson(
      NativePaths.memoryList(threadId: threadId, limit: boundedLimit),
    );
    final rawMemories = json['memories'];
    if (rawMemories is! List) {
      throw const FormatException('Conversation memory is unavailable.');
    }
    final memories = <TalkThreadMemorySummary>[];
    final seen = <String>{};
    for (final raw in rawMemories.take(boundedLimit)) {
      if (raw is! Map) continue;
      final memory = TalkThreadMemorySummary.tryFromJson(
        Map<String, dynamic>.from(raw),
      );
      if (memory != null && seen.add(memory.id)) memories.add(memory);
    }
    return List.unmodifiable(memories);
  }
}
