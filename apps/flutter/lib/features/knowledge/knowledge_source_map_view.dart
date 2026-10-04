import 'package:flutter/material.dart';

import '../../core/network/api_exception.dart';
import 'knowledge.dart';
import 'knowledge_mutations.dart';
import 'knowledge_mutation_widgets.dart';
import 'knowledge_private_action_contracts.dart';

class KnowledgeSourceMaps extends StatefulWidget {
  const KnowledgeSourceMaps({
    super.key,
    required this.controller,
    this.active = true,
  });
  final KnowledgeController controller;
  final bool active;
  @override
  State<KnowledgeSourceMaps> createState() => _KnowledgeSourceMapsState();
}

class _KnowledgeSourceMapsState extends State<KnowledgeSourceMaps>
    with WidgetsBindingObserver {
  final _exact = TextEditingController();
  List<KnowledgeSourceMap> _rows = const [];
  KnowledgeSourceMap? _review;
  String _status = 'pending_review';
  String? _selected, _listError, _detailError, _decision;
  bool _loading = false, _reading = false, _saving = false, _foreground = true;
  int _listEpoch = 0, _detailEpoch = 0;
  bool get _current =>
      mounted && widget.active && _foreground && widget.controller.available;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    _load();
  }

  void _reset() {
    _listEpoch++;
    _detailEpoch++;
    _rows = const [];
    _review = null;
    _selected = _listError = _detailError = _decision = null;
    _loading = _reading = _saving = false;
    _exact.clear();
  }

  @override
  void didUpdateWidget(covariant KnowledgeSourceMaps oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller) ||
        oldWidget.active != widget.active) {
      _reset();
      _load();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    setState(_reset);
    _load();
  }

  @override
  void dispose() {
    _listEpoch++;
    _detailEpoch++;
    WidgetsBinding.instance.removeObserver(this);
    _exact.dispose();
    super.dispose();
  }

  bool _denied(Object error) =>
      error is ApiException && [401, 403, 404].contains(error.statusCode);
  String _failure(Object error) => error is FormatException
      ? error.message
      : _denied(error)
      ? 'This private source map is unavailable to the current account. A submitted decision remains held until its exact acceptance can be read.'
      : 'The current source-map read is unavailable. Retry the read; saved decisions remain recorded.';
  Future<void> _load() async {
    if (!_current || !widget.controller.sourceMapsAvailable) {
      return;
    }
    final controller = widget.controller,
        epoch = ++_listEpoch,
        status = _status;
    bool current() =>
        _current &&
        identical(controller, widget.controller) &&
        epoch == _listEpoch;
    setState(() {
      _loading = true;
      _listError = null;
    });
    try {
      final rows = await controller.sourceMaps(status: status);
      if (current()) {
        setState(() => _rows = rows);
      }
    } catch (error) {
      if (current()) {
        setState(() {
          _listError = _failure(error);
          if (_denied(error)) {
            _rows = const [];
          }
        });
      }
    } finally {
      if (current()) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _open(String id) async {
    if (!_current) {
      return;
    }
    final controller = widget.controller, epoch = ++_detailEpoch;
    bool current() =>
        _current &&
        identical(controller, widget.controller) &&
        epoch == _detailEpoch;
    setState(() {
      if (_selected != id) {
        _review = null;
      }
      _selected = id;
      _reading = true;
      _detailError = _decision = null;
    });
    try {
      final read = await controller.inspectSourceMap(id);
      if (current()) {
        setState(() => _review = read.review);
      }
    } catch (error) {
      if (current()) {
        setState(() {
          _detailError = _failure(error);
          if (_denied(error)) {
            _review = null;
          }
        });
      }
    } finally {
      if (current()) {
        setState(() => _reading = false);
      }
    }
  }

  Future<void> _decide(KnowledgeSourceMap review, String decision) async {
    final controller = widget.controller, epoch = _detailEpoch;
    bool current() =>
        _current &&
        identical(controller, widget.controller) &&
        epoch == _detailEpoch &&
        identical(_review, review) &&
        !_reading &&
        _detailError == null &&
        _decision == decision;
    if (!current() || _saving) {
      return;
    }
    setState(() => _saving = true);
    try {
      await controller.decideSourceMap(
        review,
        decision,
        isReviewCurrent: current,
      );
      if (current() && controller.pendingChange == null) {
        setState(() => _saving = false);
        await _open(review.id);
        await _load();
      }
    } catch (error) {
      if (current()) {
        setState(() => _detailError = _failure(error));
      }
    } finally {
      if (mounted &&
          identical(controller, widget.controller) &&
          epoch == _detailEpoch) {
        setState(() => _saving = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller, review = _review;
      if (!_current) {
        return const Center(
          child: Text('Unlock and sign in to read private source maps.'),
        );
      }
      if (!controller.sourceMapsAvailable) {
        return const Padding(
          padding: EdgeInsets.all(20),
          child: Text(
            'Source-map reviews are unavailable for this account or app version. Check access or update the app.',
          ),
        );
      }
      final canDecide =
          !_reading &&
          !_saving &&
          _detailError == null &&
          review?.pin != null &&
          controller.supportsChange(MemoryChange.sourceMap) &&
          controller.pendingChange == null &&
          !controller.changing;
      return ListView(
        key: ValueKey(_selected ?? 'source-maps'),
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Review private source maps',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          const Text(
            'Inspect source evidence before confirming a source map as a private memory. A saved decision is separate from relationship projection.',
          ),
          MemoryChangeStatus(controller: controller),
          if (_selected == null) ...[
            const Text(
              'Showing up to 25 reviews; the full count is unavailable.',
            ),
            DropdownButtonFormField<String>(
              initialValue: _status,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Source-map status'),
              items: [
                for (final status in sourceMapStatuses)
                  DropdownMenuItem(
                    value: status,
                    child: Text(status.replaceAll('_', ' ')),
                  ),
              ],
              onChanged: _loading
                  ? null
                  : (value) {
                      setState(() {
                        _status = value!;
                        _rows = const [];
                      });
                      _load();
                    },
            ),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: OutlinedButton(
                onPressed: _loading ? null : _load,
                child: const Text('Refresh source maps'),
              ),
            ),
            if (_loading) const Text('Reading private source maps…'),
            if (_listError != null) Text(_listError!),
            if (_listError != null && _rows.isNotEmpty)
              const Text(
                'Showing the last verified rows. Current freshness is unavailable.',
              ),
            if (!_loading && _listError == null && _rows.isEmpty)
              const Text('No source maps were returned for this status.'),
            for (final row in _rows)
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        row.title,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      Text(
                        '${row.status.replaceAll('_', ' ')} · batch ${(row.raw['batchIndex'] as int) + 1} of ${row.raw['batchCount']}',
                      ),
                      OutlinedButton(
                        onPressed: () => _open(row.id),
                        child: const Text('Inspect source-map evidence'),
                      ),
                    ],
                  ),
                ),
              ),
            TextField(
              controller: _exact,
              decoration: const InputDecoration(
                labelText: 'Exact source-map review ID',
              ),
              onSubmitted: (value) => _open(value.trim()),
            ),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: OutlinedButton(
                onPressed: () => _open(_exact.text.trim()),
                child: const Text('Open exact source map'),
              ),
            ),
          ] else ...[
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                TextButton(
                  onPressed: () => setState(() {
                    _detailEpoch++;
                    _selected = _decision = _detailError = null;
                    _review = null;
                    _reading = _saving = false;
                  }),
                  child: const Text('Back to source maps'),
                ),
                OutlinedButton(
                  onPressed: _reading || _saving
                      ? null
                      : () => _open(_selected!),
                  child: const Text('Refresh exact source map'),
                ),
              ],
            ),
            if (_reading)
              const Text('Reading exact source evidence and policy…'),
            if (_detailError != null) Text(_detailError!),
            if (review != null) ...[
              if (_detailError != null)
                const Text(
                  'Last verified evidence. Decisions remain disabled until a fresh read succeeds.',
                ),
              Text(review.title, style: Theme.of(context).textTheme.titleLarge),
              Text(
                'Review: ${review.status.replaceAll('_', ' ')} · relationship projection: ${review.raw['projection']}',
              ),
              const SizedBox(height: 12),
              SelectableText(review.summary),
              Text(
                'Model confidence: ${(review.raw['summary'] as Map)['confidenceBasisPoints']} / 10000. This is not independent verification.',
              ),
              const SizedBox(height: 12),
              Text(
                'Quoted source evidence',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              for (final quote
                  in (review.raw['summary'] as Map)['evidence'] as List)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: SelectableText((quote as Map)['quote'] as String),
                ),
              for (final (key, title, field) in [
                ('topics', 'Topics', 'label'),
                ('claims', 'Claims', 'statement'),
                ('entities', 'Named entities', 'canonicalLabel'),
                ('relations', 'Relationships', 'statement'),
              ])
                ExpansionTile(
                  title: Text('$title (${(review.raw[key] as List).length})'),
                  children: [
                    for (final item in review.raw[key] as List)
                      Padding(
                        padding: const EdgeInsets.all(12),
                        child: SelectableText((item as Map)[field] as String),
                      ),
                  ],
                ),
              ExpansionTile(
                title: const Text('Exact source identity and retention'),
                children: [
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: SelectableText(
                      'Review: ${review.id}\nDocument: ${review.raw['documentId']}\n${review.pin == null ? 'No current decision pin is available.' : 'Source revision: ${review.pin!['sourceRevisionId']}\nSource policy: ${review.pin!['sourcePolicySha256']}\nRetention expiry: ${review.pin!['retentionExpiresAt'] ?? 'None reported'}\nReview digest: ${review.pin!['reviewSha256']}'}',
                    ),
                  ),
                ],
              ),
              if (review.pin == null ||
                  !controller.supportsChange(MemoryChange.sourceMap))
                const Text(
                  'This review is readable, but current source-map decision authority is unavailable.',
                ),
              Wrap(
                spacing: 12,
                runSpacing: 8,
                children: [
                  for (final decision in review.allowed)
                    OutlinedButton(
                      onPressed: canDecide
                          ? () => setState(() => _decision = decision)
                          : null,
                      child: Text(
                        decision == 'confirm'
                            ? 'Save source map as memory'
                            : 'Dismiss source map',
                      ),
                    ),
                ],
              ),
              if (_decision != null)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _decision == 'confirm'
                              ? 'Confirm the reviewed source map?'
                              : 'Dismiss this source map?',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        Text(
                          _decision == 'confirm'
                              ? 'Save the reviewed candidate as your private memory. Relationship updates may remain unconfirmed; this decision does not authorize maintenance or external actions.'
                              : 'Record this dismissal without deleting the source document.',
                        ),
                        Wrap(
                          spacing: 12,
                          runSpacing: 8,
                          children: [
                            TextButton(
                              onPressed: _saving
                                  ? null
                                  : () => setState(() => _decision = null),
                              child: const Text('Cancel source-map decision'),
                            ),
                            FilledButton(
                              onPressed: canDecide
                                  ? () => _decide(review, _decision!)
                                  : null,
                              child: Text(
                                _decision == 'confirm'
                                    ? 'Confirm source-map memory'
                                    : 'Confirm source-map dismissal',
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ],
        ],
      );
    },
  );
}
