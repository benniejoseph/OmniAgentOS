import 'package:flutter/foundation.dart';

typedef AgentGovernanceJson = Map<String, dynamic>;

@immutable
class AgentGovernanceSnapshot {
  const AgentGovernanceSnapshot({
    required this.release,
    required this.definitionVersion,
    required this.adaptations,
  });

  final AgentReleaseProjection release;
  final int definitionVersion;
  final List<AgentAdaptationProjection> adaptations;
}

@immutable
class AgentReleaseProjection {
  const AgentReleaseProjection({
    required this.agentId,
    required this.state,
    required this.releaseRevision,
    required this.activeDefinitionVersion,
    required this.activeDefinitionVersionId,
    required this.latestDefinitionVersion,
    required this.latestDefinitionVersionId,
    required this.versions,
    required this.evaluations,
    required this.candidateEvaluation,
    required this.updatedAt,
  });

  final String agentId,
      state,
      activeDefinitionVersionId,
      latestDefinitionVersionId,
      updatedAt;
  final int releaseRevision, activeDefinitionVersion, latestDefinitionVersion;
  final List<AgentReleaseVersion> versions;
  final List<AgentReleaseEvaluation> evaluations;
  final AgentReleaseEvaluation? candidateEvaluation;

  factory AgentReleaseProjection.fromResponse(AgentGovernanceJson response) {
    final value = _record(response['release']);
    if (value.isEmpty) {
      throw const FormatException('The release service returned no channel.');
    }
    final agentId = _requiredText(value, 'agentId');
    final state = _requiredText(value, 'state');
    final activeVersion = _positiveInt(value, 'activeDefinitionVersion');
    final activeVersionId = _requiredText(value, 'activeDefinitionVersionId');
    final latestVersion = _positiveInt(value, 'latestDefinitionVersion');
    final latestVersionId = _requiredText(value, 'latestDefinitionVersionId');
    final versions = _records(value['versions'])
        .map(AgentReleaseVersion.fromJson)
        .toList(growable: false);
    final evaluations = _records(value['evaluations'])
        .map(AgentReleaseEvaluation.fromJson)
        .toList(growable: false);
    final candidate = value['candidateEvaluation'] == null
        ? null
        : AgentReleaseEvaluation.fromJson(
            _requiredRecord(value, 'candidateEvaluation'),
          );
    final versionNumbers = versions
        .map((version) => version.definitionVersion)
        .toList(growable: false);
    final versionIdsAreExact = versions.every(
      (version) =>
          version.definitionVersionId ==
          'definition:custom:$agentId:v${version.definitionVersion}',
    );
    final versionsAreOrdered =
        versions.isNotEmpty &&
        List<int>.generate(
          versions.length - 1,
          (index) => index,
        ).every((index) => versionNumbers[index] < versionNumbers[index + 1]);
    final activeVersions = versions
        .where((version) => version.active)
        .toList(growable: false);
    final evaluationIds = evaluations
        .map((evaluation) => evaluation.evaluationId)
        .toSet();
    if (!const {'active', 'retired'}.contains(state) ||
        activeVersionId != 'definition:custom:$agentId:v$activeVersion' ||
        latestVersionId != 'definition:custom:$agentId:v$latestVersion' ||
        latestVersion < activeVersion ||
        !versionIdsAreExact ||
        !versionsAreOrdered ||
        activeVersions.length != 1 ||
        activeVersions.single.definitionVersion != activeVersion ||
        versions.last.definitionVersion != latestVersion ||
        evaluationIds.length != evaluations.length ||
        evaluations.any(
          (evaluation) =>
              evaluation.definitionVersionId !=
                  'definition:custom:$agentId:v${evaluation.definitionVersion}' ||
              evaluation.baselineDefinitionVersion != activeVersion ||
              evaluation.baselineDefinitionVersionId != activeVersionId,
        ) ||
        (candidate != null &&
            !evaluations.any(
              (evaluation) =>
                  evaluation.evaluationId == candidate.evaluationId &&
                  evaluation.evaluationSha256 == candidate.evaluationSha256,
            ))) {
      throw const FormatException(
        'The release channel has inconsistent version-bound evidence.',
      );
    }
    return AgentReleaseProjection(
      agentId: agentId,
      state: state,
      releaseRevision: _positiveInt(value, 'releaseRevision'),
      activeDefinitionVersion: activeVersion,
      activeDefinitionVersionId: activeVersionId,
      latestDefinitionVersion: latestVersion,
      latestDefinitionVersionId: latestVersionId,
      versions: versions,
      evaluations: evaluations,
      candidateEvaluation: candidate,
      updatedAt: _timestamp(value, 'updatedAt'),
    );
  }
}

