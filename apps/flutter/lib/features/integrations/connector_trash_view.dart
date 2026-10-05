import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/native_workspace_access.dart';
import 'connector_contracts.dart';
import 'connector_trash_contracts.dart';
import 'connector_trash_controller.dart';
import 'connector_trash_providers.dart';

class NativeConnectorTrashWorkspace extends StatelessWidget {
  const NativeConnectorTrashWorkspace({super.key, this.connectorId});
  final String? connectorId;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Connector Trash')),
    body: _TrashRouteVisibility(
      current: ModalRoute.isCurrentOf(context) ?? true,
      child: NativePrivateWorkspace(
        ownNavigator: true,
        builder: (_) => Consumer(
          builder: (context, ref, _) {
            final controller = ref.watch(connectorTrashControllerProvider);
            if (controller == null || !controller.current) {
              return const Center(
                child: Text(
                  'Unlock this workspace to recover its connector Trash action.',
                ),
              );
            }
            return ConnectorTrashPanel(
              key: ObjectKey(controller),
              controller: controller,
              initialConnectorId: connectorId,
              routeCurrent: _TrashRouteVisibility.of(context),
            );
          },
        ),
      ),
    ),
  );
}

class _TrashRouteVisibility extends InheritedWidget {
  const _TrashRouteVisibility({required this.current, required super.child});
  final bool current;
  static bool of(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<_TrashRouteVisibility>()!
      .current;
  @override
  bool updateShouldNotify(_TrashRouteVisibility oldWidget) =>
      current != oldWidget.current;
}

class ConnectorTrashPanel extends StatefulWidget {
  const ConnectorTrashPanel({
    super.key,
    required this.controller,
    this.routeCurrent = true,
    this.initialConnectorId,
  });
  final ConnectorTrashController controller;
  final bool routeCurrent;
  final String? initialConnectorId;
  @override
  State<ConnectorTrashPanel> createState() => _ConnectorTrashPanelState();
}

class _ConnectorTrashPanelState extends State<ConnectorTrashPanel>
    with WidgetsBindingObserver {
  bool _foreground = true,
      _confirming = false,
      _wasVisible = true,
      _workspaceWasVisible = true;
  int _viewEpoch = 0;
  ConnectorTrashController get c => widget.controller;
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
    if (id != null) await controller.select(id);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final workspaceVisible =
        _foreground &&
        widget.routeCurrent &&
        TickerMode.valuesOf(context).enabled;
    if (!workspaceVisible && _workspaceWasVisible) _viewEpoch++;
    _workspaceWasVisible = workspaceVisible;
    final visible = _visible;
    if (!visible && _wasVisible && !_confirming) _viewEpoch++;
    _wasVisible = visible;
  }

