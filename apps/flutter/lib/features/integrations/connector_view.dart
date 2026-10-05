import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/native_workspace_access.dart';
import 'connector_contracts.dart';
import 'connector_control_contracts.dart';
import 'connector_controller.dart';
import 'connector_credential_removal_view.dart';
import 'connector_credential_rotation_view.dart';
import 'connector_github_upgrade_contracts.dart';
import 'connector_github_upgrade_repository.dart';
import 'connector_github_upgrade_view.dart';
import 'connector_mcp_registration_view.dart';
import 'connector_mcp_discovery_view.dart';
import 'connector_openapi_import_view.dart';
import 'connector_providers.dart';
import 'connector_trash_view.dart';

class NativeConnectorWorkspace extends StatelessWidget {
  const NativeConnectorWorkspace({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Connector controls')),
    body: NativePrivateWorkspace(
      ownNavigator: true,
      builder: (_) => Consumer(
        builder: (context, ref, _) {
          final controller = ref.watch(connectorControllerProvider);
          if (controller == null || !controller.current) {
            return const Center(
              child: Text('Unlock this workspace to read its connections.'),
            );
          }
          return Material(
            color: Theme.of(context).scaffoldBackgroundColor,
            child: ConnectorControlPanel(
              key: ObjectKey(controller),
              controller: controller,
            ),
          );
        },
      ),
    ),
  );
}

String connectorActionLabel(String action) => switch (action) {
  'review_contracts' => 'Approve reviewed contracts',
  'enable' => 'Enable connector',
  'disable' => 'Disable connector',
  _ => 'Connector action',
};

class ConnectorControlPanel extends StatefulWidget {
  const ConnectorControlPanel({super.key, required this.controller});
  final ConnectorController controller;
  @override
  State<ConnectorControlPanel> createState() => _ConnectorControlPanelState();
}

class _ConnectorControlPanelState extends State<ConnectorControlPanel>
    with WidgetsBindingObserver {
  final _exactId = TextEditingController();
  String _kind = 'mcp';
  bool _foreground = true;
  int _viewEpoch = 0;
  ConnectorController get c => widget.controller;
  bool get _visible =>
      mounted &&
      _foreground &&
      c.current &&
      (ModalRoute.of(context)?.isCurrent ?? true) &&
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
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _viewEpoch++;
    if (mounted) {
      setState(() {});
    }
  }

