import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/platform/macos_presentation.dart';
import '../../core/network/native_workspace_access.dart';
import 'quality_contracts.dart';
import 'quality_controller.dart';
import 'quality_providers.dart';

/// An indexed shell can keep hidden branches mounted. A new visibility epoch
/// owns the private navigator, provider and detail selection on each return.
class NativeQualityPage extends StatefulWidget {
  const NativeQualityPage({super.key});
  @override
  State<NativeQualityPage> createState() => _NativeQualityPageState();
}

class _NativeQualityPageState extends State<NativeQualityPage>
    with WidgetsBindingObserver {
  bool _foreground = true;
  Object _visibility = Object();
  QualityController? _controller;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground = lifecycle == null || lifecycle == AppLifecycleState.resumed;
  }

  void _close() {
    final controller = _controller;
    _controller = null;
    if (controller != null) {
      controller.invalidate(notify: false);
      _visibility = Object();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final next = state == AppLifecycleState.resumed;
    if (_foreground == next) return;
    _close();
    setState(() => _foreground = next);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_foreground || !TickerMode.valuesOf(context).enabled) {
      _close();
      return const SizedBox.shrink();
    }
    return KeyedSubtree(
      key: ObjectKey(_visibility),
      child: NativePrivateWorkspace(
        requireManager: true,
        ownNavigator: true,
        builder: (_) => Consumer(
          builder: (context, ref, _) {
            final controller = ref.watch(
              qualityControllerProvider(_visibility),
            );
            _controller = controller;
            return controller == null
                ? const Center(
                    child: Text('Quality is unavailable for this session.'),
                  )
                : QualityWorkspaceView(
                    key: ObjectKey(controller),
                    controller: controller,
                  );
          },
        ),
      ),
    );
  }
}

class QualityWorkspaceView extends StatefulWidget {
  const QualityWorkspaceView({
    super.key,
    required this.controller,
    this.onOpenBrowser,
  });
  final QualityController controller;
  final VoidCallback? onOpenBrowser;
  @override
  State<QualityWorkspaceView> createState() => _QualityWorkspaceViewState();
}

class _QualityWorkspaceViewState extends State<QualityWorkspaceView> {
  QualityController get c => widget.controller;
  final _scroll = ScrollController();
  final _detailKey = GlobalKey();
  final _detailFocus = FocusNode(debugLabel: 'Quality evidence detail');
  int _selectionNavigation = 0;
  @override
  void initState() {
    super.initState();
    unawaited(c.refresh());
  }

