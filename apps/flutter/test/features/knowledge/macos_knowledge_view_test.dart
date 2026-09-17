import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/macos_knowledge_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _KnowledgeRepository implements KnowledgeRepository {
  int rebuilds = 0;

  @override
  Future<KnowledgeState> load({String query = '', String type = 'all'}) async =>
      const KnowledgeState(
        memories: [_memoryOne, _memoryTwo],
        knowledge: [_sourceOne, _sourceTwo],
        nodes: [_nodeOne, _nodeTwo, _nodeThree],
        edges: [_edgeOne, _edgeTwo],
        stats: {'nodes': 3, 'edges': 2, 'communities': 1},
      );

  @override
  Future<MemoryRecord> getMemory(String id) async =>
      id == _memoryOne.id ? _memoryOne : _memoryTwo;

  @override
  Future<void> addMemory(Json input) async {}

  @override
  Future<void> correctMemory(String id, Json input) async {}

  @override
  Future<void> deleteConnectedSource(String source) async {}

  @override
  Future<void> forgetMemory(String id, String expectedManifestSha256) async {}

  @override
  Future<MemoryForgetPreview> previewForgetMemory(String id) async =>
      const MemoryForgetPreview(
        expectedReceiptManifestSha256: 'receipt',
        guarantee: 'durable',
        descendantMemoryCount: 0,
        graphNodeCount: 1,
        graphEdgeCount: 1,
        retrievalTraceCount: 2,
      );

  @override
  Future<void> rebuildGraph() async {
    rebuilds += 1;
  }
}

const _memoryOne = MemoryRecord(
  id: 'm1',
  title: 'Owner prefers evidence first',
  content: 'Explain the evidence before offering a recommendation.',
  type: 'preference',
  tags: ['communication'],
  scope: 'workspace',
  source: 'Owner conversation',
  importance: .9,
  confidence: .94,
  claimStatus: 'active',
  assertedBy: 'owner',
  evidenceRefs: ['conversation:1'],
  category: 'preferences',
  tier: 'semantic',
  evidenceCount: 1,
);

const _memoryTwo = MemoryRecord(
  id: 'm2',
  title: 'Trading research scope',
  content: 'Focus analysis on XAUUSD and NAS100.',
  type: 'fact',
  tags: ['markets'],
  scope: 'project',
  source: 'Market project',
  importance: .8,
  confidence: .86,
  claimStatus: 'active',
  assertedBy: 'owner',
  evidenceRefs: [],
  category: 'facts',
  tier: 'semantic',
  evidenceCount: 0,
);

const _sourceOne = KnowledgeItem(
  id: 's1',
  title: 'Quarterly theory notes',
  content: 'A structured overview of quarterly theory.',
  source: 'capture/quarterly-theory.pdf',
  tags: ['trading'],
  kind: 'document',
  category: 'markets',
  chunkCount: 18,
  totalCharacters: 22400,
);

const _sourceTwo = KnowledgeItem(
  id: 's2',
  title: 'Workspace guide',
  content: 'The operating rules for the workspace.',
  source: 'docs/guide.md',
  tags: ['operations'],
  kind: 'document',
  category: 'operations',
  chunkCount: 4,
  totalCharacters: 6100,
);

const _nodeOne = GraphNode(
  id: 'n1',
  label: 'Quarterly theory',
  kind: 'concept',
  weight: .9,
  sourceCount: 3,
  tags: ['markets'],
  summary: 'A time-fractal trading framework.',
);

const _nodeTwo = GraphNode(
  id: 'n2',
  label: 'XAUUSD',
  kind: 'system',
  weight: .8,
  sourceCount: 5,
  tags: ['gold'],
  summary: 'Gold priced in US dollars.',
);

const _nodeThree = GraphNode(
  id: 'n3',
  label: 'Liquidity',
  kind: 'concept',
  weight: .75,
  sourceCount: 4,
  tags: ['ict'],
  summary: 'Resting orders around known levels.',
);

const _edgeOne = GraphEdge(
  source: 'n1',
  target: 'n2',
  relation: 'applies_to',
  weight: .8,
);

const _edgeTwo = GraphEdge(
  source: 'n1',
  target: 'n3',
  relation: 'uses',
  weight: .9,
);

void main() {
  testWidgets('provides searchable indexes and a persistent inspector', (
    tester,
  ) async {
    await _useDesktopViewport(tester);
    final repository = _KnowledgeRepository();
    final controller = KnowledgeController(
      repository,
      canManage: true,
      mutationsAvailable: true,
    );
    await controller.refresh();

    await tester.pumpWidget(_app(MacosKnowledgeView(controller: controller)));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('macos-knowledge-inspector')), findsOneWidget);
    expect(find.byType(FloatingActionButton), findsNothing);
    expect(find.text('Memory and claim'), findsOneWidget);
    expect(find.text(_memoryOne.content), findsWidgets);

    await tester.tap(find.byKey(const Key('macos-memory-row-m2')));
    await tester.pumpAndSettle();
    expect(find.text(_memoryTwo.content), findsWidgets);

    await tester.enterText(
      find.byKey(const Key('macos-knowledge-search')),
      'evidence',
    );
    await tester.pump();
    expect(find.byKey(const Key('macos-memory-row-m1')), findsOneWidget);
    expect(find.byKey(const Key('macos-memory-row-m2')), findsNothing);

    await tester.enterText(find.byKey(const Key('macos-knowledge-search')), '');
    await tester.pump();
    await tester.tap(find.text('Sources'));
    await tester.pumpAndSettle();
    expect(find.text('Indexed source'), findsOneWidget);
    expect(find.byKey(const Key('macos-source-row-s1')), findsOneWidget);

    await tester.enterText(
      find.byKey(const Key('macos-knowledge-search')),
      'Quarterly',
    );
    await tester.pump();
    expect(find.byKey(const Key('macos-source-row-s1')), findsOneWidget);
    expect(find.byKey(const Key('macos-source-row-s2')), findsNothing);
  });

  testWidgets('uses a stable interactive relationship workspace', (
    tester,
  ) async {
    await _useDesktopViewport(tester);
    final repository = _KnowledgeRepository();
    final controller = KnowledgeController(
      repository,
      canManage: true,
      mutationsAvailable: true,
    );
    await controller.refresh();
    await tester.pumpWidget(_app(MacosKnowledgeView(controller: controller)));

    await tester.tap(find.text('Relationships'));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const Key('macos-knowledge-relationship-canvas')),
      findsOneWidget,
    );
    expect(find.byType(InteractiveViewer), findsOneWidget);
    expect(find.byKey(const Key('macos-graph-node-n1')), findsOneWidget);

    await tester.tap(find.byKey(const Key('macos-graph-node-n1')));
    await tester.pump();
    expect(find.text('Connected concepts (2)'), findsOneWidget);
    expect(find.text('Applies To'), findsOneWidget);

    await tester.tap(find.byKey(const Key('macos-knowledge-rebuild-graph')));
    await tester.pumpAndSettle();
    expect(repository.rebuilds, 1);
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
