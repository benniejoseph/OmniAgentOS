import 'package:flutter/material.dart';

import '../../core/network/api_exception.dart';
import 'knowledge.dart';
import 'knowledge_mutations.dart';
import 'knowledge_mutation_widgets.dart';
import 'knowledge_read_widgets.dart' show MemoryEvidenceDetails;
import 'knowledge_review_contracts.dart';

class KnowledgeReviews extends StatefulWidget {
  const KnowledgeReviews({super.key, required this.controller});
  final KnowledgeController controller;
  @override
  State<KnowledgeReviews> createState() => _KnowledgeReviewsState();
}

class _KnowledgeReviewsState extends State<KnowledgeReviews>
    with WidgetsBindingObserver {
  final _exact = TextEditingController();
  final _listFocus = FocusNode(), _detailFocus = FocusNode();
  final _detailKey = GlobalKey();
  List<MemoryReview>? _reviews;
  MemoryReviewRead? _detail;
  String _status = 'pending';
  String? _selectedId, _listError, _detailError, _decisionError;
  String? _confirmation;
  bool _loading = false, _reading = false, _visible = true, _deciding = false;
  int _listEpoch = 0, _detailEpoch = 0;
  bool get _current => mounted && _visible && widget.controller.available;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _visible =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    _list();
  }

  @override
  void didUpdateWidget(covariant KnowledgeReviews oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller)) {
      _listEpoch++;
      _detailEpoch++;
      _reviews = null;
      _detail = null;
      _selectedId = null;
      _confirmation = null;
      _listError = _detailError = _decisionError = null;
      _exact.clear();
      _deciding = false;
      _loading = _reading = false;
      _list();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _visible = state == AppLifecycleState.resumed;
    _listEpoch++;
    _detailEpoch++;
    setState(() {
      _reviews = null;
      _detail = null;
      _confirmation = null;
      _loading = _reading = false;
    });
    if (_visible) {
      _list();
    }
  }

  @override
  void dispose() {
    _listEpoch++;
    _detailEpoch++;
    WidgetsBinding.instance.removeObserver(this);
    _exact.dispose();
    _listFocus.dispose();
    _detailFocus.dispose();
    super.dispose();
  }

  String _error(Object error) => error is FormatException
      ? error.message
      : error is ApiException &&
            const {401, 403, 404}.contains(error.statusCode)
      ? 'This exact private review is unavailable to the current account. An earlier submitted decision remains unconfirmed until its matching acceptance can be read.'
      : 'The live review read did not finish. Retry the read; no decision is inferred from this failure.';

  Future<void> _list() async {
    if (!_current || !widget.controller.reviewsAvailable) {
      return;
    }
    final controller = widget.controller,
        epoch = ++_listEpoch,
        status = _status;
    bool current() =>
        _current &&
        identical(widget.controller, controller) &&
        epoch == _listEpoch;
    setState(() {
      _loading = true;
      _listError = null;
    });
    try {
      final rows = await controller.reviews(status: status);
      if (current()) {
        setState(() => _reviews = rows);
      }
    } catch (error) {
      if (current()) {
        setState(() {
          _listError = _error(error);
          if (error is ApiException &&
              const {401, 403}.contains(error.statusCode)) {
            _reviews = null;
            _detail = null;
            _detailEpoch++;
          }
        });
      }
    } finally {
      if (current()) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _read(String id, {bool focus = true}) async {
    if (!_current || !widget.controller.reviewsAvailable) {
      return;
    }
    try {
      memoryReviewId(id);
    } catch (_) {
      setState(() => _detailError = 'Enter the complete exact review ID.');
      return;
    }
    final controller = widget.controller, epoch = ++_detailEpoch;
    bool current() =>
        _current &&
        identical(widget.controller, controller) &&
        epoch == _detailEpoch &&
        _selectedId == id;
    setState(() {
      if (_selectedId != id) {
        _detail = null;
      }
      _selectedId = id;
      _confirmation = null;
      _reading = true;
      _detailError = _decisionError = null;
    });
    try {
      final result = await controller.inspectReview(id);
      if (current()) {
        setState(() => _detail = result);
      }
    } catch (error) {
      if (current()) {
        setState(() {
          _detailError = _error(error);
          if (error is ApiException &&
              const {401, 403, 404}.contains(error.statusCode)) {
            _detail = null;
          }
        });
      }
    } finally {
      if (current()) {
        setState(() => _reading = false);
        if (focus) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (!current()) {
              return;
            }
            _detailFocus.requestFocus();
            final detailContext = _detailKey.currentContext;
            if (detailContext != null) {
              Scrollable.ensureVisible(detailContext, alignment: 0.05);
            }
          });
        }
      }
    }
  }

  Future<void> _decide(MemoryReview reviewed, String decision) async {
    final controller = widget.controller, epoch = _detailEpoch;
    bool current() =>
        _current &&
        identical(widget.controller, controller) &&
        epoch == _detailEpoch &&
        _selectedId == reviewed.id &&
        identical(_detail?.review, reviewed) &&
        !_reading &&
        _detailError == null;
    if (!current() ||
        _deciding ||
        controller.pendingChange != null ||
        !controller.supportsChange(MemoryChange.review) ||
        !reviewed.actionable) {
      return;
    }
    setState(() => _deciding = true);
    try {
      await controller.resolveReview(
        reviewed,
        decision,
        isReviewCurrent: current,
      );
      if (current() && controller.pendingChange == null) {
        await _read(reviewed.id);
      }
    } catch (error) {
      if (current()) {
        setState(() => _decisionError = _error(error));
      }
    } finally {
      if (mounted && identical(widget.controller, controller)) {
        setState(() => _deciding = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      if (!_current) {
        return const Center(
          child: Text('Unlock and sign in to inspect private Memory reviews.'),
        );
      }
      if (!controller.reviewsAvailable) {
        return const Padding(
          padding: EdgeInsets.all(20),
          child: Text(
            'Your private Memory reviews are unavailable for this account or app version. Check account access or update the app, then reopen Reviews.',
          ),
        );
      }
      final reviewed = _detail?.review;
      final canDecide =
          reviewed?.actionable == true &&
          !_reading &&
          !_deciding &&
          _detailError == null &&
          controller.pendingChange == null &&
          !controller.changing &&
          controller.supportsChange(MemoryChange.review);
      return ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Focus(
            focusNode: _listFocus,
            child: Text(
              'Memory reviews',
              style: Theme.of(context).textTheme.titleLarge,
            ),
          ),
          const Text(
            'Your private Memory reviews. Showing up to 50 reviews; the full count is unavailable.',
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 12,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              SizedBox(
                width: 240,
                child: DropdownButtonFormField<String>(
                  initialValue: _status,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Review status'),
                  items: const [
                    DropdownMenuItem(value: 'pending', child: Text('Pending')),
                    DropdownMenuItem(
                      value: 'resolved',
                      child: Text('Resolved'),
                    ),
                    DropdownMenuItem(value: 'all', child: Text('All')),
                  ],
                  onChanged: _loading
                      ? null
                      : (value) {
                          if (value != null) {
                            setState(() {
                              _status = value;
                              _reviews = null;
                            });
                            _list();
                          }
                        },
                ),
              ),
              OutlinedButton(
                onPressed: _loading ? null : _list,
                child: const Text('Refresh reviews'),
              ),
            ],
          ),
          MemoryChangeStatus(controller: controller),
          if (_loading) const Text('Reading your private Memory reviews…'),
          if (_listError != null) Text(_listError!),
          if (_reviews == null && !_loading)
            const Text(
              'Queue contents are unavailable until an authorized read succeeds.',
            ),
          if (_reviews != null)
            Text(
              '${_reviews!.length} reviews in the ${_listError != null ? 'last loaded' : 'loaded'} bounded window.',
            ),
          for (final row in _reviews ?? const <MemoryReview>[])
            Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      row.candidate.title,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    Text('${row.kind} · ${row.status}'),
                    SelectableText(row.id),
                    OutlinedButton(
                      onPressed: () => _read(row.id),
                      child: const Text('Inspect exact review'),
                    ),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 16),
          TextField(
            controller: _exact,
            maxLength: 200,
            decoration: const InputDecoration(
              labelText: 'Exact review ID, including outside this window',
            ),
            onSubmitted: (value) => _read(value.trim()),
          ),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: OutlinedButton(
              onPressed: () => _read(_exact.text.trim()),
              child: const Text('Read exact review'),
            ),
          ),
          if (_selectedId != null) ...[
            const Divider(),
            Focus(
              key: _detailKey,
              focusNode: _detailFocus,
              child: Text(
                'Exact review',
                style: Theme.of(context).textTheme.titleLarge,
              ),
            ),
            SelectableText(_selectedId!),
            Wrap(
              spacing: 12,
              children: [
                OutlinedButton(
                  onPressed: _reading ? null : () => _read(_selectedId!),
                  child: const Text('Refresh exact review'),
                ),
                TextButton(
                  onPressed: () {
                    setState(() {
                      _detailEpoch++;
                      _selectedId = null;
                      _detail = null;
                      _reading = false;
                      _detailError = null;
                      _confirmation = null;
                    });
                    _listFocus.requestFocus();
                  },
                  child: const Text('Close review'),
                ),
              ],
            ),
          ],
          if (_reading)
            const Text('Reading the exact current review and targets…'),
          if (_detailError != null) Text(_detailError!),
          if (reviewed != null) ...[
            if (_reading || _detailError != null)
              const Text(
                'Last loaded targets are shown for reference. Decisions require a fresh exact read.',
              ),
            Text(
              '${reviewed.kind} · ${reviewed.status} · ${reviewed.raw['detectionReason']}',
            ),
            if (reviewed.decision != null)
              Text('Recorded decision: ${_decisionLabel(reviewed.decision!)}'),
            if (!reviewed.actionable && reviewed.status == 'pending')
              const Text(
                'This review is readable, but no current decision token is available. Reading these records does not authorize a decision.',
              ),
            _memory('Candidate memory', reviewed.candidate),
            if (reviewed.existing != null)
              _memory('Existing memory', reviewed.existing!),
            if (reviewed.status == 'pending')
              Wrap(
                spacing: 12,
                runSpacing: 8,
                children: [
                  for (final decision in memoryReviewDecisions.where(
                    (value) =>
                        value != 'keep_both' ||
                        reviewed.kind == 'contradiction',
                  ))
                    OutlinedButton(
                      onPressed: canDecide
                          ? () => setState(() => _confirmation = decision)
                          : null,
                      child: Text(_decisionLabel(decision)),
                    ),
                ],
              ),
            if (_confirmation != null && reviewed.status == 'pending')
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Confirm: ${_decisionLabel(_confirmation!)}'),
                      SelectableText(
                        'Review: ${reviewed.id}\nCandidate: ${reviewed.candidate.id}${reviewed.existing == null ? '' : '\nExisting: ${reviewed.existing!.id}'}',
                      ),
                      Text(_decisionMeaning(_confirmation!, reviewed.kind)),
                      const Text(
                        'This saves a memory decision. Graph and entity projection outcomes are reported separately.',
                      ),
                      Wrap(
                        spacing: 12,
                        children: [
                          TextButton(
                            onPressed: _deciding
                                ? null
                                : () => setState(() => _confirmation = null),
                            child: const Text('Cancel decision'),
                          ),
                          FilledButton(
                            onPressed: canDecide
                                ? () => _decide(reviewed, _confirmation!)
                                : null,
                            child: const Text('Save reviewed decision'),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            if (_decisionError != null) Text(_decisionError!),
          ],
          if (controller.acceptedChange?.submission.kind ==
              MemoryChange.review) ...[
            const Divider(),
            const Text('Saved decision and projection status'),
            if (controller.acceptedChange!.raw['projections'] is Map)
              for (final entry
                  in (controller.acceptedChange!.raw['projections'] as Map)
                      .entries)
                Text('${entry.key}: ${entry.value}')
            else
              const Text(
                'Acceptance was recovered by an exact read. Downstream graph and entity projection outcomes were not returned and remain unconfirmed here.',
              ),
          ],
        ],
      );
    },
  );

  Widget _memory(String label, MemoryRecord record) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: Theme.of(context).textTheme.titleMedium),
          SelectableText(record.id),
          Text(record.title),
          SelectableText(record.content),
          MemoryEvidenceDetails(memory: record),
        ],
      ),
    ),
  );
}

String _decisionLabel(String decision) => switch (decision) {
  'confirm_candidate' => 'Confirm candidate',
  'keep_existing' => 'Keep existing',
  'keep_both' => 'Keep both',
  _ => 'Unknown decision',
};
String _decisionMeaning(String decision, String kind) => switch (decision) {
  'confirm_candidate' =>
    kind == 'contradiction'
        ? 'Accept the candidate and mark the conflicting existing claim as contradicted.'
        : 'Accept this candidate as active memory.',
  'keep_existing' =>
    kind == 'contradiction'
        ? 'Keep the existing claim active and mark the candidate as superseded.'
        : 'Do not accept this candidate; mark it as superseded.',
  _ => 'Accept the candidate while keeping the existing claim active.',
};