@immutable
class AgentReleaseVersion {
  const AgentReleaseVersion({
    required this.definitionVersion,
    required this.definitionVersionId,
    required this.publishedAt,
    required this.active,
  });

  final int definitionVersion;
  final String definitionVersionId, publishedAt;
  final bool active;

  factory AgentReleaseVersion.fromJson(AgentGovernanceJson value) {
    final active = value['active'];
    if (active is! bool) {
      throw const FormatException(
        'The Agent release version needs an exact active state.',
      );
    }
    return AgentReleaseVersion(
      definitionVersion: _positiveInt(value, 'definitionVersion'),
      definitionVersionId: _requiredText(value, 'definitionVersionId'),
      publishedAt: _timestamp(value, 'publishedAt'),
      active: active,
    );
  }
}

@immutable
class AgentReleaseEvaluation {
  const AgentReleaseEvaluation({
    required this.evaluationId,
    required this.definitionVersion,
    required this.definitionVersionId,
    required this.definitionSha256,
    required this.baselineDefinitionVersion,
    required this.baselineDefinitionVersionId,
    required this.baselineDefinitionSha256,
    required this.direction,
    required this.changedFields,
    required this.verdict,
    required this.evaluationSha256,
    required this.evaluatedAt,
  });

  final String evaluationId,
      definitionVersionId,
      definitionSha256,
      baselineDefinitionVersionId,
      baselineDefinitionSha256,
      direction,
      verdict,
      evaluationSha256,
      evaluatedAt;
  final int definitionVersion, baselineDefinitionVersion;
  final List<String> changedFields;

  factory AgentReleaseEvaluation.fromJson(AgentGovernanceJson value) {
    final definitionVersion = _positiveInt(value, 'definitionVersion');
    final baselineVersion = _positiveInt(value, 'baselineDefinitionVersion');
    final definitionVersionId = _requiredText(value, 'definitionVersionId');
    final baselineVersionId = _requiredText(
      value,
      'baselineDefinitionVersionId',
    );
    final direction = _requiredText(value, 'direction');
    final verdict = _requiredText(value, 'verdict');
    final evaluationId = _requiredText(value, 'evaluationId');
    final changedFields = _strings(value, 'changedFields');
    const allowedChangedFields = {
      'slug',
      'name',
      'role',
      'description',
      'instructions',
      'persona',
      'status',
      'accent',
      'model_policy',
      'skills',
    };
    final definitionPrefix = _versionPrefix(
      definitionVersionId,
      definitionVersion,
    );
    final baselinePrefix = _versionPrefix(baselineVersionId, baselineVersion);
    if (definitionVersion == baselineVersion ||
        definitionPrefix == null ||
        definitionPrefix != baselinePrefix ||
        !RegExp(r'^agent-release-evaluation:[a-f0-9]{64}$')
            .hasMatch(evaluationId) ||
        direction !=
            (definitionVersion > baselineVersion ? 'promotion' : 'rollback') ||
        changedFields.isEmpty ||
        changedFields.toSet().length != changedFields.length ||
        changedFields.any((field) => !allowedChangedFields.contains(field)) ||
        verdict != 'passed') {
      throw const FormatException(
        'The Agent release evaluation is not an exact valid transition.',
      );
    }
    return AgentReleaseEvaluation(
      evaluationId: evaluationId,
      definitionVersion: definitionVersion,
      definitionVersionId: definitionVersionId,
      definitionSha256: _sha256(value, 'definitionSha256'),
      baselineDefinitionVersion: baselineVersion,
      baselineDefinitionVersionId: baselineVersionId,
      baselineDefinitionSha256: _sha256(value, 'baselineDefinitionSha256'),
      direction: direction,
      changedFields: changedFields,
      verdict: verdict,
      evaluationSha256: _sha256(value, 'evaluationSha256'),
      evaluatedAt: _timestamp(value, 'evaluatedAt'),
    );
  }
}

