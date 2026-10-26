import '../agents/specialist_contracts.dart';

typedef ImprovementJson = Map<String, dynamic>;

void improvementRequire(
  bool value, [
  String message = 'The improvement response is incomplete or changed. Refresh before continuing.',
]) {
  if (!value) throw FormatException(message);
}

ImprovementJson improvementObject(Object? value) {
  improvementRequire(value is Map && value.keys.every((key) => key is String));
  return Map<String, dynamic>.from(value as Map);
}

List<ImprovementJson> improvementObjects(Object? value, [int maximum = 100]) {
  improvementRequire(value is List && value.length <= maximum);
  return (value as List).map(improvementObject).toList(growable: false);
}

String improvementText(Object? value, [int maximum = 240, bool empty = false]) {
  improvementRequire(
    value is String && (empty || value.isNotEmpty) && value.length <= maximum,
  );
  return value as String;
}

String improvementDigest(Object? value, [int size = 64]) {
  final text = improvementText(value, size);
  improvementRequire(RegExp('^[a-f0-9]{$size}\$').hasMatch(text));
  return text;
}

int improvementInt(Object? value, {int minimum = 0, int maximum = 1000000}) {
  improvementRequire(value is int && value >= minimum && value <= maximum);
  return value as int;
}

double improvementNumber(Object? value, {double maximum = 1000000}) {
  improvementRequire(
    value is num && value.isFinite && value >= 0 && value <= maximum,
  );
  return (value as num).toDouble();
}

bool improvementBool(Object? value) {
  improvementRequire(value is bool);
  return value as bool;
}

String improvementTime(Object? value) {
  final text = improvementText(value, 80);
  improvementRequire(
    RegExp(r'(Z|[+-]\d\d:\d\d)$').hasMatch(text) &&
        DateTime.tryParse(text) != null,
  );
  return text;
}

String improvementChoice(Object? value, Set<String> choices) {
  final text = improvementText(value);
  improvementRequire(choices.contains(text));
  return text;
}

String? improvementPullRequest(Object? value) {
  if (value == null) return null;
  final text = improvementText(value, 500);
  improvementRequire(
    RegExp(
      r'^https://github\.com/benniejoseph/omniagentos/pull/[1-9][0-9]*$',
      caseSensitive: false,
    ).hasMatch(text),
  );
  return text;
}

class SelfImprovementPolicy {
  SelfImprovementPolicy.fromJson(ImprovementJson value)
    : data = specialistFreeze(value) {
    improvementRequire(
      value['version'] == 1 &&
          value['maxActiveCycles'] == 1 &&
          value['maxCandidatesPerCycle'] == 1 &&
          value['maxCorrections'] == 1 &&
          value['protectedPathsVersion'] == 1,
    );
    dailyBudgetUsd = improvementNumber(value['dailyBudgetUsd'], maximum: 100);
    maxCycleBudgetUsd = improvementNumber(
      value['maxCycleBudgetUsd'] ?? value['dailyBudgetUsd'],
      maximum: 100,
    );
    improvementRequire(
      dailyBudgetUsd > 0 &&
          maxCycleBudgetUsd > 0 &&
          maxCycleBudgetUsd <= dailyBudgetUsd,
    );
    autoReleaseRoutineChanges = improvementBool(
      value['autoReleaseRoutineChanges'],
    );
    notifyOutcomes = improvementBool(value['notifyOutcomes']);
    policySha256 = improvementDigest(value['policySha256']);
    improvementInt(
      value['maxCycleDurationMs'],
      minimum: 60000,
      maximum: 86400000,
    );
    improvementInt(value['maxChangedFiles'], minimum: 1, maximum: 100);
    improvementInt(value['maxChangedLines'], minimum: 1, maximum: 10000);
  }
  final ImprovementJson data;
  late final double dailyBudgetUsd, maxCycleBudgetUsd;
  late final bool autoReleaseRoutineChanges, notifyOutcomes;
  late final String policySha256;
}

class SelfImprovementRepository {
  SelfImprovementRepository.fromJson(ImprovementJson value) {
    owner = improvementText(value['owner'], 39);
    name = improvementText(value['name'], 100);
    defaultBranch = improvementText(value['defaultBranch'], 200);
    improvementRequire(
      owner.toLowerCase() == 'benniejoseph' &&
          name.toLowerCase() == 'omniagentos' &&
          defaultBranch == 'main',
    );
  }
  late final String owner, name, defaultBranch;
  String get fullName => '$owner/$name';
}

