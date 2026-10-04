import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'responsibility_contracts.dart';
import 'responsibility_controller.dart';

/// Shared native workspace. The host binds this controller through Riverpod and
/// may route exact list selections through [onOpenResponsibility].
class ResponsibilityWorkspaceView extends StatefulWidget {
  const ResponsibilityWorkspaceView({
    super.key,
    required this.controller,
    this.focusId,
    this.onOpenResponsibility,
    this.onNewDraft,
  });
  final ResponsibilityController controller;
  final String? focusId;
  final ValueChanged<String>? onOpenResponsibility;
  final VoidCallback? onNewDraft;
  @override
  State<ResponsibilityWorkspaceView> createState() =>
      _ResponsibilityWorkspaceViewState();
}

class _ResponsibilityWorkspaceViewState
    extends State<ResponsibilityWorkspaceView> {
  ResponsibilityController get controller => widget.controller;
  @override
  void initState() {
    super.initState();
    _initialize();
  }

  void _initialize() {
    unawaited(
      Future<void>.microtask(() {
        if (mounted) return controller.initialize(focusId: widget.focusId);
      }),
    );
  }

  @override
  void didUpdateWidget(covariant ResponsibilityWorkspaceView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, controller) ||
        oldWidget.focusId != widget.focusId) {
      _initialize();
    }
  }

  void _select(String id) {
    final open = widget.onOpenResponsibility;
    if (open != null) {
      open(id);
    } else {
      unawaited(controller.select(id));
    }
  }

  Future<void> _newDraft() async {
    final origin = controller, epoch = controller.authorityEpoch;
    await origin.select(null);
    if (mounted &&
        identical(controller, origin) &&
        controller.authorityEpoch == epoch &&
        controller.available) {
      widget.onNewDraft?.call();
    }
  }

  Future<void> _saveDraft() async {
    final origin = controller,
        epoch = controller.authorityEpoch,
        creating = controller.selectedId == null;
    await origin.saveDraft();
    if (mounted &&
        identical(controller, origin) &&
        creating &&
        controller.authorityEpoch == epoch &&
        controller.available &&
        controller.selectedId != null &&
        controller.pending == null &&
        controller.accepted.isNotEmpty) {
      widget.onOpenResponsibility?.call(controller.selectedId!);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      if (!controller.available) {
        return const Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text(
              'Unlock your current account to read Responsibilities.',
            ),
          ),
        );
      }
      return CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.keyR, meta: true): () =>
              unawaited(controller.refresh()),
          const SingleActivator(LogicalKeyboardKey.keyR, control: true): () =>
              unawaited(controller.refresh()),
          const SingleActivator(LogicalKeyboardKey.keyS, meta: true): () =>
              unawaited(_saveDraft()),
          const SingleActivator(LogicalKeyboardKey.keyS, control: true): () =>
              unawaited(_saveDraft()),
        },
        child: Focus(
          child: Scaffold(
            appBar: AppBar(
              title: const Text('Responsibilities'),
              actions: [
                IconButton(
                  tooltip: 'Refresh Responsibilities',
                  onPressed: controller.loading ? null : controller.refresh,
                  icon: const Icon(Icons.refresh),
                ),
              ],
            ),
            body: LayoutBuilder(
              builder: (context, constraints) {
                final wide =
                    constraints.maxWidth >= 1000 &&
                    MediaQuery.textScalerOf(context).scale(16) <= 24;
                final detail = _detail();
                if (wide) {
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SizedBox(width: 320, child: _catalogue()),
                      const VerticalDivider(width: 1),
                      Expanded(child: detail),
                    ],
                  );
                }
                return ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    ExpansionTile(
                      key: const Key('responsibility-catalogue'),
                      initiallyExpanded: controller.selectedId == null,
                      title: Text(
                        'Recent responsibilities · ${controller.records.length}',
                      ),
                      children: [_catalogue(shrinkWrap: true)],
                    ),
                    ..._detailChildren(),
                  ],
                );
              },
            ),
          ),
        ),
      );
    },
  );
  Widget _catalogue({bool shrinkWrap = false}) => ListView(
    shrinkWrap: shrinkWrap,
    physics: shrinkWrap ? const NeverScrollableScrollPhysics() : null,
    padding: const EdgeInsets.all(12),
    children: [
      if (controller.canManage)
        OutlinedButton.icon(
          key: const Key('responsibility-new'),
          onPressed: controller.busy ? null : _newDraft,
          icon: const Icon(Icons.add),
          label: const Text('New draft'),
        ),
      const Padding(
        padding: EdgeInsets.symmetric(vertical: 12),
        child: Text('Up to 40 recent records. Total coverage is unknown.'),
      ),
      if (controller.readErrors[ResponsibilityRead.list] != null)
        _Notice(controller.readErrors[ResponsibilityRead.list]!, error: true),
      if (controller.loading && controller.listing == null)
        const LinearProgressIndicator(),
      if (controller.listing != null && controller.records.isEmpty)
        const Padding(
          padding: EdgeInsets.all(12),
          child: Text('No responsibilities were returned for this account.'),
        ),
      for (final record in controller.records)
        ListTile(
          key: ValueKey(record.id),
          selected: record.id == controller.selectedId,
          title: Text(
            record.title,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
          ),
          subtitle: Text(
            '${_label(record.state)} · revision ${record.revision}',
          ),
          onTap: () => _select(record.id),
        ),
      if (controller.listing?['hasMore'] == true)
        const Text(
          'More records exist outside this recent window. Exact Responsibility links can still be opened.',
        ),
    ],
  );
  Widget _detail() =>
      ListView(padding: const EdgeInsets.all(24), children: _detailChildren());
  List<Widget> _detailChildren() => [
    if (!controller.canManage)
      const _Notice(
        'This account can read Responsibilities. A workflow manager is required to edit, review, activate, or enable in-app notices.',
      ),
    if (controller.loading) const LinearProgressIndicator(),
    if (controller.recoveryError != null)
      _Notice(
        controller.recoveryError!,
        error: true,
        action: TextButton(
          onPressed: controller.retryProtectedRecovery,
          child: const Text('Retry protected recovery'),
        ),
      ),
    if (controller.error != null) _Notice(controller.error!, error: true),
    if (controller.notice != null) _Notice(controller.notice!),
    if (controller.pending != null) _pending(),
    for (final entry in controller.readErrors.entries.where(
      (entry) => entry.key != ResponsibilityRead.list,
    ))
      _Notice(entry.value, error: true),
    if (controller.selectedId != null && controller.record == null)
      _Section(
        title: 'Exact Responsibility',
        children: [
          SelectableText(controller.selectedId!),
          const Text(
            'The exact draft has not been verified. Retry the read before taking action.',
          ),
          TextButton(
            onPressed: controller.refreshDetail,
            child: const Text('Reload exact detail'),
          ),
        ],
      ),
    if (controller.selectedId == null || controller.record != null) ...[
      _Section(
        title: controller.record?.title ?? 'New Responsibility draft',
        children: [
          if (controller.record != null) ...[
            Text(
              '${_label(controller.record!.state)} · revision ${controller.record!.revision}',
            ),
            SelectableText(controller.record!.id),
          ],
          const Text(
            'Describe a finite responsibility, choose exact references, then review its current pins. Saving and reviewing do not start checks or delivery.',
          ),
          if (controller.canManage)
            _ResponsibilityDraftEditor(
              key: ValueKey((
                controller,
                controller.repository.access.owner?.key,
                controller.selectedId ?? 'new',
              )),
              controller: controller,
            )
          else
            _Evidence(label: 'Saved draft', value: controller.record?.draft),
          if (controller.invalidDraftInputs.isNotEmpty)
            const _Notice(
              'Complete or correct the highlighted draft fields before saving or changing authority.',
              error: true,
            ),
          if (controller.draftRevisionConflict)
            _Notice(
              'Your local draft was based on an older server revision. Review both versions before rebasing these edits.',
              error: true,
              action: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _Evidence(
                    label: 'Current server draft',
                    value: controller.record!.draft,
                  ),
                  TextButton(
                    onPressed: controller.canMutate ? _rebase : null,
                    child: const Text('Rebase local draft'),
                  ),
                ],
              ),
            ),
          if (controller.canManage)
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton.icon(
                  key: const Key('responsibility-save'),
                  onPressed: controller.canSaveDraft ? _saveDraft : null,
                  icon: const Icon(Icons.save_outlined),
                  label: Text(
                    controller.selectedId == null
                        ? 'Save draft'
                        : 'Save exact revision',
                  ),
                ),
                if (controller.selectedId != null)
                  OutlinedButton(
                    onPressed:
                        controller.canMutate &&
                            !controller.dirty &&
                            controller.invalidDraftInputs.isEmpty
                        ? () => controller.requestPreview(
                            ResponsibilityRead.detail,
                          )
                        : null,
                    child: const Text('Review current pins'),
                  ),
              ],
            ),
        ],
      ),
      if (controller.selectedId != null) ...[
        _review(),
        _runtime(),
        _observations(),
        _notifications(),
      ],
    ],
    if (controller.accepted.isNotEmpty)
      _Section(
        title: 'Accepted action receipts',
        children: [
          const Text(
            'These immutable responses remain accepted if a later read fails. A replay may return a newer current snapshot.',
          ),
          for (final raw in controller.accepted)
            Builder(
              builder: (context) {
                final intent = responsibilityMap(raw['intent']),
                    result = responsibilityMap(raw['result']),
                    receipt = responsibilityMap(result['receipt']);
                return _Evidence(
                  label:
                      '${_label(responsibilityMap(intent['body'])['action'])} · ${receipt['savedAt']}',
                  value: receipt,
                );
              },
            ),
          const Text(
            'The latest 12 local receipts are retained securely. Server history is separately bounded.',
          ),
        ],
      ),
    const SizedBox(height: 32),
  ];
  Widget _pending() {
    final pending = controller.pending!;
    return _Section(
      title: 'Unconfirmed change',
      children: [
        Text('${_label(pending.body['action'])} · ${pending.lane.name}'),
        const Text(
          'The original request and key are saved on this device. Refreshing does not retry it. Recovery sends exactly this frozen request; no new action can run while its outcome is unresolved.',
        ),
        _Evidence(label: 'Frozen request', value: pending.json),
        FilledButton.tonal(
          key: const Key('responsibility-recover'),
          onPressed:
              controller.canManage &&
                  controller.recoveryReady &&
                  !controller.busy
              ? controller.recoverPending
              : null,
          child: const Text('Recover original request'),
        ),
      ],
    );
  }

  Future<void> _rebase() async {
    final origin = controller,
        epoch = controller.authorityEpoch,
        id = controller.selectedId,
        revision = controller.record?.revision;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        scrollable: true,
        title: const Text('Rebase your local draft?'),
        content: const Text(
          'Your local field values will be proposed against the current server revision. Check the current server draft above before continuing.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep reviewing'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Use current revision'),
          ),
        ],
      ),
    );
    if (!mounted ||
        !identical(controller, origin) ||
        confirmed != true ||
        controller.authorityEpoch != epoch ||
        controller.selectedId != id ||
        controller.record?.revision != revision) {
      return;
    }
    controller.rebaseDraft();
  }

  Widget _review() {
    final ready = controller.preview(ResponsibilityRead.detail);
    return _Section(
      title: 'Exact draft review',
      children: [
        Text(
          ready == null
              ? 'Current pins have not been checked.'
              : 'Review: ${_label(ready['state'])}',
        ),
        if (ready?['issues'] is List)
          for (final issue in ready!['issues'] as List)
            Text('• ${_label(issue)}'),
        if (ready?['state'] == 'ready') ...[
          const Text(
            'The source revisions, canonical Work, procedure snapshot, and Agent identity below are the exact proposed pins.',
          ),
          _Evidence(label: 'Review digests and pins', value: ready),
          FilledButton.tonal(
            key: const Key('responsibility-review-accept'),
            onPressed:
                controller.canMutate &&
                    !controller.dirty &&
                    controller.invalidDraftInputs.isEmpty &&
                    controller.isFresh(ResponsibilityRead.detail)
                ? controller.acceptReview
                : null,
            child: const Text('Accept this review'),
          ),
        ],
        if (controller.record?.raw['review'] != null)
          _Evidence(
            label: 'Saved review receipt',
            value: controller.record!.raw['review'],
          ),
      ],
    );
  }

  Widget _runtime() {
    final view = controller.view(ResponsibilityRead.runtime),
        head = controller.head(ResponsibilityRead.runtime),
        ready = controller.preview(ResponsibilityRead.runtime);
    return _Section(
      title: 'Finite checks',
      children: [
        Text(
          head == null
              ? 'No runtime admission is confirmed.'
              : '${_label(head['state'])} · ${_label(head['reason'])} · revision ${head['revision']} · generation ${head['generation']}',
        ),
        if (view?['disclosure'] is Map)
          for (final field in [
            'source',
            'comparison',
            'cadence',
            'stops',
            'execution',
          ])
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                responsibilityMap(view!['disclosure'])[field] as String,
              ),
            ),
        if (head != null) ...[
          Text('Next due: ${head['nextDueAt'] ?? 'none'}'),
          _BudgetSummary(head),
          _Evidence(
            label: 'Pinned runtime configuration',
            value: head['configuration'],
          ),
        ],
        if (ready?['state'] == 'blocked')
          _Notice('Activation review blocked: ${_label(ready!['reason'])}'),
        if (ready?['state'] == 'ready') ...[
          const Text(
            'This review grants no authority. Activation or resume admits only the disclosed finite pilot; it does not enable notifications.',
          ),
          _Evidence(
            label: 'Exact activation configuration',
            value: ready!['configuration'],
          ),
        ],
        if (controller.canManage)
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (head == null || head['state'] == 'paused')
                OutlinedButton(
                  onPressed: controller.canMutate && !controller.dirty
                      ? () => controller.requestPreview(
                          ResponsibilityRead.runtime,
                        )
                      : null,
                  child: const Text('Review activation'),
                ),
              if (ready?['state'] == 'ready' &&
                  (head == null || head['state'] == 'paused'))
                FilledButton(
                  onPressed:
                      controller.canMutate &&
                          !controller.dirty &&
                          controller.isFresh(ResponsibilityRead.runtime)
                      ? () => controller.lifecycle(
                          head == null ? 'activate' : 'resume',
                        )
                      : null,
                  child: Text(
                    head == null
                        ? 'Acknowledge pilot and activate'
                        : 'Acknowledge pilot and resume',
                  ),
                ),
              if (head?['state'] == 'active')
                OutlinedButton(
                  onPressed:
                      controller.canMutate &&
                          controller.isFresh(ResponsibilityRead.runtime)
                      ? () => controller.lifecycle('pause')
                      : null,
                  child: const Text('Pause checks'),
                ),
              if (head != null &&
                  !const {'ending', 'ended'}.contains(head['state']))
                OutlinedButton(
                  onPressed:
                      controller.canMutate &&
                          controller.isFresh(ResponsibilityRead.runtime)
                      ? () => controller.lifecycle('end')
                      : null,
                  child: const Text('End checks'),
                ),
            ],
          ),
        if (view != null) ...[
          const Text(
            'Up to 40 wakes and 40 lifecycle receipts. Totals are unknown; scheduler dispatch has not been observed by this read.',
          ),
          for (final raw in view['wakes'] as List)
            Builder(
              builder: (_) {
                final wake = responsibilityMap(raw);
                return _Evidence(
                  label:
                      '${_label(wake['state'])} · ${wake['scheduledFor']} · generation ${wake['generation']}',
                  value: wake,
                );
              },
            ),
          _Evidence(
            label: 'Lifecycle receipt history',
            value: view['receipts'],
          ),
          if (responsibilityMap(view['coverage'])['hasMoreWakes'] == true ||
              responsibilityMap(view['coverage'])['hasMoreReceipts'] == true)
            const Text(
              'Additional lifecycle history exists outside this window.',
            ),
        ],
      ],
    );
  }

  Widget _observations() {
    final view = controller.view(ResponsibilityRead.observations);
    return _Section(
      title: 'Accepted observations and baseline',
      children: [
        const Text(
          'Only authoritative stored evidence can advance the baseline. The first complete observation establishes a baseline quietly. No change and cosmetic differences do not produce a material-change notice.',
        ),
        if (view == null)
          const Text('Observation evidence has not been verified.')
        else ...[
          if (view['baseline'] == null)
            const Text('No accepted baseline is recorded.')
          else
            _Evidence(
              label:
                  'Accepted baseline · revision ${responsibilityMap(view['baseline'])['revision']}',
              value: view['baseline'],
            ),
          Text(responsibilityMap(view['policy'])['adapterCoverage'] as String),
          for (final field in [
            'materialExamples',
            'cosmeticExamples',
            'unsupportedExamples',
          ])
            _Evidence(
              label: _label(
                field == 'materialExamples'
                    ? 'Material changes'
                    : field == 'cosmeticExamples'
                    ? 'Cosmetic differences'
                    : 'Insufficient evidence',
              ),
              value: responsibilityMap(view['policy'])[field],
            ),
          for (final raw in view['receipts'] as List)
            Builder(
              builder: (_) {
                final receipt = responsibilityMap(raw),
                    plan = responsibilityMap(receipt['plan']),
                    observation = responsibilityMap(plan['observation']);
                return _Section(
                  title:
                      '${_label(plan['outcome'])} · ${observation['observedAt']}',
                  children: [
                    Text((plan['reasons'] as List).map(_label).join(', ')),
                    for (final rawSource in observation['sources'] as List)
                      Builder(
                        builder: (_) {
                          final source = responsibilityMap(rawSource);
                          return Text(
                            '${_label(responsibilityMap(source['source'])['kind'])} · ${_label(source['state'])}${source['reason'] == null ? '' : ' · ${_label(source['reason'])}'} · ${(source['evidence'] as List).length} evidence references',
                          );
                        },
                      ),
                    if (plan['change'] != null)
                      Text(
                        'Material categories: ${(responsibilityMap(plan['change'])['categories'] as List).map(_label).join(', ')}. Delivery was not requested by this observation.',
                      ),
                    _Evidence(
                      label: 'Exact observation receipt and evidence',
                      value: receipt,
                    ),
                  ],
                );
              },
            ),
          Text(
            '${(view['receipts'] as List).length} of up to 25 recent receipts. Total is unknown.${view['hasMore'] == true ? ' More history exists.' : ''}',
          ),
        ],
      ],
    );
  }

  Widget _notifications() {
    final view = controller.view(ResponsibilityRead.notifications),
        head = controller.head(ResponsibilityRead.notifications),
        ready = controller.preview(ResponsibilityRead.notifications);
    return _Section(
      title: 'Separate in-app notification authority',
      children: [
        Text(
          view?['disclosure'] as String? ?? 'In-app notifications require their own current review and explicit admission. Runtime activation alone grants no notification authority.',
        ),
        const Text(
          'Only an actual in-app inbox record counts as delivered. This feature does not send push, email, or browser notifications. Enabling does not backfill older observations.',
        ),
        Text(
          head == null
              ? 'No notification admission is confirmed.'
              : '${_label(head['state'])} · ${_label(head['reason'])} · revision ${head['revision']} · generation ${head['generation']}',
        ),
        if (head != null) ...[
          Text(
            '${head['used']} recorded · ${head['reserved']} reserved · ${responsibilityMap(head['configuration'])['maximumNotifications']} cumulative maximum',
          ),
          Text(
            'Expires: ${responsibilityMap(head['configuration'])['expiresAt']}',
          ),
          _Evidence(
            label: 'Pinned destination and configuration',
            value: head['configuration'],
          ),
        ],
        if (ready?['state'] == 'blocked')
          _Notice('Notification review blocked: ${_label(ready!['reason'])}'),
        if (ready?['state'] == 'ready')
          _Evidence(label: 'Exact in-app admission review', value: ready),
        if (controller.canManage)
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (head == null)
                OutlinedButton(
                  onPressed: controller.canMutate && !controller.dirty
                      ? () => controller.requestPreview(
                          ResponsibilityRead.notifications,
                        )
                      : null,
                  child: const Text('Review in-app notices'),
                ),
              if (head == null && ready?['state'] == 'ready')
                FilledButton(
                  onPressed:
                      controller.canMutate &&
                          !controller.dirty &&
                          controller.isFresh(ResponsibilityRead.notifications)
                      ? () => controller.notification('enable')
                      : null,
                  child: const Text('Enable reviewed in-app notices'),
                ),
              if (head != null && head['state'] != 'ended')
                OutlinedButton(
                  onPressed:
                      controller.canMutate &&
                          controller.isFresh(ResponsibilityRead.notifications)
                      ? _stopNotifications
                      : null,
                  child: const Text('Stop in-app notices'),
                ),
            ],
          ),
        if (view != null) ...[
          for (final raw in view['candidates'] as List)
            Builder(
              builder: (_) {
                final candidate = responsibilityMap(raw),
                    delivered = candidate['state'] == 'delivered';
                return _Section(
                  title: delivered
                      ? 'Recorded in this account’s inbox'
                      : '${_label(candidate['state'])} · ${_label(candidate['reason'])}',
                  children: [
                    if (candidate['state'] == 'held')
                      const Text(
                        'Quiet hours hold this exact candidate. It has not been delivered.',
                      ),
                    if (candidate['nextAttemptAt'] != null)
                      Text(
                        'Next eligible attempt: ${candidate['nextAttemptAt']}',
                      ),
                    Text(
                      'Expires: ${candidate['expiresAt']} · ${candidate['attempts']} attempts',
                    ),
                    _Evidence(
                      label: 'Candidate and ledger references',
                      value: candidate,
                    ),
                  ],
                );
              },
            ),
          _Evidence(
            label: 'Notification receipt history',
            value: view['receipts'],
          ),
          const Text(
            'Up to 40 candidates and 40 receipts are shown. Counts may be below cumulative use; total history is unknown.',
          ),
          if (responsibilityMap(view['coverage'])['hasMoreCandidates'] ==
                  true ||
              responsibilityMap(view['coverage'])['hasMoreReceipts'] == true)
            const Text(
              'Additional notification history exists outside this window.',
            ),
        ],
      ],
    );
  }

  Future<void> _stopNotifications() async {
    final origin = controller,
        epoch = controller.authorityEpoch,
        id = controller.selectedId,
        head = controller.head(ResponsibilityRead.notifications);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        scrollable: true,
        title: const Text('Stop these in-app notices?'),
        content: const Text(
          'This permanently ends the separate notification admission and cancels held or pending notices. Already recorded inbox history remains. It does not reopen or restart checks.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep notices'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Stop notices'),
          ),
        ],
      ),
    );
    if (!mounted ||
        !identical(controller, origin) ||
        confirmed != true ||
        controller.authorityEpoch != epoch ||
        controller.selectedId != id ||
        !responsibilitySame(
          controller.head(ResponsibilityRead.notifications),
          head,
        )) {
      return;
    }
    await controller.notification('stop');
  }
}

