import 'package:flutter/material.dart';

import 'agent_governance.dart';

typedef AgentGovernanceLoad = Future<AgentGovernanceSnapshot> Function();
typedef AgentGovernanceMutation = Future<AgentGovernanceSnapshot> Function(
  AgentGovernanceJson action,
);

/// Responsive release and non-authority adaptation console shared by macOS
/// and Android. It intentionally has no retirement or signed-grant controls.
class AgentGovernanceView extends StatefulWidget {
  const AgentGovernanceView({
    super.key,
    required this.agentId,
    required this.builtIn,
    required this.canRead,
    required this.canManage,
    required this.load,
    required this.manageRelease,
    required this.manageAdaptation,
    this.compact = false,
  });

  final String agentId;
  final bool builtIn, canRead, canManage;
  final AgentGovernanceLoad load;
  final AgentGovernanceMutation manageRelease, manageAdaptation;
  final bool compact;

  @override
  State<AgentGovernanceView> createState() => _AgentGovernanceViewState();
}

class _AgentGovernanceViewState extends State<AgentGovernanceView> {
  AgentGovernanceSnapshot? _snapshot;
  Object? _error;
  bool _loading = false;
  String? _action;

  @override
  void initState() {
    super.initState();
    if (widget.canRead && !widget.builtIn) {
      Future<void>.microtask(_load);
    }
  }

  @override
  void didUpdateWidget(covariant AgentGovernanceView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.agentId != widget.agentId) {
      _snapshot = null;
      _error = null;
      if (widget.canRead && !widget.builtIn) {
        Future<void>.microtask(_load);
      }
    }
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final value = await widget.load();
      if (mounted) setState(() => _snapshot = value);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _release(AgentGovernanceJson action) async =>
      _mutate('release-${action['action']}', () {
        return widget.manageRelease(action);
      });

  Future<void> _adapt(AgentGovernanceJson action) async =>
      _mutate('adaptation-${action['action']}', () {
        return widget.manageAdaptation(action);
      });

  Future<void> _mutate(
    String key,
    Future<AgentGovernanceSnapshot> Function() action,
  ) async {
    if (_action != null) return;
    setState(() {
      _action = key;
      _error = null;
    });
    try {
      final value = await action();
      if (mounted) setState(() => _snapshot = value);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _action = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.builtIn) {
      return const _GovernanceNotice(
        icon: Icons.lock_outline_rounded,
        message: 'Built-in Agents use immutable system release definitions.',
      );
    }
    if (!widget.canRead) {
      return const _GovernanceNotice(
        icon: Icons.system_update_outlined,
        message:
            'Release and adaptation evidence requires native contract v25.',
      );
    }
    final snapshot = _snapshot;
    if (snapshot == null && _loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 24),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (snapshot == null) {
      return _GovernanceNotice(
        icon: Icons.cloud_off_outlined,
        message: _error == null
            ? 'Release governance is unavailable.'
            : 'Release governance could not be loaded: $_error',
        action: TextButton.icon(
          onPressed: _load,
          icon: const Icon(Icons.refresh_rounded, size: 16),
          label: const Text('Retry'),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_error != null)
          Container(
            width: double.infinity,
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.errorContainer,
              borderRadius: BorderRadius.circular(9),
            ),
            child: Text('Showing last verified state. $_error'),
          ),
        _ReleasePanel(
          snapshot: snapshot,
          canManage: widget.canManage,
          busy: _action,
          onAction: _release,
        ),
        const SizedBox(height: 14),
        _AdaptationPanel(
          snapshot: snapshot,
          canManage: widget.canManage,
          busy: _action,
          onAction: _adapt,
        ),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton.icon(
            onPressed: _loading ? null : _load,
            icon: _loading
                ? const SizedBox.square(
                    dimension: 14,
                    child: CircularProgressIndicator(strokeWidth: 1.8),
                  )
                : const Icon(Icons.refresh_rounded, size: 16),
            label: const Text('Refresh evidence'),
          ),
        ),
      ],
    );
  }
}

class _ReleasePanel extends StatelessWidget {
  const _ReleasePanel({
    required this.snapshot,
    required this.canManage,
    required this.busy,
    required this.onAction,
  });

  final AgentGovernanceSnapshot snapshot;
  final bool canManage;
  final String? busy;
  final ValueChanged<AgentGovernanceJson> onAction;

