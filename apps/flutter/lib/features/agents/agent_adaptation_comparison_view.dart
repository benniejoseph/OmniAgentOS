import 'package:flutter/material.dart';

import 'agent_adaptation_comparison.dart';

class AgentAdaptationComparisonForm extends StatefulWidget {
  const AgentAdaptationComparisonForm({
    super.key,
    required this.busy,
    required this.onCompare,
    this.failed = false,
    this.comparisonId,
  });
  final bool busy, failed;
  final String? comparisonId;
  final ValueChanged<ComparisonJson> onCompare;
  @override
  State<AgentAdaptationComparisonForm> createState() => _ComparisonFormState();
}

class _ComparisonTaskFields {
  final task = TextEditingController(),
      requiredPhrases = TextEditingController(),
      forbiddenPhrases = TextEditingController(),
      min = TextEditingController(text: '1'),
      max = TextEditingController(text: '8000');
  void dispose() {
    for (final field in [task, requiredPhrases, forbiddenPhrases, min, max]) {
      field.dispose();
    }
  }

  ComparisonJson value(int index) => {
    'id': 'case-${index + 1}',
    'task': task.text,
    'assertions': {
      'allOf': requiredPhrases.text
          .split('\n')
          .map((s) => s.trim())
          .where((s) => s.isNotEmpty)
          .toList(),
      'noneOf': forbiddenPhrases.text
          .split('\n')
          .map((s) => s.trim())
          .where((s) => s.isNotEmpty)
          .toList(),
      'minLength': int.tryParse(min.text),
      'maxLength': int.tryParse(max.text),
    },
  };
}

class _ComparisonFormState extends State<AgentAdaptationComparisonForm> {
  final _cases = List.generate(3, (_) => _ComparisonTaskFields());
  String? _error;
  ComparisonJson? _submittedSuite;

  @override
  void didUpdateWidget(covariant AgentAdaptationComparisonForm oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.comparisonId != widget.comparisonId) {
      _submittedSuite = null;
    }
  }

  @override
  void dispose() {
    for (final task in _cases) {
      task.dispose();
    }
    super.dispose();
  }

  void _run() {
    try {
      final suite = parseAdaptationComparisonSuite({
        'cases': [for (var i = 0; i < _cases.length; i++) _cases[i].value(i)],
      });
      setState(() => _error = null);
      _submittedSuite = suite;
      widget.onCompare(suite);
    } on FormatException catch (error) {
      setState(() => _error = error.message);
    }
  }

  @override
  Widget build(BuildContext context) => ExpansionTile(
    title: const Text('Compare on my tasks'),
    subtitle: const Text(
      'Choose 3–10 tasks and define what a good answer must contain.',
    ),
    children: [
      Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Runs every task twice using the configured model: ${_cases.length * 2} paid model calls, up to two minutes. It compares text outputs with your literal checks; it does not test tools or real-world task completion.',
            ),
            for (var index = 0; index < _cases.length; index++)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'Task ${index + 1}',
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                    TextField(
                      key: ValueKey('comparison-task-$index'),
                      controller: _cases[index].task,
                      enabled: !widget.busy,
                      minLines: 2,
                      maxLines: 5,
                      maxLength: 2000,
                      decoration: const InputDecoration(
                        labelText: 'Task to try',
                        helperMaxLines: 3,
                        helperText: '10–2000 characters. Use a different real task for each case.',
                      ),
                    ),
                    TextField(
                      key: ValueKey('comparison-required-$index'),
                      controller: _cases[index].requiredPhrases,
                      enabled: !widget.busy,
                      minLines: 1,
                      maxLines: 5,
                      maxLength: 604,
                      decoration: const InputDecoration(
                        labelText: 'Required phrases',
                        helperMaxLines: 3,
                        helperText: 'Optional; one phrase per line, up to five, each at most 120 characters.',
                      ),
                    ),
                    TextField(
                      key: ValueKey('comparison-forbidden-$index'),
                      controller: _cases[index].forbiddenPhrases,
                      enabled: !widget.busy,
                      minLines: 1,
                      maxLines: 5,
                      maxLength: 604,
                      decoration: const InputDecoration(
                        labelText: 'Forbidden phrases',
                        helperMaxLines: 3,
                        helperText: 'Optional; the same phrase limits apply. Checks ignore letter case.',
                      ),
                    ),
                    Wrap(
                      spacing: 12,
                      runSpacing: 8,
                      children: [
                        SizedBox(
                          width: 150,
                          child: TextField(
                            controller: _cases[index].min,
                            enabled: !widget.busy,
                            keyboardType: TextInputType.number,
                            decoration: const InputDecoration(
                              labelText: 'Minimum length',
                            ),
                          ),
                        ),
                        SizedBox(
                          width: 150,
                          child: TextField(
                            controller: _cases[index].max,
                            enabled: !widget.busy,
                            keyboardType: TextInputType.number,
                            decoration: const InputDecoration(
                              labelText: 'Maximum length',
                            ),
                          ),
                        ),
                      ],
                    ),
                    if (_cases.length > 3)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton(
                          onPressed: widget.busy
                              ? null
                              : () => setState(() {
                                  _cases.removeAt(index).dispose();
                                }),
                          child: const Text('Remove task'),
                        ),
                      ),
                  ],
                ),
              ),
            if (_error != null)
              Semantics(
                liveRegion: true,
                child: Text(
                  _error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (_cases.length < 10)
                  OutlinedButton(
                    onPressed: widget.busy
                        ? null
                        : () => setState(
                            () => _cases.add(_ComparisonTaskFields()),
                          ),
                    child: const Text('Add task'),
                  ),
                FilledButton.tonal(
                  key: const Key('agent-run-comparison'),
                  onPressed: widget.busy
                      ? null
                      : widget.failed && _submittedSuite != null
                      ? () => widget.onCompare(_submittedSuite!)
                      : _run,
                  child: Text(
                    widget.busy
                        ? 'Working…'
                        : widget.failed && _submittedSuite != null
                        ? 'Check same comparison'
                        : 'Run paid text comparison',
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            const Text(
              'If the connection is lost, Check same comparison uses the original tasks and request key to recover its result. It never starts a duplicate comparison. Comparisons are never retried automatically.',
            ),
          ],
        ),
      ),
    ],
  );
}

