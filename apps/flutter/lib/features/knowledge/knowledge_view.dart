import 'package:flutter/material.dart';

import 'knowledge.dart';
import 'knowledge_labels.dart';
import 'knowledge_relationship_map.dart';
import 'knowledge_consent_view.dart';
import 'knowledge_promotion_view.dart';
import 'knowledge_source_map_view.dart';
import 'knowledge_source_deletion_view.dart';
import 'knowledge_graph_view.dart';
import 'knowledge_operations_view.dart';
import 'knowledge_read_widgets.dart';
import 'knowledge_mutations.dart';
import 'knowledge_mutation_widgets.dart';

/// The touch presenter keeps exact memory reads in this route, so replacing a
/// session cannot leave a private inspector in an independently owned sheet.
class KnowledgeView extends StatefulWidget {
  const KnowledgeView({
    super.key,
    required this.controller,
    this.initialMemoryId,
  });
  final KnowledgeController controller;
  final String? initialMemoryId;
  @override
  State<KnowledgeView> createState() => _KnowledgeViewState();
}

class _KnowledgeViewState extends State<KnowledgeView>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs;
  final _search = TextEditingController();
  String? _selectedMemoryId, _selectedNodeId;
  String _memoryType = 'all';
  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 10, vsync: this);
    _tabs.addListener(_tabChanged);
    _selectedMemoryId = widget.initialMemoryId;
    _search.text = widget.controller.query;
    if (widget.controller.state == null) widget.controller.refresh();
  }

  void _tabChanged() {
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(covariant KnowledgeView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller) ||
        oldWidget.initialMemoryId != widget.initialMemoryId) {
      _selectedMemoryId = widget.initialMemoryId;
      _selectedNodeId = null;
      _memoryType = 'all';
      _search.text = widget.controller.query;
      _tabs.index = 0;
    }
  }

  @override
  void dispose() {
    _tabs.removeListener(_tabChanged);
    _tabs.dispose();
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller, state = controller.state;
      if (!controller.available) {
        return const Scaffold(
          body: Center(child: Text('Sign in to read memory and knowledge.')),
        );
      }
      return Scaffold(
        appBar: AppBar(
          title: const Text(
            'Memory',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          actions: [
            if (controller.supportsChange(MemoryChange.create))
              IconButton(
                tooltip: 'Add private memory',
                icon: const Icon(Icons.add),
                onPressed: controller.pendingChange != null
                    ? null
                    : () => showMemoryEditor(context, controller),
              ),
            IconButton(
              tooltip: 'Refresh catalogue',
              onPressed: controller.loading ? null : controller.refresh,
              icon: const Icon(Icons.refresh),
            ),
          ],
          bottom: TabBar(
            controller: _tabs,
            isScrollable: true,
            tabs: const [
              Tab(text: 'Memory'),
              Tab(text: 'Knowledge'),
              Tab(text: 'Reviews'),
              Tab(text: 'Map'),
              Tab(text: 'Personal recall'),
              Tab(text: 'Promotions'),
              Tab(text: 'Source maps'),
              Tab(text: 'Source cleanup'),
              Tab(text: 'Advanced graph'),
              Tab(text: 'Maintenance'),
            ],
          ),
        ),
        body: _selectedMemoryId != null && _tabs.index == 0
            ? KnowledgeMemoryInspector(
                key: ValueKey(_selectedMemoryId),
                controller: controller,
                memoryId: _selectedMemoryId!,
                onClose: () => setState(() => _selectedMemoryId = null),
              )
            : Column(
                children: [
                  if (_tabs.index < 2)
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: TextField(
                        controller: _search,
                        onSubmitted: controller.search,
                        decoration: InputDecoration(
                          labelText: 'Search memories and sources',
                          helperText: 'Press search to update the list.',
                          prefixIcon: const Icon(Icons.search),
                          suffixIcon: IconButton(
                            tooltip: 'Submit catalogue search',
                            onPressed: () => controller.search(_search.text),
                            icon: const Icon(Icons.arrow_forward),
                          ),
                        ),
                      ),
                    ),
                  Expanded(
                    child: TabBarView(
                      controller: _tabs,
                      children: [
                        state == null
                            ? _catalogueUnavailable()
                            : _memory(state),
                        state == null
                            ? _catalogueUnavailable()
                            : _knowledge(state),
                        KnowledgeReviews(controller: controller),
                        state == null
                            ? _catalogueUnavailable()
                            : _universe(state),
                        KnowledgePersonalRecall(
                          controller: controller,
                          active: _tabs.index == 4,
                        ),
                        KnowledgePromotions(
                          controller: controller,
                          active: _tabs.index == 5,
                        ),
                        KnowledgeSourceMaps(
                          controller: controller,
                          active: _tabs.index == 6,
                        ),
                        KnowledgeSourceCleanup(
                          controller: controller,
                          active: _tabs.index == 7,
                        ),
                        KnowledgeGraphExplorer(
                          controller: controller,
                          active: _tabs.index == 8,
                        ),
                        KnowledgeOperations(
                          controller: controller,
                          active: _tabs.index == 9,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
      );
    },
  );
  Widget _catalogueUnavailable() => widget.controller.loading
      ? const Center(child: CircularProgressIndicator())
      : Center(
          child: FilledButton.tonal(
            onPressed: widget.controller.refresh,
            child: const Text('Retry catalogue read'),
          ),
        );
  Widget _memory(KnowledgeState state) {
    final types = state.memories.map((item) => item.type).toSet().toList()
      ..sort();
    final selectedType = types.contains(_memoryType) ? _memoryType : 'all';
    final values = state.memories
        .where(
          (item) =>
              (selectedType == 'all' || item.type == selectedType) &&
              (widget.controller.claimState != 'all' ||
                  !memoryRetiredPlaceholder(item.title)),
        )
        .toList();
    return ListView(
      children: [
        KnowledgeCoverage(controller: widget.controller),
        MemoryChangeStatus(controller: widget.controller),
        KnowledgeMemoryFilters(controller: widget.controller),
        Padding(
          padding: const EdgeInsets.all(12),
          child: DropdownButtonFormField<String>(
            key: ValueKey(selectedType),
            initialValue: selectedType,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Category'),
            items: [
              const DropdownMenuItem(
                value: 'all',
                child: Text('All loaded types'),
              ),
              for (final type in types)
                DropdownMenuItem(
                  value: type,
                  child: Text(memoryFriendlyLabel(type)),
                ),
            ],
            onChanged: (value) => setState(() => _memoryType = value ?? 'all'),
          ),
        ),
        if (values.isEmpty)
          const Padding(
            padding: EdgeInsets.all(20),
            child: Text('No memories match this loaded view.'),
          ),
        for (final memory in values)
          Card(
            margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: ListTile(
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 12,
                vertical: 4,
              ),
              title: Text(memoryDisplayTitle(memory.title, memory.updatedAt)),
              trailing: const Icon(Icons.chevron_right),
              subtitle: Text(
                '${memoryFriendlyLabel(memory.tier)} · ${memoryFriendlyLabel(memory.claimStatus)} · ${memory.evidenceCount} sources',
              ),
              onTap: () => setState(() => _selectedMemoryId = memory.id),
            ),
          ),
        KnowledgePageControls(controller: widget.controller, memory: true),
      ],
    );
  }

  Widget _knowledge(KnowledgeState state) => ListView(
    children: [
      KnowledgeCoverage(controller: widget.controller),
      if (state.knowledge.isEmpty)
        const Padding(
          padding: EdgeInsets.all(20),
          child: Text('No indexed sources match this catalogue page.'),
        ),
      for (final source in state.knowledge)
        Card(
          margin: const EdgeInsets.all(12),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  source.title,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                SelectableText(source.id),
                SelectableText(
                  source.source.isEmpty ? 'Origin not reported' : source.source,
                ),
                Text(
                  '${source.sourceType} · ${source.category} · ${source.chunkCount} segments · ${source.totalCharacters} indexed characters',
                ),
                Text(
                  'Canonical lineage: ${source.hasCanonicalLineage ? 'reported' : 'not reported'}',
                ),
                Text(
                  'Indexed: ${source.indexedAt?.toIso8601String() ?? 'not reported'}',
                ),
                const Text(
                  'Catalogue metadata only. Use Source cleanup to review deletion of eligible private local imports.',
                ),
              ],
            ),
          ),
        ),
      KnowledgePageControls(controller: widget.controller, memory: false),
    ],
  );
  Widget _universe(KnowledgeState state) {
    if (widget.controller.advancedGraphAvailable)
      return KnowledgeRelationshipMap(
        controller: widget.controller,
        active: _tabs.index == 3,
        onOpenMemory: (memory) {
          setState(() => _selectedMemoryId = memory.id);
          _tabs.animateTo(0);
        },
        onOpenSource: (source) {
          _tabs.animateTo(1);
          widget.controller.search(source.title);
        },
      );
    GraphNode? selected;
    for (final node in state.nodes) {
      if (node.id == _selectedNodeId) selected = node;
    }
    final selectedId = selected?.id;
    final neighbors = selectedId == null
        ? <GraphEdge>[]
        : state.edges
              .where(
                (edge) =>
                    edge.source == selectedId || edge.target == selectedId,
              )
              .take(40)
              .toList();
    return ListView(
      children: [
        KnowledgeCoverage(controller: widget.controller, graph: true),
        const Padding(
          padding: EdgeInsets.all(12),
          child: Text(
            'Relationships are a bounded read of recorded links. A link does not establish the truth of either claim.',
          ),
        ),
        if (selected != null)
          Card(
            margin: const EdgeInsets.all(12),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    selected.label,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  SelectableText(selected.id),
                  Text(
                    selected.summary.isEmpty
                        ? 'No summary reported.'
                        : selected.summary,
                  ),
                  Text(
                    'Showing ${neighbors.length} incident links from this sample (maximum 40).',
                  ),
                  for (final edge in neighbors)
                    SelectableText(
                      '${edge.source}\n${edge.relation}\n${edge.target}',
                    ),
                  TextButton(
                    onPressed: () => setState(() => _selectedNodeId = null),
                    child: const Text('Close relationship details'),
                  ),
                ],
              ),
            ),
          ),
        if (state.nodes.isEmpty)
          const Padding(
            padding: EdgeInsets.all(20),
            child: Text('No relationship points were returned.'),
          ),
        for (final node in state.nodes)
          ListTile(
            title: Text(node.label),
            subtitle: Text(
              '${node.kind} · ${node.sourceCount} recorded sources',
            ),
            selected: node.id == selected?.id,
            onTap: () => setState(() => _selectedNodeId = node.id),
          ),
      ],
    );
  }
}
