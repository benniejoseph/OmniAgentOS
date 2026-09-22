import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/agents/agent_governance.dart';
import 'package:asael/features/agents/agent_governance_view.dart';
import 'package:asael/features/agents/agents_api_repository.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

const _shaA =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _shaB =
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const _shaC =
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

void main() {
  test(
    'loads exact release and correction-backed adaptation evidence',
    () async {
      final api = _GovernanceApiClient();
      final repository = ApiAgentsRepository(api);

      final snapshot = await repository.loadGovernance('agent/one');

      expect(snapshot.release.agentId, 'agent/one');
      expect(snapshot.release.activeDefinitionVersion, 1);
      expect(snapshot.release.candidateEvaluation?.verdict, 'passed');
      expect(snapshot.definitionVersion, 2);
      expect(snapshot.adaptations.single.authorityImpact, 'none');
      expect(snapshot.adaptations.single.evidenceCount, 1);
      expect(api.freshReads, {
        NativePaths.agentsReleaseShow('agent/one'),
        NativePaths.agentsAdaptationsList('agent/one'),
      });
    },
  );

  test('permits bounded lifecycle actions and refuses retirement', () async {
    final api = _GovernanceApiClient();
    final repository = ApiAgentsRepository(api);

    await repository.manageRelease('agent/one', const {
      'action': 'evaluate',
      'definitionVersion': 2,
    }, idempotencyKey: 'release-evaluate-one');
    expect(api.posts.single.path, NativePaths.agentsReleaseManage('agent/one'));
    expect(api.posts.single.headers, {
      'idempotency-key': 'release-evaluate-one',
    });

    await repository.manageAdaptation('agent/one', const {
      'action': 'activate',
      'adaptationId': 'adaptation-one',
    }, idempotencyKey: 'adaptation-activate-one');
    expect(
      api.posts.last.path,
      NativePaths.agentsAdaptationsManage('agent/one'),
    );

    await expectLater(
      repository.manageRelease('agent/one', const {
        'action': 'retire',
      }, idempotencyKey: 'forbidden-retire'),
      throwsFormatException,
    );
    expect(api.posts, hasLength(2));
  });

  test('fails closed on malformed release or adaptation digests', () {
    final badRelease = _releaseResponse();
    final release = Map<String, dynamic>.from(badRelease['release']! as Map)
      ..['candidateEvaluation'] = {
        ...Map<String, dynamic>.from(
          (badRelease['release']! as Map)['candidateEvaluation']! as Map,
        ),
        'evaluationSha256': 'not-a-digest',
      };
    expect(
      () => AgentReleaseProjection.fromResponse({'release': release}),
      throwsFormatException,
    );

    final adaptation = Map<String, dynamic>.from(
      (_adaptationResponse()['adaptations']! as List).single as Map,
    )..['confidence'] = 2;
    expect(
      () => AgentAdaptationProjection.fromJson(
        adaptation,
        expectedAgentId: 'agent/one',
        expectedDefinitionVersion: 2,
      ),
      throwsFormatException,
    );
    expect(
      () => AgentAdaptationProjection.listFromResponse({
        'definitionVersion': 2,
        'adaptations': ['malformed'],
      }, expectedAgentId: 'agent/one'),
      throwsFormatException,
    );
  });

  test('release channel rejects malformed exact transition coordinates', () {
    final unordered = _releaseResponse();
    final unorderedRelease = unordered['release']! as Map<String, dynamic>;
    unorderedRelease['versions'] = List<Object?>.from(
      unorderedRelease['versions']! as List,
    ).reversed.toList();
    expect(
      () => AgentReleaseProjection.fromResponse(unordered),
      throwsFormatException,
    );

    final missingLatest = _releaseResponse();
    final missingLatestRelease =
        missingLatest['release']! as Map<String, dynamic>;
    missingLatestRelease['versions'] = [
      (missingLatestRelease['versions']! as List).first,
    ];
    expect(
      () => AgentReleaseProjection.fromResponse(missingLatest),
      throwsFormatException,
    );

    final malformedEvaluation = _releaseResponse();
    final malformedRelease =
        malformedEvaluation['release']! as Map<String, dynamic>;
    final malformed =
        Map<String, dynamic>.from(
            (malformedRelease['evaluations']! as List).single as Map,
          )
          ..['evaluationId'] = 'evaluation-one'
          ..['changedFields'] = <String>[];
    malformedRelease['evaluations'] = [malformed];
    malformedRelease['candidateEvaluation'] = malformed;
    expect(
      () => AgentReleaseProjection.fromResponse(malformedEvaluation),
      throwsFormatException,
    );
  });

  test('adaptations reject authority and lifecycle drift', () {
    Map<String, dynamic> adaptation() => Map<String, dynamic>.from(
      (_adaptationResponse()['adaptations']! as List).single as Map,
    );

    final broadened = adaptation();
    broadened['effect'] = {
      ...Map<String, dynamic>.from(broadened['effect']! as Map),
      'authorityImpact': 'expanded',
    };
    expect(
      () => AgentAdaptationProjection.fromJson(
        broadened,
        expectedAgentId: 'agent/one',
        expectedDefinitionVersion: 2,
      ),
      throwsFormatException,
    );

    final invalidRevision = adaptation()..['lifecycleRevision'] = 2;
    expect(
      () => AgentAdaptationProjection.fromJson(
        invalidRevision,
        expectedAgentId: 'agent/one',
        expectedDefinitionVersion: 2,
      ),
      throwsFormatException,
    );

    final invalidActivation = adaptation()
      ..['state'] = 'active'
      ..['lifecycleRevision'] = 2
      ..['evaluation'] = {
        ...Map<String, dynamic>.from(adaptation()['evaluation']! as Map),
        'verdict': 'held',
      };
    expect(
      () => AgentAdaptationProjection.fromJson(
        invalidActivation,
        expectedAgentId: 'agent/one',
        expectedDefinitionVersion: 2,
      ),
      throwsFormatException,
    );

    expect(
      () => AgentAdaptationProjection.fromJson(
        adaptation(),
        expectedAgentId: 'agent/two',
        expectedDefinitionVersion: 2,
      ),
      throwsFormatException,
    );
    expect(
      () => AgentAdaptationProjection.fromJson(
        adaptation(),
        expectedAgentId: 'agent/one',
        expectedDefinitionVersion: 1,
      ),
      throwsFormatException,
    );
    final historical = AgentAdaptationProjection.listFromResponse({
      'definitionVersion': 3,
      'adaptations': [adaptation()],
    }, expectedAgentId: 'agent/one');
    expect(historical.definitionVersion, 3);
    expect(historical.items.single.observedDefinitionVersion, 2);
  });

  testWidgets(
    'holds historical adaptation advancement but allows active rollback',
    (tester) async {
      tester.view.physicalSize = const Size(800, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final evaluated = AgentAdaptationProjection.fromJson(
        (_adaptationResponse()['adaptations']! as List).single
            as Map<String, dynamic>,
        expectedAgentId: 'agent/one',
        expectedDefinitionVersion: 3,
      );
      final activeJson =
          Map<String, dynamic>.from(
              (_adaptationResponse()['adaptations']! as List).single as Map,
            )
            ..['adaptationId'] = 'agent-adaptation:$_shaC'
            ..['state'] = 'active'
            ..['lifecycleRevision'] = 2;
      final active = AgentAdaptationProjection.fromJson(
        activeJson,
        expectedAgentId: 'agent/one',
        expectedDefinitionVersion: 3,
      );
      final snapshot = AgentGovernanceSnapshot(
        release: AgentReleaseProjection.fromResponse(
          _rollbackReleaseResponse(),
        ),
        definitionVersion: 3,
        adaptations: [evaluated, active],
      );
      AgentGovernanceJson? action;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: AgentGovernanceView(
                agentId: 'agent/one',
                builtIn: false,
                canRead: true,
                canManage: true,
                load: () async => snapshot,
                manageRelease: (_) async => snapshot,
                manageAdaptation: (value) async {
                  action = value;
                  return snapshot;
                },
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Activate guidance'), findsNothing);
      final rollback = find.text('Roll back');
      expect(rollback, findsOneWidget);
      await tester.ensureVisible(rollback);
      await tester.tap(rollback);
      await tester.pumpAndSettle();
      expect(action, {
        'action': 'rollback',
        'adaptationId': 'agent-adaptation:$_shaC',
      });
    },
  );

  testWidgets(
    'acts on an exact rollback evaluation even when latest is already active',
    (tester) async {
      tester.view.physicalSize = const Size(800, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final release = AgentReleaseProjection.fromResponse(
        _rollbackReleaseResponse(),
      );
      final snapshot = AgentGovernanceSnapshot(
        release: release,
        definitionVersion: 3,
        adaptations: const [],
      );
      AgentGovernanceJson? action;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: AgentGovernanceView(
                agentId: 'agent-one',
                builtIn: false,
                canRead: true,
                canManage: true,
                load: () async => snapshot,
                manageRelease: (value) async {
                  action = value;
                  return snapshot;
                },
                manageAdaptation: (_) async => snapshot,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Rollback v3 → v1'), findsOneWidget);
      expect(find.text('definition:custom:agent-one:v3'), findsWidgets);
      expect(find.text('definition:custom:agent-one:v1'), findsWidgets);
      expect(find.text(_shaB), findsWidgets);
      expect(find.text(_shaA), findsWidgets);
      final rollback = find.text('Roll back exact version');
      await tester.ensureVisible(rollback);
      await tester.tap(rollback);
      await tester.pumpAndSettle();

      expect(action, {
        'action': 'rollback',
        'evaluationId': 'agent-release-evaluation:$_shaB',
      });
      expect(
        find.textContaining('Retirement is intentionally unavailable'),
        findsOneWidget,
      );
    },
  );
}

class _GovernanceApiClient extends ApiClient {
  _GovernanceApiClient()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  final freshReads = <String>{};
  final posts = <_Call>[];

  @override
  Future<Map<String, dynamic>> getJsonFresh(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    freshReads.add(path);
    return path.endsWith('/release')
        ? _releaseResponse()
        : _adaptationResponse();
  }

  @override
  Future<Map<String, dynamic>> postJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    posts.add(_Call(path, data, headers));
    return const {};
  }
}

class _Call {
  const _Call(this.path, this.data, this.headers);
  final String path;
  final Map<String, dynamic>? data, headers;
}

Map<String, dynamic> _releaseResponse() {
  final evaluation = {
    'evaluationId': 'agent-release-evaluation:$_shaA',
    'definitionVersion': 2,
    'definitionVersionId': 'definition:custom:agent/one:v2',
    'definitionSha256': _shaA,
    'baselineDefinitionVersion': 1,
    'baselineDefinitionVersionId': 'definition:custom:agent/one:v1',
    'baselineDefinitionSha256': _shaB,
    'direction': 'promotion',
    'changedFields': ['instructions'],
    'verdict': 'passed',
    'evaluationSha256': _shaC,
    'evaluatedAt': '2026-09-22T09:00:00.000Z',
  };
  return {
    'release': {
      'agentId': 'agent/one',
      'state': 'active',
      'releaseRevision': 1,
      'activeDefinitionVersion': 1,
      'activeDefinitionVersionId': 'definition:custom:agent/one:v1',
      'latestDefinitionVersion': 2,
      'latestDefinitionVersionId': 'definition:custom:agent/one:v2',
      'versions': [
        {
          'definitionVersion': 1,
          'definitionVersionId': 'definition:custom:agent/one:v1',
          'publishedAt': '2026-09-21T09:00:00.000Z',
          'active': true,
        },
        {
          'definitionVersion': 2,
          'definitionVersionId': 'definition:custom:agent/one:v2',
          'publishedAt': '2026-09-22T08:00:00.000Z',
          'active': false,
        },
      ],
      'evaluations': [evaluation],
      'candidateEvaluation': evaluation,
      'updatedAt': '2026-09-22T09:00:00.000Z',
    },
  };
}

Map<String, dynamic> _adaptationResponse() => {
  'definitionVersion': 2,
  'adaptations': [
    {
      'adaptationId': 'agent-adaptation:$_shaB',
      'agentId': 'agent/one',
      'state': 'evaluated',
      'lifecycleRevision': 1,
      'observedDefinitionVersion': 2,
      'confidence': .84,
      'effect': {
        'guidance': 'Prefer exact evidence before summarizing.',
        'guidanceSha256': _shaA,
        'effectSha256': _shaB,
        'authorityImpact': 'none',
      },
      'evidenceSha256': _shaC,
      'evidence': [
        {'correctionId': 'correction-one'},
      ],
      'evaluation': {
        'definitionVersion': 2,
        'verdict': 'passed',
        'evaluationSha256': _shaA,
      },
      'updatedAt': '2026-09-22T09:30:00.000Z',
    },
  ],
};

Map<String, dynamic> _rollbackReleaseResponse() => {
  'release': {
    'agentId': 'agent-one',
    'state': 'active',
    'releaseRevision': 4,
    'activeDefinitionVersion': 3,
    'activeDefinitionVersionId': 'definition:custom:agent-one:v3',
    'latestDefinitionVersion': 3,
    'latestDefinitionVersionId': 'definition:custom:agent-one:v3',
    'versions': [
      for (var version = 1; version <= 3; version += 1)
        {
          'definitionVersion': version,
          'definitionVersionId': 'definition:custom:agent-one:v$version',
          'publishedAt': '2026-09-2${version}T08:00:00.000Z',
          'active': version == 3,
        },
    ],
    'evaluations': [
      {
        'evaluationId': 'agent-release-evaluation:$_shaB',
        'definitionVersion': 1,
        'definitionVersionId': 'definition:custom:agent-one:v1',
        'definitionSha256': _shaA,
        'baselineDefinitionVersion': 3,
        'baselineDefinitionVersionId': 'definition:custom:agent-one:v3',
        'baselineDefinitionSha256': _shaB,
        'direction': 'rollback',
        'changedFields': ['instructions'],
        'verdict': 'passed',
        'evaluationSha256': _shaC,
        'evaluatedAt': '2026-09-22T11:00:00.000Z',
      },
    ],
    'candidateEvaluation': null,
    'updatedAt': '2026-09-22T11:00:00.000Z',
  },
};
