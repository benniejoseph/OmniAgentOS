import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/native_workspace_access.dart';
import 'connector_contracts.dart';
import 'connector_control_contracts.dart';
import 'connector_github_upgrade_contracts.dart';
import 'connector_github_upgrade_controller.dart';
import 'connector_github_upgrade_providers.dart';

class NativeConnectorGithubUpgradeWorkspace extends StatelessWidget {
  const NativeConnectorGithubUpgradeWorkspace({super.key, this.connectorId});
  final String? connectorId;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('GitHub MCP upgrade')),
    body: _GithubUpgradeRouteVisibility(
      current: ModalRoute.isCurrentOf(context) ?? true,
      child: NativePrivateWorkspace(
        ownNavigator: true,
        builder: (_) => Consumer(
          builder: (panelContext, ref, _) {
            final controller = ref.watch(
              connectorGithubUpgradeControllerProvider,
            );
            if (controller == null || !controller.current) {
              return const Center(
                child: Text(
                  'Unlock this workspace to review GitHub upgrade recovery.',
                ),
              );
            }
            return Material(
              color: Theme.of(context).scaffoldBackgroundColor,
              child: ConnectorGithubUpgradePanel(
                key: ObjectKey(controller),
                controller: controller,
                initialConnectorId: connectorId,
                routeCurrent: _GithubUpgradeRouteVisibility.of(panelContext),
                onReview: (id) => Navigator.of(context).pop(id),
              ),
            );
          },
        ),
      ),
    ),
  );
}

class _GithubUpgradeRouteVisibility extends InheritedWidget {
  const _GithubUpgradeRouteVisibility({
    required this.current,
    required super.child,
  });
  final bool current;
  static bool of(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<_GithubUpgradeRouteVisibility>()!
      .current;

  @override
  bool updateShouldNotify(_GithubUpgradeRouteVisibility oldWidget) =>
      current != oldWidget.current;
}

class ConnectorGithubUpgradePanel extends StatefulWidget {
  const ConnectorGithubUpgradePanel({
    super.key,
    required this.controller,
    this.initialConnectorId,
    this.routeCurrent = true,
    this.onReview,
  });

  final ConnectorGithubUpgradeController controller;
  final String? initialConnectorId;
  final bool routeCurrent;
  final ValueChanged<String>? onReview;

  @override
  State<ConnectorGithubUpgradePanel> createState() =>
      _ConnectorGithubUpgradePanelState();
}

class _ConnectorGithubUpgradePanelState
    extends State<ConnectorGithubUpgradePanel>
    with WidgetsBindingObserver {
  bool _foreground = true,
      _confirming = false,
      _wasVisible = true,
      _workspaceWasVisible = true;
  int _viewEpoch = 0;
  ConnectorGithubUpgradeController get c => widget.controller;
  bool get _visible =>
      mounted &&
      _foreground &&
      widget.routeCurrent &&
      c.current &&
      (ModalRoute.isCurrentOf(context) ?? true) &&
      TickerMode.valuesOf(context).enabled;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    unawaited(_load());
  }

