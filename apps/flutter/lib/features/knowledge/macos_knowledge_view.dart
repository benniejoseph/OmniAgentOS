import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import 'knowledge.dart';

enum _KnowledgeWorkspace { memories, sources, relationships }

/// A desktop knowledge browser for macOS.
///
/// This presenter deliberately keeps the portable controller and repository as
/// the source of truth. It replaces the touch-first cards and modal sheets with
/// searchable indexes, a stable relationship canvas, and a persistent
/// inspector suited to a resizable Mac window.
class MacosKnowledgeView extends StatefulWidget {
  const MacosKnowledgeView({super.key, required this.controller});

  final KnowledgeController controller;

  @override
  State<MacosKnowledgeView> createState() => _MacosKnowledgeViewState();
}

class _MacosKnowledgeViewState extends State<MacosKnowledgeView> {
  final _searchController = TextEditingController();
  final _graphTransform = TransformationController();
  _KnowledgeWorkspace _workspace = _KnowledgeWorkspace.memories;
  String _category = 'all';
  String? _selectedMemoryId;
  String? _selectedSourceId;
  String? _selectedNodeId;
  MemoryRecord? _inspectedMemory;
  bool _inspectingMemory = false;

  @override
  void initState() {
    super.initState();
    _searchController.text = widget.controller.query;
    if (widget.controller.state == null) widget.controller.refresh();
  }

