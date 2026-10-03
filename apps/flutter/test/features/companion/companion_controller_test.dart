import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/companion/companion_controller.dart';
import 'package:asael/features/companion/companion_models.dart';
import 'package:flutter_test/flutter_test.dart';

import 'companion_fixtures.dart';

void main() {
  test(
    'maximum revision remains readable but cannot admit a save or reset',
    () async {
      final repository = FakeCompanionRepository()
        ..response = CompanionResponse.fromJson(
          companionFixture(revision: companionMaximumRevision),
        );
      final c = CompanionController(repository);
      addTearDown(c.dispose);
      await c.refresh();
      c.edit(const CompanionPreferences(intensity: 'quiet'));
      expect(c.current!.revision, companionMaximumRevision);
      expect(c.canSubmit, false);
      await c.save();
      await c.save(reset: true);
      expect(repository.submissions, isEmpty);
    },
  );
  test('unavailable read never turns defaults into an editable or writable snapshot', () async {
    final repository = FakeCompanionRepository()
      ..readFailure = StateError('offline');
    final c = CompanionController(repository);
    addTearDown(c.dispose);
    await c.refresh();
    expect(c.current, isNull);
    expect(c.draft, isNull);
    expect(c.canSubmit, false);
    expect(c.readError, contains('read-only preview'));
    await c.save();
    expect(repository.submissions, isEmpty);
  });
  test('held enrollment allows drafting but no mutation', () async {
    final repository = FakeCompanionRepository()
      ..policy = const CompanionWritePolicy(
        active: false,
        reason: 'Update required',
      );
    final c = CompanionController(repository);
    addTearDown(c.dispose);
    await c.refresh();
    c.edit(const CompanionPreferences(intensity: 'quiet'));
    await c.save();
    expect(c.dirty, true);
    expect(repository.submissions, isEmpty);
  });
  test('single write slot freezes body/key and preserves draft edits made during save', () async {
    final repository = FakeCompanionRepository()
      ..heldSave = Completer<CompanionResponse>();
    final c = CompanionController(repository, createKey: () => 'fixed-key');
    addTearDown(c.dispose);
    await c.refresh();
    c.edit(const CompanionPreferences(intensity: 'quiet'));
    final save = c.save();
    await c.save();
    expect(repository.submissions, hasLength(1));
    final frozen = repository.submissions.single;
    c.edit(const CompanionPreferences(intensity: 'expressive'));
    repository.heldSave!.complete(
      CompanionResponse.fromJson(
        companionFixture(
          revision: 1,
          preferences: frozen.submitted,
          submission: frozen,
        ),
        submission: frozen,
      ),
    );
    await save;
    expect(c.receipt!.revision, 1);
    expect(c.draft!.intensity, 'expressive');
    expect(c.draftRevision, 1);
    expect(c.dirty, true);
    expect(c.writing, false);
  });
  test('uncertain retry retains identical body/key across edits and later pre-store refusal', () async {
    final repository = FakeCompanionRepository()
      ..saveFailure = const ApiException('connection ended');
    final c = CompanionController(repository, createKey: () => 'frozen-key');
    addTearDown(c.dispose);
    await c.refresh();
    c.edit(const CompanionPreferences(motion: 'off'));
    await c.save();
    final frozen = c.submission!;
    c.edit(const CompanionPreferences(intensity: 'quiet'));
    repository.saveFailure = const ApiException(
      'owner mismatch',
      statusCode: 403,
    );
    await c.retrySubmission();
    expect(c.submission, same(frozen));
    expect(c.uncertain, true);
    repository.saveFailure = null;
    await c.retrySubmission();
    expect(
      repository.submissions.every((value) => identical(value, frozen)),
      true,
    );
    expect(c.submission, isNull);
    expect(c.receipt!.preferences.motion, 'off');
    expect(c.draft!.intensity, 'quiet');
  });
  test(
    '409 retains draft and requires refreshed access and explicit rebase',
    () async {
      final repository = FakeCompanionRepository()
        ..saveFailure = const ApiConflictException('changed');
      final c = CompanionController(repository);
      addTearDown(c.dispose);
      await c.refresh();
      c.edit(const CompanionPreferences(intensity: 'quiet'));
      await c.save();
      expect(c.submission, isNull);
      expect(c.canSubmit, false);
      expect(c.dirty, true);
      repository.response = CompanionResponse.fromJson(
        companionFixture(
          revision: 2,
          preferences: const CompanionPreferences(motion: 'off'),
        ),
      );
      await c.refresh();
      expect(c.staleRevision, true);
      expect(c.canSubmit, false);
      c.reviewAgainstCurrent();
      expect(c.canSubmit, true);
      expect(c.draft!.intensity, 'quiet');
    },
  );
  test('older replay receipt survives a newer snapshot and a later refresh failure', () async {
    final repository = FakeCompanionRepository()
      ..heldSave = Completer<CompanionResponse>();
    final c = CompanionController(repository);
    addTearDown(c.dispose);
    await c.refresh();
    c.edit(const CompanionPreferences(intensity: 'quiet'));
    final pending = c.save();
    final frozen = repository.submissions.single;
    repository.heldSave!.complete(
      CompanionResponse.fromJson(
        companionFixture(
          revision: 3,
          preferences: const CompanionPreferences(motion: 'off'),
          submission: frozen,
          outcome: 'replayed',
        ),
        submission: frozen,
      ),
    );
    await pending;
    expect(c.current!.revision, 3);
    expect(c.receipt!.revision, 1);
    expect(c.staleRevision, true);
    repository.readFailure = StateError('offline');
    await c.refresh();
    expect(c.receipt!.revision, 1);
    expect(c.current!.revision, 3);
    expect(c.writing, false);
  });
  test(
    'obsolete and disposed reads cannot replace owner-bound state',
    () async {
      final repository = FakeCompanionRepository()
        ..heldRead = Completer<CompanionResponse>();
      final c = CompanionController(repository);
      final pending = c.refresh();
      final oldRead = repository.heldRead!;
      repository.heldRead = null;
      await c.refresh();
      oldRead.complete(
        CompanionResponse.fromJson(
          companionFixture(
            revision: 5,
            preferences: const CompanionPreferences(intensity: 'quiet'),
          ),
        ),
      );
      await pending;
      expect(c.current!.revision, 0);
      expect(repository.readCancels.first.isCancelled, true);
      repository.heldRead = Completer<CompanionResponse>();
      final disposedRead = c.refresh();
      c.dispose();
      repository.heldRead!.complete(repository.response);
      await disposedRead;
      expect(c.current!.revision, 0);
    },
  );
  test('disposal fences a late accepted write without claiming server cancellation', () async {
    final repository = FakeCompanionRepository()
      ..heldSave = Completer<CompanionResponse>();
    final c = CompanionController(repository);
    await c.refresh();
    c.edit(const CompanionPreferences(intensity: 'quiet'));
    final pending = c.save();
    final frozen = repository.submissions.single;
    c.dispose();
    repository.heldSave!.complete(
      CompanionResponse.fromJson(
        companionFixture(
          revision: 1,
          preferences: frozen.submitted,
          submission: frozen,
        ),
        submission: frozen,
      ),
    );
    await pending;
    expect(c.receipt, isNull);
  });
}