class SelfImprovementConfiguration {
  SelfImprovementConfiguration.fromJson(ImprovementJson value)
    : data = specialistFreeze(value) {
    id = improvementText(value['id']);
    tenantId = improvementText(value['tenantId']);
    ownerActorId = improvementText(value['ownerActorId']);
    projectId = improvementText(value['projectId']);
    repositoryId = improvementText(value['repositoryId'], 24);
    improvementRequire(RegExp(r'^\d{1,24}$').hasMatch(repositoryId));
    repository = SelfImprovementRepository.fromJson(
      improvementObject(value['repository']),
    );
    policy = SelfImprovementPolicy.fromJson(improvementObject(value['policy']));
    generation = improvementInt(value['generation'], minimum: 1);
    dailyHour = improvementInt(value['dailyHour'], maximum: 23);
    timeZone = improvementText(value['timeZone'], 100);
    nextDueAt = improvementTime(value['nextDueAt']);
    paused = improvementBool(value['paused']);
    createdAt = improvementTime(value['createdAt']);
    updatedAt = improvementTime(value['updatedAt']);
  }
  final ImprovementJson data;
  late final String id,
      tenantId,
      ownerActorId,
      projectId,
      repositoryId,
      timeZone,
      nextDueAt,
      createdAt,
      updatedAt;
  late final int generation, dailyHour;
  late final bool paused;
  late final SelfImprovementPolicy policy;
  late final SelfImprovementRepository repository;
}

class SelfImprovementChangedFile {
  SelfImprovementChangedFile.fromJson(ImprovementJson value) {
    path = improvementText(value['path'], 500);
    improvementRequire(
      !path.startsWith('/') &&
          !path.contains('\\') &&
          !RegExp(r'[\x00-\x1f\x7f]').hasMatch(path) &&
          path.split('/').every((p) => p.isNotEmpty && p != '.' && p != '..'),
    );
    beforeSha256 = value['beforeSha256'] == null
        ? null
        : improvementDigest(value['beforeSha256']);
    afterSha256 = value['afterSha256'] == null
        ? null
        : improvementDigest(value['afterSha256']);
    improvementRequire(beforeSha256 != afterSha256);
  }
  late final String path;
  late final String? beforeSha256, afterSha256;
}

class SelfImprovementCandidate {
  SelfImprovementCandidate.fromJson(ImprovementJson value)
    : data = specialistFreeze(value) {
    revision = improvementDigest(value['revision'], 40);
    candidateSha256 = improvementDigest(value['candidateSha256']);
    workspaceSha256 = improvementDigest(value['workspaceSha256']);
    diffSha256 = improvementDigest(value['diffSha256']);
    releaseTarget = value['releaseTarget'] == null
        ? 'paired_server'
        : improvementChoice(value['releaseTarget'], {'macos_app'});
    architectureImpact = improvementChoice(value['architectureImpact'], {
      'none',
      'minor',
      'major',
    });
    changedLines = improvementInt(
      value['changedLines'],
      minimum: 1,
      maximum: 100000,
    );
    changedFiles = List.unmodifiable(
      improvementObjects(
        value['changedFiles'],
        500,
      ).map(SelfImprovementChangedFile.fromJson),
    );
    final paths = changedFiles.map((f) => f.path).toList();
    final sorted = [...paths]..sort();
    improvementRequire(
      paths.isNotEmpty &&
          paths.toSet().length == paths.length &&
          paths.join('\n') == sorted.join('\n'),
    );
  }
  final ImprovementJson data;
  late final String revision,
      candidateSha256,
      workspaceSha256,
      diffSha256,
      architectureImpact,
      releaseTarget;
  bool get isMacUpdate => releaseTarget == 'macos_app';
  late final int changedLines;
  late final List<SelfImprovementChangedFile> changedFiles;
}

