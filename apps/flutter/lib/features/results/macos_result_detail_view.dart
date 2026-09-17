import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../macos_detail_support.dart';
import 'results.dart';

/// A macOS document reader for one durable result and its grounding evidence.
class MacosResultDetailView extends StatefulWidget {
  const MacosResultDetailView({
    super.key,
    required this.keyValue,
    required this.repository,
  });

  final String keyValue;
  final ResultsRepository repository;

  @override
  State<MacosResultDetailView> createState() => _MacosResultDetailViewState();
}

class _MacosResultDetailViewState extends State<MacosResultDetailView> {
  ResultItem? _item;
  Object? _error;
  bool _loading = true;
  bool _canceling = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant MacosResultDetailView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.keyValue != widget.keyValue) {
      _item = null;
      _load();
    }
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final item = await widget.repository.detail(widget.keyValue);
      if (mounted) setState(() => _item = item);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) => CallbackShortcuts(
    bindings: {
      const SingleActivator(LogicalKeyboardKey.bracketLeft, meta: true): () =>
          macosNavigateBack(context, '/results'),
      const SingleActivator(LogicalKeyboardKey.keyR, meta: true): _load,
      const SingleActivator(LogicalKeyboardKey.keyC, meta: true, shift: true):
          _copyOutput,
    },
    child: Focus(autofocus: true, child: _page(context)),
  );

  Widget _page(BuildContext context) {
    final item = _item;
    return MacosPageScaffold(
      title: item?.title ?? 'Result detail',
      description:
          item?.meta ??
          'Inspect final output, execution state, and grounding evidence.',
      icon: Icons.description_outlined,
      actions: [
        IconButton(
          key: const Key('macos-result-detail-refresh'),
          tooltip: 'Refresh result (⌘R)',
          onPressed: _loading ? null : _load,
          icon: _loading
              ? const SizedBox.square(
                  dimension: 15,
                  child: CircularProgressIndicator(strokeWidth: 1.8),
                )
              : const Icon(Icons.refresh_rounded),
        ),
      ],
      primaryAction: item == null
          ? null
          : FilledButton.tonalIcon(
              key: const Key('macos-result-copy'),
              onPressed: _copyOutput,
              icon: const Icon(Icons.content_copy_rounded, size: 16),
              label: const Text('Copy output'),
            ),
      toolbar: Row(
        children: [
          const MacosDetailBackButton(
            fallbackLocation: '/results',
            label: 'Results',
          ),
          if (item != null) ...[
            const SizedBox(width: 12),
            MacosStatusBadge(
              label: macosHumanize(item.status),
              tone: macosToneForStatus(item.status),
            ),
            const SizedBox(width: 8),
            MacosStatusBadge(
              label: macosHumanize(item.kind.name),
              icon: _kindIcon(item.kind),
            ),
            const Spacer(),
            Text(
              'Copy output  ⇧⌘C',
              style: Theme.of(context).textTheme.labelSmall,
            ),
          ],
        ],
      ),
      inspector: item == null
          ? null
          : _ResultInspector(
              item: item,
              canceling: _canceling,
              onCancel: item.canCancel ? _confirmCancel : null,
            ),
      inspectorWidth: 370,
      inspectorMinWidth: 320,
      inspectorMaxWidth: 520,
      body: _body(item),
    );
  }

  Widget _body(ResultItem? item) {
    if (_loading && item == null) return const MacosLoadingList(rows: 8);
    if (_error != null && item == null) {
      return MacosEmptyState(
        icon: Icons.cloud_off_outlined,
        title: 'The result is unavailable',
        message: 'Asael could not load this result from the execution ledger.',
        action: FilledButton.tonalIcon(
          onPressed: _load,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('Try again'),
        ),
      );
    }
    if (item == null) {
      return const MacosEmptyState(
        icon: Icons.find_in_page_outlined,
        title: 'Result not found',
        message: 'This linked result is unavailable or no longer visible.',
      );
    }
    return Column(
      children: [
        if (_error != null)
          MacosDetailNotice(
            message:
                'Showing the last available result. Refresh failed: $_error',
            action: TextButton(onPressed: _load, child: const Text('Retry')),
          ),
        Expanded(child: _ResultDocument(item: item)),
      ],
    );
  }

  Future<void> _copyOutput() async {
    final item = _item;
    if (item == null) return;
    await Clipboard.setData(ClipboardData(text: item.body));
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Result output copied.')));
  }

  Future<void> _confirmCancel() async {
    final item = _item;
    if (item == null || !item.canCancel || _canceling) return;
    final accepted = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Cancel this agent run?'),
        content: const Text(
          'The run will stop at its next safe cancellation point. Completed tool actions are not undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Keep running'),
          ),
          FilledButton(
            key: const Key('macos-result-cancel-confirm'),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Cancel run'),
          ),
        ],
      ),
    );
    if (accepted != true) return;
    setState(() => _canceling = true);
    try {
      await widget.repository.cancel(item.key.substring(6));
      await _load();
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _canceling = false);
    }
  }
}

