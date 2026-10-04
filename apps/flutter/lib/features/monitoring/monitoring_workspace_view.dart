import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/platform/macos_presentation.dart';
import '../../core/network/native_workspace_access.dart';
import 'monitoring_contracts.dart';
import 'monitoring_controller.dart';
import 'monitoring_providers.dart';

/// A fresh visibility epoch also replaces the private navigator and selection.
class NativeMonitoringPage extends StatefulWidget {
  const NativeMonitoringPage({super.key});
  @override
  State<NativeMonitoringPage> createState() => _NativeMonitoringPageState();
}

class _NativeMonitoringPageState extends State<NativeMonitoringPage>
    with WidgetsBindingObserver {
  bool _foreground = true;
  Object _visibility = Object();
  MonitoringController? _controller;
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
              monitoringControllerProvider(_visibility),
            );
            _controller = controller;
            return controller == null
                ? const Center(
                    child: Text('Monitoring is unavailable for this session.'),
                  )
                : MonitoringWorkspaceView(
                    key: ObjectKey(controller),
                    controller: controller,
                  );
          },
        ),
      ),
    );
  }
}

class MonitoringWorkspaceView extends StatefulWidget {
  const MonitoringWorkspaceView({
    super.key,
    required this.controller,
    this.onOpenBrowser,
  });
  final MonitoringController controller;
  final VoidCallback? onOpenBrowser;
  @override
  State<MonitoringWorkspaceView> createState() =>
      _MonitoringWorkspaceViewState();
}

class _MonitoringWorkspaceViewState extends State<MonitoringWorkspaceView> {
  MonitoringController get c => widget.controller;
  final _scroll = ScrollController();
  final _detailKey = GlobalKey();
  final _detailFocus = FocusNode(debugLabel: 'Monitoring evidence detail');
  int _selectionNavigation = 0;
  @override
  void initState() {
    super.initState();
    unawaited(c.refresh());
  }

