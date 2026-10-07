import 'package:flutter/material.dart';

import 'knowledge.dart';
import 'knowledge_labels.dart';

/// Category branches describe the authorized catalog, not inferred relationships.
class KnowledgeLandscape extends StatefulWidget {
  const KnowledgeLandscape({
    super.key,
    required this.controller,
    required this.active,
    this.onOpenMemory,
    this.onOpenSource,
  });
  final KnowledgeController controller;
  final bool active;
  final ValueChanged<MemoryRecord>? onOpenMemory;
  final ValueChanged<KnowledgeItem>? onOpenSource;
  @override
  State<KnowledgeLandscape> createState() => _KnowledgeLandscapeState();
}

class _KnowledgeLandscapeState extends State<KnowledgeLandscape> {
  final _search = TextEditingController();
  bool _sources = false;
  String? _category, _selected;
  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant KnowledgeLandscape oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller) || !widget.active) {
      _selected = _category = null;
      _search.clear();
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      if (!widget.active || !controller.available) {
        return const Center(
          child: Text('Unlock Memory to explore your knowledge.'),
        );
      }
      final scheme = Theme.of(context).colorScheme;
      final state = controller.state;
      final entries = _sources
          ? (state?.knowledge ?? const <KnowledgeItem>[])
                .map(
                  (item) => _Entry(
                    item.id,
                    item.title,
                    item.category,
                    item.indexedAt,
                    item.source.isEmpty ? 'Saved source' : item.source,
                    source: item,
                  ),
                )
                .toList()
          : (state?.memories ?? const <MemoryRecord>[])
                .where(
                  (item) =>
                      !memoryRetiredPlaceholder(item.title) &&
                      item.claimStatus == 'active',
                )
                .map(
                  (item) => _Entry(
                    item.id,
                    memoryDisplayTitle(item.title, item.updatedAt),
                    item.category,
                    item.updatedAt,
                    '${item.evidenceCount} ${item.evidenceCount == 1 ? 'source' : 'sources'} · ${memoryFriendlyLabel(item.tier)}',
                    memory: item,
                  ),
                )
                .toList();
      final query = _search.text.trim().toLowerCase();
      final matching = entries
          .where(
            (item) => '${item.title} ${_collection(item.category).label}'
                .toLowerCase()
                .contains(query),
          )
          .toList();
      final grouped = <String, List<_Entry>>{};
      for (final item in matching) {
        (grouped[item.category] ??= []).add(item);
      }
      final groups = grouped.entries.toList()
        ..sort((a, b) => b.value.length.compareTo(a.value.length));
      final visible = groups
          .where((group) => _category == null || _category == group.key)
          .toList();
      return LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 760;
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Your knowledge map',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 6),
                        const Text(
                          'Explore a collection, then open the memories and sources that belong to it.',
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: 'Refresh knowledge map',
                    onPressed: controller.loading ? null : controller.refresh,
                    icon: const Icon(Icons.refresh),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final sources in [false, true])
                    ChoiceChip(
                      avatar: Icon(
                        sources
                            ? Icons.menu_book_outlined
                            : Icons.psychology_outlined,
                        size: 18,
                      ),
                      label: Text(sources ? 'Sources' : 'Memories'),
                      selected: _sources == sources,
                      onSelected: (_) => setState(() {
                        _sources = sources;
                        _category = _selected = null;
                        _search.clear();
                      }),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _search,
                onChanged: (_) => setState(() => _category = _selected = null),
                decoration: const InputDecoration(
                  hintText: 'Find a title or collection',
                  prefixIcon: Icon(Icons.search),
                  labelText: 'Search this map',
                ),
              ),
              const SizedBox(height: 16),
              if (controller.loading) const LinearProgressIndicator(),
              if (controller.error != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                    'Your library could not refresh. Previously loaded titles may still be shown.',
                    style: TextStyle(color: scheme.error),
                  ),
                ),
              Container(
                clipBehavior: Clip.antiAlias,
                decoration: BoxDecoration(
                  color: scheme.surface,
                  border: Border.all(color: scheme.outlineVariant),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                      child: Wrap(
                        spacing: 12,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          if (_category != null)
                            TextButton.icon(
                              onPressed: () =>
                                  setState(() => _category = _selected = null),
                              icon: const Icon(Icons.arrow_back, size: 16),
                              label: const Text('All collections'),
                            )
                          else
                            Text(
                              _sources
                                  ? 'Where the context comes from'
                                  : 'What Asael remembers',
                              style: Theme.of(context).textTheme.titleSmall,
                            ),
                          Text(
                            '${matching.length} loaded ${_sources ? 'sources' : 'memories'} · ${groups.length} collections',
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                    const Divider(height: 1),
                    if (visible.isEmpty && !controller.loading)
                      Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 24,
                          vertical: 48,
                        ),
                        child: Column(
                          children: [
                            Icon(
                              Icons.menu_book_outlined,
                              color: scheme.primary,
                              size: 32,
                            ),
                            const SizedBox(height: 12),
                            Text(
                              query.isNotEmpty
                                  ? 'No titles match that search'
                                  : 'Your knowledge map starts here',
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            const SizedBox(height: 8),
                            Text(
                              query.isNotEmpty
                                  ? 'This map searches loaded titles. Try the full library for more results.'
                                  : 'Save a memory or add a source. It will appear here in its collection.',
                              textAlign: TextAlign.center,
                            ),
                          ],
                        ),
                      )
                    else
                      Padding(
                        padding: const EdgeInsets.all(12),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.center,
                          children: [
                            if (wide)
                              SizedBox(
                                width: 136,
                                child: Column(
                                  children: [
                                    Icon(
                                      _sources
                                          ? Icons.menu_book_outlined
                                          : Icons.psychology_outlined,
                                      color: scheme.primary,
                                      size: 28,
                                    ),
                                    const SizedBox(height: 12),
                                    Text(
                                      _sources ? 'Your sources' : 'Your memory',
                                      style: Theme.of(context)
                                          .textTheme
                                          .titleSmall,
                                    ),
                                    const SizedBox(height: 6),
                                    const Text(
                                      'A place for every piece',
                                      textAlign: TextAlign.center,
                                    ),
                                  ],
                                ),
                              ),
                            Expanded(
                              child: Column(
                                children: [
                                  for (var i = 0; i < visible.length; i++)
                                    _branch(
                                      context,
                                      visible[i],
                                      wide,
                                      i == visible.length - 1,
                                    ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    const Divider(height: 1),
                    const Padding(
                      padding: EdgeInsets.all(16),
                      child: Text(
                        'Branches group loaded records by category. They do not imply a factual relationship. Active memories are shown here; your full library also includes archived and replaced records.',
                        style: TextStyle(fontSize: 12),
                      ),
                    ),
                  ],
                ),
              ),
              if (_sources
                  ? controller.canLoadMoreKnowledge
                  : controller.canLoadMoreMemory)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: OutlinedButton(
                    onPressed: _sources
                        ? controller.loadMoreKnowledge
                        : controller.loadMoreMemory,
                    child: Text(
                      'Add more ${_sources ? 'sources' : 'memories'} to the map',
                    ),
                  ),
                ),
              if (controller.loadingMoreMemory ||
                  controller.loadingMoreKnowledge)
                const LinearProgressIndicator(),
            ],
          );
        },
      );
    },
  );

  Widget _selection(BuildContext context, _Entry entry) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      color: scheme.primaryContainer,
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _collection(entry.category).label,
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                    const SizedBox(height: 6),
                    Text(
                      entry.title,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Close selected record',
                onPressed: () => setState(() => _selected = null),
                icon: const Icon(Icons.close),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text('${entry.detail} · ${memoryFriendlyDate(entry.date)}'),
          if (entry.memory != null && widget.onOpenMemory != null) ...[
            const SizedBox(height: 12),
            FilledButton.tonalIcon(
              onPressed: () => widget.onOpenMemory!(entry.memory!),
              icon: const Icon(Icons.open_in_new, size: 16),
              label: const Text('Open memory'),
            ),
          ] else if (entry.source != null && widget.onOpenSource != null) ...[
            const SizedBox(height: 12),
            FilledButton.tonalIcon(
              onPressed: () => widget.onOpenSource!(entry.source!),
              icon: const Icon(Icons.open_in_new, size: 16),
              label: const Text('Open source library'),
            ),
          ],
        ],
      ),
    );
  }

  Widget _branch(
    BuildContext context,
    MapEntry<String, List<_Entry>> group,
    bool wide,
    bool last,
  ) {
    final scheme = Theme.of(context).colorScheme;
    final definition = _collection(group.key);
    final shown = _category != null
        ? group.value
        : group.value.take(3).toList();
    final category = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () => setState(() {
            _category = _category == group.key ? null : group.key;
            _selected = null;
          }),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
            child: Row(
              children: [
                Icon(definition.icon, color: scheme.primary, size: 22),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        definition.label,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '${group.value.length} ${_sources ? 'sources' : 'memories'}',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right, size: 16),
              ],
            ),
          ),
        ),
        if (wide)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Text(
              definition.description,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
      ],
    );
    final records = Column(
      children: [
        for (final entry in shown) ...[
          Row(
            children: [
              Container(width: 16, height: 1, color: scheme.outlineVariant),
              Expanded(
                child: ListTile(
                  dense: true,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 8),
                  minVerticalPadding: 8,
                  selected: _selected == entry.id,
                  selectedTileColor: scheme.primaryContainer,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(8),
                  ),
                  title: Text(
                    entry.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Text(memoryFriendlyDate(entry.date)),
                  trailing: const Icon(Icons.chevron_right, size: 16),
                  onTap: () => setState(() => _selected = entry.id),
                ),
              ),
            ],
          ),
          if (_selected == entry.id) _selection(context, entry),
        ],
        if (shown.length < group.value.length)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () => setState(() => _category = group.key),
              icon: const Icon(Icons.north_east, size: 14),
              label: Text('Explore ${group.value.length - shown.length} more'),
            ),
          ),
      ],
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: wide
          ? Row(
              children: [
                Container(width: 24, height: 1, color: scheme.outlineVariant),
                SizedBox(width: 192, child: category),
                const SizedBox(width: 16),
                Expanded(child: records),
              ],
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                category,
                Padding(
                  padding: const EdgeInsets.only(left: 18),
                  child: records,
                ),
                if (!last) const Divider(),
              ],
            ),
    );
  }
}

