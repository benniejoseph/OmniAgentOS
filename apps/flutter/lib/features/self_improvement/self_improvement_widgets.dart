import 'package:flutter/material.dart';

import '../../app/theme/macos_app_theme.dart';
import 'self_improvement_models.dart';

String improvementLabel(String value) => switch (value) {
  'observing' => 'Investigating',
  'planned' => 'Repair planned',
  'implementing' => 'Building repair',
  'validating' => 'Checking repair',
  'correcting' => 'Refining repair',
  'review_required' => 'Needs your review',
  'ready_for_release' => 'Ready to publish',
  'releasing' => 'Publishing',
  'succeeded' => 'Released',
  'no_change' => 'No change needed',
  'failed' => 'Failed',
  'rolled_back' => 'Rolled back',
  'cancelled' => 'Cancelled',
  'focused_regression' => 'Reported problem',
  'adjacent_regression' => 'Related behavior',
  'typecheck' => 'Type checks',
  'independent_review' => 'Independent review',
  'behavior_comparison' => 'Behavior comparison',
  'build' => 'Production build',
  'lint' => 'Code quality',
  'passed' => 'Passed',
  'incomplete' => 'Incomplete',
  'not_run' => 'Not run',
  _ => value.replaceAll('_', ' '),
};

String improvementMoney(num value) => '\$${value.toStringAsFixed(2)}';

String improvementDate(BuildContext context, String? value) {
  final date = value == null ? null : DateTime.tryParse(value);
  if (date == null) return 'Not recorded';
  final local = date.toLocal(),
      localization = MaterialLocalizations.of(context);
  return '${localization.formatMediumDate(local)} · ${localization.formatTimeOfDay(TimeOfDay.fromDateTime(local), alwaysUse24HourFormat: true)} local';
}

String improvementHoldMessage(String category) => switch (category) {
  'manual_operator_release_required' =>
    'Protected files require a trusted manual release after your review.',
  'source_drift' || 'base_revision_changed' || 'candidate_source_drift' => 'The source changed. Publishing is held until the repair is checked against the current code.',
  'usage_unknown' || 'usage_reconciliation_required' => 'Some AI usage is not yet reconciled. Publishing is held until its cost is known.',
  'policy_mismatch' || 'policy_not_allowed' => 'The publisher needs enrollment for this saved policy before it can release the repair.',
  _ =>
    'Publishing is held: ${category.replaceAll('_', ' ')}. Automatic retry is stopped.',
};

class ImprovementStatus extends StatelessWidget {
  const ImprovementStatus(this.stage, {super.key});
  final String stage;
  @override
  Widget build(BuildContext context) {
    final mac = MacosThemeColors.of(context),
        scheme = Theme.of(context).colorScheme;
    final (icon, color) = switch (stage) {
      'succeeded' || 'passed' => (Icons.check_circle_outline, mac.positive),
      'failed' || 'rolled_back' => (Icons.error_outline, scheme.error),
      'review_required' ||
      'ready_for_release' ||
      'incomplete' => (Icons.pending_outlined, mac.warning),
      'no_change' ||
      'cancelled' ||
      'not_run' => (Icons.remove_circle_outline, scheme.onSurfaceVariant),
      _ => (Icons.pending_outlined, scheme.primary),
    };
    return Wrap(
      spacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Icon(icon, size: 16, color: color),
        Text(
          improvementLabel(stage),
          style: Theme.of(context).textTheme.labelLarge?.copyWith(color: color),
        ),
      ],
    );
  }
}

