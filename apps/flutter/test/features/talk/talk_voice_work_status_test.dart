import 'package:asael/features/talk/talk.dart';
import 'package:flutter_test/flutter_test.dart';

const _thread = '11111111-1111-4111-8111-111111111111';

class _Repository extends Fake implements TalkRepository {
  late TalkWorkflowSnapshot workflow;
  final reads = <String>[];

  @override
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId) async {
    reads.add(workflowId);
    return workflow;
  }
}

void main() {
  test(
    'a report timeout remains paused with its exact recorded reason',
    () async {
      final repository = _Repository()
        ..workflow = TalkWorkflowSnapshot.fromJson({
          'run': {
            'id': 'wf_report',
            'status': 'paused',
            'currentStep': 'write_report',
            'error': 'AI request timed out after 180 seconds.',
            'approvalRequired': false,
            'input': {
              'metadata': {'threadId': _thread},
            },
          },
          'steps': [
            {
              'stepKey': 'research',
              'status': 'completed',
              'output': {
                'openQuestions': ['Which audience should we serve?'],
              },
            },
          ],
        });
      final controller = TalkController(repository)..threadId = _thread;
      addTearDown(controller.dispose);
      final result = await controller.inspectVoiceWork({
        'workflowId': 'wf_report',
        'runId': 'root',
      }, _thread);
      expect(result['status'], 'paused');
      expect(result['currentStep'], 'write_report');
      expect(
        result['failureReason'],
        'AI request timed out after 180 seconds.',
      );
      expect(
        result['message'],
        contains('Recorded reason: AI request timed out'),
      );
      expect(result['message'], isNot(contains('Which audience')));
      expect(result['message'], isNot(contains('needs your input')));
      expect(repository.reads, ['wf_report']);
    },
  );

  test('failure fallback belongs to the current step and exact workflow', () {
    final snapshot = TalkWorkflowSnapshot.fromJson({
      'run': {
        'id': 'wf_report',
        'status': 'paused',
        'currentStep': 'write_report',
      },
      'steps': [
        {
          'workflowRunId': 'wf_other',
          'stepKey': 'write_report',
          'status': 'failed',
          'error': 'Foreign error',
        },
        {
          'workflowRunId': 'wf_report',
          'stepKey': 'research',
          'status': 'failed',
          'error': 'Old error',
        },
        {
          'workflowRunId': 'wf_report',
          'stepKey': 'write_report',
          'status': 'failed',
          'error': 'Report timed out',
        },
      ],
    });
    expect(snapshot.error, 'Report timed out');
  });

  test(
    'a pause without a recorded reason does not invent a question',
    () async {
      final repository = _Repository()
        ..workflow = const TalkWorkflowSnapshot(
          id: 'wf_report',
          status: 'paused',
        );
      final controller = TalkController(repository)..threadId = _thread;
      addTearDown(controller.dispose);
      final result = await controller.inspectVoiceWork({
        'workflowId': 'wf_report',
      }, _thread);
      expect(result['status'], 'paused');
      expect(result['message'], contains('No reason is recorded.'));
      expect(result.containsKey('failureReason'), false);
    },
  );
}
