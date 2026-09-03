import 'package:flutter_test/flutter_test.dart';
import 'package:omniagent/features/results/results.dart';

void main() {
  test('agent result exposes grounding evidence and cancel state', () {
    final result = ResultItem.agent({
      'id': 'run-1',
      'prompt': 'Research the market',
      'status': 'running',
      'response': 'Working',
      'grounding': {
        'status': 'verified',
        'citations': [
          {'url': 'https://example.test/source'},
        ],
      },
    });
    expect(result.key, 'agent:run-1');
    expect(result.canCancel, isTrue);
    expect(result.verified, isTrue);
    expect(result.evidence, ['https://example.test/source']);
    expect(result.tone, ResultTone.warning);
  });

  test('workflow result reads nested report and verification', () {
    final result = ResultItem.workflow({
      'id': 'w1',
      'goal': 'Deploy',
      'status': 'completed',
      'result': {
        'report': 'Deployment complete',
        'verification': {'status': 'verified'},
        'evidenceRefs': ['deploy:42'],
      },
    });
    expect(result.body, 'Deployment complete');
    expect(result.tone, ResultTone.success);
    expect(result.verified, isTrue);
  });
}
