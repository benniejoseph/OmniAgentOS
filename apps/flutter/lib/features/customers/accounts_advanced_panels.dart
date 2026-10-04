import 'package:flutter/material.dart';

import 'accounts_advanced_contracts.dart';
import 'accounts_contracts.dart';
import 'accounts_controller.dart';

class AccountsAdvancedPanels extends StatelessWidget {
  const AccountsAdvancedPanels({super.key, required this.controller});
  final AccountsController controller;
  @override
  Widget build(BuildContext context) => Column(
    children: [
      for (final kind in AccountAdvancedKind.values)
        if (controller.repository.access.operations.contains(kind.operation) &&
            (controller.accountId != null ||
                kind == AccountAdvancedKind.salesforce))
          _AdvancedPanel(
            key: ValueKey((controller, kind)),
            controller: controller,
            kind: kind,
          ),
    ],
  );
}

class _AdvancedPanel extends StatelessWidget {
  const _AdvancedPanel({
    super.key,
    required this.controller,
    required this.kind,
  });
  final AccountsController controller;
  final AccountAdvancedKind kind;
  @override
  Widget build(BuildContext context) {
    final source = controller.advancedReads[kind]!, value = source.value;
    final isOld = source.state != AccountReadState.current;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(kind.label, style: Theme.of(context).textTheme.titleLarge),
            Text(switch (kind) {
              AccountAdvancedKind.health => 'The current health score and retained history are separate reads. A missing score is unknown health. Up to 20 scores are requested; no complete-history claim.',
              AccountAdvancedKind.intelligence => 'Bounded risks, meeting commitments, approvals and timeline. Suggestions are advisory and confer no action authority.',
              AccountAdvancedKind.workflows => 'Up to 50 existing workflow runs and their recorded outcomes. Reading this panel starts no workflow or external action.',
              AccountAdvancedKind.salesforce => 'Workspace-wide connection observations, up to 50 reconciliation findings and 25 write observations. This panel does not connect, sync or replay provider writes.',
            }),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                OutlinedButton.icon(
                  onPressed:
                      controller.readable &&
                          controller.workspaceId != null &&
                          !source.loading
                      ? () => controller.refreshAdvanced(kind)
                      : null,
                  icon: const Icon(Icons.refresh),
                  label: Text(
                    value == null
                        ? 'Read ${kind.label}'
                        : 'Refresh ${kind.label}',
                  ),
                ),
                if (source.loading) const Text('Reading current source…'),
                if (value != null)
                  Text(
                    isOld
                        ? 'Previously verified snapshot · not current'
                        : 'Verified current read',
                  ),
              ],
            ),
            if (source.message != null)
              Semantics(liveRegion: true, child: Text(source.message!)),
            if (value != null) ...[
              if (kind == AccountAdvancedKind.health)
                _HealthSummary(
                  value: value,
                  current: controller.detail.value?.account,
                ),
              if (kind == AccountAdvancedKind.intelligence) ...[
                Text(
                  'Suggested next action: ${(value.raw['intelligence'] as Map)['nextBestAction']['title']}',
                ),
                const Text(
                  'Inspect the cited evidence and freshness before using this suggestion.',
                ),
              ],
              if (kind == AccountAdvancedKind.salesforce) ...[
                Text(
                  'Connection: ${(value.raw['health'] as Map)['status']} · write policy: approval required',
                ),
                const Text(
                  'Prepared provider operations with attempts may already have an external effect. Inspection is not permission to retry. Salesforce status has no app-service receipt; exact workspace and fresh session checks bind this read.',
                ),
              ],
              for (final entry in value.raw.entries)
                if (entry.key != 'context' &&
                    entry.key != 'authorizeUrl' &&
                    entry.key != 'webhook')
                  _AccountEvidenceTree(
                    label: _label(entry.key),
                    value: entry.value,
                  ),
            ],
          ],
        ),
      ),
    );
  }
}

class _HealthSummary extends StatelessWidget {
  const _HealthSummary({required this.value, this.current});
  final AccountAdvancedRead value;
  final CustomerAccountSummary? current;
  @override
  Widget build(BuildContext context) {
    final raw = value.raw['score'];
    if (raw == null) {
      return const Text(
        'No current health score was returned. This does not mean healthy.',
      );
    }
    final score = accountMap(raw),
        matches =
            score['accountRevisionId'] == current?.revisionId &&
            score['accountSha256'] == current?.sha256;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Observed health: ${score['status']} · ${score['scoreBasisPoints'] == null ? 'not scored' : '${(score['scoreBasisPoints'] as int) / 100}%'}',
        ),
        Text(
          'Confidence ${(score['confidenceBasisPoints'] as int) / 100}% · coverage ${(score['coverageBasisPoints'] as int) / 100}%',
        ),
        Text(
          matches ? 'Score binds the exact displayed Account revision.' : 'Score describes another Account revision; it is historical evidence for the current Account view.',
        ),
      ],
    );
  }
}

String _label(String value) => value
    .replaceAllMapped(
      RegExp(r'([a-z])([A-Z])'),
      (match) => '${match[1]} ${match[2]}',
    )
    .replaceAll('_', ' ');

/// Expand only requested branches. Large bounded evidence lists are paged
/// locally without implying that another server page exists.
class _AccountEvidenceTree extends StatefulWidget {
  const _AccountEvidenceTree({required this.label, required this.value});
  final String label;
  final Object? value;
  @override
  State<_AccountEvidenceTree> createState() => _AccountEvidenceTreeState();
}

class _AccountEvidenceTreeState extends State<_AccountEvidenceTree> {
  bool _open = false;
  int _shown = 20;
  @override
  Widget build(BuildContext context) {
    final value = widget.value;
    if (value is! Map && value is! List) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: SelectableText('${widget.label}: ${value ?? 'not reported'}'),
      );
    }
    final entries = <MapEntry<String, Object?>>[];
    if (value is Map) {
      entries.addAll(
        value.entries.map(
          (entry) => MapEntry(_label(entry.key.toString()), entry.value),
        ),
      );
    } else {
      final list = value as List;
      for (var i = 0; i < list.length; i++) {
        entries.add(MapEntry('Item ${i + 1}', list[i]));
      }
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextButton.icon(
          style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
          onPressed: () => setState(() => _open = !_open),
          icon: Icon(_open ? Icons.expand_less : Icons.expand_more),
          label: Text('${widget.label} · ${entries.length}'),
        ),
        if (_open)
          Padding(
            padding: const EdgeInsets.only(left: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final entry in entries.take(_shown))
                  _AccountEvidenceTree(label: entry.key, value: entry.value),
                if (entries.length > _shown)
                  TextButton(
                    onPressed: () => setState(() => _shown += 20),
                    child: Text(
                      'Show next ${entries.length - _shown > 20 ? 20 : entries.length - _shown} returned entries',
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}