  @override
  void dispose() {
    _searchController.dispose();
    _graphTransform.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      final state = controller.state;
      final memories = _visibleMemories(state?.memories ?? const []);
      final sources = _visibleSources(state?.knowledge ?? const []);
      final nodes = _visibleNodes(state?.nodes ?? const []);
      final selectedMemory = _findMemory(
        state?.memories ?? const [],
        _selectedMemoryId,
      );
      final selectedSource = _findSource(
        state?.knowledge ?? const [],
        _selectedSourceId,
      );
      final selectedNode = _findNode(state?.nodes ?? const [], _selectedNodeId);

      return MacosPageScaffold(
        title: 'Knowledge',
        description: 'Browse what Asael remembers, inspect its sources, and trace relationships.',
        icon: Icons.account_tree_outlined,
        actions: [
          IconButton(
            key: const Key('macos-knowledge-refresh'),
            tooltip: 'Refresh knowledge',
            onPressed: controller.loading ? null : controller.refresh,
            icon: controller.loading
                ? const SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh_rounded),
          ),
        ],
        primaryAction: controller.canMutate
            ? FilledButton.icon(
                key: const Key('macos-knowledge-add-memory'),
                onPressed: _addMemory,
                icon: const Icon(Icons.add_rounded, size: 17),
                label: const Text('New memory'),
              )
            : null,
        toolbar: _KnowledgeToolbar(
          workspace: _workspace,
          searchController: _searchController,
          category: _category,
          categories: _categoriesFor(state),
          visibleCount: switch (_workspace) {
            _KnowledgeWorkspace.memories => memories.length,
            _KnowledgeWorkspace.sources => sources.length,
            _KnowledgeWorkspace.relationships => nodes.length,
          },
          onWorkspaceChanged: _selectWorkspace,
          onSearchChanged: (_) => setState(() {}),
          onSearchSubmitted: widget.controller.search,
          onClearSearch: _clearSearch,
          onCategoryChanged: (value) => setState(() => _category = value),
        ),
        inspectorWidth: 390,
        inspectorMinWidth: 320,
        inspectorMaxWidth: 540,
        inspector: _KnowledgeInspector(
          key: const Key('macos-knowledge-inspector'),
          workspace: _workspace,
          memory: _inspectedMemory ?? selectedMemory,
          source: selectedSource,
          node: selectedNode,
          allNodes: state?.nodes ?? const [],
          edges: state?.edges ?? const [],
          loadingMemory: _inspectingMemory,
          canMutate: controller.canMutate,
          onCorrect: selectedMemory == null
              ? null
              : () => _correctMemory(selectedMemory, contradiction: false),
          onContradict: selectedMemory == null
              ? null
              : () => _correctMemory(selectedMemory, contradiction: true),
          onForget: selectedMemory == null
              ? null
              : () => _forgetMemory(selectedMemory),
          onSelectNode: (id) => setState(() => _selectedNodeId = id),
        ),
        body: _buildBody(
          state: state,
          memories: memories,
          sources: sources,
          nodes: nodes,
          selectedMemory: selectedMemory,
          selectedSource: selectedSource,
          selectedNode: selectedNode,
        ),
      );
    },
  );

  Widget _buildBody({
    required KnowledgeState? state,
    required List<MemoryRecord> memories,
    required List<KnowledgeItem> sources,
    required List<GraphNode> nodes,
    required MemoryRecord? selectedMemory,
    required KnowledgeItem? selectedSource,
    required GraphNode? selectedNode,
  }) {
    final controller = widget.controller;
    if (state == null && controller.loading) {
      return const MacosLoadingList(rows: 9);
    }
    if (state == null && controller.error != null) {
      return MacosEmptyState(
        icon: Icons.cloud_off_outlined,
        title: 'Knowledge is unavailable',
        message: '${controller.error}',
        action: FilledButton.tonal(
          onPressed: controller.refresh,
          child: const Text('Reconnect'),
        ),
      );
    }
    return switch (_workspace) {
      _KnowledgeWorkspace.memories => _MemoryIndex(
        memories: memories,
        selectedId: selectedMemory?.id,
        filtered: _isFiltered,
        onSelect: _selectMemory,
        onClearFilters: _resetFilters,
      ),
      _KnowledgeWorkspace.sources => _SourceIndex(
        sources: sources,
        selectedId: selectedSource?.id,
        filtered: _isFiltered,
        onSelect: (source) => setState(() => _selectedSourceId = source.id),
        onClearFilters: _resetFilters,
      ),
      _KnowledgeWorkspace.relationships => _RelationshipWorkspace(
        nodes: nodes,
        allNodes: state?.nodes ?? const [],
        edges: state?.edges ?? const [],
        stats: state?.stats ?? const {},
        selectedId: selectedNode?.id,
        transform: _graphTransform,
        canRebuild: controller.canMutate,
        onRebuild: () => _run(controller.rebuild),
        onSelect: (node) => setState(() => _selectedNodeId = node.id),
      ),
    };
  }

  bool get _isFiltered =>
      _searchController.text.trim().isNotEmpty || _category != 'all';

  List<String> _categoriesFor(KnowledgeState? state) {
    final values = switch (_workspace) {
      _KnowledgeWorkspace.memories =>
        (state?.memories ?? const <MemoryRecord>[]).map(
          (item) => item.category,
        ),
      _KnowledgeWorkspace.sources =>
        (state?.knowledge ?? const <KnowledgeItem>[]).map(
          (item) => item.category,
        ),
      _KnowledgeWorkspace.relationships =>
        (state?.nodes ?? const <GraphNode>[]).map((item) => item.kind),
    };
    return values.where((value) => value.trim().isNotEmpty).toSet().toList()
      ..sort();
  }

  List<MemoryRecord> _visibleMemories(List<MemoryRecord> source) {
    final query = _searchController.text.trim().toLowerCase();
    return source.where((item) {
      final matchesCategory = _category == 'all' || item.category == _category;
      final matchesQuery =
          query.isEmpty ||
          item.title.toLowerCase().contains(query) ||
          item.content.toLowerCase().contains(query) ||
          item.tags.any((tag) => tag.toLowerCase().contains(query));
      return matchesCategory && matchesQuery;
    }).toList();
  }

  List<KnowledgeItem> _visibleSources(List<KnowledgeItem> source) {
    final query = _searchController.text.trim().toLowerCase();
    return source.where((item) {
      final matchesCategory = _category == 'all' || item.category == _category;
      final matchesQuery =
          query.isEmpty ||
          item.title.toLowerCase().contains(query) ||
          item.content.toLowerCase().contains(query) ||
          item.source.toLowerCase().contains(query) ||
          item.tags.any((tag) => tag.toLowerCase().contains(query));
      return matchesCategory && matchesQuery;
    }).toList();
  }

  List<GraphNode> _visibleNodes(List<GraphNode> source) {
    final query = _searchController.text.trim().toLowerCase();
    return source.where((item) {
      final matchesCategory = _category == 'all' || item.kind == _category;
      final matchesQuery =
          query.isEmpty ||
          item.label.toLowerCase().contains(query) ||
          item.summary.toLowerCase().contains(query) ||
          item.tags.any((tag) => tag.toLowerCase().contains(query));
      return matchesCategory && matchesQuery;
    }).toList();
  }

  void _selectWorkspace(Set<_KnowledgeWorkspace> values) {
    if (values.isEmpty) return;
    setState(() {
      _workspace = values.first;
      _category = 'all';
    });
  }

  Future<void> _clearSearch() async {
    _searchController.clear();
    setState(() {});
    await widget.controller.search('');
  }

  void _resetFilters() {
    _searchController.clear();
    setState(() => _category = 'all');
    widget.controller.search('');
  }

  Future<void> _selectMemory(MemoryRecord memory) async {
    setState(() {
      _selectedMemoryId = memory.id;
      _inspectedMemory = null;
      _inspectingMemory = true;
    });
    try {
      final exact = await widget.controller.inspect(memory.id);
      if (!mounted || _selectedMemoryId != memory.id) return;
      setState(() => _inspectedMemory = exact);
    } catch (error) {
      _showError(error);
    } finally {
      if (mounted && _selectedMemoryId == memory.id) {
        setState(() => _inspectingMemory = false);
      }
    }
  }

  Future<void> _addMemory() async {
    final value = await showDialog<Json>(
      context: context,
      builder: (_) => const _MacosMemoryDialog(),
    );
    if (value != null) await _run(() => widget.controller.add(value));
  }

  Future<void> _correctMemory(
    MemoryRecord memory, {
    required bool contradiction,
  }) async {
    try {
      final exact = await widget.controller.inspect(memory.id);
      if (!mounted) return;
      final value = await showDialog<Json>(
        context: context,
        builder: (_) =>
            _MacosMemoryDialog(memory: exact, contradiction: contradiction),
      );
      if (value != null) {
        await _run(() => widget.controller.correct(memory.id, value));
      }
    } catch (error) {
      _showError(error);
    }
  }

  Future<void> _forgetMemory(MemoryRecord memory) async {
    try {
      final preview = await widget.controller.previewForget(memory.id);
      if (!mounted) return;
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('Forget this memory?'),
          content: SizedBox(
            width: 480,
            child: Text(
              '“${memory.title}” and its derived recall material will be removed. '
              'This affects ${preview.descendantMemoryCount} derived memories, '
              '${preview.graphNodeCount} relationship points, '
              '${preview.graphEdgeCount} links, and '
              '${preview.retrievalTraceCount} recall traces. A deletion receipt '
              'will remain.',
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              key: const Key('macos-memory-confirm-forget'),
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Forget memory'),
            ),
          ],
        ),
      );
      if (confirmed == true) {
        await _run(
          () => widget.controller.forget(
            memory.id,
            preview.expectedReceiptManifestSha256,
          ),
        );
        if (mounted) {
          setState(() {
            _selectedMemoryId = null;
            _inspectedMemory = null;
          });
        }
      }
    } catch (error) {
      _showError(error);
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    try {
      await action();
    } catch (error) {
      _showError(error);
    }
  }

  void _showError(Object error) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text('$error')));
  }
}