class SelfImprovementCheck {
  SelfImprovementCheck.fromJson(ImprovementJson value)
    : data = specialistFreeze(value) {
    id = improvementText(value['id']);
    kind = improvementChoice(value['kind'], {
      'focused_regression',
      'adjacent_regression',
      'typecheck',
      'independent_review',
      'behavior_comparison',
      'build',
      'lint',
    });
    outcome = improvementChoice(value['outcome'], {
      'passed',
      'failed',
      'incomplete',
      'not_run',
    });
    producerKind = improvementChoice(value['producerKind'], {
      'command',
      'agent_review',
      'behavior_comparison',
    });
    producerId = improvementText(value['producerId']);
    candidateRevision = improvementDigest(value['candidateRevision'], 40);
    workspaceSha256 = improvementDigest(value['workspaceSha256']);
    evidenceSha256 = improvementDigest(value['evidenceSha256']);
    completedAt = improvementTime(value['completedAt']);
    declaredCases = improvementInt(
      value['declaredCases'],
      minimum: 1,
      maximum: 100000,
    );
    executedCases = improvementInt(value['executedCases'], maximum: 100000);
    failedCases = improvementInt(value['failedCases'], maximum: 100000);
    improvementRequire(
      failedCases <= executedCases &&
          executedCases <= declaredCases &&
          (outcome != 'passed' ||
              executedCases == declaredCases && failedCases == 0) &&
          (outcome != 'failed' || failedCases > 0) &&
          (outcome != 'not_run' || executedCases == 0),
    );
    improvementRequire(
      producerKind ==
          (kind == 'independent_review'
              ? 'agent_review'
              : kind == 'behavior_comparison'
              ? 'behavior_comparison'
              : 'command'),
    );
  }
  final ImprovementJson data;
  late final String id,
      kind,
      outcome,
      producerKind,
      producerId,
      candidateRevision,
      workspaceSha256,
      evidenceSha256,
      completedAt;
  late final int declaredCases, executedCases, failedCases;
}

class SelfImprovementNativeValidation {
  SelfImprovementNativeValidation.fromJson(ImprovementJson value)
    : data = specialistFreeze(value) {
    requestId = improvementText(value['requestId']);
    improvementRequire(
      RegExp(r'^self_native_[a-f0-9]{64}$').hasMatch(requestId),
    );
    for (final key in ['requestSha256', 'snapshotSha256', 'receiptSha256']) {
      improvementDigest(value[key]);
    }
    artifact = specialistFreeze(improvementObject(value['artifact']));
    installedBaseline = specialistFreeze(
      improvementObject(value['installedBaseline']),
    );
    pairedBaseline = specialistFreeze(
      improvementObject(value['pairedBaseline']),
    );
    for (final key in [
      'artifactSha256',
      'unsignedBundleSha256',
      'sourceManifestSha256',
      'toolchainSha256',
      'builderProfileSha256',
    ]) {
      improvementDigest(artifact[key]);
    }
    for (final key in [
      'baselineSha256',
      'bundleSha256',
      'signingIdentitySha256',
      'designatedRequirementSha256',
    ]) {
      improvementDigest(installedBaseline[key]);
    }
    improvementText(artifact['artifactId']);
    improvementDigest(installedBaseline['sourceRevision'], 40);
    improvementDigest(pairedBaseline['webRevision'], 40);
    improvementDigest(pairedBaseline['workerRevision'], 40);
    improvementDigest(pairedBaseline['manifestSha256']);
    version = improvementText(artifact['version'], 40);
    final build = improvementText(artifact['buildNumber'], 9);
    final previousBuild = improvementText(installedBaseline['buildNumber'], 9);
    improvementRequire(
      RegExp(r'^\d+\.\d+\.\d+$').hasMatch(version) &&
          RegExp(r'^[1-9]\d{0,8}$').hasMatch(build) &&
          RegExp(r'^[1-9]\d{0,8}$').hasMatch(previousBuild),
    );
    buildNumber = int.parse(build);
    previousBuildNumber = int.parse(previousBuild);
    improvementRequire(
      buildNumber == previousBuildNumber + 1 &&
          version == installedBaseline['version'] &&
          artifact['bundleIdentifier'] == 'app.omniagent.omniagent' &&
          installedBaseline['bundleIdentifier'] == 'app.omniagent.omniagent' &&
          artifact['architecture'] == 'arm64' &&
          pairedBaseline['webRevision'] == pairedBaseline['workerRevision'],
    );
  }
  final ImprovementJson data;
  late final ImprovementJson artifact, installedBaseline, pairedBaseline;
  late final String requestId, version;
  late final int buildNumber, previousBuildNumber;
  String get artifactSha256 => artifact['artifactSha256'] as String;
  String get baselineSha256 => installedBaseline['baselineSha256'] as String;
}

