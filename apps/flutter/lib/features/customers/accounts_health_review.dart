import 'package:flutter/material.dart';

import 'accounts_advanced_contracts.dart';
import 'accounts_contracts.dart';
import 'accounts_controller.dart';

/// Inline review stays within the workspace's foreground admission boundary.
class AccountHealthReview extends StatefulWidget {
  const AccountHealthReview({super.key, required this.controller});
  final AccountsController controller;
  @override
  State<AccountHealthReview> createState() => _AccountHealthReviewState();
}

class _AccountHealthReviewState extends State<AccountHealthReview> {
  CustomerAccountSummary? _reviewed;
  int _epoch = 0;
  @override
  void didUpdateWidget(AccountHealthReview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller)) {
      _reviewed = null;
      _epoch++;
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller,
        actions = controller.actions,
        account = controller.detail.value?.account,
        reviewed = _reviewed;
    if (actions == null) {
      return const SizedBox.shrink();
    }
    final current =
        controller.readable &&
        controller.detail.state == AccountReadState.current &&
        controller.advancedReads[AccountAdvancedKind.health]!.state ==
            AccountReadState.current;
    final canReview =
        current &&
        account != null &&
        actions.healthWritable &&
        account.raw['ownerActorId'] ==
            'actor:${controller.repository.access.owner?.userId}' &&
        !actions.locked;
    final matches =
        reviewed != null &&
        account?.id == reviewed.id &&
        account?.revision == reviewed.revision &&
        account?.sha256 == reviewed.sha256;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (reviewed == null) ...[
            OutlinedButton.icon(
              onPressed: canReview
                  ? () => setState(() {
                      _reviewed = account;
                      _epoch++;
                    })
                  : null,
              icon: const Icon(Icons.fact_check_outlined),
              label: const Text('Review health evaluation'),
            ),
            if (!canReview)
              const Text(
                'Read the current Account and health source first. Evaluation requires the Account owner and management access, with no other pending Account action.',
              ),
          ] else ...[
            Text(
              'Evaluate health for ${reviewed.name}',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            Text(
              'Reviewed Account revision ${reviewed.revision}. The deterministic policy uses current authorized facts when this request is admitted. Missing evidence remains unknown.',
            ),
            const Text(
              'This saves one health evaluation. It sends no message, starts no workflow and does not write to Salesforce.',
            ),
            if (!matches || !current)
              const Text(
                'The reviewed Account is no longer current. Close this review and refresh before evaluating.',
              ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton(
                  onPressed: canReview && matches
                      ? () async {
                          final epoch = _epoch;
                          bool admission() =>
                              mounted &&
                              identical(widget.controller, controller) &&
                              epoch == _epoch &&
                              identical(_reviewed, reviewed) &&
                              controller.readable &&
                              controller.detail.state ==
                                  AccountReadState.current &&
                              controller.detail.value?.account.id ==
                                  reviewed.id &&
                              controller.detail.value?.account.sha256 ==
                                  reviewed.sha256;
                          await actions.evaluateHealth(
                            reviewed,
                            isReviewCurrent: admission,
                          );
                          if (!mounted ||
                              !identical(widget.controller, controller) ||
                              epoch != _epoch) {
                            return;
                          }
                          setState(() {
                            _reviewed = null;
                            _epoch++;
                          });
                        }
                      : null,
                  child: Text(
                    actions.busy
                        ? 'Checking evaluation…'
                        : 'Confirm health evaluation',
                  ),
                ),
                OutlinedButton(
                  onPressed: () => setState(() {
                    _reviewed = null;
                    _epoch++;
                  }),
                  child: const Text('Close health review'),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class AccountHealthRecovery extends StatelessWidget {
  const AccountHealthRecovery({super.key, required this.controller});
  final AccountsController controller;
  @override
  Widget build(BuildContext context) {
    final actions = controller.actions;
    if (actions == null) {
      return const SizedBox.shrink();
    }
    final pending = actions.pendingHealth,
        accepted = actions.acceptedHealth?.acceptance,
        intent = actions.acceptedHealthIntent,
        disposition = actions.healthDisposition;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (pending != null) ...[
          Text(
            'Unconfirmed health evaluation',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          Text(
            '${pending.accountName} · reviewed Account revision ${pending.accountRevision}',
          ),
          const Text(
            'This evaluation may already be saved. Recovery only reads its exact acceptance and never repeats the evaluation.',
          ),
          SelectableText(
            'Evaluation: ${pending.evaluationId}\nRequest: ${pending.requestSha256}',
          ),
          FilledButton(
            onPressed:
                actions.available &&
                    !actions.busy &&
                    !actions.storageUnconfirmed
                ? actions.recoverHealth
                : null,
            child: const Text('Read evaluation receipt'),
          ),
        ],
        if (accepted != null && intent != null)
          ExpansionTile(
            key: PageStorageKey((
              controller,
              controller.repository.access.owner?.key,
              intent.evaluationId,
              'health-acceptance',
            )),
            title: Text('Accepted health evaluation · ${accepted['status']}'),
            subtitle: Text(
              '${intent.accountName} · Account revision ${intent.accountRevision}',
            ),
            childrenPadding: const EdgeInsets.all(12),
            children: [
              const Text(
                'This is the original accepted evaluation. Current Account or health data may be newer; a failed refresh does not remove this receipt.',
              ),
              SelectableText(
                'Accepted: ${accepted['acceptedAt']}\nEvaluation: ${intent.evaluationId}\nScore revision: ${accepted['scoreRevisionId']}\nAcceptance: ${accepted['acceptanceSha256']}',
              ),
              OutlinedButton(
                onPressed:
                    !controller.busy && controller.accountId == intent.accountId
                    ? () =>
                          controller.refreshAdvanced(AccountAdvancedKind.health)
                    : null,
                child: const Text('Refresh current health evidence'),
              ),
            ],
          ),
        if (disposition != null)
          Text(
            disposition['response'] == null
                ? 'The previous health review closed before a request was sent.'
                : 'The service confirmed that the previous health attempt was not admitted. Refresh before reviewing another evaluation.',
          ),
        if (actions.storageUnconfirmed &&
            pending == null &&
            (accepted != null || disposition != null))
          OutlinedButton(
            onPressed: actions.available && !actions.busy
                ? actions.settleHealthLocally
                : null,
            child: const Text('Save verified health outcome locally'),
          ),
      ],
    );
  }
}