  @override
  void didUpdateWidget(covariant ConnectorTrashPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, c) ||
        oldWidget.routeCurrent != widget.routeCurrent) {
      _viewEpoch++;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _viewEpoch++;
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _viewEpoch++;
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
            'Return to the unlocked workspace to review connector Trash.',
          ),
        );
      }
      return ListView(
        key: PageStorageKey(('connector-trash-list', c, c.owner.key)),
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Connector Trash and recovery',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          const Text(
            'Move an exact reviewed MCP connection and its tools to Trash. This does not revoke provider tokens or change external environment credentials.',
          ),
          const SizedBox(height: 12),
          if (!c.mayChange)
            const Text(
              'Your current access permits exact receipt recovery. An administrator must obtain a fresh Trash preview and confirm a move.',
            ),
          Wrap(
            spacing: 12,
            runSpacing: 8,
            children: [
              OutlinedButton.icon(
                onPressed:
                    c.busy || c.reading || !c.mayChange || c.selectedId == null
                    ? null
                    : c.refresh,
                icon: const Icon(Icons.refresh),
                label: Text(
                  c.reading ? 'Reading connection…' : 'Refresh Trash preview',
                ),
              ),
              if (!c.loaded || c.storageUnconfirmed)
                OutlinedButton(
                  onPressed: c.busy ? null : c.reloadProtected,
                  child: const Text('Reload protected recovery'),
                ),
            ],
          ),
          if (c.readError != null) _error(c.readError!),
          if (c.error != null) _error(c.error!),
          if (c.reading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: LinearProgressIndicator(),
            ),
          if (c.pending != null) _pending(),
          if (c.accepted != null) _receipt(),
          if (c.reviewed != null)
            ..._review(c.reviewed!)
          else if (!c.reading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Text(
                'Open an existing MCP connection to review a new move. Saved Trash recovery above remains available after a connection is deleted.',
              ),
            ),
        ],
      );
    },
  );

  Widget _error(String message) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Text(
      message,
      style: TextStyle(color: Theme.of(context).colorScheme.error),
    ),
  );

  Widget _pending() {
    final pending = c.pending!;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              pending.dispatched
                  ? 'Move to Trash unconfirmed'
                  : 'Prepared move not sent',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            SelectableText(
              'Connection ${pending.intent.id} · credential version ${pending.intent.review['credentialVersion']}',
            ),
            const Text(
              'The exact submission is protected on this device. Checking its receipt does not repeat the move.',
            ),
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                OutlinedButton(
                  onPressed: c.busy ? null : c.recover,
                  child: const Text('Check exact receipt'),
                ),
                if (!pending.dispatched && !c.storageUnconfirmed)
                  TextButton(
                    onPressed: c.busy ? null : c.discardPrepared,
                    child: const Text('Discard local preparation'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _review(ConnectorTrashPreview reviewed) {
    final review = reviewed.review;
    if (review.connector == null) {
      return [
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 16),
          child: Text(
            'This connection is no longer available. The saved submission can still be recovered by its exact receipt.',
          ),
        ),
      ];
    }
    final row = review.connector!,
        contracts = review.value!['contracts'] as List;
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
        '${contracts.length} discovered tools are included in this exact review.',
      ),
      if (reviewed.preview != null) ...[
        Text('Preview expires ${reviewed.preview!['expiresAt']}'),
        if (!reviewed.freshAt(c.now()))
          const Text(
            'This preview expired. Refresh it and review again before confirming.',
          ),
        if (reviewed.compensation!['limitation'] != null)
          Text(reviewed.compensation!['limitation'] as String),
        if (contracts.isNotEmpty)
          ExpansionTile(
            key: PageStorageKey((
              'connector-trash-tools',
              c,
              review.pin!['reviewSha256'],
            )),
            title: const Text('Affected discovered tools'),
            children: [
              for (final tool in contracts)
                ListTile(title: Text(connectorMap(tool)['name'] as String)),
            ],
          ),
        Align(
          alignment: Alignment.centerLeft,
          child: FilledButton.icon(
            onPressed: c.canAct ? () => _confirm(reviewed) : null,
            icon: const Icon(Icons.delete_outline),
            label: const Text('Move to Trash'),
          ),
        ),
      ] else
        const Text(
          'A complete supported review is required before moving this connection to Trash.',
        ),
    ];
  }

  Widget _receipt() {
    final saved = c.accepted!, acceptance = saved.response.acceptance!;
    final settlement = saved.response.action!['settlement'];
    final trash = settlement == null
        ? null
        : connectorMap(connectorMap(settlement)['result'])['trash'];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              saved.settled
                  ? 'Move to Trash confirmed'
                  : 'Move accepted; result unconfirmed',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            SelectableText('Connection ${saved.intent.id}'),
            Text('Accepted ${acceptance['acceptedAt']}'),
            if (trash is Map) ...[
              SelectableText('Trash ID: ${trash['trashId']}'),
              Text('Original restore deadline: ${trash['restoreUntil']}'),
              const Text(
                'This receipt records the original move. It does not establish current restore availability; the item may since have been restored, purged or expired.',
              ),
              if (trash['limitation'] != null)
                Text(trash['limitation'] as String),
              const Text(
                'To review restoration, sign into the same account and workspace in the browser. Choose Data & privacy → Trash recovery and enter this exact Trash ID. Review and confirm there.',
              ),
              const NativeWorkspaceBrowserButton(
                path: '/app/settings',
                label: 'Open Trash recovery in browser',
              ),
            ],
            const Text(
              'Moving to Trash does not revoke a provider token or change external environment credentials.',
            ),
            if (c.storageUnconfirmed)
              OutlinedButton(
                onPressed: c.busy ? null : c.saveAcceptedLocally,
                child: const Text('Save verified receipt locally'),
              ),
            ExpansionTile(
              key: PageStorageKey((
                'connector-trash-receipt',
                c,
                acceptance['id'],
              )),
              title: const Text('Receipt details'),
              children: [
                SelectableText(
                  key: PageStorageKey((
                    'connector-trash-receipt-text',
                    c,
                    acceptance['id'],
                  )),
                  const JsonEncoder.withIndent('  ')
                      .convert(saved.response.action),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirm(ConnectorTrashPreview review) async {
    if (!_visible || !c.canAct) return;
    final controller = c, epoch = _viewEpoch, row = review.review.connector!;
    _confirming = true;
    bool? confirmed;
    try {
      confirmed = await showDialog<bool>(
        context: context,
        useRootNavigator: false,
        builder: (dialogContext) => AlertDialog(
          scrollable: true,
          title: const Text('Move this connection to Trash?'),
          content: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(row['name'] as String),
              SelectableText('${row['id']}\n${row['endpoint']}'),
              const SizedBox(height: 12),
              Text(review.preview!['effectSummary'] as String),
              Text('Preview expires ${review.preview!['expiresAt']}'),
              if (review.compensation!['limitation'] != null)
                Text(review.compensation!['limitation'] as String),
              const SizedBox(height: 12),
              const Text(
                'This removes the live connection and its tools from Asael. It does not revoke the provider token or change external environment credentials. Browser restoration requires a separate current review and confirmation.',
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('Confirm move to Trash'),
            ),
          ],
        ),
      );
    } finally {
      _confirming = false;
    }
    if (confirmed != true ||
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
}
