import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/theme/macos_app_theme.dart';
import 'results.dart';

/// A searchable macOS evidence ledger with a persistent output inspector.
class MacosResultsView extends StatefulWidget {
  const MacosResultsView({
    super.key,
    required this.controller,
    required this.onOpen,
  });

  final ResultsController controller;
  final ValueChanged<ResultItem> onOpen;

  @override
  State<MacosResultsView> createState() => _MacosResultsViewState();
}

class _MacosResultsViewState extends State<MacosResultsView> {
  late final _searchController = TextEditingController(
    text: widget.controller.query,
  );
  final _searchFocus = FocusNode(debugLabel: 'Search evidence ledger');
  String? _selectedKey;
  String? _cancelingKey;

  @override
  void dispose() {
    _searchController.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final snapshot = widget.controller.snapshot;
      final items = widget.controller.filtered;
      final selected = _selectedResult(items);
      final statuses =
          (snapshot?.items ?? const <ResultItem>[])
              .map((item) => item.status)
              .toSet()
              .toList()
            ..sort();

      return CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.keyR, meta: true):
              widget.controller.refresh,
          const SingleActivator(LogicalKeyboardKey.keyF, meta: true):
              _searchFocus.requestFocus,
          const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
              _moveSelection(items, 1),
          const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
              _moveSelection(items, -1),
          const SingleActivator(LogicalKeyboardKey.enter): () {
            if (selected != null) widget.onOpen(selected);
          },
        },
        child: Focus(
          autofocus: true,
          child: MacosPageScaffold(
            title: 'Results',
            description: 'A durable ledger of agent outputs, workflow reports, approvals, and evidence.',
            icon: Icons.fact_check_outlined,
            actions: [
              if (widget.controller.loading)
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 8),
                  child: SizedBox.square(
                    dimension: 15,
                    child: CircularProgressIndicator(strokeWidth: 1.8),
                  ),
                ),
              IconButton(
                key: const Key('macos-results-refresh'),
                tooltip: 'Refresh results (⌘R)',
                onPressed: widget.controller.loading
                    ? null
                    : widget.controller.refresh,
                icon: const Icon(Icons.refresh_rounded),
              ),
            ],
            toolbar: _ResultsToolbar(
              controller: widget.controller,
              searchController: _searchController,
              searchFocus: _searchFocus,
              statuses: statuses,
            ),
            inspector: _ResultInspector(
              item: selected,
              canceling: selected?.key == _cancelingKey,
              onOpen: selected == null ? null : () => widget.onOpen(selected),
              onCancel: selected == null || !selected.canCancel
                  ? null
                  : () => _cancel(selected),
            ),
            inspectorWidth: 430,
            inspectorMinWidth: 350,
            inspectorMaxWidth: 600,
            body: _ResultsBody(
              controller: widget.controller,
              items: items,
              selectedKey: selected?.key,
              onSelect: (item) => setState(() => _selectedKey = item.key),
            ),
          ),
        ),
      );
    },
  );

  ResultItem? _selectedResult(List<ResultItem> items) {
    if (items.isEmpty) return null;
    for (final item in items) {
      if (item.key == _selectedKey) return item;
    }
    return items.first;
  }

  void _moveSelection(List<ResultItem> items, int delta) {
    if (items.isEmpty) return;
    final current = items.indexWhere((item) => item.key == _selectedKey);
    final next = current < 0 ? 0 : (current + delta).clamp(0, items.length - 1);
    setState(() => _selectedKey = items[next].key);
  }

  Future<void> _cancel(ResultItem item) async {
    setState(() => _cancelingKey = item.key);
    try {
      await widget.controller.repository.cancel(item.key.substring(6));
      await widget.controller.refresh();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Unable to cancel this run: $error')),
      );
    } finally {
      if (mounted) setState(() => _cancelingKey = null);
    }
  }
}

class _ResultsToolbar extends StatelessWidget {
  const _ResultsToolbar({
    required this.controller,
    required this.searchController,
    required this.searchFocus,
    required this.statuses,
  });

  static const _allStatuses = '__all__';
  static const _allKinds = '__all_kinds__';

