import 'package:asael/features/builder/builder_contracts.dart';
import 'package:flutter_test/flutter_test.dart';

import 'builder_test_support.dart';

BuilderSnapshot parse(BuilderJson value) =>
    BuilderSnapshot.parse(value, builderProject, builderApi);
void main() {
  test(
    'Mac verification keeps platform checks and rejects incomplete cases',
    () {
      final raw = snapshotJson();
      final verification = (raw['verifications'] as List).single as Map;
      verification['checks'] = [
        for (final command in ['macos_analyze', 'macos_build'])
          {
            'command': command,
            'status': 'passed',
            'exitCode': 0,
            'durationMs': 1,
            'outputSha256': sha(),
            'policySha256': sha('b'),
          },
        for (final purpose in ['regression', 'adjacent'])
          {
            'command': 'macos_test_focused',
            'purpose': purpose,
            'paths': ['apps/flutter/test/example/${purpose}_test.dart'],
            'status': 'passed',
            'exitCode': 0,
            'durationMs': 1,
            'outputSha256': sha(),
            'policySha256': sha('b'),
            'testSummary': {
              'totalTests': 2,
              'passedTests': 2,
              'failedTests': 0,
              'pendingTests': 0,
              'executedPaths': [
                'apps/flutter/test/example/${purpose}_test.dart',
              ],
              'success': true,
            },
          },
      ];
      expect(parse(raw).records('verification'), hasLength(1));
      final checks = verification['checks'] as List;
      (checks[2]['testSummary'] as Map)['pendingTests'] = 1;
      expect(() => parse(raw), throwsFormatException);
    },
  );
  test(
    'focused verification retains four exact checks and actual case counts',
    () {
      final raw = snapshotJson();
      final verification = (raw['verifications'] as List).single as Map;
      verification['checks'] = [
        for (final command in ['lint_focused', 'typecheck_direct'])
          {
            'command': command,
            'status': 'passed',
            'exitCode': 0,
            'durationMs': 1,
            'outputSha256': sha(),
            'policySha256': sha('b'),
          },
        for (final purpose in ['regression', 'adjacent'])
          {
            'command': 'test_focused',
            'purpose': purpose,
            'paths': ['src/$purpose.test.ts'],
            'status': 'passed',
            'exitCode': 0,
            'durationMs': 1,
            'outputSha256': sha(),
            'policySha256': sha('b'),
            'testSummary': {
              'totalTests': 2,
              'passedTests': 2,
              'failedTests': 0,
              'pendingTests': 0,
              'executedPaths': ['src/$purpose.test.ts'],
              'success': true,
            },
          },
      ];
      verification['browserEvidence'] = {
        'status': 'retired',
        'captures': [],
        'replacement': {
          'mode': 'deterministic',
          'version': 1,
          'phase': 'checkpoint',
          'status': 'passed',
          'summary': 'Focused checks passed',
          'signals': [
            for (final name in [
              'lint',
              'typecheck',
              'regression_tests',
              'adjacent_tests',
            ])
              {'name': name, 'status': 'passed'},
          ],
        },
      };
      expect(parse(raw).records('verification'), hasLength(1));
      final checks = verification['checks'] as List;
      (checks[2]['testSummary'] as Map)['passedTests'] = 1;
      expect(() => parse(raw), throwsFormatException);
    },
  );
  test('published public projection retains full exact IDs and freezes nested evidence', () {
    final raw = snapshotJson(), value = parse(raw);
    expect(value.session!.projectId, builderProject);
    expect(value.deliveryVerification!.id, buildId('verification'));
    expect(value.records('release').single.text('releaseDigest'), sha('d'));
    expect(
      () => value.records('release').single.object('logs')['status'] = 'failed',
      returnsNormally,
    );
    expect(
      value.records('release').single.object('logs')['status'],
      'captured',
    );
    expect(() => value.session!.raw['revision'] = 99, throwsUnsupportedError);
    (raw['releases'] as List).clear();
    expect(value.records('release'), hasLength(1));
  });
  test('empty state is distinct from missing bounded histories', () {
    expect(parse(snapshotJson(empty: true)).session, isNull);
    final raw = snapshotJson(empty: true)..remove('checkpoints');
    expect(() => parse(raw), throwsFormatException);
  });
  test('another project or session cannot enter the exact snapshot', () {
    final raw = snapshotJson();
    (raw['session'] as Map)['projectId'] = 'someone-else';
    expect(() => parse(raw), throwsFormatException);
    final other = snapshotJson();
    ((other['deployments'] as List).single as Map)['sessionId'] = buildId(
      'session',
      'b',
    );
    expect(() => parse(other), throwsFormatException);
  });
  test(
    'bounded histories reject duplicates, overflow and impossible revisions',
    () {
      for (final invalid in [
        snapshotJson()
          ..['deployments'] = [
            recordJson('deployment'),
            recordJson('deployment'),
          ],
        snapshotJson()
          ..['activity'] = List.generate(
            41,
            (index) => activityJson()..['id'] = 'event-$index',
          ),
        snapshotJson()..['session'] = sessionJson(revision: 0),
      ]) {
        expect(() => parse(invalid), throwsFormatException);
      }
    },
  );
  test(
    'newest matching BLOCK overrides older PASS; unrelated review does not',
    () {
      final raw = snapshotJson()
        ..['activity'] = [
          activityJson(verdict: 'blocked', char: 'b'),
          activityJson(),
        ];
      expect(parse(raw).deliveryVerification, isNull);
      ((raw['activity'] as List).first['detail'] as Map)['verificationId'] =
          buildId('verification', 'c');
      expect(parse(raw).deliveryVerification, isNotNull);
    },
  );
  test(
    'passing review must match the current checkpoint SHA as well as ID',
    () {
      final raw = snapshotJson();
      ((raw['checkpoints'] as List).single as Map)['workspaceSha256'] = sha(
        'c',
      );
      expect(parse(raw).deliveryVerification, isNull);
    },
  );
  test('removed explicit history ID never falls back to the first record', () {
    final value = parse(snapshotJson());
    expect(value.find('deployment', buildId('deployment', 'b')), isNull);
    expect(
      value.find('deployment', buildId('deployment'))?.id,
      buildId('deployment'),
    );
  });
  test(
    'complete exact file required; sliced or changed path cannot be edited',
    () {
      for (final raw in [
        fileJson(path: 'other.tsx'),
        fileJson()..['lineRange'] = {'truncated': true},
        fileJson()..['sha256'] = 'short',
      ]) {
        expect(
          () => BuilderFile.parse(raw, 'app/page.tsx'),
          throwsFormatException,
        );
      }
      expect(BuilderFile.parse(fileJson(), 'app/page.tsx').sha256, sha());
    },
  );
  test(
    'preview credentials never become an app-origin or non-HTTPS preview',
    () {
      for (final url in [
        'javascript:alert(1)',
        'http://example.test',
        'https://user:password@example.test',
        '$builderApi/preview',
        ' https://example.test',
      ]) {
        expect(parse(snapshotJson()..['previewUrl'] = url).preview, isNull);
      }
      expect(
        parse(snapshotJson()).preview!.queryParameters['token'],
        'do-not-persist',
      );
    },
  );
  test(
    'canonical UUID and exact known role are required independently of email',
    () {
      expect(
        BuilderOwner.fromSession(
          builderSession(user: 'owner@example.test'),
          builderApi,
        ),
        isNull,
      );
      for (final role in ['member', 'owner', 'Operator']) {
        expect(
          BuilderOwner.fromSession(builderSession(role: role), builderApi),
          isNull,
        );
      }
      expect(testBuilderOwner(role: 'viewer').canRun, isFalse);
      expect(
        testBuilderOwner(user: builderOtherUser).key,
        isNot(testBuilderOwner().key),
      );
      expect(
        testBuilderOwner(api: '$builderApi/other').key,
        isNot(testBuilderOwner().key),
      );
      expect(
        testBuilderOwner(role: 'viewer').key,
        isNot(testBuilderOwner().key),
      );
    },
  );
  test(
    'timestamps and hashes reject overflow rather than normalizing evidence',
    () {
      expect(
        builderDate('2024-02-29T13:00:00+05:30'),
        DateTime.utc(2024, 2, 29, 7, 30),
      );
      for (final date in [
        '2026-02-29T10:00:00Z',
        '2026-10-04T24:00:00Z',
        '2026-10-04T10:00:00',
        '2026-10-04T10:00:00+99:00',
      ]) {
        expect(() => builderDate(date), throwsFormatException);
      }
      expect(
        () => builderHash(repeated('a', 41), git: true),
        throwsFormatException,
      );
      expect(() => builderInt(9007199254740992), throwsFormatException);
    },
  );
  test('native actions refuse invented rollback, resume, forged review or incomplete preconditions', () {
    for (final action in [
      {'action': 'rollback'},
      {'action': 'resume', 'sessionId': buildId('session')},
      {'action': 'sentinel.record', 'verdict': 'passed'},
      {
        'action': 'file.update',
        'sessionId': buildId('session'),
        'path': 'app/page.tsx',
        'content': 'changed',
      },
      {
        'action': 'command.run',
        'sessionId': buildId('session'),
        'command': 'arbitrary shell',
      },
      {'action': 'create', 'ownerActorId': 'someone-else'},
    ]) {
      expect(() => validateBuilderAction(action), throwsFormatException);
    }
    expect(
      () => validateBuilderAction({
        'action': 'file.update',
        'sessionId': buildId('session'),
        'path': 'app/page.tsx',
        'content': 'changed',
        'expectedSha256': sha(),
      }),
      returnsNormally,
    );
  });
  test('recovered prepared request remains immutable and uncertain', () {
    final value = BuilderOutcome.parse({
      'key': 'prepared-request',
      'submitted': {'action': 'stop', 'sessionId': buildId('session')},
      'at': builderTime,
      'state': 'prepared',
    });
    expect(value.state, BuilderOutcomeState.uncertain);
    expect(
      () => value.submitted['sessionId'] = buildId('session', 'b'),
      throwsUnsupportedError,
    );
  });
}
