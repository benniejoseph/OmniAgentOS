import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'accounts_contracts.dart';
import 'accounts_controller.dart';
import 'accounts_mutation_controller.dart';

class AccountSalesforcePanel extends StatefulWidget {
  const AccountSalesforcePanel({super.key, required this.controller});
  final AccountsController controller;
  @override
  State<AccountSalesforcePanel> createState() => _AccountSalesforcePanelState();
}

class _AccountSalesforcePanelState extends State<AccountSalesforcePanel>
    with WidgetsBindingObserver {
  bool _expanded = false, _foreground = true, _opening = false;
  int _epoch = 0;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
  }

  @override
  void didUpdateWidget(AccountSalesforcePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller)) {
      _epoch++;
      _expanded = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _epoch++;
    if (mounted) {
      setState(() {});
    }
  }

  @override
  void dispose() {
    _epoch++;
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  bool _current(
    int epoch,
    AccountsMutationController actions,
    AccountsOwner owner,
    String workspace,
  ) =>
      mounted &&
      _foreground &&
      _expanded &&
      epoch == _epoch &&
      identical(widget.controller.actions, actions) &&
      actions.available &&
      actions.workspace == workspace &&
      widget.controller.workspaceId == workspace &&
      widget.controller.repository.access.owner?.key == owner.key &&
      (ModalRoute.of(context)?.isCurrent ?? true) &&
      TickerMode.valuesOf(context).enabled;

  Future<void> _connect(
    AccountsMutationController actions,
    AccountsOwner owner,
    String workspace,
  ) async {
    final epoch = _epoch;
    if (_opening || !_current(epoch, actions, owner, workspace)) {
      return;
    }
    setState(() => _opening = true);
    try {
      final base = Uri.parse(owner.apiScope);
      accountRequire(
        base.scheme == 'https' ||
            base.scheme == 'http' &&
                ['localhost', '127.0.0.1', '::1'].contains(base.host),
      );
      final uri = base.replace(
        path: '/app/accounts',
        queryParameters: {'workspaceId': workspace},
        fragment: null,
      );
      if (!_current(epoch, actions, owner, workspace)) {
        return;
      }
      if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
        throw StateError('Browser unavailable');
      }
    } catch (_) {
      if (mounted && _current(epoch, actions, owner, workspace)) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('The browser connection setup could not be opened.'),
          ),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _opening = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller,
        actions = controller.actions,
        owner = controller.repository.access.owner,
        workspace = controller.workspaceId;
    if (actions == null || owner == null || workspace == null) {
      return const SizedBox.shrink();
    }
    final pending = actions.salesforceState.pending,
        observed = actions.salesforceState.observed,
        review = actions.salesforceReview,
        connection = review?.connection;
    final epoch = _epoch;
    bool current() => _current(epoch, actions, owner, workspace);
    return ExpansionTile(
      key: ValueKey(('salesforce-actions', actions, workspace)),
      title: const Text('Salesforce connection actions'),
      subtitle: Text(
        pending == null
            ? 'Review this workspace connection'
            : 'Saved ${pending.action} outcome is unconfirmed',
      ),
      initiallyExpanded: _expanded,
      onExpansionChanged: (value) {
        setState(() {
          _expanded = value;
          _epoch++;
        });
      },
      childrenPadding: const EdgeInsets.symmetric(vertical: 12),
      expandedCrossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SelectableText('Workspace: $workspace'),
        const Text(
          'Sync imports provider records into this workspace. Reconciliation checks existing records and records findings. Neither action changes records in Salesforce.',
        ),
        if (pending != null) ...[
          const SizedBox(height: 8),
          Text(
            'Unconfirmed ${pending.action} · authorization generation ${pending.review['authorizationGeneration']}',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const Text(
            'This saved request will not be sent again. A missing receipt keeps it held.',
          ),
          OutlinedButton(
            onPressed:
                actions.available &&
                    !actions.busy &&
                    !actions.storageUnconfirmed
                ? actions.recoverSalesforceAction
                : null,
            child: const Text('Read exact Salesforce receipt'),
          ),
        ],
        if (actions.salesforceState.needsLocalSave)
          OutlinedButton(
            onPressed: actions.available && !actions.busy
                ? actions.settleSalesforceLocally
                : null,
            child: const Text('Save Salesforce receipt locally'),
          ),
        if (observed?.action case final action?) ...[
          const SizedBox(height: 8),
          _SalesforceOutcome(action: action),
        ],
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: current() && !actions.busy
              ? () => actions.loadSalesforceReview(isReviewCurrent: current)
              : null,
          icon: const Icon(Icons.refresh),
          label: const Text('Review current connection'),
        ),
        if (review != null) ...[
          if (connection == null)
            const Text(
              'No Salesforce connection owned by your signed-in Asael account is available in the selected workspace.',
            )
          else ...[
            SelectableText(
              'Instance: ${connection['instanceOrigin']}\nConnection: ${connection['connectionState']}\nAuthorization generation: ${connection['authorizationGeneration']}\nCurrent grant: ${connection['grantStatus']} · generation ${connection['grantAuthorizationGeneration']}',
            ),
            if (review.busy)
              const Text(
                'This connection currently has an active sync lease. Refresh its review after that work finishes.',
              ),
            if (review.blockedAction != null)
              const Text(
                'A previously admitted action remains unconfirmed. Another action cannot start until its exact receipt is settled.',
              ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final action in ['sync', 'reconcile', 'disconnect'])
                  OutlinedButton(
                    onPressed:
                        current() &&
                            actions.salesforceWritable &&
                            !actions.locked &&
                            review.allowed.contains(action)
                        ? () => _confirmAction(
                            actions,
                            owner,
                            workspace,
                            action,
                            connection,
                          )
                        : null,
                    child: Text(switch (action) {
                      'sync' => 'Sync reviewed connection',
                      'reconcile' => 'Reconcile reviewed connection',
                      _ => 'Disconnect reviewed connection',
                    }),
                  ),
              ],
            ),
          ],
          const SizedBox(height: 8),
          const Text(
            'Connect or reconnect through the provider consent page in your system browser. Confirm the Asael browser account and workspace before starting OAuth.',
          ),
          OutlinedButton.icon(
            onPressed:
                current() &&
                    actions.salesforceWritable &&
                    !actions.locked &&
                    !_opening
                ? () => _connect(actions, owner, workspace)
                : null,
            icon: const Icon(Icons.open_in_new),
            label: const Text('Open browser connection setup'),
          ),
        ],
      ],
    );
  }

  Future<void> _confirmAction(
    AccountsMutationController actions,
    AccountsOwner owner,
    String workspace,
    String action,
    AccountJson review,
  ) async {
    final epoch = _epoch;
    bool current() =>
        _current(epoch, actions, owner, workspace) &&
        actions.salesforceReview?.connection?['reviewSha256'] ==
            review['reviewSha256'];
    if (!current()) {
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(
          action == 'disconnect'
              ? 'Disconnect this Salesforce connection?'
              : '${action == 'sync' ? 'Sync' : 'Reconcile'} this Salesforce connection?',
        ),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SelectableText(
                'Workspace: $workspace\nInstance: ${review['instanceOrigin']}\nAuthorization generation: ${review['authorizationGeneration']}',
              ),
              const SizedBox(height: 12),
              Text(
                action == 'disconnect'
                    ? 'This revokes local access and preserves imported history. Provider revocation is attempted separately; its confirmation may remain unknown.'
                    : action == 'sync'
                    ? 'Import a bounded batch of Salesforce records and project their Account evidence. The result may be partial.'
                    : 'Read a bounded set of provider records and record differences. This does not repair provider records.',
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Confirm reviewed action'),
          ),
        ],
      ),
    );
    if (confirmed == true && current()) {
      await actions.submitSalesforceAction(
        action,
        review,
        isReviewCurrent: current,
      );
    }
  }
}

