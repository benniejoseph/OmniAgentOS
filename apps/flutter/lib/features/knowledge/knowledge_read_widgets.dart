import 'package:flutter/material.dart';

import '../../generated/native_contract.g.dart';
import 'knowledge.dart';

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
                : 'Live durable catalogue · 40 per read · at most 200 retained per list. Working memory is excluded. Totals describe the observed catalogue, not every stored record.',
          ),
          if (state?.overview['generatedAt'] != null)
            Text('Observed ${state!.overview['generatedAt']}'),
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
          Text(
            '${count ?? 0} loaded · observed total ${total ?? 'unavailable'}',
          ),
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
            decoration: const InputDecoration(labelText: 'Memory tier'),
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
                DropdownMenuItem(value: value, child: Text(value)),
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
            decoration: const InputDecoration(labelText: 'Claim state'),
            items: [
              for (final value in [
                'all',
                'active',
                'candidate',
                'superseded',
                'contradicted',
                'archived',
              ])
                DropdownMenuItem(value: value, child: Text(value)),
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
  });
  final KnowledgeController controller;
  final String memoryId;
  final VoidCallback? onClose;
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
        _error = null;
        _previewError = null;
      });
    }
    try {
      final memory = await controller.inspect(widget.memoryId);
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
                child: const Text('Refresh exact memory'),
              ),
            ],
          ),
          const Text('Exact memory identity'),
          SelectableText(widget.memoryId),
          if (_loading)
            const Padding(
              padding: EdgeInsets.all(20),
              child: LinearProgressIndicator(),
            ),
          if (_error != null)
            const Text(
              'This memory is unavailable or no longer accessible. No index content is substituted. Retry to verify its current state.',
            ),
          if (memory != null) ...[
            const SizedBox(height: 16),
            Text(memory.title, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 16),
            SelectableText(memory.content),
            const SizedBox(height: 16),
            MemoryEvidenceDetails(memory: memory),
            const SizedBox(height: 16),
            Text(
              'Pin, archive, restore, correct and forget require a separately published native mutation contract. Current contract: ${NativeContract.currentVersion}.',
            ),
            if (widget.controller.canManage)
              OutlinedButton.icon(
                onPressed: _previewLoading ? null : _readImpact,
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size(48, 48),
                ),
                icon: const Icon(Icons.policy_outlined),
                label: Text(
                  _previewLoading
                      ? 'Reading impact…'
                      : 'Review forgetting impact',
                ),
              ),
            if (_previewError != null)
              const Text(
                'The current impact could not be verified. Nothing was forgotten.',
              ),
            if (_preview != null) MemoryImpactDetails(preview: _preview!),
          ],
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
        for (final entry in entries.entries)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: SelectableText('${entry.key}\n${entry.value}'),
          ),
        if (memory.tags.isNotEmpty)
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final tag in memory.tags.take(50)) Chip(label: Text(tag)),
            ],
          ),
        Text('Evidence references · ${memory.evidenceRefs.length} returned'),
        if (memory.evidenceRefs.isEmpty)
          const Text('No evidence references were returned.'),
        for (final reference in memory.evidenceRefs.take(50))
          SelectableText(reference),
        if (memory.evidenceRefs.length > 50)
          const Text('Only the first 50 returned references are displayed.'),
        const SizedBox(height: 10),
        const Text(
          'These are recorded references and direct correction links. Full history and evidence contents are not included in this read.',
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
        const Text('Impact preview only. No deletion has been submitted.'),
        SelectableText(
          'Memory: ${preview.memoryId}\nObserved: ${preview.generatedAt}\nGuarantee: ${preview.guarantee}',
        ),
        Text(
          '${preview.descendantMemoryCount} derived memories · ${preview.retrievalTraceCount} retrieval traces · '
          '${preview.graphNodeCount} relationship points · ${preview.graphEdgeCount} links',
        ),
        Text(
          'Pending Agent runs: ${impact['pendingAgentRunCount'] ?? 'unavailable'}; pending workflow runs: ${impact['pendingWorkflowRunCount'] ?? 'unavailable'}.',
        ),
        const Text('Expected manifest fingerprint'),
        SelectableText(preview.expectedReceiptManifestSha256),
        for (final value in descendants.take(40))
          SelectableText('${(value as Map)['title']}\n${value['id']}'),
        if (descendants.length > 40)
          Text(
            'Showing 40 of ${descendants.length} enumerated derived memories.',
          ),
        if (preview.guarantee == 'best_effort')
          const Text('Best effort is not a verified rollback barrier.'),
      ],
    );
  }
}

class KnowledgeReviews extends StatelessWidget {
  const KnowledgeReviews({
    super.key,
    required this.overview,
    this.stale = false,
  });
  final Json overview;
  final bool stale;
  @override
  Widget build(BuildContext context) {
    final summary = overview['summary'] as Map? ?? const {};
    final steward = overview['steward'] as Map? ?? const {};
    final recommendations = steward['recommendations'] is List
        ? steward['recommendations'] as List
        : const [];
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text('Memory reviews', style: Theme.of(context).textTheme.titleLarge),
        if (stale)
          const Text('Refresh failed. This advisory view may be stale.'),
        Text(
          '${summary['pendingReviews'] ?? 'Unavailable'} pending in the observed catalogue',
        ),
        const SizedBox(height: 12),
        const Text(
          'The memory steward proposes changes. This view does not execute maintenance or change historical truth.',
        ),
        const SizedBox(height: 12),
        Text(
          'Review decisions, promotions, source mapping, consent and maintenance are not published in native contract ${NativeContract.currentVersion}. Use the authenticated web Memory workspace for supported review workflows.',
        ),
        const SizedBox(height: 16),
        if (recommendations.isEmpty)
          const Text(
            'No advisory recommendations were returned. This does not establish that the review queue is empty.',
          ),
        for (final item in recommendations.whereType<Map>().take(20))
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${item['title'] ?? 'Advisory recommendation'}',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  Text('${item['detail'] ?? ''}'),
                  Text(
                    'Affected count: ${item['affectedCount'] ?? 'not reported'}',
                  ),
                  SelectableText('Reference: ${item['id'] ?? 'not reported'}'),
                ],
              ),
            ),
          ),
        if (recommendations.length > 20)
          const Text('Showing the first 20 advisory recommendations.'),
      ],
    );
  }
}
