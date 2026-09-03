import 'package:flutter/material.dart';

import 'results.dart';

class ResultsView extends StatelessWidget {
  const ResultsView({
    super.key,
    required this.controller,
    required this.onOpen,
  });
  final ResultsController controller;
  final ValueChanged<ResultItem> onOpen;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (_, _) {
      final snapshot = controller.snapshot, items = controller.filtered;
      return Scaffold(
        appBar: AppBar(
          title: const Text('Results'),
          actions: [
            IconButton(
              tooltip: 'Refresh',
              onPressed: controller.refresh,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
        ),
        body: RefreshIndicator(
          onRefresh: controller.refresh,
          child: controller.loading && snapshot == null
              ? const _ResultsSkeleton()
              : controller.error != null && snapshot == null
              ? ListView(
                  children: [
                    const SizedBox(height: 200),
                    Center(
                      child: FilledButton.tonalIcon(
                        onPressed: controller.refresh,
                        icon: const Icon(Icons.cloud_off_rounded),
                        label: const Text('Reconnect results'),
                      ),
                    ),
                  ],
                )
              : CustomScrollView(
                  slivers: [
                    SliverToBoxAdapter(child: _Header(snapshot: snapshot)),
                    SliverToBoxAdapter(child: _Filters(controller: controller)),
                    if (snapshot?.sourceErrors.isNotEmpty ?? false)
                      SliverToBoxAdapter(
                        child: Padding(
                          padding: const EdgeInsets.all(12),
                          child: Card(
                            color: Theme.of(context).colorScheme.errorContainer,
                            child: Padding(
                              padding: const EdgeInsets.all(12),
                              child: Text(
                                'Some sources could not be verified: ${snapshot!.sourceErrors.join(', ')}',
                              ),
                            ),
                          ),
                        ),
                      ),
                    if (items.isEmpty)
                      const SliverFillRemaining(
                        child: Center(
                          child: Text('No results match these filters.'),
                        ),
                      )
                    else
                      SliverPadding(
                        padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
                        sliver: SliverList.builder(
                          itemCount: items.length,
                          itemBuilder: (_, i) => _ResultCard(
                            item: items[i],
                            onTap: () => onOpen(items[i]),
                          ),
                        ),
                      ),
                    if (snapshot?.evaluations.isNotEmpty ?? false)
                      SliverToBoxAdapter(
                        child: _Evaluations(values: snapshot!.evaluations),
                      ),
                  ],
                ),
        ),
      );
    },
  );
}

class ResultDetailView extends StatefulWidget {
  const ResultDetailView({
    super.key,
    required this.keyValue,
    required this.repository,
  });
  final String keyValue;
  final ResultsRepository repository;
  @override
  State<ResultDetailView> createState() => _ResultDetailViewState();
}

class _ResultDetailViewState extends State<ResultDetailView> {
  ResultItem? item;
  Object? error;
  bool loading = true, canceling = false;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      item = await widget.repository.detail(widget.keyValue);
    } catch (e) {
      error = e;
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = item;
    return Scaffold(
      appBar: AppBar(title: const Text('Result detail')),
      body: loading
          ? const Center(child: CircularProgressIndicator())
          : error != null
          ? Center(
              child: FilledButton.tonal(
                onPressed: _load,
                child: Text(error.toString()),
              ),
            )
          : r == null
          ? const Center(child: Text('This linked result is unavailable.'))
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Wrap(
                  alignment: WrapAlignment.spaceBetween,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          r.title,
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                        Text(r.meta),
                      ],
                    ),
                    Chip(
                      avatar: Icon(_toneIcon(r.tone), size: 16),
                      label: Text(r.status),
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(18),
                    child: SelectableText(
                      r.body,
                      style: const TextStyle(height: 1.55),
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Icon(
                              r.verified
                                  ? Icons.verified_user_rounded
                                  : Icons.policy_outlined,
                            ),
                            const SizedBox(width: 8),
                            Text(
                              'Evidence verification',
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        Text('Grounding: ${r.groundingStatus}'),
                        const SizedBox(height: 8),
                        if (r.evidence.isEmpty)
                          const Text(
                            'No evidence references were recorded for this result.',
                          )
                        else
                          ...r.evidence.map(
                            (e) => ListTile(
                              dense: true,
                              contentPadding: EdgeInsets.zero,
                              leading: const Icon(Icons.link_rounded),
                              title: SelectableText(e),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
                if (r.canCancel)
                  Padding(
                    padding: const EdgeInsets.only(top: 16),
                    child: OutlinedButton.icon(
                      onPressed: canceling
                          ? null
                          : () async {
                              setState(() => canceling = true);
                              try {
                                await widget.repository.cancel(
                                  r.key.substring(6),
                                );
                                await _load();
                              } catch (e) {
                                if (mounted) setState(() => error = e);
                              } finally {
                                if (mounted) setState(() => canceling = false);
                              }
                            },
                      icon: const Icon(Icons.stop_circle_outlined),
                      label: Text(canceling ? 'Canceling…' : 'Cancel run'),
                    ),
                  ),
              ],
            ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.snapshot});
  final ResultsSnapshot? snapshot;
  @override
  Widget build(BuildContext context) {
    final values = snapshot?.items ?? const <ResultItem>[];
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Execution ledger',
            style: Theme.of(context).textTheme.labelLarge
                ?.copyWith(color: Theme.of(context).colorScheme.primary),
          ),
          Text('Results', style: Theme.of(context).textTheme.displaySmall),
          const Text(
            'Final outputs, approvals, and the evidence that produced them.',
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(child: _Metric('${values.length}', 'Total')),
              Expanded(
                child: _Metric(
                  '${values.where((e) => e.tone == ResultTone.success).length}',
                  'Succeeded',
                ),
              ),
              Expanded(
                child: _Metric(
                  '${values.where((e) => e.verified).length}',
                  'Verified',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Filters extends StatelessWidget {
  const _Filters({required this.controller});
  final ResultsController controller;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
    child: Column(
      children: [
        TextField(
          onChanged: (v) => controller.filter(search: v),
          decoration: const InputDecoration(
            prefixIcon: Icon(Icons.search_rounded),
            hintText: 'Search outputs and reports',
          ),
        ),
        const SizedBox(height: 8),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              FilterChip(
                label: const Text('All'),
                selected: controller.kind == null,
                onSelected: (_) => controller.filter(clearKind: true),
              ),
              const SizedBox(width: 6),
              ...ResultKind.values.map(
                (k) => Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: FilterChip(
                    label: Text(k.name),
                    selected: controller.kind == k,
                    onSelected: (_) => controller.filter(resultKind: k),
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.item, required this.onTap});
  final ResultItem item;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Card(
    child: InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CircleAvatar(
              child: Icon(
                item.kind == ResultKind.agent
                    ? Icons.terminal_rounded
                    : item.kind == ResultKind.workflow
                    ? Icons.account_tree_rounded
                    : Icons.approval_rounded,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          item.title,
                          style: const TextStyle(fontWeight: FontWeight.w700),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      Chip(
                        avatar: Icon(_toneIcon(item.tone), size: 14),
                        label: Text(item.status),
                      ),
                    ],
                  ),
                  Text(
                    item.meta,
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                  const SizedBox(height: 8),
                  Text(item.body, maxLines: 3, overflow: TextOverflow.ellipsis),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Icon(
                        item.verified
                            ? Icons.verified_rounded
                            : Icons.shield_outlined,
                        size: 16,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        item.verified
                            ? 'Evidence verified'
                            : item.groundingStatus,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

class _ResultsSkeleton extends StatelessWidget {
  const _ResultsSkeleton();
  @override
  Widget build(BuildContext context) {
    final tone = Theme.of(context).colorScheme.surfaceContainerHighest;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Container(
          height: 92,
          decoration: BoxDecoration(
            color: tone,
            borderRadius: BorderRadius.circular(14),
          ),
        ),
        const SizedBox(height: 14),
        Container(
          height: 48,
          decoration: BoxDecoration(
            color: tone.withValues(alpha: .72),
            borderRadius: BorderRadius.circular(14),
          ),
        ),
        const SizedBox(height: 18),
        for (var i = 0; i < 5; i++)
          Container(
            height: 116,
            margin: const EdgeInsets.only(bottom: 12),
            decoration: BoxDecoration(
              color: tone.withValues(alpha: .58),
              borderRadius: BorderRadius.circular(14),
            ),
          ),
      ],
    );
  }
}

class _Evaluations extends StatelessWidget {
  const _Evaluations({required this.values});
  final List<EvaluationResult> values;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Evaluation evidence',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        ...values.map(
          (e) => ListTile(
            leading: const Icon(Icons.fact_check_outlined),
            title: Text(e.suite),
            subtitle: Text('${e.passed} of ${e.total} checks passed'),
            trailing: Chip(label: Text(e.status)),
          ),
        ),
      ],
    ),
  );
}

class _Metric extends StatelessWidget {
  const _Metric(this.value, this.label);
  final String value, label;
  @override
  Widget build(BuildContext context) => Column(
    children: [
      Text(value, style: Theme.of(context).textTheme.headlineSmall),
      Text(label),
    ],
  );
}

IconData _toneIcon(ResultTone t) => switch (t) {
  ResultTone.success => Icons.check_circle_rounded,
  ResultTone.warning => Icons.pending_rounded,
  ResultTone.danger => Icons.error_rounded,
  ResultTone.neutral => Icons.circle_outlined,
};
