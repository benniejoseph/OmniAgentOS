import 'package:asael/features/quality/quality_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'quality_test_fixtures.dart';

QualityEvaluationsSnapshot _evaluations(Object? value) =>
    QualityEvaluationsSnapshot.parse(value, tenantId: 'tenant-a');
QualityReleaseReport _release(Object? value) =>
    QualityReleaseReport.parse(value, tenantId: 'tenant-a');

void main() {
  test('completed run retains failed and warning outcomes independently', () {
    final snapshot = _evaluations(qualityEvaluationsJson());
    final run = snapshot.runs.single;
    expect(snapshot.tenantId, 'tenant-a');
    expect(run.status, QualityRunStatus.completed);
    expect(run.summary.passed, 1);
    expect(run.summary.failed, 1);
    expect(run.summary.warnings, 1);
    expect(run.summary.passRate, closeTo(1 / 3, 0.00001));
    expect(snapshot.stats.completed, 1);
    expect(snapshot.stats.latestPassRate, closeTo(1 / 3, 0.00001));
    expect(snapshot.jobs.single.quarantined, isTrue);
    expect(snapshot.jobs.single.status, QualityJobStatus.failed);
    expect(snapshot.jobs.single.evalRunId, 'eval-run-1');
    expect(snapshot.cases.single.safetyMode, QualitySafetyMode.synthetic);
    expect(snapshot.cases.single.cleanup, QualityCleanupPolicy.selfCleaning);
    expect(snapshot.cases.single.writesToDatabase, isTrue);
  });

  test('empty history and zero-case run have no measured pass rate', () {
    final empty = qualityEvaluationsJson()
      ..['runs'] = <Object>[]
      ..['jobs'] = <Object>[]
      ..['stats'] = {
        'total': 0,
        'byStatus': <String, dynamic>{},
        'latestPassRate': 0,
        'averageLatencyMs': 0,
        'estimatedCostUsd': 0,
      };
    final snapshot = _evaluations(empty);
    expect(snapshot.stats.latest, isNull);
    expect(snapshot.stats.latestPassRate, isNull);
    final zero = qualityEvaluationsJson();
    for (final run in [
      (zero['runs'] as List).single as Map,
      (zero['stats'] as Map)['latest'] as Map,
    ]) {
      run['summary'] = {
        'total': 0,
        'passed': 0,
        'failed': 0,
        'warnings': 0,
        'averageLatencyMs': 0,
        'estimatedCostUsd': 0,
      };
    }
    (zero['stats'] as Map)['latestPassRate'] = 0;
    expect(_evaluations(zero).stats.latestPassRate, isNull);
    expect(_evaluations(zero).runs.single.summary.passRate, isNull);
  });

  test('exact tenant required on every run, latest run and release report', () {
    final wrongRun = qualityEvaluationsJson();
    ((wrongRun['runs'] as List).single as Map)['tenantId'] = 'tenant-b';
    final wrongLatest = qualityEvaluationsJson();
    ((wrongLatest['stats'] as Map)['latest'] as Map)['tenantId'] = 'tenant-b';
    final missingRunTenant = qualityEvaluationsJson();
    ((missingRunTenant['runs'] as List).single as Map).remove('tenantId');
    for (final value in [wrongRun, wrongLatest, missingRunTenant]) {
      expect(() => _evaluations(value), throwsFormatException);
    }
    expect(
      () => _release(qualityReleaseJson(tenantId: 'tenant-b')),
      throwsFormatException,
    );
  });

  test(
    'unknown lifecycle and safety states never become favorable defaults',
    () {
      for (final field in ['status', 'type']) {
        final value = qualityEvaluationsJson();
        ((value[field == 'status' ? 'runs' : 'cases'] as List).single
                as Map)[field] =
            'all_good';
        expect(() => _evaluations(value), throwsFormatException);
      }
      for (final field in ['safetyMode', 'cleanup']) {
        final value = qualityEvaluationsJson();
        (((value['cases'] as List).single as Map)['governance'] as Map)[field] =
            'safe';
        expect(() => _evaluations(value), throwsFormatException);
      }
      final status = qualityEvaluationsJson();
      ((status['jobs'] as List).single as Map)['status'] = 'quarantined';
      expect(() => _evaluations(status), throwsFormatException);
      final jobType = qualityEvaluationsJson();
      ((jobType['jobs'] as List).single as Map)['type'] = 'agent.execute';
      expect(() => _evaluations(jobType), throwsFormatException);
    },
  );

  test(
    'run counts, rates and numbers reject malformed or impossible values',
    () {
      for (final bad in [-1, 1.5, '3', double.nan, double.infinity, 1000001]) {
        final value = qualityEvaluationsJson();
        (((value['runs'] as List).single as Map)['summary'] as Map)['total'] =
            bad;
        expect(() => _evaluations(value), throwsFormatException);
      }
      final tooManyPassed = qualityEvaluationsJson();
      (((tooManyPassed['runs'] as List).single as Map)['summary']
              as Map)['passed'] =
          4;
      expect(() => _evaluations(tooManyPassed), throwsFormatException);
      for (final bad in [-0.1, double.infinity, '0.1']) {
        final value = qualityEvaluationsJson();
        (((value['runs'] as List).single as Map)['summary']
                as Map)['estimatedCostUsd'] =
            bad;
        expect(() => _evaluations(value), throwsFormatException);
      }
      final falseRate = qualityEvaluationsJson();
      (falseRate['stats'] as Map)['latestPassRate'] = 1;
      expect(() => _evaluations(falseRate), throwsFormatException);
    },
  );

  test(
    'stats are a bounded latest-100 sample with consistent known statuses',
    () {
      for (final mutate in <void Function(Map)>[
        (stats) => stats['total'] = 101,
        (stats) => stats['byStatus'] = {'completed': 2},
        (stats) => stats['byStatus'] = {'passed': 1},
        (stats) => stats['byStatus'] = {'running': null, 'completed': 1},
        (stats) => stats['latest'] = null,
      ]) {
        final value = qualityEvaluationsJson();
        mutate(value['stats'] as Map);
        expect(() => _evaluations(value), throwsFormatException);
      }
    },
  );

  test('quarantine cannot describe a successful or queued job', () {
    for (final status in ['queued', 'running', 'completed', 'canceled']) {
      final value = qualityEvaluationsJson();
      ((value['jobs'] as List).single as Map)['status'] = status;
      expect(() => _evaluations(value), throwsFormatException);
    }
    for (final field in ['attempt', 'maxAttempts']) {
      final value = qualityEvaluationsJson();
      ((value['jobs'] as List).single as Map)[field] = field == 'attempt'
          ? 4
          : 0;
      expect(() => _evaluations(value), throwsFormatException);
    }
    final ordinary = qualityEvaluationsJson();
    ((ordinary['jobs'] as List).single as Map).remove('quarantined');
    expect(_evaluations(ordinary).jobs.single.quarantined, isFalse);
  });

  test('all collection limits and duplicate identities fail closed', () {
    for (final field in ['runs', 'jobs', 'cases']) {
      final duplicate = qualityEvaluationsJson();
      (duplicate[field] as List).add((duplicate[field] as List).first);
      expect(() => _evaluations(duplicate), throwsFormatException);
      final overflow = qualityEvaluationsJson();
      final item = (overflow[field] as List).first as Map;
      overflow[field] = List.generate(
        field == 'cases' ? 201 : 101,
        (index) => {...item, 'id': '$field-$index'},
      );
      expect(() => _evaluations(overflow), throwsFormatException);
    }
  });

  test('invalid dates and oversized user-visible text are rejected', () {
    for (final date in [
      '2026-02-30T20:00:00.000Z',
      '2026-10-04T25:00:00.000Z',
      '2026-10-04',
      '2026-10-04T20:00:00',
      'yesterday',
    ]) {
      final value = qualityEvaluationsJson();
      ((value['runs'] as List).single as Map)['startedAt'] = date;
      expect(() => _evaluations(value), throwsFormatException);
    }
    final value = qualityEvaluationsJson();
    ((value['cases'] as List).single as Map)['description'] = 'a' * 4001;
    expect(() => _evaluations(value), throwsFormatException);
  });

  test('published safety flags are typed and not inferred from case names', () {
    final value = qualityEvaluationsJson();
    final governance =
        ((value['cases'] as List).single as Map)['governance'] as Map;
    governance['safetyMode'] = 'mutation_allowed';
    governance['riskLevel'] = 3;
    governance['cleanup'] = 'manual_review';
    governance['production'] = {
      'allowedByDefault': false,
      'requiresAdmin': true,
      'requiresMutationApproval': true,
    };
    final item = _evaluations(value).cases.single;
    expect(item.safetyMode, QualitySafetyMode.mutationAllowed);
    expect(item.riskLevel, 3);
    expect(item.allowedByDefault, isFalse);
    expect(item.requiresAdmin, isTrue);
    expect(item.requiresMutationApproval, isTrue);
    governance['writesToDatabase'] = 'false';
    expect(() => _evaluations(value), throwsFormatException);
  });

  test('approval remains independent of advisory warning status', () {
    final approved = _release(qualityReleaseJson());
    expect(approved.status, QualityReleaseStatus.warning);
    expect(approved.approved, isTrue);
    expect(approved.summary.warnings, 1);
    expect(approved.gates.last.status, QualityGateStatus.warn);
    expect(approved.checkedAt, DateTime.utc(2026, 10, 4, 20, 2));
    final withheld = qualityReleaseJson();
    ((withheld['report'] as Map)['releaseGate'] as Map)['approved'] = false;
    expect(_release(withheld).approved, isFalse);
    expect(_release(withheld).status, QualityReleaseStatus.warning);
  });

  test('unknown release and gate states cannot be presented as passed', () {
    final release = qualityReleaseJson();
    ((release['report'] as Map)['releaseGate'] as Map)['status'] = 'ready';
    expect(() => _release(release), throwsFormatException);
    final gate = qualityReleaseJson();
    (((gate['report'] as Map)['gates'] as List).first as Map)['status'] =
        'passed';
    expect(() => _release(gate), throwsFormatException);
    final approved = qualityReleaseJson();
    ((approved['report'] as Map)['releaseGate'] as Map)['approved'] = 'true';
    expect(() => _release(approved), throwsFormatException);
  });

  test('release summaries must match exact gates and cannot hide failures', () {
    final wrongCount = qualityReleaseJson();
    (((wrongCount['report'] as Map)['releaseGate'] as Map)['summary']
            as Map)['total'] =
        3;
    expect(() => _release(wrongCount), throwsFormatException);
    final falsePass = qualityReleaseJson();
    ((falsePass['report'] as Map)['releaseGate'] as Map)['status'] = 'passed';
    expect(() => _release(falsePass), throwsFormatException);
    final hiddenFailure = qualityReleaseJson();
    (((hiddenFailure['report'] as Map)['gates'] as List).first
            as Map)['status'] =
        'fail';
    expect(() => _release(hiddenFailure), throwsFormatException);
    final duplicated = qualityReleaseJson();
    final gates = (duplicated['report'] as Map)['gates'] as List;
    (gates.last as Map)['id'] = (gates.first as Map)['id'];
    expect(() => _release(duplicated), throwsFormatException);
  });

  test('failed gates cannot accompany a favorable approval flag', () {
    final value = qualityReleaseJson();
    final report = value['report'] as Map;
    final gate = report['releaseGate'] as Map;
    gate['status'] = 'blocked';
    gate['summary'] = {'total': 2, 'passed': 1, 'warnings': 0, 'failures': 1};
    ((report['gates'] as List).last as Map)['status'] = 'fail';
    expect(() => _release(value), throwsFormatException);
    gate['approved'] = false;
    expect(_release(value).status, QualityReleaseStatus.blocked);
    expect(_release(value).approved, isFalse);
  });

  test('empty gate set cannot claim favorable evidence', () {
    final value = qualityReleaseJson();
    final report = value['report'] as Map;
    report['gates'] = <Object>[];
    report['releaseGate'] = {
      'approved': true,
      'status': 'passed',
      'summary': {'total': 0, 'passed': 0, 'warnings': 0, 'failures': 0},
      'reasons': <String>[],
      'warnings': <String>[],
    };
    expect(() => _release(value), throwsFormatException);
  });

  test('parsed collections are detached and unmodifiable at every level', () {
    final raw = qualityEvaluationsJson();
    final snapshot = _evaluations(raw);
    final notes =
        (((raw['cases'] as List).single as Map)['governance'] as Map)['notes']
            as List;
    notes.clear();
    (raw['runs'] as List).clear();
    expect(snapshot.runs, hasLength(1));
    expect(snapshot.cases.single.notes, hasLength(1));
    expect(() => snapshot.runs.clear(), throwsUnsupportedError);
    expect(() => snapshot.jobs.clear(), throwsUnsupportedError);
    expect(() => snapshot.cases.clear(), throwsUnsupportedError);
    expect(() => snapshot.cases.single.notes.clear(), throwsUnsupportedError);
    final rawRelease = qualityReleaseJson();
    final release = _release(rawRelease);
    ((rawRelease['report'] as Map)['gates'] as List).clear();
    expect(release.gates, hasLength(2));
    expect(() => release.gates.clear(), throwsUnsupportedError);
    expect(() => release.reasons.clear(), throwsUnsupportedError);
    expect(() => release.warnings.clear(), throwsUnsupportedError);
    expect(() => release.recommendations.clear(), throwsUnsupportedError);
  });

  test('missing required source collections and flags remain unavailable', () {
    for (final field in ['runs', 'stats', 'jobs', 'cases']) {
      final value = qualityEvaluationsJson()..remove(field);
      expect(() => _evaluations(value), throwsFormatException);
    }
    final caseFlags = qualityEvaluationsJson();
    (((caseFlags['cases'] as List).single as Map)['governance'] as Map).remove(
      'writesToDatabase',
    );
    expect(() => _evaluations(caseFlags), throwsFormatException);
    expect(() => _release({'report': null}), throwsFormatException);
  });
}
