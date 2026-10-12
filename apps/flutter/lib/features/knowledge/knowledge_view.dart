import 'package:flutter/material.dart';

import '../../app/mobile/mobile_page_scaffold.dart';
import '../../app/platform/mobile_presentation.dart';
import 'knowledge.dart';
import 'knowledge_labels.dart';
import 'knowledge_relationship_map.dart';
import 'knowledge_landscape.dart';
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
  String? _selectedMemoryId, _selectedNodeId, _selectedSourceId;
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
      _selectedSourceId = null;
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
      if (usesMobilePresentation()) return _mobileWorkspace(state);
      return Scaffold(
        appBar: AppBar(
          title: const Text(
            'Library',
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

  Widget _mobileWorkspace(KnowledgeState? state) {
    final controller = widget.controller;
    final secondary = !const [0, 1, 3].contains(_tabs.index);
    final title = switch (_tabs.index) {
      2 => 'Review memories',
      4 => 'Personal recall',
      5 => 'Promote knowledge',
      6 => 'Source maps',
      7 => 'Source cleanup',
      8 => 'Explore relationships',
      9 => 'Knowledge maintenance',
      _ => 'Memory',
    };
    final selectedSource = state?.knowledge
        .where((item) => item.id == _selectedSourceId)
        .firstOrNull;
    final inspector = _selectedMemoryId != null && _tabs.index == 0;
    return Column(
      children: [
        MobilePageHeader(
          title: inspector
              ? 'Saved memory'
              : _selectedSourceId != null && _tabs.index == 1
              ? 'Saved source'
              : title,
          subtitle: inspector || secondary || _selectedSourceId != null
              ? null
              : 'What you know. Where it comes from.',
          leading: inspector || secondary || _selectedSourceId != null
              ? BackButton(
                  onPressed: () => setState(() {
                    _selectedMemoryId = _selectedSourceId = null;
                    if (secondary) _tabs.index = 0;
                  }),
                )
              : null,
          actions: [
            if (!inspector &&
                !secondary &&
                controller.supportsChange(MemoryChange.create))
              IconButton.filledTonal(
                tooltip: 'Add memory',
                onPressed: controller.pendingChange != null
                    ? null
                    : () => showMemoryEditor(context, controller),
                icon: const Icon(Icons.add_rounded),
              ),
            PopupMenuButton<int>(
              tooltip: 'Memory tools',
              icon: const Icon(Icons.more_horiz_rounded),
              onSelected: (value) {
                if (value == -1) {
                  controller.refresh();
                } else {
                  setState(() {
                    _selectedMemoryId = _selectedSourceId = null;
                    _tabs.index = value;
                  });
                }
              },
              itemBuilder: (_) => [
                const PopupMenuItem(value: -1, child: Text('Refresh memory')),
                for (final (index, name) in [
                  (2, 'Review memories'),
                  (4, 'Personal recall'),
                  (5, 'Promote knowledge'),
                  (6, 'Source maps'),
                  (7, 'Source cleanup'),
                  (8, 'Explore relationships'),
                  (9, 'Maintenance'),
                ])
                  PopupMenuItem(value: index, child: Text(name)),
              ],
            ),
          ],
        ),
        if (!secondary && !inspector && _selectedSourceId == null)
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                MobileSegmentBar<int>(
                  items: const [
                    (
                      value: 0,
                      label: 'Memories',
                      icon: Icons.bookmark_border_rounded,
                    ),
                    (
                      value: 1,
                      label: 'Sources',
                      icon: Icons.menu_book_outlined,
                    ),
                    (value: 3, label: 'Map', icon: Icons.hub_outlined),
                  ],
                  value: _tabs.index,
                  onChanged: (value) => setState(() => _tabs.index = value),
                ),
                if (_tabs.index < 2) ...[
                  const SizedBox(height: 16),
                  TextField(
                    controller: _search,
                    textInputAction: TextInputAction.search,
                    onSubmitted: controller.search,
                    decoration: InputDecoration(
                      hintText: _tabs.index == 0
                          ? 'Find a memory'
                          : 'Find a saved source',
                      prefixIcon: const Icon(Icons.search_rounded),
                      suffixIcon: IconButton(
                        tooltip: 'Search',
                        onPressed: () => controller.search(_search.text),
                        icon: const Icon(Icons.arrow_forward_rounded),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        Expanded(
          child: inspector
              ? KnowledgeMemoryInspector(
                  key: ValueKey(_selectedMemoryId),
                  controller: controller,
                  memoryId: _selectedMemoryId!,
                  onClose: () => setState(() => _selectedMemoryId = null),
                )
              : _tabs.index == 1 && _selectedSourceId != null
              ? selectedSource == null
                    ? const Center(
                        child: Text(
                          'This source is no longer in the current collection. Refresh or return to Sources.',
                        ),
                      )
                    : _mobileSourceDetail(selectedSource)
              : switch (_tabs.index) {
                  0 =>
                    state == null
                        ? _catalogueUnavailable()
                        : _mobileMemories(state),
                  1 =>
                    state == null
                        ? _catalogueUnavailable()
                        : _mobileSources(state),
                  2 => KnowledgeReviews(controller: controller),
                  3 =>
                    state == null ? _catalogueUnavailable() : _universe(state),
                  4 => KnowledgePersonalRecall(
                    controller: controller,
                    active: true,
                  ),
                  5 => KnowledgePromotions(
                    controller: controller,
                    active: true,
                  ),
                  6 => KnowledgeSourceMaps(
                    controller: controller,
                    active: true,
                  ),
                  7 => KnowledgeSourceCleanup(
                    controller: controller,
                    active: true,
                  ),
                  8 => KnowledgeGraphExplorer(
                    controller: controller,
                    active: true,
                  ),
                  _ => KnowledgeOperations(
                    controller: controller,
                    active: true,
                  ),
                },
        ),
      ],
    );
  }

  Widget _mobileMemories(KnowledgeState state) {
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
        .toList(growable: false);
    return CustomScrollView(
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      slivers: [
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (widget.controller.loading) const LinearProgressIndicator(),
                if (widget.controller.error != null)
                  const Padding(
                    padding: EdgeInsets.only(bottom: 12),
                    child: Text(
                      'Memory could not refresh. Your last loaded collection is shown.',
                    ),
                  ),
                MemoryChangeStatus(controller: widget.controller),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        'Your personal collection',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                    IconButton(
                      tooltip: 'Memory filters',
                      icon: const Icon(Icons.tune_rounded),
                      onPressed: () => showMobileSheet<void>(
                        context: context,
                        title: 'Refine your memories',
                        builder: (_) => ListenableBuilder(
                          listenable: widget.controller,
                          builder: (context, _) => KnowledgeMemoryFilters(
                            controller: widget.controller,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                MobileSegmentBar<String>(
                  items: [
                    (value: 'all', label: 'All', icon: null),
                    for (final type in types)
                      (
                        value: type,
                        label: memoryFriendlyLabel(type),
                        icon: null,
                      ),
                  ],
                  value: selectedType,
                  onChanged: (value) => setState(() => _memoryType = value),
                ),
                if (values.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 36),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(Icons.bookmark_border_rounded, size: 36),
                        const SizedBox(height: 16),
                        Text(
                          'A little context goes a long way.',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 8),
                        const Text(
                          'Add something worth remembering, or try a different search or category.',
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          sliver: SliverList.builder(
            itemCount: values.length,
            itemBuilder: (context, index) {
              final memory = values[index];
              return _mobileCollectionRow(
                icon: Icons.bookmark_border_rounded,
                title: memoryDisplayTitle(memory.title, memory.updatedAt),
                preview: memory.content,
                category: memoryFriendlyLabel(memory.type),
                detail:
                    '${memory.evidenceCount} ${memory.evidenceCount == 1 ? 'source' : 'sources'} · ${memoryFriendlyDate(memory.updatedAt)}',
                status: memory.claimStatus == 'active'
                    ? null
                    : memoryFriendlyLabel(memory.claimStatus),
                onTap: () => setState(() => _selectedMemoryId = memory.id),
              );
            },
          ),
        ),
        SliverToBoxAdapter(
          child: KnowledgePageControls(
            controller: widget.controller,
            memory: true,
          ),
        ),
        const SliverPadding(padding: EdgeInsets.only(bottom: 24)),
      ],
    );
  }

  Widget _mobileCollectionRow({
    required IconData icon,
    required String title,
    required String preview,
    required String category,
    required String detail,
    required VoidCallback onTap,
    String? status,
  }) {
    final theme = Theme.of(context);
    final excerpt = preview.length > 600 ? preview.substring(0, 600) : preview;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(18),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(icon, size: 18, color: theme.colorScheme.primary),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        category,
                        style: theme.textTheme.labelMedium?.copyWith(
                          color: theme.colorScheme.primary,
                        ),
                      ),
                    ),
                    const Icon(Icons.arrow_outward_rounded, size: 18),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  title,
                  style: theme.textTheme.titleMedium,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                ),
                if (excerpt.trim().isNotEmpty &&
                    excerpt.trim() != title.trim()) ...[
                  const SizedBox(height: 8),
                  Text(
                    excerpt.trim(),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                      height: 1.45,
                    ),
                  ),
                ],
                const SizedBox(height: 16),
                if (status != null) ...[
                  MobileStatusPill(label: status),
                  const SizedBox(height: 8),
                ],
                Text(detail, style: theme.textTheme.bodySmall),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _mobileSources(KnowledgeState state) => CustomScrollView(
    keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
    slivers: [
      SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (widget.controller.loading) const LinearProgressIndicator(),
              if (widget.controller.error != null)
                const Text(
                  'Sources could not refresh. Your last loaded collection is shown.',
                ),
              Text(
                'The story behind your knowledge',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 6),
              const Text('Documents, conversations and saved references.'),
            ],
          ),
        ),
      ),
      if (state.knowledge.isEmpty)
        const SliverToBoxAdapter(
          child: Padding(
            padding: EdgeInsets.all(32),
            child: Text('No saved sources match this search.'),
          ),
        ),
      SliverPadding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        sliver: SliverList.builder(
          itemCount: state.knowledge.length,
          itemBuilder: (context, index) {
            final source = state.knowledge[index];
            return _mobileCollectionRow(
              icon: Icons.description_outlined,
              title: source.title,
              preview: source.content,
              category: memoryFriendlyLabel(source.category),
              detail: memoryFriendlyDate(source.indexedAt),
              onTap: () => setState(() => _selectedSourceId = source.id),
            );
          },
        ),
      ),
      SliverToBoxAdapter(
        child: KnowledgePageControls(
          controller: widget.controller,
          memory: false,
        ),
      ),
      const SliverPadding(padding: EdgeInsets.only(bottom: 24)),
    ],
  );

  Widget _mobileSourceDetail(KnowledgeItem source) => ListView(
    padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
    children: [
      Text(source.title, style: Theme.of(context).textTheme.headlineSmall),
      const SizedBox(height: 12),
      Text(
        '${memoryFriendlyLabel(source.sourceType)} · ${memoryFriendlyLabel(source.category)}',
      ),
      const SizedBox(height: 16),
      MobileStatusPill(
        label: memoryFriendlyDate(source.indexedAt),
        icon: Icons.schedule_rounded,
      ),
      const SizedBox(height: 28),
      if (source.content.trim().isNotEmpty)
        _MobileSourceReader(key: ValueKey(source.id), content: source.content)
      else
        const Text(
          'This source is saved for recall. A text preview is not available here.',
        ),
      const SizedBox(height: 20),
      if (source.source.isNotEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: SelectableText(source.source),
        ),
      ExpansionTile(
        tilePadding: EdgeInsets.zero,
        title: const Text('Source details'),
        children: [
          ListTile(
            title: const Text('Last indexed'),
            subtitle: Text(
              source.indexedAt == null
                  ? 'Not reported'
                  : MaterialLocalizations.of(context)
                        .formatFullDate(source.indexedAt!.toLocal()),
            ),
          ),
          ListTile(
            title: const Text('Saved text size'),
            subtitle: Text(
              '${source.totalCharacters} characters · ${source.chunkCount} searchable sections',
            ),
          ),
          SelectableText('Source reference: ${source.id}'),
          Text(
            'Original-source link: ${source.hasCanonicalLineage ? 'recorded' : 'not reported'}',
          ),
        ],
      ),
      const SizedBox(height: 12),
      OutlinedButton.icon(
        onPressed: () => setState(() {
          _selectedSourceId = null;
          _tabs.index = 7;
        }),
        icon: const Icon(Icons.cleaning_services_outlined),
        label: const Text('Review source cleanup'),
      ),
    ],
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
    if (usesMobilePresentation() && !widget.controller.advancedGraphAvailable) {
      return KnowledgeLandscape(
        controller: widget.controller,
        active: _tabs.index == 3,
        onOpenMemory: (memory) => setState(() {
          _selectedMemoryId = memory.id;
          _tabs.index = 0;
        }),
        onOpenSource: (source) => setState(() {
          _selectedSourceId = source.id;
          _tabs.index = 1;
        }),
      );
    }
    if (widget.controller.advancedGraphAvailable)
      return KnowledgeRelationshipMap(
        controller: widget.controller,
        active: _tabs.index == 3,
        onOpenMemory: (memory) {
          setState(() => _selectedMemoryId = memory.id);
          _tabs.animateTo(0);
        },
        onOpenSource: (source) {
          if (usesMobilePresentation()) {
            setState(() {
              _selectedSourceId = source.id;
              _tabs.index = 1;
            });
          } else {
            _tabs.animateTo(1);
            widget.controller.search(source.title);
          }
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

/// Keeps long saved documents readable without laying out their full body per frame.
class _MobileSourceReader extends StatefulWidget {
  const _MobileSourceReader({super.key, required this.content});
  final String content;
  @override
  State<_MobileSourceReader> createState() => _MobileSourceReaderState();
}

class _MobileSourceReaderState extends State<_MobileSourceReader> {
  int _page = 0;
  @override
  Widget build(BuildContext context) {
    const pageSize = 6000;
    final pages = ((widget.content.length + pageSize - 1) ~/ pageSize)
        .clamp(1, 1000000)
        .toInt();
    final page = _page.clamp(0, pages - 1).toInt();
    var start = page * pageSize;
    var end = ((page + 1) * pageSize).clamp(0, widget.content.length).toInt();
    bool lowSurrogate(int offset) =>
        offset < widget.content.length &&
        widget.content.codeUnitAt(offset) >= 0xDC00 &&
        widget.content.codeUnitAt(offset) <= 0xDFFF;
    if (start > 0 && lowSurrogate(start)) start--;
    if (end < widget.content.length && lowSurrogate(end)) end--;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (pages > 1) ...[
          Row(
            children: [
              IconButton(
                tooltip: 'Previous section',
                onPressed: page > 0
                    ? () => setState(() => _page = page - 1)
                    : null,
                icon: const Icon(Icons.chevron_left_rounded),
              ),
              Expanded(
                child: Text(
                  'Reading section ${page + 1} of $pages',
                  textAlign: TextAlign.center,
                ),
              ),
              IconButton(
                tooltip: 'Next section',
                onPressed: page + 1 < pages
                    ? () => setState(() => _page = page + 1)
                    : null,
                icon: const Icon(Icons.chevron_right_rounded),
              ),
            ],
          ),
          const SizedBox(height: 16),
        ],
        SelectableText(
          widget.content.substring(start, end),
          style: Theme.of(context).textTheme.bodyLarge?.copyWith(height: 1.6),
        ),
      ],
    );
  }
}
