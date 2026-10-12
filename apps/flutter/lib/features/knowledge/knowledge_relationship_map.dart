import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'knowledge.dart';
import 'knowledge_graph_contracts.dart';
import 'knowledge_labels.dart';
import 'knowledge_landscape.dart';

class KnowledgeRelationshipMap extends StatefulWidget {
  const KnowledgeRelationshipMap({
    super.key,
    required this.controller,
    this.active = true,
    this.onOpenMemory,
    this.onOpenSource,
  });
  final KnowledgeController controller;
  final bool active;
  final ValueChanged<MemoryRecord>? onOpenMemory;
  final ValueChanged<KnowledgeItem>? onOpenSource;
  @override
  State<KnowledgeRelationshipMap> createState() =>
      _KnowledgeRelationshipMapState();
}

class _KnowledgeRelationshipMapState extends State<KnowledgeRelationshipMap> {
  bool _connections = false;
  @override
  Widget build(BuildContext context) => _connections
      ? Column(
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: TextButton.icon(
                  onPressed: () => setState(() => _connections = false),
                  icon: const Icon(Icons.arrow_back, size: 16),
                  label: const Text('Back to knowledge map'),
                ),
              ),
            ),
            Expanded(
              child: _KnowledgeConnectionsMap(
                controller: widget.controller,
                active: widget.active,
              ),
            ),
          ],
        )
      : KnowledgeLandscape(
          controller: widget.controller,
          active: widget.active,
          onOpenMemory: widget.onOpenMemory,
          onOpenSource: widget.onOpenSource,
          onShowConnections: () => setState(() => _connections = true),
        );
}

/// Names are read only after selection or an explicit bounded Open visible names action.
/// The v48 private sample and exact-read authority remain unchanged.
class _KnowledgeConnectionsMap extends StatefulWidget {
  const _KnowledgeConnectionsMap({
    super.key,
    required this.controller,
    this.active = true,
  });
  final KnowledgeController controller;
  final bool active;
  @override
  State<_KnowledgeConnectionsMap> createState() =>
      _KnowledgeConnectionsMapState();
}

