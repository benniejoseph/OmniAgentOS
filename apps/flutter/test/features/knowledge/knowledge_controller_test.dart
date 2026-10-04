import 'dart:async';

import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

MemoryRecord _memory(String id) =>
    MemoryRecord.fromJson({'id': id, 'title': id, 'content': 'Exact $id'});
KnowledgeState _state(String id, {String? cursor}) => KnowledgeState(
  memories: [_memory(id)],
  knowledge: [],
  nodes: [],
  edges: [],
  memoryCursor: cursor,
);

class _Repository extends Fake
    implements KnowledgeRepository, PagedKnowledgeRepository {
  final loads =
      <({KnowledgeQuery query, Completer<KnowledgeState> response})>[];
  KnowledgePage<MemoryRecord>? nextPage;
  Completer<MemoryRecord>? exact;
  int previewReads = 0;
  @override
  Future<KnowledgeState> loadWorkspace(KnowledgeQuery query) {
    final response = Completer<KnowledgeState>();
    loads.add((query: query, response: response));
    return response.future;
  }

  @override
  Future<KnowledgePage<MemoryRecord>> loadMemoryPage(
    KnowledgeQuery query,
    String cursor,
  ) async => nextPage!;
  @override
  Future<MemoryRecord> getMemory(String id) =>
      exact?.future ?? Future.value(_memory(id));
  @override
  Future<MemoryForgetPreview> previewForgetMemory(String id) async {
    previewReads++;
    throw StateError('unavailable');
  }
}

KnowledgeController _controller(_Repository repo) =>
    KnowledgeController(repo, canManage: false, mutationsAvailable: false);
void main() {
  test(
    'an older query success or error cannot replace the latest query',
    () async {
      final repo = _Repository();
      final current = _controller(repo);
      final old = current.search('old'), newest = current.search('new');
      repo.loads[1].response.complete(_state('new'));
      await newest;
      repo.loads[0].response.completeError(StateError('old failure'));
      await old;
      expect(current.state!.memories.single.id, 'new');
      expect(current.error, isNull);
      expect(current.query, 'new');
    },
  );
  test('same query refreshes coalesce, while a failed refresh retains its last view', () async {
    final repo = _Repository();
    final current = _controller(repo);
    final first = current.refresh(), second = current.refresh();
    expect(identical(first, second), isTrue);
    repo.loads.single.response.complete(_state('first'));
    await first;
    final retry = current.refresh();
    repo.loads.last.response.completeError(StateError('offline'));
    await retry;
    expect(current.state!.memories.single.id, 'first');
    expect(current.error, isStateError);
  });
  test(
    'pagination deduplicates live overlap and refuses a nonadvancing cursor',
    () async {
      final repo = _Repository();
      final current = _controller(repo);
      final read = current.refresh();
      repo.loads.single.response.complete(_state('one', cursor: 'page-2'));
      await read;
      repo.nextPage = KnowledgePage(
        items: [_memory('one'), _memory('two')],
        catalogTotal: 3,
        nextCursor: 'page-3',
      );
      await current.loadMoreMemory();
      expect(current.state!.memories.map((item) => item.id), ['one', 'two']);
      repo.nextPage = KnowledgePage(
        items: [_memory('three')],
        catalogTotal: 3,
        nextCursor: 'page-3',
      );
      await current.loadMoreMemory();
      expect(current.memoryPageError, isFormatException);
      expect(current.state!.memories, hasLength(2));
    },
  );
  test(
    'an exact response with a different identity is never accepted',
    () async {
      final repo = _Repository()..exact = Completer<MemoryRecord>();
      final controller = _controller(repo);
      final read = controller.inspect('selected');
      final assertion = expectLater(read, throwsFormatException);
      repo.exact!.complete(_memory('other'));
      await assertion;
    },
  );
  test(
    'disposal clears private state and fences pending list and exact reads',
    () async {
      final repo = _Repository()..exact = Completer<MemoryRecord>();
      final controller = _controller(repo);
      final list = controller.refresh();
      final exact = controller.inspect('one');
      final assertion = expectLater(exact, throwsStateError);
      controller.dispose();
      repo.loads.single.response.complete(_state('private'));
      repo.exact!.complete(_memory('one'));
      await list;
      await assertion;
      expect(controller.state, isNull);
      expect(controller.available, isFalse);
      await controller.refresh();
      expect(repo.loads, hasLength(1));
    },
  );
  test('disabled sessions and read-only accounts cannot start mutations or impact reads', () async {
    final repo = _Repository();
    final disabled = KnowledgeController(
      repo,
      canManage: true,
      mutationsAvailable: true,
      enabled: false,
    );
    await disabled.refresh();
    expect(repo.loads, isEmpty);
    await expectLater(disabled.add({}), throwsStateError);
    final viewer = _controller(repo);
    await expectLater(viewer.previewForget('one'), throwsStateError);
    expect(repo.previewReads, 0);
  });
}
