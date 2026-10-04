import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/macos/macos_page_scaffold.dart';
import '../../app/platform/macos_presentation.dart';
import '../../core/network/native_workspace_access.dart';
import 'security_contracts.dart';
import 'security_controller.dart';
import 'security_providers.dart';

/// A fresh visibility epoch also replaces the private navigator and selection.
class NativeSecurityPage extends StatefulWidget {
  const NativeSecurityPage({super.key});
  @override
  State<NativeSecurityPage> createState() => _NativeSecurityPageState();
}

class _NativeSecurityPageState extends State<NativeSecurityPage>
    with WidgetsBindingObserver {
  bool _foreground = true;
  Object _visibility = Object();
  SecurityController? _controller;
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
              securityControllerProvider(_visibility),
            );
            _controller = controller;
            return controller == null
                ? const Center(
                    child: Text('Security is unavailable for this session.'),
                  )
                : SecurityWorkspaceView(
                    key: ObjectKey(controller),
                    controller: controller,
                  );
          },
        ),
      ),
    );
  }
}

class SecurityWorkspaceView extends StatefulWidget {
  const SecurityWorkspaceView({
    super.key,
    required this.controller,
    this.onOpenBrowser,
  });
  final SecurityController controller;
  final VoidCallback? onOpenBrowser;
  @override
  State<SecurityWorkspaceView> createState() => _SecurityWorkspaceViewState();
}

class _SecurityWorkspaceViewState extends State<SecurityWorkspaceView> {
  SecurityController get c => widget.controller;
  final _scroll = ScrollController();
  final _detailKey = GlobalKey();
  final _detailFocus = FocusNode(debugLabel: 'Security evidence detail');
  int _selectionNavigation = 0;
  @override
  void initState() {
    super.initState();
    unawaited(c.refresh());
  }

