import 'package:flutter/material.dart';

import 'knowledge.dart';
import 'knowledge_labels.dart';
import 'knowledge_mutations.dart';
import 'knowledge_mutation_widgets.dart';
export 'knowledge_reviews.dart';

class KnowledgeCoverage extends StatelessWidget {
  const KnowledgeCoverage({
    super.key,
    required this.controller,
    this.graph = false,
  });
  final KnowledgeController controller;
  final bool graph;
  @override
  Widget build(BuildContext context) {
    final state = controller.state;
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (controller.loading) const LinearProgressIndicator(),
          if (controller.error != null)
            const Text(
              'Refresh failed. The last loaded view may be stale; retry before relying on it.',
            ),
          Text(
            graph
                ? 'Visible relationship sample: ${state?.nodes.length ?? 0} points, ${state?.edges.length ?? 0} links. Connections outside this sample are not shown.'
                : 'Saved memories and source documents. Open an item to read or manage it.',
          ),

          if (graph)
            Text(
              'Graph state: ${(state?.overview['summary'] as Map?)?['graphStatus'] ?? 'not reported'}. Sampled communities are not a global total.',
            ),
        ],
      ),
    );
  }
}

class KnowledgePageControls extends StatelessWidget {
  const KnowledgePageControls({
    super.key,
    required this.controller,
    required this.memory,
  });
  final KnowledgeController controller;
  final bool memory;
  @override
  Widget build(BuildContext context) {
    final state = controller.state;
    final count = memory ? state?.memories.length : state?.knowledge.length;
    final total = memory
        ? state?.memoryCatalogTotal
        : state?.knowledgeCatalogTotal;
    final cursor = memory ? state?.memoryCursor : state?.knowledgeCursor;
    final error = memory
        ? controller.memoryPageError
        : controller.knowledgePageError;
    final loading = memory
        ? controller.loadingMoreMemory
        : controller.loadingMoreKnowledge;
    final canLoad = memory
        ? controller.canLoadMoreMemory
        : controller.canLoadMoreKnowledge;
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Wrap(
        spacing: 12,
        runSpacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text('${count ?? 0} shown${total != null ? ' of $total' : ''}'),
          if (error != null)
            const Text(
              'This page could not be read. Loaded items are retained.',
            ),
          if (cursor != null)
            OutlinedButton(
              onPressed: canLoad
                  ? (memory
                        ? controller.loadMoreMemory
                        : controller.loadMoreKnowledge)
                  : null,
              style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
              child: Text(
                loading
                    ? 'Loading page…'
                    : error != null
                    ? 'Retry page'
                    : 'Load next 40',
              ),
            ),
          if (cursor != null &&
              (count ?? 0) > KnowledgeController.maximumRetainedItems - 40)
            const Text(
              'List limit reached. Refine the search or refresh to start again.',
            ),
        ],
      ),
    );
  }
}

class KnowledgeMemoryFilters extends StatelessWidget {
  const KnowledgeMemoryFilters({super.key, required this.controller});
  final KnowledgeController controller;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(12),
    child: Wrap(
      spacing: 12,
      runSpacing: 12,
      children: [
        SizedBox(
          width: 240,
          child: DropdownButtonFormField<String>(
            key: ValueKey('tier-${controller.tier}'),
            initialValue: controller.tier,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Kind'),
            items: [
              for (final value in [
                'all',
                'episodic',
                'semantic',
                'procedural',
                'preference',
                'commitment',
                'decision',
                'summary',
              ])
                DropdownMenuItem(
                  value: value,
                  child: Text(memoryFriendlyLabel(value)),
                ),
            ],
            onChanged: controller.loading
                ? null
                : (value) => controller.filter(memoryTier: value),
          ),
        ),
        SizedBox(
          width: 240,
          child: DropdownButtonFormField<String>(
            key: ValueKey('state-${controller.claimState}'),
            initialValue: controller.claimState,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Status'),
            items: [
              for (final value in [
                'all',
                'active',
                'candidate',
                'superseded',
                'contradicted',
                'archived',
              ])
                DropdownMenuItem(
                  value: value,
                  child: Text(memoryFriendlyLabel(value)),
                ),
            ],
            onChanged: controller.loading
                ? null
                : (value) => controller.filter(stateFilter: value),
          ),
        ),
      ],
    ),
  );
}