class ImprovementNotice extends StatelessWidget {
  const ImprovementNotice(
    this.message, {
    super.key,
    this.error = false,
    this.action,
  });
  final String message;
  final bool error;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            error ? Icons.error_outline : Icons.info_outline,
            size: 18,
            color: error
                ? Theme.of(context).colorScheme.error
                : Theme.of(context).colorScheme.onSurfaceVariant,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(message),
                if (action != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: action!,
                  ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

/// Decisions keep the exact validated cycle object captured by the parent.
class ImprovementCycleEvidence extends StatefulWidget {
  const ImprovementCycleEvidence({
    super.key,
    required this.cycle,
    this.onApprove,
    this.onReject,
    this.onDiscard,
    this.onRetry,
    this.onStopNativeCheck,
    this.onOpenRun,
  });
  final SelfImprovementCycle cycle;
  final VoidCallback? onApprove,
      onReject,
      onDiscard,
      onRetry,
      onStopNativeCheck;
  final ValueChanged<String>? onOpenRun;
  @override
  State<ImprovementCycleEvidence> createState() =>
      _ImprovementCycleEvidenceState();
}

class _ImprovementCycleEvidenceState extends State<ImprovementCycleEvidence> {
  bool _confirmDiscard = false;
  @override
  void didUpdateWidget(covariant ImprovementCycleEvidence oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.cycle.id != widget.cycle.id ||
        oldWidget.cycle.revision != widget.cycle.revision) {
      _confirmDiscard = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final cycle = widget.cycle,
        candidate = cycle.candidate,
        validation = cycle.validation;
    final hold = cycle.controllerHold, release = cycle.releaseReceipt;
    final renew = cycle.approvalRenewalAvailable;
    final review = cycle.stage == 'review_required' || renew;
    final manual = cycle.releaseEligibility == 'manual_release';
    final native = validation?.native;
    final theme = Theme.of(context);
    return SelectionArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ImprovementStatus(cycle.stage),
          const SizedBox(height: 12),
          Text(
            review ? 'Review this repair' : 'Cycle details',
            style: theme.textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          Text(
            cycle.summary.isNotEmpty
                ? cycle.summary
                : 'Asael has not recorded an investigation summary yet.',
            style: theme.textTheme.bodyLarge,
          ),
          const SizedBox(height: 8),
          Text(
            'Updated ${improvementDate(context, cycle.updatedAt)}',
            style: theme.textTheme.bodySmall,
          ),
          if (hold != null)
            ImprovementNotice(
              improvementHoldMessage(hold['category'] as String),
            ),
          if (cycle.nativeCheck case final check?) ...[
            ImprovementNotice(
              cycle.stage == 'cancelled'
                  ? 'The Mac check was stopped. Its evidence is retained.'
                  : switch (check['status']) {
                      'queued' => 'Waiting for the Mac publisher to run this check. No additional AI work starts while it waits.',
                      'claimed' => 'The Mac publisher is validating this exact source snapshot.',
                      'held' => 'The Mac check needs attention. Its evidence is retained and it will not repeat automatically.',
                      _ => 'The Mac check finished; its recorded result is available below.',
                    },
            ),
            if (cycle.stage != 'cancelled' && cycle.canStopNativeCheck)
              OutlinedButton(
                onPressed: widget.onStopNativeCheck,
                child: const Text('Stop check'),
              ),
          ],
          if (cycle.approvalExpired)
            ImprovementNotice(
              renew
                  ? 'The earlier approval expired. Renew it for the same code and saved checks without starting another repair.'
                  : 'The earlier approval expired. Renewal is unavailable in this release state; the code and checks are retained.',
            ),
          if (review)
            ImprovementNotice(
              manual
                  ? 'This repair changes protected code. Your approval records the review; a trusted operator must publish it manually.'
                  : native != null
                  ? 'One approval authorizes this tested Mac package to be signed, installed and reopened. Asael waits for current work to finish and restores the previous app if startup verification fails.'
                  : 'Approval applies only to this exact repair and its recorded checks.',
            ),
          if (cycle.stage == 'ready_for_release' &&
              hold == null &&
              !cycle.approvalExpired)
            const ImprovementNotice(
              'Validation is complete. Publishing waits for the enrolled Mac publisher and its production checks.',
            ),
          if (cycle.agentRuns.isNotEmpty) ...[
            _section(context, 'Agent work'),
            for (final run in cycle.agentRuns)
              ListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                leading: const Icon(Icons.account_tree_outlined, size: 20),
                title: Text(switch (run.agentId) {
                  'atlas' => 'Atlas',
                  'forge' => 'Forge',
                  _ => 'Sentinel',
                }),
                subtitle: Text(
                  '${improvementLabel(run.phase)} · ${run.completed ? 'completed' : 'recorded'}',
                ),
                trailing: widget.onOpenRun == null
                    ? null
                    : const Icon(Icons.chevron_right, size: 18),
                onTap: widget.onOpenRun == null
                    ? null
                    : () => widget.onOpenRun!(run.runId),
              ),
          ],
          if (validation != null) ...[
            _section(context, 'Validation evidence'),
            if (validation.baselineReproduction case final baseline?)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(
                  'Original problem reproduced: ${baseline['failedCases']} failing ${baseline['failedCases'] == 1 ? 'case' : 'cases'} out of ${baseline['executedCases']} executed.',
                ),
              ),
            for (final check in validation.checks)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            improvementLabel(check.kind),
                            style: theme.textTheme.titleSmall,
                          ),
                          Text(
                            '${check.executedCases}/${check.declaredCases} ${check.kind == 'independent_review' ? 'review checks' : 'checks'}${check.failedCases > 0 ? ' · ${check.failedCases} failed' : ''}',
                            style: theme.textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    Flexible(child: ImprovementStatus(check.outcome)),
                  ],
                ),
              ),
          ],
          if (candidate != null) ...[
            if (native != null) ...[
              _section(context, 'Mac update'),
              Text(
                'Asael ${native.version} (${native.buildNumber})',
                style: theme.textTheme.titleMedium,
              ),
              const SizedBox(height: 4),
              Text(
                'Replaces build ${native.previousBuildNumber} on this Mac. The web and worker release stay unchanged.',
              ),
            ],
            _section(context, 'Changes'),
            Text(
              '${candidate.changedFiles.length} ${candidate.changedFiles.length == 1 ? 'file' : 'files'} · ${candidate.changedLines} changed lines',
            ),
            const SizedBox(height: 8),
            for (final file in candidate.changedFiles)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Text(file.path, style: theme.textTheme.bodySmall),
              ),
          ],
          if (review) ...[
            const SizedBox(height: 20),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton(
                  onPressed: widget.onApprove,
                  child: Text(
                    renew
                        ? 'Renew approval'
                        : manual
                        ? 'Approve for manual release'
                        : native != null
                        ? 'Approve Mac update'
                        : 'Approve this repair',
                  ),
                ),
                OutlinedButton(
                  onPressed: widget.onReject,
                  child: const Text('Decline repair'),
                ),
              ],
            ),
          ],
          if (cycle.discardAvailable) ...[
            const SizedBox(height: 16),
            const Text(
              'Discarding this held candidate keeps its evidence and lets future work resume.',
            ),
            const SizedBox(height: 8),
            if (!_confirmDiscard)
              OutlinedButton(
                onPressed: widget.onDiscard == null
                    ? null
                    : () => setState(() => _confirmDiscard = true),
                child: const Text('Discard candidate'),
              )
            else
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  FilledButton(
                    onPressed: widget.onDiscard,
                    child: const Text('Confirm discard'),
                  ),
                  TextButton(
                    onPressed: () => setState(() => _confirmDiscard = false),
                    child: const Text('Keep candidate'),
                  ),
                ],
              ),
          ],
          if (cycle.setupRetryAvailable) ...[
            const SizedBox(height: 16),
            const Text(
              'Setup was rejected before workspace or AI work began. One new attempt preserves this failure and its budget history.',
            ),
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: widget.onRetry,
              child: const Text('Retry setup once'),
            ),
          ],
          if (release != null) ...[
            _section(context, 'Release result'),
            Text(switch (release.outcome) {
              'deployed' =>
                native != null
                    ? 'The signed Mac update was installed and startup was verified.'
                    : 'The verified repair was deployed.',
              'rolled_back' =>
                native != null
                    ? 'The previous Mac app was restored and reopened.'
                    : 'The release was rolled back.',
              _ => 'The release failed.',
            }),
          ],
          _section(context, 'Recorded AI cost'),
          Text(
            cycle.usageState == 'known'
                ? '${improvementMoney(cycle.spendUsd)} USD'
                : 'Not fully reconciled',
            style: theme.textTheme.titleMedium,
          ),
          if (cycle.usageState != 'known')
            const Padding(
              padding: EdgeInsets.only(top: 6),
              child: Text(
                'Unconfirmed usage is retained. This is not a zero-cost result.',
              ),
            ),
          const SizedBox(height: 20),
          ExpansionTile(
            key: ValueKey('improvement-technical-${cycle.id}'),
            tilePadding: EdgeInsets.zero,
            title: const Text('Technical details'),
            children: [
              _datum('Cycle', cycle.id),
              _datum('Phase', improvementLabel(cycle.phase)),
              _datum('Base revision', cycle.baseRevision),
              if (candidate != null) ...[
                _datum('Candidate revision', candidate.revision),
                _datum('Candidate fingerprint', candidate.candidateSha256),
              ],
              if (validation != null)
                _datum('Validation fingerprint', validation.validationSha256),
              if (native != null) ...[
                _datum('Mac artifact fingerprint', native.artifactSha256),
                _datum('Previous Mac baseline', native.baselineSha256),
              ],
              if (release != null) ...[
                if (release.nativeInstall != null)
                  _datum(
                    'Installed Mac bundle',
                    release.nativeInstall!['installedBundleSha256'] as String,
                  ),
                _datum('Web revision', release.webRevision),
                _datum('Worker revision', release.workerRevision),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _section(BuildContext context, String text) => Padding(
    padding: const EdgeInsets.only(top: 24, bottom: 10),
    child: Text(text, style: Theme.of(context).textTheme.titleMedium),
  );
  Widget _datum(String label, String value) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Align(
      alignment: Alignment.centerLeft,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label),
          const SizedBox(height: 3),
          SelectableText(value),
        ],
      ),
    ),
  );
}