class SelfImprovementValidation {
  SelfImprovementValidation.fromJson(ImprovementJson value)
    : data = specialistFreeze(value) {
    validationSha256 = improvementDigest(value['validationSha256']);
    candidateSha256 = improvementDigest(value['candidateSha256']);
    candidateRevision = improvementDigest(value['candidateRevision'], 40);
    workspaceSha256 = improvementDigest(value['workspaceSha256']);
    policySha256 = improvementDigest(value['policySha256']);
    improvementDigest(value['signalSha256']);
    native = value['native'] == null
        ? null
        : SelfImprovementNativeValidation.fromJson(
            improvementObject(value['native']),
          );
    if (native != null) {
      improvementRequire(
        native!.artifact['sourceManifestSha256'] == workspaceSha256,
      );
    }
    scope = specialistFreeze(improvementObject(value['scope']));
    checks = List.unmodifiable(
      improvementObjects(
        value['checks'],
        30,
      ).map(SelfImprovementCheck.fromJson),
    );
    improvementRequire(
      checks.isNotEmpty &&
          checks.map((c) => c.id).toSet().length == checks.length &&
          checks.every(
            (c) =>
                c.candidateRevision == candidateRevision &&
                c.workspaceSha256 == workspaceSha256,
          ),
    );
    baselineReproduction = value['baselineReproduction'] == null
        ? null
        : specialistFreeze(improvementObject(value['baselineReproduction']));
    if (baselineReproduction case final baseline?) {
      improvementDigest(baseline['revision'], 40);
      improvementText(baseline['producerId']);
      improvementDigest(baseline['evidenceSha256']);
      improvementTime(baseline['completedAt']);
      improvementRequire(
        improvementInt(baseline['failedCases'], minimum: 1) <=
            improvementInt(baseline['executedCases'], minimum: 1),
      );
    }
  }
  final ImprovementJson data;
  late final ImprovementJson scope;
  late final ImprovementJson? baselineReproduction;
  late final String validationSha256,
      candidateSha256,
      candidateRevision,
      workspaceSha256,
      policySha256;
  late final List<SelfImprovementCheck> checks;
  late final SelfImprovementNativeValidation? native;
}

class SelfImprovementAgentRun {
  SelfImprovementAgentRun.fromJson(ImprovementJson value) {
    agentId = improvementChoice(value['agentId'], {
      'atlas',
      'forge',
      'sentinel',
    });
    phase = improvementText(value['phase']);
    runId = improvementText(value['runId']);
    improvementRequire(RegExp(r'^[a-f0-9-]{36}$').hasMatch(runId));
    costCeilingUsd = improvementNumber(value['costCeilingUsd'], maximum: 100);
    completed = improvementBool(value['completed']);
  }
  late final String agentId, phase, runId;
  late final double costCeilingUsd;
  late final bool completed;
}

class SelfImprovementReleaseReceipt {
  SelfImprovementReleaseReceipt.fromJson(ImprovementJson value)
    : data = specialistFreeze(value) {
    outcome = improvementChoice(value['outcome'], {
      'deployed',
      'failed',
      'rolled_back',
    });
    recordedAt = improvementTime(value['recordedAt']);
    webRevision = improvementDigest(value['webRevision'], 40);
    workerRevision = improvementDigest(value['workerRevision'], 40);
    for (final key in [
      'releaseBindingSha256',
      'manifestSha256',
      'healthEvidenceSha256',
      'behaviorEvidenceSha256',
      'evidenceSha256',
    ]) {
      improvementDigest(value[key]);
    }
    if (value['serverHealthEvidenceSha256'] != null) {
      improvementDigest(value['serverHealthEvidenceSha256']);
    }
    nativeInstall = value['nativeInstall'] == null
        ? null
        : specialistFreeze(improvementObject(value['nativeInstall']));
    if (nativeInstall case final installed?) {
      for (final key in [
        'artifactSha256',
        'baselineSha256',
        'unsignedBundleSha256',
        'installedBundleSha256',
        'signingIdentitySha256',
        'designatedRequirementSha256',
        'codeSignatureSha256',
        'startupEvidenceSha256',
        'installationReceiptSha256',
      ]) {
        improvementDigest(installed[key]);
      }
      improvementRequire(
        RegExp(r'^\d+\.\d+\.\d+$')
                .hasMatch(improvementText(installed['version'], 40)) &&
            RegExp(r'^[1-9]\d{0,8}$')
                .hasMatch(improvementText(installed['buildNumber'], 9)),
      );
    }
  }
  final ImprovementJson data;
  late final String outcome, recordedAt, webRevision, workerRevision;
  late final ImprovementJson? nativeInstall;
}