  @override
  Widget build(BuildContext context) {
    final release = snapshot.release;
    final evaluations = release.evaluations;
    final mutable = canManage && release.state == 'active';
    return _GovernanceCard(
      title: 'Release channel',
      icon: Icons.rocket_launch_outlined,
      trailing: _StatusPill(release.state),
      children: [
        _ValueLine(
          label: 'Active',
          value:
              'v${release.activeDefinitionVersion} · ${release.activeDefinitionVersionId}',
        ),
        _ValueLine(
          label: 'Latest',
          value:
              'v${release.latestDefinitionVersion} · ${release.latestDefinitionVersionId}',
        ),
        _ValueLine(label: 'Revision', value: '${release.releaseRevision}'),
        if (evaluations.isNotEmpty) ...[
          const SizedBox(height: 9),
          Text(
            'Evaluated transitions · ${evaluations.length}',
            style: Theme.of(context).textTheme.labelLarge,
          ),
          const SizedBox(height: 7),
          for (final evaluation in evaluations)
            _ReleaseEvaluationCard(
              evaluation: evaluation,
              candidate:
                  release.candidateEvaluation?.evaluationId ==
                  evaluation.evaluationId,
              canManage: mutable,
              busy: busy,
              onAction: onAction,
            ),
        ],
        const SizedBox(height: 9),
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: Text('Definition versions · ${release.versions.length}'),
          children: [
            for (final version in release.versions)
              ListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                title: SelectableText(version.definitionVersionId),
                subtitle: Text(
                  version.active
                      ? 'Active release'
                      : 'Published ${_shortTime(version.publishedAt)}',
                ),
                trailing: mutable && !version.active && busy == null
                    ? TextButton(
                        onPressed: () => onAction({
                          'action': 'evaluate',
                          'definitionVersion': version.definitionVersion,
                        }),
                        child: const Text('Evaluate'),
                      )
                    : version.active
                    ? const Icon(Icons.check_circle_outline, size: 18)
                    : null,
              ),
          ],
        ),
        const Text(
          'Retirement is intentionally unavailable in the native app.',
        ),
      ],
    );
  }
}

class _ReleaseEvaluationCard extends StatelessWidget {
  const _ReleaseEvaluationCard({
    required this.evaluation,
    required this.candidate,
    required this.canManage,
    required this.busy,
    required this.onAction,
  });

  final AgentReleaseEvaluation evaluation;
  final bool candidate, canManage;
  final String? busy;
  final ValueChanged<AgentGovernanceJson> onAction;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    margin: const EdgeInsets.only(bottom: 8),
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(9),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                '${_label(evaluation.direction)} v${evaluation.baselineDefinitionVersion} → v${evaluation.definitionVersion}',
                style: Theme.of(context).textTheme.labelLarge,
              ),
            ),
            if (candidate) const _StatusPill('Latest candidate'),
          ],
        ),
        const SizedBox(height: 5),
        _ValueLine(
          label: 'Baseline',
          value: evaluation.baselineDefinitionVersionId,
        ),
        _ValueLine(
          label: 'Baseline SHA-256',
          value: evaluation.baselineDefinitionSha256,
        ),
        _ValueLine(label: 'Target', value: evaluation.definitionVersionId),
        _ValueLine(label: 'Target SHA-256', value: evaluation.definitionSha256),
        SelectableText(
          evaluation.evaluationId,
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 3),
        SelectableText(
          evaluation.evaluationSha256,
          style: Theme.of(context).textTheme.labelSmall,
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: evaluation.changedFields
              .map((field) => Chip(label: Text(_label(field))))
              .toList(growable: false),
        ),
        if (canManage) ...[
          const SizedBox(height: 7),
          FilledButton.tonalIcon(
            key: ValueKey(
              'agent-release-transition-${evaluation.evaluationId}',
            ),
            onPressed: busy == null
                ? () => onAction({
                    'action': evaluation.direction == 'promotion'
                        ? 'promote'
                        : 'rollback',
                    'evaluationId': evaluation.evaluationId,
                  })
                : null,
            icon: const Icon(Icons.swap_horiz_rounded, size: 17),
            label: Text(
              evaluation.direction == 'promotion'
                  ? 'Promote exact version'
                  : 'Roll back exact version',
            ),
          ),
        ],
      ],
    ),
  );
}

class _AdaptationPanel extends StatelessWidget {
  const _AdaptationPanel({
    required this.snapshot,
    required this.canManage,
    required this.busy,
    required this.onAction,
  });

  final AgentGovernanceSnapshot snapshot;
  final bool canManage;
  final String? busy;
  final ValueChanged<AgentGovernanceJson> onAction;