  @override
  void didUpdateWidget(covariant QualityWorkspaceView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, c)) {
      _selectionNavigation++;
      _detailFocus.unfocus();
      unawaited(c.refresh());
    }
  }

  @override
  void dispose() {
    _selectionNavigation++;
    _scroll.dispose();
    _detailFocus.dispose();
    super.dispose();
  }

  void _select(String id, {required bool compact}) {
    final controller = c, section = c.section;
    if (!controller.available) return;
    controller.select(id);
    final navigation = ++_selectionNavigation;
    if (!compact || !controller.available || controller.selectedId != id) {
      return;
    }
    // The header and embedded inspector are one sliver child, so returning to
    // its start mounts the selected detail even after a late row was opened.
    if (_scroll.hasClients) _scroll.jumpTo(0);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      bool current() =>
          mounted &&
          identical(c, controller) &&
          navigation == _selectionNavigation &&
          controller.available &&
          controller.section == section &&
          controller.selectedId == id;
      if (!current()) return;
      final detailContext = _detailKey.currentContext;
      if (detailContext == null || !detailContext.mounted) return;
      unawaited(
        Scrollable.ensureVisible(
          detailContext,
          duration: Duration.zero,
          alignment: 0,
        ),
      );
      if (current() && detailContext.mounted) _detailFocus.requestFocus();
    });
  }

  @override
  Widget build(BuildContext context) => CallbackShortcuts(
    bindings: {
      const SingleActivator(LogicalKeyboardKey.keyR, meta: true): () =>
          unawaited(c.refresh()),
      const SingleActivator(LogicalKeyboardKey.keyR, control: true): () =>
          unawaited(c.refresh()),
      const SingleActivator(LogicalKeyboardKey.escape): () => c.select(null),
    },
    child: FocusScope(
      autofocus: true,
      child: FocusTraversalGroup(
        child: ListenableBuilder(
          listenable: c,
          builder: (context, _) {
            if (!c.available) {
              return Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(
                    c.authorizationDenied
                        ? 'Quality access expired. Sign in again to read current evidence.'
                        : 'Unlock and sign in to an authorized workspace to continue.',
                  ),
                ),
              );
            }
            return LayoutBuilder(
              builder: (context, constraints) {
                final desktop = usesMacosPresentation();
                final wide = desktop && constraints.maxWidth >= 980;
                final content = _content(context, wide: wide);
                final refresh = IconButton(
                  key: const Key('quality-refresh'),
                  tooltip: c.loading ? 'Refreshing Quality' : 'Refresh Quality',
                  onPressed: c.loading ? null : c.refresh,
                  icon: const Icon(Icons.refresh_rounded),
                );
                return desktop
                    ? MacosPageScaffold(
                        title: 'Quality',
                        description: 'Evaluation outcomes and release evidence',
                        icon: Icons.fact_check_outlined,
                        actions: [refresh],
                        inspector: wide
                            ? _QualityInspector(controller: c)
                            : null,
                        inspectorWidth: 350,
                        inspectorCollapseBelow: 980,
                        body: content,
                      )
                    : Scaffold(
                        appBar: AppBar(
                          title: const Text('Quality'),
                          actions: [refresh],
                        ),
                        body: content,
                      );
              },
            );
          },
        ),
      ),
    ),
  );

  Widget _content(BuildContext context, {required bool wide}) {
    final snapshot = c.evaluations.data, report = c.release.data;
    final source = c.selectedSource, lane = c.lane(source);
    return ListView(
      key: ValueKey((c, 'quality-workspace')),
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 32),
      children: [
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Evidence at a glance',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 6),
            const Text(
              'Review outcomes, background work and the server’s release assessment.',
            ),
            const SizedBox(height: 16),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                _Metric(
                  label: 'Recent runs',
                  value: snapshot == null
                      ? 'Not available'
                      : '${snapshot.stats.total}',
                  detail: 'Statistics cover up to 100 recent runs',
                ),
                _Metric(
                  label: 'Latest case pass rate',
                  value: snapshot?.stats.latestPassRate == null
                      ? 'Not measured'
                      : '${(snapshot!.stats.latestPassRate! * 100).toStringAsFixed(0)}%',
                  detail: 'Execution completion does not imply a pass',
                ),
                _Metric(
                  label: 'Release assessment',
                  value:
                      report?.status.label ??
                      (c.release.state == QualityLoadState.restricted
                          ? 'Restricted'
                          : 'Not available'),
                  detail: report == null
                      ? 'Administrator evidence is a separate source'
                      : report.approved
                      ? 'Server approval: approved'
                      : 'Server approval: withheld',
                ),
              ],
            ),
            const SizedBox(height: 20),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final section in QualitySection.values)
                  ChoiceChip(
                    key: ValueKey('quality-tab-${section.name}'),
                    label: Text(section.label),
                    selected: c.section == section,
                    onSelected: (_) => c.selectSection(section),
                  ),
              ],
            ),
            const SizedBox(height: 18),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        c.section.label,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _sectionDescription(c.section),
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: source == QualitySource.release
                      ? 'Refresh release evidence'
                      : 'Refresh evaluations',
                  onPressed: lane.state == QualityLoadState.loading
                      ? null
                      : () => c.refreshSource(source),
                  icon: const Icon(Icons.refresh_rounded, size: 20),
                ),
              ],
            ),
            const SizedBox(height: 12),
            if (lane.state == QualityLoadState.loading)
              Semantics(
                label: 'Reading ${c.section.label}',
                liveRegion: true,
                child: const LinearProgressIndicator(),
              ),
            if (lane.error != null)
              _Notice(
                message: lane.error!,
                icon: lane.state == QualityLoadState.restricted
                    ? Icons.lock_outline
                    : Icons.cloud_off_outlined,
                action: lane.state == QualityLoadState.failed
                    ? TextButton(
                        onPressed: () => c.refreshSource(source),
                        child: const Text('Retry this source'),
                      )
                    : null,
              ),
            if (lane.receivedAt != null) ...[
              Text(
                'Fetched ${_time(lane.receivedAt!)}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 12),
            ],
            if (!wide && c.selectedId != null) ...[
              Focus(
                key: _detailKey,
                focusNode: _detailFocus,
                child: Card(
                  child: _QualityInspector(controller: c, embedded: true),
                ),
              ),
              const SizedBox(height: 12),
            ],
          ],
        ),
        if (snapshot != null && c.section == QualitySection.runs) ...[
          if (snapshot.runs.isEmpty)
            const _Notice(
              message: 'No evaluation runs are present in this recent sample.',
              icon: Icons.fact_check_outlined,
            ),
          for (final run in snapshot.runs)
            _EvidenceRow(
              key: ValueKey('quality-run-${run.id}'),
              selected: c.selectedId == run.id,
              title: run.suite,
              detail:
                  '${run.summary.passed} passed · ${run.summary.failed} failed · ${run.summary.warnings} warnings',
              footer: 'Started ${_time(run.startedAt)}',
              status: run.status.label,
              attention:
                  run.status == QualityRunStatus.failed ||
                  run.summary.failed > 0,
              onTap: () => _select(run.id, compact: !wide),
            ),
        ],
        if (snapshot != null && c.section == QualitySection.jobs) ...[
          if (snapshot.jobs.isEmpty)
            const _Notice(
              message: 'No background evaluation jobs are present in this recent sample.',
              icon: Icons.work_history_outlined,
            ),
          for (final job in snapshot.jobs)
            _EvidenceRow(
              key: ValueKey('quality-job-${job.id}'),
              selected: c.selectedId == job.id,
              title: job.evalRunId == null
                  ? 'Evaluation job'
                  : 'Evaluation run ${job.evalRunId}',
              detail: 'Attempt ${job.attempt} of ${job.maxAttempts}',
              footer: 'Updated ${_time(job.updatedAt)}',
              status: job.quarantined ? 'Quarantined' : job.status.label,
              attention: job.status == QualityJobStatus.failed,
              onTap: () => _select(job.id, compact: !wide),
            ),
        ],
        if (snapshot != null && c.section == QualitySection.cases) ...[
          if (snapshot.cases.isEmpty)
            const _Notice(
              message: 'No cases are present in this catalog.',
              icon: Icons.inventory_2_outlined,
            ),
          for (final item in snapshot.cases)
            _EvidenceRow(
              key: ValueKey('quality-case-${item.id}'),
              selected: c.selectedId == item.id,
              title: item.name,
              detail: item.description,
              footer:
                  '${item.type.label} · Risk ${item.riskLevel} · ${item.writesToDatabase ? 'Writes to database' : 'No database writes'}',
              status: item.safetyMode.label,
              attention: item.requiresMutationApproval,
              onTap: () => _select(item.id, compact: !wide),
            ),
        ],
        if (report != null && c.section == QualitySection.release) ...[
          _Notice(
            icon: report.status == QualityReleaseStatus.blocked
                ? Icons.gpp_bad_outlined
                : Icons.policy_outlined,
            message:
                '${report.status.label} · Server approval ${report.approved ? 'approved' : 'withheld'}\nChecked ${_time(report.checkedAt)}\n${report.summary.passed} gates passed · ${report.summary.warnings} warnings · ${report.summary.failures} failures',
          ),
          const SizedBox(height: 6),
          Text(
            'The server may reuse evidence for 30 seconds. Fetch time and evidence check time are shown separately.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 12),
          for (final gate in report.gates)
            _EvidenceRow(
              key: ValueKey('quality-gate-${gate.id}'),
              selected: c.selectedId == gate.id,
              title: gate.name,
              detail: gate.summary,
              status: gate.status.label,
              attention: gate.status != QualityGateStatus.pass,
              onTap: () => _select(gate.id, compact: !wide),
            ),
        ],
        const SizedBox(height: 24),
        const Divider(),
        const SizedBox(height: 12),
        const Text(
          'Quality is read only here. Open the workspace for governed evaluation actions and full reports.',
        ),
        const SizedBox(height: 10),
        Align(
          alignment: Alignment.centerLeft,
          child: widget.onOpenBrowser == null
              ? const NativeWorkspaceBrowserButton(
                  path: '/app/evaluations',
                  label: 'Open Quality in browser',
                )
              : OutlinedButton.icon(
                  onPressed: c.available ? widget.onOpenBrowser : null,
                  icon: const Icon(Icons.open_in_browser_outlined, size: 18),
                  label: const Text('Open Quality in browser'),
                ),
        ),
      ],
    );
  }
}

