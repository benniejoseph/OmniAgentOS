import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/network/native_workspace_access.dart';
import '../../generated/native_contract.g.dart';
import '../agents/specialist_contracts.dart';
import 'self_improvement_models.dart';

class SelfImprovementMutationResult {
  const SelfImprovementMutationResult({
    this.configuration,
    this.cycle,
    this.outcome,
    this.manualReleaseRequired = false,
  });
  final SelfImprovementConfiguration? configuration;
  final SelfImprovementCycle? cycle;
  final String? outcome;
  final bool manualReleaseRequired;
}

abstract interface class SelfImprovementRepositoryApi {
  bool get current;
  bool get canManage;
  Future<SelfImprovementSnapshot> load();
  Future<SelfImprovementCycle?> loadCycle(String id);
  Future<List<SelfImprovementRepositoryOption>> loadRepositories();
  Future<List<SelfImprovementProject>> loadProjects();
  Future<SelfImprovementMutationResult> mutate(
    String action,
    ImprovementJson input,
    String idempotencyKey,
  );
}

class ApiSelfImprovementRepository implements SelfImprovementRepositoryApi {
  ApiSelfImprovementRepository(
    this.api,
    this.access, {
    bool Function(String)? operationAvailable,
    String? verifiedOwnerEmail,
    this.ownerEmailIsCurrent,
  }) : operationAvailable =
           operationAvailable ?? NativeContract.supportsOperation,
       verifiedOwnerEmail = verifiedOwnerEmail?.trim().toLowerCase() {
    improvementRequire(
      this.verifiedOwnerEmail == null ||
          (ownerEmailIsCurrent != null &&
              RegExp(r'^[^\s@]+@[^\s@]+$').hasMatch(this.verifiedOwnerEmail!)),
      'A current authenticated email binding is required.',
    );
  }
  final ApiClient api;
  final NativeWorkspaceAccess? access;
  final bool Function(String) operationAvailable;
  // Supplied only by the current authenticated session, never project data.
  final String? verifiedOwnerEmail;
  final bool Function()? ownerEmailIsCurrent;
  static String get path => NativePaths.selfImprovementGet();
  @override
  bool get current =>
      access?.current == true &&
      (verifiedOwnerEmail == null || ownerEmailIsCurrent!()) &&
      operationAvailable('selfImprovement.get');
  @override
  bool get canManage =>
      current &&
      access!.canManage &&
      access!.authority.role == 'admin' &&
      operationAvailable('selfImprovement.mutate') &&
      operationAvailable('workspaces.update');
  void _require([bool mutation = false]) {
    improvementRequire(
      mutation ? canManage : current,
      'The signed-in owner and current published improvement capability are required.',
    );
    access!.authority.requireCurrent(api.apiBaseUrl);
  }

  String get _actor =>
      'actor:${access!.authority.canonicalUserId.toLowerCase()}';
  void _owner(String tenant, String actor) => improvementRequire(
    tenant == access!.authority.tenantId && actor == _actor,
    'The improvement response belongs to a different owner.',
  );
  Future<ImprovementJson> _get(String target, {ImprovementJson? query}) async {
    _require();
    final response = await api.getJsonAuthorized(
      target,
      authority: access!.authority,
      query: query,
    );
    _require();
    return response;
  }

  Future<void> _sealed(String kind, ImprovementJson value, String field) async {
    final body = {...value}..remove(field);
    improvementRequire(
      value[field] ==
          await specialistSha({
            'contract': 'asael-self-improvement',
            'version': 1,
            'kind': kind,
            'value': body,
          }),
      'The improvement evidence fingerprint changed.',
    );
  }

  Future<void> _configuration(SelfImprovementConfiguration value) async {
    _owner(value.tenantId, value.ownerActorId);
    await _sealed('policy', value.policy.data, 'policySha256');
  }

  Future<void> _cycle(SelfImprovementCycle value) async {
    _owner(value.tenantId, value.ownerActorId);
    await _sealed('policy', value.policy.data, 'policySha256');
    if (value.candidate case final c?) {
      await _sealed('candidate', c.data, 'candidateSha256');
    }
    if (value.validation case final v?) {
      await _sealed('validation', v.data, 'validationSha256');
    }
    if (value.approval case final a?) {
      await _sealed('approval', a, 'receiptSha256');
    }
    if (value.release case final r?) {
      await _sealed('release_binding', r, 'releaseBindingSha256');
    }
    if (value.signal case final signal?) {
      final withoutId = {...signal}..remove('id');
      await _sealed('engineering_signal', withoutId, 'signalSha256');
      improvementRequire(
        signal['id'] == 'self_signal_${signal['signalSha256']}' &&
            specialistCanonical(signal['scope']) ==
                specialistCanonical(value.scope),
      );
    }
    _require();
  }

  @override
  Future<SelfImprovementSnapshot> load() async {
    final snapshot = SelfImprovementSnapshot.fromJson(await _get(path));
    for (final c in snapshot.configurations) {
      await _configuration(c);
    }
    for (final c in snapshot.cycles) {
      await _cycle(c);
    }
    _require();
    return snapshot;
  }

