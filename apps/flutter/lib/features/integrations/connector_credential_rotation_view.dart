import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/native_workspace_access.dart';
import 'connector_contracts.dart';
import 'connector_credential_rotation_contracts.dart';
import 'connector_credential_rotation_controller.dart';
import 'connector_credential_rotation_providers.dart';

class NativeConnectorCredentialRotationWorkspace extends StatelessWidget {
  const NativeConnectorCredentialRotationWorkspace({
    super.key,
    this.connectorId,
  });
  final String? connectorId;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('MCP bearer credential')),
    body: _RotationRouteVisibility(
      current: ModalRoute.isCurrentOf(context) ?? true,
      child: NativePrivateWorkspace(
        ownNavigator: true,
        builder: (_) => Consumer(
          builder: (context, ref, _) {
            final controller = ref.watch(
              connectorCredentialRotationControllerProvider,
            );
            if (controller == null || !controller.current) {
              return const Center(
                child: Text(
                  'Unlock this workspace to review credential recovery.',
                ),
              );
            }
            return ConnectorCredentialRotationPanel(
              key: ObjectKey(controller),
              controller: controller,
              initialConnectorId: connectorId,
              routeCurrent: _RotationRouteVisibility.of(context),
            );
          },
        ),
      ),
    ),
  );
}

class _RotationRouteVisibility extends InheritedWidget {
  const _RotationRouteVisibility({required this.current, required super.child});
  final bool current;
  static bool of(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<_RotationRouteVisibility>()!
      .current;
  @override
  bool updateShouldNotify(_RotationRouteVisibility oldWidget) =>
      current != oldWidget.current;
}

class ConnectorCredentialRotationPanel extends StatefulWidget {
  const ConnectorCredentialRotationPanel({
    super.key,
    required this.controller,
    this.initialConnectorId,
    this.routeCurrent = true,
  });
  final ConnectorCredentialRotationController controller;
  final String? initialConnectorId;
  final bool routeCurrent;
  @override
  State<ConnectorCredentialRotationPanel> createState() =>
      _ConnectorCredentialRotationPanelState();
}

class _ConnectorCredentialRotationPanelState
    extends State<ConnectorCredentialRotationPanel>
    with WidgetsBindingObserver {
  final _token = TextEditingController();
  bool _foreground = true,
      _confirming = false,
      _wasVisible = true,
      _workspaceWasVisible = true;
  int _viewEpoch = 0;
  ConnectorCredentialRotationController get c => widget.controller;
  bool get _visible =>
      mounted &&
      _foreground &&
      widget.routeCurrent &&
      c.current &&
      (ModalRoute.isCurrentOf(context) ?? true) &&
      TickerMode.valuesOf(context).enabled;
  void _clearSecret() {
    if (mounted) {
      _token.clear();
    }
  }

  void _changed() {
    if (!c.current) {
      _clearSecret();
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    c.addListener(_changed);
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
      _clearSecret();
    }
    _workspaceWasVisible = workspaceVisible;
    final visible = _visible;
    if (!visible && _wasVisible && !_confirming) {
      _viewEpoch++;
      _clearSecret();
    }
    _wasVisible = visible;
  }

  @override
  void didUpdateWidget(covariant ConnectorCredentialRotationPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, c)) {
      oldWidget.controller.removeListener(_changed);
      c.addListener(_changed);
      _viewEpoch++;
      _clearSecret();
      unawaited(_load());
    }
    if (oldWidget.routeCurrent != widget.routeCurrent) {
      _viewEpoch++;
      _clearSecret();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _viewEpoch++;
    _clearSecret();
    if (mounted) {
      setState(() {});
    }
  }

