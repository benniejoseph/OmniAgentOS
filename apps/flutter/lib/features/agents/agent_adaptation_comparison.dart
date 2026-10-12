import 'package:flutter/foundation.dart';

typedef ComparisonJson = Map<String, dynamic>;

Never _invalid(String message) => throw FormatException(message);
ComparisonJson _map(Object? value) =>
    value is Map && value.keys.every((key) => key is String)
    ? Map<String, dynamic>.from(value)
    : _invalid('Comparison evidence must be an object.');
void _keys(ComparisonJson value, String names) {
  final required = names.split(' ').toSet();
  if (value.length != required.length || !value.keys.every(required.contains)) {
    _invalid('Comparison evidence has missing or unsupported fields.');
  }
}

String _text(Object? value, int min, int max) =>
    value is String && value.length >= min && value.length <= max
    ? value
    : _invalid('Comparison text must contain $min–$max characters.');
int _int(Object? value, int min, int max) =>
    value is int && value >= min && value <= max
    ? value
    : _invalid('Comparison count is out of range.');
String _digest(Object? value) =>
    value is String && RegExp(r'^[a-f0-9]{64}$').hasMatch(value)
    ? value
    : _invalid('Comparison evidence needs an exact digest.');
String _choice(Object? value, String options) =>
    value is String && options.split(' ').contains(value)
    ? value
    : _invalid('Unsupported comparison evidence.');
double? _cost(Object? value) => value == null
    ? null
    : value is num && value.isFinite && value >= 0
    ? value.toDouble()
    : _invalid('Comparison cost is invalid.');
DateTime _time(Object? value) {
  final text = _text(value, 20, 40), result = DateTime.tryParse(text);
  if (result == null || !RegExp(r'(Z|[+-]\d{2}:\d{2})$').hasMatch(text)) {
    _invalid('Comparison timestamp is invalid.');
  }
  return result.toUtc();
}

List<String> _phrases(Object? value) {
  if (value is! List || value.length > 5) {
    _invalid('Use up to five phrases per assertion.');
  }
  return value
      .map((item) => _text(item is String ? item.trim() : item, 1, 120))
      .toList(growable: false);
}

/// Validates owner-authored literal checks before making a paid request.
ComparisonJson parseAdaptationComparisonSuite(Object? raw) {
  final suite = _map(raw);
  _keys(suite, 'cases');
  final rows = suite['cases'];
  if (rows is! List || rows.length < 3 || rows.length > 10) {
    _invalid('Provide 3–10 different tasks.');
  }
  final ids = <String>{}, tasks = <String>{};
  final cases = rows
      .map((raw) {
        final row = _map(raw);
        _keys(row, 'id task assertions');
        final id = _text(row['id'], 1, 40);
        final task = _text(
          row['task'] is String ? (row['task'] as String).trim() : row['task'],
          10,
          2000,
        );
        if (!RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(id) ||
            !ids.add(id) ||
            !tasks.add(task.toLowerCase().replaceAll(RegExp(r'\s+'), ' '))) {
          _invalid('Provide different tasks with unique IDs.');
        }
        final assertions = _map(row['assertions']);
        _keys(assertions, 'allOf noneOf minLength maxLength');
        final allOf = _phrases(assertions['allOf']),
            noneOf = _phrases(assertions['noneOf']);
        final min = _int(assertions['minLength'], 1, 8000),
            max = _int(assertions['maxLength'], 1, 8000);
        if (max < min ||
            allOf.any(
              (phrase) => noneOf.any(
                (excluded) =>
                    phrase.toLowerCase().contains(excluded.toLowerCase()),
              ),
            )) {
          _invalid(
            'The length bounds or required and forbidden phrases conflict.',
          );
        }
        return <String, dynamic>{
          'id': id,
          'task': task,
          'assertions': {
            'allOf': allOf,
            'noneOf': noneOf,
            'minLength': min,
            'maxLength': max,
          },
        };
      })
      .toList(growable: false);
  return {'cases': cases};
}