  @override
  void didUpdateWidget(covariant SecurityWorkspaceView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, c)) {
      _selectionNavigation++;
      _detailFocus.unfocus();
      _query = '';
      _myRoleOnly = false;
      _attentionOnly = false;
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
                        ? 'Security access expired. Sign in again to read current evidence.'
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
                  key: const Key('security-refresh'),
                  tooltip: c.loading
                      ? 'Refreshing Security'
                      : 'Refresh Security',
                  onPressed: c.loading ? null : c.refresh,
                  icon: const Icon(Icons.refresh_rounded),
                );
                return desktop
                    ? MacosPageScaffold(
                        title: 'Security',
                        description: 'Access rules and storage policy evidence',
                        icon: Icons.security_outlined,
                        actions: [refresh],
                        inspector: wide
                            ? _SecurityInspector(controller: c)
                            : null,
                        inspectorWidth: 350,
                        inspectorCollapseBelow: 980,
                        body: _content(context, wide: wide),
                      )
                    : Scaffold(
                        appBar: AppBar(
                          title: const Text('Security'),
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

  String _query = '';
  bool _myRoleOnly = false, _attentionOnly = false;
  void _section(SecuritySection section) {
    if (!c.available || section == c.section) return;
    _selectionNavigation++;
    _detailFocus.unfocus();
    setState(() {
      _query = '';
      _myRoleOnly = false;
      _attentionOnly = false;
    });
    c.selectSection(section);
  }

  void _filter(VoidCallback change) {
    if (!c.available) return;
    _selectionNavigation++;
    setState(change);
    c.select(null);
  }

  bool _matches(String text) =>
      text.toLowerCase().contains(_query.trim().toLowerCase());

  Widget _content(BuildContext context, {required bool wide}) {
    final source = c.selectedSource, lane = c.lane(source);
    return ListView(
      key: ValueKey((c, 'security-workspace')),
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 32),
      children: [
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Security evidence',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 6),
            const Text(
              'Understand your access, recent decisions and the reported storage policies.',
            ),
            const SizedBox(height: 16),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                _Metric(
                  'Current role',
                  c.context.data == null
                      ? _sourceLabel(c.context.state)
                      : _label(c.context.data!.role.name),
                  'Exact authenticated native account',
                ),
                _Metric(
                  'Recent denied decisions',
                  c.audits.data == null
                      ? _sourceLabel(c.audits.state)
                      : '${c.audits.data!.denied}',
                  'Statistics sample up to 200 latest audit records',
                ),
                _Metric(
                  'Storage policy assessment',
                  c.isolation.data == null
                      ? _sourceLabel(c.isolation.state)
                      : _assessment(c.isolation.data!.assessment),
                  'Known storage catalog and policy checks',
                ),
              ],
            ),
            const SizedBox(height: 20),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final section in SecuritySection.values)
                  ChoiceChip(
                    key: ValueKey('security-tab-${section.name}'),
                    label: Text(section.label),
                    selected: c.section == section,
                    onSelected: (_) => _section(section),
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
                  onPressed: lane.state == SecurityLoadState.loading
                      ? null
                      : () => c.refreshSource(source),
                  icon: const Icon(Icons.refresh_rounded, size: 20),
                ),
              ],
            ),
            const SizedBox(height: 12),
            if (lane.state == SecurityLoadState.loading)
              Semantics(
                label: 'Reading ${c.section.label}',
                liveRegion: true,
                child: const LinearProgressIndicator(),
              ),
            if (lane.error != null)
              _Notice(
                lane.error!,
                icon: lane.state == SecurityLoadState.restricted
                    ? Icons.lock_outline
                    : Icons.cloud_off_outlined,
                action: lane.state == SecurityLoadState.failed
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
            if (lane.data != null &&
                c.section != SecuritySection.retention) ...[
              TextFormField(
                key: ValueKey((c, c.section, 'security-filter')),
                initialValue: _query,
                decoration: InputDecoration(
                  labelText: switch (c.section) {
                    SecuritySection.access => 'Find a role rule',
                    SecuritySection.audits => 'Find an audit record',
                    _ => 'Find a table',
                  },
                  prefixIcon: const Icon(Icons.search_rounded),
                ),
                onChanged: (value) => _filter(() => _query = value),
              ),
              const SizedBox(height: 8),
              if (c.section == SecuritySection.access)
                FilterChip(
                  key: const Key('security-my-role'),
                  label: const Text('My role'),
                  selected: _myRoleOnly,
                  onSelected: (value) => _filter(() => _myRoleOnly = value),
                ),
              if (c.section == SecuritySection.isolation)
                FilterChip(
                  key: const Key('security-attention-only'),
                  label: const Text('Needs attention'),
                  selected: _attentionOnly,
                  onSelected: (value) => _filter(() => _attentionOnly = value),
                ),
              const SizedBox(height: 12),
            ],
            if (!wide && c.selectedId != null) ...[
              Focus(
                key: _detailKey,
                focusNode: _detailFocus,
                child: Card(
                  child: _SecurityInspector(controller: c, embedded: true),
                ),
              ),
              const SizedBox(height: 12),
            ],
          ],
        ),
        ..._rows(compact: !wide),
        const SizedBox(height: 24),
        const Text(
          'Open the browser workspace for signed audit download and retention review.',
        ),
        const SizedBox(height: 10),
        Align(
          alignment: Alignment.centerLeft,
          child: widget.onOpenBrowser == null
              ? const NativeWorkspaceBrowserButton(
                  path: '/app/security',
                  label: 'Open security in browser',
                )
              : OutlinedButton.icon(
                  onPressed: widget.onOpenBrowser,
                  icon: const Icon(Icons.open_in_browser_outlined, size: 18),
                  label: const Text('Open security in browser'),
                ),
        ),
      ],
    );
  }

  List<Widget> _rows({required bool compact}) {
    switch (c.section) {
      case SecuritySection.access:
        final data = c.context.data;
        if (data == null) return [];
        final rows = data.rules
            .where(
              (row) =>
                  (!_myRoleOnly || row.roles.contains(data.role)) &&
                  _matches(
                    '${row.action} ${row.description} ${row.roles.map((role) => role.name).join(' ')}',
                  ),
            )
            .toList(growable: false);
        return [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _Field('Tenant', data.tenantId),
                  _Field('Actor', data.actorId),
                  _Field('Canonical user', data.userId),
                  Text('Native bearer identity · ${_label(data.role.name)}'),
                ],
              ),
            ),
          ),
          const _Notice(
            'Role rules explain the reported policy. Each request still requires current authorization.',
            icon: Icons.info_outline,
          ),
          if (rows.isEmpty)
            const _Notice(
              'No role rules match this view.',
              icon: Icons.rule_outlined,
            ),
          for (final row in rows)
            _EvidenceRow(
              key: ValueKey('security-rule-${row.action}'),
              title: row.action,
              detail: row.description,
              status:
                  'Allowed roles: ${row.roles.map((role) => _label(role.name)).join(', ')}',
              selected: c.selectedId == row.action,
              onTap: () => _select(row.action, compact: compact),
            ),
        ];
      case SecuritySection.audits:
        final data = c.audits.data;
        if (data == null) return [];
        final rows = data.rows
            .where(
              (row) => _matches(
                '${row.id} ${row.action} ${row.actorId} ${row.resourceType} ${row.resourceId ?? ''} ${row.decision.name}',
              ),
            )
            .toList(growable: false);
        return [
          _Notice(
            '${data.allowed} allowed · ${data.denied} denied across ${data.total} sampled records. Statistics cover up to 200 latest records; the list below covers up to 50.',
            icon: Icons.history_rounded,
          ),
          const Text(
            'Past decisions describe individual requests and do not grant current access. This list is not a signed or complete audit export.',
          ),
          const SizedBox(height: 12),
          if (rows.isEmpty)
            _Notice(
              data.rows.isEmpty
                  ? 'No recent tenant audit records are available.'
                  : 'No audit records match this view.',
              icon: Icons.receipt_long_outlined,
            ),
          for (final row in rows)
            _EvidenceRow(
              key: ValueKey('security-audit-${row.id}'),
              title: row.action,
              detail:
                  '${row.actorId} · ${_label(row.actorRole.name)}\n${row.resourceType}',
              status: row.decision == SecurityDecision.allow
                  ? 'Allowed'
                  : 'Denied',
              attention: row.decision == SecurityDecision.deny,
              footer: _time(row.createdAt),
              selected: c.selectedId == row.id,
              onTap: () => _select(row.id, compact: compact),
            ),
        ];
      case SecuritySection.isolation:
        final data = c.isolation.data;
        if (data == null) return [];
        final rows = data.tables
            .where(
              (row) =>
                  (!_attentionOnly || row.status == SecurityCheck.fail) &&
                  _matches(row.name),
            )
            .toList(growable: false);
        final unclassified = data.unclassified
            .where(_matches)
            .toList(growable: false);
        return [
          Text('Server checked ${_time(data.checkedAt)}'),
          const SizedBox(height: 8),
          _Notice(
            '${data.protected} of ${data.expected} expected tables pass. ${data.failing} fail; ${data.unclassified.length} additional tables are unclassified. Child tables: ${data.protectedChildren} passing of ${data.expectedChildren} expected.',
            icon: Icons.storage_outlined,
          ),
          Text(
            'Backend: ${_storage(data.backend)} · Database ${data.databaseConfigured ? 'configured' : 'not configured'}',
          ),
          const SizedBox(height: 8),
          const Text(
            'This storage policy assessment covers the known catalog. It does not certify every application path.',
          ),
          const SizedBox(height: 12),
          if (data.latestEval case final evaluation?)
            _EvidenceRow(
              key: const Key('security-isolation-evaluation'),
              title: 'Latest isolation evaluation',
              detail:
                  'Run ${_label(evaluation.runStatus.name)} · Case ${_result(evaluation.resultStatus)}',
              status: 'Created ${_time(evaluation.createdAt)}',
              selected: c.selectedId == 'evaluation',
              onTap: () => _select('evaluation', compact: compact),
            )
          else
            const _Notice(
              'Latest isolation evaluation: Not available.',
              icon: Icons.fact_check_outlined,
            ),
          for (final recommendation in data.recommendations)
            _Notice(recommendation, icon: Icons.info_outline),
          if (rows.isEmpty && unclassified.isEmpty)
            const _Notice(
              'No tables match this view.',
              icon: Icons.filter_alt_outlined,
            ),
          for (final name in unclassified)
            _EvidenceRow(
              key: ValueKey('security-unclassified-$name'),
              title: name,
              detail: 'No reported tenant-isolation classification',
              status: 'Unclassified',
              attention: true,
              selected: c.selectedId == 'unclassified:$name',
              onTap: () => _select('unclassified:$name', compact: compact),
            ),
          for (final row in rows)
            _EvidenceRow(
              key: ValueKey('security-table-${row.name}'),
              title: row.name,
              detail: '${_label(row.category.name)} table',
              status: row.status == SecurityCheck.pass
                  ? 'Policy checks pass'
                  : 'Needs attention',
              attention: row.status == SecurityCheck.fail,
              selected: c.selectedId == 'table:${row.name}',
              onTap: () => _select('table:${row.name}', compact: compact),
            ),
        ];
      case SecuritySection.retention:
        final data = c.retention.data;
        if (data == null) return [];
        return [
          _Notice(
            'Backend: ${data.backend == SecurityRetentionBackend.postgres ? 'Postgres' : 'Bounded local storage'}. Automatic sweep: ${data.automaticSweep ? 'configured' : 'not configured'}.',
            icon: Icons.schedule_outlined,
          ),
          const Text(
            'These are configured retention windows. This response provides no last sweep time, deletion count or completion receipt.',
          ),
          const SizedBox(height: 12),
          for (final group
              in SecurityRetentionWindow.values
                  .map((window) => window.group)
                  .toSet()) ...[
            Padding(
              padding: const EdgeInsets.only(top: 12, bottom: 8),
              child: Text(group),
            ),
            for (final window in SecurityRetentionWindow.values.where(
              (window) => window.group == group,
            ))
              _EvidenceRow(
                key: ValueKey('security-retention-${window.name}'),
                title: window.label,
                detail: group,
                status: '${data.days[window]} days',
                selected: c.selectedId == window.name,
                onTap: () => _select(window.name, compact: compact),
              ),
          ],
        ];
    }
  }
}

