import 'dart:math' as math;

import 'package:flutter/material.dart';

typedef Json = Map<String, dynamic>;
List<String> _ss(Object? v) =>
    (v as List? ?? const []).map((e) => e.toString()).toList();

class MemoryRecord {
  const MemoryRecord({
    required this.id,
    required this.title,
    required this.content,
    required this.type,
    required this.tags,
    required this.scope,
    required this.source,
    required this.importance,
    required this.confidence,
    required this.claimStatus,
    required this.assertedBy,
    required this.evidenceRefs,
    required this.category,
    required this.tier,
    required this.evidenceCount,
    this.supersedesId,
    this.contradictionOfId,
    this.createdAt,
    this.updatedAt,
  });
  final String id, title, content, type, scope, source, claimStatus, assertedBy;
  final String category, tier;
  final List<String> tags, evidenceRefs;
  final int evidenceCount;
  final double importance, confidence;
  final String? supersedesId, contradictionOfId;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  factory MemoryRecord.fromJson(Json j) => MemoryRecord(
    id: '${j['id']}',
    title: '${j['title'] ?? 'Memory'}',
    content: '${j['content'] ?? ''}',
    type: '${j['type'] ?? 'fact'}',
    tags: _ss(j['tags']),
    scope: '${j['scope'] ?? 'workspace'}',
    source: '${j['source'] ?? ''}',
    importance: (j['importance'] as num?)?.toDouble() ?? .5,
    confidence: (j['confidence'] as num?)?.toDouble() ?? .7,
    claimStatus: '${j['claimStatus'] ?? j['state'] ?? 'active'}',
    assertedBy: '${j['assertedBy'] ?? 'system'}',
    evidenceRefs: _ss(j['evidenceRefs']),
    category: '${j['category'] ?? j['type'] ?? 'facts'}',
    tier: '${j['tier'] ?? 'semantic'}',
    evidenceCount:
        (j['evidenceCount'] as num?)?.toInt() ?? _ss(j['evidenceRefs']).length,
    supersedesId: j['supersedesId']?.toString(),
    contradictionOfId: j['contradictionOfId']?.toString(),
    createdAt: DateTime.tryParse('${j['createdAt'] ?? ''}'),
    updatedAt: DateTime.tryParse('${j['updatedAt'] ?? ''}'),
  );
}

class KnowledgeItem {
  const KnowledgeItem({
    required this.id,
    required this.title,
    required this.content,
    required this.source,
    required this.tags,
    required this.kind,
    required this.category,
    required this.chunkCount,
    required this.totalCharacters,
  });
  final String id, title, content, source, kind, category;
  final int chunkCount, totalCharacters;
  final List<String> tags;
  factory KnowledgeItem.fromJson(Json j, {String kind = 'document'}) =>
      KnowledgeItem(
        id: '${j['id']}',
        title: '${j['title'] ?? j['documentTitle'] ?? 'Knowledge'}',
        content: '${j['content'] ?? j['text'] ?? j['summary'] ?? ''}',
        source: '${j['sourceLabel'] ?? j['source'] ?? j['sourceUri'] ?? ''}',
        tags: _ss(j['tags']),
        kind: kind,
        category: '${j['category'] ?? 'other'}',
        chunkCount: (j['chunkCount'] as num?)?.toInt() ?? 0,
        totalCharacters: (j['totalCharacters'] as num?)?.toInt() ?? 0,
      );
}

class GraphNode {
  const GraphNode({
    required this.id,
    required this.label,
    required this.kind,
    required this.weight,
    required this.sourceCount,
    required this.tags,
    required this.summary,
  });
  final String id, label, kind, summary;
  final double weight;
  final int sourceCount;
  final List<String> tags;
  factory GraphNode.fromJson(Json j) => GraphNode(
    id: '${j['id']}',
    label: '${j['label'] ?? 'Node'}',
    kind: '${j['kind'] ?? 'concept'}',
    weight: (j['weight'] as num?)?.toDouble() ?? 0,
    sourceCount: (j['sourceCount'] as num?)?.toInt() ?? 0,
    tags: _ss(j['tags']),
    summary: '${j['summary'] ?? ''}',
  );
}