String _sectionDescription(QualitySection section) => switch (section) {
  QualitySection.runs =>
    'The latest 20 runs. Outcomes are separate from execution status.',
  QualitySection.jobs =>
    'Recent evaluation jobs. A missing job does not establish completion.',
  QualitySection.cases =>
    'Case purpose, safety boundaries and production restrictions.',
  QualitySection.release =>
    'The server assessment and its individual evidence gates.',
};
String _time(DateTime value) =>
    '${value.toLocal().toIso8601String().split('.').first.replaceFirst('T', ' ')} local';

class _Metric extends StatelessWidget {
  const _Metric({
    required this.label,
    required this.value,
    required this.detail,
  });
  final String label, value, detail;
  @override
  Widget build(BuildContext context) => ConstrainedBox(
    constraints: const BoxConstraints(maxWidth: 300),
    child: Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: Theme.of(context).textTheme.labelLarge),
            const SizedBox(height: 8),
            Text(value, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 6),
            Text(detail, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
    ),
  );
}

class _Notice extends StatelessWidget {
  const _Notice({required this.message, required this.icon, this.action});
  final String message;
  final IconData icon;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(icon, size: 22),
                const SizedBox(width: 12),
                Expanded(child: Text(message)),
              ],
            ),
            if (action != null) ...[const SizedBox(height: 8), action!],
          ],
        ),
      ),
    ),
  );
}