class _KnowledgeConnectionsMapState extends State<_KnowledgeConnectionsMap>
    with WidgetsBindingObserver {
  final _transform = TransformationController();
  final _search = TextEditingController();
  KnowledgeGraphRead? _snapshot;
  Map<String, dynamic>? _detail;
  final Map<String, String> _names = {};
  String? _selected, _error, _detailError;
  String _mode = 'nodes', _kind = 'all', _notice = '';
  bool _loading = false, _opening = false, _naming = false, _foreground = true;
  int _epoch = 0, _selectionEpoch = 0;
  static const _depth = 1;
  double _viewWidth = 0;
  bool get _current =>
      mounted &&
      widget.active &&
      _foreground &&
      widget.controller.advancedGraphAvailable;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    _load();
  }

  @override
  void didUpdateWidget(covariant _KnowledgeConnectionsMap oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller) ||
        oldWidget.active != widget.active) {
      _clear();
      _load();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    setState(_clear);
    _load();
  }

  void _clear() {
    _epoch++;
    _selectionEpoch++;
    _snapshot = null;
    _detail = null;
    _selected = null;
    _names.clear();
    _search.clear();
    _error = _detailError = null;
    _notice = '';
    _loading = _opening = _naming = false;
    _kind = 'all';
  }

  @override
  void dispose() {
    _epoch++;
    _selectionEpoch++;
    WidgetsBinding.instance.removeObserver(this);
    _transform.dispose();
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    if (!_current) return;
    final epoch = ++_epoch, controller = widget.controller;
    _selectionEpoch++;
    setState(() {
      _loading = true;
      _error = null;
      _detail = null;
      _names.clear();
      _naming = _opening = false;
      _notice = '';
    });
    try {
      final result = await controller.inspectGraph('universe', {'limit': 200});
      if (_current &&
          epoch == _epoch &&
          identical(controller, widget.controller))
        setState(() {
          _snapshot = result;
          if (!_nodes.any((node) => node['id'] == _selected)) _selected = null;
        });
    } catch (_) {
      if (_current && epoch == _epoch)
        setState(() {
          _snapshot = null;
          _selected = null;
          _error =
              'The relationship map could not be opened. Refresh to try again.';
        });
    } finally {
      if (_current && epoch == _epoch) setState(() => _loading = false);
    }
  }

  List<Map<String, dynamic>> get _nodes =>
      ((_snapshot?.raw['graph'] as Map?)?[_mode] as List? ?? const [])
          .map((row) => Map<String, dynamic>.from(row as Map))
          .toList();
  List<_MapLink> get _links {
    final graph = _snapshot?.raw['graph'] as Map?;
    if (graph == null) return [];
    if (_mode == 'nodes')
      return (graph['edges'] as List)
          .map(
            (row) => _MapLink(
              row['sourceNodeId'] as String,
              row['targetNodeId'] as String,
            ),
          )
          .toList();
    return (graph['relations'] as List)
        .map(
          (row) => _MapLink(
            row['source']['entityId'] as String,
            row['target']['entityId'] as String,
          ),
        )
        .toList();
  }

  String _name(Map<String, dynamic> node, Map<String, int> order) =>
      _names[node['id']] != null
      ? memoryGraphName(
          _names[node['id']]!,
          fallback: 'Assistant task ${order[node['id']] ?? ''}'.trim(),
        )
      : '${memoryFriendlyLabel(node['kind'] as String)} ${order[node['id']] ?? ''}'
            .trim();
  Future<void> _open(String id) async {
    if (!_current) return;
    final epoch = _epoch,
        selection = ++_selectionEpoch,
        controller = widget.controller;
    final view = _mode == 'nodes' ? 'node' : 'entity';
    setState(() {
      _selected = id;
      _kind = 'all';
      _search.clear();
      _detail = null;
      _detailError = null;
      _opening = true;
    });
    try {
      final result = await controller.inspectGraph(view, {'id': id});
      if (!_current ||
          epoch != _epoch ||
          selection != _selectionEpoch ||
          !identical(controller, widget.controller))
        return;
      final detail = Map<String, dynamic>.from(result.raw[view] as Map);
      if (detail['id'] != id) throw const FormatException('Selection changed.');
      setState(() {
        _detail = detail;
        _names[id] = detail['label'] as String;
      });
    } catch (_) {
      if (_current && epoch == _epoch && selection == _selectionEpoch)
        setState(
          () => _detailError =
              'This item is no longer available to your current account.',
        );
    } finally {
      if (_current && epoch == _epoch && selection == _selectionEpoch)
        setState(() => _opening = false);
    }
  }

  Future<void> _showNames(List<Map<String, dynamic>> visible) async {
    if (!_current || _naming) return;
    final epoch = _epoch,
        controller = widget.controller,
        view = _mode == 'nodes' ? 'node' : 'entity';
    final pending = visible
        .where((node) => !_names.containsKey(node['id']))
        .take(24)
        .toList();
    setState(() {
      _naming = true;
      _notice = '';
    });
    int loaded = 0, failed = 0;
    for (final node in pending) {
      if (!_current ||
          epoch != _epoch ||
          !identical(controller, widget.controller))
        return;
      try {
        final result = await controller.inspectGraph(view, {'id': node['id']});
        if (!_current ||
            epoch != _epoch ||
            !identical(controller, widget.controller))
          return;
        final detail = result.raw[view] as Map;
        if (detail['id'] != node['id'])
          throw const FormatException('Selection changed.');
        setState(
          () => _names[node['id'] as String] = detail['label'] as String,
        );
        loaded++;
      } catch (_) {
        failed++;
      }
    }
    if (_current && epoch == _epoch)
      setState(() {
        _naming = false;
        _notice =
            '$loaded names opened.${failed > 0 ? ' $failed are unavailable with your current access.' : ''}';
      });
  }

  void _fit() {
    if (_viewWidth <= 0) return;
    final scale = math.min(_viewWidth / 900, 360 / 540);
    _transform.value = Matrix4.identity()
      ..translateByDouble(
        (_viewWidth - 900 * scale) / 2,
        (360 - 540 * scale) / 2,
        0,
        1,
      )
      ..scaleByDouble(scale, scale, 1, 1);
  }

  void _zoom(double factor) {
    final matrix = _transform.value.clone();
    final current = matrix.getMaxScaleOnAxis();
    if (current * factor < .2 || current * factor > 4) return;
    matrix.scaleByDouble(factor, factor, 1, 1);
    _transform.value = matrix;
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      if (!_current)
        return const Center(
          child: Padding(
            padding: EdgeInsets.all(20),
            child: Text(
              'Sign in and unlock Memory to open your relationship map.',
            ),
          ),
        );
      final scheme = Theme.of(context).colorScheme;
      final nodes = _nodes, links = _links;
      final byId = {for (final node in nodes) node['id'] as String: node};
      final neighbors = <String, Set<String>>{};
      for (final link in links) {
        if (!byId.containsKey(link.from) || !byId.containsKey(link.to))
          continue;
        (neighbors[link.from] ??= {}).add(link.to);
        (neighbors[link.to] ??= {}).add(link.from);
      }
      nodes.sort((a, b) {
        final degree = (neighbors[b['id']]?.length ?? 0).compareTo(
          neighbors[a['id']]?.length ?? 0,
        );
        return degree != 0
            ? degree
            : (a['id'] as String).compareTo(b['id'] as String);
      });
      final order = {
        for (var i = 0; i < nodes.length; i++) nodes[i]['id'] as String: i + 1,
      };
      var candidates = nodes;
      if (_selected != null && byId.containsKey(_selected)) {
        final ids = <String>{_selected!};
        var frontier = <String>[_selected!];
        for (var hop = 0; hop < _depth; hop++) {
          final next = <String>[];
          for (final id in frontier) {
            for (final other in neighbors[id] ?? <String>{}) {
              if (ids.add(other)) next.add(other);
            }
          }
          frontier = next;
        }
        candidates = [
          byId[_selected]!,
          ...nodes.where(
            (node) => node['id'] != _selected && ids.contains(node['id']),
          ),
        ];
      }
      final search = _search.text.trim().toLowerCase();
      final matching = candidates
          .where(
            (node) =>
                (_kind == 'all' || node['kind'] == _kind) &&
                (search.isEmpty ||
                    '${_names[node['id']] ?? ''} ${memoryFriendlyLabel(node['kind'] as String)}'
                        .toLowerCase()
                        .contains(search)),
          )
          .toList();
      final visible = matching.take(_selected != null ? 13 : 12).toList();
      final ids = visible.map((node) => node['id'] as String).toSet();
      final edges = links
          .where(
            (link) =>
                (link.from == _selected || link.to == _selected) &&
                ids.contains(link.from) &&
                ids.contains(link.to),
          )
          .take(120)
          .toList();
      final points = _mapLayout(visible, _selected);
      final kinds = nodes.map((node) => node['kind'] as String).toSet().toList()
        ..sort();
      final selected = byId[_selected];
      final visibleSummary = memoryGraphSummary(
        _detail?['summary'] as String? ?? '',
      );
      final connected = (neighbors[_selected] ?? <String>{})
          .map((id) => byId[id]!)
          .toList();
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'One connection at a time',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              IconButton(
                tooltip: 'Refresh map',
                onPressed: _loading ? null : _load,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          const Text(
            'Choose a starting point, then follow up to 12 direct connections. Each line has a recorded source relationship.',
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            children: [
              for (final mode in const {
                'nodes': 'Related evidence',
                'entities': 'Stated relationships',
              }.entries)
                ChoiceChip(
                  label: Text(mode.value),
                  selected: _mode == mode.key,
                  onSelected: (_) {
                    if (_mode == mode.key) return;
                    setState(() {
                      _epoch++;
                      _selectionEpoch++;
                      _mode = mode.key;
                      _selected = null;
                      _detail = null;
                      _names.clear();
                      _kind = 'all';
                      _search.clear();
                      _naming = _opening = false;
                      _notice = '';
                    });
                    if (_snapshot == null) _load();
                    _fit();
                  },
                ),
            ],
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _search,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(
              labelText: 'Filter loaded names or types',
              prefixIcon: Icon(Icons.search),
            ),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 12,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              SizedBox(
                width: 180,
                child: DropdownButtonFormField<String>(
                  key: ValueKey('map-kind:$_mode:$_kind'),
                  initialValue: _kind,
                  decoration: const InputDecoration(labelText: 'Type'),
                  items: [
                    const DropdownMenuItem(
                      value: 'all',
                      child: Text('All types'),
                    ),
                    for (final kind in kinds)
                      DropdownMenuItem(
                        value: kind,
                        child: Text(memoryFriendlyLabel(kind)),
                      ),
                  ],
                  onChanged: (value) => setState(() => _kind = value ?? 'all'),
                ),
              ),
              OutlinedButton(
                onPressed:
                    _naming ||
                        !visible.any((node) => !_names.containsKey(node['id']))
                    ? null
                    : () => _showNames(visible),
                child: Text(_naming ? 'Opening names…' : 'Open visible names'),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            _mode == 'nodes' ? 'Lines show shared context, not proven facts.' : 'Lines show claims stated in sources; claims may still need review.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          if (_loading) const LinearProgressIndicator(),
          if (_error != null)
            Text(_error!, style: TextStyle(color: scheme.error)),
          if (_notice.isNotEmpty) Text(_notice),
          const SizedBox(height: 8),
          LayoutBuilder(
            builder: (context, constraints) {
              if (_viewWidth != constraints.maxWidth) {
                _viewWidth = constraints.maxWidth;
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (mounted) _fit();
                });
              }
              return Container(
                height: 360,
                clipBehavior: Clip.hardEdge,
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerLow,
                  border: Border.all(color: scheme.outlineVariant),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: visible.isEmpty && !_loading
                    ? const Center(
                        child: Padding(
                          padding: EdgeInsets.all(24),
                          child: Text(
                            'No items match. Try another filter, or open names before searching for a topic.',
                          ),
                        ),
                      )
                    : InteractiveViewer(
                        transformationController: _transform,
                        constrained: false,
                        minScale: .2,
                        maxScale: 4,
                        boundaryMargin: const EdgeInsets.all(160),
                        trackpadScrollCausesScale: true,
                        child: SizedBox(
                          width: 900,
                          height: 540,
                          child: Stack(
                            children: [
                              Positioned.fill(
                                child: CustomPaint(
                                  painter: _MapEdgesPainter(
                                    points: points,
                                    edges: edges,
                                    selected: _selected,
                                    color: scheme.outlineVariant,
                                    accent: scheme.primary,
                                  ),
                                ),
                              ),
                              for (final node in visible)
                                Positioned(
                                  left: points[node['id']]!.dx - 66,
                                  top: points[node['id']]!.dy - 12,
                                  width: 132,
                                  child: Semantics(
                                    button: true,
                                    selected: node['id'] == _selected,
                                    label: _name(node, order),
                                    child: GestureDetector(
                                      onTap: () => _open(node['id'] as String),
                                      child: Column(
                                        children: [
                                          Container(
                                            width: node['id'] == _selected
                                                ? 18
                                                : 12,
                                            height: node['id'] == _selected
                                                ? 18
                                                : 12,
                                            decoration: BoxDecoration(
                                              shape: BoxShape.circle,
                                              color: node['id'] == _selected
                                                  ? scheme.primary
                                                  : scheme.onSurfaceVariant,
                                            ),
                                          ),
                                          if (_names.containsKey(node['id']) ||
                                              node['id'] == _selected ||
                                              visible.length <= 18)
                                            Padding(
                                              padding: const EdgeInsets.only(
                                                top: 4,
                                              ),
                                              child: Text(
                                                _name(node, order),
                                                textAlign: TextAlign.center,
                                                maxLines: 2,
                                                overflow: TextOverflow.ellipsis,
                                                style: TextStyle(
                                                  fontSize: 12,
                                                  color: scheme.onSurface,
                                                  backgroundColor: scheme
                                                      .surfaceContainerLow,
                                                ),
                                              ),
                                            ),
                                        ],
                                      ),
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ),
              );
            },
          ),
          Wrap(
            spacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              const Text('Drag to pan · Pinch or scroll to zoom'),
              IconButton(
                tooltip: 'Zoom in',
                onPressed: () => _zoom(1.2),
                icon: const Icon(Icons.add),
              ),
              IconButton(
                tooltip: 'Zoom out',
                onPressed: () => _zoom(1 / 1.2),
                icon: const Icon(Icons.remove),
              ),
              TextButton.icon(
                onPressed: _fit,
                icon: const Icon(Icons.center_focus_strong),
                label: const Text('Fit'),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(
              selected == null
                  ? 'Choose a starting point to draw its connections.'
                  : '${visible.length - 1} direct connections shown.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
          const Divider(),
          if (selected != null) ...[
            Row(
              children: [
                Expanded(
                  child: Text(
                    _name(selected, order),
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                IconButton(
                  tooltip: 'Close item',
                  onPressed: () => setState(() {
                    _selectionEpoch++;
                    _selected = null;
                    _detail = null;
                    _opening = false;
                    _detailError = null;
                  }),
                  icon: const Icon(Icons.close),
                ),
              ],
            ),
            if (_opening) const LinearProgressIndicator(),
            if (_detailError != null)
              Text(_detailError!, style: TextStyle(color: scheme.error)),
            if (visibleSummary.isNotEmpty) SelectableText(visibleSummary),
            Text(
              '${selected['sourceCount']} sources · ${connected.length} connections',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            if (connected.isNotEmpty) ...[
              const SizedBox(height: 12),
              Text(
                'Connected items',
                style: Theme.of(context).textTheme.titleSmall,
              ),
              for (final node in connected.take(12))
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  title: Text(_name(node, order)),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _open(node['id'] as String),
                ),
            ],
            ExpansionTile(
              title: const Text('Technical reference'),
              children: [
                SelectableText(_selected!),
                if (_detail != null &&
                    _detail!['label'] != _name(selected, order))
                  SelectableText('Original name: ${_detail!['label']}'),
                if (_detail?['summary'] != null &&
                    visibleSummary != _detail!['summary']) ...[
                  const Text('Original source summary'),
                  SelectableText(_detail!['summary'] as String),
                ],
              ],
            ),
            const Divider(),
          ] else ...[
            Text(
              'Start with an item',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const Text(
              'Select a dot or a row below. Names and details open with your current access.',
            ),
          ],
          const SizedBox(height: 8),
          for (final node in visible)
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              selected: node['id'] == _selected,
              title: Text(_name(node, order)),
              subtitle: Text('${node['sourceCount']} sources'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => _open(node['id'] as String),
            ),
          const ExpansionTile(
            title: Text('Map coverage'),
            children: [
              Padding(
                padding: EdgeInsets.all(12),
                child: Text(
                  'This private sample shows one selected item and up to 12 direct connections. More may exist outside this map. Names open on request. Start in Knowledge map to browse your saved memory and source titles.',
                ),
              ),
            ],
          ),
        ],
      );
    },
  );
}

class _MapLink {
  const _MapLink(this.from, this.to);
  final String from, to;
}

Map<String, Offset> _mapLayout(
  List<Map<String, dynamic>> nodes,
  String? selected,
) {
  final points = <String, Offset>{};
  final related = nodes.where((node) => node['id'] != selected).toList();
  if (selected != null && nodes.any((node) => node['id'] == selected)) {
    points[selected] = const Offset(220, 270);
    for (var i = 0; i < related.length; i++) {
      points[related[i]['id'] as String] = Offset(
        650,
        35 + i * math.min(40.0, 460 / math.max(1, related.length - 1)),
      );
    }
  } else {
    for (var i = 0; i < nodes.length; i++) {
      points[nodes[i]['id'] as String] = Offset(
        160 + (i % 3) * 285,
        65 + (i ~/ 3) * 125,
      );
    }
  }
  return points;
}

class _MapEdgesPainter extends CustomPainter {
  const _MapEdgesPainter({
    required this.points,
    required this.edges,
    required this.selected,
    required this.color,
    required this.accent,
  });
  final Map<String, Offset> points;
  final List<_MapLink> edges;
  final String? selected;
  final Color color, accent;
  @override
  void paint(Canvas canvas, Size size) {
    for (final edge in edges) {
      final from = points[edge.from], to = points[edge.to];
      if (from == null || to == null) continue;
      final active = edge.from == selected || edge.to == selected;
      final paint = Paint()
        ..color = (active ? accent : color)
        ..strokeWidth = (active ? 1.6 : 1);
      canvas.drawLine(from, to, paint);
    }
  }

  @override
  bool shouldRepaint(covariant _MapEdgesPainter oldDelegate) =>
      oldDelegate.points != points ||
      oldDelegate.selected != selected ||
      oldDelegate.color != color ||
      oldDelegate.accent != accent;
}