  final ResultsController controller;
  final TextEditingController searchController;
  final FocusNode searchFocus;
  final List<String> statuses;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final compact = constraints.maxWidth < 1040;
      final search = TextField(
        controller: searchController,
        focusNode: searchFocus,
        onChanged: (value) => controller.filter(search: value),
        decoration: const InputDecoration(
          prefixIcon: Icon(Icons.search_rounded, size: 17),
          hintText: 'Search outputs and reports  ⌘F',
        ),
      );
      final statusFilter = DropdownButtonFormField<String>(
        key: ValueKey(controller.status ?? _allStatuses),
        initialValue: controller.status ?? _allStatuses,
        isDense: true,
        isExpanded: true,
        decoration: InputDecoration(
          prefixIcon: compact
              ? null
              : const Icon(Icons.filter_list_rounded, size: 16),
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 8,
            vertical: 6,
          ),
        ),
        items: [
          const DropdownMenuItem(
            value: _allStatuses,
            child: Text('Every status'),
          ),
          for (final status in statuses)
            DropdownMenuItem(value: status, child: Text(_resultLabel(status))),
        ],
        onChanged: (value) =>
            controller.filter(resultStatus: value == _allStatuses ? '' : value),
      );
      return Row(
        children: [
          if (compact)
            Expanded(child: search)
          else
            SizedBox(width: 280, child: search),
          const SizedBox(width: 10),
          if (compact)
            SizedBox(
              width: 150,
              child: DropdownButtonFormField<String>(
                key: ValueKey(controller.kind?.name ?? _allKinds),
                initialValue: controller.kind?.name ?? _allKinds,
                isDense: true,
                isExpanded: true,
                decoration: const InputDecoration(
                  contentPadding: EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 6,
                  ),
                ),
                items: [
                  const DropdownMenuItem(
                    value: _allKinds,
                    child: Text('Every kind'),
                  ),
                  for (final kind in ResultKind.values)
                    DropdownMenuItem(
                      value: kind.name,
                      child: Text(_resultLabel(kind.name)),
                    ),
                ],
                onChanged: (value) {
                  if (value == null) return;
                  if (value == _allKinds) {
                    controller.filter(clearKind: true);
                  } else {
                    controller.filter(
                      resultKind: ResultKind.values.byName(value),
                    );
                  }
                },
              ),
            )
          else
            SegmentedButton<ResultKind?>(
              showSelectedIcon: false,
              segments: const [
                ButtonSegment(value: null, label: Text('All')),
                ButtonSegment(
                  value: ResultKind.agent,
                  icon: Icon(Icons.terminal_rounded, size: 15),
                  label: Text('Agents'),
                ),
                ButtonSegment(
                  value: ResultKind.workflow,
                  icon: Icon(Icons.account_tree_outlined, size: 15),
                  label: Text('Workflows'),
                ),
                ButtonSegment(
                  value: ResultKind.approval,
                  icon: Icon(Icons.approval_outlined, size: 15),
                  label: Text('Approvals'),
                ),
              ],
              selected: {controller.kind},
              onSelectionChanged: (values) {
                final value = values.single;
                if (value == null) {
                  controller.filter(clearKind: true);
                } else {
                  controller.filter(resultKind: value);
                }
              },
            ),
          const SizedBox(width: 10),
          if (!compact) const Spacer(),
          SizedBox(width: compact ? 165 : 210, child: statusFilter),
        ],
      );
    },
  );
}

class _ResultsBody extends StatelessWidget {
  const _ResultsBody({
    required this.controller,
    required this.items,
    required this.selectedKey,
    required this.onSelect,
  });

  final ResultsController controller;
  final List<ResultItem> items;
  final String? selectedKey;
  final ValueChanged<ResultItem> onSelect;

