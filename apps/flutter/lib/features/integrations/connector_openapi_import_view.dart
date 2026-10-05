import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/native_workspace_access.dart';
import 'connector_contracts.dart';
import 'connector_openapi_import_contracts.dart';
import 'connector_openapi_import_controller.dart';
import 'connector_openapi_import_providers.dart';

class NativeConnectorOpenApiImportWorkspace extends StatelessWidget {
  const NativeConnectorOpenApiImportWorkspace({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('New OpenAPI import')),
    body: _ImportRouteVisibility(
      current: ModalRoute.isCurrentOf(context) ?? true,
      child: NativePrivateWorkspace(
        ownNavigator: true,
        builder: (_) => Consumer(
          builder: (panelContext, ref, _) {
            final controller = ref.watch(
              connectorOpenApiImportControllerProvider,
            );
            if (controller == null || !controller.current) {
              return const Center(
                child: Text('Unlock this workspace to review import recovery.'),
              );
            }
            return Material(
              color: Theme.of(context).scaffoldBackgroundColor,
              child: ConnectorOpenApiImportPanel(
                key: ObjectKey(controller),
                controller: controller,
                routeCurrent: _ImportRouteVisibility.of(panelContext),
                onReview: (id) => Navigator.of(context).pop(id),
              ),
            );
          },
        ),
      ),
    ),
  );
}

