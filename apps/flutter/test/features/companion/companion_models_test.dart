import 'package:asael/features/companion/companion_models.dart';
import 'package:asael/features/companion/companion_presentation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'companion_fixtures.dart';

void main() {
  test('thread IDs and timestamps accept the server contract without calendar rollover', () {
    for (final id in [
      homeThread,
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
    ]) {
      expect(companionThreadId(id), id);
    }
    expect(companionThreadId('FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'), isNull);
    for (final instant in [
      '2026-10-03T10:00Z',
      '2026-10-03T10:00+05:30',
      '2026-10-03T10:00:00.123456789Z',
      '0000-02-29T00:00Z',
      '2400-02-29T00:00-23:59',
    ]) {
      final value = companionFixture(revision: 1);
      (value['snapshot'] as Map)['updatedAt'] = instant;
      expect(CompanionResponse.fromJson(value).updatedAt, instant);
    }
    for (final instant in [
      '2026-02-29T10:00Z',
      '1900-02-29T10:00Z',
      '2026-04-31T10:00Z',
      '2026-10-03T24:00Z',
      '2026-10-03T10:00:60Z',
      '2026-10-03T10:00+24:00',
      '2026-10-03T10:00+01:60',
      '2026-10-03T10:00',
    ]) {
      final value = companionFixture(revision: 1);
      (value['snapshot'] as Map)['updatedAt'] = instant;
      expect(() => CompanionResponse.fromJson(value), throwsFormatException);
    }
  });
  test('strict defaults are read-only server defaults and unknown fields are rejected', () {
    final defaults = CompanionResponse.fromJson(companionFixture());
    expect(defaults.persisted, false);
    expect(defaults.nativeDestination, '/talk');
    expect(
      () =>
          CompanionResponse.fromJson({...companionFixture(), 'private': true}),
      throwsFormatException,
    );
    final bad = companionFixture();
    (bad['snapshot'] as Map)['persisted'] = true;
    expect(() => CompanionResponse.fromJson(bad), throwsFormatException);
  });
  test('home availability is bound to the saved UUID and native fallback never mutates it', () {
    const preferences = CompanionPreferences(preferredThreadId: homeThread);
    final available = CompanionResponse.fromJson(
      companionFixture(revision: 1, preferences: preferences),
    );
    expect(available.nativeDestination, '/talk?thread=$homeThread');
    final unavailable = CompanionResponse.fromJson(
      companionFixture(
        revision: 1,
        preferences: preferences,
        homeState: 'unavailable',
      ),
    );
    expect(unavailable.nativeDestination, '/talk');
    expect(unavailable.preferences.preferredThreadId, homeThread);
    final mismatch = companionFixture(revision: 1, preferences: preferences);
    (mismatch['home'] as Map)['href'] = '/app/command?thread=$otherThread';
    expect(() => CompanionResponse.fromJson(mismatch), throwsFormatException);
  });
  test('receipt binds frozen values and expected revision while old replay may coexist with newer snapshot', () {
    final submission = CompanionSubmission(
      key: 'key:1',
      expectedRevision: 0,
      draftAtStart: const CompanionPreferences(intensity: 'quiet'),
    );
    final replay = CompanionResponse.fromJson(
      companionFixture(
        revision: 3,
        preferences: const CompanionPreferences(motion: 'off'),
        submission: submission,
        outcome: 'replayed',
      ),
      submission: submission,
    );
    expect(replay.receipt!.revision, 1);
    expect(replay.revision, 3);
    final wrong = companionFixture(
      revision: 1,
      preferences: submission.submitted,
      submission: submission,
    );
    (wrong['mutation'] as Map)['preferences'] = const CompanionPreferences()
        .toJson();
    expect(
      () => CompanionResponse.fromJson(wrong, submission: submission),
      throwsFormatException,
    );
    expect(
      () => CompanionResponse.fromJson(
        companionFixture(),
        submission: submission,
      ),
      throwsFormatException,
    );
  });
  test('picker excludes foreign owners, opaque IDs, duplicates, and excess windows', () {
    Map<String, Object?> row(String id, {String actor = 'actor'}) => {
      'id': id,
      'tenantId': 'tenant',
      'actorId': actor,
      'title': 'Full owned title',
      'updatedAt': savedAt,
      'mode': 'research',
    };
    final parsed = parseCompanionConversations(
      {
        'threads': [
          row(homeThread),
          row(otherThread),
          row(otherThread),
          row('thread:opaque'),
          row(homeThread, actor: 'other'),
        ],
      },
      tenantId: 'tenant',
      actorId: 'actor',
    );
    expect(parsed.threads.map((row) => row.id), [homeThread]);
    expect(parsed.omitted, 4);
    expect(
      () => parseCompanionConversations(
        {'threads': List.generate(101, (_) => row(homeThread))},
        tenantId: 'tenant',
        actorId: 'actor',
      ),
      throwsFormatException,
    );
  });
  test('completion requires full bound verification and reactions deduplicate exact event identity', () {
    final verified = companionWork(
      status: 'completed',
      runId: 'run:1',
      terminalReceipt: verifiedTerminalFixture(),
    );
    expect(verified.state, 'completed');
    final ledger = CompanionReactionLedger();
    expect(ledger.accept(verified), true);
    expect(ledger.accept(verified), false);
    for (final invalid in [
      null,
      {'disposition': 'succeeded'},
      verifiedTerminalFixture(runId: 'run:other'),
      {...verifiedTerminalFixture(), 'verificationState': 'partially_verified'},
      {...verifiedTerminalFixture(), 'source': 'legacy_adapter'},
      {...verifiedTerminalFixture(), 'disposition': 'partial'},
      {...verifiedTerminalFixture(), 'verifiedRequirementCount': 2},
      {...verifiedTerminalFixture(), 'verifierReceiptIds': <String>[]},
    ]) {
      expect(
        companionWork(
          status: 'completed',
          runId: 'run:1',
          terminalReceipt: invalid,
        ).state,
        isNot('completed'),
      );
    }
  });
  test('actual foreground audio wins, queued remains queued, and OS motion is a floor', () {
    final queued = companionWork(status: 'queued', runId: 'run:1');
    expect(queued.label, 'Queued');
    expect(companionForeground(work: queued).label, 'Queued');
    expect(
      companionForeground(work: queued, microphoneActive: true).state,
      'listening',
    );
    expect(
      companionForeground(
        work: queued,
        microphoneActive: true,
        playbackActive: true,
      ).state,
      'responding',
    );
    expect(
      companionForeground(work: queued, speechPreparing: true).label,
      'Preparing reply audio',
    );
    expect(
      companionEffectiveMotion(const CompanionPreferences(), true),
      'reduced',
    );
    expect(
      companionEffectiveMotion(const CompanionPreferences(motion: 'off'), true),
      'off',
    );
    final gate = CompanionHomeGate();
    final old = gate.capture();
    gate.invalidate();
    expect(gate.current(old), false);
  });

  test(
    'historical and unseen terminal receipts cannot introduce a reaction',
    () {
      final completed = companionWork(
        status: 'completed',
        runId: 'run:1',
        terminalReceipt: verifiedTerminalFixture(),
      );
      final mountedCompleted = CompanionReactionLedger();
      expect(mountedCompleted.observe(completed, allowReaction: false), false);
      expect(mountedCompleted.observe(completed, allowReaction: true), false);
      final lateHistoricalRead = CompanionReactionLedger();
      lateHistoricalRead.observe(availableCompanion, allowReaction: true);
      expect(lateHistoricalRead.observe(completed, allowReaction: true), false);
      lateHistoricalRead.observe(
        companionWork(status: 'running', runId: 'run:1'),
        allowReaction: true,
      );
      expect(lateHistoricalRead.observe(completed, allowReaction: true), false);
    },
  );

  test('only an exact observed active run admits its fresh verified completion once', () {
    for (final status in ['running', 'waiting_approval', 'paused']) {
      final ledger = CompanionReactionLedger();
      ledger.observe(
        companionWork(status: status, runId: 'run:1'),
        allowReaction: true,
      );
      final completed = companionWork(
        status: 'completed',
        runId: 'run:1',
        terminalReceipt: verifiedTerminalFixture(),
      );
      expect(ledger.observe(completed, allowReaction: true), true);
      expect(ledger.observe(completed, allowReaction: true), false);
    }
    for (final observation in [
      companionWork(status: 'blocked', runId: 'run:1'),
      companionWork(status: 'running', runId: 'run:other'),
    ]) {
      final ledger = CompanionReactionLedger();
      ledger.observe(observation, allowReaction: true);
      expect(
        ledger.observe(
          companionWork(
            status: 'completed',
            runId: 'run:1',
            terminalReceipt: verifiedTerminalFixture(),
          ),
          allowReaction: true,
        ),
        false,
      );
    }
  });

  test(
    'suppressed completion is consumed while hidden or audio has priority',
    () {
      final ledger = CompanionReactionLedger();
      ledger.observe(
        companionWork(status: 'running', runId: 'run:1'),
        allowReaction: true,
      );
      final completed = companionWork(
        status: 'completed',
        runId: 'run:1',
        terminalReceipt: verifiedTerminalFixture(),
      );
      expect(ledger.observe(completed, allowReaction: false), false);
      expect(ledger.observe(completed, allowReaction: true), false);
    },
  );
}