class GraphEdge {
  const GraphEdge({
    required this.source,
    required this.target,
    required this.relation,
    required this.weight,
  });
  final String source, target, relation;
  final double weight;
  factory GraphEdge.fromJson(Json j) => GraphEdge(
    source: '${j['sourceNodeId']}',
    target: '${j['targetNodeId']}',
    relation: '${j['relation']}',
    weight: (j['weight'] as num?)?.toDouble() ?? 0,
  );
}

class KnowledgeState {
  const KnowledgeState({
    required this.memories,
    required this.knowledge,
    required this.nodes,
    required this.edges,
    this.stats = const {},
    this.overview = const {},
  });
  final List<MemoryRecord> memories;
  final List<KnowledgeItem> knowledge;
  final List<GraphNode> nodes;
  final List<GraphEdge> edges;
  final Json stats;
  final Json overview;
}

class MemoryForgetPreview {
  const MemoryForgetPreview({
    required this.expectedReceiptManifestSha256,
    required this.guarantee,
    required this.descendantMemoryCount,
    required this.graphNodeCount,
    required this.graphEdgeCount,
    required this.retrievalTraceCount,
  });
  final String expectedReceiptManifestSha256, guarantee;
  final int descendantMemoryCount, graphNodeCount, graphEdgeCount;
  final int retrievalTraceCount;

  factory MemoryForgetPreview.fromJson(Json json) {
    final impact = json['impact'] is Map
        ? Map<String, dynamic>.from(json['impact'] as Map)
        : const <String, dynamic>{};
    return MemoryForgetPreview(
      expectedReceiptManifestSha256:
          '${json['expectedReceiptManifestSha256'] ?? ''}',
      guarantee: '${json['guarantee'] ?? 'best_effort'}',
      descendantMemoryCount:
          (impact['descendantMemoryCount'] as num?)?.toInt() ?? 0,
      graphNodeCount: (impact['graphNodeCount'] as num?)?.toInt() ?? 0,
      graphEdgeCount: (impact['graphEdgeCount'] as num?)?.toInt() ?? 0,
      retrievalTraceCount:
          (impact['retrievalTraceCount'] as num?)?.toInt() ?? 0,
    );
  }
}

abstract interface class KnowledgeRepository {
  Future<KnowledgeState> load({String query = '', String type = 'all'});
  Future<MemoryRecord> getMemory(String id);
  Future<void> addMemory(Json input);
  Future<void> correctMemory(String id, Json input);
  Future<MemoryForgetPreview> previewForgetMemory(String id);
  Future<void> forgetMemory(String id, String expectedManifestSha256);
  Future<void> rebuildGraph();
  Future<void> deleteConnectedSource(String source);
}

class KnowledgeController extends ChangeNotifier {
  KnowledgeController(this.repository, {required this.canManage});
  final KnowledgeRepository repository;
  final bool canManage;
  KnowledgeState? state;
  bool loading = false;
  Object? error;
  String query = '', type = 'all';
  Future<void> refresh() async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      state = await repository.load(query: query, type: type);
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> search(String v) async {
    query = v.trim();
    await refresh();
  }

  Future<void> add(Json v) async {
    await repository.addMemory(v);
    await refresh();
  }

  Future<void> correct(String id, Json v) async {
    await repository.correctMemory(id, v);
    await refresh();
  }

  Future<MemoryRecord> inspect(String id) => repository.getMemory(id);

  Future<MemoryForgetPreview> previewForget(String id) =>
      repository.previewForgetMemory(id);

  Future<void> forget(String id, String expectedManifestSha256) async {
    await repository.forgetMemory(id, expectedManifestSha256);
    await refresh();
  }

  Future<void> rebuild() async {
    await repository.rebuildGraph();
    await refresh();
  }
}

class KnowledgeView extends StatefulWidget {
  const KnowledgeView({super.key, required this.controller});
  final KnowledgeController controller;
  @override
  State<KnowledgeView> createState() => _KnowledgeViewState();
}

