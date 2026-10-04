import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/native_workspace_access.dart';
import 'specialist_api_client.dart';
import 'specialist_contracts.dart';

/// A private navigator owns its sheets as well as its page. Replacing the
/// session/API or leaving the foreground removes both in the same build.
class SpecialistWorkspace extends ConsumerStatefulWidget {
  const SpecialistWorkspace({
    super.key,
    required this.family,
    required this.browserPath,
    required this.builder,
    this.requireManager = false,
  });
  final String family, browserPath;
  final bool requireManager;
  final Widget Function(BuildContext context) builder;
  @override
  ConsumerState<SpecialistWorkspace> createState() =>
      _SpecialistWorkspaceState();
}

class _SpecialistWorkspaceState extends ConsumerState<SpecialistWorkspace>
    with WidgetsBindingObserver {
  bool _foreground = true;
  int _visibility = 0;
  SpecialistApiClient? _client;
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
    final next = state == AppLifecycleState.resumed;
    if (next == _foreground) return;
    _client?.close();
    _client = null;
    ref.invalidate(specialistApiProvider(widget.family));
    setState(() {
      _foreground = next;
      _visibility++;
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _client?.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_foreground || !TickerMode.valuesOf(context).enabled) {
      _client?.close();
      return const Center(child: Text('Unlock this workspace to continue.'));
    }
    return NativePrivateWorkspace(
      requireManager: widget.requireManager,
      builder: (access) {
        return _SpecialistScope(
          key: ValueKey((access.identity, _visibility)),
          family: widget.family,
          browserPath: widget.browserPath,
          builder: widget.builder,
          onClient: (client) => _client = client,
        );
      },
    );
  }
}

class _SpecialistScope extends ConsumerWidget {
  const _SpecialistScope({
    super.key,
    required this.family,
    required this.browserPath,
    required this.builder,
    required this.onClient,
  });
  final String family, browserPath;
  final Widget Function(BuildContext) builder;
  final ValueChanged<SpecialistApiClient> onClient;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final client = ref.watch(specialistApiProvider(family));
    onClient(client);
    return ListenableBuilder(
      listenable: client,
      builder: (context, _) => !client.current
          ? const Center(
              child: Text(
                'Refresh the current account session to restore specialist access.',
              ),
            )
          : Navigator(
              key: ValueKey(client),
              onGenerateRoute: (_) => MaterialPageRoute<void>(
                builder: (context) => Column(
                  children: [
                    SpecialistRecoveryPanel(
                      client: client,
                      browserPath: browserPath,
                    ),
                    Expanded(child: Builder(builder: builder)),
                  ],
                ),
              ),
            ),
    );
  }
}

class SpecialistRecoveryPanel extends StatefulWidget {
  const SpecialistRecoveryPanel({
    super.key,
    required this.client,
    required this.browserPath,
  });
  final SpecialistApiClient client;
  final String browserPath;
  @override
  State<SpecialistRecoveryPanel> createState() =>
      _SpecialistRecoveryPanelState();
}

class _SpecialistRecoveryPanelState extends State<SpecialistRecoveryPanel> {
  String? _error;
  bool _busy = false;
  Future<void> _run(Future<void> Function() operation) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await operation();
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _inspect(SpecialistJson entry) => _run(() async {
    final inspection = await widget.client.inspectDecision(
      entry['key'] as String,
    );
    if (!mounted || !widget.client.current) return;
    final encoded = const JsonEncoder.withIndent('  ')
        .convert(inspection['currentResource']);
    final decision = await showDialog<bool>(
      context: context,
      useRootNavigator: false,
      builder: (context) => AlertDialog(
        title: const Text('Inspect the current resource'),
        content: SizedBox(
          width: 640,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(inspection['disclosure'] as String),
                const SizedBox(height: 12),
                SelectableText(
                  '${entry['method']} ${entry['path']}\nRequest key: ${entry['key']}\nRequest digest: ${entry['bodySha256']}\nObserved state: ${entry['state']}',
                ),
                const SizedBox(height: 12),
                SelectableText(
                  encoded.length > 24000
                      ? '${encoded.substring(0, 24000)}\n[Display limited to 24,000 characters; use the full browser workspace for more.]'
                      : encoded,
                ),
                const SizedBox(height: 12),
                const Text(
                  'An unresolved decision remains unknown. Allowing another decision never marks this request accepted and never retries it.',
                ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep held'),
          ),
          if (entry['state'] != 'accepted' &&
              widget.client.access?.canManage == true)
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Allow a new explicit decision'),
            ),
        ],
      ),
    );
    if (decision == true && mounted && widget.client.current) {
      await widget.client.acknowledgeNewDecision(entry['key'] as String);
    }
  });
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.client,
    builder: (context, _) {
      if (!widget.client.current) return const SizedBox.shrink();
      final entries = widget.client.journal;
      return Material(
        color: Theme.of(context).colorScheme.surfaceContainerLow,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * .35,
          ),
          child: SingleChildScrollView(
            key: const PageStorageKey<String>('specialist-decision-scroll'),
            child: ExpansionTile(
              key: const PageStorageKey<String>('specialist-decision-recovery'),
              title: Text(
                entries.isEmpty
                    ? 'Workspace controls'
                    : 'Decision recovery · ${entries.length} records',
              ),
              subtitle: Text(
                widget.client.recoveryError ?? 'Current account and API · interrupted actions are never automatically retried.',
              ),
              children: [
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      NativeWorkspaceBrowserButton(
                        path: widget.browserPath,
                        label: 'Open full workspace in browser',
                      ),
                      if (widget.client.recoveryError != null)
                        OutlinedButton(
                          onPressed: _busy
                              ? null
                              : () => _run(widget.client.reloadRecovery),
                          child: const Text('Reload protected recovery'),
                        ),
                      if (_error != null)
                        Text(
                          _error!,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        ),
                      for (final entry in entries)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 8),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              SelectableText(
                                '${entry['operation']} · ${entry['state']}\n${entry['path']}\n${entry['createdAt']}',
                              ),
                              if (entry['newDecisionAcknowledgedAt'] != null)
                                const Text(
                                  'A separate decision was explicitly allowed. The earlier outcome is unchanged.',
                                ),
                              Wrap(
                                spacing: 8,
                                children: [
                                  OutlinedButton(
                                    onPressed: _busy
                                        ? null
                                        : () => _inspect(entry),
                                    child: const Text(
                                      'Inspect current resource',
                                    ),
                                  ),
                                  if (entry['state'] == 'accepted')
                                    TextButton(
                                      onPressed: _busy
                                          ? null
                                          : () => _run(
                                              () =>
                                                  widget.client.dismissAccepted(
                                                    entry['key'] as String,
                                                  ),
                                            ),
                                      child: const Text(
                                        'Dismiss accepted receipt',
                                      ),
                                    ),
                                ],
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}