class AgentAdaptationComparisonEvidence extends StatelessWidget {
  const AgentAdaptationComparisonEvidence({
    super.key,
    required this.comparison,
  });
  final AgentAdaptationComparison comparison;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text(switch (comparison.verdict) {
        'improved' => 'Improved on these tasks',
        'no_change' => 'No measured improvement',
        'regressed' => 'Regressed on at least one task',
        _ => 'Comparison incomplete',
      }, style: Theme.of(context).textTheme.titleSmall),
      Text(
        'Before: ${comparison.baselinePassed}/${comparison.results.length} passed · With guidance: ${comparison.candidatePassed}/${comparison.results.length} passed',
      ),
      Text(
        'Model: ${comparison.model} · Cost: ${comparison.costUsd == null ? 'unknown' : '\$${comparison.costUsd!.toStringAsFixed(6)}'}',
      ),
      Text(
        'Completed ${comparison.completedAt.toLocal()}. Activation requires improvement with no regressions, all calls completed, and evidence less than 24 hours old. The server rechecks the current configuration.',
      ),
      const Text(
        'These text-only tests do not verify tool use or real-world task completion.',
      ),
      for (var index = 0; index < comparison.results.length; index++)
        ExpansionTile(
          title: Text(
            'Task ${index + 1}: ${comparison.results[index].candidatePassed ? 'Pass' : 'Did not pass'}',
          ),
          children: [
            Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SelectableText(
                    comparison.results[index].task['task'] as String,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Required phrases: ${(comparison.results[index].task['assertions']['allOf'] as List).join(' · ').isEmpty ? 'none' : (comparison.results[index].task['assertions']['allOf'] as List).join(' · ')}',
                  ),
                  Text(
                    'Forbidden phrases: ${(comparison.results[index].task['assertions']['noneOf'] as List).join(' · ').isEmpty ? 'none' : (comparison.results[index].task['assertions']['noneOf'] as List).join(' · ')}',
                  ),
                  Text(
                    'Length: ${comparison.results[index].task['assertions']['minLength']}–${comparison.results[index].task['assertions']['maxLength']} characters. Literal checks ignore letter case.',
                  ),
                  const SizedBox(height: 10),
                  Text(
                    'Before · ${comparison.results[index].baselinePassed ? 'Pass' : 'Did not pass'}',
                  ),
                  SelectableText(
                    comparison.results[index].baseline.output ??
                        'No completed output (${comparison.results[index].baseline.failure ?? comparison.results[index].baseline.status}).',
                  ),
                  const SizedBox(height: 10),
                  Text(
                    'With guidance · ${comparison.results[index].candidatePassed ? 'Pass' : 'Did not pass'}',
                  ),
                  SelectableText(
                    comparison.results[index].candidate.output ??
                        'No completed output (${comparison.results[index].candidate.failure ?? comparison.results[index].candidate.status}).',
                  ),
                ],
              ),
            ),
          ],
        ),
      ExpansionTile(
        title: const Text('Comparison details'),
        children: [
          SelectableText(
            'Receipt: ${comparison.comparisonId}\nComparison: ${comparison.comparisonSha256}\nTask suite: ${comparison.suiteSha256}\nDefinition version: ${comparison.definitionVersion}',
          ),
        ],
      ),
    ],
  );
}