  @override
  void didUpdateWidget(covariant ConnectorControlPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, c)) {
      _viewEpoch++;
      _exactId.clear();
      _kind = 'mcp';
    }
  }

  @override
  void dispose() {
    _viewEpoch++;
    _exactId.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      if (!c.current || !_foreground) {
        return const Center(
          child: Text(
            'Return to the unlocked workspace to review its connections.',
          ),
        );
      }
      return ListView(
        key: PageStorageKey(('native-connector-list', c, c.owner.key)),
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'MCP and OpenAPI connections',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          const Text(
            'Inspect the current contracts and explicitly approve or change a connection. Approving contracts does not execute their tools.',
          ),
          const SizedBox(height: 12),
          if (!c.mayManage)
            const Text(
              'Your current access permits reading and receipt recovery. An administrator must approve contracts or change connector state.',
            ),
          Wrap(
            spacing: 12,
            runSpacing: 8,
            children: [
              if (c.mayManage)
                FilledButton.icon(
                  onPressed: c.busy ? null : _openMcpRegistration,
                  icon: const Icon(Icons.add),
                  label: const Text('New MCP connection'),
                ),
              OutlinedButton(
                onPressed: c.busy ? null : _openMcpRegistration,
                child: const Text('MCP registration recovery'),
              ),
              OutlinedButton(
                onPressed: c.busy ? null : () => _openMcpDiscovery(),
                child: const Text('MCP discovery recovery'),
              ),
              OutlinedButton(
                onPressed: c.busy ? null : () => _openGithubUpgrade(),
                child: const Text('GitHub upgrade recovery'),
              ),
              if (c.mayManage)
                FilledButton.icon(
                  onPressed: c.busy ? null : _openOpenApiImport,
                  icon: const Icon(Icons.add),
                  label: const Text('New OpenAPI import'),
                ),
              OutlinedButton(
                onPressed: c.busy ? null : _openOpenApiImport,
                child: const Text('OpenAPI import recovery'),
              ),
              OutlinedButton.icon(
                onPressed: c.listing ? null : c.refresh,
                icon: const Icon(Icons.refresh),
                label: Text(
                  c.listing ? 'Reading connections…' : 'Refresh connections',
                ),
              ),
              if (!c.loaded || c.storageUnconfirmed)
                OutlinedButton(
                  onPressed: c.busy ? null : c.reloadProtected,
                  child: const Text('Reload protected recovery'),
                ),
              OutlinedButton.icon(
                onPressed: c.busy ? null : () => _openTrash(),
                icon: const Icon(Icons.restore_from_trash_outlined),
                label: const Text('Connector Trash recovery'),
              ),
              OutlinedButton.icon(
                onPressed: c.busy ? null : () => _openCredentialRotation(),
                icon: const Icon(Icons.key_outlined),
                label: const Text('Credential preparation recovery'),
              ),
            ],
          ),
          if (c.readError != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(
                c.readError!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          if (c.error != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(
                c.error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          if (c.pending != null) _pending(),
          if (c.accepted != null) _receipt(),
          const SizedBox(height: 16),
          if (c.inventory == null)
            const Text('The current connection list has not been verified.')
          else ...[
            Text(
              c.inventory!.hasMore
                  ? 'Showing the first 50 connections. Open a known exact ID below for another connection.'
                  : '${c.inventory!.rows.length} connections in this verified list.',
            ),
            if (c.inventory!.rows.isEmpty)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text('No MCP or OpenAPI connections are visible.'),
              ),
            for (final row in c.inventory!.rows)
              Card(
                child: ListTile(
                  title: Text(row['name'] as String),
                  subtitle: Text(
                    '${(row['kind'] as String).toUpperCase()} · ${row['status']} · ${row['contractCount']} contracts\n${row['id']}',
                  ),
                  selected:
                      c.selectedKind == row['kind'] &&
                      c.selectedId == row['id'],
                  trailing: const Icon(Icons.chevron_right),
                  onTap: c.busy
                      ? null
                      : () =>
                            _select(row['kind'] as String, row['id'] as String),
                ),
              ),
          ],
          ExpansionTile(
            key: PageStorageKey(('connector-exact-picker', c, c.owner.key)),
            title: const Text('Open an exact connection'),
            children: [
              DropdownButtonFormField<String>(
                initialValue: _kind,
                decoration: const InputDecoration(labelText: 'Connection type'),
                items: const [
                  DropdownMenuItem(value: 'mcp', child: Text('MCP')),
                  DropdownMenuItem(value: 'openapi', child: Text('OpenAPI')),
                ],
                onChanged: c.busy
                    ? null
                    : (value) => setState(() => _kind = value!),
              ),
              TextField(
                key: PageStorageKey((
                  'connector-exact-input',
                  c,
                  c.owner.key,
                  _kind,
                )),
                controller: _exactId,
                enabled: !c.busy,
                decoration: const InputDecoration(labelText: 'Connection ID'),
                maxLength: 200,
              ),
              OutlinedButton(
                onPressed: c.busy
                    ? null
                    : () {
                        try {
                          _select(_kind, controlId(_exactId.text.trim()));
                        } catch (_) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(
                              content: Text(
                                'Enter the complete connection ID.',
                              ),
                            ),
                          );
                        }
                      },
                child: const Text('Read exact connection'),
              ),
            ],
          ),
          if (c.reading)
            const Padding(
              padding: EdgeInsets.all(20),
              child: LinearProgressIndicator(),
            ),
          if (c.selected != null) ..._review(c.selected!),
          const SizedBox(height: 24),
        ],
      );
    },
  );

  void _select(String kind, String id) {
    if (!_visible) {
      return;
    }
    _viewEpoch++;
    unawaited(c.select(kind, id));
  }

  Widget _pending() {
    final held = c.pending!;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              held.dispatched
                  ? 'Unconfirmed connector action'
                  : 'Prepared action not sent',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            Text(
              '${connectorActionLabel(held.intent.action)} · ${held.intent.kind.toUpperCase()} ${held.intent.id}',
            ),
            const Text(
              'This exact submission is protected on this device. Checking its receipt never resends the action.',
            ),
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                OutlinedButton(
                  onPressed: c.busy ? null : c.recover,
                  child: const Text('Check exact receipt'),
                ),
                if (!held.dispatched && !c.storageUnconfirmed)
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

  Widget _receipt() {
    final saved = c.accepted!,
        accepted = saved.response.acceptance!,
        settlement = saved.response.action!['settlement'];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              saved.settled
                  ? 'Connector action confirmed'
                  : 'Connector action accepted; result unconfirmed',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            Text(
              '${connectorActionLabel(saved.intent.action)} · ${saved.intent.kind.toUpperCase()} ${saved.intent.id}',
            ),
            Text('Accepted ${accepted['acceptedAt']}'),
            if (settlement is Map)
              Text(
                'State ${settlement['result']['status']} · ${settlement['result']['contractCount']} contracts · ${settlement['result']['promotedCount']} approved',
              ),
            if (c.storageUnconfirmed)
              OutlinedButton(
                onPressed: c.busy ? null : c.saveAcceptedLocally,
                child: const Text('Save verified receipt locally'),
              ),
            ExpansionTile(
              key: PageStorageKey(('connector-receipt', c, accepted['id'])),
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

  List<Widget> _review(ConnectorReview review) {
    if (review.value == null) {
      return [
        const Padding(
          padding: EdgeInsets.all(16),
          child: Text('This exact connection is not currently available.'),
        ),
        if (c.selectedKind == 'mcp' && c.selectedId != null)
          OutlinedButton(
            onPressed: c.busy
                ? null
                : () => _openCredentialRemoval(c.selectedId!),
            child: const Text('Open saved credential recovery'),
          ),
      ];
    }
    final row = review.connector!,
        contracts = review.value!['contracts'] as List;
    return [
      const Divider(height: 32),
      Text(
        row['name'] as String,
        style: Theme.of(context).textTheme.headlineSmall,
      ),
      SelectableText('${row['kind']} · ${row['id']}\n${row['endpoint']}'),
      if (row['endpointRedacted'] == true)
        const Text('Endpoint query and fragment are hidden.'),
      Text(
        'State: ${row['status']} · risk ${row['defaultRiskLevel']} · ${row['approvalRequired'] == true ? 'approval required' : 'reviewed lower-risk access'}',
      ),
      Text(
        'Credentials: ${row['credentialConfigured'] == true ? 'configured' : 'not configured'} · version ${row['credentialVersion']} · ${row['credentialOriginMatch'] == true ? 'origin matches' : 'origin not confirmed'}',
      ),
      Text('Updated ${row['updatedAt']}'),
      if (review.value!['unavailableReason'] != null)
        const Text(
          'A complete bounded review is unavailable. No change can be submitted from this view.',
        ),
      const SizedBox(height: 12),
      Text(
        'Current contracts (${contracts.length})',
        style: Theme.of(context).textTheme.titleMedium,
      ),
      for (final raw in contracts) _contract(connectorMap(raw), row),
      const SizedBox(height: 12),
      Wrap(
        spacing: 12,
        runSpacing: 8,
        children: [
          for (final action in review.actions)
            FilledButton(
              onPressed: c.canAct ? () => _confirm(review, action) : null,
              child: Text(connectorActionLabel(action)),
            ),
          if (row['kind'] == 'mcp')
            OutlinedButton.icon(
              onPressed: c.busy
                  ? null
                  : () => _openCredentialRemoval(row['id'] as String),
              icon: const Icon(Icons.key_outlined),
              label: const Text('Review saved credential'),
            ),
          if (row['kind'] == 'mcp' && c.mayManage)
            OutlinedButton.icon(
              onPressed: c.busy
                  ? null
                  : () => _openCredentialRotation(row['id'] as String),
              icon: const Icon(Icons.key),
              label: const Text('Prepare bearer credential'),
            ),
          if (row['kind'] == 'mcp')
            OutlinedButton.icon(
              onPressed: c.busy
                  ? null
                  : () => _openMcpDiscovery(row['id'] as String),
              icon: const Icon(Icons.refresh),
              label: const Text('Review tool discovery'),
            ),
          if (row['kind'] == 'mcp' &&
              row['endpointRedacted'] == false &&
              legacyOfficialGithubMcpEndpoint(row['endpoint']) &&
              c.mayManage)
            _GithubUpgradeEntry(
              review: review,
              busy: c.busy,
              onPressed: () => _openGithubUpgrade(row['id'] as String),
            ),
          if (row['kind'] == 'mcp' &&
              review.pin != null &&
              review.value!['unavailableReason'] == null &&
              c.mayManage)
            OutlinedButton.icon(
              onPressed: c.busy ? null : () => _openTrash(row['id'] as String),
              icon: const Icon(Icons.delete_outline),
              label: const Text('Review move to Trash'),
            ),
          OutlinedButton(
            onPressed: c.busy
                ? null
                : () => _select(row['kind'] as String, row['id'] as String),
            child: const Text('Reload this review'),
          ),
        ],
      ),
      if (review.actions.isEmpty && review.value!['unavailableReason'] == null)
        const Text('No current action is available with this account access.'),
    ];
  }

  Future<void> _openMcpRegistration() async {
    if (!_visible || c.busy) {
      return;
    }
    final controller = c, epoch = _viewEpoch;
    final route = MaterialPageRoute<String>(
      builder: (_) => const NativeConnectorMcpRegistrationWorkspace(),
    );
    final id = await Navigator.of(context).push<String>(route);
    await route.completed;
    await WidgetsBinding.instance.endOfFrame;
    if (mounted &&
        identical(controller, c) &&
        _visible &&
        epoch == _viewEpoch) {
      if (id != null) {
        await controller.select('mcp', id);
      } else {
        await controller.refresh();
      }
    }
  }

  Future<void> _openOpenApiImport() async {
    if (!_visible || c.busy) {
      return;
    }
    final controller = c, epoch = _viewEpoch;
    final route = MaterialPageRoute<String>(
      builder: (_) => const NativeConnectorOpenApiImportWorkspace(),
    );
    final id = await Navigator.of(context).push<String>(route);
    // Pop returns before the outgoing transition restores the controls'
    // TickerMode. Wait for visible presentation, then recheck its authority.
    await route.completed;
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted ||
        !identical(controller, c) ||
        !_visible ||
        epoch != _viewEpoch) {
      return;
    }
    if (id != null) {
      // A new target need not occur on the inventory's first page.
      await controller.select('openapi', id);
    } else {
      await controller.refresh();
    }
  }

  Future<void> _openCredentialRotation([String? id]) async {
    if (!_visible || c.busy) {
      return;
    }
    final controller = c, epoch = _viewEpoch;
    final route = MaterialPageRoute<String>(
      builder: (_) =>
          NativeConnectorCredentialRotationWorkspace(connectorId: id),
    );
    final result = await Navigator.of(
      context,
      rootNavigator: true,
    ).push<String>(route);
    await route.completed;
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted ||
        !identical(controller, c) ||
        !_visible ||
        epoch != _viewEpoch) {
      return;
    }
    final target = result ?? id;
    if (target != null) {
      await controller.select('mcp', target);
    } else {
      await controller.refresh();
    }
  }

  Future<void> _openMcpDiscovery([String? id]) async {
    if (!_visible || c.busy) {
      return;
    }
    final controller = c, epoch = _viewEpoch;
    final route = MaterialPageRoute<String>(
      builder: (_) => NativeConnectorMcpDiscoveryWorkspace(connectorId: id),
    );
    final target = await Navigator.of(context).push<String>(route);
    await route.completed;
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted ||
        !identical(controller, c) ||
        !_visible ||
        epoch != _viewEpoch) {
      return;
    }
    if (target != null) {
      await controller.select('mcp', target);
    } else if (id != null) {
      await controller.select('mcp', id);
    } else {
      await controller.refresh();
    }
  }

  Future<void> _openGithubUpgrade([String? id]) async {
    if (!_visible || c.busy) return;
    final controller = c, epoch = _viewEpoch;
    final route = MaterialPageRoute<String>(
      builder: (_) => NativeConnectorGithubUpgradeWorkspace(connectorId: id),
    );
    final target = await Navigator.of(context).push<String>(route);
    await route.completed;
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted ||
        !identical(controller, c) ||
        !_visible ||
        epoch != _viewEpoch) {
      return;
    }
    if (target != null) {
      await controller.select('mcp', target);
    } else if (id != null) {
      await controller.select('mcp', id);
    } else {
      await controller.refresh();
    }
  }

  Future<void> _openTrash([String? id]) async {
    if (!_visible || c.busy) return;
    final controller = c;
    await Navigator.of(context, rootNavigator: true).push(
      MaterialPageRoute<void>(
        builder: (_) => NativeConnectorTrashWorkspace(connectorId: id),
      ),
    );
    if (mounted && identical(controller, c) && _visible) {
      unawaited(c.refresh());
      if (id != null) unawaited(c.select('mcp', id));
    }
  }

  Future<void> _openCredentialRemoval(String id) async {
    if (!_visible || c.busy) return;
    final controller = c;
    await Navigator.of(context, rootNavigator: true).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            NativeConnectorCredentialRemovalWorkspace(connectorId: id),
      ),
    );
    if (mounted && identical(controller, c) && _visible) {
      unawaited(c.select('mcp', id));
    }
  }

  Widget _contract(
    ConnectorJson contract,
    ConnectorJson connector,
  ) => ExpansionTile(
    key: PageStorageKey((
      'connector-contract',
      c,
      connector['kind'],
      connector['id'],
      contract['id'],
      contract['fingerprint'],
    )),
    title: Text(contract['name'] as String),
    subtitle: Text(
      '${contract['status']} · risk ${contract['riskLevel']} · ${contract['approvalRequired'] == true ? 'approval required' : 'no additional approval flag'}',
    ),
    childrenPadding: const EdgeInsets.all(12),
    children: [
      if (contract['description'] != null)
        Text(contract['description'] as String),
      SelectableText(
        const JsonEncoder.withIndent('  ').convert(contract['definition']),
      ),
    ],
  );
  Future<void> _confirm(ConnectorReview review, String action) async {
    if (!_visible || !c.canAct) {
      return;
    }
    final controller = c, epoch = _viewEpoch;
    final confirmed = await showDialog<bool>(
      context: context,
      useRootNavigator: false,
      builder: (dialogContext) => AlertDialog(
        scrollable: true,
        title: Text(connectorActionLabel(action)),
        content: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(review.connector!['name'] as String),
            SelectableText(
              '${review.connector!['kind']} · ${review.connector!['id']}\n${review.connector!['endpoint']}',
            ),
            const SizedBox(height: 12),
            Text(
              action == 'review_contracts'
                  ? 'Approve the exact ${review.connector!['contractCount']} contracts shown in this review and activate this connection. Consequential tool use remains governed by its approval rules.'
                  : action == 'disable'
                  ? 'Disable this exact MCP connection. This does not revoke its stored credentials.'
                  : 'Enable this exact MCP connection using its current reviewed configuration.',
            ),
            const SizedBox(height: 12),
            const Text(
              'The current server review is checked again before submission. An unconfirmed response is recovered by receipt lookup only.',
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
            child: const Text('Confirm action'),
          ),
        ],
      ),
    );
    if (confirmed != true ||
        !mounted ||
        !identical(controller, c) ||
        !_visible ||
        epoch != _viewEpoch) {
      return;
    }
    await c.act(
      review,
      action,
      () =>
          mounted &&
          identical(controller, c) &&
          _visible &&
          epoch == _viewEpoch,
    );
  }
}

