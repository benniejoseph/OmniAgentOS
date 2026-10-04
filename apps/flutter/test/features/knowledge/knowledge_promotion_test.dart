import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_promotion_contracts.dart';
import 'package:asael/features/knowledge/knowledge_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'knowledge_promotion_fixtures.dart';
import 'knowledge_review_fixtures.dart' show reviewOwner;

void main() {
  test(
    'bounded list verifies private scope, exact summary and receipt authority',
    () async {
      final row = await promotionRow(),
          raw = await promotionList(await promotionRow());
      expect(
        (await parseMemoryPromotions(
          raw,
          reviewOwner,
          status: 'pending',
          limit: 25,
        )).single.sourceIds,
        ['memory:a', 'memory:b'],
      );
      for (final changed in <Json>[
        {...promotionSummary(row), 'unknown': true},
        {
          ...promotionSummary(row),
          'sourceMemoryIds': ['memory:b', 'memory:a'],
        },
        {...promotionSummary(row), 'tenantId': 'foreign'},
        {...promotionSummary(row), 'resolvedAt': '2026-10-04T12:00:00.000Z'},
      ]) {
        expect(
          () => MemoryPromotionSummary.parse(changed, reviewOwner),
          throwsFormatException,
        );
      }
      (raw['serviceReceipt'] as Map)['authoritySha256'] = 'e' * 64;
      await expectLater(
        parseMemoryPromotions(raw, reviewOwner, status: 'pending', limit: 25),
        throwsFormatException,
      );
    },
  );

  test(
    'exact sources reject manifest, owner and policy-scope substitution',
    () async {
      for (final field in ['sourceManifestSha256', 'canonical']) {
        final row = await promotionRow();
        if (field == 'canonical') {
          ((row['canonical'] as Map)['access'] as Map)['workspaceId'] =
              'workspace:foreign';
        } else {
          row[field] = 'e' * 64;
        }
        await expectLater(
          MemoryPromotionRead.parse(
            await promotionResponse(row),
            reviewOwner,
            promotionId,
          ),
          throwsFormatException,
        );
      }
      final row = await promotionRow(writable: false),
          store = MemoryKnowledgeRecoveryStore(),
          repo = PromotionRepository(await promotionRow(writable: false));
      final controller = promotionController(repo, store);
      addTearDown(controller.dispose);
      await controller.reloadRecovery();
      final read = await MemoryPromotionReview.parseExact(row, reviewOwner);
      expect(read.allowedDecisions, isEmpty);
      await expectLater(
        controller.decidePromotion(
          read,
          'promote',
          isReviewCurrent: () => true,
        ),
        throwsFormatException,
      );
      expect(repo.submissions, isEmpty);
      expect(await store.read(reviewOwner), isNull);
    },
  );

  test('acceptance binds frozen sources, token, key and deterministic newly created revision', () async {
    final sent = await promotionSubmission(),
        accepted = await promotionAcceptance(await promotionSubmission()),
        row = await promotionRow(decision: 'promote');
    expect(
      (await MemoryAcceptance.parse(
        await promotionResponse(row, acceptance: accepted, sent: sent),
        sent,
      )).submission.key,
      sent.key,
    );
    for (final changed in <Json>[
      {...accepted, 'idempotencyKeySha256': 'f' * 64},
      {...accepted, 'expectedReviewToken': 'f' * 64},
      {...accepted, 'policySha256': 'f' * 64},
      {...accepted, 'promotedTargetRevision': 2},
    ]) {
      await expectLater(
        MemoryAcceptance.parse(
          await promotionResponse(row, acceptance: changed, sent: sent),
          sent,
        ),
        throwsFormatException,
      );
    }
    final dismissal = await promotionSubmission(decision: 'dismiss');
    expect(
      (await MemoryAcceptance.parse(
        await promotionResponse(
          await promotionRow(decision: 'dismiss'),
          acceptance: await promotionAcceptance(dismissal),
          sent: dismissal,
        ),
        dismissal,
      )).memoryId,
      'memory:a',
    );
  });

  test('historical acceptance allows later sources only on exact recovery or replay', () async {
    final sent = await promotionSubmission(),
        accepted = await promotionAcceptance(await promotionSubmission());
    final sources = promotionSources()..first['targetRevision'] = 4;
    final later = await promotionRow(decision: 'promote', sources: sources);
    final recovered = await MemoryAcceptance.parse(
      await promotionResponse(later, acceptance: accepted),
      sent,
      reviewReadOwner: reviewOwner,
    );
    expect(
      (recovered.raw['acceptance'] as Map)['sourceTargets'],
      sent.promotionEvidence!['sourceTargets'],
    );
    await expectLater(
      MemoryAcceptance.parse(
        await promotionResponse(later, acceptance: accepted, sent: sent),
        sent,
      ),
      throwsFormatException,
    );
    await MemoryAcceptance.parse(
      await promotionResponse(
        later,
        acceptance: accepted,
        sent: sent,
        replayed: true,
      ),
      sent,
    );
    sources.first['targetRevision'] = 2;
    await expectLater(
      MemoryAcceptance.parse(
        await promotionResponse(
          await promotionRow(decision: 'promote', sources: sources),
          acceptance: accepted,
        ),
        sent,
      ),
      throwsFormatException,
    );
  });

  test('frozen promotion evidence is durable before PATCH and accepted receipt survives failed catalogue read', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        repo = PromotionRepository(await promotionRow())..failCatalogue = true;
    final controller = promotionController(repo, store);
    addTearDown(controller.dispose);
    await controller.reloadRecovery();
    repo.beforeSubmit = (sent) async {
      final saved = await store.read(reviewOwner);
      expect(saved!['state'], 'pending');
      expect(
        (saved['submission'] as Map)['promotionEvidence'],
        sent.promotionEvidence,
      );
      expect(controller.pendingChange!.key, sent.key);
    };
    await controller.decidePromotion(
      (await controller.inspectPromotion(promotionId)).review,
      'promote',
      isReviewCurrent: () => true,
    );
    expect(repo.submissions, hasLength(1));
    expect(controller.pendingChange, isNull);
    expect(controller.acceptedChange, isNotNull);
    expect(controller.error, isNotNull);
    expect((await store.read(reviewOwner))!['state'], 'accepted');
  });

  test('unknown outcome and restart recover by exact GET only; null and unavailable remain held', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        repo = PromotionRepository(await promotionRow())
          ..submitFailure = TimeoutException('lost response');
    final first = promotionController(repo, store);
    await first.reloadRecovery();
    await first.decidePromotion(
      (await first.inspectPromotion(promotionId)).review,
      'promote',
      isReviewCurrent: () => true,
    );
    final sent = first.pendingChange!;
    first.dispose();
    final next = promotionController(repo, store);
    addTearDown(next.dispose);
    await next.reloadRecovery();
    expect(next.pendingChange!.key, sent.key);
    expect(next.pendingChange!.replayable, isFalse);
    await next.recoverPromotion();
    expect(next.pendingChange!.key, sent.key);
    for (final status in [403, 404, 503]) {
      repo.readFailure = ApiException('Unavailable', statusCode: status);
      await next.recoverPromotion();
      expect(next.pendingChange!.key, sent.key);
    }
    repo.readFailure = null;
    repo.row = await promotionRow(decision: 'promote');
    repo.accepted = await promotionAcceptance(sent);
    await next.recoverPromotion();
    expect(next.pendingChange, isNull);
    expect(next.acceptedChange!.submission.key, sent.key);
    expect(repo.reads.last.hash, await memoryShaText(sent.key));
    expect(repo.submissions, hasLength(1));
    final saved = await store.read(reviewOwner);
    expect(
      MemoryAcceptance.restoredReadOwner(saved!, sent)!.key,
      reviewOwner.key,
    );
  });

  test(
    'a different accepted decision never settles the held request',
    () async {
      final store = MemoryKnowledgeRecoveryStore(),
          repo = PromotionRepository(await promotionRow())
            ..submitFailure = TimeoutException('unknown');
      final controller = promotionController(repo, store);
      addTearDown(controller.dispose);
      await controller.reloadRecovery();
      await controller.decidePromotion(
        (await controller.inspectPromotion(promotionId)).review,
        'promote',
        isReviewCurrent: () => true,
      );
      final sent = controller.pendingChange!;
      repo.row = await promotionRow(decision: 'dismiss');
      repo.accepted = await promotionAcceptance(
        await promotionSubmission(decision: 'dismiss', key: sent.key),
      );
      await controller.recoverPromotion();
      expect(controller.pendingChange!.key, sent.key);
      expect(controller.acceptedChange, isNull);
      expect(repo.submissions, hasLength(1));
    },
  );

  test('closing a delayed exact preflight clears preparation without writing or dispatching', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        repo = PromotionRepository(await promotionRow());
    final controller = promotionController(repo, store);
    addTearDown(controller.dispose);
    await controller.reloadRecovery();
    final reviewed = (await controller.inspectPromotion(promotionId)).review;
    repo.heldRead = Completer<MemoryPromotionRead>();
    var visible = true;
    final deciding = controller.decidePromotion(
      reviewed,
      'promote',
      isReviewCurrent: () => visible,
    );
    visible = false;
    repo.heldRead!.complete(
      await MemoryPromotionRead.parse(
        await promotionResponse(repo.row),
        reviewOwner,
        promotionId,
      ),
    );
    await deciding;
    expect(controller.changing, isFalse);
    expect(controller.pendingChange, isNull);
    expect(repo.submissions, isEmpty);
    expect(await store.read(reviewOwner), isNull);
  });

  test('scope replacement hides a late accepted response', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        repo = PromotionRepository(await promotionRow())
          ..heldSubmit = Completer<MemoryAcceptance>();
    final controller = promotionController(repo, store);
    addTearDown(controller.dispose);
    await controller.reloadRecovery();
    final deciding = controller.decidePromotion(
      (await controller.inspectPromotion(promotionId)).review,
      'promote',
      isReviewCurrent: () => true,
    );
    await until(() => repo.submissions.isNotEmpty);
    final sent = repo.submissions.single;
    repo.access.close();
    repo.heldSubmit!.complete(
      await MemoryAcceptance.parse(
        await promotionResponse(
          await promotionRow(decision: 'promote'),
          acceptance: await promotionAcceptance(sent),
          sent: sent,
        ),
        sent,
      ),
    );
    await deciding;
    expect(controller.available, isFalse);
    expect(controller.acceptedChange, isNull);
  });
}

Future<void> until(bool Function() condition) async {
  for (var i = 0; i < 100 && !condition(); i++) {
    await Future<void>.delayed(Duration.zero);
  }
  expect(condition(), isTrue);
}
