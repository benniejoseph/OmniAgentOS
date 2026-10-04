import 'package:flutter/material.dart';

import 'knowledge.dart';
import 'knowledge_read_widgets.dart';

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
    _tabs = TabController(length: 4, vsync: this);
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
              Tab(text: 'Universe'),
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
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: TextField(
                      controller: _search,
                      onSubmitted: controller.search,
                      decoration: InputDecoration(
                        labelText: 'Search the live catalogue',
                        helperText: 'Submit to search. Type filters apply to loaded memory rows.',
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
                    child: controller.loading && state == null
                        ? const Center(child: CircularProgressIndicator())
                        : state == null
                        ? Center(
                            child: FilledButton.tonal(
                              onPressed: controller.refresh,
                              child: const Text('Retry catalogue read'),
                            ),
                          )
                        : TabBarView(
                            controller: _tabs,
                            children: [
                              _memory(state),
                              _knowledge(state),
                              KnowledgeReviews(
                                overview: state.overview,
                                stale: widget.controller.error != null,
                              ),
                              _universe(state),
                            ],
                          ),
                  ),
                ],
              ),
      );
    },
  );
  Widget _memory(KnowledgeState state) {
    final types = state.memories.map((item) => item.type).toSet().toList()
      ..sort();
    final selectedType = types.contains(_memoryType) ? _memoryType : 'all';
    final values = state.memories
        .where((item) => selectedType == 'all' || item.type == selectedType)
        .toList();
    return ListView(
      children: [
        KnowledgeCoverage(controller: widget.controller),
        KnowledgeMemoryFilters(controller: widget.controller),
        Padding(
          padding: const EdgeInsets.all(12),
          child: DropdownButtonFormField<String>(
            key: ValueKey(selectedType),
            initialValue: selectedType,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Type · loaded rows'),
            items: [
              const DropdownMenuItem(
                value: 'all',
                child: Text('All loaded types'),
              ),
              for (final type in types)
                DropdownMenuItem(value: type, child: Text(type)),
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
              contentPadding: const EdgeInsets.all(16),
              title: Text(memory.title),
              subtitle: Text(
                '${memory.type} · ${memory.tier} · ${memory.claimStatus}\n${memory.evidenceCount} evidence references · ${memory.metadata.visibility}',
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
                  'Catalogue metadata only. Exact source content and source deletion are not available in this view.',
                ),
              ],
            ),
          ),
        ),
      KnowledgePageControls(controller: widget.controller, memory: false),
    ],
  );
  Widget _universe(KnowledgeState state) {
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