class _KnowledgeViewState extends State<KnowledgeView>
    with SingleTickerProviderStateMixin {
  late final TabController tabs;
  final search = TextEditingController();
  String memoryCategory = 'all', knowledgeCategory = 'all';
  double universeAngle = 0;
  @override
  void initState() {
    super.initState();
    tabs = TabController(length: 3, vsync: this);
    if (widget.controller.state == null) widget.controller.refresh();
  }

  @override
  void dispose() {
    tabs.dispose();
    search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (_, _) {
      final c = widget.controller, s = c.state;
      return Scaffold(
        appBar: AppBar(
          title: const Text('Memory observatory'),
          bottom: TabBar(
            controller: tabs,
            tabs: const [
              Tab(text: 'Memory'),
              Tab(text: 'Knowledge'),
              Tab(text: 'Universe'),
            ],
          ),
          actions: [
            if (c.canManage)
              IconButton(
                tooltip: 'Add memory',
                onPressed: _add,
                icon: const Icon(Icons.add_rounded),
              ),
            IconButton(
              onPressed: c.refresh,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
        ),
        body: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: SearchBar(
                controller: search,
                hintText: 'Search memory and knowledge',
                leading: const Icon(Icons.search_rounded),
                trailing: [
                  if (search.text.isNotEmpty)
                    IconButton(
                      onPressed: () {
                        search.clear();
                        c.search('');
                        setState(() {});
                      },
                      icon: const Icon(Icons.close_rounded),
                    ),
                ],
                onSubmitted: c.search,
                onChanged: (_) => setState(() {}),
              ),
            ),
            if (s != null) _StewardStrip(s.overview),
            Expanded(
              child: c.loading && s == null
                  ? const _KnowledgeSkeleton()
                  : c.error != null && s == null
                  ? Center(
                      child: FilledButton.tonal(
                        onPressed: c.refresh,
                        child: const Text('Reconnect knowledge'),
                      ),
                    )
                  : AnimatedSwitcher(
                      duration: _knowledgeMotion(context),
                      switchInCurve: Curves.easeOutQuart,
                      child: TabBarView(
                        key: ValueKey(s),
                        controller: tabs,
                        children: [
                          _memory(s?.memories ?? const []),
                          _knowledge(s?.knowledge ?? const []),
                          _graph(
                            s?.nodes ?? const [],
                            s?.edges ?? const [],
                            s?.stats ?? const {},
                          ),
                        ],
                      ),
                    ),
            ),
          ],
        ),
      );
    },
  );
  Widget _memory(List<MemoryRecord> values) {
    if (values.isEmpty) return const _Empty('No memories match this view');
    final categories = values.map((item) => item.category).toSet().toList()
      ..sort();
    final filtered = memoryCategory == 'all'
        ? values
        : values.where((item) => item.category == memoryCategory).toList();
    return Column(
      children: [
        _CategoryStrip(
          categories: categories,
          selected: memoryCategory,
          count: (category) => category == 'all'
              ? values.length
              : values.where((item) => item.category == category).length,
          onSelected: (value) => setState(() => memoryCategory = value),
        ),
        Expanded(
          child: LayoutBuilder(
            builder: (context, box) {
              final columns = box.maxWidth >= 920 ? 2 : 1;
              return GridView.builder(
                padding: EdgeInsets.symmetric(
                  horizontal: box.maxWidth >= 920 ? 28 : 16,
                  vertical: 16,
                ),
                gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: columns,
                  mainAxisExtent: 154,
                  crossAxisSpacing: 12,
                  mainAxisSpacing: 12,
                ),
                itemCount: filtered.length,
                itemBuilder: (_, i) {
                  final m = filtered[i];
                  return Card(
                    clipBehavior: Clip.antiAlias,
                    child: ListTile(
                      contentPadding: const EdgeInsets.symmetric(vertical: 6),
                      leading: Icon(
                        m.claimStatus == 'active'
                            ? Icons.memory_rounded
                            : Icons.history_toggle_off_rounded,
                      ),
                      title: Text(m.title),
                      subtitle: Text(
                        '${_label(m.category)} · ${_label(m.tier)}\n${m.claimStatus} · ${m.evidenceCount} evidence links',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      isThreeLine: true,
                      trailing:
                          widget.controller.canManage &&
                              m.claimStatus != 'forgotten'
                          ? PopupMenuButton<String>(
                              onSelected: (v) => v == 'forget'
                                  ? _forget(m)
                                  : _correct(
                                      m,
                                      contradiction: v == 'contradict',
                                    ),
                              itemBuilder: (_) => const [
                                PopupMenuItem(
                                  value: 'correct',
                                  child: Text('Correct'),
                                ),
                                PopupMenuItem(
                                  value: 'contradict',
                                  child: Text('Contradict'),
                                ),
                                PopupMenuItem(
                                  value: 'forget',
                                  child: Text('Forget'),
                                ),
                              ],
                            )
                          : null,
                      onTap: () => _inspect(m),
                    ),
                  );
                },
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _knowledge(List<KnowledgeItem> values) {
    if (values.isEmpty) return const _Empty('No indexed knowledge matches');
    final categories = values.map((item) => item.category).toSet().toList()
      ..sort();
    final filtered = knowledgeCategory == 'all'
        ? values
        : values.where((item) => item.category == knowledgeCategory).toList();
    return Column(
      children: [
        _CategoryStrip(
          categories: categories,
          selected: knowledgeCategory,
          count: (category) => category == 'all'
              ? values.length
              : values.where((item) => item.category == category).length,
          onSelected: (value) => setState(() => knowledgeCategory = value),
        ),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            itemCount: filtered.length,
            itemBuilder: (_, i) {
              final k = filtered[i];
              return Card(
                clipBehavior: Clip.antiAlias,
                child: ListTile(
                  contentPadding: const EdgeInsets.all(14),
                  leading: Icon(
                    k.kind == 'document'
                        ? Icons.description_outlined
                        : Icons.segment_rounded,
                  ),
                  title: Text(k.title),
                  subtitle: Text(
                    '${_label(k.category)} · ${k.source}\n${k.chunkCount} chunks · ${_textSize(k.totalCharacters)}',
                    maxLines: 2,
                  ),
                  isThreeLine: true,
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _graph(
    List<GraphNode> nodes,
    List<GraphEdge> edges,
    Json stats,
  ) => CustomScrollView(
    slivers: [
      SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
          child: GestureDetector(
            onPanUpdate: (detail) =>
                setState(() => universeAngle += detail.delta.dx * .008),
            child: Container(
              height: 260,
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                color: const Color(0xFF071318),
                borderRadius: BorderRadius.circular(24),
              ),
              child: CustomPaint(
                painter: _UniversePainter(
                  nodes: nodes.take(100).toList(),
                  edges: edges,
                  angle: universeAngle,
                ),
                child: const Align(
                  alignment: Alignment.bottomLeft,
                  child: Padding(
                    padding: EdgeInsets.all(14),
                    child: Text(
                      'Drag to rotate the relationship space',
                      style: TextStyle(color: Color(0xFFA5C2BA), fontSize: 12),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Expanded(
                child: _Metric('${stats['nodes'] ?? nodes.length}', 'nodes'),
              ),
              Expanded(
                child: _Metric('${stats['edges'] ?? edges.length}', 'edges'),
              ),
              Expanded(
                child: _Metric('${stats['communities'] ?? '—'}', 'communities'),
              ),
              if (widget.controller.canManage)
                IconButton.filledTonal(
                  tooltip: 'Rebuild graph',
                  onPressed: () => _run(widget.controller.rebuild),
                  icon: const Icon(Icons.sync_rounded),
                ),
            ],
          ),
        ),
      ),
      nodes.isEmpty
          ? const SliverFillRemaining(
              child: _Empty('Graph builds from durable memory'),
            )
          : SliverList.builder(
              itemCount: nodes.length,
              itemBuilder: (_, i) {
                final n = nodes[i];
                final links = edges
                    .where((e) => e.source == n.id || e.target == n.id)
                    .length;
                return ListTile(
                  leading: CircleAvatar(
                    radius: 8 + 6 * n.weight.clamp(0, 1),
                    child: const SizedBox(),
                  ),
                  title: Text(n.label),
                  subtitle: Text(
                    '${n.kind} · $links links · ${n.sourceCount} sources',
                  ),
                  onTap: () => showModalBottomSheet(
                    context: context,
                    showDragHandle: true,
                    builder: (_) => _Sheet(
                      title: n.label,
                      body: n.summary.isEmpty
                          ? 'No summary available.'
                          : n.summary,
                      meta:
                          '${n.kind} · weight ${n.weight.toStringAsFixed(2)} · ${n.tags.join(', ')}',
                    ),
                  ),
                );
              },
            ),
    ],
  );
  Future<void> _inspect(MemoryRecord indexed) async {
    try {
      final m = await widget.controller.inspect(indexed.id);
      if (!mounted) return;
      await showModalBottomSheet(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        builder: (_) => _Sheet(
          title: m.title,
          body: m.content,
          meta:
              '${m.type} · ${m.scope} · ${m.claimStatus}\nAsserted by ${m.assertedBy} · confidence ${(m.confidence * 100).round()}%\nSource: ${m.source}\nEvidence: ${m.evidenceRefs.join(', ')}${m.supersedesId == null ? '' : '\nSupersedes: ${m.supersedesId}'}${m.contradictionOfId == null ? '' : '\nContradicts: ${m.contradictionOfId}'}',
        ),
      );
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$error')));
      }
    }
  }

  Future<void> _add() async {
    final v = await showDialog<Json>(
      context: context,
      builder: (_) => const _MemoryDialog(),
    );
    if (v != null) await _run(() => widget.controller.add(v));
  }

  Future<void> _correct(MemoryRecord m, {required bool contradiction}) async {
    late final MemoryRecord exact;
    try {
      exact = await widget.controller.inspect(m.id);
    } catch (error) {
      _showError(error);
      return;
    }
    if (!mounted) return;
    final v = await showDialog<Json>(
      context: context,
      builder: (_) =>
          _MemoryDialog(memory: exact, contradiction: contradiction),
    );
    if (v != null) await _run(() => widget.controller.correct(m.id, v));
  }

  Future<void> _forget(MemoryRecord m) async {
    late final MemoryForgetPreview preview;
    try {
      preview = await widget.controller.previewForget(m.id);
    } catch (error) {
      _showError(error);
      return;
    }
    if (!mounted) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Forget this memory?'),
        content: Text(
          '${m.title}\n\nThis also removes ${preview.descendantMemoryCount} derived memories, '
          '${preview.graphNodeCount} graph points, ${preview.graphEdgeCount} links, '
          'and ${preview.retrievalTraceCount} recall traces. A deletion receipt will be kept.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Forget'),
          ),
        ],
      ),
    );
    if (ok == true) {
      await _run(
        () => widget.controller.forget(
          m.id,
          preview.expectedReceiptManifestSha256,
        ),
      );
    }
  }

  Future<void> _run(Future<void> Function() f) async {
    try {
      await f();
    } catch (e) {
      _showError(e);
    }
  }

  void _showError(Object error) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text('$error')));
  }
}

class _MemoryDialog extends StatefulWidget {
  const _MemoryDialog({this.memory, this.contradiction = false});
  final MemoryRecord? memory;
  final bool contradiction;
  @override
  State<_MemoryDialog> createState() => _MemoryDialogState();
}

class _MemoryDialogState extends State<_MemoryDialog> {
  late final title = TextEditingController(text: widget.memory?.title);
  late final content = TextEditingController(text: widget.memory?.content);
  late final tags = TextEditingController(text: widget.memory?.tags.join(', '));
  String type = 'fact';
  double importance = .7, confidence = .8;
  @override
  void initState() {
    super.initState();
    type = widget.memory?.type ?? 'fact';
    importance = widget.memory?.importance ?? .7;
    confidence = widget.memory?.confidence ?? .8;
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(
      widget.memory == null
          ? 'Add memory'
          : widget.contradiction
          ? 'Contradict memory'
          : 'Correct memory',
    ),
    content: SizedBox(
      width: 520,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: title,
              decoration: const InputDecoration(labelText: 'Title'),
            ),
            TextField(
              controller: content,
              maxLines: 6,
              decoration: const InputDecoration(labelText: 'Content'),
            ),
            if (widget.memory == null) ...[
              DropdownButtonFormField<String>(
                initialValue: type,
                decoration: const InputDecoration(labelText: 'Type'),
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
                        .map((v) => DropdownMenuItem(value: v, child: Text(v)))
                        .toList(),
                onChanged: (v) => setState(() => type = v!),
              ),
              TextField(
                controller: tags,
                decoration: const InputDecoration(
                  labelText: 'Tags, comma separated',
                ),
              ),
              const SizedBox(height: 8),
              Text('Importance ${(importance * 100).round()}%'),
              Slider(
                value: importance,
                onChanged: (v) => setState(() => importance = v),
              ),
            ],
            Text('Confidence ${(confidence * 100).round()}%'),
            Slider(
              value: confidence,
              onChanged: (v) => setState(() => confidence = v),
            ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: () {
          if (title.text.trim().isEmpty || content.text.trim().isEmpty) return;
          final j = <String, dynamic>{
            'title': title.text.trim(),
            'content': content.text.trim(),
            'confidence': confidence,
          };
          if (widget.memory == null) {
            j.addAll({
              'type': type,
              'tags': tags.text
                  .split(',')
                  .map((e) => e.trim())
                  .where((e) => e.isNotEmpty)
                  .toList(),
              'importance': importance,
              'evidenceRefs': <String>[],
            });
          } else if (widget.contradiction) {
            j['contradiction'] = true;
          }
          Navigator.pop(context, j);
        },
        child: const Text('Save'),
      ),
    ],
  );
}

class _StewardStrip extends StatelessWidget {
  const _StewardStrip(this.overview);
  final Json overview;

  @override
  Widget build(BuildContext context) {
    final summary = overview['summary'] is Map
        ? Map<String, dynamic>.from(overview['summary'] as Map)
        : const <String, dynamic>{};
    final steward = overview['steward'] is Map
        ? Map<String, dynamic>.from(overview['steward'] as Map)
        : const <String, dynamic>{};
    final health = (steward['healthScore'] as num?)?.toInt();
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.primaryContainer
            .withValues(alpha: .44),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: Theme.of(context).colorScheme.primary.withValues(alpha: .2),
        ),
      ),
      child: Row(
        children: [
          CircleAvatar(
            backgroundColor: Theme.of(context).colorScheme.surface,
            child: const Icon(Icons.smart_toy_outlined),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Mnemosyne · memory steward',
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 2),
                Text(
                  '${summary['durableMemories'] ?? 0} memories · '
                  '${summary['knowledgeDocuments'] ?? 0} sources · '
                  '${summary['pendingReviews'] ?? 0} reviews',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
          if (health != null)
            Column(
              children: [
                Text(
                  '$health',
                  style: Theme.of(context).textTheme.titleMedium
                      ?.copyWith(fontWeight: FontWeight.w800),
                ),
                Text('health', style: Theme.of(context).textTheme.labelSmall),
              ],
            ),
        ],
      ),
    );
  }
}

class _CategoryStrip extends StatelessWidget {
  const _CategoryStrip({
    required this.categories,
    required this.selected,
    required this.count,
    required this.onSelected,
  });
  final List<String> categories;
  final String selected;
  final int Function(String category) count;
  final ValueChanged<String> onSelected;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 54,
    child: ListView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 6),
      children: [
        for (final category in ['all', ...categories])
          Padding(
            padding: const EdgeInsets.only(right: 7),
            child: FilterChip(
              selected: selected == category,
              label: Text('${_label(category)}  ${count(category)}'),
              onSelected: (_) => onSelected(category),
            ),
          ),
      ],
    ),
  );
}

