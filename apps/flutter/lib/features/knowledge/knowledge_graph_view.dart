import 'package:flutter/material.dart';

import '../../core/network/api_exception.dart';
import 'knowledge.dart';
import 'knowledge_contracts.dart';
import 'knowledge_graph_contracts.dart';
import 'knowledge_private_action_contracts.dart';

/// Current private reads are independent of graph maintenance and effect actions.
class KnowledgeGraphExplorer extends StatefulWidget {
  const KnowledgeGraphExplorer({
    super.key,
    required this.controller,
    this.active = true,
  });
  final KnowledgeController controller;
  final bool active;
  @override
  State<KnowledgeGraphExplorer> createState() => _KnowledgeGraphExplorerState();
}

class _KnowledgeGraphExplorerState extends State<KnowledgeGraphExplorer>
    with WidgetsBindingObserver {
  final _id = TextEditingController(),
      _search = TextEditingController(),
      _validAt = TextEditingController(),
      _recordedAt = TextEditingController();
  String _view = 'universe', _relation = 'all', _epistemic = 'all';
  int _limit = 200, _hops = 2, _epoch = 0;
  bool _history = false, _reading = false, _foreground = true;
  String? _error;
  KnowledgeGraphRead? _result;
  KnowledgeJson? _lastQuery;
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
    _read();
  }

  void _clear() {
    _epoch++;
    _reading = false;
    _result = null;
    _lastQuery = null;
    _error = null;
    for (final field in [_id, _search, _validAt, _recordedAt]) {
      field.clear();
    }
    _view = 'universe';
    _limit = 200;
    _hops = 2;
    _relation = _epistemic = 'all';
    _history = false;
  }

  @override
  void didUpdateWidget(covariant KnowledgeGraphExplorer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(widget.controller, oldWidget.controller) ||
        widget.active != oldWidget.active) {
      _clear();
      _read();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    setState(_clear);
    _read();
  }

  @override
  void dispose() {
    _epoch++;
    WidgetsBinding.instance.removeObserver(this);
    for (final field in [_id, _search, _validAt, _recordedAt]) {
      field.dispose();
    }
    super.dispose();
  }

  KnowledgeJson _query() => switch (_view) {
    'universe' => {'limit': _limit},
    'node' || 'entity' => {'id': _id.text.trim()},
    'temporal' => {
      if (_id.text.trim().isNotEmpty) 'entityId': _id.text.trim(),
      if (_relation != 'all') 'relationTypeId': _relation,
      if (_epistemic != 'all') 'epistemicKind': _epistemic,
      if (_validAt.text.trim().isNotEmpty) 'validAt': _validAt.text.trim(),
      if (_recordedAt.text.trim().isNotEmpty)
        'recordedAt': _recordedAt.text.trim(),
      'history': _history,
      'limit': _limit,
    },
    _ => {'q': _search.text.trim(), 'maxHops': _hops, 'limit': _limit},
  };
  void _select(String view, {String? id}) {
    setState(() {
      _epoch++;
      _view = view;
      _result = null;
      _lastQuery = null;
      _reading = false;
      _error = null;
      _limit = view == 'universe'
          ? 200
          : view == 'paths'
          ? 12
          : 50;
      if (id != null) {
        _id.text = id;
      }
    });
    if (id != null || view == 'universe') {
      _read();
    }
  }

  Future<void> _read() async {
    if (!_current) {
      return;
    }
    final controller = widget.controller, epoch = ++_epoch, view = _view;
    bool current() =>
        _current && identical(widget.controller, controller) && epoch == _epoch;
    setState(() {
      _reading = true;
      _error = null;
    });
    try {
      final query = validatePrivateGraphQuery(view, _query());
      if (_lastQuery != null && !privateActionSame(query, _lastQuery)) {
        setState(() => _result = null);
      }
      final result = await controller.inspectGraph(view, query);
      if (current()) {
        setState(() {
          _result = result;
          _lastQuery = query;
        });
      }
    } catch (error) {
      if (current()) {
        setState(() {
          final denied =
              error is ApiException &&
              [401, 403, 404].contains(error.statusCode);
          if (denied) {
            _result = null;
            _lastQuery = null;
          }
          _error = error is FormatException
              ? 'Check the query: use an exact identity and ISO timestamps with a timezone where provided.'
              : denied
              ? 'This graph selection is unavailable to the current account.'
              : 'The graph read is unavailable. Any result below is the previously verified snapshot. Retry the read.';
        });
      }
    } finally {
      if (current()) {
        setState(() => _reading = false);
      }
    }
  }

  Widget _choice(
    String label,
    String selected,
    List<String> values,
    ValueChanged<String> changed,
  ) => DropdownButtonFormField<String>(
    key: ValueKey('$label:$selected'),
    initialValue: selected,
    isExpanded: true,
    decoration: InputDecoration(labelText: label),
    items: [
      for (final value in values)
        DropdownMenuItem(value: value, child: Text(value.replaceAll('_', ' '))),
    ],
    onChanged: (value) {
      if (value != null) {
        setState(() => changed(value));
      }
    },
  );
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      if (!_current) {
        return const Padding(
          padding: EdgeInsets.all(20),
          child: Text(
            'Unlock and sign in to use private graph reads. If this view remains unavailable, check account access or update the app.',
          ),
        );
      }
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
            'Your private graph',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const Text(
            'Explore a bounded private sample, inspect exact identities, or trace evidence over time. Counts describe this result only; the full total is unavailable.',
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final choice in const {
                'universe': 'Overview',
                'node': 'Exact node',
                'entity': 'Exact entity',
                'temporal': 'History',
                'paths': 'Paths',
              }.entries)
                ChoiceChip(
                  label: Text(choice.value),
                  selected: _view == choice.key,
                  onSelected: (_) => _select(choice.key),
                ),
            ],
          ),
          const SizedBox(height: 12),
          if (['node', 'entity', 'temporal'].contains(_view))
            TextField(
              controller: _id,
              decoration: InputDecoration(
                labelText: _view == 'node'
                    ? 'Exact node ID'
                    : _view == 'entity'
                    ? 'Exact entity ID'
                    : 'Entity ID · optional',
              ),
              onSubmitted: (_) => _read(),
            ),
          if (_view == 'temporal') ...[
            _choice('Relation type', _relation, [
              'all',
              ...graphRelationKinds,
            ], (value) => _relation = value),
            _choice('Evidence kind', _epistemic, [
              'all',
              ...graphEpistemicKinds,
            ], (value) => _epistemic = value),
            TextField(
              controller: _validAt,
              decoration: const InputDecoration(
                labelText: 'Valid at · optional ISO timestamp',
                helperText: 'Example: 2026-10-04T12:00:00Z',
              ),
            ),
            TextField(
              controller: _recordedAt,
              decoration: const InputDecoration(
                labelText: 'Known at · optional ISO timestamp',
              ),
            ),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Include historical revisions'),
              value: _history,
              onChanged: (value) => setState(() => _history = value ?? false),
            ),
          ],
          if (_view == 'paths') ...[
            TextField(
              controller: _search,
              maxLength: 4000,
              maxLines: 3,
              decoration: const InputDecoration(
                labelText: 'Relationship question',
              ),
              onSubmitted: (_) => _read(),
            ),
            _choice('Maximum hops', '$_hops', const [
              '1',
              '2',
              '3',
            ], (value) => _hops = int.parse(value)),
          ],
          if (!['node', 'entity'].contains(_view))
            _choice(
              'Result limit',
              '$_limit',
              _view == 'paths'
                  ? const ['6', '12', '24']
                  : _view == 'universe'
                  ? const ['50', '200', '500']
                  : const ['25', '50', '100', '200'],
              (value) => _limit = int.parse(value),
            ),
          const SizedBox(height: 12),
          FilledButton.tonal(
            onPressed: _reading ? null : _read,
            child: Text(_reading ? 'Reading graph…' : 'Read graph'),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(_error!, semanticsLabel: _error),
            ),
          if (_result != null) ..._results(_result!),
        ],
      );
    },
  );
  List<Widget> _results(KnowledgeGraphRead result) {
    final raw = result.raw;
    return [
      const SizedBox(height: 16),
      SelectableText('Verified read at ${raw['generatedAt']}'),
      if (_lastQuery != null)
        _GraphFields(value: _lastQuery!, label: 'Read filters'),
      if (result.view == 'universe') ...[
        _GraphFields(
          value: (raw['graph'] as Map)['coverage'],
          label: 'Sample coverage',
        ),
        for (final kind in ['nodes', 'entities']) ...[
          Text(
            kind == 'nodes'
                ? 'Nodes · exact details on selection'
                : 'Entities · exact details on selection',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          for (final item in (raw['graph'] as Map)[kind] as List)
            Card(
              child: ListTile(
                title: Text('${item['id']}'),
                subtitle: Text(
                  '${item['kind']} · ${item['sourceCount']} source references',
                ),
                onTap: () => _select(
                  kind == 'nodes' ? 'node' : 'entity',
                  id: item['id'] as String,
                ),
              ),
            ),
        ],
        _GraphFields(
          value: (raw['graph'] as Map)['edges'],
          label: 'Sample edges',
        ),
        _GraphFields(
          value: (raw['graph'] as Map)['relations'],
          label: 'Sample relation revisions',
        ),
      ] else if (result.view == 'node' || result.view == 'entity')
        _GraphFields(
          value: raw[result.view],
          label: 'Exact ${result.view}',
          expanded: true,
        )
      else if (result.view == 'temporal') ...[
        Text(
          '${(raw['relations'] as List).length} relation revisions · ${raw['limitReached'] == true ? 'limit reached; narrow filters for more detail' : 'bounded read'}',
        ),
        for (final relation in raw['relations'] as List)
          _GraphFields(
            value: relation,
            label:
                '${relation['relationTypeId']} · ${relation['epistemicKind']} · ${relation['claimState']}',
          ),
      ] else ...[
        Text(
          '${((raw['result'] as Map)['paths'] as List).length} authorized paths · bounded evidence only',
        ),
        for (final path in (raw['result'] as Map)['paths'] as List)
          _GraphFields(
            value: path,
            label:
                '${path['anchor']['label']} → ${path['terminal']['label']} · ${path['hopCount']} hops',
          ),
        _GraphFields(
          value: (raw['result'] as Map)['receipt'],
          label: 'Path read receipt',
        ),
      ],
    ];
  }
}

class _GraphFields extends StatelessWidget {
  const _GraphFields({
    required this.value,
    required this.label,
    this.expanded = false,
  });
  final Object? value;
  final String label;
  final bool expanded;
  @override
  Widget build(BuildContext context) {
    final data = value;
    if (data is Map) {
      return ExpansionTile(
        title: Text(label),
        initiallyExpanded: expanded,
        childrenPadding: const EdgeInsets.only(left: 8, bottom: 12),
        children: [
          for (final field in data.entries)
            _GraphFields(value: field.value, label: '${field.key}'),
        ],
      );
    }
    if (data is List) {
      return ExpansionTile(
        title: Text('$label · ${data.length}'),
        initiallyExpanded: expanded,
        childrenPadding: const EdgeInsets.only(left: 8),
        children: [
          for (var index = 0; index < data.length; index++)
            _GraphFields(value: data[index], label: '${index + 1}'),
        ],
      );
    }
    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: SelectableText('$label: ${data ?? 'not available'}'),
      ),
    );
  }
}
