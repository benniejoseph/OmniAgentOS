import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

const owner = KnowledgeOwner(
  'tenant',
  'operator@example.test',
  '00000000-0000-4000-8000-000000000001',
  'operator',
  'https://example.test',
);
final token = 'a' * 64;
Json lifecycleBody() => {
  'contract': 'asael-memory-lifecycle-mutation:1',
  'action': 'pin',
  'expectedTargetToken': token,
};
Future<Json> lifecycleReceipt(MemorySubmission sent) async {
  final life = <String, dynamic>{
    'policyVersion': 1,
    'pinnedAt': '2026-10-04T10:00:00.000Z',
    'archivedAt': null,
    'archiveReason': null,
    'duplicateOfMemoryId': null,
    'updatedAt': '2026-10-04T10:00:00.000Z',
  };
  final acceptance = {
    'contract': 'asael-memory-lifecycle-acceptance:1',
    'id':
        'memory-lifecycle-acceptance:${await memorySha(['memory-lifecycle-acceptance:1', owner.tenantId, owner.canonicalActorId, await memoryShaText(sent.key)])}',
    'tenantId': owner.tenantId,
    'ownerActorId': owner.canonicalActorId,
    'memoryId': sent.id,
    'action': 'pin',
    'idempotencyKeySha256': await memoryShaText(sent.key),
    'requestSha256': 'b' * 64,
    'expectedTargetToken': token,
    'acceptedAt': '2026-10-04T10:00:00.000Z',
    'targetRevision': 1,
    'beforeLifecycleRevision': 0,
    'afterLifecycleRevision': 1,
    'lifecycle': life,
    'historicalTruthChanged': false,
    'permanentDeletion': false,
  };
  final raw = <String, dynamic>{
    'acceptance': acceptance,
    'replayed': false,
    'current': {
      'contract': 'asael-memory-lifecycle-read:1',
      'target': {
        'tenantId': owner.tenantId,
        'ownerActorId': owner.canonicalActorId,
        'memoryId': sent.id,
        'visibility': 'user_private',
        'claimStatus': 'active',
        'targetRevision': 1,
        'lifecycleRevision': 1,
        'token': 'c' * 64,
      },
      'lifecycle': life,
    },
    'currentRecord': {'state': 'unavailable'},
  };
  final receipt = <String, dynamic>{
    'schemaVersion': 1,
    'receiptKind': 'app_service_receipt',
    'boundaryVersion': 'p9.1-app-service-boundary:1',
    'operation': 'memory.lifecycle',
    'action': 'write.memory',
    'resourceType': 'memory',
    'accessMode': 'mutation',
    'eventContract': 'memory.atomic-events.v1',
    'authoritySha256': 'd' * 64,
    'idempotencyKeySha256': await memoryShaText(
      '${owner.tenantId}\u0000${sent.key}',
    ),
    'outcomeSha256': await memorySha(raw),
    'resourceCount': 1,
    'occurredAt': '2026-10-04T10:00:00.000Z',
  };
  raw['serviceReceipt'] = {
    ...receipt,
    'receiptSha256': await memorySha(receipt),
  };
  return raw;
}

class Repo extends Fake
    implements KnowledgeRepository, KnowledgeMutationRepository {
  Repo() {
    access.update(owner, true);
  }
  @override
  final access = KnowledgeAccess();
  final requests = <MemorySubmission>[];
  Completer<MemoryAcceptance>? held;
  Object? failure;
  bool failRead = false;
  @override
  bool authorityCurrent() => access.readable;
  @override
  bool supports(MemoryChange kind) => true;
  @override
  Future<MemoryAcceptance> submit(
    MemorySubmission sent,
    bool Function() current,
  ) async {
    requests.add(sent);
    if (failure != null) throw failure!;
    if (held != null) return held!.future;
    return MemoryAcceptance.parse(await lifecycleReceipt(sent), sent);
  }

  @override
  Future<KnowledgeState> load({String query = '', String type = 'all'}) async {
    if (failRead) throw StateError('read failed');
    return const KnowledgeState(
      memories: [],
      knowledge: [],
      nodes: [],
      edges: [],
    );
  }
}

KnowledgeController controller(Repo repo, KnowledgeRecoveryStore store) =>
    KnowledgeController(
      repo,
      canManage: true,
      mutationsAvailable: false,
      recoveryStore: store,
    );

