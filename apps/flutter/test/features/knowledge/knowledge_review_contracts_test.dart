import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_review_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'knowledge_review_fixtures.dart';

void main() {
  test(
    'readable private targets without a current token grant no decision',
    () async {
      final rows = await parseMemoryReviews(
        await reviewList([reviewRow(writable: false)]),
        reviewOwner,
        status: 'pending',
        limit: 50,
      );
      expect(rows.single.actionable, isFalse);
      expect(rows.single.candidate.content, 'Private candidate content');
    },
  );
  test(
    'bounded list rejects duplicate identities, wrong filter, and surplus rows',
    () async {
      for (final example in [
        (rows: [reviewRow(), reviewRow()], limit: 2),
        (rows: [reviewRow(decision: 'confirm_candidate')], limit: 1),
        (
          rows: [
            reviewRow(),
            reviewRow(id: 'review:two'),
          ],
          limit: 1,
        ),
      ]) {
        await expectLater(
          parseMemoryReviews(
            await reviewList(example.rows),
            reviewOwner,
            status: 'pending',
            limit: example.limit,
          ),
          throwsFormatException,
        );
      }
    },
  );
  test('read receipts reject a wrong actor or role despite the same canonical private owner', () async {
    for (final other in [
      KnowledgeOwner(
        reviewOwner.tenantId,
        'another@example.test',
        reviewOwner.userId,
        reviewOwner.role,
        reviewOwner.apiBaseUrl,
      ),
      KnowledgeOwner(
        reviewOwner.tenantId,
        reviewOwner.actorId,
        reviewOwner.userId,
        'viewer',
        reviewOwner.apiBaseUrl,
      ),
    ]) {
      await expectLater(
        MemoryReviewRead.parse(
          await reviewRead(reviewRow(), owner: other),
          reviewOwner,
          'review:one',
        ),
        throwsFormatException,
      );
    }
  });
  test(
    'unknown fields and nonprivate or mismatched targets fail closed',
    () async {
      final variants = <Json>[
        {...reviewRow(), 'writeAllowed': true},
        {
          ...reviewRow(),
          'candidate': {
            ...reviewMemory('memory:candidate'),
            'scope': 'workspace',
          },
        },
        {
          ...reviewRow(),
          'candidate': {
            ...reviewMemory('memory:candidate'),
            'tenantId': 'foreign',
          },
        },
        {...reviewRow(), 'kind': 'contradiction'},
        {...reviewRow(), 'reviewToken': 'not-a-token'},
        {...reviewRow(), 'createdAt': '2026-02-31T12:00:00Z'},
      ];
      for (final row in variants) {
        await expectLater(
          MemoryReviewRead.parse(
            await reviewRead(row),
            reviewOwner,
            'review:one',
          ),
          throwsFormatException,
        );
      }
    },
  );
  for (final decision in memoryReviewDecisions) {
    test(
      '$decision binds immutable before/after targets and separates projection outcome',
      () async {
        final sent = reviewSubmission(contradiction: true, decision: decision);
        final raw = await reviewDecisionResponse(sent);
        final accepted = await MemoryAcceptance.parse(raw, sent);
        expect(accepted.memoryId, 'memory:candidate');
        expect((accepted.raw['projections'] as Map)['graph'], 'unconfirmed');
        expect(sent.replayable, isFalse);
        final acceptance = raw['acceptance'] as Map;
        expect(
          acceptance['idempotencyKeySha256'],
          isNot((raw['serviceReceipt'] as Map)['idempotencyKeySha256']),
        );
        final after = acceptance['after'] as Map;
        (after['candidate'] as Map)['targetRevision'] = 9;
        await expectLater(
          MemoryAcceptance.parse(raw, sent),
          throwsFormatException,
        );
      },
    );
  }
  test(
    'exact read cannot settle another key, decision, token or target',
    () async {
      final sent = reviewSubmission();
      final acceptance = await reviewAcceptance(sent);
      final row = reviewRow(decision: 'confirm_candidate');
      final variants = <Json>[
        {...acceptance, 'idempotencyKeySha256': 'c' * 64},
        {...acceptance, 'decision': 'keep_existing'},
        {...acceptance, 'expectedReviewToken': 'c' * 64},
        {...acceptance, 'candidateMemoryId': 'memory:other'},
      ];
      for (final value in variants) {
        await expectLater(
          MemoryAcceptance.parse(
            await reviewRead(row, acceptance: value),
            sent,
          ),
          throwsFormatException,
        );
      }
      await expectLater(
        MemoryAcceptance.parse(await reviewRead(row), sent),
        throwsFormatException,
      );
    },
  );
  test(
    'confirmation cannot acquire keep-both authority through a saved journal',
    () {
      expect(
        () => reviewSubmission(decision: 'keep_both'),
        throwsFormatException,
      );
    },
  );
  test(
    'replayed acceptance reports no repeated downstream projection',
    () async {
      final sent = reviewSubmission(key: 'k' * 300);
      final raw = await reviewDecisionResponse(sent, replayed: true);
      expect((await MemoryAcceptance.parse(raw, sent)).raw['replayed'], isTrue);
      (raw['projections'] as Map)['graph'] = 'confirmed';
      await expectLater(
        MemoryAcceptance.parse(raw, sent),
        throwsFormatException,
      );
    },
  );
}