class SelfImprovementCycle {
  SelfImprovementCycle.fromJson(ImprovementJson value)
    : data = specialistFreeze(value) {
    id = improvementText(value['id']);
    configurationId = improvementText(value['configurationId']);
    projectId = improvementText(value['projectId']);
    revision = improvementInt(value['revision'], minimum: 1);
    scope = specialistFreeze(improvementObject(value['scope']));
    tenantId = improvementText(scope['tenantId']);
    ownerActorId = improvementText(scope['ownerActorId']);
    baseRevision = improvementDigest(scope['baseRevision'], 40);
    repository = SelfImprovementRepository.fromJson(
      improvementObject(scope['repository']),
    );
    policy = SelfImprovementPolicy.fromJson(improvementObject(value['policy']));
    stage = improvementChoice(value['stage'], {
      'observing',
      'no_change',
      'planned',
      'implementing',
      'validating',
      'correcting',
      'review_required',
      'ready_for_release',
      'releasing',
      'succeeded',
      'failed',
      'rolled_back',
      'cancelled',
    });
    phase = improvementChoice(value['phase'], {
      'setup',
      'inspect',
      'reproduce',
      'baseline_check',
      'implement',
      'verify',
      'review',
      'deliver',
      'release_wait',
      'done',
      'unknown',
    });
    summary = improvementText(value['summary'], 2000, true);
    usageState = improvementChoice(value['usageState'], {'known', 'unknown'});
    spendUsd = improvementNumber(value['spendUsd']);
    dailyReservationUsd = improvementNumber(
      value['dailyReservationUsd'],
      maximum: 100,
    );
    correctionsUsed = improvementInt(value['correctionsUsed'], maximum: 1);
    createdAt = improvementTime(value['createdAt']);
    updatedAt = improvementTime(value['updatedAt']);
    executionLeaseExpiresAt = improvementTime(value['executionLeaseExpiresAt']);
    candidate = value['candidate'] == null
        ? null
        : SelfImprovementCandidate.fromJson(
            improvementObject(value['candidate']),
          );
    validation = value['validation'] == null
        ? null
        : SelfImprovementValidation.fromJson(
            improvementObject(value['validation']),
          );
    signal = value['signal'] == null
        ? null
        : specialistFreeze(improvementObject(value['signal']));
    approval = value['approval'] == null
        ? null
        : specialistFreeze(improvementObject(value['approval']));
    release = value['release'] == null
        ? null
        : specialistFreeze(improvementObject(value['release']));
    releaseReceipt = value['releaseReceipt'] == null
        ? null
        : SelfImprovementReleaseReceipt.fromJson(
            improvementObject(value['releaseReceipt']),
          );
    controllerHold = value['controllerHold'] == null
        ? null
        : specialistFreeze(improvementObject(value['controllerHold']));
    nativeCheck = value['nativeCheck'] == null
        ? null
        : specialistFreeze(improvementObject(value['nativeCheck']));
    if (nativeCheck case final check?) {
      improvementRequire(
        RegExp(r'^self_native_[a-f0-9]{64}$')
            .hasMatch(improvementText(check['requestId'])),
      );
      improvementDigest(check['requestSha256']);
      improvementChoice(check['purpose'], {'baseline', 'candidate'});
      improvementChoice(check['status'], {
        'queued',
        'claimed',
        'completed',
        'held',
      });
      if (check['holdCategory'] != null) {
        improvementText(check['holdCategory'], 120);
      }
      improvementRequire(
        !improvementBool(check['canStop']) ||
            check['status'] == 'held' &&
                {'planned', 'validating'}.contains(stage) &&
                usageState == 'known',
      );
    }
    classification = value['classification'] == null
        ? null
        : specialistFreeze(improvementObject(value['classification']));
    approvalExpired = improvementBool(value['approvalExpired']);
    approvalRenewalAvailable = improvementBool(
      value['approvalRenewalAvailable'],
    );
    discardAvailable = improvementBool(value['discardAvailable']);
    setupRetryAvailable = value['setupRetryAvailable'] == null
        ? false
        : improvementBool(value['setupRetryAvailable']);
    releaseEligibility = improvementChoice(value['releaseEligibility'], {
      'manual_release',
      'owner_review',
      'automatic',
    });
    pullRequestUrl = improvementPullRequest(value['pullRequestUrl']);
    agentRuns = List.unmodifiable(
      improvementObjects(
        value['agentRuns'],
        6,
      ).map(SelfImprovementAgentRun.fromJson),
    );
    if (validation case final v?) {
      improvementRequire(
        candidate != null &&
            candidate!.isMacUpdate == (v.native != null) &&
            v.candidateSha256 == candidate!.candidateSha256 &&
            v.candidateRevision == candidate!.revision &&
            v.workspaceSha256 == candidate!.workspaceSha256 &&
            v.policySha256 == policy.policySha256 &&
            specialistCanonical(v.scope) == specialistCanonical(scope),
      );
    }
    if (approval case final a?) {
      improvementRequire(
        a['tenantId'] == tenantId &&
            a['ownerActorId'] == ownerActorId &&
            a['candidateSha256'] == candidate?.candidateSha256 &&
            a['validationSha256'] == validation?.validationSha256 &&
            a['policySha256'] == policy.policySha256 &&
            a['decision'] == 'approved',
      );
      improvementDigest(a['receiptSha256']);
      improvementTime(a['approvedAt']);
      improvementTime(a['expiresAt']);
      if (validation?.native case final native?) {
        improvementRequire(
          a['nativeArtifactSha256'] == native.artifactSha256 &&
              a['nativeBaselineSha256'] == native.baselineSha256,
        );
      } else {
        improvementRequire(
          a['nativeArtifactSha256'] == null &&
              a['nativeBaselineSha256'] == null,
        );
      }
    }
    if (release case final r?) {
      if (r['pairedBaseline'] != null) {
        final pair = improvementObject(r['pairedBaseline']);
        improvementDigest(pair['webRevision'], 40);
        improvementDigest(pair['workerRevision'], 40);
        improvementDigest(pair['manifestSha256']);
        improvementRequire(pair['webRevision'] == pair['workerRevision']);
        if (validation?.native case final native?) {
          improvementRequire(
            specialistCanonical(pair) ==
                specialistCanonical(native.pairedBaseline),
          );
        }
      }
      improvementRequire(
        r['candidateSha256'] == candidate?.candidateSha256 &&
            r['validationSha256'] == validation?.validationSha256 &&
            r['policySha256'] == policy.policySha256 &&
            r['sourceCandidateRevision'] == candidate?.revision &&
            r['previousRevision'] == baseRevision &&
            specialistCanonical(r['scope']) == specialistCanonical(scope) &&
            r['runner'] ==
                (candidate?.isMacUpdate == true
                    ? 'asael_macos_publisher'
                    : 'asael_paired_production') &&
            r['sourceTree'] == r['mergedTree'],
      );
      if (validation?.native case final native?) {
        final binding = improvementObject(r['native']);
        final validationBinding = Map<String, dynamic>.from(binding)
          ..remove('approvalSha256');
        improvementRequire(
          r['releaseTarget'] == 'macos_app' &&
              binding['approvalSha256'] == approval?['receiptSha256'] &&
              specialistCanonical(validationBinding) ==
                  specialistCanonical(native.data),
        );
      } else {
        improvementRequire(r['native'] == null && r['releaseTarget'] == null);
      }
      for (final key in [
        'previousRevision',
        'sourceCandidateRevision',
        'candidateRevision',
        'sourceTree',
        'mergedTree',
      ]) {
        improvementDigest(r[key], 40);
      }
      improvementDigest(r['releaseBindingSha256']);
      improvementDigest(r['mergeEvidenceSha256']);
      improvementRequire(
        improvementPullRequest(r['pullRequestUrl']) == pullRequestUrl,
      );
    }
    if (releaseReceipt case final receipt?) {
      improvementRequire(
        release != null &&
            receipt.data['releaseBindingSha256'] ==
                release!['releaseBindingSha256'] &&
            receipt.data['behaviorEvidenceSha256'] ==
                validation?.validationSha256,
      );
      if (validation?.native case final native?) {
        final installed = receipt.nativeInstall;
        improvementRequire(
          installed != null &&
              receipt.webRevision == native.pairedBaseline['webRevision'] &&
              receipt.workerRevision ==
                  native.pairedBaseline['workerRevision'] &&
              receipt.data['manifestSha256'] ==
                  native.pairedBaseline['manifestSha256'] &&
              installed['artifactSha256'] == native.artifactSha256 &&
              installed['baselineSha256'] == native.baselineSha256 &&
              installed['unsignedBundleSha256'] ==
                  native.artifact['unsignedBundleSha256'] &&
              installed['signingIdentitySha256'] ==
                  native.installedBaseline['signingIdentitySha256'] &&
              installed['designatedRequirementSha256'] ==
                  native.installedBaseline['designatedRequirementSha256'],
        );
        improvementRequire(
          receipt.outcome == 'deployed'
              ? installed!['version'] == native.version &&
                    installed['buildNumber'] == native.buildNumber.toString()
              : installed!['installedBundleSha256'] ==
                        native.installedBaseline['bundleSha256'] &&
                    installed['version'] ==
                        native.installedBaseline['version'] &&
                    installed['buildNumber'] ==
                        native.previousBuildNumber.toString(),
        );
      } else {
        improvementRequire(receipt.nativeInstall == null);
        if (receipt.outcome != 'deployed') {
          final pair = release!['pairedBaseline'] == null
              ? null
              : improvementObject(release!['pairedBaseline']);
          final previous = pair?['webRevision'] ?? release!['previousRevision'];
          improvementRequire(
            receipt.webRevision == previous &&
                receipt.workerRevision == previous &&
                (pair == null ||
                    receipt.data['manifestSha256'] == pair['manifestSha256']),
          );
        }
      }
    }
    if ({
      'ready_for_release',
      'releasing',
      'succeeded',
      'rolled_back',
    }.contains(stage)) {
      improvementRequire(candidate != null && validation != null);
    }
    if (stage == 'succeeded') {
      improvementRequire(
        releaseReceipt?.outcome == 'deployed' &&
            (validation?.native != null ||
                releaseReceipt?.webRevision == release?['candidateRevision'] &&
                    releaseReceipt?.workerRevision ==
                        release?['candidateRevision']) &&
            usageState == 'known',
      );
    }
  }
  final ImprovementJson data;
  late final ImprovementJson scope;
  late final ImprovementJson? signal,
      approval,
      release,
      controllerHold,
      nativeCheck,
      classification;
  late final String id,
      configurationId,
      projectId,
      tenantId,
      ownerActorId,
      baseRevision,
      stage,
      phase,
      summary,
      usageState,
      createdAt,
      updatedAt,
      executionLeaseExpiresAt,
      releaseEligibility;
  late final String? pullRequestUrl;
  late final int revision, correctionsUsed;
  late final double spendUsd, dailyReservationUsd;
  late final bool approvalExpired,
      approvalRenewalAvailable,
      discardAvailable,
      setupRetryAvailable;
  late final SelfImprovementRepository repository;
  late final SelfImprovementPolicy policy;
  late final SelfImprovementCandidate? candidate;
  late final SelfImprovementValidation? validation;
  late final SelfImprovementReleaseReceipt? releaseReceipt;
  late final List<SelfImprovementAgentRun> agentRuns;
  bool get canStopNativeCheck => nativeCheck?['canStop'] == true;
  bool get terminal => {
    'no_change',
    'succeeded',
    'failed',
    'rolled_back',
    'cancelled',
  }.contains(stage);
  bool get canApprove =>
      usageState == 'known' &&
      candidate != null &&
      validation != null &&
      (stage == 'review_required' ||
          stage == 'ready_for_release' &&
              approvalExpired &&
              approvalRenewalAvailable);
  bool get canReject =>
      canApprove ||
      candidate != null &&
          validation != null &&
          stage == 'ready_for_release' &&
          discardAvailable &&
          controllerHold != null &&
          usageState == 'known' &&
          releaseReceipt == null;
  bool get canRetrySetup =>
      stage == 'failed' &&
      setupRetryAvailable &&
      usageState == 'known' &&
      spendUsd == 0;
}

