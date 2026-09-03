import 'package:flutter_test/flutter_test.dart';
import 'package:asael/features/missions/missions.dart';

void main() {
  test('decodes public mission detail projection', () {
    final detail = MissionDetail.fromJson({
      'mission': {
        'id': 'm1',
        'title': 'Launch',
        'objective': 'Ship safely',
        'status': 'running',
        'priority': 'high',
      },
      'tasks': [
        {
          'id': 't1',
          'title': 'Verify',
          'status': 'pending',
          'definitionOfDone': 'Tests green',
        },
      ],
      'attempts': [],
      'artifacts': [],
    });
    expect(detail.mission.terminal, isFalse);
    expect(detail.tasks.single.definitionOfDone, 'Tests green');
  });
}