class _KnowledgeToolbar extends StatelessWidget {
  const _KnowledgeToolbar({
    required this.workspace,
    required this.searchController,
    required this.category,
    required this.categories,
    required this.visibleCount,
    required this.onWorkspaceChanged,
    required this.onSearchChanged,
    required this.onSearchSubmitted,
    required this.onClearSearch,
    required this.onCategoryChanged,
  });

  final _KnowledgeWorkspace workspace;
  final TextEditingController searchController;
  final String category;
  final List<String> categories;
  final int visibleCount;
  final ValueChanged<Set<_KnowledgeWorkspace>> onWorkspaceChanged;
  final ValueChanged<String> onSearchChanged;
  final ValueChanged<String> onSearchSubmitted;
  final VoidCallback onClearSearch;
  final ValueChanged<String> onCategoryChanged;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final compact = constraints.maxWidth < 860;
      return Row(
        children: [
          SegmentedButton<_KnowledgeWorkspace>(
            key: const Key('macos-knowledge-workspace'),
            showSelectedIcon: false,
            segments: const [
              ButtonSegment(
                value: _KnowledgeWorkspace.memories,
                icon: Icon(Icons.memory_outlined, size: 15),
                label: Text('Memory'),
              ),
              ButtonSegment(
                value: _KnowledgeWorkspace.sources,
                icon: Icon(Icons.library_books_outlined, size: 15),
                label: Text('Sources'),
              ),
              ButtonSegment(
                value: _KnowledgeWorkspace.relationships,
                icon: Icon(Icons.hub_outlined, size: 15),
                label: Text('Relationships'),
              ),
            ],
            selected: {workspace},
            onSelectionChanged: onWorkspaceChanged,
          ),
          const SizedBox(width: 12),
          SizedBox(
            width: compact ? 220 : 290,
            child: TextField(
              key: const Key('macos-knowledge-search'),
              controller: searchController,
              onChanged: onSearchChanged,
              onSubmitted: onSearchSubmitted,
              decoration: InputDecoration(
                hintText: switch (workspace) {
                  _KnowledgeWorkspace.memories => 'Search memory',
                  _KnowledgeWorkspace.sources => 'Search indexed sources',
                  _KnowledgeWorkspace.relationships => 'Find a concept',
                },
                prefixIcon: const Icon(Icons.search_rounded, size: 17),
                suffixIcon: searchController.text.isEmpty
                    ? null
                    : IconButton(
                        tooltip: 'Clear search',
                        onPressed: onClearSearch,
                        icon: const Icon(Icons.close_rounded, size: 15),
                      ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: compact ? 132 : 165,
            child: DropdownButtonFormField<String>(
              key: ValueKey('macos-knowledge-filter-$workspace-$category'),
              initialValue: category,
              isExpanded: true,
              decoration: const InputDecoration(),
              items: [
                const DropdownMenuItem(value: 'all', child: Text('All kinds')),
                ...categories.map(
                  (value) => DropdownMenuItem(
                    value: value,
                    child: Text(_label(value), overflow: TextOverflow.ellipsis),
                  ),
                ),
              ],
              onChanged: (value) {
                if (value != null) onCategoryChanged(value);
              },
            ),
          ),
          const Spacer(),
          if (!compact)
            Text(
              '$visibleCount visible',
              style: Theme.of(context).textTheme.bodySmall,
            ),
        ],
      );
    },
  );
}

class _MemoryIndex extends StatelessWidget {
  const _MemoryIndex({
    required this.memories,
    required this.selectedId,
    required this.filtered,
    required this.onSelect,
    required this.onClearFilters,
  });

  final List<MemoryRecord> memories;
  final String? selectedId;
  final bool filtered;
  final ValueChanged<MemoryRecord> onSelect;
  final VoidCallback onClearFilters;