/// The public connector review normalizes its endpoint. Only the dedicated
/// server proof can establish that the stored endpoint is an eligible legacy
/// GitHub URL; its pin must still match the review rendered above this action.
class _GithubUpgradeEntry extends ConsumerStatefulWidget {
  const _GithubUpgradeEntry({
    required this.review,
    required this.busy,
    required this.onPressed,
  });

  final ConnectorReview review;
  final bool busy;
  final VoidCallback onPressed;

  @override
  ConsumerState<_GithubUpgradeEntry> createState() =>
      _GithubUpgradeEntryState();
}

class _GithubUpgradeEntryState extends ConsumerState<_GithubUpgradeEntry> {
  NativeWorkspaceAccess? _access;
  ApiConnectorGithubUpgradeRepository? _repository;
  Future<ConnectorGithubUpgradeReview>? _proof;
  String? _connectorId, _reviewSha256;

  void _clear() {
    _repository?.close();
    _repository = null;
    _proof = null;
    _access = null;
    _connectorId = null;
    _reviewSha256 = null;
  }

  @override
  void dispose() {
    _clear();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final access = ref.watch(nativeWorkspaceAccessProvider);
    final id = widget.review.connector?['id'];
    final digest = widget.review.pin?['reviewSha256'];
    if (access == null ||
        !access.current ||
        !const ['admin', 'system'].contains(access.authority.role) ||
        id is! String ||
        digest is! String) {
      _clear();
      return const SizedBox.shrink();
    }
    if (!identical(_access, access) ||
        _connectorId != id ||
        _reviewSha256 != digest) {
      _clear();
      _access = access;
      _connectorId = id;
      _reviewSha256 = digest;
      final repository = ApiConnectorGithubUpgradeRepository(access);
      _repository = repository;
      _proof = repository.eligibility(id);
    }
    return FutureBuilder<ConnectorGithubUpgradeReview>(
      future: _proof,
      builder: (context, snapshot) {
        if (!snapshot.hasData ||
            !snapshot.data!.matches(widget.review) ||
            !_repository!.current) {
          return const SizedBox.shrink();
        }
        return OutlinedButton.icon(
          onPressed: widget.busy
              ? null
              : () {
                  if (_repository?.current == true &&
                      snapshot.data!.matches(widget.review)) {
                    widget.onPressed();
                  }
                },
          icon: const Icon(Icons.upgrade),
          label: const Text('Expand GitHub tools'),
        );
      },
    );
  }
}
