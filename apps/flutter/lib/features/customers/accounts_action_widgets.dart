import 'package:flutter/material.dart';

import 'accounts_contracts.dart';
import 'accounts_controller.dart';
import 'accounts_mutation_controller.dart';
import 'accounts_health_review.dart';
import 'accounts_workflow_review.dart';
import 'accounts_fact_panel.dart';
import 'accounts_salesforce_panel.dart';

class AccountActionsPanel extends StatelessWidget {
  const AccountActionsPanel({super.key, required this.controller});
  final AccountsController controller;
  @override
  Widget build(BuildContext context) {
    final actions = controller.actions;
    if (actions == null) {
      return const SizedBox.shrink();
    }
    final account = controller.detail.value?.account,
        owner = controller.repository.access.owner;
    final canRevise =
        account != null &&
        account.raw['ownerActorId'] == 'actor:${owner?.userId}';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Account changes',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const Text(
              'Create or revise the Asael relationship record. This does not connect an account, send a message, or write to Salesforce.',
            ),
            if (!actions.writable)
              const Text(
                'A current Account read and management access are required. Refresh the account source to confirm access.',
              ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (controller.accountId == null)
                  FilledButton.tonal(
                    onPressed: actions.writable && !actions.locked
                        ? () => actions.begin()
                        : null,
                    child: const Text('New Account'),
                  ),
                if (account != null)
                  FilledButton.tonal(
                    onPressed: actions.writable && canRevise && !actions.locked
                        ? () => actions.begin(account: account)
                        : null,
                    child: const Text('Revise this Account'),
                  ),
                if (actions.storageUnconfirmed ||
                    actions.pending != null ||
                    actions.pendingHealth != null ||
                    actions.pendingWorkflow != null ||
                    actions.pendingFact != null ||
                    actions.salesforceState.pending != null)
                  OutlinedButton(
                    onPressed: actions.available && !actions.busy
                        ? actions.reload
                        : null,
                    child: const Text('Reload protected recovery'),
                  ),
              ],
            ),
            if (account != null && !canRevise)
              const Text(
                'This account is owned by another canonical actor. Its records remain readable; revision requires the existing owner authority.',
              ),
            if (actions.message != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Semantics(
                  liveRegion: true,
                  child: Text(actions.message!),
                ),
              ),
            AccountHealthRecovery(controller: controller),
            AccountWorkflowRecovery(controller: controller),
            AccountFactPanel(controller: controller),
            AccountSalesforcePanel(controller: controller),
            if (actions.pending case final pending?) ...[
              Text(
                pending.create
                    ? 'Unconfirmed Account creation'
                    : 'Unconfirmed Account revision',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              SelectableText(
                'Account: ${pending.accountId}\nRequest: ${pending.requestSha256}\nName: ${pending.fields['name'] ?? 'unchanged'}\nExpected revision: ${pending.fields['expectedRevision'] ?? 'new'}',
              ),
              const Text(
                'Recovery sends only the original saved fields and idempotency key. A newer Account read cannot prove that this earlier request failed.',
              ),
              FilledButton(
                onPressed:
                    actions.writable &&
                        !actions.busy &&
                        !actions.storageUnconfirmed
                    ? () => actions.submit(recover: true)
                    : null,
                child: const Text('Retry exact saved request'),
              ),
            ] else if (actions.draft != null)
              _AccountEditor(
                key: ValueKey((actions, actions.draftVersion)),
                actions: actions,
              ),
            if (actions.accepted case final receipt?)
              ExpansionTile(
                title: Text(
                  'Accepted Account revision ${receipt.account.revision}',
                ),
                subtitle: const Text(
                  'Immutable acceptance · current Account may be newer',
                ),
                childrenPadding: const EdgeInsets.all(12),
                children: [
                  SelectableText(
                    'Name: ${receipt.account.name}\nAccount: ${receipt.account.id}\nRevision: ${receipt.account.revisionId}\nAccepted: ${receipt.acceptance['acceptedAt']}\nRequest: ${receipt.acceptance['requestSha256']}\nAcceptance: ${receipt.acceptance['acceptanceSha256']}',
                  ),
                  OutlinedButton(
                    onPressed: controller.busy ? null : controller.refreshCore,
                    child: const Text('Refresh current Account data'),
                  ),
                  if (actions.storageUnconfirmed && actions.pending == null)
                    OutlinedButton(
                      onPressed: actions.writable && !actions.busy
                          ? actions.settleReceiptLocally
                          : null,
                      child: const Text('Save accepted receipt locally'),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

class _AccountEditor extends StatefulWidget {
  const _AccountEditor({super.key, required this.actions});
  final AccountsMutationController actions;
  @override
  State<_AccountEditor> createState() => _AccountEditorState();
}

class _AccountEditorState extends State<_AccountEditor> {
  late final TextEditingController _name, _ownerName;
  @override
  void initState() {
    super.initState();
    _name = TextEditingController(
      text: widget.actions.draft!['name'] as String? ?? '',
    );
    _ownerName = TextEditingController(
      text:
          accountMap(widget.actions.draft!['accountOwner'])['displayName']
              as String,
    );
  }

  @override
  void dispose() {
    _name.dispose();
    _ownerName.dispose();
    super.dispose();
  }

  void _change(String key, Object? value) {
    final current = widget.actions.draft;
    if (current == null) {
      return;
    }
    widget.actions.edit({...current, key: value});
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final actions = widget.actions,
        draft = actions.draft!,
        enabled = actions.writable && !actions.locked;
    final owner = accountMap(draft['accountOwner']),
        purposes = List<String>.from(draft['customerDataPurposeIds'] as List);
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            actions.targetId == null
                ? 'New Account draft'
                : 'Revision draft · expected ${draft['expectedRevision']}',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          if (actions.targetId != null)
            SelectableText(
              'This saved draft changes only Account ${actions.targetId}. Its target does not follow navigation.',
            ),
          const Text(
            'Edits are saved encrypted after a short pause. Use Save draft before leaving this view. Submission requires your explicit review below.',
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _name,
            enabled: enabled,
            maxLength: 240,
            decoration: const InputDecoration(
              labelText: 'Account name',
              border: OutlineInputBorder(),
            ),
            onChanged: (value) => _change('name', value.trim()),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: draft['lifecycle'] as String,
            isExpanded: true,
            decoration: const InputDecoration(
              labelText: 'Lifecycle',
              border: OutlineInputBorder(),
            ),
            items: [
              for (final state in accountLifecycles)
                DropdownMenuItem(
                  value: state,
                  child: Text(state.replaceAll('_', ' ')),
                ),
            ],
            onChanged: enabled
                ? (value) {
                    if (value != null) {
                      _change('lifecycle', value);
                    }
                  }
                : null,
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _ownerName,
            enabled: enabled,
            maxLength: 180,
            decoration: const InputDecoration(
              labelText: 'Relationship owner display name',
              border: OutlineInputBorder(),
            ),
            onChanged: (value) => _change('accountOwner', {
              ...owner,
              'displayName': value.trim(),
            }),
          ),
          SelectableText(
            'Relationship owner identity: ${owner['ownerId']}\nOrganization link: ${draft['organizationEntityId'] ?? 'none'}',
          ),
          const Text(
            'Existing owner and organization identities are preserved. Editing the display name does not transfer canonical ownership.',
          ),
          const SizedBox(height: 8),
          Text(
            'Allowed data purposes',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          for (final purpose in accountPurposes)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: Text(
                purpose
                    .replaceFirst('customer_success.', '')
                    .replaceAll('_', ' '),
              ),
              subtitle:
                  purpose == accountPurposes[0] || purpose == accountPurposes[1]
                  ? const Text('Required for Account read and management')
                  : null,
              value: purposes.contains(purpose),
              onChanged:
                  !enabled ||
                      purpose == accountPurposes[0] ||
                      purpose == accountPurposes[1]
                  ? null
                  : (selected) {
                      final next = [...purposes]..remove(purpose);
                      if (selected == true) {
                        next.add(purpose);
                      }
                      next.sort();
                      _change('customerDataPurposeIds', next);
                    },
            ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              OutlinedButton(
                onPressed: enabled ? actions.saveDraft : null,
                child: const Text('Save draft'),
              ),
              FilledButton(
                onPressed:
                    enabled &&
                        _name.text.trim().isNotEmpty &&
                        _ownerName.text.trim().isNotEmpty
                    ? actions.submit
                    : null,
                child: Text(
                  actions.targetId == null
                      ? 'Create reviewed Account'
                      : 'Submit reviewed revision',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