class SelfImprovementControllerPresence {
  SelfImprovementControllerPresence.fromJson(ImprovementJson value) {
    status = improvementChoice(value['status'], {
      'online',
      'offline',
      'not_connected',
    });
    lastSeenAt = value['lastSeenAt'] == null
        ? null
        : improvementTime(value['lastSeenAt']);
    activity = value['activity'] == null
        ? null
        : improvementChoice(value['activity'], {'held'});
    category = value['category'] == null
        ? null
        : improvementText(value['category'], 120);
    improvementRequire(status == 'not_connected' || lastSeenAt != null);
  }
  late final String status;
  late final String? lastSeenAt, activity, category;
}

class SelfImprovementSnapshot {
  SelfImprovementSnapshot.fromJson(ImprovementJson value) {
    configurations = List.unmodifiable(
      improvementObjects(value['configurations'])
          .map(SelfImprovementConfiguration.fromJson),
    );
    cycles = List.unmodifiable(
      improvementObjects(
        value['cycles'],
        30,
      ).map(SelfImprovementCycle.fromJson),
    );
    controller = SelfImprovementControllerPresence.fromJson(
      improvementObject(value['controller']),
    );
    githubConfigured = improvementBool(
      improvementObject(value['github'])['configured'],
    );
    improvementRequire(
      configurations.map((c) => c.id).toSet().length == configurations.length &&
          cycles.map((c) => c.id).toSet().length == cycles.length,
    );
  }
  late final List<SelfImprovementConfiguration> configurations;
  late final List<SelfImprovementCycle> cycles;
  late final SelfImprovementControllerPresence controller;
  late final bool githubConfigured;
}