  @override
  Widget build(BuildContext context) {
    final snapshot = controller.snapshot;
    if (controller.loading && snapshot == null) {
      return const MacosLoadingList(rows: 10);
    }
    if (controller.error != null && snapshot == null) {
      return MacosEmptyState(
        icon: Icons.cloud_off_outlined,
        title: 'The evidence ledger is unavailable',
        message: 'Reconnect to load execution outputs and their evidence.',
        action: FilledButton.tonalIcon(
          onPressed: controller.refresh,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('Reconnect'),
        ),
      );
    }

    return Column(
      children: [
        if (controller.error != null && snapshot != null)
          _ResultsNotice(
            message: 'Offline · showing the last available evidence ledger.',
            onRetry: controller.refresh,
          ),
        if (snapshot?.sourceErrors.isNotEmpty ?? false)
          _ResultsNotice(
            message:
                'Some sources could not be verified: ${snapshot!.sourceErrors.join(', ')}',
            onRetry: controller.refresh,
          ),
        _LedgerSummary(snapshot: snapshot),
        const _ResultColumnHeader(),
        Expanded(
          child: items.isEmpty
              ? const MacosEmptyState(
                  icon: Icons.manage_search_rounded,
                  title: 'No results match these filters',
                  message:
                      'Clear the search or choose a different kind or status.',
                )
              : _ManagedScrollbar(
                  builder: (scrollController) => ListView.builder(
                    controller: scrollController,
                    padding: const EdgeInsets.fromLTRB(8, 5, 8, 18),
                    itemCount: items.length,
                    itemBuilder: (context, index) {
                      final item = items[index];
                      return _ResultRow(
                        key: Key('macos-result-${item.key}'),
                        item: item,
                        selected: item.key == selectedKey,
                        onTap: () => onSelect(item),
                      );
                    },
                  ),
                ),
        ),
        if (snapshot?.evaluations.isNotEmpty ?? false)
          _EvaluationStrip(values: snapshot!.evaluations),
      ],
    );
  }
}

class _ResultsNotice extends StatelessWidget {
  const _ResultsNotice({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
    color: Theme.of(context).colorScheme.errorContainer,
    child: Row(
      children: [
        const Icon(Icons.cloud_off_outlined, size: 16),
        const SizedBox(width: 8),
        Expanded(child: Text(message, maxLines: 2)),
        TextButton(onPressed: onRetry, child: const Text('Retry')),
      ],
    ),
  );
}

class _LedgerSummary extends StatelessWidget {
  const _LedgerSummary({required this.snapshot});

  final ResultsSnapshot? snapshot;