  Future<void> _load() async {
    final controller = c, epoch = _viewEpoch;
    await controller.initialize();
    if (!mounted ||
        !identical(controller, c) ||
        !_visible ||
        epoch != _viewEpoch) {
      return;
    }
    final id = widget.initialConnectorId;
    if (id != null) {
      await controller.select(id);
    } else if (controller.sequence != null) {
      await controller.refresh();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final workspaceVisible =
        _foreground &&
        widget.routeCurrent &&
        TickerMode.valuesOf(context).enabled;
    if (!workspaceVisible && _workspaceWasVisible) {
      _viewEpoch++;
      c.hideReview();
    }
    _workspaceWasVisible = workspaceVisible;
    final visible = _visible;
    if (!visible && _wasVisible && !_confirming) {
      _viewEpoch++;
      c.hideReview();
    }
    _wasVisible = visible;
  }

  @override
  void didUpdateWidget(covariant ConnectorGithubUpgradePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, c)) {
      oldWidget.controller.hideReview();
      _viewEpoch++;
      c.hideReview();
      unawaited(_load());
    }
    if (oldWidget.routeCurrent != widget.routeCurrent) {
      _viewEpoch++;
      c.hideReview();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _viewEpoch++;
    c.hideReview();
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _viewEpoch++;
    c.hideReview();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      if (!c.current ||
          !_foreground ||
          !widget.routeCurrent ||
          !TickerMode.valuesOf(context).enabled) {
        return const Center(
          child: Text(
            'Return to the unlocked workspace to review this upgrade.',
          ),
        );
      }
      return ListView(
        key: PageStorageKey(('github-upgrade-list', c)),
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Expand official GitHub MCP tools',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          const Text(
            'Upgrade one exact legacy GitHub connection from /mcp to /mcp/x/all. The expanded catalog is discovered once; the connection stays disabled and every returned tool waits for a separate review.',
          ),
          if (!c.mayChange)
            const Text(
              'Your access permits exact recovery. An administrator must confirm a new GitHub upgrade.',
            ),
          Wrap(
            spacing: 12,
            runSpacing: 8,
            children: [
              OutlinedButton(
                onPressed: c.busy || c.reading ? null : c.refresh,
                child: const Text('Refresh exact connection review'),
              ),
              if (!c.loaded || c.storageUnconfirmed)
                OutlinedButton(
                  onPressed: c.busy ? null : c.reloadProtected,
                  child: const Text('Reload protected recovery'),
                ),
              if (c.loaded && c.storageUnconfirmed)
                OutlinedButton(
                  onPressed: c.busy ? null : c.saveLocally,
                  child: const Text('Save retained evidence locally'),
                ),
            ],
          ),
          if (c.busy || c.reading) const LinearProgressIndicator(),
          if (c.error != null) _error(c.error!),
          if (c.readError != null) _error(c.readError!),
          if (c.sequence != null) _recovery(),
          if (c.reviewed != null) ..._review(c.reviewed!),
          if (c.reviewed == null && !c.reading)
            const Text(
              'Open an exact legacy GitHub MCP connection from connector controls. Protected recovery remains available here even when the connection is missing from the list.',
            ),
        ],
      );
    },
  );

  Widget _error(String text) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Text(
      text,
      style: TextStyle(color: Theme.of(context).colorScheme.error),
    ),
  );

  List<Widget> _review(ConnectorReview review) {
    final row = review.connector;
    if (row == null) {
      return [
        const Text(
          'This exact connection is unavailable. Its original attempt can still be recovered or explicitly closed.',
        ),
      ];
    }
    final contracts = review.value!['contracts'] as List;
    return [
      const Divider(height: 32),
      Text(
        row['name'] as String,
        style: Theme.of(context).textTheme.titleLarge,
      ),
      SelectableText('${row['id']}\n${row['endpoint']}'),
      if (row['endpointRedacted'] == true)
        const Text(
          'Endpoint query or fragment is hidden; this upgrade is unavailable.',
        ),
      Text(
        'State: ${row['status']} · credential version ${row['credentialVersion']} · ${contracts.length} current contracts',
      ),
      Text(
        'Default risk ${row['defaultRiskLevel']} · ${row['approvalRequired'] == true ? 'approval required' : 'reviewed lower-risk access'}',
      ),
      if (!githubUpgradeEligible(review))
        const Text(
          'The upgrade requires a complete review of an official GitHub /mcp connection, with a currently configured matching bearer credential when applicable.',
        ),
      if (githubUpgradeEligible(review) &&
          !c.reading &&
          c.eligibility != null &&
          !c.eligibility!.matches(review))
        const Text(
          'The stored GitHub endpoint, credential, or current review is not eligible for this upgrade. Reload the exact connection review after correcting it.',
        ),
      if (contracts.isNotEmpty)
        ExpansionTile(
          key: PageStorageKey((
            'github-upgrade-tools',
            c,
            review.pin?['reviewSha256'],
          )),
          title: const Text('Current discovered tools'),
          children: [
            for (final raw in contracts)
              _contract(connectorMap(raw), row['id'] as String),
          ],
        ),
      if (c.canAct)
        FilledButton.icon(
          onPressed: _confirm,
          icon: const Icon(Icons.upgrade),
          label: const Text('Review GitHub upgrade'),
        ),
    ];
  }

  Widget _contract(ConnectorJson row, String id) => ExpansionTile(
    key: PageStorageKey((
      'github-upgrade-contract',
      c,
      id,
      row['id'],
      row['fingerprint'],
    )),
    title: Text(row['name'] as String),
    subtitle: Text(
      '${row['status']} · risk ${row['riskLevel']} · ${row['approvalRequired'] == true ? 'approval required' : 'no additional approval flag'}',
    ),
    childrenPadding: const EdgeInsets.all(12),
    children: [
      if (row['description'] != null) Text(row['description'] as String),
      SelectableText(
        const JsonEncoder.withIndent('  ').convert(row['definition']),
      ),
    ],
  );

  Widget _recovery() {
    final held = c.sequence!,
        response = held.response,
        result = response?.result;
    final title = response?.state == 'closed'
        ? 'Upgrade attempt closed'
        : result?['status'] == 'complete'
        ? 'GitHub upgrade completed'
        : result?['status'] == 'failed'
        ? 'GitHub upgrade failed'
        : held.closeDispatched
        ? 'Close unconfirmed'
        : response?.state == 'expired'
        ? 'Upgrade deadline passed'
        : response?.state == 'pending'
        ? 'GitHub upgrade pending'
        : held.dispatched
        ? 'GitHub upgrade unconfirmed'
        : 'Local upgrade not sent';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            SelectableText('Connection ${held.intent.id}'),
            if (response?.attempt != null)
              Text(
                'Original attempt deadline: ${response!.attempt!['expiresAt']}',
              ),
            if (!held.terminal && held.dispatched)
              const Text(
                'Exact recovery does not repeat discovery. Missing or expired evidence does not permit a new upgrade; explicitly close this attempt first.',
              ),
            if (response?.state == 'closed')
              const Text(
                'This exact attempt is permanently fenced from changing the connection. Requests already started at GitHub may still finish.',
              ),
            if (result?['status'] == 'complete') ...[
              Text(
                '${result!['contractCount']} tools discovered · ${result['pendingCount']} pending review',
              ),
              const Text(
                'The endpoint was expanded and the connection remains disabled. Open its exact current review before separately approving and activating the new contracts.',
              ),
            ],
            if (result?['status'] == 'failed')
              Text(switch (result!['failureCode']) {
                'catalog_unreviewable' => 'The expanded catalog could not be reviewed within native limits. The original connection and catalog were preserved.',
                'target_changed' => 'The reviewed connection or authority changed. The original connection and catalog were preserved.',
                'deadline_exceeded' => 'The bounded attempt expired. The original connection and catalog were preserved.',
                _ => 'GitHub discovery failed. The original connection and catalog were preserved.',
              }),
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                if (held.dispatched && !held.terminal)
                  OutlinedButton(
                    onPressed: c.busy || c.reading ? null : c.recover,
                    child: const Text('Check exact attempt'),
                  ),
                if (c.canCloseAttempt)
                  TextButton(
                    onPressed: _closeAttempt,
                    child: Text(
                      held.closeDispatched
                          ? 'Reconfirm exact close'
                          : 'Close this attempt',
                    ),
                  ),
                if (!held.dispatched && !c.storageUnconfirmed)
                  TextButton(
                    onPressed: c.busy ? null : c.discardLocal,
                    child: const Text('Discard local upgrade'),
                  ),
                if (held.terminal && widget.onReview != null)
                  OutlinedButton(
                    onPressed: c.busy || c.storageUnconfirmed
                        ? null
                        : () {
                            if (_visible) widget.onReview!(held.intent.id);
                          },
                    child: const Text('Open exact connection review'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<bool> _dialog(
    String title,
    Widget Function() content,
    String confirm,
    ConnectorGithubUpgradeController controller,
    int epoch,
  ) async {
    _confirming = true;
    try {
      return await showDialog<bool>(
            context: context,
            useRootNavigator: false,
            builder: (dialogContext) => ListenableBuilder(
              listenable: controller,
              builder: (context, _) {
                final live =
                    mounted &&
                    identical(controller, c) &&
                    controller.current &&
                    _foreground &&
                    widget.routeCurrent &&
                    _viewEpoch == epoch &&
                    _workspaceWasVisible;
                return AlertDialog(
                  scrollable: true,
                  title: Text(title),
                  content: live
                      ? content()
                      : const Text(
                          'This review is no longer visible and current. Return to the connection and review it again.',
                        ),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.of(dialogContext).pop(false),
                      child: const Text('Cancel'),
                    ),
                    FilledButton(
                      onPressed: live
                          ? () => Navigator.of(dialogContext).pop(true)
                          : null,
                      child: Text(confirm),
                    ),
                  ],
                );
              },
            ),
          ) ==
          true;
    } finally {
      _confirming = false;
    }
  }

  Future<void> _confirm() async {
    if (!_visible || !c.canAct) return;
    final controller = c, epoch = _viewEpoch, review = c.reviewed!;
    final confirmed = await _dialog(
      'Expand this GitHub MCP connection?',
      () => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(review.connector!['name'] as String),
          SelectableText(
            '${review.connector!['id']}\n${review.connector!['endpoint']} → $githubExpandedMcpEndpoint',
          ),
          Text(
            'Credential version ${review.connector!['credentialVersion']} · ${review.connector!['contractCount']} current contracts',
          ),
          const SizedBox(height: 12),
          const Text(
            'This one bounded attempt contacts the official GitHub MCP server and replaces the current local tool catalog with the expanded catalog. It may add GitHub Actions tools. The connection stays disabled and every discovered tool must be reviewed separately before activation.',
          ),
          if (review.connector!['status'] == 'active')
            const Text(
              'This active connection will be paused if the upgrade succeeds. Existing tools remain unavailable until you approve the expanded catalog and activate the connection again.',
            ),
          const Text(
            'Discovery initializes a session, lists tools and closes the session. It does not execute a tool. GitHub may record or bill these requests.',
          ),
          const Text(
            'The exact current configuration is checked again before submission. An uncertain result is recovered by exact lookup without repeating the upgrade.',
          ),
        ],
      ),
      'Confirm upgrade',
      controller,
      epoch,
    );
    if (!confirmed ||
        !mounted ||
        !identical(controller, c) ||
        !_visible ||
        epoch != _viewEpoch) {
      return;
    }
    await controller.act(
      review,
      () =>
          mounted &&
          identical(controller, c) &&
          _visible &&
          epoch == _viewEpoch,
    );
  }

  Future<void> _closeAttempt() async {
    if (!_visible || !c.canCloseAttempt) return;
    final controller = c, epoch = _viewEpoch, held = c.sequence!;
    final confirmed = await _dialog(
      'Close this exact GitHub upgrade?',
      () => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SelectableText('Connection ${held.intent.id}'),
          const Text(
            'Permanently prevent this attempt from changing the connection. Provider requests already started may still finish. If the upgrade already settled, its original result remains unchanged.',
          ),
          const Text(
            'Closing does not contact GitHub. A new upgrade requires a fresh exact review and separate confirmation.',
          ),
        ],
      ),
      'Confirm close',
      controller,
      epoch,
    );
    if (!confirmed ||
        !mounted ||
        !identical(controller, c) ||
        !_visible ||
        epoch != _viewEpoch ||
        !identical(held, c.sequence)) {
      return;
    }
    await controller.closeAttempt(
      () =>
          mounted &&
          identical(controller, c) &&
          _visible &&
          epoch == _viewEpoch,
    );
  }
}
