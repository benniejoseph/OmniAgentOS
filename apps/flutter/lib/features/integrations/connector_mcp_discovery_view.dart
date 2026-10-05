import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/native_workspace_access.dart';
import 'connector_contracts.dart';
import 'connector_control_contracts.dart';
import 'connector_mcp_discovery_contracts.dart';
import 'connector_mcp_discovery_controller.dart';
import 'connector_mcp_discovery_providers.dart';

class NativeConnectorMcpDiscoveryWorkspace extends StatelessWidget {
  const NativeConnectorMcpDiscoveryWorkspace({super.key, this.connectorId});
  final String? connectorId;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('MCP tool discovery')),
    body: _DiscoveryRouteVisibility(
      current: ModalRoute.isCurrentOf(context) ?? true,
      child: NativePrivateWorkspace(
        ownNavigator: true,
        builder: (_) => Consumer(
          builder: (panelContext, ref, _) {
            final controller = ref.watch(
              connectorMcpDiscoveryControllerProvider,
            );
            if (controller == null || !controller.current) {
              return const Center(
                child: Text(
                  'Unlock this workspace to review discovery recovery.',
                ),
              );
            }
            return Material(
              color: Theme.of(context).scaffoldBackgroundColor,
              child: ConnectorMcpDiscoveryPanel(
                key: ObjectKey(controller),
                controller: controller,
                initialConnectorId: connectorId,
                routeCurrent: _DiscoveryRouteVisibility.of(panelContext),
                onReview: (id) => Navigator.of(context).pop(id),
              ),
            );
          },
        ),
      ),
    ),
  );
}

class _DiscoveryRouteVisibility extends InheritedWidget {
  const _DiscoveryRouteVisibility({
    required this.current,
    required super.child,
  });
  final bool current;
  static bool of(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<_DiscoveryRouteVisibility>()!
      .current;
  @override
  bool updateShouldNotify(_DiscoveryRouteVisibility oldWidget) =>
      current != oldWidget.current;
}

class ConnectorMcpDiscoveryPanel extends StatefulWidget {
  const ConnectorMcpDiscoveryPanel({
    super.key,
    required this.controller,
    this.initialConnectorId,
    this.routeCurrent = true,
    this.onReview,
  });
  final ConnectorMcpDiscoveryController controller;
  final String? initialConnectorId;
  final bool routeCurrent;
  final ValueChanged<String>? onReview;
  @override
  State<ConnectorMcpDiscoveryPanel> createState() =>
      _ConnectorMcpDiscoveryPanelState();
}

class _ConnectorMcpDiscoveryPanelState extends State<ConnectorMcpDiscoveryPanel>
    with WidgetsBindingObserver {
  bool _foreground = true,
      _confirming = false,
      _wasVisible = true,
      _workspaceWasVisible = true;
  int _viewEpoch = 0;
  ConnectorMcpDiscoveryController get c => widget.controller;
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
    // Only this panel's own inner confirmation route may obscure it without
    // consuming the confirmation epoch. Outer route/TickerMode loss always does.
    if (!visible && _wasVisible && !_confirming) {
      _viewEpoch++;
      c.hideReview();
    }
    _wasVisible = visible;
  }