/// This inspector owns an exact read. An index row is never its fallback body.
/// Its controller identity and request generation fence reads and impact sheets.
class KnowledgeMemoryInspector extends StatefulWidget {
  const KnowledgeMemoryInspector({
    super.key,
    required this.controller,
    required this.memoryId,
    this.onClose,
    this.exactRead,
    this.readOnly = false,
    this.onOpenWorkspace,
  });
  final KnowledgeController controller;
  final String memoryId;
  final VoidCallback? onClose;

  /// Search retains its private-active reader for every exact refresh.
  final Future<MemoryRecord> Function(String id)? exactRead;
  final bool readOnly;
  final VoidCallback? onOpenWorkspace;
  @override
  State<KnowledgeMemoryInspector> createState() =>
      _KnowledgeMemoryInspectorState();
}

class _KnowledgeMemoryInspectorState extends State<KnowledgeMemoryInspector> {
  int _generation = 0;
  MemoryRecord? _memory;
  MemoryForgetPreview? _preview;
  Object? _error, _previewError;
  bool _loading = true, _previewLoading = false;
  bool _forgetConfirmed = false;
  @override
  void initState() {
    super.initState();
    _read();
  }

  @override
  void didUpdateWidget(covariant KnowledgeMemoryInspector oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller) ||
        oldWidget.memoryId != widget.memoryId) {
      _memory = null;
      _preview = null;
      _error = _previewError = null;
      _previewLoading = false;
      _forgetConfirmed = false;
      _loading = true;
      _read();
    }
  }

  bool _current(int generation, KnowledgeController controller) =>
      mounted &&
      generation == _generation &&
      identical(widget.controller, controller) &&
      controller.available;
  Future<void> _read() async {
    final generation = ++_generation, controller = widget.controller;
    if (mounted) {
      setState(() {
        _loading = true;
        _memory = null;
        _preview = null;
        _forgetConfirmed = false;
        _error = null;
        _previewError = null;
      });
    }
    try {
      final memory =
          await (widget.exactRead?.call(widget.memoryId) ??
              controller.inspect(widget.memoryId));
      if (_current(generation, controller)) setState(() => _memory = memory);
    } catch (error) {
      if (_current(generation, controller)) setState(() => _error = error);
    } finally {
      if (_current(generation, controller)) setState(() => _loading = false);
    }
  }

  Future<void> _readImpact() async {
    final generation = _generation, controller = widget.controller;
    setState(() {
      _previewLoading = true;
      _previewError = null;
      _preview = null;
      _forgetConfirmed = false;
    });
    try {
      final value = await controller.previewForget(widget.memoryId);
      if (_current(generation, controller)) setState(() => _preview = value);
    } catch (error) {
      if (_current(generation, controller)) {
        setState(() => _previewError = error);
      }
    } finally {
      if (_current(generation, controller)) {
        setState(() => _previewLoading = false);
      }
    }
  }

  @override
  void dispose() {
    ++_generation;
    _memory = null;
    _preview = null;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      if (!widget.controller.available) {
        return const Center(
          child: Text('Sign in again to inspect this memory.'),
        );
      }
      final memory = _memory;
      return ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (widget.onClose != null)
                TextButton.icon(
                  onPressed: widget.onClose,
                  icon: const Icon(Icons.arrow_back),
                  label: const Text('Back to memory'),
                ),
              OutlinedButton(
                onPressed: _loading ? null : _read,
                child: const Text('Refresh memory'),
              ),
            ],
          ),
          if (_loading)
            const Padding(
              padding: EdgeInsets.all(20),
              child: LinearProgressIndicator(),
            ),
          if (_error != null)
            const Text(
              'This memory is unavailable or no longer accessible. Refresh to try again.',
            ),
          if (memory != null) ...[
            const SizedBox(height: 16),
            Text(memory.title, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 16),
            SelectableText(memory.content),
            const SizedBox(height: 16),
            MemoryEvidenceDetails(memory: memory),
            const SizedBox(height: 16),
            if (widget.onOpenWorkspace != null)
              OutlinedButton(
                onPressed: widget.onOpenWorkspace,
                child: const Text('Open memory workspace'),
              ),
            if (!widget.readOnly) ...[
              MemoryChangeStatus(controller: widget.controller),
              MemoryLifecycleControls(
                controller: widget.controller,
                memoryId: widget.memoryId,
              ),
              if (widget.controller.supportsChange(MemoryChange.correct) &&
                  memory.metadata.visibility == 'user_private')
                OutlinedButton(
                  onPressed: widget.controller.pendingChange != null
                      ? null
                      : () => showMemoryEditor(
                          context,
                          widget.controller,
                          memory: memory,
                        ),
                  child: const Text('Edit memory'),
                ),
              if (widget.controller.canManage)
                OutlinedButton.icon(
                  onPressed: _previewLoading ? null : _readImpact,
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(48, 48),
                  ),
                  icon: const Icon(Icons.delete_outline),
                  label: Text(
                    _previewLoading ? 'Checking deletion…' : 'Delete memory',
                  ),
                ),
              if (_previewError != null)
                const Text(
                  'Deletion could not be checked. Nothing was deleted.',
                ),
              if (_preview != null) ...[
                MemoryImpactDetails(preview: _preview!),
                if (widget.controller.supportsChange(MemoryChange.forget) &&
                    memory.metadata.visibility == 'user_private' &&
                    _preview!.guarantee == 'rollback_proof_barrier') ...[
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    value: _forgetConfirmed,
                    title: const Text(
                      'I understand this permanently deletes the memory and the related memories listed above.',
                    ),
                    onChanged: widget.controller.pendingChange != null
                        ? null
                        : (value) =>
                              setState(() => _forgetConfirmed = value ?? false),
                  ),
                  FilledButton(
                    onPressed:
                        !_forgetConfirmed ||
                            widget.controller.pendingChange != null
                        ? null
                        : () async {
                            final preview = _preview;
                            if (preview == null ||
                                widget.controller.pendingChange != null) {
                              return;
                            }
                            setState(() {
                              _preview = null;
                              _forgetConfirmed = false;
                            });
                            try {
                              await widget.controller.submitChange(
                                MemoryChange.forget,
                                {},
                                id: widget.memoryId,
                                previewDigest:
                                    preview.expectedReceiptManifestSha256,
                              );
                            } catch (error) {
                              if (mounted) {
                                setState(() => _previewError = error);
                              }
                            }
                            if (mounted &&
                                widget.controller.available &&
                                widget
                                        .controller
                                        .acceptedChange
                                        ?.submission
                                        .kind ==
                                    MemoryChange.forget &&
                                widget
                                        .controller
                                        .acceptedChange
                                        ?.submission
                                        .id ==
                                    widget.memoryId &&
                                widget
                                        .controller
                                        .acceptedChange
                                        ?.submission
                                        .previewDigest ==
                                    preview.expectedReceiptManifestSha256) {
                              setState(() => _memory = null);
                            }
                          },
                    child: const Text('Delete permanently'),
                  ),
                ] else
                  const Text(
                    'Deletion is unavailable for this app version, ownership or impact guarantee.',
                  ),
              ],
            ],
          ],
          if (memory == null && !widget.readOnly)
            MemoryChangeStatus(controller: widget.controller),
        ],
      );
    },
  );
}

