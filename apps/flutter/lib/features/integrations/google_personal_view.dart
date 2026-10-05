import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/native_workspace_access.dart';
import 'connector_contracts.dart';
import 'google_personal_contracts.dart';
import 'google_personal_controller.dart';
import 'google_personal_providers.dart';

class NativeGooglePersonalWorkspace extends StatelessWidget {
  const NativeGooglePersonalWorkspace({super.key});

  @override
  Widget build(BuildContext context) {
    // The protected workspace has its own navigator. Keep its outer route in
    // the admission fence too, so another screen cannot leave it actionable.
    final routeCurrent = ModalRoute.isCurrentOf(context) ?? true;
    return Scaffold(
      appBar: AppBar(title: const Text('Google account')),
      body: _GoogleRouteVisibility(
        current: routeCurrent,
        child: NativePrivateWorkspace(
          ownNavigator: true,
          builder: (_) => Consumer(
            builder: (context, ref, _) {
              final controller = ref.watch(googlePersonalControllerProvider);
              if (controller == null || !controller.current) {
                return const Center(
                  child: Text(
                    'Unlock this workspace to review its Google account.',
                  ),
                );
              }
              return GooglePersonalControlPanel(
                key: ObjectKey(controller),
                controller: controller,
                routeCurrent: _GoogleRouteVisibility.of(context),
              );
            },
          ),
        ),
      ),
    );
  }
}

class _GoogleRouteVisibility extends InheritedWidget {
  const _GoogleRouteVisibility({required this.current, required super.child});
  final bool current;
  static bool of(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<_GoogleRouteVisibility>()!
      .current;
  @override
  bool updateShouldNotify(_GoogleRouteVisibility oldWidget) =>
      current != oldWidget.current;
}

String googlePersonalActionLabel(String action) => switch (action) {
  'sync' => 'Sync permitted sources',
  'disconnect' => 'Disconnect Google',
  _ => 'Google action',
};

String _sourceLabel(Object? source) => switch (source) {
  'mail' => 'Mail',
  'calendar' => 'Calendar',
  'drive' => 'Drive',
  _ => 'Unknown source',
};

class GooglePersonalControlPanel extends StatefulWidget {
  const GooglePersonalControlPanel({
    super.key,
    required this.controller,
    this.routeCurrent = true,
  });
  final GooglePersonalController controller;
  final bool routeCurrent;

  @override
  State<GooglePersonalControlPanel> createState() =>
      _GooglePersonalControlPanelState();
}

class _GooglePersonalControlPanelState extends State<GooglePersonalControlPanel>
    with WidgetsBindingObserver {
  bool _foreground = true, _confirming = false, _wasVisible = true;
  bool _workspaceWasVisible = true;
  int _viewEpoch = 0;
  GooglePersonalController get c => widget.controller;
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
    // Only the confirmation dialog's own inner route may occlude the panel
    // without retiring its confirmation. Workspace hiding always retires it.
    if (!visible && _wasVisible && !_confirming) _viewEpoch++;
    _wasVisible = visible;
  }