  @override
  void didUpdateWidget(covariant ConnectorMcpDiscoveryPanel oldWidget) {
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
    if (mounted) {
      setState(() {});
    }
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
          child: Text('Return to the unlocked workspace to review discovery.'),
        );
      }
      return ListView(
        key: PageStorageKey(('mcp-discovery-list', c)),
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Discover MCP tools',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          const Text(
            'Review one disabled connection before a bounded provider discovery attempt. Discovery replaces its complete tool catalog while leaving the connection disabled. New or changed contracts need a separate approval.',
          ),
          if (!c.mayChange)
            const Text(
              'Your access permits exact recovery and closing your own attempt. An administrator is required to start discovery.',
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
              'Open an exact MCP connection to review discovery. The protected attempt remains recoverable here even if its connection is missing from the list.',
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
        const Text('Endpoint query and fragment are hidden.'),
      Text(
        'State: ${row['status']} · credential version ${row['credentialVersion']} · ${contracts.length} current contracts',
      ),
      Text(
        'Default risk ${row['defaultRiskLevel']} · ${row['approvalRequired'] == true ? 'approval required' : 'reviewed lower-risk access'}',
      ),
      if (row['authType'] == 'bearer_env')
        const Text(
          'The server rechecks the deployment credential binding before discovery.',
        ),
      if (!mcpDiscoveryEligible(review))
        const Text(
          'Discovery requires a complete supported review and a disabled connection. Disable it from connector controls first; a saved bearer credential must be configured for this origin.',
        ),
      for (final raw in contracts)
        _contract(connectorMap(raw), row['id'] as String),
      if (c.canAct)
        FilledButton(
          onPressed: _confirm,
          child: const Text('Review discovery attempt'),
        ),
    ];
  }

  Widget _contract(ConnectorJson row, String id) => ExpansionTile(
    key: PageStorageKey((
      'mcp-discovery-contract',
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
        key: PageStorageKey((
          'mcp-discovery-schema',
          c,
          id,
          row['id'],
          row['fingerprint'],
        )),
      ),
    ],
  );
  Widget _recovery() {
    final held = c.sequence!,
        response = held.response,
        result = response?.result;
    final title = response?.state == 'closed'
        ? 'Discovery attempt closed'
        : result?['status'] == 'complete'
        ? 'Discovery completed'
        : result?['status'] == 'failed'
        ? 'Discovery failed'
        : held.closeDispatched
        ? 'Close unconfirmed'
        : response?.state == 'expired'
        ? 'Discovery deadline passed'
        : response?.state == 'pending'
        ? 'Discovery pending'
        : held.dispatched
        ? 'Discovery unconfirmed'
        : 'Local attempt not sent';
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
                'Exact recovery does not repeat provider discovery. Missing or expired evidence does not permit a new attempt; explicitly close this attempt first.',
              ),
            if (response?.state == 'closed')
              const Text(
                'The server permanently fenced this attempt from publishing a catalog. This does not establish that provider requests already started were cancelled.',
              ),
            if (result?['status'] == 'complete') ...[
              Text(
                '${result!['contractCount']} tools discovered · ${result['pendingCount']} contracts pending review',
              ),
              const Text(
                'This historical receipt records a disabled connection. Open its exact current review before approving contracts. Approving pending contracts activates the connection; discovery itself did not.',
              ),
            ],
            if (result?['status'] == 'failed')
              Text(switch (result!['failureCode']) {
                'catalog_unreviewable' => 'The complete returned catalog could not be reviewed within the native limits. The previous catalog was preserved.',
                'target_changed' => 'The reviewed connection or its authority changed before publication. This attempt did not replace its catalog.',
                'deadline_exceeded' => 'The attempt exceeded its bounded deadline. This attempt did not replace the catalog.',
                _ => 'Provider discovery failed. This attempt did not replace the catalog.',
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
                    child: const Text('Discard local attempt'),
                  ),
                if (held.terminal && widget.onReview != null)
                  OutlinedButton(
                    onPressed: c.busy || c.storageUnconfirmed
                        ? null
                        : () {
                            if (_visible) {
                              widget.onReview!(held.intent.id);
                            }
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
    ConnectorMcpDiscoveryController controller,
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
    if (!_visible || !c.canAct) {
      return;
    }
    final controller = c, epoch = _viewEpoch, review = c.reviewed!;
    final confirmed = await _dialog(
      'Discover tools for this connection?',
      () => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(review.connector!['name'] as String),
          SelectableText(
            '${review.connector!['id']}\n${review.connector!['endpoint']}',
          ),
          Text(
            'Credential version ${review.connector!['credentialVersion']} · ${review.connector!['contractCount']} current contracts',
          ),
          const Text(
            'Contact this provider for one bounded discovery attempt and replace the complete local catalog. The connection stays disabled. Unchanged reviewed policies are preserved; new or changed contracts need a separate approval.',
          ),
          const Text(
            'Discovery initializes a session, lists tools and closes the session. It does not execute tools. The provider may record or bill these requests.',
          ),
          const Text(
            'The exact current configuration is checked again before submission. An uncertain outcome is recovered by exact lookup, without repeating discovery.',
          ),
        ],
      ),
      'Confirm discovery',
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
    if (!_visible || !c.canCloseAttempt) {
      return;
    }
    final controller = c, epoch = _viewEpoch, held = c.sequence!;
    final confirmed = await _dialog(
      'Close this exact discovery attempt?',
      () => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SelectableText('Connection ${held.intent.id}'),
          const Text(
            'Permanently prevent this attempt from publishing a catalog. Provider requests already started may still finish. If discovery already settled, its original result remains unchanged.',
          ),
          const Text(
            'Closing does not start discovery. A new attempt requires a fresh connection review and another explicit confirmation.',
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