class _ResultDocument extends StatelessWidget {
  const _ResultDocument({required this.item});
  final ResultItem item;

  @override
  Widget build(BuildContext context) => SelectionArea(
    child: ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 920),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  macosHumanize(item.kind.name).toUpperCase(),
                  style: Theme.of(context).textTheme.labelSmall
                      ?.copyWith(letterSpacing: .9),
                ),
                const SizedBox(height: 7),
                Text(
                  item.title,
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
                const SizedBox(height: 5),
                Text(item.meta, style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: 22),
                MacosPane(
                  padding: const EdgeInsets.fromLTRB(24, 22, 24, 26),
                  child: SizedBox(
                    width: double.infinity,
                    child: SelectableText(
                      item.body,
                      style: Theme.of(context).textTheme.bodyLarge
                          ?.copyWith(height: 1.62),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                MacosPane(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        item.verified
                            ? Icons.verified_user_rounded
                            : Icons.policy_outlined,
                        size: 20,
                        color: item.verified
                            ? Theme.of(context).colorScheme.tertiary
                            : Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                      const SizedBox(width: 11),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Evidence verification',
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            const SizedBox(height: 4),
                            Text(
                              item.verified
                                  ? 'Grounding references were verified for this output.'
                                  : 'Grounding status: ${macosHumanize(item.groundingStatus)}.',
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    ),
  );
}

class _ResultInspector extends StatelessWidget {
  const _ResultInspector({
    required this.item,
    required this.canceling,
    required this.onCancel,
  });

  final ResultItem item;
  final bool canceling;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) => ListView(
    children: [
      MacosInspectorSection(
        title: 'Execution record',
        child: Column(
          children: [
            MacosKeyValue(label: 'Kind', value: macosHumanize(item.kind.name)),
            MacosKeyValue(label: 'Status', value: macosHumanize(item.status)),
            MacosKeyValue(
              label: 'Grounding',
              value: macosHumanize(item.groundingStatus),
            ),
            MacosKeyValue(
              label: 'Recorded',
              value: item.timestamp == null
                  ? 'Unknown'
                  : _formatTimestamp(context, item.timestamp!.toLocal()),
            ),
            MacosKeyValue(label: 'Ledger key', value: item.key),
          ],
        ),
      ),
      MacosInspectorSection(
        title: 'Evidence',
        description: '${item.evidence.length} references attached',
        child: item.evidence.isEmpty
            ? Text(
                'No evidence references were recorded for this result.',
                style: Theme.of(context).textTheme.bodySmall,
              )
            : Column(
                children: [
                  for (final reference in item.evidence)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(Icons.link_rounded, size: 16),
                          const SizedBox(width: 8),
                          Expanded(child: SelectableText(reference)),
                        ],
                      ),
                    ),
                ],
              ),
      ),
      if (onCancel != null)
        MacosInspectorSection(
          title: 'Run control',
          description: 'Cancel only if this active run should not continue.',
          child: SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              key: const Key('macos-result-cancel'),
              onPressed: canceling ? null : onCancel,
              icon: canceling
                  ? const SizedBox.square(
                      dimension: 14,
                      child: CircularProgressIndicator(strokeWidth: 1.7),
                    )
                  : const Icon(Icons.stop_circle_outlined, size: 17),
              label: Text(canceling ? 'Canceling…' : 'Cancel run'),
            ),
          ),
        ),
      const SizedBox(height: 20),
    ],
  );
}

IconData _kindIcon(ResultKind kind) => switch (kind) {
  ResultKind.agent => Icons.terminal_rounded,
  ResultKind.workflow => Icons.account_tree_outlined,
  ResultKind.approval => Icons.approval_outlined,
};

String _formatTimestamp(BuildContext context, DateTime value) {
  final localization = MaterialLocalizations.of(context);
  return '${localization.formatMediumDate(value)} · ${localization.formatTimeOfDay(TimeOfDay.fromDateTime(value))}';
}