class SelfImprovementRepositoryOption {
  SelfImprovementRepositoryOption.fromJson(ImprovementJson value) {
    repositoryId = improvementText(value['repositoryId'], 24);
    fullName = improvementText(value['fullName']);
    defaultBranch = improvementText(value['defaultBranch']);
    htmlUrl = improvementText(value['htmlUrl'], 500);
    improvementRequire(
      RegExp(r'^\d{1,24}$').hasMatch(repositoryId) &&
          fullName == '${value['owner']}/${value['name']}' &&
          htmlUrl == 'https://github.com/$fullName',
    );
  }
  late final String repositoryId, fullName, defaultBranch, htmlUrl;
  bool get supported =>
      fullName.toLowerCase() == 'benniejoseph/omniagentos' &&
      defaultBranch == 'main';
}

class SelfImprovementProject {
  SelfImprovementProject.fromJson(ImprovementJson value) {
    id = improvementText(value['id']);
    title = improvementText(value['title'], 500);
    objective = improvementText(value['objective'], 100000, true);
    status = improvementText(value['status']);
    tenantId = improvementText(value['tenantId']);
    actorId = improvementText(value['actorId']);
  }
  late final String id, title, objective, status, tenantId, actorId;
}

class SelfImprovementConfigureInput {
  const SelfImprovementConfigureInput({
    required this.projectId,
    required this.repositoryId,
    this.dailyBudgetUsd = 100,
    this.maxCycleBudgetUsd = 10,
    this.autoReleaseRoutineChanges = true,
    this.notifyOutcomes = true,
    this.timeZone = 'Asia/Kolkata',
    this.dailyHour = 7,
    this.expectedGeneration,
  });
  final String projectId, repositoryId, timeZone;
  final double dailyBudgetUsd, maxCycleBudgetUsd;
  final bool autoReleaseRoutineChanges, notifyOutcomes;
  final int dailyHour;
  final int? expectedGeneration;
  ImprovementJson toJson() {
    improvementText(projectId);
    improvementRequire(RegExp(r'^\d{1,24}$').hasMatch(repositoryId));
    improvementText(timeZone, 80);
    improvementInt(dailyHour, maximum: 23);
    improvementRequire(
      dailyBudgetUsd.isFinite &&
          maxCycleBudgetUsd.isFinite &&
          dailyBudgetUsd > 0 &&
          dailyBudgetUsd <= 100 &&
          maxCycleBudgetUsd > 0 &&
          maxCycleBudgetUsd <= dailyBudgetUsd,
    );
    if (expectedGeneration != null) {
      improvementInt(expectedGeneration, minimum: 1);
    }
    return {
      'projectId': projectId,
      'repositoryId': repositoryId,
      'dailyBudgetUsd': dailyBudgetUsd,
      'maxCycleBudgetUsd': maxCycleBudgetUsd,
      'autoReleaseRoutineChanges': autoReleaseRoutineChanges,
      'notifyOutcomes': notifyOutcomes,
      'timeZone': timeZone,
      'dailyHour': dailyHour,
      if (expectedGeneration != null) 'expectedGeneration': expectedGeneration,
    };
  }

  bool changesPolicy(SelfImprovementConfiguration before) =>
      !before.policy.data.containsKey('maxCycleBudgetUsd') ||
      dailyBudgetUsd != before.policy.dailyBudgetUsd ||
      maxCycleBudgetUsd != before.policy.maxCycleBudgetUsd ||
      autoReleaseRoutineChanges != before.policy.autoReleaseRoutineChanges ||
      notifyOutcomes != before.policy.notifyOutcomes;
}
