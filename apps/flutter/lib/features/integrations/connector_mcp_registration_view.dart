import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/native_workspace_access.dart';
import 'connector_contracts.dart';
import 'connector_mcp_registration_contracts.dart';
import 'connector_mcp_registration_controller.dart';
import 'connector_mcp_registration_providers.dart';

class NativeConnectorMcpRegistrationWorkspace extends StatelessWidget {
  const NativeConnectorMcpRegistrationWorkspace({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('New MCP connection')),
    body: _RegistrationRouteVisibility(
      current: ModalRoute.isCurrentOf(context) ?? true,
      child: NativePrivateWorkspace(
        ownNavigator: true,
        builder: (_) => Consumer(
          builder: (context, ref, _) {
            final controller = ref.watch(
              connectorMcpRegistrationControllerProvider,
            );
            if (controller == null || !controller.current) {
              return const Center(
                child: Text(
                  'Unlock this workspace to review registration recovery.',
                ),
              );
            }
            return Material(
              color: Theme.of(context).scaffoldBackgroundColor,
              child: ConnectorMcpRegistrationPanel(
                key: ObjectKey(controller),
                controller: controller,
                routeCurrent: _RegistrationRouteVisibility.of(context),
              ),
            );
          },
        ),
      ),
    ),
  );
}