class _ResponsibilityDraftEditor extends StatefulWidget {
  const _ResponsibilityDraftEditor({super.key, required this.controller});
  final ResponsibilityController controller;
  @override
  State<_ResponsibilityDraftEditor> createState() =>
      _ResponsibilityDraftEditorState();
}

class _ResponsibilityDraftEditorState
    extends State<_ResponsibilityDraftEditor> {
  ResponsibilityController get controller => widget.controller;
  final Map<String, TextEditingController> _fields = {};
  final Map<String, String> _renderedValues = {};
  bool get enabled =>
      controller.canManage &&
      controller.recoveryReady &&
      !controller.busy &&
      !controller.uncertain;
  void _change(String key, Object? value) =>
      controller.edit({...controller.draft, key: value});
  TextEditingController _text(String key, String value) {
    final field = _fields.putIfAbsent(
      key,
      () => TextEditingController(text: value),
    );
    final previous = _renderedValues[key];
    if (previous != value && field.text == previous) {
      field.value = TextEditingValue(
        text: value,
        selection: TextSelection.collapsed(offset: value.length),
      );
    }
    _renderedValues[key] = value;
    return field;
  }

  Widget _field(
    String key,
    String label,
    String value,
    ValueChanged<String> onChanged, {
    int lines = 1,
    int? maxLength,
    bool numeric = false,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: TextField(
      key: ValueKey('responsibility-field-$key'),
      controller: _text(key, value),
      enabled: enabled,
      maxLines: lines,
      maxLength: maxLength,
      keyboardType: numeric
          ? TextInputType.number
          : lines > 1
          ? TextInputType.multiline
          : TextInputType.text,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
        alignLabelWithHint: true,
        errorText: controller.invalidDraftInputs.contains(key)
            ? 'Enter a valid finite value.'
            : null,
      ),
      onChanged: (text) {
        var valid = !RegExp(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]').hasMatch(text);
        if (numeric) {
          final n = int.tryParse(text),
              maximum = key == 'interval'
                  ? 24
                  : key == 'checks'
                  ? 10000
                  : key == 'notices'
                  ? 1000
                  : 1000000000000;
          valid =
              valid &&
              n != null &&
              n >= (key == 'interval' || key == 'checks' ? 1 : 0) &&
              n <= maximum;
        }
        if (key == 'timezone') {
          valid = valid && text.trim().isNotEmpty && text.trim().length <= 100;
        }
        if (key == 'stops') {
          final lines = text
              .split('\n')
              .map((s) => s.trim())
              .where((s) => s.isNotEmpty)
              .toList();
          valid =
              valid && lines.length <= 8 && lines.every((s) => s.length <= 500);
        }
        if (key == 'starts' || key == 'expires') {
          final startText = _fields['starts']?.text ?? '',
              endText = _fields['expires']?.text ?? '';
          final start = DateTime.tryParse(startText),
              end = DateTime.tryParse(endText);
          valid =
              valid &&
              start != null &&
              end != null &&
              start.toUtc().toIso8601String() == startText &&
              end.toUtc().toIso8601String() == endText &&
              startText.endsWith('Z') &&
              endText.endsWith('Z') &&
              end.isAfter(start) &&
              end.difference(start) <= const Duration(days: 366);
          controller.draftInputValidity('starts', valid);
          controller.draftInputValidity('expires', valid);
          if (valid) {
            final cadence = responsibilityMap(controller.draft['cadence']);
            _change('cadence', {
              ...cadence,
              'startsAt': DateTime.fromMillisecondsSinceEpoch(
                start.millisecondsSinceEpoch,
                isUtc: true,
              ).toIso8601String(),
              'expiresAt': DateTime.fromMillisecondsSinceEpoch(
                end.millisecondsSinceEpoch,
                isUtc: true,
              ).toIso8601String(),
            });
          }
          return;
        }
        controller.draftInputValidity(key, valid);
        if (valid) onChanged(text);
      },
    ),
  );
  void _clearInputErrors(Iterable<String> keys) {
    for (final key in keys) {
      if (_fields.containsKey(key)) {
        _fields[key]!.text = _renderedValues[key] ?? '';
      }
      controller.draftInputValidity(key, true);
    }
  }

  @override
  void dispose() {
    for (final field in _fields.values) {
      field.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final draft = controller.draft,
        groups = controller.references == null
            ? null
            : responsibilityMap(controller.references!['groups']);
    final cadence = draft['cadence'] == null
            ? null
            : responsibilityMap(draft['cadence']),
        limits = draft['limits'] == null
            ? null
            : responsibilityMap(draft['limits']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _field(
          'purpose',
          'Purpose',
          draft['purpose'] as String,
          (v) => _change('purpose', v.trim()),
          lines: 2,
          maxLength: 2000,
        ),
        _field(
          'outcome',
          'Desired outcome',
          draft['desiredOutcome'] as String,
          (v) => _change('desiredOutcome', v.trim()),
          lines: 2,
          maxLength: 2000,
        ),
        _choices(groups),
        _field(
          'success',
          'Success condition (descriptive)',
          draft['successCondition'] as String,
          (v) => _change('successCondition', v.trim()),
          lines: 2,
          maxLength: 1000,
        ),
        _field(
          'stops',
          'Stop conditions (one per line, up to 8)',
          (draft['stopConditions'] as List).join('\n'),
          (v) => _change(
            'stopConditions',
            v
                .split('\n')
                .map((s) => s.trim())
                .where((s) => s.isNotEmpty)
                .toList(),
          ),
          lines: 3,
        ),
        const Text(
          'The finite pilot enforces expiry and meeting start/cancellation. Free-text success and stop conditions remain descriptive.',
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Finite cadence'),
          value: cadence != null,
          onChanged: enabled
              ? (v) {
                  final now = DateTime.fromMillisecondsSinceEpoch(
                    DateTime.now().millisecondsSinceEpoch,
                    isUtc: true,
                  );
                  _clearInputErrors([
                    'starts',
                    'expires',
                    'timezone',
                    'interval',
                  ]);
                  _change(
                    'cadence',
                    v
                        ? {
                            'frequency': 'daily',
                            'interval': 1,
                            'timezone': 'UTC',
                            'startsAt': now
                                .add(const Duration(minutes: 5))
                                .toIso8601String(),
                            'expiresAt': now
                                .add(const Duration(days: 7))
                                .toIso8601String(),
                            'missedPolicy': 'skip',
                          }
                        : null,
                  );
                }
              : null,
        ),
        if (cadence != null) ...[
          DropdownButtonFormField<String>(
            key: ValueKey('cadence-${cadence['frequency']}'),
            initialValue: cadence['frequency'] as String,
            isExpanded: true,
            itemHeight: null,
            isDense: false,
            decoration: const InputDecoration(labelText: 'Frequency'),
            items: [
              for (final value in ['hourly', 'daily', 'weekly'])
                DropdownMenuItem(value: value, child: Text(_label(value))),
            ],
            onChanged: enabled
                ? (v) => _change('cadence', {...cadence, 'frequency': v})
                : null,
          ),
          _field('interval', 'Interval (1–24)', '${cadence['interval']}', (v) {
            final n = int.tryParse(v);
            if (n != null && n >= 1 && n <= 24) {
              _change('cadence', {...cadence, 'interval': n});
            }
          }, numeric: true),
          _field('timezone', 'IANA timezone', cadence['timezone'] as String, (
            v,
          ) {
            if (v.trim().isNotEmpty) {
              _change('cadence', {...cadence, 'timezone': v.trim()});
            }
          }),
          _field(
            'starts',
            'Starts at (UTC ISO instant)',
            cadence['startsAt'] as String,
            (v) => _cadenceTime(cadence, 'startsAt', v),
          ),
          _field(
            'expires',
            'Expires at (UTC ISO instant)',
            cadence['expiresAt'] as String,
            (v) => _cadenceTime(cadence, 'expiresAt', v),
          ),
          const Text(
            'Missed checks are skipped. The current pilot supports daily or weekly cadence and a 15-minute due grace.',
          ),
        ],
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Finite cumulative limits'),
          value: limits != null,
          onChanged: enabled
              ? (v) {
                  _clearInputErrors([
                    'checks',
                    'notices',
                    ...responsibilityBudgetDimensions.map(
                      (key) => 'budget-$key',
                    ),
                  ]);
                  _change(
                    'limits',
                    v
                        ? {
                            'maxChecks': 7,
                            'maxNotifications': 0,
                            'cumulative': {
                              for (final key in responsibilityBudgetDimensions)
                                key: key == 'wallTimeMs'
                                    ? 210000
                                    : key == 'toolCalls' || key == 'agents'
                                    ? 7
                                    : 0,
                            },
                          }
                        : null,
                  );
                }
              : null,
        ),
        if (limits != null) ...[
          _field(
            'checks',
            'Maximum checks (1–10000)',
            '${limits['maxChecks']}',
            (v) {
              final n = int.tryParse(v);
              if (n != null && n > 0 && n <= 10000) {
                _change('limits', {...limits, 'maxChecks': n});
              }
            },
            numeric: true,
          ),
          _field(
            'notices',
            'Maximum in-app notices (0–1000)',
            '${limits['maxNotifications']}',
            (v) {
              final n = int.tryParse(v);
              if (n != null && n >= 0 && n <= 1000) {
                _change('limits', {...limits, 'maxNotifications': n});
              }
            },
            numeric: true,
          ),
          ExpansionTile(
            title: const Text('Cumulative resource limits'),
            children: [
              for (final key in responsibilityBudgetDimensions)
                _field(
                  'budget-$key',
                  key == 'costMicrousd' ? 'Cost (micro USD)' : key,
                  '${responsibilityMap(limits['cumulative'])[key]}',
                  (v) {
                    final n = int.tryParse(v);
                    if (n != null && n >= 0 && n <= 1000000000000) {
                      _change('limits', {
                        ...limits,
                        'cumulative': {
                          ...responsibilityMap(limits['cumulative']),
                          key: n,
                        },
                      });
                    }
                  },
                  numeric: true,
                ),
            ],
          ),
        ],
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Material changes only, in this account’s inbox'),
          subtitle: const Text(
            'Quiet on no change. This draft setting does not enable delivery.',
          ),
          value: draft['notificationRule'] != null,
          onChanged: enabled
              ? (v) => _change(
                  'notificationRule',
                  v
                      ? {
                          'kind': 'material_change_only',
                          'destination': 'owner_in_app',
                          'quietOnNoChange': true,
                        }
                      : null,
                )
              : null,
        ),
      ],
    );
  }

  void _cadenceTime(ResponsibilityJson cadence, String key, String value) {
    final parsed = DateTime.tryParse(value.trim());
    if (parsed == null || !value.endsWith('Z')) return;
    final utc = DateTime.fromMillisecondsSinceEpoch(
      parsed.millisecondsSinceEpoch,
      isUtc: true,
    ).toIso8601String();
    _change('cadence', {...cadence, key: utc});
  }

  Widget _choices(ResponsibilityJson? groups) {
    final draft = controller.draft;
    List<ResponsibilityJson> items(String group) => groups == null
        ? const []
        : ((responsibilityMap(groups[group])['items']) as List)
              .map(responsibilityMap)
              .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (groups == null)
          const _Notice(
            'Reference choices are unavailable. Existing exact selections are retained.',
          ),
        if (groups != null)
          for (final name in ['sources', 'work', 'procedures', 'agents'])
            if (responsibilityMap(groups[name])['state'] == 'unavailable' ||
                responsibilityMap(groups[name])['hasMore'] == true)
              Text(
                '${_label(name)}: ${responsibilityMap(groups[name])['state'] == 'unavailable' ? 'read unavailable' : 'up to 40 choices; more exist'}. Exact saved selections are retained.',
              ),
        const Padding(
          padding: EdgeInsets.only(top: 12),
          child: Text('Sources (up to 20)'),
        ),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final raw in draft['sources'] as List)
              InputChip(
                label: Text(
                  '${_label(responsibilityMap(raw)['kind'])}: ${responsibilityMap(raw)['id']}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                onDeleted: enabled
                    ? () => _change(
                        'sources',
                        (draft['sources'] as List)
                            .where((item) => !responsibilitySame(item, raw))
                            .toList(),
                      )
                    : null,
              ),
          ],
        ),
        PopupMenuButton<String>(
          enabled:
              enabled &&
              (draft['sources'] as List).length < 20 &&
              controller.isFresh(ResponsibilityRead.references),
          tooltip: 'Add exact source',
          onSelected: (key) {
            final selected = items('sources').firstWhere(
              (row) => responsibilityCanonical(row['source']) == key,
            )['source'];
            if (!(draft['sources'] as List).any(
              (row) => responsibilitySame(row, selected),
            )) {
              _change('sources', [...draft['sources'] as List, selected]);
            }
          },
          itemBuilder: (_) => [
            for (final row in items('sources'))
              PopupMenuItem(
                value: responsibilityCanonical(row['source']),
                child: Text(row['label'] as String),
              ),
          ],
          child: const Padding(
            padding: EdgeInsets.all(12),
            child: Text('Add an available source'),
          ),
        ),
        _choice(
          'work',
          'Canonical Work',
          draft['work'],
          items('work')
              .map(
                (row) => ({
                  'label': row['label'],
                  'value': {
                    for (final key in [
                      'workspaceId',
                      'projectId',
                      'workItemId',
                    ])
                      key: row[key],
                  },
                }),
              )
              .toList(),
        ),
        _choice(
          'procedureId',
          'Procedure',
          draft['procedureId'],
          items('procedures')
              .map((row) => ({'label': row['label'], 'value': row['id']}))
              .toList(),
        ),
        _choice(
          'agentId',
          'Agent',
          draft['agentId'],
          items('agents')
              .map((row) => ({'label': row['label'], 'value': row['id']}))
              .toList(),
        ),
      ],
    );
  }

  Widget _choice(
    String field,
    String label,
    Object? current,
    List<ResponsibilityJson> rows,
  ) {
    final choices = <String, ResponsibilityJson>{
      'null': {'label': 'None selected', 'value': null},
    };
    for (final row in rows) {
      choices[responsibilityCanonical(row['value'])] = row;
    }
    final selected = responsibilityCanonical(current);
    choices.putIfAbsent(
      selected,
      () => {'label': 'Saved exact selection: $selected', 'value': current},
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: DropdownButtonFormField<String>(
        key: ValueKey('$field:$selected'),
        initialValue: selected,
        isExpanded: true,
        itemHeight: null,
        isDense: false,
        decoration: InputDecoration(
          labelText: label,
          border: const OutlineInputBorder(),
        ),
        items: [
          for (final entry in choices.entries)
            DropdownMenuItem(
              value: entry.key,
              child: Text(
                entry.value['label'] as String,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
              ),
            ),
        ],
        onChanged: enabled && controller.isFresh(ResponsibilityRead.references)
            ? (key) => _change(field, choices[key]!['value'])
            : null,
      ),
    );
  }
}

