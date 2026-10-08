import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import 'created_files_section.dart';
import 'result_contracts.dart';
import 'result_detail_controller.dart';
import 'results.dart';
import '../talk/talk_research.dart';
import '../talk/talk_rich_message.dart';

class ResultsWorkspace extends StatefulWidget {
  const ResultsWorkspace({
    super.key,
    required this.controller,
    required this.onOpen,
    this.desktop = false,
  });
  final ResultsController controller;
  final ValueChanged<ResultItem> onOpen;
  final bool desktop;
  @override
  State<ResultsWorkspace> createState() => _ResultsWorkspaceState();
}

class _ResultsWorkspaceState extends State<ResultsWorkspace> {
  late final _search = TextEditingController(text: widget.controller.query);
  final _searchFocus = FocusNode(debugLabel: 'Search Results');
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_syncQuery);
  }

  void _syncQuery() {
    if (_search.text != widget.controller.query) {
      _search.text = widget.controller.query;
    }
  }

  @override
  void didUpdateWidget(covariant ResultsWorkspace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_syncQuery);
      widget.controller.addListener(_syncQuery);
      _search.text = widget.controller.query;
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_syncQuery);
    _search.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      return CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.keyR, meta: true):
              controller.refresh,
          const SingleActivator(LogicalKeyboardKey.keyF, meta: true):
              _searchFocus.requestFocus,
        },
        child: Scaffold(
          appBar: AppBar(
            title: const Text('Results'),
            actions: [
              IconButton(
                key: const Key('macos-results-refresh'),
                tooltip: 'Refresh results',
                onPressed: controller.readable && !controller.downloading
                    ? controller.refresh
                    : null,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          body: RefreshIndicator(
            onRefresh: controller.refresh,
            child: LayoutBuilder(
              builder: (context, constraints) {
                final wide =
                    constraints.maxWidth >= 1100 &&
                    MediaQuery.textScalerOf(context).scale(16) <= 24;
                final selected = controller.selected;
                final ledger = _ledger(context, wide);
                return ListView(
                  key: const Key('results-scroll'),
                  padding: const EdgeInsets.all(16),
                  children: [
                    Text(
                      'Output and evidence',
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Read answers, open created files, and review the evidence behind your work.',
                    ),
                    const SizedBox(height: 12),
                    Semantics(
                      liveRegion: true,
                      child: Text(
                        !controller.readable
                            ? 'Results access is unavailable.'
                            : controller.loading
                            ? 'Refreshing Results. Last-loaded records remain visible.'
                            : controller.error != null
                            ? 'Some Results sources could not be refreshed. Check source availability below.'
                            : controller.workKnown
                            ? '${controller.snapshot?.items.length ?? 0} returned work records${controller.workFresh ? '' : ' · Last loaded'}'
                            : 'Work record count unavailable',
                      ),
                    ),
                    if (!controller.loading &&
                        ResultsSource.values.any(
                          (source) => const [
                            ResultsAvailability.partial,
                            ResultsAvailability.restricted,
                            ResultsAvailability.unavailable,
                          ].contains(controller.readFor(source).state),
                        ))
                      const Text(
                        'Some sources are partial, restricted or unavailable. Counts cover only returned records; check source availability for omitted records and access limits.',
                      ),
                    const SizedBox(height: 12),
                    CreatedFilesSection(
                      key: ValueKey(
                        controller.access?.scope ?? 'legacy-results-files',
                      ),
                      controller: controller,
                      files: controller.snapshot?.createdFiles ?? const [],
                      dense: widget.desktop,
                    ),
                    const SizedBox(height: 16),
                    _filters(context),
                    const SizedBox(height: 16),
                    if (wide)
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(child: ledger),
                          const SizedBox(width: 20),
                          Expanded(
                            child: ResultPanel(
                              child: selected == null
                                  ? Text(
                                      controller.selectedKey == null
                                          ? 'Select a result to inspect its returned output and evidence.'
                                          : 'The selected result is outside the current returned window. Use its exact link to check access and current state.',
                                    )
                                  : Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        FilledButton.icon(
                                          key: const Key('macos-result-open'),
                                          onPressed: controller.readable
                                              ? () => widget.onOpen(selected)
                                              : null,
                                          icon: const Icon(Icons.open_in_new),
                                          label: const Text('Open full record'),
                                        ),
                                        const SizedBox(height: 16),
                                        ResultDocument(item: selected),
                                      ],
                                    ),
                            ),
                          ),
                        ],
                      )
                    else
                      ledger,
                    const SizedBox(height: 16),
                    ResultPanel(
                      child: ExpansionTile(
                        expansionAnimationStyle:
                            MediaQuery.disableAnimationsOf(context)
                            ? AnimationStyle.noAnimation
                            : null,
                        tilePadding: EdgeInsets.zero,
                        title: const Text('Sources and coverage'),
                        children: [
                          const Padding(
                            padding: EdgeInsets.only(bottom: 16),
                            child: Text(
                              'Search covers the recently loaded window: up to 12 assistant tasks, 12 workflows, 12 decisions, 8 quality checks and 50 created files. A saved result link can open older work.',
                            ),
                          ),
                          for (final source in ResultsSource.values)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 16),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    resultsSourceLabel(source),
                                    style: Theme.of(context)
                                        .textTheme
                                        .titleSmall,
                                  ),
                                  Text(controller.readFor(source).label),
                                  if (controller.readFor(source).checkedAt
                                      case final at?)
                                    Text(
                                      'Checked ${at.toIso8601String()}',
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodySmall,
                                    ),
                                  if (controller.readFor(source).error
                                      case final error?)
                                    SelectableText(error),
                                ],
                              ),
                            ),
                        ],
                      ),
                    ),
                    ResultPanel(
                      child: ExpansionTile(
                        expansionAnimationStyle:
                            MediaQuery.disableAnimationsOf(context)
                            ? AnimationStyle.noAnimation
                            : null,
                        tilePadding: EdgeInsets.zero,
                        title: const Text('Evaluation evidence'),
                        subtitle: Text(
                          controller.readFor(ResultsSource.evaluations).label,
                        ),
                        children: [
                          if (controller.snapshot?.evaluations.isEmpty ?? true)
                            Text(
                              controller
                                      .readFor(ResultsSource.evaluations)
                                      .loaded
                                  ? 'No evaluations were returned in this window.'
                                  : 'Evaluations have not been successfully checked.',
                            ),
                          for (final evaluation
                              in controller.snapshot?.evaluations ??
                                  const <EvaluationResult>[])
                            Padding(
                              padding: const EdgeInsets.only(bottom: 16),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    evaluation.suite,
                                    style: Theme.of(context)
                                        .textTheme
                                        .titleSmall,
                                  ),
                                  SelectableText(evaluation.id),
                                  Text(
                                    '${evaluation.status} · ${evaluation.countLabel}',
                                  ),
                                ],
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      );
    },
  );
  Widget _filters(BuildContext context) {
    final controller = widget.controller;
    final statuses = <String>{
      ...?controller.snapshot?.items.map((item) => item.status),
      if (controller.status != null) controller.status!,
    }.toList()..sort();
    return Column(
      children: [
        TextField(
          controller: _search,
          focusNode: _searchFocus,
          onChanged: (value) => controller.filter(search: value),
          decoration: const InputDecoration(
            labelText: 'Search Results',
            hintText: 'Title, full ID, output or evidence',
          ),
        ),
        const SizedBox(height: 12),
        LayoutBuilder(
          builder: (context, constraints) {
            final kind = DropdownButtonFormField<ResultKind?>(
              key: ValueKey('kind:${controller.access?.scope}'),
              initialValue: controller.kind,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Result kind'),
              items: [
                const DropdownMenuItem<ResultKind?>(
                  value: null,
                  child: Text('Every kind'),
                ),
                for (final kind in ResultKind.values)
                  DropdownMenuItem(value: kind, child: Text(kind.name)),
              ],
              onChanged: (value) => controller.filter(
                resultKind: value,
                clearKind: value == null,
              ),
            );
            final status = DropdownButtonFormField<String>(
              key: ValueKey('status:${controller.access?.scope}'),
              initialValue: controller.status ?? '',
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Stored status'),
              items: [
                const DropdownMenuItem(value: '', child: Text('Every status')),
                for (final status in statuses)
                  DropdownMenuItem(
                    value: status,
                    child: Text(status.replaceAll('_', ' ')),
                  ),
              ],
              onChanged: (value) =>
                  controller.filter(resultStatus: value ?? ''),
            );
            if (constraints.maxWidth < 520 ||
                MediaQuery.textScalerOf(context).scale(16) > 24) {
              return Column(
                children: [kind, const SizedBox(height: 12), status],
              );
            }
            return Row(
              children: [
                Expanded(child: kind),
                const SizedBox(width: 12),
                Expanded(child: status),
              ],
            );
          },
        ),
      ],
    );
  }

  Widget _ledger(BuildContext context, bool wide) {
    final controller = widget.controller;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (controller.pageItems.isEmpty)
          ResultPanel(
            child: Text(
              !controller.workComplete
                  ? 'No matching records are available from the sources checked so far. Unavailable or partial sources are not known to be empty.'
                  : controller.query.isNotEmpty ||
                        controller.kind != null ||
                        controller.status != null
                  ? 'No returned records match these filters.'
                  : 'No work records were returned in this bounded window.',
            ),
          ),
        for (final item in controller.pageItems)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Material(
              color: controller.selectedKey == item.selectionIdentity
                  ? Theme.of(context).colorScheme.secondaryContainer
                  : Theme.of(context).colorScheme.surface,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(10),
                side: BorderSide(
                  color: Theme.of(context).colorScheme.outlineVariant,
                ),
              ),
              child: InkWell(
                key: Key('macos-result-${item.selectionIdentity}'),
                borderRadius: BorderRadius.circular(10),
                onTap: controller.readable
                    ? () {
                        controller.select(item.selectionIdentity);
                        if (!wide) {
                          widget.onOpen(item);
                        }
                      }
                    : null,
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        item.title,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      const SizedBox(height: 8),
                      Text(item.statusLabel),
                      Text(
                        '${item.kind.name} · ${item.meta}',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      Text(
                        item.key,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      if (item.approvalKind != null)
                        Text('Approval kind: ${item.approvalKind}'),
                      if (item.timestamp != null)
                        Text(
                          item.timestamp!.toIso8601String(),
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      Text(
                        item.groundingLabel,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        Wrap(
          spacing: 12,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            OutlinedButton(
              onPressed: controller.page > 0
                  ? () => controller.movePage(controller.page - 1)
                  : null,
              child: const Text('Previous'),
            ),
            Text(
              'Page ${controller.page + 1} of ${controller.pageCount} · ${controller.filtered.length} matching returned records',
            ),
            OutlinedButton(
              onPressed: controller.page + 1 < controller.pageCount
                  ? () => controller.movePage(controller.page + 1)
                  : null,
              child: const Text('Next'),
            ),
          ],
        ),
      ],
    );
  }
}

class ResultDetailWorkspace extends StatefulWidget {
  const ResultDetailWorkspace({
    super.key,
    required this.keyValue,
    required this.repository,
    this.approvalKind,
    this.onOpenInbox,
    this.onReturnToWork,
  });
  final String keyValue;
  final ResultsRepository repository;
  final String? approvalKind;
  final VoidCallback? onOpenInbox, onReturnToWork;
  @override
  State<ResultDetailWorkspace> createState() => _ResultDetailWorkspaceState();
}

class _ResultDetailWorkspaceState extends State<ResultDetailWorkspace> {
  late ResultDetailController _controller;
  String? _copyStatus;
  bool _copying = false;
  int? _copyGeneration;
  final _dialogs = <DialogRoute<bool>>{};
  @override
  void initState() {
    super.initState();
    _bind();
  }

  void _bind() {
    _controller = ResultDetailController(
      widget.repository,
      widget.keyValue,
      approvalKind: widget.approvalKind,
    );
    unawaited(_controller.refresh());
  }

  @override
  void didUpdateWidget(covariant ResultDetailWorkspace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.repository != widget.repository ||
        oldWidget.keyValue != widget.keyValue ||
        oldWidget.approvalKind != widget.approvalKind) {
      _closeDialogs();
      _controller.dispose();
      _copyStatus = null;
      _copying = false;
      _bind();
    }
  }

  void _closeDialogs() {
    final dialogs = _dialogs.toList();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      for (final route in dialogs) {
        if (route.isActive) {
          route.navigator?.removeRoute(route, false);
        }
      }
    });
  }

  @override
  void dispose() {
    _closeDialogs();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _controller,
    builder: (context, _) {
      final controller = _controller, item = controller.item;
      return CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.keyR, meta: true):
              controller.refresh,
          const SingleActivator(
            LogicalKeyboardKey.keyC,
            meta: true,
            shift: true,
          ): _copy,
        },
        child: Scaffold(
          appBar: AppBar(
            title: const Text('Result'),
            actions: [
              IconButton(
                key: const Key('macos-result-detail-refresh'),
                tooltip: 'Refresh exact result',
                onPressed: controller.readable && !controller.canceling
                    ? controller.refresh
                    : null,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          body: ListView(
            key: const Key('result-detail-scroll'),
            padding: const EdgeInsets.all(16),
            children: [
              Semantics(liveRegion: true, child: Text(controller.readLabel)),
              if (controller.readError != null)
                ResultPanel(
                  child: SelectableText(
                    controller.readError!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              if (controller.receipt != null)
                ResultPanel(
                  child: Semantics(
                    liveRegion: true,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(controller.receipt!.message),
                        SelectableText('Run ID: ${controller.receipt!.runId}'),
                        if (controller.receipt!.canceledJobs != null)
                          Text(
                            'Canceled jobs returned: ${controller.receipt!.canceledJobs}',
                          ),
                      ],
                    ),
                  ),
                ),
              if (controller.actionError != null)
                ResultPanel(
                  child: Semantics(
                    liveRegion: true,
                    child: Text(controller.actionError!),
                  ),
                ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 12,
                runSpacing: 8,
                children: [
                  if (item != null)
                    OutlinedButton.icon(
                      key: const Key('macos-result-copy'),
                      onPressed: controller.readable && !_copying
                          ? _copy
                          : null,
                      icon: const Icon(Icons.copy),
                      label: Text(_copying ? 'Copying…' : 'Copy output'),
                    ),
                  if (item?.kind == ResultKind.agent)
                    OutlinedButton.icon(
                      key: const Key('macos-result-cancel'),
                      onPressed: controller.canCancel ? _confirmCancel : null,
                      icon: const Icon(Icons.stop_circle_outlined),
                      label: Text(
                        controller.canceling
                            ? 'Requesting cancellation…'
                            : 'Cancel run',
                      ),
                    ),
                  if (widget.onOpenInbox != null &&
                      widget.keyValue.startsWith('approval:'))
                    OutlinedButton(
                      onPressed: controller.readable
                          ? widget.onOpenInbox
                          : null,
                      child: const Text('Open Inbox'),
                    ),
                  if (widget.onReturnToWork != null)
                    OutlinedButton(
                      onPressed: widget.onReturnToWork,
                      child: const Text('Return to Work'),
                    ),
                ],
              ),
              if (item?.kind == ResultKind.agent &&
                  controller.cancelBlocked != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                    controller.cancelBlocked!,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              if (_copyStatus != null &&
                  _copyGeneration == controller.generation)
                Semantics(liveRegion: true, child: Text(_copyStatus!)),
              const SizedBox(height: 16),
              if (item != null)
                ResultPanel(child: ResultDocument(item: item))
              else if (controller.loading)
                const Text('Checking the exact stored record…')
              else
                Text(
                  controller.missing
                      ? 'This exact record is unavailable or no longer visible. The result list is a bounded window; this read used the complete linked identity.'
                      : 'The exact result could not be loaded. Refresh to retry.',
                ),
            ],
          ),
        ),
      );
    },
  );
  Future<void> _copy() async {
    final controller = _controller, item = controller.item;
    if (_copying || !controller.readable || item == null) {
      return;
    }
    final generation = controller.generation;
    setState(() {
      _copying = true;
      _copyStatus = null;
    });
    try {
      await Clipboard.setData(ClipboardData(text: item.body));
      if (mounted &&
          identical(controller, _controller) &&
          generation == controller.generation &&
          controller.readable) {
        setState(() {
          _copyGeneration = generation;
          _copyStatus = 'Result output copied.';
        });
      }
    } catch (_) {
      if (mounted &&
          identical(controller, _controller) &&
          generation == controller.generation) {
        setState(() {
          _copyGeneration = generation;
          _copyStatus = 'Output could not be copied. Select the output text and copy it manually.';
        });
      }
    } finally {
      if (mounted && identical(controller, _controller)) {
        setState(() => _copying = false);
      }
    }
  }

  Future<void> _confirmCancel() async {
    final controller = _controller;
    if (!controller.canCancel) {
      return;
    }
    final generation = controller.generation, version = controller.version;
    final route = DialogRoute<bool>(
      context: context,
      builder: (context) => ListenableBuilder(
        listenable: controller,
        builder: (context, _) {
          final valid =
              identical(controller, _controller) &&
              controller.readable &&
              generation == controller.generation &&
              controller.canCancel &&
              version == controller.version;
          return AlertDialog(
            scrollable: true,
            title: Text(valid ? 'Cancel this agent run?' : 'Review expired'),
            content: valid
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SelectableText(controller.item!.key),
                      Text(controller.item!.title),
                      const SizedBox(height: 12),
                      const Text(
                        'This requests cancellation at a safe stopping point. Completed tool actions are not undone. A returned terminal receipt will determine the stored outcome.',
                      ),
                    ],
                  )
                : const Text(
                    'The result, session or access changed. Close this dialog and review a fresh exact result.',
                  ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                child: const Text('Keep run'),
              ),
              FilledButton(
                key: const Key('macos-result-cancel-confirm'),
                onPressed: valid ? () => Navigator.of(context).pop(true) : null,
                child: const Text('Request cancellation'),
              ),
            ],
          );
        },
      ),
    );
    _dialogs.add(route);
    final accepted = await Navigator.of(
      context,
      rootNavigator: true,
    ).push(route);
    await route.completed;
    _dialogs.remove(route);
    if (accepted == true &&
        mounted &&
        identical(controller, _controller) &&
        generation == controller.generation) {
      await controller.cancelReviewed(version);
    }
  }
}