@immutable
class AgentAdaptationProjection {
  const AgentAdaptationProjection({
    required this.adaptationId,
    required this.agentId,
    required this.state,
    required this.lifecycleRevision,
    required this.observedDefinitionVersion,
    required this.confidence,
    required this.guidance,
    required this.guidanceSha256,
    required this.effectSha256,
    required this.evidenceSha256,
    required this.evidenceCount,
    required this.authorityImpact,
    required this.evaluationVerdict,
    required this.evaluationSha256,
    required this.updatedAt,
  });

  final String adaptationId,
      agentId,
      state,
      guidance,
      guidanceSha256,
      effectSha256,
      evidenceSha256,
      authorityImpact,
      updatedAt;
  final String? evaluationVerdict, evaluationSha256;
  final int lifecycleRevision, observedDefinitionVersion, evidenceCount;
  final double confidence;

  factory AgentAdaptationProjection.fromJson(
    AgentGovernanceJson value, {
    required String expectedAgentId,
    required int expectedDefinitionVersion,
  }) {
    final effect = _requiredRecord(value, 'effect');
    final state = _requiredText(value, 'state');
    final lifecycleRevision = _nonNegativeInt(value, 'lifecycleRevision');
    final agentId = _requiredText(value, 'agentId');
    final observedDefinitionVersion = _positiveInt(
      value,
      'observedDefinitionVersion',
    );
    final authorityImpact = _requiredText(effect, 'authorityImpact');
    final rawEvaluation = value['evaluation'];
    final evaluation = rawEvaluation == null
        ? null
        : _requiredRecord(value, 'evaluation');
    final evaluationVerdict = evaluation == null
        ? null
        : _requiredText(evaluation, 'verdict');
    final evaluationSha256 = evaluation == null
        ? null
        : _sha256(evaluation, 'evaluationSha256');
    final evaluationDefinitionVersion = evaluation == null
        ? null
        : _positiveInt(evaluation, 'definitionVersion');
    final expectedRevision = const {
      'observed': 0,
      'evaluated': 1,
      'active': 2,
      'rolled_back': 3,
    }[state];
    final evaluationIsValid = switch (state) {
      'observed' => evaluation == null,
      'evaluated' =>
        evaluation != null &&
            const {'passed', 'held'}.contains(evaluationVerdict) &&
            evaluationDefinitionVersion == observedDefinitionVersion,
      'active' || 'rolled_back' =>
        evaluation != null &&
            evaluationVerdict == 'passed' &&
            evaluationDefinitionVersion == observedDefinitionVersion,
      _ => false,
    };
    if (!RegExp(r'^agent-adaptation:[a-f0-9]{64}$')
            .hasMatch(_requiredText(value, 'adaptationId')) ||
        agentId != expectedAgentId ||
        observedDefinitionVersion > expectedDefinitionVersion ||
        authorityImpact != 'none' ||
        expectedRevision == null ||
        lifecycleRevision != expectedRevision ||
        !evaluationIsValid) {
      throw const FormatException(
        'The Agent adaptation is not bound to the exact non-authority lifecycle.',
      );
    }
    return AgentAdaptationProjection(
      adaptationId: _requiredText(value, 'adaptationId'),
      agentId: agentId,
      state: state,
      lifecycleRevision: lifecycleRevision,
      observedDefinitionVersion: observedDefinitionVersion,
      confidence: _unitDouble(value, 'confidence'),
      guidance: _requiredText(effect, 'guidance'),
      guidanceSha256: _sha256(effect, 'guidanceSha256'),
      effectSha256: _sha256(effect, 'effectSha256'),
      evidenceSha256: _sha256(value, 'evidenceSha256'),
      evidenceCount: _records(value['evidence']).length,
      authorityImpact: authorityImpact,
      evaluationVerdict: evaluationVerdict,
      evaluationSha256: evaluationSha256,
      updatedAt: _timestamp(value, 'updatedAt'),
    );
  }