class _UniversePainter extends CustomPainter {
  const _UniversePainter({
    required this.nodes,
    required this.edges,
    required this.angle,
  });
  final List<GraphNode> nodes;
  final List<GraphEdge> edges;
  final double angle;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2 - 5);
    final points = <String, ({Offset point, double depth, GraphNode node})>{};
    for (var index = 0; index < nodes.length; index += 1) {
      final node = nodes[index];
      final theta = index * 2.399963 + (node.id.hashCode % 97) / 97;
      final radius = 22 + math.sqrt(index + 1) * 12;
      final x = math.cos(theta) * radius;
      final y = math.sin(theta * 1.7) * math.min(62, radius * .48);
      final z = math.sin(theta) * radius;
      final rotatedX = x * math.cos(angle) + z * math.sin(angle);
      final rotatedZ = -x * math.sin(angle) + z * math.cos(angle);
      final perspective = 520 / (520 + rotatedZ);
      points[node.id] = (
        point: center + Offset(rotatedX * perspective, y * perspective),
        depth: rotatedZ,
        node: node,
      );
    }

    final linePaint = Paint()
      ..color = const Color(0xFF76D8BD).withValues(alpha: .17)
      ..strokeWidth = .7;
    for (final edge in edges.take(400)) {
      final source = points[edge.source], target = points[edge.target];
      if (source != null && target != null) {
        canvas.drawLine(source.point, target.point, linePaint);
      }
    }

    final ordered = points.values.toList()
      ..sort((left, right) => right.depth.compareTo(left.depth));
    for (final item in ordered) {
      final color = _graphColor(item.node.kind);
      final radius = 2.5 + item.node.weight.clamp(0, 1) * 4.5;
      canvas.drawCircle(
        item.point,
        radius + 5,
        Paint()..color = color.withValues(alpha: .08),
      );
      canvas.drawCircle(item.point, radius, Paint()..color = color);
    }
  }

  @override
  bool shouldRepaint(covariant _UniversePainter oldDelegate) =>
      oldDelegate.angle != angle ||
      oldDelegate.nodes != nodes ||
      oldDelegate.edges != edges;
}