  @override
  void dispose() {
    _viewEpoch++;
    c.removeListener(_changed);
    _token.clear();
    _token.dispose();
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
        key: PageStorageKey(('credential-rotation-list', c)),
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Save or replace an MCP bearer credential',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          const Text(
            'Prepare a token for this existing endpoint, then review and confirm its save. Saving disables the connection and removes its discovered tools. Provider tokens remain valid until revoked with the provider.',
          ),
          if (!c.mayChange)
            const Text(
              'Your current access permits recovery and abandonment of your staging. An administrator is required to prepare or save a credential.',
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
              if (c.storageUnconfirmed && c.loaded)
                OutlinedButton(
                  onPressed: c.busy ? null : c.saveLocally,
                  child: const Text('Save retained evidence locally'),
                ),
            ],
          ),
          if (c.reading || c.busy) const LinearProgressIndicator(),
          if (c.error != null) _error(c.error!),
          if (c.readError != null) _error(c.readError!),
          if (c.sequence != null) _recovery(),
          if (c.reviewed != null) ..._review(),
          if (c.reviewed == null && !c.reading)
            const Text(
              'Open an existing MCP connection to prepare a credential. Protected recovery remains available here even when a connection is absent from the list.',
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
  List<Widget> _review() {
    final review = c.reviewed!, row = review.connector;
    if (row == null) {
      return [
        const Text(
          'This exact connection is unavailable. Its protected preparation or action can still be recovered.',
        ),
      ];
    }
    return [
      const Divider(height: 32),
      Text(
        row['name'] as String,
        style: Theme.of(context).textTheme.titleLarge,
      ),
      SelectableText('${row['id']}\n${row['endpoint']}'),
      Text(
        'Credential version ${row['credentialVersion']} · ${(review.value!['contracts'] as List).length} reviewed tools',
      ),
      if (row['endpointRedacted'] == true)
        const Text('Endpoint query and fragment are hidden.'),
      if (!credentialRotationEligible(review))
        const Text(
          'A complete supported MCP review with app-managed bearer or unconfigured authentication is required.',
        ),
      if (c.canPrepare) ...[
        const SizedBox(height: 12),
        TextField(
          key: PageStorageKey(('credential-rotation-token', c)),
          controller: _token,
          obscureText: true,
          enableSuggestions: false,
          autocorrect: false,
          enableIMEPersonalizedLearning: false,
          decoration: const InputDecoration(
            labelText: 'New bearer token',
            helperText:
                '8–8192 UTF-8 bytes; no surrounding whitespace or line breaks.',
          ),
          onChanged: (_) => setState(() {}),
        ),
        const Text(
          'The token is sent once for a 15-minute preparation. It is not saved in device recovery. Preparing does not change this connection.',
        ),
        Align(
          alignment: Alignment.centerLeft,
          child: FilledButton(
            onPressed: credentialRotationTokenValid(_token.text)
                ? _prepare
                : null,
            child: const Text('Prepare credential'),
          ),
        ),
      ],
      if (c.sequence?.prepared?.availability == 'ready' &&
          c.sequence?.finalIntent == null)
        Align(
          alignment: Alignment.centerLeft,
          child: FilledButton(
            onPressed: c.canConfirm ? _confirm : null,
            child: const Text('Review and confirm credential save'),
          ),
        ),
    ];
  }

  Widget _recovery() {
    final s = c.sequence!, p = s.prepared;
    final title = s.action?.settled == true
        ? 'Credential save confirmed'
        : s.finalIntent != null
        ? 'Credential save unconfirmed'
        : p?.availability == 'abandoned'
        ? 'Preparation abandoned'
        : s.abandonDispatched
        ? 'Abandonment unconfirmed'
        : p?.availability == 'ready'
        ? 'Credential prepared'
        : p?.availability == 'expired'
        ? 'Preparation expired'
        : s.prepareDispatched
        ? 'Preparation unconfirmed'
        : 'Local preparation not sent';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            SelectableText('Connection ${s.intent.id}'),
            if (p?.proof != null)
              Text(
                'Original preparation deadline: ${p!.proof!.raw['expiresAt']}',
              ),
            if (p?.availability == 'ready' && !p!.proof!.freshAt(c.now()))
              const Text(
                'This preparation is no longer fresh. Read its exact state or abandon it before starting again.',
              ),
            if (s.finalIntent != null && s.action?.settled != true)
              const Text(
                'Only the original action receipt can settle this save. The token and final action will not be submitted again.',
              ),
            if (s.finalIntent == null && !s.terminal)
              const Text(
                'Checking recovery does not send the token. An unobserved preparation stays pending until its exact state or explicit abandonment is confirmed.',
              ),
            if (p?.availability == 'expired')
              const Text(
                'Expiry prevents a fresh save. It does not establish when staging storage was physically scrubbed.',
              ),
            if (p?.availability == 'abandoned')
              const Text(
                'The server permanently closed this preparation. It did not change the connector or revoke a provider token.',
              ),
            if (s.action?.settled == true) ...[
              Text(
                'Saved credential version ${connectorMap(connectorMap(s.action!.action!['settlement'])['result'])['credentialVersion']}',
              ),
              const Text(
                'This historical receipt records a saved credential, a disabled connection and zero discovered tools. It does not establish current provider connectivity or tool readiness. Rediscovery and review are still required in the browser.',
              ),
              const NativeWorkspaceBrowserButton(
                path: '/app/connectors',
                label: 'Open connectors in browser',
              ),
            ],
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                if (s.prepareDispatched && !s.terminal)
                  OutlinedButton(
                    onPressed: c.busy ? null : c.recover,
                    child: Text(
                      s.finalIntent == null
                          ? 'Check exact preparation'
                          : 'Check exact action receipt',
                    ),
                  ),
                if (c.canAbandon)
                  TextButton(
                    onPressed: _abandon,
                    child: const Text('Abandon preparation'),
                  ),
                if (!s.prepareDispatched && !c.storageUnconfirmed)
                  TextButton(
                    onPressed: c.busy ? null : c.discardLocal,
                    child: const Text('Discard local preparation'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _prepare() async {
    if (!_visible || !c.canPrepare) {
      _clearSecret();
      return;
    }
    final controller = c, epoch = _viewEpoch, review = c.reviewed!;
    await controller.prepare(
      review,
      _token.text,
      () =>
          mounted &&
          identical(controller, c) &&
          _visible &&
          epoch == _viewEpoch,
      clearSecret: _clearSecret,
    );
  }

  Future<bool> _dialog(String title, Widget body, String confirm) async {
    _confirming = true;
    try {
      return await showDialog<bool>(
            context: context,
            useRootNavigator: false,
            builder: (context) => AlertDialog(
              scrollable: true,
              title: Text(title),
              content: body,
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(context).pop(false),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  onPressed: () => Navigator.of(context).pop(true),
                  child: Text(confirm),
                ),
              ],
            ),
          ) ==
          true;
    } finally {
      _confirming = false;
    }
  }

  Future<void> _confirm() async {
    if (!_visible || !c.canConfirm) {
      return;
    }
    final controller = c,
        epoch = _viewEpoch,
        review = c.reviewed!,
        held = c.sequence!;
    final confirmed = await _dialog(
      'Save this bearer credential?',
      Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(review.connector!['name'] as String),
          SelectableText('${held.intent.id}\n${review.connector!['endpoint']}'),
          Text(
            'Replace/save credential version ${held.intent.review['credentialVersion']} and remove ${(review.value!['contracts'] as List).length} reviewed tools.',
          ),
          Text('Preparation expires ${held.prepared!.proof!.raw['expiresAt']}'),
          const Text(
            'The connection will be disabled. Rediscovery and review require the browser. Existing provider tokens remain valid until revoked with the provider.',
          ),
        ],
      ),
      'Confirm credential save',
    );
    if (!confirmed ||
        !mounted ||
        !identical(controller, c) ||
        !_visible ||
        epoch != _viewEpoch) {
      return;
    }
    await controller.confirm(
      review,
      () =>
          mounted &&
          identical(controller, c) &&
          _visible &&
          epoch == _viewEpoch,
    );
  }

  Future<void> _abandon() async {
    if (!_visible || !c.canAbandon) {
      return;
    }
    final controller = c, epoch = _viewEpoch;
    final confirmed = await _dialog(
      'Abandon this preparation?',
      const Text(
        'Permanently close this exact staged credential attempt. This removes its staging authority without changing the connector or revoking a provider token.',
      ),
      'Confirm abandonment',
    );
    if (!confirmed ||
        !mounted ||
        !identical(controller, c) ||
        !_visible ||
        epoch != _viewEpoch) {
      return;
    }
    await controller.abandon(
      () =>
          mounted &&
          identical(controller, c) &&
          _visible &&
          epoch == _viewEpoch,
    );
  }
}
