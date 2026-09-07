import 'package:flutter_test/flutter_test.dart';
import 'package:asael/features/today/today.dart';

class _TodayRepository implements TodayRepository {
  var failUpdate = false;
  final item = const TodayItem(
    id: 'item-1',
    title: 'Ship',
    kind: 'task',
    priority: TodayPriority.high,
    status: 'open',
  );

  @override
  Future<TodaySnapshot> load() async =>
      TodaySnapshot(items: [item], threads: const [], projects: const []);

  @override
  Future<TodayItem> create({
    required String title,
    String kind = 'task',
    TodayPriority priority = TodayPriority.medium,
    DateTime? dueAt,
  }) async => item;

  @override
  Future<DailyBrief?> generateBrief({bool force = false}) async => null;

  @override
  Future<TodayItem> update(String id, Json changes) async {
    if (failUpdate) throw StateError('offline');
    return item;
  }
}

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

  test('keeps the last Today projection when an action fails', () async {
    final repository = _TodayRepository();
    final controller = TodayController(repository);
    await controller.refresh();
    repository.failUpdate = true;

    await controller.toggle(repository.item);

    expect(controller.snapshot?.items.single.title, 'Ship');
    expect(controller.error, isA<StateError>());
    expect(controller.updating, isEmpty);
  });
}
