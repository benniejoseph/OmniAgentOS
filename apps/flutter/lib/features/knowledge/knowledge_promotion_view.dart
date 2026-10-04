import 'package:flutter/material.dart';

import '../../core/network/api_exception.dart';
import 'knowledge.dart';
import 'knowledge_mutations.dart';
import 'knowledge_mutation_widgets.dart';
import 'knowledge_promotion_contracts.dart';
import 'knowledge_read_widgets.dart';

class KnowledgePromotions extends StatefulWidget {
  const KnowledgePromotions({
    super.key,
    required this.controller,
    this.active = true,
  });
  final KnowledgeController controller;
  final bool active;
  @override
  State<KnowledgePromotions> createState() => _KnowledgePromotionsState();
}

class _KnowledgePromotionsState extends State<KnowledgePromotions>
    with WidgetsBindingObserver {
  final _exactId = TextEditingController();
  List<MemoryPromotionSummary> _rows = const [];
  MemoryPromotionRead? _detail;
  String _status = 'pending';
  String? _selectedId, _listError, _detailError, _confirmation;
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
    _detail = null;
    _selectedId = _listError = _detailError = _confirmation = null;
    _loading = _reading = _saving = false;
    _exactId.clear();
  }

  @override
  void didUpdateWidget(covariant KnowledgePromotions oldWidget) {
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
    _exactId.dispose();
    super.dispose();
  }

  bool _denied(Object error) =>
      error is ApiException && const {401, 403, 404}.contains(error.statusCode);
  String _failure(Object error) => error is FormatException
      ? error.message
      : _denied(error)
      ? 'This promotion review is unavailable to your current account. Any submitted decision remains held until its exact receipt can be read.'
      : 'The promotion review could not be read. Retry the read; an accepted decision remains saved.';

  Future<void> _load() async {
    if (!_current || !widget.controller.promotionsAvailable) {
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
      final rows = await controller.promotions(status: status);
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
      if (_selectedId != id) {
        _detail = null;
      }
      _selectedId = id;
      _reading = true;
      _detailError = _confirmation = null;
    });
    try {
      final detail = await controller.inspectPromotion(id);
      if (current()) {
        setState(() => _detail = detail);
      }
    } catch (error) {
      if (current()) {
        setState(() {
          _detailError = _failure(error);
          if (_denied(error)) {
            _detail = null;
          }
        });
      }
    } finally {
      if (current()) {
        setState(() => _reading = false);
      }
    }
  }

  void _close() => setState(() {
    _detailEpoch++;
    _selectedId = _detailError = _confirmation = null;
    _detail = null;
    _reading = _saving = false;
  });

  Future<void> _decide(MemoryPromotionReview reviewed, String decision) async {
    final controller = widget.controller, epoch = _detailEpoch;
    bool current() =>
        _current &&
        identical(controller, widget.controller) &&
        epoch == _detailEpoch &&
        identical(_detail?.review, reviewed) &&
        !_reading &&
        _detailError == null &&
        _confirmation == decision;
    if (!current() || _saving) {
      return;
    }
    setState(() => _saving = true);
    try {
      await controller.decidePromotion(
        reviewed,
        decision,
        isReviewCurrent: current,
      );
      if (current() && controller.pendingChange == null) {
        setState(() => _saving = false);
        await _open(reviewed.id);
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
      final controller = widget.controller;
      if (!_current) {
        return const Center(
          child: Text('Unlock and sign in to view private promotion reviews.'),
        );
      }
      if (!controller.promotionsAvailable) {
        return const Padding(
          padding: EdgeInsets.all(20),
          child: Text(
            'Memory promotion reviews are unavailable for this account or app version. Check account access or update the app, then reopen Promotions.',
          ),
        );
      }
      final review = _detail?.review;
      final canDecide =
          review?.token != null &&
          !_reading &&
          !_saving &&
          _detailError == null &&
          controller.supportsChange(MemoryChange.promotion) &&
          controller.pendingChange == null &&
          !controller.changing;
      return ListView(
        key: ValueKey(_selectedId ?? 'promotion-list'),
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Your private Memory promotions',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          const Text(
            'Review repeated source evidence before saving a procedural memory. A saved decision is separate from graph and entity updates.',
          ),
          const SizedBox(height: 12),
          MemoryChangeStatus(controller: controller),
          if (_selectedId == null) ...[
            const Text(
              'Showing up to 25 reviews; the full count is unavailable.',
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _status,
              isExpanded: true,
              decoration: const InputDecoration(
                labelText: 'Promotion review status',
              ),
              items: [
                for (final status in const ['pending', 'resolved', 'all'])
                  DropdownMenuItem(value: status, child: Text(status)),
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
                child: const Text('Refresh promotion reviews'),
              ),
            ),
            if (_loading) const Text('Reading promotion reviews…'),
            if (_listError != null)
              Semantics(liveRegion: true, child: Text(_listError!)),
            if (_listError != null && _rows.isNotEmpty)
              const Text(
                'These are the last verified rows; this refresh is unavailable.',
              ),
            if (!_loading && _listError == null && _rows.isEmpty)
              const Text('No promotion reviews were returned for this status.'),
            for (final row in _rows)
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        row.title.isEmpty ? 'Untitled memory' : row.title,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      Text(
                        '${row.status} · ${row.sourceIds.length} source memories · procedural',
                      ),
                      OutlinedButton(
                        onPressed: () => _open(row.id),
                        child: const Text('Inspect promotion sources'),
                      ),
                    ],
                  ),
                ),
              ),
            const SizedBox(height: 16),
            TextField(
              controller: _exactId,
              decoration: const InputDecoration(
                labelText: 'Exact promotion review ID',
              ),
              onSubmitted: (value) => _open(value.trim()),
            ),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: OutlinedButton(
                onPressed: () => _open(_exactId.text.trim()),
                child: const Text('Open exact promotion review'),
              ),
            ),
          ] else ...[
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                TextButton(
                  onPressed: _close,
                  child: const Text('Back to promotion reviews'),
                ),
                OutlinedButton(
                  onPressed: _reading || _saving
                      ? null
                      : () => _open(_selectedId!),
                  child: const Text('Refresh promotion sources'),
                ),
              ],
            ),
            if (_reading) const Text('Reading the exact promotion sources…'),
            if (_detailError != null)
              Semantics(liveRegion: true, child: Text(_detailError!)),
            if (review != null) ...[
              if (_detailError != null)
                const Text(
                  'Last verified source read. Decisions are disabled until a fresh read succeeds.',
                ),
              Text(
                review.title.isEmpty ? 'Untitled memory' : review.title,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              Text('${review.status} · target tier: procedural'),
              if (review.decision != null)
                Text(
                  'Recorded decision: ${review.decision}. This read alone is not a receipt for a pending request.',
                ),
              const SizedBox(height: 12),
              SelectableText(review.canonical.content),
              ExpansionTile(
                title: const Text('Canonical source context and provenance'),
                children: [
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: MemoryEvidenceDetails(memory: review.canonical),
                  ),
                ],
              ),
              ExpansionTile(
                title: Text('${review.sources.length} exact source identities'),
                children: [
                  for (final source in review.sources)
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: SelectableText(
                        '${source['memoryId']}\n${source['claimStatus']} · target revision ${source['targetRevision']} · lifecycle revision ${source['lifecycleRevision']}\nSource policy: ${source['sourcePolicySha256']}',
                      ),
                    ),
                ],
              ),
              ExpansionTile(
                title: const Text('Promotion review details'),
                children: [
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: SelectableText(
                      'Review: ${review.id}\nPolicy: ${review.raw['policySha256']}\nSource manifest: ${review.raw['sourceManifestSha256']}',
                    ),
                  ),
                ],
              ),
              if (review.token == null ||
                  !controller.supportsChange(MemoryChange.promotion))
                const Text(
                  'This review is readable, but no current decision authority is available. Refresh after your Memory access changes.',
                ),
              if (review.status == 'pending' &&
                  !review.allowedDecisions.contains('promote') &&
                  review.allowedDecisions.contains('dismiss'))
                const Text(
                  'The current sources are not eligible for promotion. You may dismiss this review.',
                ),
              Wrap(
                spacing: 12,
                runSpacing: 8,
                children: [
                  for (final decision in review.allowedDecisions)
                    OutlinedButton(
                      onPressed: canDecide
                          ? () => setState(() => _confirmation = decision)
                          : null,
                      child: Text(
                        decision == 'promote'
                            ? 'Promote to procedural memory'
                            : 'Dismiss promotion review',
                      ),
                    ),
                ],
              ),
              if (_confirmation != null)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _confirmation == 'promote'
                              ? 'Save this procedural memory?'
                              : 'Dismiss this promotion review?',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          _confirmation == 'promote'
                              ? 'Confirm the canonical content and exact source evidence above. This does not authorize tools, maintenance, or external actions.'
                              : 'The source memories remain unchanged. This records your decision about this promotion review.',
                        ),
                        Wrap(
                          spacing: 12,
                          runSpacing: 8,
                          children: [
                            TextButton(
                              onPressed: _saving
                                  ? null
                                  : () => setState(() => _confirmation = null),
                              child: const Text('Cancel promotion decision'),
                            ),
                            FilledButton(
                              onPressed: canDecide
                                  ? () => _decide(review, _confirmation!)
                                  : null,
                              child: Text(
                                _confirmation == 'promote'
                                    ? 'Confirm promotion'
                                    : 'Confirm dismissal',
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
