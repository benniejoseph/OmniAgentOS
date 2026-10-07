import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
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

enum _KnowledgeWorkspace {
  memories,
  sources,
  reviews,
  relationships,
  recall,
  promotions,
  sourceMaps,
  sourceCleanup,
  graphExplorer,
  privateActions,
}

/// A desktop knowledge browser for macOS.
///
/// This presenter deliberately keeps the portable controller and repository as
/// the source of truth. It replaces the touch-first cards and modal sheets with
/// searchable indexes, a stable relationship canvas, and a persistent
/// inspector suited to a resizable Mac window.
class MacosKnowledgeView extends StatefulWidget {
  const MacosKnowledgeView({
    super.key,
    required this.controller,
    this.initialMemoryId,
  });

  final KnowledgeController controller;
  final String? initialMemoryId;

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

  @override
  void initState() {
    super.initState();
    _searchController.text = widget.controller.query;
    _selectedMemoryId = widget.initialMemoryId;
    if (widget.controller.state == null) widget.controller.refresh();
  }

  @override
  void didUpdateWidget(covariant MacosKnowledgeView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller) ||
        oldWidget.initialMemoryId != widget.initialMemoryId) {
      _selectedMemoryId = widget.initialMemoryId;
      _selectedSourceId = null;
      _selectedNodeId = null;
      _category = 'all';
      _workspace = _KnowledgeWorkspace.memories;
      _searchController.text = widget.controller.query;
      _graphTransform.value = Matrix4.identity();
    }
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
      if (!controller.available) {
        return const Center(
          child: Text('Sign in to read memory and knowledge.'),
        );
      }
      if (MediaQuery.sizeOf(context).width < 960 ||
          MediaQuery.textScalerOf(context).scale(1) >= 1.5) {
        return KnowledgeView(
          controller: controller,
          initialMemoryId: _selectedMemoryId,
        );
      }
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
        title: 'Memory',
        description: 'Browse what Asael remembers, inspect its sources, and trace relationships.',
        icon: Icons.account_tree_outlined,
        actions: [
          if (controller.pendingChange != null ||
              controller.acceptedChange != null ||
              controller.recoveryError != null)
            OutlinedButton(
              onPressed: () => showDialog<void>(
                context: context,
                builder: (_) => Dialog(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 640),
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          MemoryChangeStatus(controller: controller),
                          Builder(
                            builder: (dialogContext) => TextButton(
                              onPressed: () =>
                                  Navigator.of(dialogContext).pop(),
                              child: const Text('Close receipt'),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              child: const Text('Memory submission'),
            ),
          if (controller.supportsChange(MemoryChange.create))
            OutlinedButton.icon(
              onPressed: controller.pendingChange != null
                  ? null
                  : () => showMemoryEditor(context, controller),
              icon: const Icon(Icons.add),
              label: const Text('Add private memory'),
            ),
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
        inspectorWidth: 390,
        inspectorMinWidth: 320,
        inspectorMaxWidth: 540,
        inspector:
            _workspace == _KnowledgeWorkspace.relationships &&
                controller.advancedGraphAvailable
            ? null
            : _workspace == _KnowledgeWorkspace.memories &&
                  _selectedMemoryId != null
            ? KnowledgeMemoryInspector(
                key: ValueKey(_selectedMemoryId),
                controller: controller,
                memoryId: _selectedMemoryId!,
              )
            : _KnowledgeInspector(
                key: const Key('macos-knowledge-inspector'),
                workspace: _workspace,
                source: selectedSource,
                node: selectedNode,
                allNodes: state?.nodes ?? const [],
                edges: state?.edges ?? const [],
                onSelectNode: (id) => setState(() => _selectedNodeId = id),
              ),
        body: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(12),
              child: _KnowledgeToolbar(
                workspace: _workspace,
                searchController: _searchController,
                category: _categoriesFor(state).contains(_category)
                    ? _category
                    : 'all',
                categories: _categoriesFor(state),
                visibleCount: switch (_workspace) {
                  _KnowledgeWorkspace.memories => memories.length,
                  _KnowledgeWorkspace.sources => sources.length,
                  _KnowledgeWorkspace.relationships => nodes.length,
                  _KnowledgeWorkspace.reviews => 0,
                  _KnowledgeWorkspace.recall => 0,
                  _KnowledgeWorkspace.promotions => 0,
                  _KnowledgeWorkspace.sourceMaps => 0,
                  _KnowledgeWorkspace.sourceCleanup => 0,
                  _KnowledgeWorkspace.graphExplorer => 0,
                  _KnowledgeWorkspace.privateActions => 0,
                },
                onWorkspaceChanged: _selectWorkspace,
                onSearchChanged: (_) => setState(() {}),
                onSearchSubmitted: widget.controller.search,
                onClearSearch: _clearSearch,
                onCategoryChanged: (value) => setState(() => _category = value),
              ),
            ),
            Expanded(
              child: _buildBody(
                state: state,
                memories: memories,
                sources: sources,
                nodes: nodes,
                selectedMemory: selectedMemory,
                selectedSource: selectedSource,
                selectedNode: selectedNode,
              ),
            ),
          ],
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
    if (_workspace == _KnowledgeWorkspace.relationships &&
        controller.advancedGraphAvailable)
      return KnowledgeRelationshipMap(
        controller: controller,
        onOpenMemory: (memory) => setState(() {
          _workspace = _KnowledgeWorkspace.memories;
          _selectedMemoryId = memory.id;
        }),
        onOpenSource: (source) => setState(() {
          _workspace = _KnowledgeWorkspace.sources;
          _selectedSourceId = source.id;
        }),
      );
    if (_workspace == _KnowledgeWorkspace.recall) {
      return KnowledgePersonalRecall(controller: controller);
    }
    if (_workspace == _KnowledgeWorkspace.promotions) {
      return KnowledgePromotions(controller: controller);
    }
    if (_workspace == _KnowledgeWorkspace.sourceMaps) {
      return KnowledgeSourceMaps(controller: controller);
    }
    if (_workspace == _KnowledgeWorkspace.sourceCleanup) {
      return KnowledgeSourceCleanup(controller: controller);
    }
    if (_workspace == _KnowledgeWorkspace.graphExplorer) {
      return KnowledgeGraphExplorer(controller: controller);
    }
    if (_workspace == _KnowledgeWorkspace.privateActions) {
      return KnowledgeOperations(controller: controller);
    }
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
      _KnowledgeWorkspace.memories => Column(
        children: [
          KnowledgeCoverage(controller: controller),
          KnowledgeMemoryFilters(controller: controller),
          Expanded(
            child: _MemoryIndex(
              memories: memories,
              selectedId: selectedMemory?.id,
              filtered: _isFiltered,
              onSelect: _selectMemory,
              onClearFilters: _resetFilters,
            ),
          ),
          KnowledgePageControls(controller: controller, memory: true),
        ],
      ),
      _KnowledgeWorkspace.sources => Column(
        children: [
          KnowledgeCoverage(controller: controller),
          Expanded(
            child: _SourceIndex(
              sources: sources,
              selectedId: selectedSource?.id,
              filtered: _isFiltered,
              onSelect: (source) =>
                  setState(() => _selectedSourceId = source.id),
              onClearFilters: _resetFilters,
            ),
          ),
          KnowledgePageControls(controller: controller, memory: false),
        ],
      ),
      _KnowledgeWorkspace.reviews => KnowledgeReviews(controller: controller),
      _KnowledgeWorkspace.recall => KnowledgePersonalRecall(
        controller: controller,
      ),
      _KnowledgeWorkspace.promotions => KnowledgePromotions(
        controller: controller,
      ),
      _KnowledgeWorkspace.sourceMaps => KnowledgeSourceMaps(
        controller: controller,
      ),
      _KnowledgeWorkspace.sourceCleanup => KnowledgeSourceCleanup(
        controller: controller,
      ),
      _KnowledgeWorkspace.graphExplorer => KnowledgeGraphExplorer(
        controller: controller,
      ),
      _KnowledgeWorkspace.privateActions => KnowledgeOperations(
        controller: controller,
      ),
      _KnowledgeWorkspace.relationships => Column(
        children: [
          KnowledgeCoverage(controller: controller, graph: true),
          Expanded(
            child: _RelationshipWorkspace(
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
          ),
        ],
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
      _KnowledgeWorkspace.reviews => const <String>[],
      _KnowledgeWorkspace.recall => const <String>[],
      _KnowledgeWorkspace.promotions => const <String>[],
      _KnowledgeWorkspace.sourceMaps => const <String>[],
      _KnowledgeWorkspace.sourceCleanup => const <String>[],
      _KnowledgeWorkspace.graphExplorer => const <String>[],
      _KnowledgeWorkspace.privateActions => const <String>[],
      _KnowledgeWorkspace.relationships =>
        (state?.nodes ?? const <GraphNode>[]).map((item) => item.kind),
    };
    return values.where((value) => value.trim().isNotEmpty).toSet().toList()
      ..sort();
  }

  List<MemoryRecord> _visibleMemories(List<MemoryRecord> source) {
    final query = _searchController.text.trim().toLowerCase();
    return source.where((item) {
      if (widget.controller.claimState == 'all' &&
          memoryRetiredPlaceholder(item.title))
        return false;
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

  void _selectMemory(MemoryRecord memory) {
    setState(() => _selectedMemoryId = memory.id);
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
      return Wrap(
        spacing: 12,
        runSpacing: 12,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            key: const Key('macos-knowledge-workspace'),
            children: [
              for (final entry in const {
                _KnowledgeWorkspace.memories: 'Memory',
                _KnowledgeWorkspace.sources: 'Sources',
                _KnowledgeWorkspace.reviews: 'Reviews',
                _KnowledgeWorkspace.relationships: 'Relationships',
                _KnowledgeWorkspace.recall: 'Personal recall',
                _KnowledgeWorkspace.promotions: 'Promotions',
                _KnowledgeWorkspace.sourceMaps: 'Source maps',
                _KnowledgeWorkspace.sourceCleanup: 'Source cleanup',
                _KnowledgeWorkspace.graphExplorer: 'Advanced graph',
                _KnowledgeWorkspace.privateActions: 'Maintenance',
              }.entries)
                ChoiceChip(
                  label: Text(entry.value),
                  selected: workspace == entry.key,
                  materialTapTargetSize: MaterialTapTargetSize.padded,
                  visualDensity: VisualDensity.standard,
                  padding: const EdgeInsets.symmetric(
                    vertical: 10,
                    horizontal: 4,
                  ),
                  onSelected: (_) => onWorkspaceChanged({entry.key}),
                ),
            ],
          ),
          if (workspace != _KnowledgeWorkspace.recall &&
              workspace != _KnowledgeWorkspace.promotions &&
              workspace != _KnowledgeWorkspace.sourceMaps &&
              workspace != _KnowledgeWorkspace.sourceCleanup &&
              workspace != _KnowledgeWorkspace.relationships &&
              workspace != _KnowledgeWorkspace.graphExplorer &&
              workspace != _KnowledgeWorkspace.privateActions) ...[
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
                    _KnowledgeWorkspace.reviews => 'Search catalogue',
                    _KnowledgeWorkspace.recall => 'Personal recall',
                    _KnowledgeWorkspace.promotions => 'Promotion reviews',
                    _KnowledgeWorkspace.sourceMaps => 'Source-map reviews',
                    _KnowledgeWorkspace.sourceCleanup => 'Local source cleanup',
                    _KnowledgeWorkspace.graphExplorer =>
                      'Private graph explorer',
                    _KnowledgeWorkspace.privateActions =>
                      'Private Memory actions',
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
                  const DropdownMenuItem(
                    value: 'all',
                    child: Text('All kinds'),
                  ),
                  ...categories.map(
                    (value) => DropdownMenuItem(
                      value: value,
                      child: Text(
                        _label(value),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ),
                ],
                onChanged: (value) {
                  if (value != null) onCategoryChanged(value);
                },
              ),
            ),
            if (!compact)
              Text(
                '$visibleCount visible',
                style: Theme.of(context).textTheme.bodySmall,
              ),
          ],
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
          leading: 'Memory',
          middle: 'Kind',
          trailing: 'Status',
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
      label:
          '${memoryDisplayTitle(memory.title, memory.updatedAt)}, ${memoryFriendlyLabel(memory.category)} memory',
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
                        memoryDisplayTitle(memory.title, memory.updatedAt),
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
                    memoryFriendlyLabel(memory.tier),
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
                      memoryFriendlyLabel(memory.claimStatus),
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
    required this.source,
    required this.node,
    required this.allNodes,
    required this.edges,
    required this.onSelectNode,
  });

  final _KnowledgeWorkspace workspace;
  final KnowledgeItem? source;
  final GraphNode? node;
  final List<GraphNode> allNodes;
  final List<GraphEdge> edges;
  final ValueChanged<String> onSelectNode;

  @override
  Widget build(BuildContext context) => switch (workspace) {
    _KnowledgeWorkspace.memories => const _InspectorPlaceholder(
      icon: Icons.memory_outlined,
      title: 'Select a memory',
      message: 'Read its exact current claim, provenance, and lifecycle.',
    ),
    _KnowledgeWorkspace.reviews => const _InspectorPlaceholder(
      icon: Icons.fact_check_outlined,
      title: 'Exact private reviews',
      message: 'Inspect the candidate and existing claim. A current decision token and explicit review are required; downstream projections remain separate.',
    ),
    _KnowledgeWorkspace.recall => const _InspectorPlaceholder(
      icon: Icons.privacy_tip_outlined,
      title: 'Your personal recall choice',
      message: 'Read the current notice and explicitly enable or disable personal automatic recall. A saved decision receipt is separate from the latest setting.',
    ),
    _KnowledgeWorkspace.promotions => const _InspectorPlaceholder(
      icon: Icons.rule_outlined,
      title: 'Review repeated evidence',
      message: 'Inspect the canonical content and exact source identities before promoting or dismissing. A saved decision remains separate from downstream projections.',
    ),
    _KnowledgeWorkspace.sourceMaps => const _InspectorPlaceholder(
      icon: Icons.account_tree_outlined,
      title: 'Review private source maps',
      message: 'Inspect exact source evidence and retention before confirming or dismissing a candidate. Saved decisions and relationship projections are separate.',
    ),
    _KnowledgeWorkspace.sourceCleanup => const _InspectorPlaceholder(
      icon: Icons.delete_outline,
      title: 'Review local source cleanup',
      message: 'Inspect the complete bounded manifest before deleting private imports. Upstream sources remain unchanged and future imports may reappear.',
    ),
    _KnowledgeWorkspace.graphExplorer => const _InspectorPlaceholder(
      icon: Icons.travel_explore,
      title: 'Explore current private evidence',
      message: 'Select an exact node or entity, inspect temporal revisions, or trace a bounded relationship path. Graph reads never start maintenance or other actions.',
    ),
    _KnowledgeWorkspace.privateActions => const _InspectorPlaceholder(
      icon: Icons.fact_check_outlined,
      title: 'Review before running',
      message: 'Maintenance, graph rebuilds and model builds use an exact current plan. Saved acceptance and current processing are separate; recovery never repeats an uncertain action.',
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

class _SourceInspector extends StatelessWidget {
  const _SourceInspector({required this.source});

  final KnowledgeItem source;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(20),
    children: [
      Text(source.title, style: Theme.of(context).textTheme.titleLarge),
      SelectableText(source.id),
      Text(
        'Canonical lineage: ${source.hasCanonicalLineage ? "reported" : "not reported"}',
      ),
      Text('Indexed: ${source.indexedAt?.toIso8601String() ?? "not reported"}'),
      const Text(
        'Catalogue metadata only. Use Source cleanup to review deletion of eligible private local imports.',
      ),
      const SizedBox(height: 5),
      Text(
        '${_label(source.category)} · ${_label(source.kind)}',
        style: Theme.of(context).textTheme.bodySmall,
      ),
      const SizedBox(height: 18),
      _InspectorSection(
        title: 'Origin',
        child: SelectableText(
          source.source.isEmpty ? 'Origin not reported' : source.source,
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
        SelectableText(node.id),
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
        Text(
          'Showing at most 24 neighbors from this relationship sample. Links outside the sample are not shown.',
        ),
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
                          subtitle: Text(
                            '${_label(item.edge.relation)}\n${item.node.id}',
                          ),
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

MemoryRecord? _findMemory(List<MemoryRecord> values, String? id) {
  if (values.isEmpty) return null;
  if (id == null) return null;
  for (final value in values) {
    if (value.id == id) return value;
  }
  return null;
}

KnowledgeItem? _findSource(List<KnowledgeItem> values, String? id) {
  if (values.isEmpty) return null;
  if (id == null) return values.first;
  for (final value in values) {
    if (value.id == id) return value;
  }
  return null;
}

GraphNode? _findNode(List<GraphNode> values, String? id) {
  if (values.isEmpty) return null;
  if (id == null) return values.first;
  for (final value in values) {
    if (value.id == id) return value;
  }
  return null;
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
