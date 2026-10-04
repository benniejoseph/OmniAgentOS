import 'package:flutter/material.dart';

import '../../core/network/api_exception.dart';
import 'knowledge.dart';
import 'knowledge_mutations.dart';
import 'knowledge_mutation_widgets.dart';
import 'knowledge_private_action_contracts.dart';

class KnowledgeSourceCleanup extends StatefulWidget {
  const KnowledgeSourceCleanup({
    super.key,
    required this.controller,
    this.active = true,
  });
  final KnowledgeController controller;
  final bool active;
  @override
  State<KnowledgeSourceCleanup> createState() => _KnowledgeSourceCleanupState();
}

class _KnowledgeSourceCleanupState extends State<KnowledgeSourceCleanup>
    with WidgetsBindingObserver {
  String _kind = 'mail';
  KnowledgeSourceDeletionReview? _review;
  String? _error;
  bool _loading = false,
      _saving = false,
      _confirmed = false,
      _foreground = true;
  int _epoch = 0;
  bool get _current =>
      mounted && widget.active && _foreground && widget.controller.available;
  static const _names = {
    'google': 'All Google imports',
    'mail': 'Gmail imports',
    'calendar': 'Google Calendar imports',
    'drive': 'Google Drive imports',
  };
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
  }

  void _reset() {
    _epoch++;
    _review = null;
    _error = null;
    _loading = _saving = _confirmed = false;
  }

  @override
  void didUpdateWidget(covariant KnowledgeSourceCleanup oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller) ||
        oldWidget.active != widget.active) {
      _reset();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    setState(_reset);
  }

  @override
  void dispose() {
    _epoch++;
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  String _failure(Object error) => error is FormatException
      ? error.message
      : 'Current local source information is unavailable. A saved deletion request remains held until its exact receipt can be read.';
  Future<void> _load() async {
    if (!_current || _loading || _saving) {
      return;
    }
    final controller = widget.controller, epoch = ++_epoch, kind = _kind;
    bool current() =>
        _current && identical(controller, widget.controller) && epoch == _epoch;
    setState(() {
      _loading = true;
      _confirmed = false;
      _error = null;
    });
    try {
      final review = await controller.inspectSourceDeletion(kind);
      if (current()) {
        setState(() => _review = review);
      }
    } catch (error) {
      if (current()) {
        setState(() {
          _error = _failure(error);
          if (error is ApiException &&
              [401, 403, 404].contains(error.statusCode)) {
            _review = null;
          }
        });
      }
    } finally {
      if (current()) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _delete(KnowledgeSourceDeletionReview review) async {
    final controller = widget.controller, epoch = _epoch;
    bool current() =>
        _current &&
        identical(widget.controller, controller) &&
        epoch == _epoch &&
        identical(_review, review) &&
        _confirmed &&
        !_loading &&
        _error == null;
    if (!current() || _saving) {
      return;
    }
    setState(() => _saving = true);
    try {
      await controller.deleteReviewedSource(review, isReviewCurrent: current);
      if (current() && controller.pendingChange == null) {
        setState(() {
          _confirmed = false;
          _review = null;
        });
      }
    } catch (error) {
      if (current()) {
        setState(() => _error = _failure(error));
      }
    } finally {
      if (mounted &&
          identical(widget.controller, controller) &&
          epoch == _epoch) {
        setState(() => _saving = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller, review = _review, pin = review?.pin;
      if (!_current) {
        return const Center(
          child: Text('Unlock and sign in to review local source cleanup.'),
        );
      }
      if (!controller.sourceDeletionAvailable) {
        return const Padding(
          padding: EdgeInsets.all(20),
          child: Text(
            'Local source cleanup is unavailable for this account or app version. Check access or update the app.',
          ),
        );
      }
      final enabled =
          !_loading &&
          !_saving &&
          controller.pendingChange == null &&
          !controller.changing;
      return ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Remove imported sources from Memory',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          const Text(
            'This removes only your reviewed private local imports and their eligible derived Memory records. Gmail messages, Calendar events, and Drive files remain upstream. Connector access stays connected; future imports may bring content back.',
          ),
          MemoryChangeStatus(controller: controller),
          DropdownButtonFormField<String>(
            initialValue: _kind,
            isExpanded: true,
            decoration: const InputDecoration(
              labelText: 'Imported source scope',
            ),
            items: [
              for (final entry in _names.entries)
                DropdownMenuItem(value: entry.key, child: Text(entry.value)),
            ],
            onChanged: enabled
                ? (kind) => setState(() {
                    _reset();
                    _kind = kind!;
                  })
                : null,
          ),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: OutlinedButton(
              onPressed: enabled ? _load : null,
              child: const Text('Review local deletion impact'),
            ),
          ),
          if (_loading)
            const Text('Reading the complete bounded local deletion manifest…'),
          if (_error != null) Text(_error!),
          if (_error != null && review != null)
            const Text(
              'Showing the last verified impact. Deletion is disabled until a fresh review succeeds.',
            ),
          if (review != null) ...[
            Text(
              _names[review.kind]!,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            if (!review.eligible)
              Text(switch (review.review['reason']) {
                'scope_too_large' => 'This scope exceeds the complete native review bounds. No deletion can be admitted from a partial manifest.',
                'unsupported_memory_lineage' => 'Some derived Memory lineage cannot be safely deleted through this action.',
                'write_permission_required' => 'An operator or administrator role is required to delete these local sources.',
                _ => 'This local source scope is not eligible for deletion.',
              }),
            if (pin != null) ...[
              Text('${pin['documentCount']} local documents'),
              Text('${pin['derivedMemoryCount']} derived Memory records'),
              Text('${pin['retrievalTraceCount']} retrieval traces'),
              Text(
                '${pin['graphNodeCount']} relationship points and ${pin['graphEdgeCount']} relationships',
              ),
              ExpansionTile(
                title: Text(
                  'Complete document list (${(review.review['documents'] as List).length})',
                ),
                children: [
                  for (final item in review.review['documents'] as List)
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: SelectableText(
                        '${(item as Map)['title']}\n${item['id']}\n${item['expired'] == true ? 'Retention expired' : 'Current local document'}',
                      ),
                    ),
                ],
              ),
              ExpansionTile(
                title: const Text('Exact deletion manifest'),
                children: [
                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: SelectableText(
                      'Manifest: ${pin['manifestSha256']}\nPolicy: ${pin['policySha256']}\nReviewed impact: ${pin['reviewSha256']}',
                    ),
                  ),
                ],
              ),
            ],
            if (review.eligible) ...[
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _confirmed,
                onChanged: enabled && _error == null
                    ? (value) => setState(() => _confirmed = value == true)
                    : null,
                title: const Text(
                  'I reviewed this local deletion impact and understand that future imports may reappear.',
                ),
              ),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: FilledButton(
                  onPressed:
                      enabled &&
                          _confirmed &&
                          _error == null &&
                          controller.supportsChange(MemoryChange.sourceDelete)
                      ? () => _delete(review)
                      : null,
                  child: const Text('Delete reviewed local sources'),
                ),
              ),
            ],
          ],
        ],
      );
    },
  );
}