  @override
  void didUpdateWidget(covariant MonitoringWorkspaceView oldWidget) {
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
    // Header and compact inspector share a sliver child so even a late row
    // selection can mount the detail before scrolling it into view.
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
                        ? 'Monitoring access expired. Sign in again to read current evidence.'
                        : 'Unlock and sign in to an authorized workspace to continue.',
                  ),
                ),
              );
            }
            return LayoutBuilder(
              builder: (context, constraints) {
                final desktop = usesMacosPresentation(),
                    wide = desktop && constraints.maxWidth >= 980;
                final refresh = IconButton(
                  key: const Key('monitoring-refresh'),
                  tooltip: c.loading
                      ? 'Refreshing Monitoring'
                      : 'Refresh Monitoring',
                  onPressed: c.loading ? null : c.refresh,
                  icon: const Icon(Icons.refresh_rounded),
                );
                return desktop
                    ? MacosPageScaffold(
                        title: 'Monitoring',
                        description: 'Service health and operational evidence',
                        icon: Icons.monitor_heart_outlined,
                        actions: [refresh],
                        inspector: wide
                            ? _MonitoringInspector(controller: c)
                            : null,
                        inspectorWidth: 350,
                        inspectorCollapseBelow: 980,
                        body: _content(context, wide: wide),
                      )
                    : Scaffold(
                        appBar: AppBar(
                          title: const Text('Monitoring'),
                          actions: [refresh],
                        ),
                        body: _content(context, wide: wide),
                      );
              },
            );
          },
        ),
      ),
    ),
  );

  Widget _content(BuildContext context, {required bool wide}) {
    final source = c.selectedSource, lane = c.lane(source);
    return ListView(
      key: ValueKey((c, 'monitoring-workspace')),
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 32),
      children: [
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Operations at a glance',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 6),
            const Text(
              'Read current health, measurements and delivery outcomes in one place.',
            ),
            const SizedBox(height: 16),
            _HealthStrip(controller: c),
            const SizedBox(height: 12),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                _Metric(
                  'SLO assessment',
                  c.slo.data?.assessment ?? _sourceLabel(c.slo.state),
                  'Measurements cover the last 24 hours',
                ),
                _Metric(
                  'Active incidents',
                  c.incidents.data == null
                      ? _sourceLabel(c.incidents.state)
                      : '${c.incidents.data!.active}',
                  'Statistics sample up to 500 recent incidents',
                ),
                _Metric(
                  'Failed deliveries',
                  c.alerts.data == null
                      ? _sourceLabel(c.alerts.state)
                      : '${c.alerts.data!.failed}',
                  'Statistics sample up to 200 recent deliveries',
                ),
              ],
            ),
            const SizedBox(height: 20),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final section in MonitoringSection.values)
                  ChoiceChip(
                    key: ValueKey('monitoring-tab-${section.name}'),
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
                        _description(c.section),
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: 'Refresh ${c.section.label.toLowerCase()}',
                  onPressed: lane.state == MonitoringLoadState.loading
                      ? null
                      : () => c.refreshSource(source),
                  icon: const Icon(Icons.refresh_rounded, size: 20),
                ),
              ],
            ),
            const SizedBox(height: 12),
            if (lane.state == MonitoringLoadState.loading)
              Semantics(
                label: 'Reading ${c.section.label}',
                liveRegion: true,
                child: const LinearProgressIndicator(),
              ),
            if (lane.error != null)
              _Notice(
                lane.error!,
                icon: lane.state == MonitoringLoadState.restricted
                    ? Icons.lock_outline
                    : Icons.cloud_off_outlined,
                action: lane.state == MonitoringLoadState.failed
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
                  child: _MonitoringInspector(controller: c, embedded: true),
                ),
              ),
              const SizedBox(height: 12),
            ],
          ],
        ),
        ..._rows(compact: !wide),
        const SizedBox(height: 24),
        const Text(
          'Open the browser workspace to run the SLO monitor or record an operator marker.',
        ),
        const SizedBox(height: 10),
        Align(
          alignment: Alignment.centerLeft,
          child: widget.onOpenBrowser == null
              ? const NativeWorkspaceBrowserButton(
                  path: '/app/observability',
                  label: 'Open monitoring in browser',
                )
              : OutlinedButton.icon(
                  onPressed: widget.onOpenBrowser,
                  icon: const Icon(Icons.open_in_browser_outlined, size: 18),
                  label: const Text('Open monitoring in browser'),
                ),
        ),
      ],
    );
  }

  List<Widget> _rows({required bool compact}) {
    switch (c.section) {
      case MonitoringSection.slo:
        final data = c.slo.data;
        if (data == null) return [];
        return [
          Text('Server checked ${_time(data.checkedAt)}'),
          const SizedBox(height: 10),
          if (data.evaluations.isEmpty)
            const _Notice(
              'No enabled SLO policies are available. This is not an all-clear assessment.',
              icon: Icons.straighten_outlined,
            ),
          if (data.insufficient > 0)
            _Notice(
              '${data.insufficient} policies are awaiting enough samples to be judged.',
              icon: Icons.hourglass_empty_rounded,
            ),
          if (data.unmeasured > 0)
            _Notice(
              '${data.unmeasured} policies have no eligible measurements in this window.',
              icon: Icons.straighten_outlined,
            ),
          for (final row in data.evaluations)
            _EvidenceRow(
              key: ValueKey('monitoring-slo-${row.policy.id}'),
              selected: c.selectedId == row.policy.id,
              title: row.policy.name,
              detail: row.insufficient
                  ? '${row.samples} of ${row.minimumSamples} required samples'
                  : !data.isMeasured(row)
                  ? 'No eligible events in this window'
                  : row.policy.format(row.value),
              status: row.insufficient
                  ? 'Awaiting samples'
                  : !data.isMeasured(row)
                  ? 'Not measured'
                  : row.breached
                  ? '${_label(row.severity!.name)} breach'
                  : 'Within threshold',
              attention: data.isMeasured(row) && row.breached,
              footer: row.policy.description,
              onTap: () => _select(row.policy.id, compact: compact),
            ),
        ];
      case MonitoringSection.incidents:
        final data = c.incidents.data;
        if (data == null) return [];
        return [
          if (data.rows.isEmpty)
            const _Notice(
              'No active incidents were returned in this read.',
              icon: Icons.notifications_none_rounded,
            ),
          for (final row in data.rows)
            _EvidenceRow(
              key: ValueKey('monitoring-incident-${row.id}'),
              selected: c.selectedId == row.id,
              title: row.title,
              detail: row.message,
              status:
                  '${_label(row.severity.name)} · ${_label(row.status.name)}',
              attention: row.severity == MonitoringSeverity.critical,
              footer:
                  '${row.occurrences} observations · Last seen ${_time(row.lastSeenAt)}',
              onTap: () => _select(row.id, compact: compact),
            ),
        ];
      case MonitoringSection.alerts:
        final data = c.alerts.data;
        if (data == null) return [];
        return [
          Text(
            '${data.queued} queued · ${data.running} running · ${data.delivered} delivered · ${data.failed} failed · ${data.skipped} skipped',
          ),
          const SizedBox(height: 10),
          if (data.rows.isEmpty)
            const _Notice(
              'No alert deliveries were returned in this recent sample.',
              icon: Icons.outgoing_mail,
            ),
          for (final row in data.rows)
            _EvidenceRow(
              key: ValueKey('monitoring-alert-${row.id}'),
              selected: c.selectedId == row.id,
              title: '${_label(row.channel.name)} · ${row.targetId}',
              detail: 'Attempt ${row.attempt} of ${row.maxAttempts}',
              status: _label(row.status.name),
              attention: row.status == MonitoringAlertStatus.failed,
              footer: 'Updated ${_time(row.updatedAt)}',
              onTap: () => _select(row.id, compact: compact),
            ),
        ];
      case MonitoringSection.timeline:
        final data = c.timeline.data;
        if (data == null) return [];
        return [
          Text(
            '${data.total} events · ${data.errors} errors · ${data.warnings} warnings in the last 24 hours',
          ),
          const SizedBox(height: 10),
          if (data.rows.isEmpty)
            const _Notice(
              'No runtime events were returned in this recent sample.',
              icon: Icons.timeline_rounded,
            ),
          for (final row in data.rows)
            _EvidenceRow(
              key: ValueKey('monitoring-event-${row.id}'),
              selected: c.selectedId == row.id,
              title: row.action,
              detail: row.message,
              status:
                  '${_label(row.level.name)} · ${_label(row.category.name)}',
              attention: row.level == MonitoringEventLevel.error,
              footer: _time(row.createdAt),
              onTap: () => _select(row.id, compact: compact),
            ),
        ];
    }
  }
}

