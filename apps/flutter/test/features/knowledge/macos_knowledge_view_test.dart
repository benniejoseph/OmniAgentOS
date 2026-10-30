import 'dart:ui' show Tristate;

import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/features/knowledge/knowledge.dart';
import 'package:asael/features/knowledge/knowledge_consent_view.dart';
import 'package:asael/features/knowledge/knowledge_graph_view.dart';
import 'package:asael/features/knowledge/knowledge_operations_view.dart';
import 'package:asael/features/knowledge/knowledge_promotion_view.dart';
import 'package:asael/features/knowledge/knowledge_source_deletion_view.dart';
import 'package:asael/features/knowledge/knowledge_source_map_view.dart';
import 'package:asael/features/knowledge/macos_knowledge_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/native_visual_capture.dart';

class _KnowledgeRepository implements KnowledgeRepository {
  _KnowledgeRepository({this.memories = const [_memoryOne, _memoryTwo]});

  final List<MemoryRecord> memories;
  int rebuilds = 0;

  @override
  Future<KnowledgeState> load({String query = '', String type = 'all'}) async =>
      KnowledgeState(
        memories: memories,
        knowledge: const [_sourceOne, _sourceTwo],
        nodes: const [_nodeOne, _nodeTwo, _nodeThree],
        edges: const [_edgeOne, _edgeTwo],
        stats: const {'nodes': 3, 'edges': 2, 'communities': 1},
      );

  @override
  Future<MemoryRecord> getMemory(String id) async =>
      memories.firstWhere((memory) => memory.id == id);

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
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(loadNativeReviewFont);

