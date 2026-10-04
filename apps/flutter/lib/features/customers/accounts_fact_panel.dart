import 'package:flutter/material.dart';

import 'accounts_contracts.dart';
import 'accounts_controller.dart';
import 'accounts_fact_editor.dart';
import 'accounts_mutation_controller.dart';

class AccountFactPanel extends StatefulWidget {
  const AccountFactPanel({super.key, required this.controller});
  final AccountsController controller;
  @override
  State<AccountFactPanel> createState() => _AccountFactPanelState();
}

class _AccountFactPanelState extends State<AccountFactPanel>
    with WidgetsBindingObserver {
  bool _expanded = false, _foreground = true;
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
  void didUpdateWidget(AccountFactPanel oldWidget) {
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
    CustomerAccountSummary reviewed,
  ) =>
      mounted &&
      _foreground &&
      _expanded &&
      epoch == _epoch &&
      identical(widget.controller.actions, actions) &&
      actions.available &&
      widget.controller.repository.access.owner?.key == owner.key &&
      widget.controller.detail.state == AccountReadState.current &&
      widget.controller.detail.value?.account.id == reviewed.id &&
      widget.controller.detail.value?.account.sha256 == reviewed.sha256 &&
      (ModalRoute.of(context)?.isCurrent ?? true) &&
      TickerMode.valuesOf(context).enabled;
  @override
  Widget build(BuildContext context) {
    final controller = widget.controller,
        actions = controller.actions,
        detail = controller.detail.value,
        owner = controller.repository.access.owner;
    if (actions == null) {
      return const SizedBox.shrink();
    }
    final accepted = actions.factState.accepted?.acceptance,
        canReview =
            detail != null &&
            owner != null &&
            detail.account.raw['ownerActorId'] == 'actor:${owner.userId}' &&
            actions.factWritable &&
            controller.detail.state == AccountReadState.current;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (actions.pendingFact case final pending?) ...[
          Text(
            'Unconfirmed manual fact ${pending.request['operation']}',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          SelectableText(
            '${pending.accountName}\nFact: ${pending.factId}\nRequest: ${pending.requestSha256}',
          ),
          const Text(
            'Recovery reads only this exact saved receipt. A missing or unavailable receipt leaves the original request held.',
          ),
          OutlinedButton(
            onPressed:
                actions.available &&
                    !actions.busy &&
                    !actions.storageUnconfirmed
                ? actions.recoverFact
                : null,
            child: const Text('Check exact fact receipt'),
          ),
        ],
        if (accepted != null)
          ExpansionTile(
            title: Text('Accepted manual fact ${accepted['operation']}'),
            subtitle: Text(
              '${accepted['factKey']} · revision ${accepted['factRevision']}',
            ),
            childrenPadding: const EdgeInsets.all(12),
            children: [
              SelectableText(
                'Account: ${accepted['accountId']}\nFact: ${accepted['factRevisionId']}\nRecorded: ${accepted['recordedAt']}\nSource: manual operator assertion\nAcceptance: ${accepted['acceptanceSha256']}',
              ),
              const Text(
                'This receipt confirms the saved assertion. It does not verify external provenance or erase competing facts.',
              ),
              OutlinedButton(
                onPressed: controller.busy ? null : controller.refreshCore,
                child: const Text('Refresh current facts'),
              ),
            ],
          ),
        if (actions.factState.notSubmitted != null)
          const Text(
            'The last fact review closed before dispatch. No assertion was sent.',
          ),
        if (actions.storageUnconfirmed &&
            (accepted != null || actions.factState.notSubmitted != null))
          OutlinedButton(
            onPressed:
                actions.available &&
                    !actions.busy &&
                    actions.pendingFact == null
                ? actions.settleFactLocally
                : null,
            child: const Text('Save fact outcome locally'),
          ),
        if (detail != null)
          ExpansionTile(
            key: ValueKey((actions, detail.account.id)),
            initiallyExpanded: _expanded,
            maintainState: true,
            onExpansionChanged: (value) {
              setState(() {
                _expanded = value;
                _epoch++;
              });
            },
            title: const Text('Manual account facts'),
            subtitle: const Text(
              'Create, revise or retract an authored assertion',
            ),
            childrenPadding: const EdgeInsets.all(12),
            children: [
              if (!canReview)
                const Text(
                  'Refresh this Account with current owner management access to record a manual assertion.',
                ),
              if (owner != null)
                AccountFactEditor(
                  key: ValueKey((actions, owner.key, detail.account.id)),
                  account: detail.account,
                  facts: detail.facts,
                  owner: owner,
                  enabled:
                      canReview && !actions.locked && _foreground && _expanded,
                  draft: actions.factState.draft,
                  onDraftChanged: actions.editFactDraft,
                  onSubmit: (request) async {
                    final epoch = _epoch, reviewed = detail.account;
                    await actions.submitFact(
                      reviewed,
                      request,
                      isReviewCurrent: () =>
                          _current(epoch, actions, owner, reviewed),
                    );
                  },
                ),
              if (actions.factState.draft != null)
                OutlinedButton(
                  onPressed: canReview && !actions.locked
                      ? actions.saveDraft
                      : null,
                  child: const Text('Save fact draft'),
                ),
            ],
          ),
      ],
    );
  }
}