  static ({int definitionVersion, List<AgentAdaptationProjection> items})
  listFromResponse(
    AgentGovernanceJson response, {
    required String expectedAgentId,
  }) {
    final version = _positiveInt(response, 'definitionVersion');
    final items = _records(response['adaptations'])
        .map(
          (value) => AgentAdaptationProjection.fromJson(
            value,
            expectedAgentId: expectedAgentId,
            expectedDefinitionVersion: version,
          ),
        )
        .toList(growable: false);
    return (definitionVersion: version, items: items);
  }
}

abstract interface class AgentGovernanceRepository {
  Future<AgentGovernanceSnapshot> loadGovernance(String agentId);

  Future<AgentGovernanceSnapshot> manageRelease(
    String agentId,
    AgentGovernanceJson action, {
    required String idempotencyKey,
  });

  Future<AgentGovernanceSnapshot> manageAdaptation(
    String agentId,
    AgentGovernanceJson action, {
    required String idempotencyKey,
  });
}

List<AgentGovernanceJson> _records(Object? value) {
  if (value is! List || value.any((item) => item is! Map)) {
    throw const FormatException(
      'Agent governance evidence must be a list of records.',
    );
  }
  return value
      .cast<Map>()
      .map((item) => Map<String, dynamic>.from(item))
      .toList(growable: false);
}

AgentGovernanceJson _record(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};

AgentGovernanceJson _requiredRecord(AgentGovernanceJson source, String key) {
  final value = _record(source[key]);
  if (value.isEmpty) throw FormatException('$key must be an object.');
  return value;
}

String _requiredText(AgentGovernanceJson source, String key) {
  final value = source[key];
  if (value is! String || value.trim().isEmpty) {
    throw FormatException('$key must be a non-empty string.');
  }
  return value;
}

String _sha256(AgentGovernanceJson source, String key) {
  final value = _requiredText(source, key);
  if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(value)) {
    throw FormatException('$key must be a SHA-256 digest.');
  }
  return value;
}

String _timestamp(AgentGovernanceJson source, String key) {
  final value = _requiredText(source, key);
  if (DateTime.tryParse(value) == null) {
    throw FormatException('$key must be a timestamp.');
  }
  return value;
}

int _positiveInt(AgentGovernanceJson source, String key) {
  final value = source[key];
  if (value is! num || value.toInt() != value || value < 1) {
    throw FormatException('$key must be a positive integer.');
  }
  return value.toInt();
}

int _nonNegativeInt(AgentGovernanceJson source, String key) {
  final value = source[key];
  if (value is! num || value.toInt() != value || value < 0) {
    throw FormatException('$key must be a non-negative integer.');
  }
  return value.toInt();
}

double _unitDouble(AgentGovernanceJson source, String key) {
  final value = source[key];
  if (value is! num || !value.isFinite || value < 0 || value > 1) {
    throw FormatException('$key must be between zero and one.');
  }
  return value.toDouble();
}

List<String> _strings(AgentGovernanceJson source, String key) {
  final value = source[key];
  if (value is! List || value.any((item) => item is! String)) {
    throw FormatException('$key must be a list of strings.');
  }
  return value.cast<String>().toList(growable: false);
}

String? _versionPrefix(String id, int version) {
  final suffix = ':v$version';
  return id.endsWith(suffix)
      ? id.substring(0, id.length - suffix.length)
      : null;
}