  @override
  Widget build(BuildContext context) {
    if (memories.isEmpty) {
      return MacosEmptyState(
        icon: Icons.memory_outlined,
        title: filtered ? 'No matching memories' : 'No durable memories yet',
        message: filtered
            ? 'Change the search or kind filter to widen this index.'
            : 'Memories created from trusted interactions will appear here.',
        action: filtered
            ? TextButton(
                onPressed: onClearFilters,
                child: const Text('Clear filters'),
              )
            : null,
      );
    }
    return Column(
      children: [
        const _IndexHeader(
          leading: 'Memory and claim',
          middle: 'Kind',
          trailing: 'Confidence',
        ),
        Expanded(
          child: ListView.builder(
            itemCount: memories.length,
            itemBuilder: (context, index) {
              final memory = memories[index];
              return _MemoryRow(
                key: Key('macos-memory-row-${memory.id}'),
                memory: memory,
                selected: memory.id == selectedId,
                onTap: () => onSelect(memory),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _MemoryRow extends StatelessWidget {
  const _MemoryRow({
    super.key,
    required this.memory,
    required this.selected,
    required this.onTap,
  });

  final MemoryRecord memory;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      selected: selected,
      label: '${memory.title}, ${memory.category} memory',
      child: Material(
        color: selected ? mac.selection : Colors.transparent,
        child: InkWell(
          onTap: onTap,
          child: Container(
            height: 62,
            padding: const EdgeInsets.symmetric(horizontal: 18),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: mac.divider)),
            ),
            child: Row(
              children: [
                Icon(
                  memory.claimStatus == 'active'
                      ? Icons.circle
                      : Icons.history_toggle_off_outlined,
                  size: memory.claimStatus == 'active' ? 8 : 16,
                  color: memory.claimStatus == 'active'
                      ? mac.positive
                      : scheme.onSurfaceVariant,
                ),
                const SizedBox(width: 11),
                Expanded(
                  flex: 6,
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        memory.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        memory.content,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                Expanded(
                  flex: 2,
                  child: Text(
                    _label(memory.category),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
                Expanded(
                  flex: 2,
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: Text(
                      '${(memory.confidence * 100).round()}%',
                      style: Theme.of(context).textTheme.labelLarge,
                    ),
                  ),
                ),
                const SizedBox(width: 4),
                const Icon(Icons.chevron_right_rounded, size: 16),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SourceIndex extends StatelessWidget {
  const _SourceIndex({
    required this.sources,
    required this.selectedId,
    required this.filtered,
    required this.onSelect,
    required this.onClearFilters,
  });

  final List<KnowledgeItem> sources;
  final String? selectedId;
  final bool filtered;
  final ValueChanged<KnowledgeItem> onSelect;
  final VoidCallback onClearFilters;

  @override
  Widget build(BuildContext context) {
    if (sources.isEmpty) {
      return MacosEmptyState(
        icon: Icons.library_books_outlined,
        title: filtered ? 'No matching sources' : 'No indexed sources yet',
        message: filtered
            ? 'Change the search or kind filter to widen this index.'
            : 'Captured documents and processed material will appear here.',
        action: filtered
            ? TextButton(
                onPressed: onClearFilters,
                child: const Text('Clear filters'),
              )
            : null,
      );
    }
    return Column(
      children: [
        const _IndexHeader(
          leading: 'Indexed source',
          middle: 'Kind',
          trailing: 'Segments',
        ),
        Expanded(
          child: ListView.builder(
            itemCount: sources.length,
            itemBuilder: (context, index) {
              final source = sources[index];
              final selected = source.id == selectedId;
              final mac = MacosThemeColors.of(context);
              return Semantics(
                button: true,
                selected: selected,
                label: '${source.title}, indexed ${source.kind}',
                child: Material(
                  color: selected ? mac.selection : Colors.transparent,
                  child: InkWell(
                    key: Key('macos-source-row-${source.id}'),
                    onTap: () => onSelect(source),
                    child: Container(
                      height: 62,
                      padding: const EdgeInsets.symmetric(horizontal: 18),
                      decoration: BoxDecoration(
                        border: Border(bottom: BorderSide(color: mac.divider)),
                      ),
                      child: Row(
                        children: [
                          Icon(
                            source.kind == 'document'
                                ? Icons.description_outlined
                                : Icons.segment_outlined,
                            size: 18,
                          ),
                          const SizedBox(width: 11),
                          Expanded(
                            flex: 6,
                            child: Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  source.title,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: Theme.of(context).textTheme.titleSmall,
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  source.source.isEmpty
                                      ? 'Local knowledge'
                                      : source.source,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                              ],
                            ),
                          ),
                          Expanded(
                            flex: 2,
                            child: Text(
                              _label(source.category),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ),
                          Expanded(
                            flex: 2,
                            child: Align(
                              alignment: Alignment.centerRight,
                              child: Text(
                                '${source.chunkCount}',
                                style: Theme.of(context).textTheme.labelLarge,
                              ),
                            ),
                          ),
                          const SizedBox(width: 4),
                          const Icon(Icons.chevron_right_rounded, size: 16),
                        ],
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _IndexHeader extends StatelessWidget {
  const _IndexHeader({
    required this.leading,
    required this.middle,
    required this.trailing,
  });

  final String leading, middle, trailing;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final style = Theme.of(context).textTheme.labelSmall;
    return Container(
      height: 34,
      padding: const EdgeInsets.symmetric(horizontal: 18),
      decoration: BoxDecoration(
        color: mac.toolbar,
        border: Border(bottom: BorderSide(color: mac.divider)),
      ),
      child: Row(
        children: [
          const SizedBox(width: 29),
          Expanded(flex: 6, child: Text(leading, style: style)),
          Expanded(flex: 2, child: Text(middle, style: style)),
          Expanded(
            flex: 2,
            child: Align(
              alignment: Alignment.centerRight,
              child: Text(trailing, style: style),
            ),
          ),
          const SizedBox(width: 20),
        ],
      ),
    );
  }
}

class _RelationshipWorkspace extends StatelessWidget {
  const _RelationshipWorkspace({
    required this.nodes,
    required this.allNodes,
    required this.edges,
    required this.stats,
    required this.selectedId,
    required this.transform,
    required this.canRebuild,
    required this.onRebuild,
    required this.onSelect,
  });

  final List<GraphNode> nodes, allNodes;
  final List<GraphEdge> edges;
  final Json stats;
  final String? selectedId;
  final TransformationController transform;
  final bool canRebuild;
  final VoidCallback onRebuild;
  final ValueChanged<GraphNode> onSelect;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final visibleIds = nodes.map((node) => node.id).toSet();
    final visibleEdges = edges
        .where(
          (edge) =>
              visibleIds.contains(edge.source) &&
              visibleIds.contains(edge.target),
        )
        .toList();
    return Column(
      children: [
        Container(
          height: 44,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          decoration: BoxDecoration(
            color: mac.toolbar,
            border: Border(bottom: BorderSide(color: mac.divider)),
          ),
          child: Row(
            children: [
              _GraphMetric(
                value: '${stats['nodes'] ?? allNodes.length}',
                label: 'concepts',
              ),
              const SizedBox(width: 18),
              _GraphMetric(
                value: '${stats['edges'] ?? edges.length}',
                label: 'links',
              ),
              const SizedBox(width: 18),
              _GraphMetric(
                value: '${stats['communities'] ?? '—'}',
                label: 'groups',
              ),
              const Spacer(),
              Text(
                'Scroll to zoom · drag to pan',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              if (canRebuild) ...[
                const SizedBox(width: 10),
                TextButton.icon(
                  key: const Key('macos-knowledge-rebuild-graph'),
                  onPressed: onRebuild,
                  icon: const Icon(Icons.sync_rounded, size: 16),
                  label: const Text('Rebuild index'),
                ),
              ],
            ],
          ),
        ),
        Expanded(
          child: nodes.isEmpty
              ? const MacosEmptyState(
                  icon: Icons.hub_outlined,
                  title: 'No matching relationships',
                  message: 'The relationship index grows from durable memory and processed sources.',
                )
              : _RelationshipCanvas(
                  nodes: nodes.take(100).toList(),
                  edges: visibleEdges,
                  selectedId: selectedId,
                  transform: transform,
                  onSelect: onSelect,
                ),
        ),
      ],
    );
  }
}

class _RelationshipCanvas extends StatelessWidget {
  const _RelationshipCanvas({
    required this.nodes,
    required this.edges,
    required this.selectedId,
    required this.transform,
    required this.onSelect,
  });

  static const _canvasSize = Size(1280, 820);
  static const _nodeSize = Size(154, 48);
  final List<GraphNode> nodes;
  final List<GraphEdge> edges;
  final String? selectedId;
  final TransformationController transform;
  final ValueChanged<GraphNode> onSelect;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final positions = _layoutNodes(nodes);
    return Stack(
      children: [
        Positioned.fill(
          child: RepaintBoundary(
            child: InteractiveViewer(
              key: const Key('macos-knowledge-relationship-canvas'),
              transformationController: transform,
              constrained: false,
              minScale: .45,
              maxScale: 2.5,
              boundaryMargin: const EdgeInsets.all(360),
              interactionEndFrictionCoefficient: .00008,
              child: SizedBox.fromSize(
                size: _canvasSize,
                child: Stack(
                  children: [
                    Positioned.fill(
                      child: CustomPaint(
                        painter: _RelationshipPainter(
                          edges: edges,
                          positions: positions,
                          nodeSize: _nodeSize,
                          lineColor: mac.divider,
                          selectedId: selectedId,
                          accentColor: Theme.of(context).colorScheme.primary,
                        ),
                      ),
                    ),
                    for (final node in nodes)
                      Positioned(
                        left: positions[node.id]!.dx,
                        top: positions[node.id]!.dy,
                        width: _nodeSize.width,
                        height: _nodeSize.height,
                        child: _GraphNodeButton(
                          key: Key('macos-graph-node-${node.id}'),
                          node: node,
                          selected: node.id == selectedId,
                          onTap: () => onSelect(node),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
        Positioned(
          right: 12,
          top: 12,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surface,
              border: Border.all(color: mac.divider),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  tooltip: 'Zoom out',
                  onPressed: () => _scaleTransform(transform, .82),
                  icon: const Icon(Icons.remove_rounded, size: 17),
                ),
                IconButton(
                  tooltip: 'Reset view',
                  onPressed: () => transform.value = Matrix4.identity(),
                  icon: const Icon(
                    Icons.center_focus_strong_outlined,
                    size: 17,
                  ),
                ),
                IconButton(
                  tooltip: 'Zoom in',
                  onPressed: () => _scaleTransform(transform, 1.2),
                  icon: const Icon(Icons.add_rounded, size: 17),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  static Map<String, Offset> _layoutNodes(List<GraphNode> nodes) {
    final result = <String, Offset>{};
    const center = Offset(640, 410);
    const goldenAngle = 2.399963229728653;
    for (var index = 0; index < nodes.length; index++) {
      if (index == 0) {
        result[nodes[index].id] = Offset(
          center.dx - _nodeSize.width / 2,
          center.dy - _nodeSize.height / 2,
        );
        continue;
      }
      final radius = 72 + math.sqrt(index) * 54;
      final angle = index * goldenAngle;
      result[nodes[index].id] = Offset(
        center.dx + math.cos(angle) * radius - _nodeSize.width / 2,
        center.dy + math.sin(angle) * radius - _nodeSize.height / 2,
      );
    }
    return result;
  }

  static void _scaleTransform(
    TransformationController controller,
    double factor,
  ) {
    final current = controller.value.getMaxScaleOnAxis();
    final next = (current * factor).clamp(.45, 2.5);
    controller.value = Matrix4.diagonal3Values(next, next, 1);
  }
}

class _RelationshipPainter extends CustomPainter {
  const _RelationshipPainter({
    required this.edges,
    required this.positions,
    required this.nodeSize,
    required this.lineColor,
    required this.selectedId,
    required this.accentColor,
  });

  final List<GraphEdge> edges;
  final Map<String, Offset> positions;
  final Size nodeSize;
  final Color lineColor, accentColor;
  final String? selectedId;

  @override
  void paint(Canvas canvas, Size size) {
    for (final edge in edges) {
      final source = positions[edge.source];
      final target = positions[edge.target];
      if (source == null || target == null) continue;
      final selected = edge.source == selectedId || edge.target == selectedId;
      final paint = Paint()
        ..color = selected
            ? accentColor.withValues(alpha: .7)
            : lineColor.withValues(alpha: .8)
        ..strokeWidth = selected ? 1.8 : 1
        ..style = PaintingStyle.stroke;
      final start = source + Offset(nodeSize.width / 2, nodeSize.height / 2);
      final end = target + Offset(nodeSize.width / 2, nodeSize.height / 2);
      canvas.drawLine(start, end, paint);
    }
  }

  @override
  bool shouldRepaint(covariant _RelationshipPainter oldDelegate) =>
      oldDelegate.edges != edges ||
      oldDelegate.positions != positions ||
      oldDelegate.selectedId != selectedId ||
      oldDelegate.lineColor != lineColor ||
      oldDelegate.accentColor != accentColor;
}

class _GraphNodeButton extends StatelessWidget {
  const _GraphNodeButton({
    super.key,
    required this.node,
    required this.selected,
    required this.onTap,
  });

  final GraphNode node;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      selected: selected,
      label: '${node.label}, ${node.kind} relationship point',
      child: Material(
        color: selected ? scheme.primaryContainer : scheme.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8),
          side: BorderSide(
            color: selected ? scheme.primary : mac.divider,
            width: selected ? 1.5 : 1,
          ),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Row(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: _nodeColor(node.kind, mac, scheme),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        node.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.labelLarge,
                      ),
                      Text(
                        '${node.sourceCount} sources',
                        style: Theme.of(context).textTheme.labelSmall,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _GraphMetric extends StatelessWidget {
  const _GraphMetric({required this.value, required this.label});

  final String value, label;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Text(value, style: Theme.of(context).textTheme.titleSmall),
      const SizedBox(width: 4),
      Text(label, style: Theme.of(context).textTheme.bodySmall),
    ],
  );
}

class _KnowledgeInspector extends StatelessWidget {
  const _KnowledgeInspector({
    super.key,
    required this.workspace,
    required this.memory,
    required this.source,
    required this.node,
    required this.allNodes,
    required this.edges,
    required this.loadingMemory,
    required this.canMutate,
    required this.onCorrect,
    required this.onContradict,
    required this.onForget,
    required this.onSelectNode,
  });

  final _KnowledgeWorkspace workspace;
  final MemoryRecord? memory;
  final KnowledgeItem? source;
  final GraphNode? node;
  final List<GraphNode> allNodes;
  final List<GraphEdge> edges;
  final bool loadingMemory, canMutate;
  final VoidCallback? onCorrect, onContradict, onForget;
  final ValueChanged<String> onSelectNode;

  @override
  Widget build(BuildContext context) => switch (workspace) {
    _KnowledgeWorkspace.memories =>
      memory == null
          ? const _InspectorPlaceholder(
              icon: Icons.memory_outlined,
              title: 'Select a memory',
              message:
                  'Its claim, evidence, and lineage will remain visible here.',
            )
          : _MemoryInspector(
              memory: memory!,
              loading: loadingMemory,
              canMutate: canMutate,
              onCorrect: onCorrect,
              onContradict: onContradict,
              onForget: onForget,
            ),
    _KnowledgeWorkspace.sources =>
      source == null
          ? const _InspectorPlaceholder(
              icon: Icons.description_outlined,
              title: 'Select an indexed source',
              message:
                  'Review its origin, content, tags, and index coverage here.',
            )
          : _SourceInspector(source: source!),
    _KnowledgeWorkspace.relationships =>
      node == null
          ? const _InspectorPlaceholder(
              icon: Icons.hub_outlined,
              title: 'Select a relationship point',
              message:
                  'Its neighboring concepts and evidence will appear here.',
            )
          : _NodeInspector(
              node: node!,
              allNodes: allNodes,
              edges: edges,
              onSelectNode: onSelectNode,
            ),
  };
}

class _MemoryInspector extends StatelessWidget {
  const _MemoryInspector({
    required this.memory,
    required this.loading,
    required this.canMutate,
    required this.onCorrect,
    required this.onContradict,
    required this.onForget,
  });

  final MemoryRecord memory;
  final bool loading, canMutate;
  final VoidCallback? onCorrect, onContradict, onForget;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(20),
    children: [
      Row(
        children: [
          Expanded(
            child: Text(
              memory.title,
              style: Theme.of(context).textTheme.titleLarge,
            ),
          ),
          if (loading)
            const SizedBox.square(
              dimension: 15,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
        ],
      ),
      const SizedBox(height: 5),
      Text(
        '${_label(memory.category)} · ${_label(memory.tier)} · ${_label(memory.claimStatus)}',
        style: Theme.of(context).textTheme.bodySmall,
      ),
      const SizedBox(height: 18),
      _InspectorSection(title: 'Claim', child: SelectableText(memory.content)),
      const SizedBox(height: 18),
      _ConfidenceMeter(label: 'Confidence', value: memory.confidence),
      const SizedBox(height: 10),
      _ConfidenceMeter(label: 'Importance', value: memory.importance),
      const SizedBox(height: 18),
      _InspectorSection(
        title: 'Provenance',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _MetaLine(label: 'Asserted by', value: memory.assertedBy),
            _MetaLine(
              label: 'Source',
              value: memory.source.isEmpty ? 'Not recorded' : memory.source,
            ),
            _MetaLine(
              label: 'Evidence',
              value: '${memory.evidenceCount} links',
            ),
            if (memory.supersedesId != null)
              _MetaLine(label: 'Supersedes', value: memory.supersedesId!),
            if (memory.contradictionOfId != null)
              _MetaLine(label: 'Contradicts', value: memory.contradictionOfId!),
          ],
        ),
      ),
      if (memory.tags.isNotEmpty) ...[
        const SizedBox(height: 18),
        _InspectorSection(
          title: 'Tags',
          child: Wrap(
            spacing: 6,
            runSpacing: 6,
            children: memory.tags.map((tag) => Chip(label: Text(tag))).toList(),
          ),
        ),
      ],
      if (canMutate && memory.claimStatus != 'forgotten') ...[
        const SizedBox(height: 22),
        const Divider(),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: FilledButton.tonal(
                key: const Key('macos-memory-correct'),
                onPressed: onCorrect,
                child: const Text('Correct'),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: OutlinedButton(
                key: const Key('macos-memory-contradict'),
                onPressed: onContradict,
                child: const Text('Contradict'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        TextButton.icon(
          key: const Key('macos-memory-forget'),
          onPressed: onForget,
          icon: const Icon(Icons.delete_outline_rounded, size: 17),
          label: const Text('Forget this memory'),
          style: TextButton.styleFrom(
            foregroundColor: Theme.of(context).colorScheme.error,
          ),
        ),
      ],
    ],
  );
}

class _SourceInspector extends StatelessWidget {
  const _SourceInspector({required this.source});

  final KnowledgeItem source;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(20),
    children: [
      Text(source.title, style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: 5),
      Text(
        '${_label(source.category)} · ${_label(source.kind)}',
        style: Theme.of(context).textTheme.bodySmall,
      ),
      const SizedBox(height: 18),
      _InspectorSection(
        title: 'Origin',
        child: SelectableText(
          source.source.isEmpty ? 'Local knowledge' : source.source,
        ),
      ),
      const SizedBox(height: 18),
      Row(
        children: [
          Expanded(
            child: _CompactStat(
              value: '${source.chunkCount}',
              label: 'segments',
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: _CompactStat(
              value: _textSize(source.totalCharacters),
              label: 'indexed text',
            ),
          ),
        ],
      ),
      const SizedBox(height: 18),
      _InspectorSection(
        title: 'Indexed content',
        child: SelectableText(
          source.content.isEmpty ? 'No preview is available.' : source.content,
        ),
      ),
      if (source.tags.isNotEmpty) ...[
        const SizedBox(height: 18),
        _InspectorSection(
          title: 'Tags',
          child: Wrap(
            spacing: 6,
            runSpacing: 6,
            children: source.tags.map((tag) => Chip(label: Text(tag))).toList(),
          ),
        ),
      ],
    ],
  );
}

class _NodeInspector extends StatelessWidget {
  const _NodeInspector({
    required this.node,
    required this.allNodes,
    required this.edges,
    required this.onSelectNode,
  });

  final GraphNode node;
  final List<GraphNode> allNodes;
  final List<GraphEdge> edges;
  final ValueChanged<String> onSelectNode;

  @override
  Widget build(BuildContext context) {
    final nodeById = {for (final item in allNodes) item.id: item};
    final related = <({GraphNode node, GraphEdge edge})>[];
    for (final edge in edges) {
      final otherId = edge.source == node.id
          ? edge.target
          : edge.target == node.id
          ? edge.source
          : null;
      final other = otherId == null ? null : nodeById[otherId];
      if (other != null) related.add((node: other, edge: edge));
    }
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(node.label, style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 5),
        Text(
          '${_label(node.kind)} · ${node.sourceCount} sources · weight ${node.weight.toStringAsFixed(2)}',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 18),
        _InspectorSection(
          title: 'Summary',
          child: SelectableText(
            node.summary.isEmpty ? 'No summary is available.' : node.summary,
          ),
        ),
        const SizedBox(height: 18),
        _InspectorSection(
          title: 'Connected concepts (${related.length})',
          child: related.isEmpty
              ? Text(
                  'No direct relationships in this view.',
                  style: Theme.of(context).textTheme.bodySmall,
                )
              : Column(
                  children: [
                    for (final item in related.take(24))
                      Material(
                        color: Colors.transparent,
                        child: ListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          title: Text(item.node.label),
                          subtitle: Text(_label(item.edge.relation)),
                          trailing: Text(
                            item.edge.weight.toStringAsFixed(2),
                            style: Theme.of(context).textTheme.labelSmall,
                          ),
                          onTap: () => onSelectNode(item.node.id),
                        ),
                      ),
                  ],
                ),
        ),
        if (node.tags.isNotEmpty) ...[
          const SizedBox(height: 18),
          _InspectorSection(
            title: 'Tags',
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: node.tags.map((tag) => Chip(label: Text(tag))).toList(),
            ),
          ),
        ],
      ],
    );
  }
}

class _InspectorPlaceholder extends StatelessWidget {
  const _InspectorPlaceholder({
    required this.icon,
    required this.title,
    required this.message,
  });

  final IconData icon;
  final String title, message;

  @override
  Widget build(BuildContext context) =>
      MacosEmptyState(icon: icon, title: title, message: message);
}

class _InspectorSection extends StatelessWidget {
  const _InspectorSection({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(title, style: Theme.of(context).textTheme.titleSmall),
      const SizedBox(height: 7),
      DefaultTextStyle.merge(
        style: Theme.of(context).textTheme.bodyMedium,
        child: child,
      ),
    ],
  );
}

class _ConfidenceMeter extends StatelessWidget {
  const _ConfidenceMeter({required this.label, required this.value});

  final String label;
  final double value;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      Row(
        children: [
          Expanded(child: Text(label)),
          Text(
            '${(value * 100).round()}%',
            style: Theme.of(context).textTheme.labelLarge,
          ),
        ],
      ),
      const SizedBox(height: 5),
      LinearProgressIndicator(value: value.clamp(0, 1), minHeight: 4),
    ],
  );
}

class _MetaLine extends StatelessWidget {
  const _MetaLine({required this.label, required this.value});

  final String label, value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 7),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 90,
          child: Text(label, style: Theme.of(context).textTheme.bodySmall),
        ),
        Expanded(child: SelectableText(value)),
      ],
    ),
  );
}

class _CompactStat extends StatelessWidget {
  const _CompactStat({required this.value, required this.label});

  final String value, label;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: mac.hover,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: mac.divider),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value, style: Theme.of(context).textTheme.titleMedium),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _MacosMemoryDialog extends StatefulWidget {
  const _MacosMemoryDialog({this.memory, this.contradiction = false});

  final MemoryRecord? memory;
  final bool contradiction;

  @override
  State<_MacosMemoryDialog> createState() => _MacosMemoryDialogState();
}

class _MacosMemoryDialogState extends State<_MacosMemoryDialog> {
  final _formKey = GlobalKey<FormState>();
  late final _title = TextEditingController(text: widget.memory?.title);
  late final _content = TextEditingController(text: widget.memory?.content);
  late final _tags = TextEditingController(
    text: widget.memory?.tags.join(', '),
  );
  late String _type = widget.memory?.type ?? 'fact';
  late double _importance = widget.memory?.importance ?? .7;
  late double _confidence = widget.memory?.confidence ?? .8;

  @override
  void dispose() {
    _title.dispose();
    _content.dispose();
    _tags.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(
      widget.memory == null
          ? 'New memory'
          : widget.contradiction
          ? 'Record a contradiction'
          : 'Correct memory',
    ),
    content: SizedBox(
      width: 600,
      child: Form(
        key: _formKey,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextFormField(
                key: const Key('macos-memory-title'),
                controller: _title,
                autofocus: true,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(labelText: 'Title'),
                validator: (value) => value == null || value.trim().isEmpty
                    ? 'Give this memory a title.'
                    : null,
              ),
              const SizedBox(height: 10),
              TextFormField(
                key: const Key('macos-memory-content'),
                controller: _content,
                minLines: 5,
                maxLines: 9,
                decoration: const InputDecoration(
                  labelText: 'What should Asael remember?',
                  alignLabelWithHint: true,
                ),
                validator: (value) => value == null || value.trim().isEmpty
                    ? 'Memory content cannot be empty.'
                    : null,
              ),
              if (widget.memory == null) ...[
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: DropdownButtonFormField<String>(
                        initialValue: _type,
                        decoration: const InputDecoration(labelText: 'Kind'),
                        items:
                            const [
                                  'preference',
                                  'fact',
                                  'episode',
                                  'procedure',
                                  'knowledge',
                                  'decision',
                                  'task',
                                ]
                                .map(
                                  (value) => DropdownMenuItem(
                                    value: value,
                                    child: Text(_label(value)),
                                  ),
                                )
                                .toList(),
                        onChanged: (value) {
                          if (value != null) setState(() => _type = value);
                        },
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: TextFormField(
                        controller: _tags,
                        decoration: const InputDecoration(
                          labelText: 'Tags, comma separated',
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                _DialogSlider(
                  label: 'Importance',
                  value: _importance,
                  onChanged: (value) => setState(() => _importance = value),
                ),
              ],
              const SizedBox(height: 10),
              _DialogSlider(
                label: 'Confidence',
                value: _confidence,
                onChanged: (value) => setState(() => _confidence = value),
              ),
            ],
          ),
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        key: const Key('macos-memory-save'),
        onPressed: _save,
        child: Text(widget.contradiction ? 'Record contradiction' : 'Save'),
      ),
    ],
  );

  void _save() {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final value = <String, dynamic>{
      'title': _title.text.trim(),
      'content': _content.text.trim(),
      'confidence': _confidence,
    };
    if (widget.memory == null) {
      value.addAll({
        'type': _type,
        'tags': _tags.text
            .split(',')
            .map((tag) => tag.trim())
            .where((tag) => tag.isNotEmpty)
            .toList(),
        'importance': _importance,
        'evidenceRefs': <String>[],
      });
    } else if (widget.contradiction) {
      value['contradiction'] = true;
    }
    Navigator.pop(context, value);
  }
}

class _DialogSlider extends StatelessWidget {
  const _DialogSlider({
    required this.label,
    required this.value,
    required this.onChanged,
  });

  final String label;
  final double value;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      SizedBox(width: 90, child: Text(label)),
      Expanded(
        child: Slider(value: value, onChanged: onChanged),
      ),
      SizedBox(
        width: 42,
        child: Text(
          '${(value * 100).round()}%',
          textAlign: TextAlign.right,
          style: Theme.of(context).textTheme.labelLarge,
        ),
      ),
    ],
  );
}

MemoryRecord? _findMemory(List<MemoryRecord> values, String? id) {
  if (values.isEmpty) return null;
  if (id == null) return values.first;
  for (final value in values) {
    if (value.id == id) return value;
  }
  return values.first;
}

KnowledgeItem? _findSource(List<KnowledgeItem> values, String? id) {
  if (values.isEmpty) return null;
  if (id == null) return values.first;
  for (final value in values) {
    if (value.id == id) return value;
  }
  return values.first;
}

GraphNode? _findNode(List<GraphNode> values, String? id) {
  if (values.isEmpty) return null;
  if (id == null) return values.first;
  for (final value in values) {
    if (value.id == id) return value;
  }
  return values.first;
}

Color _nodeColor(String kind, MacosThemeColors mac, ColorScheme scheme) =>
    switch (kind.toLowerCase()) {
      'system' || 'systems' => scheme.primary,
      'tag' || 'tags' => mac.warning,
      'tool' || 'tools' => scheme.error,
      'workflow' || 'workflows' => scheme.tertiary,
      _ => mac.positive,
    };

String _label(String value) => value
    .replaceAll('_', ' ')
    .split(' ')
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');

String _textSize(int characters) {
  if (characters >= 1000000) {
    return '${(characters / 1000000).toStringAsFixed(1)}M chars';
  }
  if (characters >= 1000) {
    return '${(characters / 1000).toStringAsFixed(1)}K chars';
  }
  return '$characters chars';
}