String _label(String value) => '${value[0].toUpperCase()}${value.substring(1)}';
String _assessment(SecurityAssessment value) => switch (value) {
  SecurityAssessment.passing => 'Passing',
  SecurityAssessment.degraded => 'Degraded',
  SecurityAssessment.notConfigured => 'Not configured',
};
String _result(SecurityResultStatus value) => switch (value) {
  SecurityResultStatus.pass => 'Pass',
  SecurityResultStatus.fail => 'Fail',
  SecurityResultStatus.warn => 'Warning',
};
String _storage(SecurityStorage value) => switch (value) {
  SecurityStorage.postgres => 'Postgres',
  SecurityStorage.file => 'File storage',
  SecurityStorage.ephemeral => 'Ephemeral storage',
};
String _time(DateTime value) {
  final local = value.toLocal();
  String pad(int part) => part.toString().padLeft(2, '0');
  return '${local.year}-${pad(local.month)}-${pad(local.day)} ${pad(local.hour)}:${pad(local.minute)}';
}

String _sourceLabel(SecurityLoadState state) => switch (state) {
  SecurityLoadState.loading => 'Reading…',
  SecurityLoadState.restricted => 'Restricted',
  _ => 'Unavailable',
};
String _description(SecuritySection section) => switch (section) {
  SecuritySection.access =>
    'Your authenticated identity and the server’s declared role rules.',
  SecuritySection.audits =>
    'Recent decisions for this tenant, including other authorized actors.',
  SecuritySection.isolation =>
    'Reported table protections, configuration and dated evaluation evidence.',
  SecuritySection.retention =>
    'All 18 configured retention windows, expressed in days.',
};

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

