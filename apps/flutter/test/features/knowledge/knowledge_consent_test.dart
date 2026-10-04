import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_consent_contracts.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'knowledge_consent_fixtures.dart';
import 'knowledge_review_fixtures.dart' show reviewOwner;

void main() {
  test('full current notice, consent history and ordered authority digest are verified', () async {
    for (final value in [
      await consentCurrent(),
      await consentCurrent(active: true),
      await consentCurrent(generation: 4),
    ]) {
      final read = await MemoryConsentRead.parse(
        await consentResponse(value),
        reviewOwner,
      );
      expect(read.current.notice['text'], consentText);
      expect(read.acceptance, isNull);
    }
    final altered = await consentCurrent();
    (altered['notice'] as Map)['text'] = 'Different notice';
    await expectLater(
      MemoryConsentRead.parse(await consentResponse(altered), reviewOwner),
      throwsFormatException,
    );
    final active = await consentCurrent(active: true);
    (active['authority'] as Map)['authoritySha256'] = 'c' * 64;
    await expectLater(
      MemoryConsentRead.parse(await consentResponse(active), reviewOwner),
      throwsFormatException,
    );
  });
  test(
    'null decision token remains readable and never grants decision authority',
    () async {
      final repo = ConsentRepository(await consentCurrent(writable: false)),
          store = MemoryKnowledgeRecoveryStore();
      final controller = consentController(repo, store);
      addTearDown(controller.dispose);
      await controller.reloadRecovery();
      final read = await controller.readConsent();
      expect(read.current.token, isNull);
      await expectLater(
        controller.decideConsent(
          read.current,
          'activate',
          isReviewCurrent: () => true,
        ),
        throwsFormatException,
      );
      expect(await store.read(reviewOwner), isNull);
      expect(repo.submissions, isEmpty);
    },
  );
  test('activation, revocation and no-op acceptances bind exact before and after states', () async {
    for (final sample in [
      (current: await consentCurrent(), action: 'activate'),
      (
        current: await consentCurrent(active: true, generation: 3),
        action: 'revoke',
      ),
      (
        current: await consentCurrent(active: true, generation: 3),
        action: 'activate',
      ),
      (current: await consentCurrent(generation: 3), action: 'revoke'),
    ]) {
      final sent = consentSubmission(sample.current, action: sample.action);
      final acceptance = await consentAcceptance(sent);
      final after = acceptance['after'] as Map;
      final fresh = await consentResponse(
        await consentCurrent(
          active: after['state'] == 'active',
          generation: after['consentGeneration'] as int,
        ),
        acceptance: acceptance,
        sent: sent,
      );
      expect(
        (await MemoryAcceptance.parse(fresh, sent)).submission.body['action'],
        sample.action,
      );
      final raw = await consentResponse(
        await consentCurrent(generation: 8),
        acceptance: acceptance,
        sent: sent,
        replayed: true,
      );
      expect(
        (await MemoryAcceptance.parse(raw, sent)).submission.body['action'],
        sample.action,
      );
      // A later current state never rewrites the immutable decision receipt.
      expect((raw['current'] as Map)['consentGeneration'], 8);
      (acceptance['after'] as Map)['consentGeneration'] = 20;
      final mismatched = await consentResponse(
        await consentCurrent(),
        acceptance: acceptance,
        sent: sent,
      );
      await expectLater(
        MemoryAcceptance.parse(mismatched, sent),
        throwsFormatException,
      );
    }
  });
  test(
    'exact consent recovery rejects a current state older than its acceptance',
    () async {
      final sent = consentSubmission(
        await consentCurrent(active: true, generation: 3),
        action: 'revoke',
      );
      final acceptance = await consentAcceptance(sent),
          keyHash = await memoryShaText(sent.key);
      for (final current in [
        await consentCurrent(generation: 2),
        await consentCurrent(active: true, generation: 3),
      ]) {
        await expectLater(
          MemoryConsentRead.parse(
            await consentResponse(
              current,
              acceptance: acceptance,
              keyHash: keyHash,
            ),
            reviewOwner,
            keyHash: keyHash,
          ),
          throwsFormatException,
        );
      }
      final later = await MemoryConsentRead.parse(
        await consentResponse(
          await consentCurrent(active: true, generation: 4),
          acceptance: acceptance,
          keyHash: keyHash,
        ),
        reviewOwner,
        keyHash: keyHash,
      );
      expect(later.current.generation, 4);
      expect((later.acceptance!['after'] as Map)['consentGeneration'], 3);
    },
  );
  test(
    'only replayed consent decisions may return a later current snapshot',
    () async {
      final sent = consentSubmission(await consentCurrent()),
          acceptance = await consentAcceptance(
            consentSubmission(await consentCurrent()),
          );
      for (final current in [
        await consentCurrent(generation: 1),
        await consentCurrent(active: true, generation: 4),
      ]) {
        await expectLater(
          MemoryAcceptance.parse(
            await consentResponse(current, acceptance: acceptance, sent: sent),
            sent,
          ),
          throwsFormatException,
        );
        final replay = await MemoryAcceptance.parse(
          await consentResponse(
            current,
            acceptance: acceptance,
            sent: sent,
            replayed: true,
          ),
          sent,
        );
        expect(replay.submission.key, sent.key);
      }
    },
  );
  test('decision acceptance rejects another key, notice, expected token or snapshot', () async {
    final sent = consentSubmission(await consentCurrent()),
        acceptance = await consentAcceptance(
          consentSubmission(await consentCurrent()),
        );
    for (final changed in <Json>[
      {...acceptance, 'idempotencyKeySha256': 'c' * 64},
      {...acceptance, 'noticeSha256': 'c' * 64},
      {...acceptance, 'expectedDecisionToken': 'c' * 64},
      {
        ...acceptance,
        'before': {
          'state': 'inactive',
          'consentGeneration': 4,
          'lifecycleRevision': 2,
        },
      },
    ]) {
      await expectLater(
        MemoryAcceptance.parse(
          await consentResponse(
            await consentCurrent(active: true),
            acceptance: changed,
            sent: sent,
          ),
          sent,
        ),
        throwsFormatException,
      );
    }
  });
  test('consent uses the same protected admission slot and stores the full reviewed notice before transport', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        repo = ConsentRepository(await consentCurrent());
    final controller = consentController(repo, store);
    addTearDown(controller.dispose);
    await controller.reloadRecovery();
    repo.beforeSubmit = (sent) async {
      final saved = await store.read(reviewOwner);
      expect(saved!['state'], 'pending');
      expect(
        memoryCanonical(saved['submission']),
        memoryCanonical(sent.recovery),
      );
      expect(sent.consentNotice!['text'], consentText);
      await expectLater(
        controller.submitChange(MemoryChange.create, {
          'title': 'Another',
          'content': 'Held',
        }),
        throwsStateError,
      );
    };
    await controller.decideConsent(
      (await controller.readConsent()).current,
      'activate',
      isReviewCurrent: () => true,
    );
    expect(repo.submissions, hasLength(1));
    expect(controller.pendingChange, isNull);
    expect(controller.acceptedChange!.submission.kind, MemoryChange.consent);
    expect((await store.read(reviewOwner))!['state'], 'accepted');
  });
  test('notice generation drift or foreground loss during preflight never dispatches or strands preparation', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        repo = ConsentRepository(await consentCurrent());
    final controller = consentController(repo, store);
    addTearDown(controller.dispose);
    await controller.reloadRecovery();
    final reviewed = (await controller.readConsent()).current;
    repo.snapshot = await consentCurrent(generation: 2);
    await expectLater(
      controller.decideConsent(
        reviewed,
        'activate',
        isReviewCurrent: () => true,
      ),
      throwsFormatException,
    );
    expect(controller.changing, isFalse);
    repo.heldRead = Completer<MemoryConsentRead>();
    var foreground = true;
    final saving = controller.decideConsent(
      reviewed,
      'activate',
      isReviewCurrent: () => foreground,
    );
    foreground = false;
    repo.heldRead!.complete(
      await MemoryConsentRead.parse(
        await consentResponse(await consentCurrent()),
        reviewOwner,
      ),
    );
    await saving;
    expect(controller.changing, isFalse);
    expect(controller.pendingChange, isNull);
    expect(repo.submissions, isEmpty);
    expect(await store.read(reviewOwner), isNull);
  });
  test('unknown consent write survives restart and recovers by exact GET despite a later changed setting', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        repo = ConsentRepository(await consentCurrent())
          ..submitFailure = StateError('Response lost');
    final first = consentController(repo, store);
    await first.reloadRecovery();
    await first.decideConsent(
      (await first.readConsent()).current,
      'activate',
      isReviewCurrent: () => true,
    );
    final sent = repo.submissions.single;
    first.dispose();
    final reopened = consentController(repo, store);
    addTearDown(reopened.dispose);
    await reopened.reloadRecovery();
    await reopened.retryChange();
    repo.snapshot = await consentCurrent(generation: 4);
    repo.accepted = await consentAcceptance(sent);
    await reopened.recoverConsent();
    expect(repo.reads.last, await memoryShaText(sent.key));
    expect(repo.submissions, hasLength(1));
    expect(reopened.pendingChange, isNull);
    expect(reopened.acceptedChange!.submission.key, sent.key);
    expect(
      (reopened.acceptedChange!.raw['current'] as Map)['state'],
      'inactive',
    );
    expect(reopened.acceptedChange!.description, contains('enable'));
  });
  test('current matching state, missing receipt or a failed exact read never settles an uncertain write', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        repo = ConsentRepository(await consentCurrent())
          ..submitFailure = StateError('Unknown');
    final controller = consentController(repo, store);
    addTearDown(controller.dispose);
    await controller.reloadRecovery();
    await controller.decideConsent(
      (await controller.readConsent()).current,
      'activate',
      isReviewCurrent: () => true,
    );
    final pending = controller.pendingChange!;
    repo.snapshot = await consentCurrent(active: true);
    for (final failure in <Object?>[
      null,
      const ApiException('Missing', statusCode: 404),
      const ApiException('Denied', statusCode: 403),
      StateError('Unavailable'),
    ]) {
      repo.readFailure = failure;
      await controller.recoverConsent();
      expect(controller.pendingChange, same(pending));
      expect(controller.acceptedChange, isNull);
    }
    expect(repo.submissions, hasLength(1));
  });
  test('changed role can read prior acceptance without reusing old write authority, including another restart', () async {
    final store = MemoryKnowledgeRecoveryStore(),
        sent = consentSubmission(await consentCurrent());
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
    final repo = ConsentRepository(
      await consentCurrent(owner: viewer, active: true, writable: false),
      owner: viewer,
    )..accepted = await consentAcceptance(sent);
    final controller = consentController(repo, store);
    await controller.reloadRecovery();
    expect(controller.supportsChange(MemoryChange.consent), isFalse);
    await controller.recoverConsent();
    expect(controller.acceptedChange, isNotNull);
    controller.dispose();
    final reopened = consentController(repo, store);
    addTearDown(reopened.dispose);
    await reopened.reloadRecovery();
    expect(reopened.acceptedChange!.submission.owner.role, 'operator');
    expect(reopened.acceptedChange!.reviewReadOwner!.role, 'viewer');
    expect(reopened.recoveryError, isNull);
    expect(repo.submissions, isEmpty);
  });
}