  @override
  Future<SelfImprovementCycle?> loadCycle(String id) async {
    improvementRequire(RegExp(r'^self_cycle_[a-f0-9]{64}$').hasMatch(id));
    ImprovementJson response;
    try {
      response = await _get(path, query: {'cycleId': id});
    } on ApiException catch (error) {
      if (error.statusCode == 404) {
        _require();
        return null;
      }
      rethrow;
    }
    if (response['cycle'] == null) return null;
    final cycle = SelfImprovementCycle.fromJson(
      improvementObject(response['cycle']),
    );
    improvementRequire(cycle.id == id);
    await _cycle(cycle);
    return cycle;
  }

  @override
  Future<List<SelfImprovementRepositoryOption>> loadRepositories() async {
    final response = await _get(path, query: {'view': 'repositories'});
    return List.unmodifiable(
      improvementObjects(
        response['repositories'],
        1000,
      ).map(SelfImprovementRepositoryOption.fromJson).where((r) => r.supported),
    );
  }

  @override
  Future<List<SelfImprovementProject>> loadProjects() async {
    final response = await _get('/api/projects', query: {'limit': 100});
    final projects = improvementObjects(
      response['projects'],
      100,
    ).map(SelfImprovementProject.fromJson).toList(growable: false);
    for (final p in projects) {
      improvementRequire(
        p.tenantId == access!.authority.tenantId &&
            ({access!.authority.actorId, _actor}.contains(p.actorId) ||
                (verifiedOwnerEmail != null &&
                    p.actorId.trim().toLowerCase() == verifiedOwnerEmail)),
        'The setup project belongs to a different account.',
      );
    }
    return List.unmodifiable(projects);
  }