class _SecurityInspector extends StatelessWidget {
  const _SecurityInspector({required this.controller, this.embedded = false});
  final SecurityController controller;
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
          'Select a role rule, audit record, table or retention window to inspect its evidence.',
        ),
      );
    } else {
      switch (c.section) {
        case SecuritySection.access:
          final row = c.context.data?.rules
              .where((row) => row.action == id)
              .firstOrNull;
          if (row != null) {
            children.addAll([
              _Field('Action', row.action),
              _Field('Policy description', row.description),
              _Field(
                'Allowed roles',
                row.roles.map((role) => _label(role.name)).join(', '),
              ),
              const Text(
                'This rule is explanatory policy evidence, not an executable grant.',
              ),
            ]);
          }
        case SecuritySection.audits:
          final row = c.audits.data?.rows
              .where((row) => row.id == id)
              .firstOrNull;
          if (row != null) {
            children.addAll([
              _Field(
                'Decision',
                row.decision == SecurityDecision.allow ? 'Allowed' : 'Denied',
              ),
              _Field('Action', row.action),
              _Field('Actor', row.actorId),
              _Field('Actor role', _label(row.actorRole.name)),
              _Field('Tenant', row.tenantId),
              _Field('Resource type', row.resourceType),
              if (row.resourceId != null)
                _Field('Resource identifier', row.resourceId!),
              if (row.reason != null) _Field('Recorded reason', row.reason!),
              if (row.riskLevel != null)
                _Field('Risk level', '${row.riskLevel}'),
              _Field('Created', _time(row.createdAt)),
              _Field('Audit identifier', row.id),
            ]);
          }
        case SecuritySection.isolation:
          final data = c.isolation.data;
          if (data == null) break;
          if (id == 'evaluation') {
            final evaluation = data.latestEval;
            if (evaluation != null) {
              children.addAll([
                _Field('Evaluation run', evaluation.runId),
                _Field('Execution status', _label(evaluation.runStatus.name)),
                _Field('Case result', _result(evaluation.resultStatus)),
                _Field('Score', '${evaluation.score}'),
                _Field('Created', _time(evaluation.createdAt)),
                if (evaluation.completedAt != null)
                  _Field('Completed', _time(evaluation.completedAt!)),
                _Field('Current catalog checked', _time(data.checkedAt)),
                const Text(
                  'Completed execution does not imply a passing case. Evaluation evidence may predate the current catalog assessment.',
                ),
              ]);
            }
          } else if (id.startsWith('unclassified:')) {
            final name = id.substring('unclassified:'.length);
            if (data.unclassified.contains(name)) {
              children.addAll([
                _Field('Table', name),
                const _Field('Classification', 'Unclassified'),
                const Text(
                  'This table is outside the reported expected catalog and contributes to the degraded assessment.',
                ),
              ]);
            }
          } else {
            final row = data.tables
                .where((row) => 'table:${row.name}' == id)
                .firstOrNull;
            if (row != null) {
              children.addAll([
                _Field('Table', row.name),
                _Field('Category', _label(row.category.name)),
                _Field(
                  'Assessment',
                  row.status == SecurityCheck.pass
                      ? 'Policy checks pass'
                      : 'Needs attention',
                ),
                _Field('Table exists', _yes(row.exists)),
                _Field('Tenant column', _yes(row.tenantColumn)),
                _Field('Row security enabled', _yes(row.rlsEnabled)),
                _Field('Row security forced', _yes(row.forceRls)),
                _Field('Expected policy present', _yes(row.policyPresent)),
                _Field('Server checked', _time(data.checkedAt)),
              ]);
            }
          }
        case SecuritySection.retention:
          final window = SecurityRetentionWindow.values
                  .where((window) => window.name == id)
                  .firstOrNull,
              data = c.retention.data;
          if (window != null && data != null) {
            children.addAll([
              _Field('Retention window', window.label),
              _Field('Category', window.group),
              _Field('Configured duration', '${data.days[window]} days'),
              _Field('Policy field', window.name),
              const Text(
                'The reported window does not establish that records were deleted or a sweep completed.',
              ),
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
            key: ValueKey((c, 'security-inspector', c.section, id)),
            padding: const EdgeInsets.all(20),
            children: children,
          );
  }
}

String _yes(bool value) => value ? 'Yes' : 'No';

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