@immutable
class AgentComparisonObservation {
  const AgentComparisonObservation(
    this.status,
    this.output,
    this.costUsd,
    this.failure,
  );
  final String status;
  final String? output, failure;
  final double? costUsd;
  factory AgentComparisonObservation.fromJson(Object? raw) {
    final value = _map(raw);
    _keys(value, 'status output costUsd failure');
    final status = _choice(value['status'], 'completed failed not_run');
    final output = value['output'] == null
        ? null
        : _text(value['output'], 1, 8000);
    final failure = value['failure'] == null
        ? null
        : _choice(
            value['failure'],
            'model_failed route_changed empty_or_oversized_output cancelled stale_configuration',
          );
    if (status == 'completed'
        ? output == null || failure != null
        : output != null) {
      _invalid('Comparison output does not match its status.');
    }
    return AgentComparisonObservation(
      status,
      output,
      _cost(value['costUsd']),
      failure,
    );
  }
  bool passes(ComparisonJson task) {
    if (status != 'completed' || output == null) return false;
    final text = output!.toLowerCase(), count = output!.runes.length;
    final checks = _map(task['assertions']);
    return (checks['allOf'] as List<String>).every(
          (phrase) => text.contains(phrase.toLowerCase()),
        ) &&
        (checks['noneOf'] as List<String>).every(
          (phrase) => !text.contains(phrase.toLowerCase()),
        ) &&
        count >= checks['minLength'] &&
        count <= checks['maxLength'];
  }
}

@immutable
class AgentComparisonCaseResult {
  const AgentComparisonCaseResult({
    required this.task,
    required this.baseline,
    required this.candidate,
    required this.baselinePassed,
    required this.candidatePassed,
  });
  final ComparisonJson task;
  final AgentComparisonObservation baseline, candidate;
  final bool baselinePassed, candidatePassed;
}

/// Rechecks literal scores and identity bindings. The service revalidates the
/// exact current model, authority and active guidance before activation.
@immutable
class AgentAdaptationComparison {
  const AgentAdaptationComparison({
    required this.comparisonId,
    required this.comparisonSha256,
    required this.suiteSha256,
    required this.definitionVersion,
    required this.verdict,
    required this.baselinePassed,
    required this.candidatePassed,
    required this.startedAt,
    required this.completedAt,
    required this.costUsd,
    required this.model,
    required this.results,
    required this.suite,
  });
  final String comparisonId, comparisonSha256, suiteSha256, verdict, model;
  final int definitionVersion, baselinePassed, candidatePassed;
  final DateTime startedAt, completedAt;
  final double? costUsd;
  final List<AgentComparisonCaseResult> results;
  final ComparisonJson suite;
  bool isFreshAt(DateTime now) =>
      !now.isBefore(completedAt) &&
      now.difference(completedAt) <= const Duration(hours: 24);

