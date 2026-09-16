import 'package:flutter/foundation.dart';

import '../../generated/native_contract.g.dart';

typedef TalkHistoryJson = Map<String, dynamic>;

TalkHistoryJson _jsonRecord(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

String _safeProjectionText(Object? value, int maximum, {String fallback = ''}) {
  if (value is! String || maximum < 1) return fallback;
  final normalized = value
      .replaceAll(
        RegExp(r'[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]'),
        ' ',
      )
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  if (normalized.isEmpty) return fallback;
  final runes = normalized.runes;
  return runes.length <= maximum
      ? normalized
      : '${String.fromCharCodes(runes.take(maximum - 1))}\u2026';
}

String safeTalkHistoryId(Object? value) {
  if (value is! String ||
      value.isEmpty ||
      value.length > 200 ||
      !RegExp(r'^[A-Za-z0-9._:-]+$').hasMatch(value)) {
    return '';
  }
  return value;
}

DateTime? _safeProjectionDate(Object? value) {
  if (value is! String || value.length > 80) return null;
  return DateTime.tryParse(value)?.toLocal();
}

enum TalkHistoryState { idle, loading, refreshing, ready, empty, error, stale }

enum TalkThreadState { idle, loading, ready, error, stale }

enum TalkMemoryContextState { idle, loading, ready, empty, stale }

enum TalkThreadRole { user, assistant }

class TalkThreadSummary {
  const TalkThreadSummary({
    required this.id,
    required this.title,
    required this.mode,
    this.createdAt,
    this.updatedAt,
  });

  final String id;
  final String title;
  final String mode;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  factory TalkThreadSummary.fromJson(TalkHistoryJson payload) {
    final id = safeTalkHistoryId(payload['id']);
    if (id.isEmpty) {
      throw const FormatException('Invalid conversation identity.');
    }
    final rawMode = _safeProjectionText(payload['mode'], 24).toLowerCase();
    final mode =
        const {'orchestrate', 'research', 'execute', 'learn'}.contains(rawMode)
        ? rawMode
        : 'orchestrate';
    return TalkThreadSummary(
      id: id,
      title: _safeProjectionText(
        payload['title'],
        120,
        fallback: 'Untitled conversation',
      ),
      mode: mode,
      createdAt: _safeProjectionDate(payload['createdAt']),
      updatedAt: _safeProjectionDate(payload['updatedAt']),
    );
  }
}

class TalkThreadTurn {
  const TalkThreadTurn({
    required this.role,
    required this.text,
    this.createdAt,
  });

  final TalkThreadRole role;
  final String text;
  final DateTime? createdAt;

  static TalkThreadTurn? tryFromJson(TalkHistoryJson payload, String threadId) {
    if (safeTalkHistoryId(payload['threadId']) != threadId) return null;
    final role = switch (payload['role']) {
      'user' => TalkThreadRole.user,
      'assistant' => TalkThreadRole.assistant,
      _ => null,
    };
    if (role == null) return null;
    final text = _safeProjectionText(payload['content'], 40000);
    if (text.isEmpty) return null;
    return TalkThreadTurn(
      role: role,
      text: text,
      createdAt: _safeProjectionDate(payload['createdAt']),
    );
  }
}

class TalkThreadDetail {
  const TalkThreadDetail({required this.thread, required this.turns});

  final TalkThreadSummary thread;
  final List<TalkThreadTurn> turns;

  factory TalkThreadDetail.fromJson(TalkHistoryJson payload) {
    final thread = TalkThreadSummary.fromJson(_jsonRecord(payload['thread']));
    final turns = <TalkThreadTurn>[];
    final rawTurns = payload['turns'];
    if (rawTurns is List) {
      for (final raw in rawTurns.take(40)) {
        final turn = TalkThreadTurn.tryFromJson(_jsonRecord(raw), thread.id);
        if (turn != null) turns.add(turn);
      }
    }
    return TalkThreadDetail(thread: thread, turns: List.unmodifiable(turns));
  }
}

class TalkThreadMemorySummary {
  const TalkThreadMemorySummary({
    required this.id,
    required this.title,
    required this.type,
    this.updatedAt,
  });

  final String id;
  final String title;
  final String type;
  final DateTime? updatedAt;

  static TalkThreadMemorySummary? tryFromJson(TalkHistoryJson payload) {
    final id = safeTalkHistoryId(payload['id']);
    if (id.isEmpty) return null;
    return TalkThreadMemorySummary(
      id: id,
      title: _safeProjectionText(
        payload['title'],
        120,
        fallback: 'Linked memory',
      ),
      type: _safeProjectionText(payload['type'], 32, fallback: 'memory'),
      updatedAt: _safeProjectionDate(payload['updatedAt']),
    );
  }
}

/// Actor-scoped read surface published by native contract v9. Authentication
/// remains an ApiClient responsibility and this interface exposes no mutation.
abstract interface class TalkHistoryRepository {
  Future<List<TalkThreadSummary>> listThreads({int limit = 30});
  Future<TalkThreadDetail> getThread(String threadId);
  Future<List<TalkThreadMemorySummary>> listThreadMemories(
    String threadId, {
    int limit = 24,
  });
}

/// Owns the durable-history state machine while the host conversation
/// controller retains streaming, activity, and composer concerns.
mixin TalkHistoryControllerMixin on ChangeNotifier {
  TalkHistoryRepository? get talkHistoryRepository;
  bool get historyInteractionBusy;
  void applyHistoryThreadProjection(TalkThreadDetail detail);
  void clearHistoryThreadProjection();

  final recentThreads = <TalkThreadSummary>[];
  final selectedThreadMemories = <TalkThreadMemorySummary>[];
  String? threadId;
  String? openingThreadId;
  String? failedThreadId;
  DateTime? historyLoadedAt;
  TalkHistoryState historyState = TalkHistoryState.idle;
  TalkThreadState threadState = TalkThreadState.idle;
  TalkMemoryContextState memoryContextState = TalkMemoryContextState.idle;
  bool _historyDisposed = false;
  int _historyLoadGeneration = 0;
  int _threadLoadGeneration = 0;

  bool get conversationHistorySupported =>
      talkHistoryRepository != null &&
      NativeContract.supportsOperation('threads.list') &&
      NativeContract.supportsOperation('threads.get') &&
      NativeContract.supportsOperation('memory.list');
  bool get hasSelectedThread => threadId != null;
  int get selectedThreadMemoryCount => selectedThreadMemories.length;
  TalkThreadSummary? get selectedThread {
    final selectedId = threadId;
    if (selectedId == null) return null;
    for (final thread in recentThreads) {
      if (thread.id == selectedId) return thread;
    }
    return null;
  }

  Future<void> loadRecentThreads({bool force = false}) async {
    final repository = talkHistoryRepository;
    if (!conversationHistorySupported ||
        repository == null ||
        _historyDisposed) {
      return;
    }
    if (!force &&
        (historyState == TalkHistoryState.loading ||
            historyState == TalkHistoryState.refreshing)) {
      return;
    }
    final generation = ++_historyLoadGeneration;
    final hasProjection = recentThreads.isNotEmpty;
    historyState = hasProjection
        ? TalkHistoryState.refreshing
        : TalkHistoryState.loading;
    notifyListeners();
    try {
      final loaded = await repository.listThreads(limit: 30);
      if (_historyDisposed || generation != _historyLoadGeneration) return;
      final seen = <String>{};
      recentThreads
        ..clear()
        ..addAll(loaded.where((thread) => seen.add(thread.id)).take(30));
      historyLoadedAt = DateTime.now();
      historyState = recentThreads.isEmpty
          ? TalkHistoryState.empty
          : TalkHistoryState.ready;
    } catch (_) {
      if (_historyDisposed || generation != _historyLoadGeneration) return;
      historyState = hasProjection
          ? TalkHistoryState.stale
          : TalkHistoryState.error;
    }
    notifyListeners();
  }

  Future<void> openThread(String requestedId) async {
    final repository = talkHistoryRepository;
    final id = safeTalkHistoryId(requestedId);
    if (!conversationHistorySupported ||
        repository == null ||
        id.isEmpty ||
        historyInteractionBusy ||
        _historyDisposed) {
      return;
    }
    final generation = ++_threadLoadGeneration;
    final refreshingCurrent =
        threadId == id && threadState == TalkThreadState.ready;
    openingThreadId = id;
    failedThreadId = null;
    threadState = TalkThreadState.loading;
    memoryContextState = TalkMemoryContextState.loading;
    notifyListeners();

    var memoryUnavailable = false;
    final memoriesFuture = repository
        .listThreadMemories(id, limit: 24)
        .catchError((Object _) {
          memoryUnavailable = true;
          return <TalkThreadMemorySummary>[];
        });
    try {
      final detail = await repository.getThread(id);
      if (detail.thread.id != id) {
        throw const FormatException('Conversation identity did not match.');
      }
      final memories = await memoriesFuture;
      if (_historyDisposed || generation != _threadLoadGeneration) return;
      threadId = id;
      openingThreadId = null;
      failedThreadId = null;
      threadState = TalkThreadState.ready;
      applyHistoryThreadProjection(detail);
      selectedThreadMemories
        ..clear()
        ..addAll(memories.take(24));
      memoryContextState = memoryUnavailable
          ? TalkMemoryContextState.stale
          : selectedThreadMemories.isEmpty
          ? TalkMemoryContextState.empty
          : TalkMemoryContextState.ready;
      _upsertRecentThread(detail.thread);
    } catch (_) {
      if (_historyDisposed || generation != _threadLoadGeneration) return;
      openingThreadId = null;
      failedThreadId = id;
      threadState = refreshingCurrent
          ? TalkThreadState.stale
          : TalkThreadState.error;
      memoryContextState = refreshingCurrent
          ? TalkMemoryContextState.stale
          : TalkMemoryContextState.idle;
    }
    notifyListeners();
  }

  Future<void> retryOpenThread() async {
    final id = failedThreadId ?? threadId;
    if (id != null) await openThread(id);
  }

  Future<void> refreshSelectedThread() async {
    final id = threadId;
    if (id != null) await openThread(id);
  }

  void newConversation() {
    if (historyInteractionBusy || _historyDisposed) return;
    _threadLoadGeneration += 1;
    threadId = null;
    openingThreadId = null;
    failedThreadId = null;
    threadState = TalkThreadState.idle;
    memoryContextState = TalkMemoryContextState.idle;
    selectedThreadMemories.clear();
    clearHistoryThreadProjection();
    notifyListeners();
  }

  String? adoptConversationThreadId(Object? value) {
    final id = safeTalkHistoryId(value);
    if (id.isEmpty) return null;
    threadId = id;
    openingThreadId = null;
    failedThreadId = null;
    threadState = TalkThreadState.ready;
    return id;
  }

  void disposeTalkHistory() {
    _historyDisposed = true;
    _historyLoadGeneration += 1;
    _threadLoadGeneration += 1;
  }

  void _upsertRecentThread(TalkThreadSummary thread) {
    recentThreads.removeWhere((candidate) => candidate.id == thread.id);
    recentThreads.insert(0, thread);
    if (recentThreads.length > 30) recentThreads.removeLast();
    if (historyState == TalkHistoryState.empty ||
        historyState == TalkHistoryState.idle ||
        historyState == TalkHistoryState.error) {
      historyState = TalkHistoryState.ready;
    }
  }
}
