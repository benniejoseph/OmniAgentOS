import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/today/macos_today_view.dart';
import 'package:asael/features/today/today.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _TodayRepository implements TodayRepository {
  _TodayRepository()
    : items = [
        TodayItem(
          id: 'focus-1',
          title: 'Review the release evidence',
          kind: 'task',
          priority: TodayPriority.high,
          status: 'open',
          dueAt: DateTime.now().add(const Duration(hours: 2)),
        ),
        const TodayItem(
          id: 'focus-2',
          title: 'Archive the accepted proposal',
          kind: 'task',
          priority: TodayPriority.low,
          status: 'done',
        ),
      ];

  List<TodayItem> items;
  String? createdTitle;
  TodayPriority? createdPriority;

  @override
  Future<TodaySnapshot> load() async => TodaySnapshot(
    items: items,
    brief: DailyBrief(
      summary: 'Resolve the release review before starting new work.',
      focus: const [
        (title: 'Review evidence', reason: 'The release is waiting on it.'),
      ],
      watchouts: const ['One approval is still unresolved.'],
      generatedAt: DateTime.now().subtract(const Duration(minutes: 8)),
    ),
    threads: const [(id: 'thread-1', title: 'Release readiness')],
    projects: const [
      (id: 'project-1', title: 'Asael macOS', completed: 6, total: 8),
    ],
  );

  @override
  Future<TodayItem> create({
    required String title,
    String kind = 'task',
    TodayPriority priority = TodayPriority.medium,
    DateTime? dueAt,
  }) async {
    createdTitle = title;
    createdPriority = priority;
    final item = TodayItem(
      id: 'focus-new',
      title: title,
      kind: kind,
      priority: priority,
      status: 'open',
      dueAt: dueAt,
    );
    items = [item, ...items];
    return item;
  }

  @override
  Future<DailyBrief?> generateBrief({bool force = false}) async =>
      (await load()).brief;

  @override
  Future<TodayItem> update(String id, Json changes) async {
    final current = items.firstWhere((item) => item.id == id);
    final updated = TodayItem(
      id: current.id,
      title: current.title,
      kind: current.kind,
      priority: current.priority,
      status: changes['status'] as String? ?? current.status,
      reminderState: current.reminderState,
      dueAt: current.dueAt,
      updatedAt: DateTime.now(),
    );
    items = items.map((item) => item.id == id ? updated : item).toList();
    return updated;
  }
}

void main() {
  testWidgets('renders a desktop operating board and persistent context', (
    tester,
  ) async {
    await _useDesktopViewport(tester);
    final repository = _TodayRepository();
    final controller = TodayController(repository);
    await controller.refresh();

    await tester.pumpWidget(_app(MacosTodayView(controller: controller)));
    await tester.pumpAndSettle();

    expect(find.text('Focus list'), findsOneWidget);
    expect(find.text('Daily brief'), findsOneWidget);
    expect(find.text('Active projects'), findsOneWidget);
    expect(find.text('Recent conversations'), findsOneWidget);
    expect(find.text('Review the release evidence'), findsOneWidget);
    expect(find.byKey(const Key('macos-today-inspector')), findsOneWidget);

    await tester.tap(find.byType(Checkbox).first);
    await tester.pumpAndSettle();
    expect(
      repository.items.firstWhere((item) => item.id == 'focus-1').isDone,
      isTrue,
    );
  });

  testWidgets('adds focus through the shared Today controller', (tester) async {
    await _useDesktopViewport(tester);
    final repository = _TodayRepository();
    final controller = TodayController(repository);
    await controller.refresh();
    await tester.pumpWidget(_app(MacosTodayView(controller: controller)));

    await tester.tap(find.byKey(const Key('macos-today-add')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('macos-today-add-title')),
      'Prepare the owner update',
    );
    await tester.tap(find.byKey(const Key('macos-today-add-submit')));
    await tester.pumpAndSettle();

    expect(repository.createdTitle, 'Prepare the owner update');
    expect(repository.createdPriority, TodayPriority.medium);
    expect(find.text('Prepare the owner update'), findsOneWidget);
  });
}

Widget _app(Widget child) =>
    MaterialApp(theme: MacosAppTheme.light(), home: child);

Future<void> _useDesktopViewport(WidgetTester tester) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1440, 900);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
}
