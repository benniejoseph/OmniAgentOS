import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../app/mobile/mobile_page_scaffold.dart';
import '../../app/platform/mobile_presentation.dart';
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
    this.onShowConnections,
  });
  final KnowledgeController controller;
  final bool active;
  final ValueChanged<MemoryRecord>? onOpenMemory;
  final ValueChanged<KnowledgeItem>? onOpenSource;
  final VoidCallback? onShowConnections;
  @override
  State<KnowledgeLandscape> createState() => _KnowledgeLandscapeState();
}

class _KnowledgeLandscapeState extends State<KnowledgeLandscape> {
  final _search = TextEditingController();
  bool _sources = false;
  String? _category, _selected;
  int _mapPage = 0;
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
      if (usesMobilePresentation()) return _mobileMap(matching, groups);
      return LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 760;
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            children: [
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
                  if (widget.onShowConnections != null)
                    TextButton.icon(
                      onPressed: widget.onShowConnections,
                      icon: const Icon(Icons.hub_outlined, size: 16),
                      label: const Text('Connections'),
                    ),
                  IconButton(
                    tooltip: 'Refresh knowledge map',
                    onPressed: controller.loading ? null : controller.refresh,
                    icon: const Icon(Icons.refresh),
                  ),
                ],
              ),
              const SizedBox(height: 8),
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

  Widget _mobileMap(
    List<_Entry> entries,
    List<MapEntry<String, List<_Entry>>> groups,
  ) {
    final scheme = Theme.of(context).colorScheme;
    final selected = groups
        .where((group) => group.key == _category)
        .firstOrNull;
    final page = _mapPage
        .clamp(0, groups.isEmpty ? 0 : (groups.length - 1) ~/ 6)
        .toInt();
    final visible = groups.skip(page * 6).take(6).toList();
    return CustomScrollView(
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      slivers: [
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
          sliver: SliverToBoxAdapter(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: MobileSegmentBar<bool>(
                        items: const [
                          (value: false, label: 'Memories', icon: null),
                          (value: true, label: 'Sources', icon: null),
                        ],
                        value: _sources,
                        onChanged: (value) => setState(() {
                          _sources = value;
                          _category = _selected = null;
                          _search.clear();
                          _mapPage = 0;
                        }),
                      ),
                    ),
                    if (widget.onShowConnections != null)
                      IconButton(
                        tooltip: 'Explore recorded connections',
                        onPressed: widget.onShowConnections,
                        icon: const Icon(Icons.hub_outlined),
                      ),
                  ],
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: _search,
                  decoration: const InputDecoration(
                    hintText: 'Find a title or collection',
                    prefixIcon: Icon(Icons.search_rounded),
                  ),
                  onChanged: (_) => setState(() {
                    _category = _selected = null;
                    _mapPage = 0;
                  }),
                ),
                const SizedBox(height: 20),
                if (widget.controller.loading) const LinearProgressIndicator(),
                if (widget.controller.error != null)
                  Text(
                    'The map could not refresh. Previously loaded titles are shown.',
                    style: TextStyle(color: scheme.error),
                  ),
                if (selected == null) ...[
                  Text(
                    'A place for every thought',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    '${entries.length} saved ${_sources ? 'sources' : 'memories'} in this view. Tap a collection to explore.',
                  ),
                ] else
                  TextButton.icon(
                    onPressed: () =>
                        setState(() => _category = _selected = null),
                    icon: const Icon(Icons.arrow_back_rounded),
                    label: const Text('All collections'),
                  ),
                if (groups.isEmpty && !widget.controller.loading)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 32),
                    child: Text(
                      'Your map starts with something worth remembering. Save a memory or source, or try a broader search.',
                    ),
                  ),
              ],
            ),
          ),
        ),
        if (selected == null && visible.isNotEmpty)
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: _MobileCollectionConstellation(
                label: _sources ? 'Sources' : 'Memory',
                groups: [
                  for (final group in visible)
                    (
                      key: group.key,
                      label: _collection(group.key).label,
                      icon: _collection(group.key).icon,
                      count: group.value.length,
                    ),
                ],
                onSelect: (value) => setState(() => _category = value),
              ),
            ),
          ),
        if (selected == null && groups.length > 6)
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  IconButton(
                    tooltip: 'Previous collections',
                    onPressed: page > 0
                        ? () => setState(() => _mapPage = page - 1)
                        : null,
                    icon: const Icon(Icons.chevron_left_rounded),
                  ),
                  Text(
                    'Collections ${page * 6 + 1}–${math.min((page + 1) * 6, groups.length)} of ${groups.length}',
                  ),
                  IconButton(
                    tooltip: 'More collections',
                    onPressed: (page + 1) * 6 < groups.length
                        ? () => setState(() => _mapPage = page + 1)
                        : null,
                    icon: const Icon(Icons.chevron_right_rounded),
                  ),
                ],
              ),
            ),
          ),
        if (selected != null) ...[
          SliverToBoxAdapter(
            child: MobileSectionHeader(
              title: _collection(selected.key).label,
              description: _collection(selected.key).description,
            ),
          ),
          SliverList.builder(
            itemCount: selected.value.length,
            itemBuilder: (context, index) {
              final entry = selected.value[index];
              return MobileActionTile(
                icon: _collection(entry.category).icon,
                title: entry.title,
                subtitle: '${entry.detail} · ${memoryFriendlyDate(entry.date)}',
                onTap: entry.memory != null && widget.onOpenMemory != null
                    ? () => widget.onOpenMemory!(entry.memory!)
                    : entry.source != null && widget.onOpenSource != null
                    ? () => widget.onOpenSource!(entry.source!)
                    : null,
              );
            },
          ),
        ],
        SliverPadding(
          padding: const EdgeInsets.all(20),
          sliver: SliverToBoxAdapter(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (widget.onShowConnections != null)
                  MobileActionTile(
                    icon: Icons.hub_outlined,
                    title: 'Follow a connection',
                    subtitle: 'Explore relationships recorded in your sources.',
                    onTap: widget.onShowConnections,
                  ),
                const SizedBox(height: 12),
                Text(
                  'This map groups saved items by collection. Lines here show organisation, not factual relationships.',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                if (_sources
                    ? widget.controller.canLoadMoreKnowledge
                    : widget.controller.canLoadMoreMemory)
                  Padding(
                    padding: const EdgeInsets.only(top: 16),
                    child: OutlinedButton(
                      onPressed: _sources
                          ? widget.controller.loadMoreKnowledge
                          : widget.controller.loadMoreMemory,
                      child: const Text('Add more saved items to the map'),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }

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

/// Stable collection positions avoid force simulation and unreadable label clouds.
class _MobileCollectionConstellation extends StatelessWidget {
  const _MobileCollectionConstellation({
    required this.label,
    required this.groups,
    required this.onSelect,
  });
  final String label;
  final List<({String key, String label, IconData icon, int count})> groups;
  final ValueChanged<String> onSelect;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final theme = Theme.of(context), width = constraints.maxWidth;
      final textScale = MediaQuery.textScalerOf(context).scale(14) / 14;
      final height = 450.0 + math.max(0.0, textScale - 1) * 160;
      final center = Offset(width / 2, height / 2);
      final positions = <Offset>[
        for (var i = 0; i < groups.length; i++)
          Offset(
            center.dx +
                math.sin(i * math.pi * 2 / groups.length) * (width / 2 - 59),
            center.dy -
                math.cos(i * math.pi * 2 / groups.length) * (height / 2 - 65),
          ),
      ];
      return SizedBox(
        height: height,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(24),
          child: InteractiveViewer(
            minScale: 1,
            maxScale: 2.5,
            child: SizedBox(
              width: width,
              height: height,
              child: Stack(
                children: [
                  Positioned.fill(
                    child: CustomPaint(
                      painter: _CollectionThreadsPainter(
                        center,
                        positions,
                        theme.colorScheme.primary.withValues(alpha: .22),
                      ),
                    ),
                  ),
                  Positioned(
                    left: center.dx - 45,
                    top: center.dy - 45,
                    child: Container(
                      width: 90,
                      height: 90,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: theme.colorScheme.primaryContainer,
                      ),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(
                            Icons.auto_awesome_outlined,
                            color: theme.colorScheme.primary,
                            size: 25,
                          ),
                          const SizedBox(height: 8),
                          Text(
                            label,
                            style: theme.textTheme.labelLarge,
                            textAlign: TextAlign.center,
                          ),
                        ],
                      ),
                    ),
                  ),
                  for (var i = 0; i < groups.length; i++)
                    Positioned(
                      left: positions[i].dx - 54,
                      top: positions[i].dy - 56 * textScale,
                      width: 108,
                      child: Semantics(
                        button: true,
                        label:
                            '${groups[i].label}, ${groups[i].count} saved items',
                        child: Material(
                          color: Colors.transparent,
                          child: InkWell(
                            borderRadius: BorderRadius.circular(20),
                            onTap: () => onSelect(groups[i].key),
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 3,
                                vertical: 8,
                              ),
                              child: Column(
                                children: [
                                  Container(
                                    width: 52,
                                    height: 52,
                                    decoration: BoxDecoration(
                                      shape: BoxShape.circle,
                                      color: theme.colorScheme.surface,
                                      border: Border.all(
                                        color: theme.colorScheme.outlineVariant,
                                      ),
                                    ),
                                    child: Icon(
                                      groups[i].icon,
                                      color: theme.colorScheme.primary,
                                      size: 23,
                                    ),
                                  ),
                                  const SizedBox(height: 8),
                                  Text(
                                    groups[i].label,
                                    textAlign: TextAlign.center,
                                    maxLines: 3,
                                    overflow: TextOverflow.ellipsis,
                                    style: theme.textTheme.labelMedium,
                                  ),
                                  const SizedBox(height: 3),
                                  Text(
                                    '${groups[i].count}',
                                    style: theme.textTheme.bodySmall,
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );
}

class _CollectionThreadsPainter extends CustomPainter {
  const _CollectionThreadsPainter(this.center, this.points, this.color);
  final Offset center;
  final List<Offset> points;
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1.2
      ..style = PaintingStyle.stroke;
    for (final point in points) {
      final path = Path()
        ..moveTo(center.dx, center.dy)
        ..quadraticBezierTo(
          (center.dx + point.dx) / 2 + (point.dy - center.dy) * .12,
          (center.dy + point.dy) / 2,
          point.dx,
          point.dy,
        );
      canvas.drawPath(path, paint);
    }
  }

  @override
  bool shouldRepaint(covariant _CollectionThreadsPainter oldDelegate) =>
      oldDelegate.center != center ||
      oldDelegate.color != color ||
      oldDelegate.points.length != points.length ||
      !List.generate(
        points.length,
        (index) => oldDelegate.points[index] == points[index],
      ).every((equal) => equal);
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
