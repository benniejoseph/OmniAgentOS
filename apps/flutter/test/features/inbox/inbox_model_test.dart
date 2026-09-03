import 'package:flutter_test/flutter_test.dart';
import 'package:asael/features/inbox/inbox.dart';

void main() {
  test('decodes unified approval queue', () {
    final queue = ApprovalQueue.fromJson({
      'items': [
        {
          'id': 'a1',
          'kind': 'workflow',
          'title': 'Deploy',
          'status': 'waiting_approval',
          'riskLevel': 3,
          'input': {'target': 'prod'},
        },
      ],
      'stats': {'tools': 0, 'workflows': 1, 'sloPolicies': 0},
    });
    expect(queue.items.single.riskLevel, 3);
    expect(queue.workflows, 1);
  });
}