class _Entry {
  const _Entry(
    this.id,
    this.title,
    this.category,
    this.date,
    this.detail, {
    this.memory,
    this.source,
  });
  final String id, title, category, detail;
  final DateTime? date;
  final MemoryRecord? memory;
  final KnowledgeItem? source;
}

({String label, String description, IconData icon}) _collection(String key) =>
    switch (key) {
      'preferences' => (
        label: 'Your preferences',
        description: 'How you like things done',
        icon: Icons.favorite_outline,
      ),
      'commitments' => (
        label: 'Commitments',
        description: 'Promises and follow-through',
        icon: Icons.flag_outlined,
      ),
      'decisions' => (
        label: 'Decisions',
        description: 'Choices worth remembering',
        icon: Icons.done_all,
      ),
      'procedures' => (
        label: 'How-to',
        description: 'Ways of getting things done',
        icon: Icons.checklist,
      ),
      'experiences' => (
        label: 'Experiences',
        description: 'What happened and what you learned',
        icon: Icons.forum_outlined,
      ),
      'summaries' => (
        label: 'Summaries',
        description: 'Useful context to carry forward',
        icon: Icons.summarize_outlined,
      ),
      'facts' => (
        label: 'Facts & context',
        description: 'Things Asael can refer back to',
        icon: Icons.lightbulb_outline,
      ),
      'mail' => (
        label: 'Email',
        description: 'Messages and correspondence',
        icon: Icons.mail_outline,
      ),
      'calendar' => (
        label: 'Calendar',
        description: 'Events and appointments',
        icon: Icons.event_outlined,
      ),
      'drive' => (
        label: 'Drive files',
        description: 'Files from your connected drive',
        icon: Icons.folder_outlined,
      ),
      'transcripts' => (
        label: 'Conversations',
        description: 'Meeting notes and transcripts',
        icon: Icons.forum_outlined,
      ),
      'documents' => (
        label: 'Documents',
        description: 'Reports, decks and documents',
        icon: Icons.description_outlined,
      ),
      'web' => (
        label: 'Web sources',
        description: 'Saved pages and research',
        icon: Icons.public,
      ),
      'notes' => (
        label: 'Notes',
        description: 'Ideas and notes you saved',
        icon: Icons.lightbulb_outline,
      ),
      _ => (
        label: memoryFriendlyLabel(key),
        description: 'Saved context',
        icon: Icons.menu_book_outlined,
      ),
    };
