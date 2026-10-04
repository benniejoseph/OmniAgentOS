import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_contracts.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_recovery_store.dart';
import 'package:asael/features/knowledge/knowledge_review_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'knowledge_review_fixtures.dart';

class HeldSaveStore extends MemoryKnowledgeRecoveryStore {
  final saved = Completer<void>(), release = Completer<void>();
  bool hold = true;
  @override
  Future<void> write(
    KnowledgeOwner owner,
    KnowledgeJson value,
    bool Function() isCurrent,
  ) async {
    await super.write(owner, value, isCurrent);
    if (hold) {
      hold = false;
      saved.complete();
      await release.future;
    }
  }
}

void main() {
  test('single admission slot persists exact reviewed values before PATCH and survives catalogue failure', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        repo = ReviewRepository()..failCatalogue = true;
    final controller = reviewController(repo, store);
    addTearDown(controller.dispose);
    await controller.reloadRecovery();
    repo.beforeSubmit = (sent) async {
      final journal = await store.read(reviewOwner);
      expect(journal!['state'], 'pending');
      expect(
        memoryCanonical(journal['submission']),
        memoryCanonical(sent.recovery),
      );
      await expectLater(
        controller.submitChange(MemoryChange.create, {
          'title': 'Blocked',
          'content': 'Second write',
        }),
        throwsStateError,
      );
    };
    await controller.resolveReview(
      MemoryReview.parse(repo.row, reviewOwner),
      'confirm_candidate',
    );
    expect(repo.reads.single, (id: 'review:one', hash: null));
    expect(repo.submissions, hasLength(1));
    expect(controller.pendingChange, isNull);
    expect(controller.acceptedChange, isNotNull);
    expect(controller.error, isNotNull);
    expect((await store.read(reviewOwner))!['state'], 'accepted');
  });
  test('lost response and restart recover only through exact authenticated GET with the original key hash', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        repo = ReviewRepository()..submitFailure = StateError('Response lost');
    final first = reviewController(repo, store);
    await first.reloadRecovery();
    await first.resolveReview(
      MemoryReview.parse(repo.row, reviewOwner),
      'confirm_candidate',
    );
    final sent = repo.submissions.single;
    first.dispose();
    final next = reviewController(repo, store);
    addTearDown(next.dispose);
    await next.reloadRecovery();
    await next.retryChange();
    expect(repo.submissions, hasLength(1));
    repo.row = reviewRow(decision: 'confirm_candidate');
    repo.accepted = await reviewAcceptance(sent);
    await next.recoverReview();
    expect(repo.reads.last, (
      id: sent.id!,
      hash: await memoryShaText(sent.key),
    ));
    expect(repo.submissions, hasLength(1));
    expect(next.pendingChange, isNull);
    expect(next.acceptedChange!.raw.containsKey('projections'), isFalse);
    expect(next.acceptedChange!.submission.key, sent.key);
  });
  test('pending, unavailable, forbidden, and mismatched visible resolution preserve the frozen unknown intent', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        repo = ReviewRepository()..submitFailure = StateError('Response lost');
    final controller = reviewController(repo, store);
    addTearDown(controller.dispose);
    await controller.reloadRecovery();
    await controller.resolveReview(
      MemoryReview.parse(repo.row, reviewOwner),
      'confirm_candidate',
    );
    final original = controller.pendingChange!;
    for (final failure in <Object?>[
      null,
      const ApiException('Missing', statusCode: 404),
      const ApiException('Denied', statusCode: 403),
      StateError('Offline'),
    ]) {
      repo.readFailure = failure;
      await controller.recoverReview();
      expect(controller.pendingChange, same(original));
      expect(controller.acceptedChange, isNull);
    }
    repo.readFailure = null;
    repo.row = reviewRow(decision: 'keep_existing');
    repo.accepted = await reviewAcceptance(
      reviewSubmission(key: original.key, decision: 'keep_existing'),
    );
    await controller.recoverReview();
    expect(controller.pendingChange, same(original));
    expect(controller.acceptedChange, isNull);
    expect(repo.submissions, hasLength(1));
    await expectLater(
      controller.submitChange(MemoryChange.create, {
        'title': 'Another',
        'content': 'Blocked',
      }),
      throwsStateError,
    );
  });
  test(
    'fresh exact token drift refuses preparation before journal or transport',
    () async {
      final store = MemoryKnowledgeRecoveryStore(), repo = ReviewRepository();
      final controller = reviewController(repo, store);
      addTearDown(controller.dispose);
      await controller.reloadRecovery();
      final reviewed = MemoryReview.parse(repo.row, reviewOwner);
      repo.row = {...repo.row, 'reviewToken': 'c' * 64};
      await expectLater(
        controller.resolveReview(reviewed, 'confirm_candidate'),
        throwsFormatException,
      );
      expect(await store.read(reviewOwner), isNull);
      expect(repo.submissions, isEmpty);
      expect(controller.changing, isFalse);
    },
  );
  test('closing or backgrounding during exact preflight stops the write and releases preparation', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        repo = ReviewRepository()..heldRead = Completer<MemoryReviewRead>();
    final controller = reviewController(repo, store);
    addTearDown(controller.dispose);
    await controller.reloadRecovery();
    var visible = true;
    final saving = controller.resolveReview(
      MemoryReview.parse(repo.row, reviewOwner),
      'confirm_candidate',
      isReviewCurrent: () => visible,
    );
    expect(controller.changing, isTrue);
    visible = false;
    repo.heldRead!.complete(
      await MemoryReviewRead.parse(
        await reviewRead(repo.row),
        reviewOwner,
        'review:one',
      ),
    );
    await saving;
    expect(controller.changing, isFalse);
    expect(controller.pendingChange, isNull);
    expect(repo.submissions, isEmpty);
    expect(await store.read(reviewOwner), isNull);
  });
  test('scope loss after protected save but before transport records definite non-submission', () async {
    final store = HeldSaveStore(), repo = ReviewRepository();
    final controller = reviewController(repo, store);
    addTearDown(controller.dispose);
    await controller.reloadRecovery();
    var visible = true;
    final saving = controller.resolveReview(
      MemoryReview.parse(repo.row, reviewOwner),
      'confirm_candidate',
      isReviewCurrent: () => visible,
    );
    await store.saved.future;
    visible = false;
    store.release.complete();
    await saving;
    expect(repo.submissions, isEmpty);
    expect(controller.pendingChange, isNull);
    expect(controller.changing, isFalse);
    expect((await store.read(reviewOwner))!['state'], 'not_submitted');
  });
  test('readable changed role can recover prior acceptance without acquiring write access; restart preserves read proof', () async {
    final store = MemoryKnowledgeRecoveryStore(), sent = reviewSubmission();
    await store.write(reviewOwner, {
      'version': 1,
      'state': 'pending',
      'submission': sent.recovery,
    }, () => true);
    final viewer = KnowledgeOwner(
      reviewOwner.tenantId,
      'renamed@example.test',
      reviewOwner.userId,
      'viewer',
      reviewOwner.apiBaseUrl,
    );
    final repo = ReviewRepository(owner: viewer)
      ..row = reviewRow(decision: 'confirm_candidate')
      ..accepted = await reviewAcceptance(sent);
    final controller = reviewController(repo, store);
    await controller.reloadRecovery();
    expect(controller.supportsChange(MemoryChange.review), isFalse);
    expect(controller.canRecoverReview, isTrue);
    await controller.recoverReview();
    expect(controller.pendingChange, isNull);
    expect(controller.acceptedChange!.reviewReadOwner!.role, 'viewer');
    controller.dispose();
    final reopened = reviewController(repo, store);
    addTearDown(reopened.dispose);
    await reopened.reloadRecovery();
    expect(reopened.acceptedChange!.submission.owner.role, 'operator');
    expect(reopened.acceptedChange!.reviewReadOwner!.actorId, viewer.actorId);
    expect(reopened.recoveryError, isNull);
    expect(repo.submissions, isEmpty);
  });
  test('owner replacement while exact preparation is held clears private state and cannot submit', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        repo = ReviewRepository()..heldRead = Completer<MemoryReviewRead>();
    final controller = reviewController(repo, store);
    addTearDown(controller.dispose);
    await controller.reloadRecovery();
    final saving = controller.resolveReview(
      MemoryReview.parse(repo.row, reviewOwner),
      'confirm_candidate',
    );
    repo.access.close(notify: false);
    repo.heldRead!.complete(
      await MemoryReviewRead.parse(
        await reviewRead(repo.row),
        reviewOwner,
        'review:one',
      ),
    );
    await saving;
    expect(controller.available, isFalse);
    expect(controller.pendingChange, isNull);
    expect(repo.submissions, isEmpty);
    expect(await store.read(reviewOwner), isNull);
  });
}
