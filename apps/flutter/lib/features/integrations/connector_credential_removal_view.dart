import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/native_workspace_access.dart';
import 'connector_contracts.dart';
import 'connector_control_contracts.dart';
import 'connector_credential_removal_contracts.dart';
import 'connector_credential_removal_controller.dart';
import 'connector_credential_removal_providers.dart';

class NativeConnectorCredentialRemovalWorkspace extends StatelessWidget {
  const NativeConnectorCredentialRemovalWorkspace({
    super.key,
    required this.connectorId,
  });
  final String connectorId;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Saved MCP credential')),
    body: _RemovalRouteVisibility(
      current: ModalRoute.isCurrentOf(context) ?? true,
      child: NativePrivateWorkspace(
        ownNavigator: true,
        builder: (_) => Consumer(
          builder: (context, ref, _) {
            final controller = ref.watch(
              connectorCredentialRemovalControllerProvider(connectorId),
            );
            if (controller == null || !controller.current) {
              return const Center(
                child: Text(
                  'Unlock this workspace to review its saved credential.',
                ),
              );
            }
            return ConnectorCredentialRemovalPanel(
              key: ObjectKey(controller),
              controller: controller,
              routeCurrent: _RemovalRouteVisibility.of(context),
            );
          },
        ),
      ),
    ),
  );
}

class _RemovalRouteVisibility extends InheritedWidget {
  const _RemovalRouteVisibility({required this.current, required super.child});
  final bool current;
  static bool of(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<_RemovalRouteVisibility>()!
      .current;
  @override
  bool updateShouldNotify(_RemovalRouteVisibility oldWidget) =>
      current != oldWidget.current;
}

class ConnectorCredentialRemovalPanel extends StatefulWidget {
  const ConnectorCredentialRemovalPanel({
    super.key,
    required this.controller,
    this.routeCurrent = true,
  });
  final ConnectorCredentialRemovalController controller;
  final bool routeCurrent;
  @override
  State<ConnectorCredentialRemovalPanel> createState() =>
      _ConnectorCredentialRemovalPanelState();
}

class _ConnectorCredentialRemovalPanelState
    extends State<ConnectorCredentialRemovalPanel>
    with WidgetsBindingObserver {
  bool _foreground = true,
      _confirming = false,
      _wasVisible = true,
      _workspaceWasVisible = true;
  int _viewEpoch = 0;
  ConnectorCredentialRemovalController get c => widget.controller;
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
  void didUpdateWidget(covariant ConnectorCredentialRemovalPanel oldWidget) {
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
            'Return to the unlocked workspace to review this credential.',
          ),
        );
      }
      return ListView(
        key: PageStorageKey(('credential-removal-list', c, c.owner.key)),
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Remove a saved MCP credential',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          const Text(
            'Remove the credential stored in Asael, disable this connection, and clear its discovered tools. The provider token remains valid until you revoke it with the provider.',
          ),
          const SizedBox(height: 12),
          if (!c.mayChange)
            const Text(
              'Your current access permits review and receipt recovery. An administrator must remove a saved credential.',
            ),
          Wrap(
            spacing: 12,
            runSpacing: 8,
            children: [
              OutlinedButton.icon(
                onPressed: c.busy || c.reading ? null : c.refresh,
                icon: const Icon(Icons.refresh),
                label: Text(
                  c.reading
                      ? 'Reading connection…'
                      : 'Refresh credential review',
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
                'Refresh the exact connection review before removing a credential.',
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
                  ? 'Credential removal unconfirmed'
                  : 'Prepared removal not sent',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            SelectableText(
              'Connection ${pending.intent.id} · credential version ${pending.intent.review['credentialVersion']}',
            ),
            const Text(
              'The exact submission is protected on this device. Checking its receipt does not repeat the removal.',
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

  List<Widget> _review(ConnectorReview review) {
    if (review.connector == null) {
      return [
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 16),
          child: Text(
            'This exact connection is not currently available. Any saved submission can still be checked by its exact receipt.',
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
        'Saved credential: ${row['credentialConfigured'] == true ? 'configured' : 'not configured'} · version ${row['credentialVersion']}',
      ),
      Text('Connection state: ${row['status']}'),
      const SizedBox(height: 12),
      if (credentialRemovalEligible(review)) ...[
        Text(
          '${contracts.length} discovered tools will be cleared from this connection.',
        ),
        if (contracts.isNotEmpty)
          ExpansionTile(
            key: PageStorageKey((
              'credential-removal-contracts',
              c,
              review.pin!['reviewSha256'],
            )),
            title: const Text('Affected discovered tools'),
            children: [
              for (final raw in contracts)
                ListTile(title: Text(connectorMap(raw)['name'] as String)),
            ],
          ),
        Align(
          alignment: Alignment.centerLeft,
          child: FilledButton.icon(
            onPressed: c.canAct ? () => _confirm(review) : null,
            icon: const Icon(Icons.key_off_outlined),
            label: const Text('Remove saved credential'),
          ),
        ),
      ] else
        const Text(
          'No saved credential can be removed from this current review. A configured app-managed bearer credential and a complete supported review are required.',
        ),
    ];
  }

  Widget _receipt() {
    final saved = c.accepted!, acceptance = saved.response.acceptance!;
    final settlement = saved.response.action!['settlement'];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              saved.settled
                  ? 'Saved credential removed'
                  : 'Removal accepted; result unconfirmed',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            SelectableText('Connection ${saved.intent.id}'),
            Text('Accepted ${acceptance['acceptedAt']}'),
            if (settlement is Map)
              Text(
                'Connection disabled · discovered tools cleared · credential version ${settlement['result']['credentialVersion']}',
              ),
            const Text(
              'The provider token remains valid until you revoke it with the provider.',
            ),
            if (c.storageUnconfirmed)
              OutlinedButton(
                onPressed: c.busy ? null : c.saveAcceptedLocally,
                child: const Text('Save verified receipt locally'),
              ),
            ExpansionTile(
              key: PageStorageKey((
                'credential-removal-receipt',
                c,
                acceptance['id'],
              )),
              title: const Text('Receipt details'),
              children: [
                SelectableText(
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

  Future<void> _confirm(ConnectorReview review) async {
    if (!_visible || !c.canAct) return;
    final controller = c, epoch = _viewEpoch, row = review.connector!;
    _confirming = true;
    bool? confirmed;
    try {
      confirmed = await showDialog<bool>(
        context: context,
        useRootNavigator: false,
        builder: (dialogContext) => AlertDialog(
          scrollable: true,
          title: const Text('Remove saved credential?'),
          content: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(row['name'] as String),
              SelectableText('${row['id']}\n${row['endpoint']}'),
              const SizedBox(height: 12),
              Text(
                'Remove credential version ${row['credentialVersion']} stored in Asael, disable this connection, and clear its ${row['contractCount']} discovered tools.',
              ),
              const SizedBox(height: 12),
              const Text(
                'The provider token remains valid until you revoke it with the provider. To use this connection again, save a credential and rediscover and review its tools.',
              ),
              const SizedBox(height: 12),
              const Text(
                'Asael checks this exact reviewed configuration again before removal. An uncertain result is recovered by receipt lookup.',
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
              child: const Text('Confirm removal'),
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