  Future<void> _receipt(
    ImprovementJson response,
    String action,
    String key,
  ) async {
    final receipt = improvementObject(response['serviceReceipt']);
    final body = {...receipt}..remove('receiptSha256');
    final outcome = {...response}..remove('serviceReceipt');
    final idHash = (await Sha256().hash(
      utf8.encode('${access!.authority.tenantId}\u0000$key'),
    )).bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    improvementRequire(
      receipt['receiptSha256'] == await specialistSha(body) &&
          receipt['outcomeSha256'] == await specialistSha(outcome) &&
          receipt['idempotencyKeySha256'] == idHash &&
          receipt['operation'] == 'app.self_improvement.$action' &&
          receipt['schemaVersion'] == 1 &&
          receipt['receiptKind'] == 'app_service_receipt' &&
          receipt['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
          receipt['accessMode'] == 'mutation' &&
          receipt['action'] == 'manage.workflow' &&
          receipt['resourceType'] == 'self_improvement' &&
          receipt['eventContract'] == 'self-improvement-events.v1',
      'The exact improvement mutation receipt could not be verified. Refresh before continuing.',
    );
    improvementDigest(receipt['authoritySha256']);
  }

  @override
  Future<SelfImprovementMutationResult> mutate(
    String action,
    ImprovementJson input,
    String idempotencyKey,
  ) async {
    _require(true);
    improvementRequire(
      {
        'configure',
        'run',
        'pause',
        'review',
        'retry',
        'stop_native_check',
      }.contains(action),
    );
    improvementRequire(
      RegExp(r'^native-improvement-[a-f0-9]{32}$').hasMatch(idempotencyKey),
    );
    final fields = switch (action) {
      'configure' => {
        'projectId',
        'repositoryId',
        'dailyBudgetUsd',
        'maxCycleBudgetUsd',
        'autoReleaseRoutineChanges',
        'notifyOutcomes',
        'timeZone',
        'dailyHour',
        if (input.containsKey('expectedGeneration')) 'expectedGeneration',
      },
      'pause' => {'configurationId', 'expectedGeneration', 'paused'},
      'review' => {
        'cycleId',
        'expectedRevision',
        'candidateSha256',
        'validationSha256',
        'decision',
      },
      'retry' => {
        'configurationId',
        'expectedGeneration',
        'failedCycleId',
        'expectedRevision',
      },
      'stop_native_check' => {
        'cycleId',
        'expectedRevision',
        'requestId',
        'requestSha256',
      },
      _ => {'configurationId', 'expectedGeneration'},
    };
    improvementRequire(
      input.length == fields.length && input.keys.every(fields.contains),
    );
    if (action == 'configure') {
      SelfImprovementConfigureInput(
        projectId: improvementText(input['projectId']),
        repositoryId: improvementText(input['repositoryId']),
        dailyBudgetUsd: improvementNumber(
          input['dailyBudgetUsd'],
          maximum: 100,
        ),
        maxCycleBudgetUsd: improvementNumber(
          input['maxCycleBudgetUsd'],
          maximum: 100,
        ),
        autoReleaseRoutineChanges: improvementBool(
          input['autoReleaseRoutineChanges'],
        ),
        notifyOutcomes: improvementBool(input['notifyOutcomes']),
        timeZone: improvementText(input['timeZone']),
        dailyHour: improvementInt(input['dailyHour'], maximum: 23),
        expectedGeneration: input['expectedGeneration'] == null
            ? null
            : improvementInt(input['expectedGeneration'], minimum: 1),
      ).toJson();
    } else if (action == 'stop_native_check') {
      improvementText(input['cycleId']);
      improvementInt(input['expectedRevision'], minimum: 1);
      improvementRequire(
        RegExp(r'^self_native_[a-f0-9]{64}$')
            .hasMatch(improvementText(input['requestId'])),
      );
      improvementDigest(input['requestSha256']);
    } else if (action == 'review') {
      improvementText(input['cycleId']);
      improvementInt(input['expectedRevision'], minimum: 1);
      improvementDigest(input['candidateSha256']);
      improvementDigest(input['validationSha256']);
      improvementChoice(input['decision'], {'approve', 'reject'});
    } else {
      improvementText(input['configurationId']);
      improvementInt(input['expectedGeneration'], minimum: 1);
      if (action == 'pause') improvementBool(input['paused']);
      if (action == 'retry') {
        improvementText(input['failedCycleId']);
        improvementInt(input['expectedRevision'], minimum: 1);
      }
    }
    final response = await api.postJsonAuthorizedOnce(
      NativePaths.selfImprovementMutate,
      authority: access!.authority,
      data: {'action': action, 'input': input},
      headers: {'idempotency-key': idempotencyKey},
    );
    _require(true);
    await _receipt(response, action, idempotencyKey);
    if (action == 'configure' || action == 'pause') {
      final c = SelfImprovementConfiguration.fromJson(
        improvementObject(response['configuration']),
      );
      await _configuration(c);
      improvementRequire(
        c.generation == (input['expectedGeneration'] as int? ?? 0) + 1,
      );
      if (action == 'pause') {
        improvementRequire(
          c.id == input['configurationId'] && c.paused == input['paused'],
        );
      } else {
        improvementRequire(
          c.projectId == input['projectId'] &&
              c.repositoryId == input['repositoryId'] &&
              c.timeZone == input['timeZone'] &&
              c.dailyHour == input['dailyHour'] &&
              c.policy.dailyBudgetUsd == input['dailyBudgetUsd'] &&
              c.policy.maxCycleBudgetUsd == input['maxCycleBudgetUsd'] &&
              c.policy.autoReleaseRoutineChanges ==
                  input['autoReleaseRoutineChanges'] &&
              c.policy.notifyOutcomes == input['notifyOutcomes'],
        );
      }
      return SelfImprovementMutationResult(configuration: c);
    }
    final cycle = response['cycle'] == null
        ? null
        : SelfImprovementCycle.fromJson(improvementObject(response['cycle']));
    if (cycle != null) await _cycle(cycle);
    if (action == 'stop_native_check') {
      improvementRequire(
        cycle != null &&
            cycle.id == input['cycleId'] &&
            cycle.revision > (input['expectedRevision'] as int) &&
            cycle.stage == 'cancelled' &&
            cycle.nativeCheck?['requestId'] == input['requestId'] &&
            cycle.nativeCheck?['requestSha256'] == input['requestSha256'] &&
            !cycle.canStopNativeCheck,
      );
      return SelfImprovementMutationResult(
        cycle: cycle,
        outcome: 'stop_native_check',
      );
    }
    if (action == 'review') {
      improvementRequire(
        cycle != null &&
            cycle.id == input['cycleId'] &&
            cycle.revision > (input['expectedRevision'] as int) &&
            cycle.candidate?.candidateSha256 == input['candidateSha256'] &&
            cycle.validation?.validationSha256 == input['validationSha256'] &&
            (input['decision'] == 'reject'
                ? cycle.stage == 'cancelled'
                : cycle.stage == 'ready_for_release'),
      );
      return SelfImprovementMutationResult(
        cycle: cycle,
        manualReleaseRequired: improvementBool(
          response['manualReleaseRequired'],
        ),
      );
    }
    final outcome = improvementChoice(response['outcome'], {
      'claimed',
      'duplicate',
      'busy',
      'budget_exhausted',
      'paused',
      'not_due',
    });
    improvementRequire(
      !{'claimed', 'duplicate'}.contains(outcome) || cycle != null,
    );
    if (cycle != null) {
      improvementRequire(cycle.configurationId == input['configurationId']);
    }
    if (action == 'retry' && cycle != null) {
      improvementRequire(
        improvementObject(response['retryOf'])['cycleId'] ==
                input['failedCycleId'] &&
            cycle.id != input['failedCycleId'],
      );
    }
    final job = response['operationJob'];
    if (job != null) {
      final j = improvementObject(job);
      improvementText(j['id']);
      improvementRequire(
        cycle != null && j['type'] == 'self_improvement.cycle.tick',
      );
      improvementChoice(j['status'], {
        'queued',
        'running',
        'completed',
        'failed',
        'canceled',
        'quarantined',
      });
    }
    return SelfImprovementMutationResult(cycle: cycle, outcome: outcome);
  }
}

String newSelfImprovementIdempotencyKey() {
  final random = Random.secure();
  return 'native-improvement-${List.generate(16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
}
