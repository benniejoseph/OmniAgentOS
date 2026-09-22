import 'package:flutter/material.dart';

import 'agent_council.dart';

/// Portable Agent Control surface used by Android and other non-macOS native
/// clients. Canonical state and cancellation authority remain on the server.
class AgentControlView extends StatefulWidget {
  const AgentControlView({super.key, required this.controller});

  final AgentCouncilController controller;

  @override
  State<AgentControlView> createState() => _AgentControlViewState();
}

class _AgentControlViewState extends State<AgentControlView> {
  @override
  void initState() {
    super.initState();
    if (widget.controller.projection == null && !widget.controller.loading) {
      widget.controller.refresh();
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      final projection = controller.projection;
      if (projection == null && controller.loading) {
        return const Center(child: CircularProgressIndicator());
      }
      if (projection == null) {
        return _AgentControlNotice(
          icon: Icons.cloud_off_outlined,
          title: 'Live work is unavailable',
          message:
              '${controller.error ?? 'The canonical delegation ledger could not be loaded.'}',
          onRetry: controller.refresh,
        );
      }
      if (projection.state == 'unavailable') {
        return _AgentControlNotice(
          icon: Icons.sync_problem_outlined,
          title: 'Delegation ledger is unavailable',
          message: 'No task health or authority was inferred.',
          onRetry: controller.refresh,
        );
      }
      if (projection.executions.isEmpty) {
        return _AgentControlNotice(
          icon: Icons.account_tree_outlined,
          title: 'No delegated work yet',
          message: 'Bounded specialist tasks will appear here with their authority, runtime, cost, and verification.',
          onRetry: controller.refresh,
        );
      }
      return RefreshIndicator(
        onRefresh: controller.refresh,
        child: ListView(
          key: const Key('android-agent-control-list'),
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 28),
          children: [
            _AgentControlSummary(projection: projection),
            if (controller.error != null) ...[
              const SizedBox(height: 10),
              _InlineNotice(
                message:
                    'Showing the last verified ledger. Refresh failed: ${controller.error}',
              ),
            ],
            const SizedBox(height: 12),
            for (final execution in projection.executions) ...[
              _ExecutionCard(
                execution: execution,
                controller: controller,
                onCancel: _confirmCancel,
              ),
              const SizedBox(height: 12),
            ],
          ],
        ),
      );
    },
  );

  Future<void> _confirmCancel(AgentCouncilMember member) async {
    final reasonController = TextEditingController(
      text: 'Canceled from Agent Control.',
    );
    final reason = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Cancel ${member.identity.name}\'s task?'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'The child execution will stop. Recorded work remains available.',
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('android-agent-control-cancel-reason'),
              controller: reasonController,
              maxLength: 500,
              decoration: const InputDecoration(labelText: 'Reason'),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Keep running'),
          ),
          FilledButton(
            key: const Key('android-agent-control-confirm-cancel'),
            onPressed: () {
              final value = reasonController.text.trim();
              if (value.isNotEmpty) Navigator.pop(dialogContext, value);
            },
            child: const Text('Cancel task'),
          ),
        ],
      ),
    );
    reasonController.dispose();
    if (reason == null || !mounted) return;
    try {
      await widget.controller.cancelTask(member, reason: reason);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Task canceled. Recorded evidence remains available.'),
        ),
      );
      await widget.controller.refresh();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('$error')));
    }
  }
}

class _AgentControlSummary extends StatelessWidget {
  const _AgentControlSummary({required this.projection});

  final AgentCouncilProjection projection;

  @override
  Widget build(BuildContext context) {
    final summary = projection.summary;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.account_tree_outlined,
                  color: Theme.of(context).colorScheme.primary,
                ),
                const SizedBox(width: 9),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Agent Control',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      Text(
                        'Canonical delegated work',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                _Metric(value: summary.executionCount, label: 'runs'),
                _Metric(value: summary.activeMemberCount, label: 'active'),
                _Metric(value: summary.waitingMemberCount, label: 'waiting'),
                _Metric(value: summary.acceptedMemberCount, label: 'accepted'),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Metric extends StatelessWidget {
  const _Metric({required this.value, required this.label});
  final int value;
  final String label;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(10),
    ),
    child: Text(
      '$value $label',
      style: Theme.of(context).textTheme.labelMedium,
    ),
  );
}

class _ExecutionCard extends StatelessWidget {
  const _ExecutionCard({
    required this.execution,
    required this.controller,
    required this.onCancel,
  });

  final AgentCouncilExecution execution;
  final AgentCouncilController controller;
  final ValueChanged<AgentCouncilMember> onCancel;