class _RegistrationRouteVisibility extends InheritedWidget {
  const _RegistrationRouteVisibility({
    required this.current,
    required super.child,
  });
  final bool current;
  static bool of(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<_RegistrationRouteVisibility>()!
      .current;
  @override
  bool updateShouldNotify(_RegistrationRouteVisibility oldWidget) =>
      current != oldWidget.current;
}

class ConnectorMcpRegistrationPanel extends StatefulWidget {
  const ConnectorMcpRegistrationPanel({
    super.key,
    required this.controller,
    this.routeCurrent = true,
  });
  final ConnectorMcpRegistrationController controller;
  final bool routeCurrent;
  @override
  State<ConnectorMcpRegistrationPanel> createState() =>
      _ConnectorMcpRegistrationPanelState();
}

class _ConnectorMcpRegistrationPanelState
    extends State<ConnectorMcpRegistrationPanel>
    with WidgetsBindingObserver {
  final _name = TextEditingController();
  final _endpoint = TextEditingController();
  final _token = TextEditingController();
  final _environment = TextEditingController();
  String _authType = 'none';
  int _risk = 2;
  bool _approval = true;
  bool _foreground = true,
      _confirming = false,
      _wasVisible = true,
      _workspaceWasVisible = true;
  int _viewEpoch = 0;
  ConnectorMcpRegistrationController get c => widget.controller;
  bool get _visible =>
      mounted &&
      _foreground &&
      widget.routeCurrent &&
      c.current &&
      (ModalRoute.isCurrentOf(context) ?? true) &&
      TickerMode.valuesOf(context).enabled;
  void _clearSecret() {
    if (mounted) {
      _endpoint.clear();
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
  void didUpdateWidget(covariant ConnectorMcpRegistrationPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, c)) {
      oldWidget.controller.removeListener(_changed);
      c.addListener(_changed);
      _viewEpoch++;
      _clearSecret();
      _name.clear();
      _environment.clear();
      _authType = 'none';
      _risk = 2;
      _approval = true;
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
    _endpoint.clear();
    _token.clear();
    _name.dispose();
    _endpoint.dispose();
    _token.dispose();
    _environment.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  ConnectorJson? get _draft {
    try {
      if (_authType == 'bearer_vault' &&
          !mcpRegistrationTokenValid(_token.text)) {
        return null;
      }
      return mcpRegistrationDeclaration(
        name: _name.text,
        endpoint: _endpoint.text,
        authType: _authType,
        authTokenEnv: _authType == 'bearer_env'
            ? _environment.text.trim().toUpperCase()
            : null,
        defaultRiskLevel: _risk,
        approvalRequired: _approval,
      );
    } catch (_) {
      return null;
    }
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
            'Return to the unlocked workspace to review this registration.',
          ),
        );
      }
      return ListView(
        key: PageStorageKey(('mcp-registration-list', c)),
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'New MCP connection',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          const Text(
            'Prepare a streamable HTTP connection, then confirm its local creation. The new connection starts disabled with no tools. Setup does not contact the provider or discover tools.',
          ),
          if (!c.mayChange)
            const Text(
              'Your current access permits recovery and abandonment of your staging. An administrator is required to prepare or create a connection.',
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
          if (c.busy) const LinearProgressIndicator(),
          if (c.error != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(
                c.error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          if (c.sequence != null) _recovery(),
          if (c.canPrepare) ..._form(),
        ],
      );
    },
  );

  List<Widget> _form() => [
    const Divider(height: 32),
    TextField(
      key: PageStorageKey(('mcp-registration-name', c)),
      controller: _name,
      maxLength: 120,
      decoration: const InputDecoration(labelText: 'Connection name'),
      onChanged: (_) => setState(() {}),
    ),
    TextField(
      key: PageStorageKey(('mcp-registration-endpoint', c)),
      controller: _endpoint,
      obscureText: true,
      enableSuggestions: false,
      autocorrect: false,
      enableIMEPersonalizedLearning: false,
      keyboardType: TextInputType.url,
      decoration: const InputDecoration(
        labelText: 'Full MCP endpoint',
        helperText: 'HTTP(S) URL, including any required query or fragment.',
      ),
      onChanged: (_) => setState(() {}),
    ),
    const Text(
      'Use an ASCII hostname or dotted IPv4 address and a percent-encoded path. For international hostnames, use their ASCII form. Use browser setup for other URL formats, including IPv6.',
    ),
    const NativeWorkspaceBrowserButton(
      path: '/app/connectors',
      label: 'Open browser setup',
    ),
    DropdownButtonFormField<String>(
      key: PageStorageKey(('mcp-registration-auth', c)),
      initialValue: _authType,
      decoration: const InputDecoration(labelText: 'Authentication'),
      items: const [
        DropdownMenuItem(value: 'none', child: Text('No authentication')),
        DropdownMenuItem(
          value: 'bearer_env',
          child: Text('Deployer-bound environment handle'),
        ),
        DropdownMenuItem(
          value: 'bearer_vault',
          child: Text('Saved bearer token'),
        ),
      ],
      onChanged: (value) {
        if (value != null) {
          setState(() {
            _authType = value;
            _token.clear();
          });
        }
      },
    ),
    if (_authType == 'bearer_env') ...[
      TextField(
        key: PageStorageKey(('mcp-registration-environment', c)),
        controller: _environment,
        decoration: const InputDecoration(
          labelText: 'Environment handle',
          helperText: 'Enter the configured handle, never its secret value.',
        ),
        onChanged: (_) => setState(() {}),
      ),
      const Text(
        'A deployer must already have bound this handle to your tenant and the exact endpoint origin. Setup does not create a binding or copy an environment secret.',
      ),
    ],
    if (_authType == 'bearer_vault') ...[
      TextField(
        key: PageStorageKey(('mcp-registration-token', c)),
        controller: _token,
        obscureText: true,
        enableSuggestions: false,
        autocorrect: false,
        enableIMEPersonalizedLearning: false,
        decoration: const InputDecoration(
          labelText: 'Bearer token',
          helperText:
              '8–8192 UTF-8 bytes; no surrounding whitespace or line breaks.',
        ),
        onChanged: (_) => setState(() {}),
      ),
      const Text(
        'Saved tokens and private endpoint query/fragment staging require protected credential storage on the server.',
      ),
    ],
    DropdownButtonFormField<int>(
      key: PageStorageKey(('mcp-registration-risk', c)),
      initialValue: _risk,
      decoration: const InputDecoration(labelText: 'Default tool risk'),
      items: const [
        DropdownMenuItem(value: 0, child: Text('0 · Minimal')),
        DropdownMenuItem(value: 1, child: Text('1 · Low')),
        DropdownMenuItem(value: 2, child: Text('2 · Moderate')),
        DropdownMenuItem(value: 3, child: Text('3 · High')),
      ],
      onChanged: (value) {
        if (value != null) {
          setState(() => _risk = value);
        }
      },
    ),
    SwitchListTile(
      contentPadding: EdgeInsets.zero,
      title: const Text('Require approval'),
      value: _approval,
      onChanged: (value) => setState(() => _approval = value),
    ),
    const Text(
      'The endpoint and optional token are sent once for a 15-minute preparation. Device recovery keeps only the public declaration and exact receipts. Input is cleared when this view is hidden or preparation may be sent.',
    ),
    Align(
      alignment: Alignment.centerLeft,
      child: FilledButton(
        onPressed: _draft == null ? null : _prepare,
        child: const Text('Prepare new MCP connection'),
      ),
    ),
  ];

  Widget _declaration(ConnectorJson declaration) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        declaration['name'] as String,
        style: Theme.of(context).textTheme.titleMedium,
      ),
      SelectableText(declaration['endpoint'] as String),
      if (declaration['endpointRedacted'] == true)
        const Text('Endpoint query and fragment are hidden.'),
      Text(
        'Authentication: ${switch (declaration['authType']) {
          'bearer_env' => 'deployer-bound environment handle',
          'bearer_vault' => 'saved bearer token',
          _ => 'none',
        }}',
      ),
      if (declaration['authTokenEnv'] != null)
        SelectableText('Handle: ${declaration['authTokenEnv']}'),
      Text(
        'Default risk ${declaration['defaultRiskLevel']} · ${declaration['approvalRequired'] == true ? 'approval required' : 'no additional approval flag'}',
      ),
    ],
  );

  Widget _recovery() {
    final s = c.sequence!, p = s.prepared;
    final title = s.action?.settled == true
        ? 'MCP registration confirmed'
        : s.finalIntent != null
        ? 'MCP registration unconfirmed'
        : p?.availability == 'abandoned'
        ? 'Preparation abandoned'
        : s.abandonDispatched
        ? 'Abandonment unconfirmed'
        : p?.availability == 'ready'
        ? 'MCP registration prepared'
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
            Text(title, style: Theme.of(context).textTheme.titleLarge),
            SelectableText('Connection ${s.intent.id}'),
            _declaration(s.intent.declaration),
            if (p?.proof != null)
              Text(
                'Original preparation deadline: ${p!.proof!.raw['expiresAt']}',
              ),
            if (p?.availability == 'ready' && !p!.proof!.freshAt(c.now()))
              const Text(
                'This preparation is no longer fresh. Check its exact state or abandon it before starting again.',
              ),
            if (s.finalIntent != null && s.action?.settled != true)
              const Text(
                'Only the original action receipt can settle this registration. Its final action will not be submitted again.',
              ),
            if (s.finalIntent == null && !s.terminal)
              const Text(
                'Recovery does not send the endpoint or token. An unobserved attempt stays pending until its exact state or explicit abandonment is confirmed.',
              ),
            if (p?.availability == 'expired')
              const Text(
                'Expiry prevents new creation. It does not establish when staging was physically scrubbed.',
              ),
            if (p?.availability == 'abandoned')
              const Text(
                'The server permanently closed this preparation. This did not create a connection or revoke a provider token.',
              ),
            if (s.action?.settled == true) ...[
              const Text(
                'This historical receipt records a disabled local MCP connection with zero tools. It does not establish current provider connectivity or tool readiness. Discover and review tools in the browser before enabling it.',
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
                          : 'Check exact creation receipt',
                    ),
                  ),
                if (c.canConfirm)
                  FilledButton(
                    onPressed: _confirm,
                    child: const Text('Review and confirm creation'),
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
    final draft = _draft;
    if (!_visible || !c.canPrepare || draft == null) {
      _clearSecret();
      return;
    }
    final controller = c, epoch = _viewEpoch;
    await controller.prepare(
      draft,
      _endpoint.text,
      _authType == 'bearer_vault' ? _token.text : null,
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
    final controller = c, epoch = _viewEpoch;
    // A saved/recovered ready label is historical. Read the original key before
    // presenting its unchanged proof for this distinct visible confirmation.
    await controller.recover();
    if (!mounted ||
        !identical(controller, c) ||
        !_visible ||
        epoch != _viewEpoch ||
        !c.canConfirm ||
        c.error != null) {
      return;
    }
    final held = c.sequence!;
    final confirmed = await _dialog(
      'Create this disabled MCP connection?',
      Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _declaration(held.intent.declaration),
          SelectableText(held.intent.id),
          Text('Preparation expires ${held.prepared!.proof!.raw['expiresAt']}'),
          const Text(
            'Create this local configuration disabled, with no tools or provider discovery. Later discovery, review and enablement require the browser. Provider tokens remain valid until revoked with their provider.',
          ),
        ],
      ),
      'Confirm MCP creation',
    );
    if (!confirmed ||
        !mounted ||
        !identical(controller, c) ||
        !_visible ||
        epoch != _viewEpoch) {
      return;
    }
    await controller.confirm(
      held,
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
      'Abandon this registration preparation?',
      const Text(
        'Permanently close this exact staged attempt. This cannot create a connection or revoke a provider token.',
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