  @override
  Widget build(BuildContext context) {
    final values = snapshot?.items ?? const <ResultItem>[];
    final successful = values
        .where((item) => item.tone == ResultTone.success)
        .length;
    final verified = values.where((item) => item.verified).length;
    final active = values.where((item) => item.canCancel).length;
    final metrics = [
      _LedgerMetric(value: '${values.length}', label: 'records'),
      _LedgerMetric(value: '$successful', label: 'succeeded'),
      _LedgerMetric(value: '$verified', label: 'verified'),
      _LedgerMetric(value: '$active', label: 'active'),
    ];
    return LayoutBuilder(
      builder: (context, constraints) => Container(
        constraints: const BoxConstraints(minHeight: 62),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 9),
        child: Row(
          children: [
            if (constraints.maxWidth < 900)
              for (final metric in metrics) Expanded(child: metric)
            else ...[
              metrics[0],
              const SizedBox(width: 26),
              metrics[1],
              const SizedBox(width: 26),
              metrics[2],
              const SizedBox(width: 26),
              metrics[3],
              const Spacer(),
              Icon(
                Icons.lock_outline_rounded,
                size: 15,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              const SizedBox(width: 6),
              Text(
                'Durable execution evidence',
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _LedgerMetric extends StatelessWidget {
  const _LedgerMetric({required this.value, required this.label});

  final String value;
  final String label;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Text(value, style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(width: 6),
      Text(label, style: Theme.of(context).textTheme.labelSmall),
    ],
  );
}

class _ResultColumnHeader extends StatelessWidget {
  const _ResultColumnHeader();

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return LayoutBuilder(
      builder: (context, constraints) => Container(
        height: 31,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        decoration: BoxDecoration(
          color: mac.toolbar,
          border: Border.symmetric(horizontal: BorderSide(color: mac.divider)),
        ),
        child: Row(
          children: [
            SizedBox(
              width: 104,
              child: Text(
                'RECORDED',
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ),
            SizedBox(
              width: 94,
              child: Text(
                'KIND',
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ),
            Expanded(
              child: Text(
                'OUTPUT',
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ),
            if (constraints.maxWidth >= 680)
              SizedBox(
                width: 110,
                child: Text(
                  'EVIDENCE',
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              ),
            SizedBox(
              width: 112,
              child: Text(
                'STATUS',
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ResultRow extends StatelessWidget {
  const _ResultRow({
    super.key,
    required this.item,
    required this.selected,
    required this.onTap,
  });

  final ResultItem item;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    final recorded = item.timestamp?.toLocal();
    final recordedLabel = recorded == null
        ? 'Not recorded'
        : '${MaterialLocalizations.of(context).formatMediumDate(recorded)}\n${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(recorded))}';
    final accent = _resultToneColor(context, item.tone);
    return LayoutBuilder(
      builder: (context, constraints) => Material(
        color: selected ? mac.selection : Colors.transparent,
        borderRadius: BorderRadius.circular(7),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(7),
          child: Container(
            constraints: const BoxConstraints(minHeight: 60),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
            decoration: BoxDecoration(
              border: Border(left: BorderSide(color: accent, width: 3)),
            ),
            child: Row(
              children: [
                SizedBox(
                  width: 104,
                  child: Text(
                    recordedLabel,
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ),
                SizedBox(
                  width: 94,
                  child: Row(
                    children: [
                      Icon(_resultKindIcon(item.kind), size: 15),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          _resultLabel(item.kind.name),
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.labelSmall,
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(
                        item.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodyMedium
                            ?.copyWith(fontWeight: FontWeight.w600),
                      ),
                      Text(
                        item.meta,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                if (constraints.maxWidth >= 680)
                  SizedBox(
                    width: 110,
                    child: Row(
                      children: [
                        Icon(
                          item.verified
                              ? Icons.verified_rounded
                              : Icons.shield_outlined,
                          size: 15,
                          color: item.verified
                              ? mac.positive
                              : Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            item.verified
                                ? 'Verified'
                                : '${item.evidence.length} refs',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.labelSmall,
                          ),
                        ),
                      ],
                    ),
                  ),
                SizedBox(
                  width: 112,
                  child: Row(
                    children: [
                      Container(
                        width: 7,
                        height: 7,
                        decoration: BoxDecoration(
                          color: accent,
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          _resultLabel(item.status),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.labelSmall
                              ?.copyWith(color: accent),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ResultInspector extends StatelessWidget {
  const _ResultInspector({
    required this.item,
    required this.canceling,
    required this.onOpen,
    required this.onCancel,
  });

  final ResultItem? item;
  final bool canceling;
  final VoidCallback? onOpen;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final item = this.item;
    if (item == null) {
      return const MacosEmptyState(
        icon: Icons.fact_check_outlined,
        title: 'Select a result',
        message: 'Its output, grounding state, and evidence appear here.',
      );
    }
    final accent = _resultToneColor(context, item.tone);
    return Column(
      children: [
        Expanded(
          child: _ManagedScrollbar(
            builder: (scrollController) => ListView(
              controller: scrollController,
              padding: const EdgeInsets.fromLTRB(20, 22, 20, 24),
              children: [
                Row(
                  children: [
                    Icon(_resultKindIcon(item.kind), size: 17, color: accent),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(
                        _resultLabel(item.kind.name).toUpperCase(),
                        style: Theme.of(context).textTheme.labelSmall
                            ?.copyWith(color: accent),
                      ),
                    ),
                    _ResultStatus(item: item, color: accent),
                  ],
                ),
                const SizedBox(height: 11),
                Text(
                  item.title,
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: 5),
                Text(item.meta, style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: 22),
                const _InspectorTitle(
                  icon: Icons.subject_rounded,
                  label: 'Output',
                ),
                const SizedBox(height: 8),
                SelectableText(
                  item.body,
                  style: Theme.of(context).textTheme.bodyMedium
                      ?.copyWith(height: 1.55),
                ),
                const SizedBox(height: 24),
                _InspectorTitle(
                  icon: item.verified
                      ? Icons.verified_user_rounded
                      : Icons.policy_outlined,
                  label: 'Evidence',
                ),
                const SizedBox(height: 8),
                _GroundingState(item: item),
                const SizedBox(height: 12),
                if (item.evidence.isEmpty)
                  Text(
                    'No evidence references were recorded for this result.',
                    style: Theme.of(context).textTheme.bodySmall,
                  )
                else
                  for (var index = 0; index < item.evidence.length; index++)
                    _EvidenceReference(
                      index: index + 1,
                      value: item.evidence[index],
                    ),
              ],
            ),
          ),
        ),
        Container(
          padding: const EdgeInsets.fromLTRB(16, 11, 16, 14),
          decoration: BoxDecoration(
            border: Border(
              top: BorderSide(color: MacosThemeColors.of(context).divider),
            ),
          ),
          child: Column(
            children: [
              if (onOpen != null && item.kind != ResultKind.approval)
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    key: const Key('macos-result-open'),
                    onPressed: onOpen,
                    icon: const Icon(Icons.open_in_new_rounded),
                    label: const Text('Open full record'),
                  ),
                ),
              if (onCancel != null) ...[
                const SizedBox(height: 5),
                SizedBox(
                  width: double.infinity,
                  child: TextButton.icon(
                    key: const Key('macos-result-cancel'),
                    onPressed: canceling ? null : onCancel,
                    icon: canceling
                        ? const SizedBox.square(
                            dimension: 14,
                            child: CircularProgressIndicator(strokeWidth: 1.8),
                          )
                        : const Icon(Icons.stop_circle_outlined),
                    label: Text(canceling ? 'Canceling…' : 'Cancel run'),
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _ResultStatus extends StatelessWidget {
  const _ResultStatus({required this.item, required this.color});

  final ResultItem item;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    decoration: BoxDecoration(
      color: color.withValues(alpha: .12),
      borderRadius: BorderRadius.circular(5),
    ),
    child: Text(
      _resultLabel(item.status),
      style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color),
    ),
  );
}

class _InspectorTitle extends StatelessWidget {
  const _InspectorTitle({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Icon(icon, size: 17),
      const SizedBox(width: 7),
      Text(label, style: Theme.of(context).textTheme.titleSmall),
    ],
  );
}

class _GroundingState extends StatelessWidget {
  const _GroundingState({required this.item});

  final ResultItem item;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: item.verified ? mac.positive.withValues(alpha: .09) : mac.hover,
        borderRadius: BorderRadius.circular(7),
        border: Border.all(
          color: item.verified
              ? mac.positive.withValues(alpha: .3)
              : mac.divider,
        ),
      ),
      child: Row(
        children: [
          Icon(
            item.verified ? Icons.verified_rounded : Icons.info_outline_rounded,
            size: 16,
            color: item.verified
                ? mac.positive
                : Theme.of(context).colorScheme.onSurfaceVariant,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              item.verified
                  ? 'Evidence verification passed.'
                  : 'Grounding: ${_resultLabel(item.groundingStatus)}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }
}

class _EvidenceReference extends StatelessWidget {
  const _EvidenceReference({required this.index, required this.value});

  final int index;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 9),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 24,
          child: Text('$index.', style: Theme.of(context).textTheme.labelSmall),
        ),
        Expanded(child: SelectableText(value)),
      ],
    ),
  );
}

class _EvaluationStrip extends StatelessWidget {
  const _EvaluationStrip({required this.values});

  final List<EvaluationResult> values;

  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context);
    return Container(
      height: 46,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        color: mac.toolbar,
        border: Border(top: BorderSide(color: mac.divider)),
      ),
      child: Row(
        children: [
          const Icon(Icons.fact_check_outlined, size: 16),
          const SizedBox(width: 7),
          Text(
            'Evaluation evidence',
            style: Theme.of(context).textTheme.labelMedium,
          ),
          const SizedBox(width: 16),
          Expanded(
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: values.length,
              separatorBuilder: (_, _) => const SizedBox(width: 20),
              itemBuilder: (context, index) {
                final value = values[index];
                return Center(
                  child: Text(
                    '${value.suite}: ${value.passed}/${value.total} · ${_resultLabel(value.status)}',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

IconData _resultKindIcon(ResultKind kind) => switch (kind) {
  ResultKind.agent => Icons.terminal_rounded,
  ResultKind.workflow => Icons.account_tree_outlined,
  ResultKind.approval => Icons.approval_outlined,
};

Color _resultToneColor(BuildContext context, ResultTone tone) {
  final mac = MacosThemeColors.of(context);
  return switch (tone) {
    ResultTone.success => mac.positive,
    ResultTone.warning => mac.warning,
    ResultTone.danger => Theme.of(context).colorScheme.error,
    ResultTone.neutral => Theme.of(context).colorScheme.onSurfaceVariant,
  };
}

String _resultLabel(String value) => value
    .replaceAll('_', ' ')
    .split(' ')
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');

class _ManagedScrollbar extends StatefulWidget {
  const _ManagedScrollbar({required this.builder});

  final Widget Function(ScrollController controller) builder;

  @override
  State<_ManagedScrollbar> createState() => _ManagedScrollbarState();
}

class _ManagedScrollbarState extends State<_ManagedScrollbar> {
  final _controller = ScrollController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      Scrollbar(controller: _controller, child: widget.builder(_controller));
}
