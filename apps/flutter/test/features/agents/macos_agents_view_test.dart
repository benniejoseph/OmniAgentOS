import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/agents/agents.dart';
import 'package:asael/features/agents/macos_agents_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _AgentsRepository implements AgentsRepository {
  @override
  Future<AgentLedger> load() async => const AgentLedger(
    agents: [_atlas, _mnemosyne],
    skills: [_research, _memory],
    performance: [_atlasPerformance, _memoryPerformance],
  );

  @override
  Future<void> deleteAgent(String id) async {}

  @override
  Future<void> deleteSkill(String id) async {}

  @override
  Future<AgentProfile> saveAgent(Json input, {String? id}) async =>
      AgentProfile.fromJson({'id': id ?? 'new', ...input});

  @override
  Future<AgentSkill> saveSkill(Json input, {String? id}) async =>
      AgentSkill.fromJson({'id': id ?? 'new', ...input});
}

const _atlas = AgentProfile(
  id: 'atlas',
  name: 'Atlas',
  role: 'Research coordinator',
  description: 'Plans research and delegates bounded work.',
  instructions: 'Prefer current primary sources and preserve evidence.',
  status: 'ready',
  accent: 'emerald',
  modelPolicy: 'reasoning_primary',
  autonomy: 'governed',
  approvalPolicy: 'risk_based',
  memoryScope: 'all',
  skillIds: ['research'],
  toolIds: ['web.search'],
  builtIn: true,
  manageable: false,
);

const _mnemosyne = AgentProfile(
  id: 'mnemosyne',
  name: 'Mnemosyne',
  role: 'Memory steward',
  description: 'Monitors durable memory and relationship quality.',
  instructions: 'Review contradictions and preserve provenance.',
  status: 'learning',
  accent: 'amber',
  modelPolicy: 'auto',
  autonomy: 'assist',
  approvalPolicy: 'always',
  memoryScope: 'all',
  skillIds: ['memory'],
  toolIds: [],
);

const _research = AgentSkill(
  id: 'research',
  name: 'Deep research',
  description: 'Collects and reconciles current evidence.',
  category: 'research',
  status: 'active',
  instructions: 'Use primary sources and cite observed claims.',
  toolIds: ['web.search'],
  tags: ['evidence'],
  builtIn: true,
  manageable: false,
);

const _memory = AgentSkill(
  id: 'memory',
  name: 'Memory stewardship',
  description: 'Reviews durable memory quality.',
  category: 'memory',
  status: 'active',
  instructions: 'Detect contradictions and preserve claim lineage.',
  toolIds: ['memory.inspect'],
  tags: ['memory'],
);

const _atlasPerformance = AgentPerformance(
  id: 'atlas',
  name: 'Atlas',
  runs: 28,
  successRate: .93,
  averageLatencyMs: 1400,
  memoriesFormed: 8,
);

const _memoryPerformance = AgentPerformance(
  id: 'mnemosyne',
  name: 'Mnemosyne',
  runs: 17,
  successRate: .88,
  averageLatencyMs: 920,
  memoriesFormed: 21,
);

void main() {
  testWidgets('uses a searchable agent roster with persistent policy detail', (
    tester,
  ) async {
    await _useDesktopViewport(tester);
    final controller = AgentsController(
      _AgentsRepository(),
      canManage: true,
      mutationsAvailable: true,
    );
    await controller.refresh();

    await tester.pumpWidget(_app(MacosAgentsView(controller: controller)));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('macos-agents-inspector')), findsOneWidget);
    expect(find.byType(FloatingActionButton), findsNothing);
    expect(find.text('Agent and role'), findsOneWidget);
    expect(find.text('Risk Based'), findsOneWidget);
    expect(find.text('93%'), findsOneWidget);

    await tester.tap(find.byKey(const Key('macos-agent-row-mnemosyne')));
    await tester.pump();
    expect(find.text(_mnemosyne.description), findsOneWidget);
    expect(find.text('Memory stewardship'), findsOneWidget);

    await tester.enterText(
      find.byKey(const Key('macos-agents-search')),
      'Research',
    );
    await tester.pump();
    expect(find.byKey(const Key('macos-agent-row-atlas')), findsOneWidget);
    expect(find.byKey(const Key('macos-agent-row-mnemosyne')), findsNothing);
  });

  testWidgets('switches between skill and outcome indexes', (tester) async {
    await _useDesktopViewport(tester);
    final controller = AgentsController(
      _AgentsRepository(),
      canManage: true,
      mutationsAvailable: true,
    );
    await controller.refresh();
    await tester.pumpWidget(_app(MacosAgentsView(controller: controller)));

    await tester.tap(find.text('Skills'));
    await tester.pumpAndSettle();
    expect(find.text('Skill and purpose'), findsOneWidget);
    expect(find.byKey(const Key('macos-skill-row-memory')), findsOneWidget);

    await tester.tap(find.byKey(const Key('macos-skill-row-memory')));
    await tester.pump();
    expect(find.text(_memory.instructions), findsOneWidget);
    expect(find.byKey(const Key('macos-skill-edit')), findsOneWidget);

    await tester.tap(find.text('Outcomes'));
    await tester.pumpAndSettle();
    expect(find.text('Average latency'), findsOneWidget);
    expect(
      find.byKey(const Key('macos-performance-row-atlas')),
      findsOneWidget,
    );
    expect(find.text('1.4 s'), findsWidgets);
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