class MemoryEvidenceDetails extends StatelessWidget {
  const MemoryEvidenceDetails({super.key, required this.memory});
  final MemoryRecord memory;
  @override
  Widget build(BuildContext context) {
    final metadata = memory.metadata;
    final entries = <String, String>{
      'Type / tier / claim':
          '${memory.type} / ${memory.tier} / ${memory.claimStatus}',
      'Scope': memory.scope,
      'Visibility': metadata.visibility,
      'Sensitivity': metadata.sensitivity,
      'Asserted by': memory.assertedBy,
      'Source': memory.source.isEmpty ? 'Not reported' : memory.source,
      'Why remembered': metadata.why.isEmpty ? 'Not reported' : metadata.why,
      'Confidence': '${(memory.confidence * 100).round()}%',
      'Importance': '${(memory.importance * 100).round()}%',
      'Current validity': metadata.validity,
      'Pinned': '${metadata.pinned ?? 'Not reported'}',
      'Archived': '${metadata.archived ?? 'Not reported'}',
      'Created': memory.createdAt?.toIso8601String() ?? 'Not reported',
      'Updated': memory.updatedAt?.toIso8601String() ?? 'Not reported',
      'Valid from': metadata.validFrom ?? 'Not reported',
      'Valid until': metadata.validTo ?? 'Not reported',
      'Retention expiry': metadata.retentionExpiresAt ?? 'Not reported',
      'Last used': metadata.lastUsedAt ?? 'Not reported',
      'Use count': '${metadata.useCount ?? 'Not reported'}',
      if (memory.supersedesId != null)
        'Supersedes exact identity': memory.supersedesId!,
      if (memory.contradictionOfId != null)
        'Contradicts exact identity': memory.contradictionOfId!,
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '${memoryFriendlyLabel(memory.tier)} · ${memoryFriendlyLabel(memory.claimStatus)} · Updated ${memoryFriendlyDate(memory.updatedAt)}',
        ),
        if (metadata.why.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(metadata.why),
          ),
        if (memory.tags.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final tag in memory.tags.take(12)) Chip(label: Text(tag)),
              ],
            ),
          ),
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: Text(
            'Source and technical details · ${memory.evidenceRefs.length} references',
          ),
          children: [
            SelectableText('Reference: ${memory.id}'),
            for (final entry in entries.entries)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: SelectableText('${entry.key}: ${entry.value}'),
              ),
            for (final reference in memory.evidenceRefs.take(50))
              SelectableText(reference),
            if (memory.evidenceRefs.length > 50)
              const Text('Showing the first 50 source references.'),
          ],
        ),
      ],
    );
  }
}