  factory AgentAdaptationComparison.fromJson(
    Object? raw, {
    required String adaptationId,
    required int observedDefinitionVersion,
    required String effectSha256,
  }) {
    final value = _map(raw);
    _keys(
      value,
      'version scorerVersion comparisonId adaptationId suite suiteSha256 pins results verdict baselinePassed candidatePassed costUsd completedAt comparisonSha256',
    );
    if (value['version'] != 'agent-text-comparison:1' ||
        value['scorerVersion'] != 'literal-output-assertions:1' ||
        value['adaptationId'] != adaptationId) {
      _invalid('Comparison belongs to a different adaptation or scorer.');
    }
    final id = _text(value['comparisonId'], 36, 36);
    if (!RegExp(
      r'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',
    ).hasMatch(id)) {
      _invalid('Comparison ID is invalid.');
    }
    final suite = parseAdaptationComparisonSuite(value['suite']);
    final cases = (suite['cases'] as List).cast<ComparisonJson>();
    final pins = _map(value['pins']);
    _keys(
      pins,
      'definitionVersion definitionSha256 principalSha256 baselineGuidanceSha256 candidateEffectSha256 promptContractVersion baselineInstructionsSha256 candidateInstructionsSha256 runtime clock mode environment maxOutputTokens maxCalls timeoutMs',
    );
    final definitionVersion = _int(
      pins['definitionVersion'],
      1,
      9007199254740991,
    );
    if (definitionVersion != observedDefinitionVersion ||
        pins['candidateEffectSha256'] != effectSha256 ||
        pins['mode'] != 'orchestrate' ||
        pins['environment'] != 'text_only_no_tools_memory_or_retrieval' ||
        pins['maxOutputTokens'] != 1000 ||
        pins['timeoutMs'] != 120000 ||
        pins['maxCalls'] != cases.length * 2) {
      _invalid(
        'Comparison pins do not match this guidance or bounded experiment.',
      );
    }
    for (final key in [
      'definitionSha256',
      'principalSha256',
      'baselineGuidanceSha256',
      'candidateEffectSha256',
      'baselineInstructionsSha256',
      'candidateInstructionsSha256',
    ]) {
      _digest(pins[key]);
    }
    _text(pins['promptContractVersion'], 1, 100);
    final clock = _time(pins['clock']), completed = _time(value['completedAt']);
    if (completed.isBefore(clock)) {
      _invalid('Comparison finished before it started.');
    }
    final runtime = _map(pins['runtime']);
    _keys(
      runtime,
      'provider model tier source assignmentId assignmentRevision assignmentConfigurationSha256',
    );
    _choice(runtime['provider'], 'openai google anthropic aws_bedrock');
    _choice(runtime['tier'], 'fast reasoning');
    _choice(runtime['source'], 'tenant_assignment deployment_environment');
    if (runtime['assignmentId'] != null) {
      _text(runtime['assignmentId'], 0, 1000);
    }
    if (runtime['assignmentRevision'] != null) {
      _int(runtime['assignmentRevision'], 1, 9007199254740991);
    }
    if (runtime['assignmentConfigurationSha256'] != null) {
      _digest(runtime['assignmentConfigurationSha256']);
    }
    final rows = value['results'];
    if (rows is! List || rows.length != cases.length) {
      _invalid('Comparison results do not cover the supplied tasks.');
    }
    final results = <AgentComparisonCaseResult>[];
    for (var index = 0; index < rows.length; index++) {
      final row = _map(rows[index]);
      _keys(row, 'caseId baseline candidate baselinePassed candidatePassed');
      final baseline = AgentComparisonObservation.fromJson(row['baseline']),
          candidate = AgentComparisonObservation.fromJson(row['candidate']);
      final baselinePassed = baseline.passes(cases[index]),
          candidatePassed = candidate.passes(cases[index]);
      if (row['caseId'] != cases[index]['id'] ||
          row['baselinePassed'] != baselinePassed ||
          row['candidatePassed'] != candidatePassed) {
        _invalid(
          'Comparison assertions or task identity do not match the outputs.',
        );
      }
      results.add(
        AgentComparisonCaseResult(
          task: cases[index],
          baseline: baseline,
          candidate: candidate,
          baselinePassed: baselinePassed,
          candidatePassed: candidatePassed,
        ),
      );
    }
    final observations = results
        .expand((row) => [row.baseline, row.candidate])
        .toList();
    final incomplete = observations.any((row) => row.status != 'completed');
    final verdict = incomplete
        ? 'incomplete'
        : results.any((row) => row.baselinePassed && !row.candidatePassed)
        ? 'regressed'
        : results.any((row) => !row.baselinePassed && row.candidatePassed)
        ? 'improved'
        : 'no_change';
    final before = results.where((row) => row.baselinePassed).length,
        after = results.where((row) => row.candidatePassed).length;
    final cost = _cost(value['costUsd']);
    final expectedCost =
        incomplete || observations.any((row) => row.costUsd == null)
        ? null
        : observations.fold<double>(0, (total, row) => total + row.costUsd!);
    if (value['verdict'] != verdict ||
        value['baselinePassed'] != before ||
        value['candidatePassed'] != after ||
        (cost == null) != (expectedCost == null) ||
        cost != null && (cost - expectedCost!).abs() > 1e-12) {
      _invalid('Comparison totals do not match its evidence.');
    }
    return AgentAdaptationComparison(
      comparisonId: id,
      comparisonSha256: _digest(value['comparisonSha256']),
      suiteSha256: _digest(value['suiteSha256']),
      definitionVersion: definitionVersion,
      verdict: verdict,
      baselinePassed: before,
      candidatePassed: after,
      startedAt: clock,
      completedAt: completed,
      costUsd: cost,
      model: _text(runtime['model'], 1, 240),
      results: List.unmodifiable(results),
      suite: suite,
    );
  }
}
