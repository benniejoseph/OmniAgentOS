import 'package:asael/features/results/result_projection.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'run projection preserves executing Agent, full key, output and evidence',
    () {
      final prose = List.filled(
        40,
        'Exact full output and source context.',
      ).join('\n');
      final item = ParsedResult.agent({
        'id': 'run:exact/東京+id%2F',
        'prompt': 'Reviewed goal',
        'status': 'completed',
        'response': prose,
        'agentId': 'sentinel',
        'threadId': 'thread:exact/full',
        'grounding': {
          'status': 'verified',
          'citations': [
            {
              'sourceId': 'source:exact',
              'url': 'https://synthetic.invalid/source',
              'quote': prose,
            },
          ],
        },
      });
      expect(item.key.value, 'agent:run:exact/東京+id%2F');
      expect(item.body, prose);
      expect(item.meta, contains('sentinel'));
      expect(item.canonical, isNull);
      expect(item.grounding, 'verified');
      expect(item.metadata['Conversation ID'], 'thread:exact/full');
      expect(item.evidence.single, contains('source:exact'));
      expect(item.evidence.single, contains('Exact full output'));
    },
  );
  test('workflow summary report and exact-detail nested report both remain available', () {
    final summary = ParsedResult.workflow({
      'id': 'workflow:one',
      'goal': 'Reviewed workflow',
      'status': 'completed',
      'report': 'Returned summary report',
    });
    final detail = ParsedResult.workflow({
      'id': 'workflow:one',
      'goal': 'Reviewed workflow',
      'status': 'completed',
      'result': {
        'report': 'Full report',
        'verification': {'status': 'verified'},
        'evidenceRefs': ['evidence:exact/full'],
      },
    });
    expect(summary.body, 'Returned summary report');
    expect(detail.body, 'Full report');
    expect(detail.evidence, ['evidence:exact/full']);
    expect(detail.canonical, isNull);
  });
  test('approval identity includes an exact separate kind without rewriting the canonical key', () {
    final approval = ParsedResult.approval({
      'id': 'shared:identity',
      'kind': 'slo_policy',
      'title': 'Review policy',
      'status': 'pending',
      'reason': 'Full reviewed rationale',
      'requestedBy': 'actor:exact',
    });
    expect(approval.key.value, 'approval:shared:identity');
    expect(approval.approvalKind, 'slo_policy');
    expect(approval.metadata['Requesting actor ID'], 'actor:exact');
    expect(
      () => ParsedResult.approval({
        'id': 'shared:identity',
        'title': 'No kind',
        'status': 'pending',
      }),
      throwsFormatException,
    );
  });
  for (final kind in ['tool', 'workflow', 'slo_policy']) {
    test(
      '$kind approval accepts its numeric transport risk and exact canonical domain',
      () {
        final domain = kind == 'slo_policy' ? 'slo_policy_change' : 'approval';
        for (var risk = 0; risk <= 3; risk++) {
          final approval = ParsedResult.approval({
            'id': 'shared:identity',
            'kind': kind,
            'title': 'Review exact request',
            'status': 'pending',
            'riskLevel': risk,
            'canonicalStatus': {
              'schemaVersion': 1,
              'domain': domain,
              'status': 'waiting',
              'basis': 'legacy_status',
              'source': 'legacy_adapter',
              'sourceStatus': 'pending',
              'verificationState': 'unassessed',
            },
          });
          expect(approval.meta, '$kind · risk $risk');
          expect(approval.metadata['Risk'], '$risk');
          expect(approval.canonical!.status, 'waiting');
        }
        final base = <String, dynamic>{
          'id': 'one',
          'kind': kind,
          'title': 'Review request',
          'status': 'pending',
        };
        for (final malformed in [-1, 4, 1.5, '2', true]) {
          expect(
            () => ParsedResult.approval({...base, 'riskLevel': malformed}),
            throwsFormatException,
          );
        }
        expect(
          () => ParsedResult.approval({
            ...base,
            'canonicalStatus': {
              'schemaVersion': 1,
              'domain': kind == 'slo_policy' ? 'approval' : 'slo_policy_change',
              'status': 'waiting',
              'basis': 'legacy_status',
              'source': 'legacy_adapter',
              'sourceStatus': 'pending',
              'verificationState': 'unassessed',
            },
          }),
          throwsFormatException,
        );
      },
    );
  }
  test('malformed required fields cannot turn into an unknown or fabricated healthy row', () {
    final base = <String, dynamic>{
      'id': 'run-one',
      'prompt': 'Reviewed run',
      'status': 'completed',
    };
    for (final row in [
      {...base, 'id': 12},
      {
        ...base,
        'status': ['completed'],
      },
      {...base, 'prompt': null},
      {
        ...base,
        'grounding': {'status': 'verified', 'citations': 'not-an-array'},
      },
      {...base, 'completedAt': 'yesterday'},
    ]) {
      expect(() => ParsedResult.agent(row), throwsFormatException);
    }
  });
  test('canceled and active output absence are described without invented final output', () {
    final canceled = ParsedResult.agent({
      'id': 'run-one',
      'prompt': 'Reviewed run',
      'status': 'canceled',
    });
    final pending = ParsedResult.workflow({
      'id': 'workflow-one',
      'goal': 'Reviewed workflow',
      'status': 'waiting_approval',
    });
    expect(canceled.body, 'No result text was returned for this stored run.');
    expect(pending.body, 'No final report has been returned yet.');
  });
}
