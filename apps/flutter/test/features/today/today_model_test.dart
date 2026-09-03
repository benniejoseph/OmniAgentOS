import 'package:flutter_test/flutter_test.dart';
import 'package:omniagent/features/today/today.dart';

void main() {
  test('decodes composite today snapshot safely', () {
    final snapshot = TodaySnapshot.fromJson({
      'items': [
        {
          'id': '1',
          'title': 'Ship',
          'kind': 'task',
          'priority': 'high',
          'status': 'open',
          'reminderState': 'due_soon',
        },
      ],
      'brief': {
        'summary': 'Make progress',
        'focus': [
          {'title': 'Ship', 'reason': 'Due'},
        ],
        'watchouts': ['Time'],
        'generatedAt': '2026-08-27T00:00:00Z',
      },
      'threads': [],
      'projects': [],
    });
    expect(snapshot.items.single.priority, TodayPriority.high);
    expect(snapshot.brief!.focus.single.title, 'Ship');
  });
}