class MemoryImpactDetails extends StatelessWidget {
  const MemoryImpactDetails({super.key, required this.preview});
  final MemoryForgetPreview preview;
  @override
  Widget build(BuildContext context) {
    final descendants =
        preview.details['descendantMemories'] as List? ?? const [];
    final impact = preview.details['impact'] as Map? ?? const {};
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 16),
        Text(
          'Delete this memory?',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        Text(
          'This permanently deletes the selected memory and ${preview.descendantMemoryCount} memories created from it. It removes their map connections and recall history. This cannot be undone.',
        ),
        const SizedBox(height: 8),
        const Text(
          'Original files and messages are not deleted. A deletion receipt is retained.',
        ),
        for (final value in descendants.take(40))
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text('• ${(value as Map)['title']}'),
          ),
        if (descendants.length > 40)
          Text('Showing 40 of ${descendants.length} related memories.'),
        if (preview.guarantee == 'best_effort')
          const Text(
            'Older backups may still contain this memory. Permanent deletion is unavailable in this state.',
          ),
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: const Text('Deletion details'),
          children: [
            Text(
              '${preview.retrievalTraceCount} recall records · ${preview.graphNodeCount} map items · ${preview.graphEdgeCount} connections',
            ),
            Text(
              'Affected active tasks: ${impact['pendingAgentRunCount'] ?? 'unavailable'}; workflows: ${impact['pendingWorkflowRunCount'] ?? 'unavailable'}.',
            ),
            SelectableText('Reference: ${preview.memoryId}'),
            SelectableText(
              'Preview fingerprint: ${preview.expectedReceiptManifestSha256}',
            ),
          ],
        ),
      ],
    );
  }
}