  @override
  Widget build(BuildContext context) => _GovernanceCard(
    title: 'Observed adaptations',
    icon: Icons.auto_awesome_outlined,
    trailing: canManage
        ? IconButton(
            key: const Key('agent-adaptations-refresh'),
            tooltip: 'Observe new correction-backed evidence',
            onPressed: busy == null
                ? () => onAction(const {'action': 'refresh'})
                : null,
            icon: const Icon(Icons.refresh_rounded, size: 18),
          )
        : null,
    children: snapshot.adaptations.isEmpty
        ? [
            const Text(
              'No correction-backed adaptations are available. Unknown is not treated as healthy or empty evidence.',
            ),
          ]
        : [
            for (final adaptation in snapshot.adaptations) ...[
              Container(
                width: double.infinity,
                margin: const EdgeInsets.only(bottom: 9),
                padding: const EdgeInsets.all(11),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surfaceContainerLow,
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            _label(adaptation.state),
                            style: Theme.of(context).textTheme.labelLarge,
                          ),
                        ),
                        Text('${(adaptation.confidence * 100).round()}%'),
                      ],
                    ),
                    const SizedBox(height: 5),
                    Text(adaptation.guidance),
                    const SizedBox(height: 6),
                    Text(
                      '${adaptation.evidenceCount} evidence items · observed against definition v${adaptation.observedDefinitionVersion} · authority impact: ${adaptation.authorityImpact}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: 5),
                    SelectableText(
                      adaptation.adaptationId,
                      style: Theme.of(context).textTheme.labelSmall,
                    ),
                    SelectableText(
                      adaptation.effectSha256,
                      style: Theme.of(context).textTheme.labelSmall,
                    ),
                    if (canManage) ...[
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 7,
                        runSpacing: 7,
                        children: [
                          if (adaptation.state == 'observed' &&
                              adaptation.observedDefinitionVersion ==
                                  snapshot.definitionVersion)
                            OutlinedButton(
                              onPressed: busy == null
                                  ? () => onAction({
                                      'action': 'evaluate',
                                      'adaptationId': adaptation.adaptationId,
                                    })
                                  : null,
                              child: const Text('Evaluate'),
                            ),
                          if (adaptation.state == 'evaluated' &&
                              adaptation.observedDefinitionVersion ==
                                  snapshot.definitionVersion &&
                              adaptation.evaluationVerdict == 'passed')
                            FilledButton.tonal(
                              onPressed: busy == null
                                  ? () => onAction({
                                      'action': 'activate',
                                      'adaptationId': adaptation.adaptationId,
                                    })
                                  : null,
                              child: const Text('Activate guidance'),
                            ),
                          if (adaptation.state == 'active')
                            OutlinedButton(
                              onPressed: busy == null
                                  ? () => onAction({
                                      'action': 'rollback',
                                      'adaptationId': adaptation.adaptationId,
                                    })
                                  : null,
                              child: const Text('Roll back'),
                            ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ],
  );
}

class _GovernanceCard extends StatelessWidget {
  const _GovernanceCard({
    required this.title,
    required this.icon,
    required this.children,
    this.trailing,
  });

  final String title;
  final IconData icon;
  final List<Widget> children;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(13),
    decoration: BoxDecoration(
      border: Border.all(color: Theme.of(context).dividerColor),
      borderRadius: BorderRadius.circular(11),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(icon, size: 18),
            const SizedBox(width: 8),
            Expanded(
              child: Text(title, style: Theme.of(context).textTheme.titleSmall),
            ),
            ?trailing,
          ],
        ),
        const SizedBox(height: 11),
        ...children,
      ],
    ),
  );
}

class _ValueLine extends StatelessWidget {
  const _ValueLine({required this.label, required this.value});
  final String label, value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 5),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.labelSmall),
        SelectableText(value),
      ],
    ),
  );
}

class _StatusPill extends StatelessWidget {
  const _StatusPill(this.value);
  final String value;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.primaryContainer,
      borderRadius: BorderRadius.circular(99),
    ),
    child: Text(_label(value), style: Theme.of(context).textTheme.labelSmall),
  );
}

class _GovernanceNotice extends StatelessWidget {
  const _GovernanceNotice({
    required this.icon,
    required this.message,
    this.action,
  });
  final IconData icon;
  final String message;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(10),
    ),
    child: Row(
      children: [
        Icon(icon, size: 19),
        const SizedBox(width: 9),
        Expanded(child: Text(message)),
        ?action,
      ],
    ),
  );
}

String _label(String value) => value
    .replaceAll('_', ' ')
    .split(' ')
    .where((part) => part.isNotEmpty)
    .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
    .join(' ');

String _shortTime(String value) =>
    DateTime.tryParse(value)?.toLocal().toString() ?? 'unknown time';
