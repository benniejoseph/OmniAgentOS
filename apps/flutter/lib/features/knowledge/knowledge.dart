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
    this.supersedesId,
    this.contradictionOfId,
    this.createdAt,
  });
  final String id, title, content, type, scope, source, claimStatus, assertedBy;
  final List<String> tags, evidenceRefs;
  final double importance, confidence;
  final String? supersedesId, contradictionOfId;
  final DateTime? createdAt;
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
    claimStatus: '${j['claimStatus'] ?? 'active'}',
    assertedBy: '${j['assertedBy'] ?? 'system'}',
    evidenceRefs: _ss(j['evidenceRefs']),
    supersedesId: j['supersedesId']?.toString(),
    contradictionOfId: j['contradictionOfId']?.toString(),
    createdAt: DateTime.tryParse('${j['createdAt'] ?? ''}'),
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
  });
  final String id, title, content, source, kind;
  final List<String> tags;
  factory KnowledgeItem.fromJson(Json j, {String kind = 'document'}) =>
      KnowledgeItem(
        id: '${j['id']}',
        title: '${j['title'] ?? j['documentTitle'] ?? 'Knowledge'}',
        content: '${j['content'] ?? j['text'] ?? j['summary'] ?? ''}',
        source: '${j['source'] ?? j['sourceUri'] ?? ''}',
        tags: _ss(j['tags']),
        kind: kind,
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
  });
  final List<MemoryRecord> memories;
  final List<KnowledgeItem> knowledge;
  final List<GraphNode> nodes;
  final List<GraphEdge> edges;
  final Json stats;
}

abstract interface class KnowledgeRepository {
  Future<KnowledgeState> load({String query = '', String type = 'all'});
  Future<void> addMemory(Json input);
  Future<void> correctMemory(String id, Json input);
  Future<void> forgetMemory(String id);
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

  Future<void> forget(String id) async {
    await repository.forgetMemory(id);
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
          title: const Text('Knowledge & memory'),
          bottom: TabBar(
            controller: tabs,
            tabs: const [
              Tab(text: 'Memory'),
              Tab(text: 'Knowledge'),
              Tab(text: 'Graph'),
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
  Widget _memory(List<MemoryRecord> values) => values.isEmpty
      ? const _Empty('No memories match this view')
      : LayoutBuilder(
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
              itemCount: values.length,
              itemBuilder: (_, i) {
                final m = values[i];
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
                      '${m.type} · ${m.claimStatus} · ${m.source}\n${m.content}',
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                    ),
                    isThreeLine: true,
                    trailing:
                        widget.controller.canManage &&
                            m.claimStatus != 'forgotten'
                        ? PopupMenuButton<String>(
                            onSelected: (v) => v == 'forget'
                                ? _forget(m)
                                : _correct(m, contradiction: v == 'contradict'),
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
        );
  Widget _knowledge(List<KnowledgeItem> values) => values.isEmpty
      ? const _Empty('No indexed knowledge matches')
      : ListView.builder(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          itemCount: values.length,
          itemBuilder: (_, i) {
            final k = values[i];
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
                subtitle: Text('${k.source}\n${k.content}', maxLines: 3),
                isThreeLine: true,
                onTap: () => showModalBottomSheet(
                  context: context,
                  showDragHandle: true,
                  isScrollControlled: true,
                  builder: (_) => _Sheet(
                    title: k.title,
                    body: k.content,
                    meta: '${k.kind} · ${k.source}',
                  ),
                ),
              ),
            );
          },
        );
  Widget _graph(
    List<GraphNode> nodes,
    List<GraphEdge> edges,
    Json stats,
  ) => CustomScrollView(
    slivers: [
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
  Future<void> _inspect(MemoryRecord m) => showModalBottomSheet(
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
  Future<void> _add() async {
    final v = await showDialog<Json>(
      context: context,
      builder: (_) => const _MemoryDialog(),
    );
    if (v != null) await _run(() => widget.controller.add(v));
  }

  Future<void> _correct(MemoryRecord m, {required bool contradiction}) async {
    final v = await showDialog<Json>(
      context: context,
      builder: (_) => _MemoryDialog(memory: m, contradiction: contradiction),
    );
    if (v != null) await _run(() => widget.controller.correct(m.id, v));
  }

  Future<void> _forget(MemoryRecord m) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Forget this memory?'),
        content: Text(m.title),
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
    if (ok == true) await _run(() => widget.controller.forget(m.id));
  }

  Future<void> _run(Future<void> Function() f) async {
    try {
      await f();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$e')));
      }
    }
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