String _label(String value) => value == 'warn'
    ? 'Warning'
    : '${value[0].toUpperCase()}${value.substring(1)}';
String _time(DateTime value) {
  final local = value.toLocal();
  String pad(int part) => part.toString().padLeft(2, '0');
  return '${local.year}-${pad(local.month)}-${pad(local.day)} ${pad(local.hour)}:${pad(local.minute)}';
}

String _sourceLabel(MonitoringLoadState state) => switch (state) {
  MonitoringLoadState.loading => 'Reading…',
  MonitoringLoadState.restricted => 'Restricted',
  _ => 'Unavailable',
};
String _description(MonitoringSection section) => switch (section) {
  MonitoringSection.slo =>
    'Thresholds and sample sufficiency over the last 24 hours.',
  MonitoringSection.incidents =>
    'Up to 25 active incidents, ordered by most recent update.',
  MonitoringSection.alerts =>
    'Up to 50 recent deliveries. Queued and skipped are separate outcomes.',
  MonitoringSection.timeline =>
    'Up to 50 recent runtime events. Statistics cover the last 24 hours.',
};

class _HealthStrip extends StatelessWidget {
  const _HealthStrip({required this.controller});
  final MonitoringController controller;
  @override
  Widget build(BuildContext context) {
    final c = controller,
        lane = c.health,
        data = lane.data,
        scheme = Theme.of(context).colorScheme;
    final attention =
        data != null && data.status != MonitoringHealthStatus.healthy;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  Icons.monitor_heart_outlined,
                  color: attention ? scheme.error : scheme.primary,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Service health',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        data == null
                            ? _sourceLabel(lane.state)
                            : _label(data.status.name),
                        style: TextStyle(
                          fontWeight: FontWeight.w600,
                          color: attention ? scheme.error : scheme.onSurface,
                        ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: 'Refresh service health',
                  onPressed: lane.state == MonitoringLoadState.loading
                      ? null
                      : () => c.refreshSource(MonitoringSource.health),
                  icon: const Icon(Icons.refresh_rounded, size: 20),
                ),
              ],
            ),
            if (lane.state == MonitoringLoadState.loading)
              const LinearProgressIndicator(),
            if (lane.error != null) ...[
              const SizedBox(height: 8),
              Text(lane.error!),
            ],
            if (data != null) ...[
              const SizedBox(height: 12),
              Text(
                'Checked ${_time(data.checkedAt)}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 16,
                runSpacing: 6,
                children: [
                  Text(
                    'Database: ${data.databaseConfigured ? 'configured' : 'missing configuration'}',
                  ),
                  Text(
                    'OpenAI: ${data.openAiConfigured ? 'configured' : 'missing configuration'}',
                  ),
                  Text(
                    'Scheduler: ${data.cronSecretConfigured ? 'configured' : 'missing configuration'}',
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                'Configuration indicators do not establish provider reachability.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              if (data.revision != null) ...[
                const SizedBox(height: 6),
                Text(
                  'Revision ${data.revision}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

class _Metric extends StatelessWidget {
  const _Metric(this.label, this.value, this.detail);
  final String label, value, detail;
  @override
  Widget build(BuildContext context) => ConstrainedBox(
    constraints: const BoxConstraints(maxWidth: 260),
    child: Card(
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
  const _Notice(this.message, {required this.icon, this.action});
  final String message;
  final IconData icon;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 20),
            const SizedBox(width: 10),
            Expanded(child: Text(message)),
          ],
        ),
        if (action != null)
          Padding(padding: const EdgeInsets.only(top: 8), child: action),
      ],
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
    required this.onTap,
    this.attention = false,
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
                Text(
                  status,
                  style: TextStyle(
                    fontWeight: FontWeight.w600,
                    color: attention ? scheme.error : scheme.onSurfaceVariant,
                  ),
                ),
                if (footer != null) ...[
                  const SizedBox(height: 6),
                  Text(footer!, style: Theme.of(context).textTheme.bodySmall),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _MonitoringInspector extends StatelessWidget {
  const _MonitoringInspector({required this.controller, this.embedded = false});
  final MonitoringController controller;
  final bool embedded;
  @override
  Widget build(BuildContext context) {
    final c = controller, id = c.selectedId;
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
          'Select a measurement, incident, delivery or runtime event to inspect its evidence.',
        ),
      );
    } else {
      switch (c.section) {
        case MonitoringSection.slo:
          final row = c.slo.data?.evaluations
              .where((row) => row.policy.id == id)
              .firstOrNull;
          if (row != null) {
            children.addAll([
              _Field('Policy', row.policy.name),
              _Field('Purpose', row.policy.description),
              _Field(
                'Assessment',
                row.insufficient
                    ? 'Awaiting samples'
                    : !c.slo.data!.isMeasured(row)
                    ? 'Not measured'
                    : row.breached
                    ? '${_label(row.severity!.name)} breach'
                    : 'Within threshold',
              ),
              _Field(
                !c.slo.data!.isMeasured(row)
                    ? 'Observed value · not judged'
                    : 'Measured value',
                row.policy.format(row.value),
              ),
              if (row.insufficient)
                _Field(
                  'Samples',
                  '${row.samples} of ${row.minimumSamples} required',
                ),
              if (row.policy.sampled && !row.insufficient)
                _Field(
                  'Samples',
                  '${c.slo.data!.sampleCounts[row.policy.id]} · minimum ${row.policy.minimumSamples}',
                ),
              if (!row.policy.sampled)
                _Field(
                  'Eligible events',
                  '${c.slo.data!.eligibleEventCount} of ${c.slo.data!.eventCount} total events',
                ),
              _Field(
                'Warning threshold',
                '${row.policy.comparator.symbol} ${row.policy.format(row.policy.warningThreshold)}',
              ),
              _Field(
                'Critical threshold',
                '${row.policy.comparator.symbol} ${row.policy.format(row.policy.criticalThreshold)}',
              ),
              _Field('Component', row.policy.component),
              _Field('Server explanation', row.message),
              _Field('Policy identifier', row.policy.id),
            ]);
          }
        case MonitoringSection.incidents:
          final row = c.incidents.data?.rows
              .where((row) => row.id == id)
              .firstOrNull;
          if (row != null) {
            children.addAll([
              _Field('Incident', row.title),
              _Field('Observation', row.message),
              _Field('Severity', _label(row.severity.name)),
              _Field('Status', _label(row.status.name)),
              _Field('Component', row.component),
              _Field('Occurrences', '${row.occurrences}'),
              _Field('First seen', _time(row.firstSeenAt)),
              _Field('Last seen', _time(row.lastSeenAt)),
              if (row.acknowledgedAt != null)
                _Field('Acknowledged', _time(row.acknowledgedAt!)),
              _Field('Incident identifier', row.id),
            ]);
          }
        case MonitoringSection.alerts:
          final row = c.alerts.data?.rows
              .where((row) => row.id == id)
              .firstOrNull;
          if (row != null) {
            children.addAll([
              _Field('Delivery status', _label(row.status.name)),
              _Field('Channel', _label(row.channel.name)),
              _Field('Target', row.targetId),
              _Field('Severity', _label(row.severity.name)),
              _Field('Attempts', '${row.attempt} of ${row.maxAttempts}'),
              _Field('Scheduled', _time(row.runAt)),
              _Field('Updated', _time(row.updatedAt)),
              _Field(
                'Delivered',
                row.deliveredAt == null
                    ? 'No delivery timestamp recorded'
                    : _time(row.deliveredAt!),
              ),
              _Field('Incident identifier', row.incidentId),
              _Field('Delivery identifier', row.id),
              if (row.status == MonitoringAlertStatus.skipped)
                const Text(
                  'Skipped delivery does not establish that the alert reached its target.',
                ),
            ]);
          }
        case MonitoringSection.timeline:
          final row = c.timeline.data?.rows
              .where((row) => row.id == id)
              .firstOrNull;
          if (row != null) {
            children.addAll([
              _Field('Action', row.action),
              _Field('Observation', row.message),
              _Field('Level', _label(row.level.name)),
              _Field('Category', _label(row.category.name)),
              _Field('Recorded', _time(row.createdAt)),
              if (row.route != null) _Field('Route', row.route!),
              if (row.method != null) _Field('Method', row.method!),
              if (row.statusCode != null)
                _Field('HTTP status', '${row.statusCode}'),
              if (row.durationMs != null)
                _Field('Duration', '${row.durationMs!.toStringAsFixed(1)} ms'),
              _Field('Correlation identifier', row.correlationId),
              _Field('Event identifier', row.id),
            ]);
          }
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
            key: ValueKey((c, 'monitoring-inspector', c.section, id)),
            padding: const EdgeInsets.all(20),
            children: children,
          );
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