class ResultPanel extends StatelessWidget {
  const ResultPanel({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Material(
      color: Theme.of(context).colorScheme.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: Theme.of(context).colorScheme.outlineVariant),
      ),
      child: Padding(padding: const EdgeInsets.all(16), child: child),
    ),
  );
}

class ResultDocument extends StatelessWidget {
  const ResultDocument({super.key, required this.item});
  final ResultItem item;
  @override
  Widget build(BuildContext context) {
    final research = item.research;
    if (research != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TalkResearchPanel(workflow: research),
          if (RegExp(r'^[A-Za-z0-9._:-]{1,200}$').hasMatch(research.threadId))
            TextButton.icon(
              onPressed: () => context.go(
                '/talk?thread=${Uri.encodeComponent(research.threadId)}',
              ),
              icon: const Icon(Icons.chat_bubble_outline_rounded, size: 18),
              label: Text(
                research.terminal
                    ? 'Open conversation'
                    : 'Open conversation and controls',
              ),
            ),
          if (research.report case final report?) ...[
            const SizedBox(height: 20),
            TalkRichMessage(text: report.linkedContent),
          ],
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SelectableText(
          item.title,
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 12),
        Text(item.statusLabel, style: Theme.of(context).textTheme.titleSmall),
        SelectableText(item.key),
        if (item.approvalKind != null)
          Text('Approval kind: ${item.approvalKind}'),
        SelectableText(item.meta),
        if (item.timestamp != null)
          Text('Recorded ${item.timestamp!.toIso8601String()}'),
        const SizedBox(height: 20),
        Text(
          item.kind == ResultKind.approval ? 'Review context' : 'Output',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        SelectableText(item.body, style: Theme.of(context).textTheme.bodyLarge),
        const SizedBox(height: 20),
        Text('Evidence', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Text(item.groundingLabel),
        Text(
          item.kind == ResultKind.agent
              ? 'Citation verification describes the returned sources. Verified success requires a canonical outcome receipt.'
              : 'The returned verification field does not establish successful completion. Verified success requires a canonical outcome receipt.',
        ),
        if (item.kind == ResultKind.agent)
          Text(
            'Created file evidence: ${item.metadata['Created file projection'] ?? 'not included in this record'}',
          ),
        if (item.evidence.isEmpty)
          const Text('No evidence references were returned in this record.'),
        for (var index = 0; index < item.evidence.length; index++)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Reference ${index + 1}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                SelectableText(item.evidence[index]),
              ],
            ),
          ),
        if (item.canonical != null)
          ExpansionTile(
            expansionAnimationStyle: MediaQuery.disableAnimationsOf(context)
                ? AnimationStyle.noAnimation
                : null,
            tilePadding: EdgeInsets.zero,
            title: const Text('Canonical outcome receipt'),
            children: [
              SelectableText(
                'Status: ${item.canonical!.status}\nBasis: ${item.canonical!.basis}\nSource: ${item.canonical!.source}\nSource status: ${item.canonical!.sourceStatus}\nVerification: ${item.canonical!.verificationState}',
              ),
            ],
          ),
        if (item.metadata.isNotEmpty)
          ExpansionTile(
            expansionAnimationStyle: MediaQuery.disableAnimationsOf(context)
                ? AnimationStyle.noAnimation
                : null,
            tilePadding: EdgeInsets.zero,
            title: const Text('Exact identity and provenance'),
            children: [
              for (final entry in item.metadata.entries)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        entry.key,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      SelectableText(entry.value),
                    ],
                  ),
                ),
            ],
          ),
      ],
    );
  }
}