void main() {
  test('lifecycle acceptance binds exact key and reviewed target while current read can be newer', () async {
    final sent = MemorySubmission(
      kind: MemoryChange.lifecycle,
      owner: owner,
      body: lifecycleBody(),
      id: 'memory-one',
      key: 'fixed-key',
    );
    final raw = await lifecycleReceipt(sent);
    expect((await MemoryAcceptance.parse(raw, sent)).memoryId, 'memory-one');
    final other = MemorySubmission(
      kind: MemoryChange.lifecycle,
      owner: owner,
      body: {...lifecycleBody(), 'expectedTargetToken': 'e' * 64},
      id: 'memory-one',
      key: 'fixed-key',
    );
    await expectLater(
      MemoryAcceptance.parse(raw, other),
      throwsFormatException,
    );
    (raw['acceptance'] as Map)['afterLifecycleRevision'] = 4;
    await expectLater(MemoryAcceptance.parse(raw, sent), throwsFormatException);
  });
  test(
    'pending create survives replacement and never automatically resends',
    () async {
      final store = MemoryKnowledgeRecoveryStore(),
          repo = Repo()..failure = StateError('response lost');
      final first = controller(repo, store);
      await first.reloadRecovery();
      await first.submitChange(MemoryChange.create, {
        'title': 'Fact',
        'content': 'Private fact',
      });
      expect(repo.requests, hasLength(1));
      first.dispose();
      final next = controller(repo, store);
      await next.reloadRecovery();
      expect(next.pendingChange!.key, repo.requests.single.key);
      await next.retryChange();
      expect(repo.requests, hasLength(1));
      await expectLater(
        next.submitChange(MemoryChange.create, {
          'title': 'Again',
          'content': 'Private fact',
        }),
        throwsStateError,
      );
      next.dispose();
    },
  );
  test('cross-action admission is synchronous and acceptance survives refresh failure', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        repo = Repo()
          ..held = Completer<MemoryAcceptance>()
          ..failRead = true;
    final current = controller(repo, store);
    await current.reloadRecovery();
    final saving = current.submitChange(
      MemoryChange.lifecycle,
      lifecycleBody(),
      id: 'memory-one',
    );
    await expectLater(
      current.submitChange(MemoryChange.create, {
        'title': 'Another',
        'content': 'Fact',
      }),
      throwsStateError,
    );
    await Future<void>.delayed(Duration.zero);
    final sent = repo.requests.single;
    repo.held!.complete(
      await MemoryAcceptance.parse(await lifecycleReceipt(sent), sent),
    );
    await saving;
    expect(current.acceptedChange!.memoryId, 'memory-one');
    expect(current.error, isStateError);
    expect(current.pendingChange, isNull);
    current.dispose();
  });
  test('unknown lifecycle replay uses the same frozen key and a later conflict does not erase uncertainty', () async {
    final repo = Repo()..failure = StateError('lost'),
        store = MemoryKnowledgeRecoveryStore();
    final current = controller(repo, store);
    await current.reloadRecovery();
    await current.submitChange(
      MemoryChange.lifecycle,
      lifecycleBody(),
      id: 'memory-one',
    );
    final sent = current.pendingChange!;
    repo.failure = const ApiException('changed', statusCode: 409);
    await current.retryChange();
    expect(identical(repo.requests.last, sent), isTrue);
    expect(current.pendingChange, same(sent));
    current.dispose();
  });
  test('owner replacement hides state and rejects a delayed receipt', () async {
    final repo = Repo()..held = Completer<MemoryAcceptance>(),
        store = MemoryKnowledgeRecoveryStore();
    final current = controller(repo, store);
    await current.reloadRecovery();
    final work = current.submitChange(
      MemoryChange.lifecycle,
      lifecycleBody(),
      id: 'memory-one',
    );
    await Future<void>.delayed(Duration.zero);
    final sent = repo.requests.single;
    repo.access.update(
      const KnowledgeOwner(
        'tenant',
        'other@example.test',
        '00000000-0000-4000-8000-000000000002',
        'operator',
        'https://example.test',
      ),
      true,
    );
    repo.held!.complete(
      await MemoryAcceptance.parse(await lifecycleReceipt(sent), sent),
    );
    await work;
    expect(current.available, isFalse);
    expect(current.acceptedChange, isNull);
    current.dispose();
  });
  test('decimal hashing matches JavaScript receipt number boundaries', () {
    expect(
      memoryCanonical({'a': 1.0, 'b': 0.000001, 'c': 1e-7}),
      '{"a":1,"b":0.000001,"c":1e-7}',
    );
  });
}
