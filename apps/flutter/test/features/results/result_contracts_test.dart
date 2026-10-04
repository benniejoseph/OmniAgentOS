import 'package:asael/features/results/result_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'canonical result keys preserve the complete already-decoded identity',
    () {
      for (final kind in ['agent', 'workflow', 'approval']) {
        const id = 'exact:run/東京+percent%2Fvalue';
        final key = ResultKey.parse('$kind:$id');
        expect(key.kind, kind);
        expect(key.id, id);
        expect(key.value, '$kind:$id');
        expect(Uri.decodeComponent(Uri.encodeComponent(key.value)), key.value);
      }
      for (final value in [
        'agent:',
        ':no-kind',
        'unknown:id',
        'agent: id',
        'workflow:id\n',
      ]) {
        expect(() => ResultKey.parse(value), throwsFormatException);
      }
    },
  );
  test('legacy completion cannot manufacture verified success', () {
    final legacy = canonical(
      status: 'unverified',
      basis: 'legacy_status',
      source: 'legacy_adapter',
      verification: 'unassessed',
      sourceStatus: 'completed',
    );
    expect(
      ResultCanonical.fromJson(legacy, domain: 'agent_run').label,
      'Outcome unverified',
    );
    expect(
      () => ResultCanonical.fromJson({
        ...legacy,
        'status': 'succeeded',
      }, domain: 'agent_run'),
      throwsFormatException,
    );
    expect(
      ResultCanonical.fromJson(canonical(), domain: 'agent_run').label,
      'Verified success',
    );
  });
  test('canonical receipt fields reject coercions, wrong domains and inconsistent verification', () {
    for (final malformed in [
      {
        ...canonical(),
        'status': ['succeeded'],
      },
      {...canonical(), 'domain': 'workflow_run'},
      {...canonical(), 'source': 'legacy_adapter'},
      {...canonical(), 'verificationState': 'unassessed'},
      {...canonical(), 'sourceStatus': 'completed'},
      {...canonical(), 'schemaVersion': '1'},
    ]) {
      expect(
        () => ResultCanonical.fromJson(malformed, domain: 'agent_run'),
        throwsFormatException,
      );
    }
    expect(
      () => ResultCanonical.fromJson({
        ...canonical(),
        'domain': 'approval',
      }, domain: 'approval'),
      throwsFormatException,
    );
  });
  test('unavailable counts stay unknown while stale reads retain their last known boundary', () {
    final unavailable = const ResultsRead().failed('Synthetic unavailable');
    expect(unavailable.loaded, isFalse);
    expect(unavailable.label, 'Unavailable');
    final current = ResultsRead(
      state: ResultsAvailability.ready,
      loaded: true,
      checkedAt: DateTime.utc(2026, 10, 4),
    );
    final stale = current.failed('Synthetic refresh unavailable');
    expect(stale.retained, isTrue);
    expect(stale.checkedAt, current.checkedAt);
    expect(stale.fresh, isFalse);
    expect(current.failed('Revoked', restricted: true).loaded, isFalse);
  });
  test('same-session pause preserves scope while role replacement and closure invalidate reads', () {
    final access = ResultsAccess(
      deployment: 'https://synthetic.invalid',
      tenantId: 'tenant',
      actorId: 'actor',
      role: 'operator',
    );
    addTearDown(access.dispose);
    final scope = access.scope;
    access.update(available: false);
    expect(access.scope, scope);
    expect(access.readable, isFalse);
    expect(access.generation, 1);
    access.update(
      tenant: 'tenant',
      actor: 'actor',
      nextRole: 'viewer',
      available: true,
    );
    expect(access.scope, isNot(scope));
    expect(access.writable, isFalse);
    expect(access.generation, 2);
    access.close();
    expect(access.readable, isFalse);
    expect(access.generation, 3);
  });
  test('invalid calendar dates cannot silently normalize into a different recorded time', () {
    for (final value in [
      '2026-02-31T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-10-04T25:00:00Z',
      '2026-10-04T00:61:00Z',
    ]) {
      expect(() => resultDate(value), throwsFormatException);
    }
    expect(
      resultDate('2026-10-04T12:00:00+05:30'),
      DateTime.utc(2026, 10, 4, 6, 30),
    );
  });
}

Map<String, dynamic> canonical({
  String status = 'succeeded',
  String basis = 'terminal_receipt',
  String source = 'outcome_evaluator',
  String verification = 'verified',
  String sourceStatus = 'succeeded',
}) => {
  'schemaVersion': 1,
  'status': status,
  'domain': 'agent_run',
  'basis': basis,
  'source': source,
  'sourceStatus': sourceStatus,
  'verificationState': verification,
};