  @override
  void didUpdateWidget(covariant GooglePersonalControlPanel oldWidget) {
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
          child: Text('Return to the unlocked workspace to review Google.'),
        );
      }
      return ListView(
        key: PageStorageKey(('native-google-list', c, c.owner.key)),
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            'Your Google account',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          const Text(
            'Review the connected account and its current permissions before syncing or disconnecting it.',
          ),
          if (!c.mayChange)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                'Your current access permits review and receipt recovery. Sync and disconnect require permission to change this account.',
              ),
            ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 12,
            runSpacing: 8,
            children: [
              OutlinedButton.icon(
                onPressed: c.busy || c.reading ? null : c.refresh,
                icon: const Icon(Icons.refresh),
                label: Text(
                  c.reading
                      ? 'Reading Google account…'
                      : 'Refresh Google review',
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
          if (c.accepted != null) _receipt(c.accepted!.response, local: true),
          if (c.reviewed != null)
            ..._review(c.reviewed!)
          else if (!c.reading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Text(
                'Refresh the Google review to see which actions are currently available.',
              ),
            ),
          const Divider(height: 32),
          Text(
            'Google authorization',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          const Text(
            'Connecting an account or changing Google permissions opens your system browser. Check that the browser is signed in to the same Asael account before continuing to Google consent. Return here and refresh the review afterward.',
          ),
          const SizedBox(height: 12),
          const Align(
            alignment: Alignment.centerLeft,
            child: NativeWorkspaceBrowserButton(
              path: '/app/connectors',
              label: 'Open Google authorization in browser',
            ),
          ),
        ],
      );
    },
  );

  Widget _error(String value) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Text(
      value,
      style: TextStyle(color: Theme.of(context).colorScheme.error),
    ),
  );

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
                  ? 'Google action unconfirmed'
                  : 'Prepared action not sent',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            Text(
              '${googlePersonalActionLabel(held.intent.action)} · ${held.intent.review['accountEmail']}',
            ),
            const SizedBox(height: 8),
            const Text(
              'This exact submission is protected on this device. Checking its receipt never sends the action again.',
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

  List<Widget> _review(GooglePersonalRead review) {
    final connection = review.connection;
    return [
      const SizedBox(height: 20),
      if (connection == null)
        const Text(
          'No personal Google connection is currently visible for this Asael account.',
        )
      else ...[
        Text(
          connection['accountEmail'] as String,
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 8),
        Text(
          connection['status'] == 'active'
              ? 'Connected to this Asael account'
              : 'Google access is locally revoked',
        ),
        Text(
          'Permitted sources: ${(connection['permittedSources'] as List).isEmpty ? 'None' : (connection['permittedSources'] as List).map(_sourceLabel).join(', ')}',
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 12,
          runSpacing: 8,
          children: [
            for (final action in review.actions)
              FilledButton(
                onPressed: c.canAct ? () => _confirm(review, action) : null,
                child: Text(googlePersonalActionLabel(action)),
              ),
          ],
        ),
        if (review.actions.isEmpty && review.blocked == null)
          Text(
            review.busy
                ? 'Google work is already in progress. Refresh this review after it finishes.'
                : 'No action is currently available with this account access.',
          ),
        ExpansionTile(
          key: PageStorageKey(('google-review', c, connection['reviewSha256'])),
          title: const Text('Reviewed connection details'),
          childrenPadding: const EdgeInsets.all(12),
          children: [
            SelectableText(
              'Connection: ${connection['connectionId']}\nAuthorization version: ${connection['authorizationGeneration']}',
            ),
          ],
        ),
      ],
      if (review.blocked != null) ...[
        const SizedBox(height: 12),
        Text(
          'An accepted Google action needs its final receipt',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        Text(
          '${googlePersonalActionLabel(connectorMap(review.blocked!['acceptance'])['action'] as String)} · ${connectorMap(connectorMap(review.blocked!['acceptance'])['review'])['accountEmail']}',
        ),
        const Text(
          'This may have started in another window or on another device. Read its exact receipt to inspect the outcome.',
        ),
        Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton(
            onPressed: c.busy ? null : c.recoverBlocked,
            child: const Text('Check accepted action receipt'),
          ),
        ),
      ],
      if (c.observedReceipt != null) _receipt(c.observedReceipt!, local: false),
    ];
  }

  Widget _receipt(GooglePersonalRead response, {required bool local}) {
    final acceptance = response.acceptance!;
    final review = connectorMap(acceptance['review']);
    final settlement = response.action!['settlement'];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              response.settled
                  ? 'Google action confirmed'
                  : 'Google action accepted; result unconfirmed',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            Text(
              '${googlePersonalActionLabel(acceptance['action'] as String)} · ${review['accountEmail']}',
            ),
            Text('Accepted ${acceptance['acceptedAt']}'),
            if (acceptance['localRevoked'] == true)
              const Text(
                'Asael access to this Google authorization has been revoked locally.',
              ),
            if (settlement is Map && settlement['action'] == 'disconnect')
              Text(
                settlement['providerRevocation'] == 'revoked'
                    ? 'Google also confirmed revocation of the provider token.'
                    : 'Google token revocation is unconfirmed. Local revocation remains in effect.',
              ),
            if (settlement is Map && settlement['action'] == 'sync') ...[
              Text(
                '${settlement['imported']} imported · ${settlement['removed']} removed',
              ),
              for (final raw in settlement['sources'] as List)
                Text(
                  '${_sourceLabel((raw as Map)['source'])}: ${raw['status'] == 'healthy' ? 'Up to date' : 'Sync in progress'} · ${raw['imported']} imported · ${raw['removed']} removed',
                ),
              if (settlement['status'] == 'partial')
                const Text(
                  'The receipt confirms a partial sync. Some source backfill remains in progress.',
                ),
            ],
            if (local && c.storageUnconfirmed)
              OutlinedButton(
                onPressed: c.busy ? null : c.saveAcceptedLocally,
                child: const Text('Save verified receipt locally'),
              ),
            ExpansionTile(
              key: PageStorageKey((
                'google-receipt',
                c,
                local,
                acceptance['id'],
              )),
              title: const Text('Receipt details'),
              childrenPadding: const EdgeInsets.all(12),
              children: [
                SelectableText(
                  const JsonEncoder.withIndent('  ').convert(response.action),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirm(GooglePersonalRead review, String action) async {
    if (!_visible || !c.canAct) return;
    final controller = c, epoch = _viewEpoch, connection = review.connection!;
    _confirming = true;
    bool? confirmed;
    try {
      confirmed = await showDialog<bool>(
        context: context,
        useRootNavigator: false,
        builder: (dialogContext) => AlertDialog(
          scrollable: true,
          title: Text(googlePersonalActionLabel(action)),
          content: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(connection['accountEmail'] as String),
              const SizedBox(height: 12),
              Text(
                action == 'sync'
                    ? 'Sync the full currently permitted source set: ${(connection['permittedSources'] as List).map(_sourceLabel).join(', ')}. This imports the authorized Google content into this Asael account.'
                    : 'Revoke Asael access to this exact Google authorization and request revocation from Google. This does not delete previously imported content.',
              ),
              const SizedBox(height: 12),
              const Text(
                'The account and permission version are checked again before submission. If its result is uncertain, the exact receipt can be checked without repeating the action.',
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
      action,
      () =>
          mounted &&
          identical(controller, c) &&
          _visible &&
          epoch == _viewEpoch,
    );
  }
}