Color _graphColor(String kind) => switch (kind) {
  'tag' => const Color(0xFFFFD18A),
  'system' => const Color(0xFF99C7FF),
  'workflow' => const Color(0xFFD4B4FF),
  'tool' => const Color(0xFFFF9FAE),
  'memory' => const Color(0xFFFFF4C6),
  'trace' => const Color(0xFF91A6C9),
  _ => const Color(0xFF90EAD0),
};

String _label(String value) => value
    .split('_')
    .map(
      (part) =>
          part.isEmpty ? part : '${part[0].toUpperCase()}${part.substring(1)}',
    )
    .join(' ');

String _textSize(int characters) {
  if (characters < 1000) return '$characters characters';
  if (characters < 1000000) {
    return '${(characters / 1000).toStringAsFixed(1)}k characters';
  }
  return '${(characters / 1000000).toStringAsFixed(1)}m characters';
}

class _Metric extends StatelessWidget {
  const _Metric(this.value, this.label);
  final String value, label;
  @override
  Widget build(BuildContext context) => Semantics(
    label: '$label: $value',
    child: Container(
      margin: const EdgeInsets.only(right: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value, style: Theme.of(context).textTheme.titleLarge),
          Text(label, style: Theme.of(context).textTheme.labelSmall),
        ],
      ),
    ),
  );
}

Duration _knowledgeMotion(BuildContext context) =>
    MediaQuery.maybeOf(context)?.disableAnimations == true
    ? Duration.zero
    : const Duration(milliseconds: 190);

class _KnowledgeSkeleton extends StatelessWidget {
  const _KnowledgeSkeleton();
  @override
  Widget build(BuildContext context) => ListView.builder(
    padding: const EdgeInsets.all(16),
    itemCount: 6,
    itemBuilder: (_, i) => Container(
      height: 112,
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest
            .withValues(alpha: .55),
        borderRadius: BorderRadius.circular(14),
      ),
    ),
  );
}

class _Sheet extends StatelessWidget {
  const _Sheet({required this.title, required this.body, required this.meta});
  final String title, body, meta;
  @override
  Widget build(BuildContext context) => SafeArea(
    child: SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 0, 24, 32),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 8),
          Text(meta, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 20),
          SelectableText(body),
        ],
      ),
    ),
  );
}

class _Empty extends StatelessWidget {
  const _Empty(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Center(child: Text(text));
}