class _SalesforceOutcome extends StatelessWidget {
  const _SalesforceOutcome({required this.action});
  final AccountJson action;
  @override
  Widget build(BuildContext context) {
    final accepted = accountMap(action['acceptance']),
        settlement = action['settlement'] == null
            ? null
            : accountMap(action['settlement']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Saved Salesforce ${accepted['action']} receipt',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        if (accepted['localRevoked'] == true)
          const Text(
            'Local access was revoked. Imported history remains available.',
          ),
        if (settlement == null)
          const Text('Admission is confirmed. Completion remains unconfirmed.')
        else if (settlement['action'] == 'sync')
          Text(
            '${settlement['status']} · ${settlement['pages']} pages · ${settlement['records']} records · ${settlement['advanced']} advanced · ${settlement['conflicts']} conflicts\nProjection: ${settlement['projection']['projected']} projected, ${settlement['projection']['held']} held, ${settlement['projection']['failed']} failed',
          )
        else if (settlement['action'] == 'reconcile')
          Text(
            'Reconciliation completed · ${settlement['checked']} checked · ${settlement['findings']} findings',
          )
        else
          Text('Provider revocation: ${settlement['providerRevocation']}'),
        ExpansionTile(
          title: const Text('Receipt details'),
          children: [
            SelectableText(
              'Action: ${accepted['id']}\nAccepted: ${accepted['acceptedAt']}\nAuthorization generation: ${accepted['review']['authorizationGeneration']}\nRequest: ${accepted['requestSha256']}',
            ),
          ],
        ),
      ],
    );
  }
}