class _ImportRouteVisibility extends InheritedWidget {
  const _ImportRouteVisibility({required this.current, required super.child});
  final bool current;
  static bool of(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<_ImportRouteVisibility>()!
      .current;
  @override
  bool updateShouldNotify(_ImportRouteVisibility oldWidget) =>
      current != oldWidget.current;
}

class ConnectorOpenApiImportPanel extends StatefulWidget {
  const ConnectorOpenApiImportPanel({
    super.key,
    required this.controller,
    this.routeCurrent = true,
    this.onReview,
  });
  final ConnectorOpenApiImportController controller;
  final bool routeCurrent;
  final ValueChanged<String>? onReview;
  @override
  State<ConnectorOpenApiImportPanel> createState() =>
      _ConnectorOpenApiImportPanelState();
}

class _ConnectorOpenApiImportPanelState
    extends State<ConnectorOpenApiImportPanel>
    with WidgetsBindingObserver {
  final _name = TextEditingController();
  final _endpoint = TextEditingController();
  final _sourceUrl = TextEditingController();
  final _specText = TextEditingController();
  final _header = TextEditingController();
  String _source = 'url';
  final _environment = TextEditingController();
  String _authType = 'none';
  int _risk = 2;
  bool _approval = true;
  bool _foreground = true,
      _confirming = false,
      _wasVisible = true,
      _workspaceWasVisible = true;
  int _viewEpoch = 0;
  ConnectorOpenApiImportController get c => widget.controller;
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
      _sourceUrl.clear();
      _specText.clear();
    }
  }

  void _hideReview() {
    _clearSecret();
    c.hideReview();
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
      _hideReview();
    }
    _workspaceWasVisible = workspaceVisible;
    final visible = _visible;
    if (!visible && _wasVisible && !_confirming) {
      _viewEpoch++;
      _hideReview();
    }
    _wasVisible = visible;
  }

  @override
  void didUpdateWidget(covariant ConnectorOpenApiImportPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, c)) {
      oldWidget.controller.hideReview();
      oldWidget.controller.removeListener(_changed);
      c.addListener(_changed);
      _viewEpoch++;
      _hideReview();
      _name.clear();
      _environment.clear();
      _header.clear();
      _source = 'url';
      _authType = 'none';
      _risk = 2;
      _approval = true;
      unawaited(_load());
    }
    if (oldWidget.routeCurrent != widget.routeCurrent) {
      _viewEpoch++;
      _hideReview();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _viewEpoch++;
    _hideReview();
    if (mounted) {
      setState(() {});
    }
  }

  @override
  void dispose() {
    _viewEpoch++;
    c.hideReview();
    c.removeListener(_changed);
    _endpoint.clear();
    _sourceUrl.clear();
    _specText.clear();
    _name.dispose();
    _endpoint.dispose();
    _sourceUrl.dispose();
    _specText.dispose();
    _header.dispose();
    _environment.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  ConnectorJson? get _draft {
    try {
      if (_source == 'text' &&
          (_specText.text.isEmpty ||
              utf8.encode(_specText.text).length > 2000000)) {
        return null;
      }
      return openApiImportDeclaration(
        name: _name.text,
        source: _source,
        specUrl: _source == 'url' ? _sourceUrl.text : null,
        endpoint: _endpoint.text.isEmpty ? null : _endpoint.text,
        authType: _authType,
        authTokenEnv: _authType == 'none'
            ? null
            : _environment.text.trim().toUpperCase(),
        authHeaderName: _authType == 'api_key_header_env'
            ? _header.text.trim()
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
            'Return to the unlocked workspace to review this import.',
          ),
        );
      }
      return ListView(
        key: PageStorageKey(('openapi-import-list', c)),
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'New OpenAPI import',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          const Text(
            'Capture an OpenAPI specification from a public URL or pasted JSON/YAML, review every operation, then confirm its import. The new connection stays disabled and all operations await a separate schema review.',
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
      key: PageStorageKey(('openapi-import-name', c)),
      controller: _name,
      maxLength: 120,
      decoration: const InputDecoration(labelText: 'Connection name'),
      onChanged: (_) => setState(() {}),
    ),
    DropdownButtonFormField<String>(
      key: PageStorageKey(('openapi-import-source', c)),
      initialValue: _source,
      decoration: const InputDecoration(labelText: 'Specification source'),
      items: const [
        DropdownMenuItem(value: 'url', child: Text('Public specification URL')),
        DropdownMenuItem(value: 'text', child: Text('Paste JSON or YAML')),
      ],
      onChanged: (value) {
        if (value != null) {
          setState(() {
            _source = value;
            _clearSecret();
          });
        }
      },
    ),
    if (_source == 'url')
      TextField(
        key: PageStorageKey(('openapi-import-url', c)),
        controller: _sourceUrl,
        obscureText: true,
        enableSuggestions: false,
        autocorrect: false,
        enableIMEPersonalizedLearning: false,
        keyboardType: TextInputType.url,
        decoration: const InputDecoration(
          labelText: 'Full specification URL',
          helperText: 'Public HTTP(S) source. Connector authentication is never sent to this URL.',
        ),
        onChanged: (_) => setState(() {}),
      )
    else
      TextField(
        key: PageStorageKey(('openapi-import-text', c)),
        controller: _specText,
        minLines: 4,
        maxLines: 10,
        enableSuggestions: false,
        autocorrect: false,
        enableIMEPersonalizedLearning: false,
        decoration: const InputDecoration(
          labelText: 'OpenAPI JSON or YAML',
          helperText: 'Up to 2 MB of UTF-8 text; 1–200 complete operations.',
        ),
        onChanged: (_) => setState(() {}),
      ),
    TextField(
      key: PageStorageKey(('openapi-import-base', c)),
      controller: _endpoint,
      obscureText: true,
      enableSuggestions: false,
      autocorrect: false,
      enableIMEPersonalizedLearning: false,
      keyboardType: TextInputType.url,
      decoration: const InputDecoration(
        labelText: 'Optional API base URL',
        helperText: 'Leave empty to use the specification. No query or fragment, including empty ? or #.',
      ),
      onChanged: (_) => setState(() {}),
    ),
    const Text(
      'Use ASCII hostnames or dotted IPv4 and percent-encoded paths. Use browser setup for other URL formats or specifications outside these bounds.',
    ),
    const NativeWorkspaceBrowserButton(
      path: '/app/connectors',
      label: 'Open browser setup',
    ),
    DropdownButtonFormField<String>(
      key: PageStorageKey(('openapi-import-auth', c)),
      initialValue: _authType,
      decoration: const InputDecoration(labelText: 'API authentication'),
      items: const [
        DropdownMenuItem(value: 'none', child: Text('No authentication')),
        DropdownMenuItem(
          value: 'bearer_env',
          child: Text('Deployer-bound bearer handle'),
        ),
        DropdownMenuItem(
          value: 'api_key_header_env',
          child: Text('Deployer-bound API key handle'),
        ),
      ],
      onChanged: (value) {
        if (value != null) {
          setState(() {
            _authType = value;
            _header.clear();
          });
        }
      },
    ),
    if (_authType != 'none') ...[
      TextField(
        key: PageStorageKey(('openapi-import-environment', c)),
        controller: _environment,
        decoration: const InputDecoration(
          labelText: 'Environment handle',
          helperText: 'Enter the configured handle, never its secret value.',
        ),
        onChanged: (_) => setState(() {}),
      ),
      const Text(
        'A deployer must already have bound this handle to your tenant and the resolved API origin. Import does not create a binding or test API credentials.',
      ),
    ],
    if (_authType == 'api_key_header_env')
      TextField(
        key: PageStorageKey(('openapi-import-header', c)),
        controller: _header,
        decoration: const InputDecoration(
          labelText: 'API key header',
          helperText: 'For example, x-api-key. Routing and reserved headers are not allowed.',
        ),
        onChanged: (_) => setState(() {}),
      ),
    DropdownButtonFormField<int>(
      key: PageStorageKey(('openapi-import-risk', c)),
      initialValue: _risk,
      decoration: const InputDecoration(labelText: 'Default operation risk'),
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
      'The source is submitted once for a bounded capture attempt and a 15-minute preparation. Source URL and text are cleared when hidden or submission may begin. Device recovery retains only the safe declaration and compact evidence.',
    ),
    Align(
      alignment: Alignment.centerLeft,
      child: FilledButton(
        onPressed: _draft == null ? null : _prepare,
        child: const Text('Prepare OpenAPI import'),
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
      SelectableText(
        declaration['endpoint'] as String? ??
            'API base will be resolved from the specification.',
      ),
      Text(
        'Source: ${declaration['specSource'] == 'url' ? 'public URL' : 'pasted specification'}',
      ),
      if (declaration['specUrl'] != null)
        SelectableText(declaration['specUrl'] as String),
      if (declaration['specUrlRedacted'] == true)
        const Text('Source URL query and fragment are hidden.'),
      if (declaration['endpointRedacted'] == true)
        const Text('Endpoint query and fragment are hidden.'),
      Text(
        'Authentication: ${switch (declaration['authType']) {
          'bearer_env' => 'deployer-bound environment handle',
          'api_key_header_env' => 'deployer-bound API key header',
          _ => 'none',
        }}',
      ),
      if (declaration['authTokenEnv'] != null)
        SelectableText('Handle: ${declaration['authTokenEnv']}'),
      if (declaration['authHeaderName'] != null)
        Text('Header: ${declaration['authHeaderName']}'),
      Text(
        'Default risk ${declaration['defaultRiskLevel']} · ${declaration['approvalRequired'] == true ? 'approval required' : 'no additional approval flag'}',
      ),
    ],
  );

  Widget _operations(ConnectorJson summary) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        'Captured operations (${(summary['operations'] as List).length})',
        style: Theme.of(context).textTheme.titleMedium,
      ),
      for (final value in summary['operations'] as List)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${connectorMap(value)['method']} ${connectorMap(value)['path']}',
              ),
              SelectableText(connectorMap(value)['operationId'] as String),
              Text(
                'Risk ${connectorMap(value)['riskLevel']} · ${connectorMap(value)['approvalRequired'] == true ? 'approval required' : 'no additional approval flag'}',
              ),
            ],
          ),
        ),
    ],
  );

  Widget _recovery() {
    final s = c.sequence!, p = s.prepared;
    final title = s.action?.settled == true
        ? 'OpenAPI import confirmed'
        : s.finalIntent != null
        ? 'OpenAPI import unconfirmed'
        : p?.availability == 'abandoned'
        ? 'Preparation abandoned'
        : s.abandonDispatched
        ? 'Abandonment unconfirmed'
        : p?.availability == 'ready'
        ? 'OpenAPI import prepared'
        : p?.availability == 'expired'
        ? 'Preparation expired'
        : p?.availability == 'preparing'
        ? 'Specification capture pending'
        : p?.availability == 'failed'
        ? 'Specification capture failed'
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
            _declaration(p?.proof?.resolvedDeclaration ?? s.intent.declaration),
            if (p?.prepared?['attempt'] != null)
              Text(
                'Original capture deadline: ${connectorMap(p!.prepared!['attempt'])['expiresAt']}',
              ),
            if (p?.availability == 'failed')
              Text(
                'Capture result: ${connectorMap(p!.prepared!['failure'])['code']}',
              ),
            if (c.summary != null) _operations(c.summary!),
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
                'Only the original action receipt can settle this import. Its final action will not be submitted again.',
              ),
            if (s.finalIntent == null && !s.terminal)
              const Text(
                'Recovery only reads the original attempt. Pending, failed or expired capture does not authorize another submission. Abandon this exact preparation before starting a new draft.',
              ),
            if (p?.availability == 'expired')
              const Text(
                'Expiry prevents new creation. It does not establish when staging was physically scrubbed.',
              ),
            if (p?.availability == 'abandoned')
              const Text(
                'The server permanently closed this preparation. This did not import a connection or run any API operation.',
              ),
            if (s.action?.settled == true) ...[
              const Text(
                'This historical receipt records a disabled OpenAPI connection. All imported operations started pending review. Open its exact current review to approve schemas separately; import does not approve or execute them.',
              ),
              if (widget.onReview != null)
                FilledButton(
                  onPressed: c.busy || c.storageUnconfirmed
                      ? null
                      : () {
                          if (_visible && c.current && !c.storageUnconfirmed) {
                            widget.onReview!(s.intent.id);
                          }
                        },
                  child: const Text('Review imported connection'),
                ),
            ],
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                if (s.prepareDispatched && !s.terminal)
                  OutlinedButton(
                    onPressed: c.busy
                        ? null
                        : () => c.recover(admission: () => _visible),
                    child: Text(
                      s.finalIntent == null
                          ? 'Check exact preparation'
                          : 'Check exact import receipt',
                    ),
                  ),
                if (c.canConfirm)
                  FilledButton(
                    onPressed: _confirm,
                    child: const Text('Review and confirm import'),
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
      {
        'endpoint': _endpoint.text.isEmpty ? null : _endpoint.text,
        'specUrl': _source == 'url' ? _sourceUrl.text : null,
        'specText': _source == 'text' ? _specText.text : null,
      },
      () =>
          mounted &&
          identical(controller, c) &&
          _visible &&
          epoch == _viewEpoch,
      clearSecret: _clearSecret,
    );
  }

  Future<bool> _dialog(
    String title,
    Widget Function() body,
    String confirm, {
    bool Function()? valid,
  }) async {
    final controller = c;
    _confirming = true;
    try {
      return await showDialog<bool>(
            context: context,
            useRootNavigator: false,
            builder: (context) => ListenableBuilder(
              listenable: controller,
              builder: (context, _) => AlertDialog(
                scrollable: true,
                title: Text(title),
                content: (valid?.call() ?? true)
                    ? body()
                    : const Text(
                        'This review is no longer current. Close it and check the exact preparation again.',
                      ),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(false),
                    child: const Text('Cancel'),
                  ),
                  FilledButton(
                    onPressed: (valid?.call() ?? true)
                        ? () => Navigator.of(context).pop(true)
                        : null,
                    child: Text(confirm),
                  ),
                ],
              ),
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
    await controller.recover(
      admission: () =>
          mounted &&
          identical(controller, c) &&
          _visible &&
          epoch == _viewEpoch,
    );
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
      'Import this disabled OpenAPI connection?',
      () => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _declaration(held.prepared!.proof!.resolvedDeclaration),
          _operations(controller.summary!),
          SelectableText(held.intent.id),
          Text('Preparation expires ${held.prepared!.proof!.raw['expiresAt']}'),
          const Text(
            'Import exactly these captured operations into a disabled connection. Every operation remains pending a separate schema review. This confirmation does not approve schemas, test connectivity or run operations.',
          ),
        ],
      ),
      'Confirm OpenAPI import',
      valid: () =>
          mounted &&
          identical(controller, c) &&
          epoch == _viewEpoch &&
          controller.canConfirm,
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
      'Abandon this import preparation?',
      () => const Text(
        'Permanently close this exact capture attempt. This cannot import a connection or run an API operation.',
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