  @override
  Widget build(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    clipBehavior: Clip.antiAlias,
    child: ExpansionTile(
      initiallyExpanded: true,
      leading: const Icon(Icons.hub_outlined),
      title: Text(
        execution.currentWork,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        '${execution.members.length} specialist${execution.members.length == 1 ? '' : 's'} · ${_label(execution.status)}',
      ),
      children: [
        for (final member in execution.members)
          _MemberTile(
            member: member,
            controller: controller,
            onCancel: onCancel,
          ),
      ],
    ),
  );
}

class _MemberTile extends StatelessWidget {
  const _MemberTile({
    required this.member,
    required this.controller,
    required this.onCancel,
  });

  final AgentCouncilMember member;
  final AgentCouncilController controller;
  final ValueChanged<AgentCouncilMember> onCancel;

  @override
  Widget build(BuildContext context) {
    final runtime = member.runtime;
    final verifierRuntime = member.verifier.runtime;
    final canceling = controller.isCanceling(member.taskId);
    final cancelError = controller.cancellationError(member.taskId);
    return Container(
      key: Key('android-agent-control-member-${member.taskId}'),
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 13, 16, 16),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: Theme.of(context).dividerColor)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 18,
                child: Text(member.identity.name.characters.first),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      member.identity.name,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    Text(
                      '${member.identity.role} · ${_label(member.state)}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(member.currentWork),
          const SizedBox(height: 12),
          _FactRow(
            label: 'Worker runtime',
            value: runtime == null
                ? 'Not recorded'
                : '${runtime.providerId} · ${runtime.modelId} · ${_label(runtime.modelTier)}',
          ),
          _FactRow(
            label: 'Verifier runtime',
            value: verifierRuntime == null
                ? 'Not recorded'
                : '${verifierRuntime.providerId} · ${verifierRuntime.modelId} · ${_label(verifierRuntime.modelTier)}',
          ),
          _FactRow(
            label: 'Authority',
            value:
                '${member.authority.contextGrantCount} context · ${member.authority.capabilityGrantCount} capability · ${member.authority.toolIds.length} tools',
          ),
          _FactRow(
            label: 'Usage',
            value: member.cost.receiptCount == 0
                ? 'Not recorded'
                : '${member.cost.totalTokens} tokens · ${_money(member.cost.knownEstimatedCostMicrousd)}',
          ),
          _FactRow(
            label: 'Verifier',
            value:
                '${member.verifier.identity.name} · ${_label(member.verifier.verdict)}${member.verifier.score == null ? '' : ' · ${(member.verifier.score! * 100).round()}%'}',
          ),
          if (cancelError != null) ...[
            const SizedBox(height: 8),
            _InlineNotice(message: '$cancelError'),
          ],
          if (controller.canCancel(member)) ...[
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerRight,
              child: OutlinedButton.icon(
                key: Key('android-agent-control-cancel-${member.taskId}'),
                onPressed: canceling ? null : () => onCancel(member),
                icon: canceling
                    ? const SizedBox.square(
                        dimension: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.stop_circle_outlined, size: 18),
                label: Text(canceling ? 'Canceling' : 'Cancel task'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _FactRow extends StatelessWidget {
  const _FactRow({required this.label, required this.value});
  final String label, value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 5),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 108,
          child: Text(label, style: Theme.of(context).textTheme.labelSmall),
        ),
        Expanded(
          child: Text(value, style: Theme.of(context).textTheme.bodySmall),
        ),
      ],
    ),
  );
}

class _InlineNotice extends StatelessWidget {
  const _InlineNotice({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.errorContainer,
      borderRadius: BorderRadius.circular(10),
    ),
    child: Text(
      message,
      style: Theme.of(context).textTheme.bodySmall
          ?.copyWith(color: Theme.of(context).colorScheme.onErrorContainer),
    ),
  );
}

class _AgentControlNotice extends StatelessWidget {
  const _AgentControlNotice({
    required this.icon,
    required this.title,
    required this.message,
    required this.onRetry,
  });

  final IconData icon;
  final String title, message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 42),
          const SizedBox(height: 12),
          Text(title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 6),
          Text(message, textAlign: TextAlign.center),
          const SizedBox(height: 16),
          FilledButton.tonalIcon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh_rounded),
            label: const Text('Refresh'),
          ),
        ],
      ),
    ),
  );
}

String _label(String value) => value
    .replaceAll('_', ' ')
    .split(' ')
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');

String _money(int microusd) => '\$${(microusd / 1000000).toStringAsFixed(4)}';
