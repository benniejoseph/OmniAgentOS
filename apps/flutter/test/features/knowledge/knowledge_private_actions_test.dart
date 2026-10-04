import 'dart:async';

import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_private_action_contracts.dart';
import 'package:asael/features/knowledge/knowledge_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'knowledge_private_action_fixtures.dart';
import 'knowledge_review_fixtures.dart' show reviewOwner;

void main() {
  test('source-map exact acceptance binds owner, key, complete review and current decision', () async {
    final sent = await privateSubmission(key: 'a' * 300),
        raw = await privateResponse(await privateSubmission(key: 'a' * 300));
    final accepted = await MemoryAcceptance.parse(raw, sent);
    expect(accepted.memoryId, 'memory:$sourceMapTestId');
    expect((accepted.raw['review'] as Map)['projection'], 'unconfirmed');
    final wrong = await privateSubmission(key: 'another-key');
    await expectLater(
      MemoryAcceptance.parse(raw, wrong),
      throwsFormatException,
    );
    final changed = {...raw, 'review': await sourceMapRow(decision: 'dismiss')}
      ..remove('serviceReceipt');
    await expectLater(
      MemoryAcceptance.parse(
        await privateSeal(
          changed,
          'app.knowledge.cognification.native.decide',
          sent: sent,
        ),
        sent,
      ),
      throwsFormatException,
    );
    final oversized = await sourceMapRow();
    oversized['claims'] = List.generate(49, (_) => {'statement': 'claim'});
    await expectLater(
      KnowledgeSourceMap.parse(oversized),
      throwsFormatException,
    );
  });
  test('source deletion exact manifest rejects counts, source scope and missing receipt', () async {
    final sent = await privateSubmission(deletion: true),
        raw = await privateResponse(await privateSubmission(deletion: true));
    expect(
      (await MemoryAcceptance.parse(raw, sent)).description,
      contains('1 documents and 2 derived memories'),
    );
    final altered = {...raw}..remove('serviceReceipt');
    final proof = Map<String, dynamic>.from(raw['acceptance'] as Map),
        result = Map<String, dynamic>.from(proof['result'] as Map);
    result['documents'] = 2;
    proof['result'] = result;
    proof['acceptanceSha256'] = await memorySha(
      {...proof}..remove('acceptanceSha256'),
    );
    altered['acceptance'] = proof;
    await expectLater(
      MemoryAcceptance.parse(
        await privateSeal(
          altered,
          'app.knowledge.sources.native.delete',
          sent: sent,
        ),
        sent,
      ),
      throwsFormatException,
    );
    await expectLater(
      KnowledgeSourceDeletionRead.parse(
        raw,
        reviewOwner,
        'drive',
        keyHash: await privateActionKey(sent),
        sent: sent,
        mutation: true,
      ),
      throwsFormatException,
    );
    await expectLater(
      MemoryAcceptance.parse(
        await privateResponse(sent, mutation: false, absent: true),
        sent,
        reviewReadOwner: reviewOwner,
      ),
      throwsFormatException,
    );
  });
  for (final deletion in [false, true]) {
    test(
      '${deletion ? 'deletion' : 'source map'} saves one journal and recovers lost response only through exact GET',
      () async {
        final repository = PrivateActionRepository()..loseResponse = true,
            store = MemoryKnowledgeRecoveryStore();
        var controller = privateController(repository, store);
        await controller.reloadRecovery();
        repository.beforeSubmit = (sent) async {
          expect((await store.read(reviewOwner))!['submission'], sent.recovery);
        };
        if (deletion) {
          await controller.deleteReviewedSource(
            await controller.inspectSourceDeletion('mail'),
            isReviewCurrent: () => true,
          );
        } else {
          await controller.decideSourceMap(
            (await controller.inspectSourceMap(sourceMapTestId)).review,
            'confirm',
            isReviewCurrent: () => true,
          );
        }
        expect(repository.privateSubmissions, hasLength(1));
        expect(controller.pendingChange, isNotNull);
        controller.dispose();
        controller = privateController(repository, store);
        await controller.reloadRecovery();
        repository.returnAbsent = true;
        if (deletion) {
          await controller.recoverSourceDeletion();
        } else {
          await controller.recoverSourceMap();
        }
        expect(controller.pendingChange, isNotNull);
        repository.returnAbsent = false;
        if (deletion) {
          await controller.recoverSourceDeletion();
        } else {
          await controller.recoverSourceMap();
        }
        expect(controller.pendingChange, isNull);
        expect(controller.acceptedChange, isNotNull);
        expect(repository.privateSubmissions, hasLength(1));
        controller.dispose();
      },
    );
  }
  test('closed source-map view fences delayed preflight and releases its busy state', () async {
    final repository = PrivateActionRepository(),
        store = MemoryKnowledgeRecoveryStore(),
        controller = privateController(repository, store);
    await controller.reloadRecovery();
    final read = await controller.inspectSourceMap(sourceMapTestId);
    repository.heldMap = Completer();
    var current = true;
    final result = controller.decideSourceMap(
      read.review,
      'confirm',
      isReviewCurrent: () => current,
    );
    current = false;
    repository.heldMap!.complete(read);
    await result;
    expect(repository.privateSubmissions, isEmpty);
    expect(await store.read(reviewOwner), isNull);
    expect(controller.changing, isFalse);
    controller.dispose();
  });
}