  testWidgets(
    'Mac Library keeps four primary views and every secondary view reachable',
    (tester) async {
      await _useDesktopViewport(tester);
      final controller = KnowledgeController(
        _KnowledgeRepository(),
        canManage: false,
        mutationsAvailable: false,
      );
      addTearDown(controller.dispose);
      await controller.refresh();
      await tester.pumpWidget(_app(MacosKnowledgeView(controller: controller)));
      await tester.pumpAndSettle();

      final navigation = find.byKey(const Key('macos-knowledge-workspace'));
      final choices = find.descendant(
        of: navigation,
        matching: find.byType(ChoiceChip),
      );
      expect(choices, findsNWidgets(4));
      for (final label in ['Memory', 'Sources', 'Reviews', 'Relationships']) {
        expect(
          find.descendant(of: navigation, matching: find.text(label)),
          findsOneWidget,
        );
      }
      expect(find.byType(MenuItemButton), findsNothing);
      expect(find.text('More views'), findsOneWidget);
      expect(find.text('Category'), findsOneWidget);
      expect(
        find.widgetWithText(DropdownButtonFormField<String>, 'Kind'),
        findsOneWidget,
      );
      expect(find.text('All categories'), findsOneWidget);
      expect(find.text('All kinds'), findsNothing);
      await captureNativeSurface(tester, _capture, 'mac-library-primary-1440');

      // Category narrows the loaded collection; Kind requests a memory tier.
      // Keep these distinct filters and their state independent.
      final category = find.widgetWithText(
        DropdownButtonFormField<String>,
        'Category',
      );
      await tester.tap(category);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Preferences').last);
      await tester.pumpAndSettle();
      expect(controller.tier, 'all');
      expect(find.byKey(const Key('macos-memory-row-m1')), findsOneWidget);
      expect(find.byKey(const Key('macos-memory-row-m2')), findsNothing);

      await tester.tap(find.byKey(const ValueKey('tier-all')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Facts').last);
      await tester.pumpAndSettle();
      expect(controller.tier, 'semantic');
      expect(
        find.widgetWithText(DropdownButtonFormField<String>, 'Preferences'),
        findsOneWidget,
      );
      expect(find.byKey(const Key('macos-memory-row-m2')), findsNothing);

      await tester.tap(category);
      await tester.pumpAndSettle();
      await tester.tap(find.text('All categories').last);
      await tester.pumpAndSettle();
      expect(controller.tier, 'semantic');
      await tester.tap(find.byKey(const ValueKey('tier-semantic')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('All').last);
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('macos-memory-row-m2')));
      await tester.enterText(
        find.byKey(const Key('macos-knowledge-search')),
        'Trading',
      );
      await tester.pumpAndSettle();

      const secondaryViews = {
        'recall': ('Personal recall', KnowledgePersonalRecall),
        'promotions': ('Promotions', KnowledgePromotions),
        'sourceMaps': ('Source maps', KnowledgeSourceMaps),
        'sourceCleanup': ('Source cleanup', KnowledgeSourceCleanup),
        'graphExplorer': ('Advanced graph', KnowledgeGraphExplorer),
        'privateActions': ('Maintenance', KnowledgeOperations),
      };
      for (final entry in secondaryViews.entries) {
        await tester.tap(_moreViews);
        await tester.pumpAndSettle();
        expect(find.byType(MenuItemButton), findsNWidgets(6));
        for (final view in secondaryViews.values) {
          expect(find.widgetWithText(MenuItemButton, view.$1), findsOneWidget);
        }
        if (entry.key == 'recall') {
          await captureNativeSurface(tester, _capture, 'mac-library-more-1440');
        }
        await tester.tap(find.byKey(Key('macos-knowledge-view-${entry.key}')));
        await tester.pumpAndSettle();
        expect(find.byType(entry.value.$2), findsOneWidget);
        expect(find.text('More views · ${entry.value.$1}'), findsOneWidget);
        expect(find.byType(MenuItemButton), findsNothing);
        expect(
          tester.widgetList<ChoiceChip>(choices).any((chip) => chip.selected),
          isFalse,
        );
        expect(tester.takeException(), isNull);
      }

      await tester.tap(find.widgetWithText(ChoiceChip, 'Memory'));
      await tester.pumpAndSettle();
      expect(find.text('More views'), findsOneWidget);
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('macos-knowledge-search')))
            .controller!
            .text,
        'Trading',
      );
      expect(find.byKey(const Key('macos-memory-row-m1')), findsNothing);
      expect(find.byKey(const Key('macos-memory-row-m2')), findsOneWidget);
      expect(find.text(_memoryTwo.content), findsWidgets);
      expect(
        tester
            .widget<ChoiceChip>(find.widgetWithText(ChoiceChip, 'Memory'))
            .selected,
        isTrue,
      );
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets(
    'Mac Library More views works with the keyboard and exposes the current view',
    (tester) async {
      await _useDesktopViewport(tester);
      final controller = KnowledgeController(
        _KnowledgeRepository(),
        canManage: false,
        mutationsAvailable: false,
      );
      addTearDown(controller.dispose);
      await controller.refresh();
      await tester.pumpWidget(_app(MacosKnowledgeView(controller: controller)));
      await tester.pumpAndSettle();

      final buttonFocus = tester.widget<TextButton>(_moreViews).focusNode!;
      buttonFocus.requestFocus();
      await tester.pump();
      expect(buttonFocus.hasFocus, isTrue);
      expect(
        tester.getSemantics(_moreViews).getSemanticsData().label,
        'More views',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();

      expect(find.byType(KnowledgePersonalRecall), findsOneWidget);
      expect(
        tester.getSemantics(_moreViews).getSemanticsData().label,
        'More views · Personal recall',
      );
      expect(
        tester
            .getSemantics(_moreViews)
            .getSemanticsData()
            .flagsCollection
            .isSelected,
        Tristate.isTrue,
      );
      expect(buttonFocus.hasFocus, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      final selectedItem = find.byKey(const Key('macos-knowledge-view-recall'));
      expect(
        tester
            .getSemantics(selectedItem)
            .getSemanticsData()
            .flagsCollection
            .isSelected,
        Tristate.isTrue,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(MenuItemButton), findsNothing);
      expect(buttonFocus.hasFocus, isTrue);
      expect(tester.takeException(), isNull);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  for (final dark in [false, true]) {
    testWidgets(
      'Mac Library ${dark ? 'dark' : 'light'} keeps long data and the menu usable at a narrow desktop width',
      (tester) async {
        await _useDesktopViewport(tester);
        tester.view.physicalSize = const Size(1000, 900);
        final longTitle = List.filled(
          8,
          'Weekly creative research across all brands',
        ).join(' · ');
        final memories = List.generate(
          24,
          (index) => MemoryRecord.fromJson({
            'id': 'long-$index',
            'title': '$index $longTitle',
            'content': List.filled(
              8,
              'Keep the original research and its exact source context available.',
            ).join(' '),
            'category':
                'creative-research-with-an-intentionally-long-category-label',
            'tier': 'semantic',
            'source': 'Owner research notes',
          }),
        );
        final controller = KnowledgeController(
          _KnowledgeRepository(memories: memories),
          canManage: false,
          mutationsAvailable: false,
        );
        addTearDown(controller.dispose);
        await controller.refresh();
        await tester.pumpWidget(
          _app(
            MacosKnowledgeView(controller: controller),
            dark: dark,
            textScale: 1.3,
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('macos-knowledge-inspector')),
          findsOneWidget,
        );
        expect(find.byKey(const Key('macos-knowledge-search')), findsOneWidget);
        final firstRow = find.byKey(const Key('macos-memory-row-long-0'));
        final title = tester.widget<Text>(
          find.descendant(of: firstRow, matching: find.text('0 $longTitle')),
        );
        expect(title.maxLines, 1);
        expect(title.overflow, TextOverflow.ellipsis);
        expect(tester.getSemantics(firstRow).label, contains(longTitle));
        expect(tester.takeException(), isNull);
        await captureNativeSurface(
          tester,
          _capture,
          'mac-library-${dark ? 'dark' : 'light'}-1000',
        );

        final list = find.ancestor(
          of: firstRow,
          matching: find.byType(ListView),
        );
        final scroll = tester
            .state<ScrollableState>(
              find.descendant(of: list, matching: find.byType(Scrollable)),
            )
            .position;
        scroll.jumpTo(280);
        await tester.pumpAndSettle();
        await tester.tap(_moreViews);
        await tester.pumpAndSettle();
        expect(find.byType(MenuItemButton), findsNWidgets(6));
        for (final item in tester.widgetList<MenuItemButton>(
          find.byType(MenuItemButton),
        )) {
          final bounds = tester.getRect(find.byKey(item.key!));
          expect(bounds.left, greaterThanOrEqualTo(0));
          expect(bounds.right, lessThanOrEqualTo(1000));
          expect(bounds.bottom, lessThanOrEqualTo(900));
        }
        expect(tester.takeException(), isNull);
        await captureNativeSurface(
          tester,
          _capture,
          'mac-library-more-${dark ? 'dark' : 'light'}-1000',
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(scroll.pixels, 280);
        await tester.tap(_moreViews);
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('macos-knowledge-view-recall')));
        await tester.pumpAndSettle();
        expect(find.text('More views · Personal recall'), findsOneWidget);
        expect(tester.getRect(_moreViews).right, lessThanOrEqualTo(1000));
        expect(tester.takeException(), isNull);
        await captureNativeSurface(
          tester,
          _capture,
          'mac-library-secondary-${dark ? 'dark' : 'light'}-1000',
        );
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  }

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
    expect(find.text('Status'), findsNWidgets(2));
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
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

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
    expect(find.textContaining('Applies To'), findsOneWidget);
    expect(find.textContaining('n2'), findsWidgets);

    await tester.tap(find.byKey(const Key('macos-knowledge-rebuild-graph')));
    await tester.pumpAndSettle();
    expect(repository.rebuilds, 1);
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
}

const _capture = Key('mac-library-capture');
Finder get _moreViews => find.byKey(const Key('macos-knowledge-more-views'));

Widget _app(Widget child, {bool dark = false, double textScale = 1}) =>
    RepaintBoundary(
      key: _capture,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: dark ? MacosAppTheme.dark() : MacosAppTheme.light(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(
            textScaler: TextScaler.linear(textScale),
            disableAnimations: true,
          ),
          child: child!,
        ),
        home: child,
      ),
    );

Future<void> _useDesktopViewport(WidgetTester tester) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1440, 900);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
}