class _BudgetSummary extends StatelessWidget {
  const _BudgetSummary(this.head);
  final ResponsibilityJson head;
  @override
  Widget build(BuildContext context) {
    final budget = responsibilityMap(head['budget']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Checks: ${budget['usedChecks']} used + ${budget['reservedChecks']} reserved / ${budget['maximumChecks']} maximum',
        ),
        ExpansionTile(
          title: const Text('Cumulative use and reservations'),
          children: [
            for (final key in responsibilityBudgetDimensions)
              ListTile(
                title: Text(key),
                subtitle: Text(
                  '${responsibilityMap(budget['used'])[key]} used + ${responsibilityMap(budget['reserved'])[key]} reserved / ${responsibilityMap(budget['limits'])[key]} limit',
                ),
              ),
          ],
        ),
      ],
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.children});
  final String title;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.symmetric(vertical: 10),
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),
          for (final child in children)
            Padding(padding: const EdgeInsets.only(bottom: 10), child: child),
        ],
      ),
    ),
  );
}

class _Notice extends StatelessWidget {
  const _Notice(this.message, {this.error = false, this.action});
  final String message;
  final bool error;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.symmetric(vertical: 8),
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: error
          ? Theme.of(context).colorScheme.errorContainer
          : Theme.of(context).colorScheme.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [Text(message), ?action],
    ),
  );
}

class _Evidence extends StatelessWidget {
  const _Evidence({required this.label, required this.value});
  final String label;
  final Object? value;
  @override
  Widget build(BuildContext context) => ExpansionTile(
    title: Text(label),
    children: [
      Padding(
        padding: const EdgeInsets.all(12),
        child: Align(
          alignment: Alignment.centerLeft,
          child: SelectableText(
            const JsonEncoder.withIndent('  ').convert(value),
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
      ),
    ],
  );
}

String _label(Object? value) => (value?.toString() ?? 'Unknown')
    .replaceAll('responsibility_', '')
    .replaceAll('_', ' ');