class _EvidenceRow extends StatelessWidget {
  const _EvidenceRow({
    super.key,
    required this.title,
    required this.detail,
    required this.status,
    required this.selected,
    required this.attention,
    required this.onTap,
    this.footer,
  });
  final String title, detail, status;
  final String? footer;
  final bool selected, attention;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      color: selected ? scheme.primaryContainer : null,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Semantics(
          button: true,
          selected: selected,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Text(
                        title,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                    const SizedBox(width: 8),
                    const Icon(Icons.chevron_right_rounded, size: 20),
                  ],
                ),
                const SizedBox(height: 6),
                Text(detail),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 12,
                  runSpacing: 6,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(
                      status,
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        color: attention
                            ? scheme.error
                            : scheme.onSurfaceVariant,
                      ),
                    ),
                    if (footer != null)
                      Text(
                        footer!,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _QualityInspector extends StatelessWidget {
  const _QualityInspector({required this.controller, this.embedded = false});
  final QualityController controller;
  final bool embedded;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final c = controller, data = c.evaluations.data, report = c.release.data;
      final id = c.selectedId;
      final children = <Widget>[
        Row(
          children: [
            Expanded(
              child: Text(
                'Evidence detail',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            if (id != null)
              IconButton(
                tooltip: 'Close evidence detail',
                onPressed: () => c.select(null),
                icon: const Icon(Icons.close_rounded, size: 18),
              ),
          ],
        ),
        const SizedBox(height: 14),
      ];
      if (!c.available) {
        children.add(
          const Text('Evidence is no longer available to this account.'),
        );
      } else if (id == null) {
        children.add(
          const Text(
            'Select a run, job, case or release gate to inspect its evidence.',
          ),
        );
        if (c.section == QualitySection.release && report != null) {
          _releaseDetails(children, report);
        }
      } else {
        switch (c.section) {
          case QualitySection.runs:
            final row = data?.runs.where((item) => item.id == id).firstOrNull;
            if (row != null) {
              children.addAll([
                _Field('Suite', row.suite),
                _Field('Execution', row.status.label),
                _Field(
                  'Case outcomes',
                  '${row.summary.passed} passed · ${row.summary.failed} failed · ${row.summary.warnings} warnings / ${row.summary.total} cases',
                ),
                _Field(
                  'Case pass rate',
                  row.summary.passRate == null
                      ? 'Not measured'
                      : '${(row.summary.passRate! * 100).toStringAsFixed(1)}%',
                ),
                _Field(
                  'Average case latency',
                  '${row.summary.averageLatencyMs.toStringAsFixed(0)} ms',
                ),
                _Field(
                  'Estimated cost',
                  '\$${row.summary.estimatedCostUsd.toStringAsFixed(4)}',
                ),
                _Field('Started', _time(row.startedAt)),
                _Field(
                  'Completed',
                  row.completedAt == null
                      ? 'No completion recorded'
                      : _time(row.completedAt!),
                ),
                if (row.error != null) _Field('Run error', row.error!),
                _Field('Run identifier', row.id),
                const Text(
                  'Individual case results and full audit reports are available in the browser workspace.',
                ),
              ]);
            }
          case QualitySection.jobs:
            final row = data?.jobs.where((item) => item.id == id).firstOrNull;
            if (row != null) {
              children.addAll([
                _Field(
                  'Job status',
                  row.quarantined ? 'Failed · quarantined' : row.status.label,
                ),
                _Field('Attempts', '${row.attempt} of ${row.maxAttempts}'),
                _Field('Scheduled', _time(row.runAt)),
                _Field('Updated', _time(row.updatedAt)),
                _Field(
                  'Completed',
                  row.completedAt == null
                      ? 'No completion recorded'
                      : _time(row.completedAt!),
                ),
                if (row.lastError != null) _Field('Last error', row.lastError!),
                if (row.evalRunId != null)
                  _Field('Evaluation run', row.evalRunId!),
                _Field('Job identifier', row.id),
                if (row.quarantined)
                  const Text(
                    'Quarantined work requires operator review. This view does not retry the job.',
                  ),
              ]);
            }
          case QualitySection.cases:
            final row = data?.cases.where((item) => item.id == id).firstOrNull;
            if (row != null) {
              children.addAll([
                _Field('Case', row.name),
                _Field('Purpose', row.description),
                _Field('Type', row.type.label),
                _Field('Safety mode', row.safetyMode.label),
                _Field('Risk level', '${row.riskLevel}'),
                _Field('Database writes', row.writesToDatabase ? 'Yes' : 'No'),
                _Field('Cleanup policy', row.cleanup.label),
                _Field(
                  'Allowed by default in production',
                  row.allowedByDefault ? 'Yes' : 'No',
                ),
                _Field(
                  'Administrator required',
                  row.requiresAdmin ? 'Yes' : 'No',
                ),
                _Field(
                  'Mutation approval required',
                  row.requiresMutationApproval ? 'Yes' : 'No',
                ),
                for (final note in row.notes) _Field('Governance note', note),
                _Field('Case identifier', row.id),
              ]);
            }
          case QualitySection.release:
            final row = report?.gates
                .where((item) => item.id == id)
                .firstOrNull;
            if (row != null) {
              children.addAll([
                _Field('Gate', row.name),
                _Field('Assessment', row.status.label),
                _Field('Evidence summary', row.summary),
                _Field('Gate identifier', row.id),
              ]);
            }
            if (report != null) _releaseDetails(children, report);
        }
      }
      return embedded
          ? Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: children,
              ),
            )
          : ListView(
              key: ValueKey((c, 'quality-inspector', c.section, id)),
              padding: const EdgeInsets.all(20),
              children: children,
            );
    },
  );

  void _releaseDetails(List<Widget> children, QualityReleaseReport report) {
    final deploy = report.deployment;
    children.addAll([
      const SizedBox(height: 16),
      _Field('Server release assessment', report.status.label),
      _Field('Server approval', report.approved ? 'Approved' : 'Withheld'),
      _Field('Evidence checked', _time(report.checkedAt)),
      _Field('Deployment', '${deploy.provider} · ${deploy.environment}'),
      if (deploy.commitSha != null) _Field('Revision', deploy.commitSha!),
      if (deploy.branch != null) _Field('Branch', deploy.branch!),
      if (deploy.region != null) _Field('Region', deploy.region!),
      for (final reason in report.reasons) _Field('Blocking reason', reason),
      for (final warning in report.warnings) _Field('Warning', warning),
      for (final recommendation in report.recommendations)
        _Field('Recommendation', recommendation),
    ]);
  }
}

class _Field extends StatelessWidget {
  const _Field(this.label, this.value);
  final String label, value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: Theme.of(context).textTheme.labelMedium
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 4),
        SelectableText(value),
      ],
    ),
  );
}
