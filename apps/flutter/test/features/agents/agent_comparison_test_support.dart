import 'package:asael/features/agents/agent_governance.dart';

const comparisonShaA =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const comparisonShaB =
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const comparisonShaC =
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const comparisonAdaptationId = 'agent-adaptation:$comparisonShaB';

Map<String, dynamic> comparisonSuite() => {
  'cases': [
    for (var i = 1; i <= 3; i++)
      {
        'id': 'case-$i',
        'task': 'Summarize the next step for project $i.',
        'assertions': {
          'allOf': ['next step'],
          'noneOf': ['guaranteed'],
          'minLength': 1,
          'maxLength': 8000,
        },
      },
  ],
};

Map<String, dynamic> comparisonReceipt({
  String verdict = 'improved',
  DateTime? completedAt,
  bool unknownCost = false,
}) {
  final completed =
      completedAt ??
      DateTime.now().toUtc().subtract(const Duration(minutes: 1));
  Map<String, dynamic> observation(bool passed, {bool incomplete = false}) => {
    'status': incomplete ? 'failed' : 'completed',
    'output': incomplete
        ? null
        : passed
        ? 'Next step: inspect the evidence.'
        : 'A generic summary.',
    'costUsd': unknownCost || incomplete ? null : 0.01,
    'failure': incomplete ? 'model_failed' : null,
  };
  final beforePasses = verdict == 'regressed',
      afterPasses = verdict == 'improved' || verdict == 'incomplete';
  return {
    'version': 'agent-text-comparison:1',
    'scorerVersion': 'literal-output-assertions:1',
    'comparisonId': '11111111-1111-4111-8111-111111111111',
    'adaptationId': comparisonAdaptationId,
    'suite': comparisonSuite(),
    'suiteSha256': comparisonShaA,
    'pins': {
      'definitionVersion': 2,
      'definitionSha256': comparisonShaA,
      'principalSha256': comparisonShaA,
      'baselineGuidanceSha256': comparisonShaA,
      'candidateEffectSha256': comparisonShaB,
      'promptContractVersion': 'test-prompt:1',
      'baselineInstructionsSha256': comparisonShaA,
      'candidateInstructionsSha256': comparisonShaC,
      'runtime': {
        'provider': 'openai',
        'model': 'owner-selected-model',
        'tier': 'fast',
        'source': 'deployment_environment',
        'assignmentId': null,
        'assignmentRevision': null,
        'assignmentConfigurationSha256': null,
      },
      'clock': completed
          .subtract(const Duration(seconds: 10))
          .toIso8601String(),
      'mode': 'orchestrate',
      'environment': 'text_only_no_tools_memory_or_retrieval',
      'maxOutputTokens': 1000,
      'maxCalls': 6,
      'timeoutMs': 120000,
    },
    'results': [
      for (var i = 1; i <= 3; i++)
        {
          'caseId': 'case-$i',
          'baseline': observation(beforePasses),
          'candidate': observation(
            afterPasses,
            incomplete: verdict == 'incomplete' && i == 3,
          ),
          'baselinePassed': beforePasses,
          'candidatePassed':
              afterPasses && !(verdict == 'incomplete' && i == 3),
        },
    ],
    'verdict': verdict,
    'baselinePassed': beforePasses ? 3 : 0,
    'candidatePassed': verdict == 'incomplete'
        ? 2
        : afterPasses
        ? 3
        : 0,
    'costUsd': unknownCost || verdict == 'incomplete' ? null : 0.06,
    'completedAt': completed.toIso8601String(),
    'comparisonSha256': comparisonShaC,
  };
}

Map<String, dynamic> comparisonAdaptation({Map<String, dynamic>? comparison}) =>
    {
      'adaptationId': comparisonAdaptationId,
      'agentId': 'agent/one',
      'state': 'evaluated',
      'lifecycleRevision': 1,
      'observedDefinitionVersion': 2,
      'confidence': .84,
      'effect': {
        'guidance': 'Prefer exact evidence before summarizing.',
        'guidanceSha256': comparisonShaA,
        'effectSha256': comparisonShaB,
        'authorityImpact': 'none',
      },
      'evidenceSha256': comparisonShaC,
      'evidence': [
        {'correctionId': 'correction-one'},
      ],
      'evaluation': {
        'definitionVersion': 2,
        'verdict': 'passed',
        'evaluationSha256': comparisonShaA,
      },
      'updatedAt': '2026-09-22T09:30:00.000Z',
      'comparison': ?comparison,
    };

AgentAdaptationProjection comparisonProjection({
  String verdict = 'improved',
  DateTime? completedAt,
  bool missing = false,
}) => AgentAdaptationProjection.fromJson(
  comparisonAdaptation(
    comparison: missing
        ? null
        : comparisonReceipt(verdict: verdict, completedAt: completedAt),
  ),
  expectedAgentId: 'agent/one',
  expectedDefinitionVersion: 2,
);
