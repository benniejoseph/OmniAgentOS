import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/self_improvement/self_improvement_models.dart';
import 'package:asael/features/self_improvement/self_improvement_repository.dart';
import 'package:asael/features/self_improvement/self_improvement_controller.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'self_improvement_test_support.dart';

class _Api extends ApiClient {
  _Api()
    : super(
        Dio(BaseOptions(baseUrl: 'https://asael.test')),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  late ImprovementJson response;
  Future<ImprovementJson> Function(String, ImprovementJson?, ImprovementJson?)?
  write;
  Future<ImprovementJson> Function(String, ImprovementJson?)? read;
  int posts = 0, reads = 0;
  bool ownerCurrent = true;
  String actorId = 'owner@example.test';
  ImprovementJson? body, headers;
  NativeRequestAuthority get authority => NativeRequestAuthority(
    tenantId: 'default',
    actorId: actorId,
    canonicalUserId: improvementUser,
    role: 'admin',
    apiBaseUrl: apiBaseUrl,
    isCurrent: () => ownerCurrent,
  );
  ApiSelfImprovementRepository repository({
    String? verifiedOwnerEmail,
    bool Function()? ownerEmailIsCurrent,
  }) => ApiSelfImprovementRepository(
    this,
    NativeWorkspaceAccess(this, authority, true),
    operationAvailable: (_) => true,
    verifiedOwnerEmail: verifiedOwnerEmail,
    ownerEmailIsCurrent: ownerEmailIsCurrent,
  );
  @override
  Future<ImprovementJson> getJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    ImprovementJson? query,
    ImprovementJson? headers,
    CancelToken? cancelToken,
  }) async {
    reads++;
    return read == null ? response : read!(path, query);
  }

  @override
  Future<ImprovementJson> postJsonAuthorizedOnce(
    String path, {
    required NativeRequestAuthority authority,
    ImprovementJson? data,
    ImprovementJson? headers,
    Duration? receiveTimeout,
  }) async {
    posts++;
    body = data;
    this.headers = headers;
    return write!(path, data, headers);
  }

  @override
  Future<ImprovementJson> postJson(
    String path, {
    ImprovementJson? data,
    ImprovementJson? headers,
  }) => throw StateError('Unbound transport is forbidden.');
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  test('the checked server-produced status, cycle and setup envelopes parse unchanged', () async {
    final fixture = improvementObject(
      jsonDecode(
        File('test/fixtures/self_improvement_public_response.json')
            .readAsStringSync(),
      ),
    );
    final api = _Api()..actorId = improvementActor;
    api.read = (path, query) async {
      if (path == '/api/projects') {
        return improvementObject(fixture['projects']);
      }
      if (query?['view'] == 'repositories') {
        return improvementObject(fixture['repositories']);
      }
      if (query?['cycleId'] != null) {
        return improvementObject(fixture['exactCycle']);
      }
      return improvementObject(fixture['status']);
    };
    final repository = api.repository(
      verifiedOwnerEmail: 'owner@example.test',
      ownerEmailIsCurrent: () => true,
    );
    final status = await repository.load();
    final exact = await repository.loadCycle(
      improvementObject(fixture['exactCycle'])['cycle']['id'] as String,
    );
    expect(status.cycles.single.id, exact!.id);
    expect(exact.stage, 'succeeded');
    expect(exact.agentRuns.map((r) => r.agentId), [
      'atlas',
      'forge',
      'sentinel',
    ]);
    expect(exact.releaseReceipt!.outcome, 'deployed');
    expect(exact.validation!.baselineReproduction, isNotNull);
    expect((await repository.loadRepositories()).single.supported, true);
    expect(
      (await repository.loadProjects()).single.id,
      status.configurations.single.projectId,
    );
    expect(api.posts, 0);
  });
  test(
    'canonical native owner reads only its currently verified legacy projects',
    () async {
      final api = _Api()..actorId = improvementActor;
      final project = <String, dynamic>{
        'id': 'legacy-project',
        'title': 'Engineering',
        'objective': 'Improve Asael',
        'status': 'active',
        'tenantId': 'default',
        'actorId': 'owner@example.test',
      };
      api.response = {
        'projects': [project],
      };
      await expectLater(api.repository().loadProjects(), throwsFormatException);
      final repository = api.repository(
        verifiedOwnerEmail: 'owner@example.test',
        ownerEmailIsCurrent: () => true,
      );
      expect(
        (await repository.loadProjects()).single.actorId,
        'owner@example.test',
      );
      for (final changed in [
        {...project, 'actorId': 'another@example.test'},
        {...project, 'tenantId': 'another-tenant'},
        {...project, 'actorId': 'actor:22222222-2222-4222-8222-222222222222'},
      ]) {
        api.response = {
          'projects': [changed],
        };
        await expectLater(repository.loadProjects(), throwsFormatException);
      }
      api.response = {
        'projects': [
          {...project, 'actorId': improvementActor},
        ],
      };
      expect(
        (await repository.loadProjects()).single.actorId,
        improvementActor,
      );
      expect(api.posts, 0);
    },
  );
  test('an email change invalidates retained native authority before alias readback', () async {
    final api = _Api()..actorId = improvementActor;
    var currentEmail = 'owner@example.test';
    final repository = api.repository(
      verifiedOwnerEmail: currentEmail,
      ownerEmailIsCurrent: () => currentEmail == 'owner@example.test',
    );
    api.read = (_, _) async {
      currentEmail = 'new@example.test';
      return {
        'projects': [
          {
            'id': 'legacy-project',
            'title': 'Engineering',
            'objective': '',
            'status': 'active',
            'tenantId': 'default',
            'actorId': 'owner@example.test',
          },
        ],
      };
    };
    await expectLater(repository.loadProjects(), throwsFormatException);
    expect(repository.current, false);
    expect(repository.canManage, false);
    await expectLater(repository.loadProjects(), throwsFormatException);
    expect(api.reads, 1);
    expect(
      () => api.repository(verifiedOwnerEmail: 'owner@example.test'),
      throwsFormatException,
    );
    expect(
      () => api.repository(
        verifiedOwnerEmail: 'not-an-email',
        ownerEmailIsCurrent: () => true,
      ),
      throwsFormatException,
    );
  });
  test('GitHub identity permits canonical casing without changing evidence strings', () {
    final normalized = SelfImprovementRepository.fromJson({
      'owner': 'benniejoseph',
      'name': 'omniagentos',
      'defaultBranch': 'main',
    });
    expect(normalized.name, 'omniagentos');
    expect(
      () => SelfImprovementRepository.fromJson({
        'owner': 'foreign',
        'name': 'OmniAgentOS',
        'defaultBranch': 'main',
      }),
      throwsFormatException,
    );
    expect(
      () => SelfImprovementRepository.fromJson({
        'owner': 'benniejoseph',
        'name': 'OmniAgentOS',
        'defaultBranch': 'other',
      }),
      throwsFormatException,
    );
  });
  test(
    'a confirmed settings receipt cannot be replaced by an older read',
    () async {
      final config = improvementConfig(await improvementPolicy());
      final api = _Api()..response = improvementSnapshot(config);
      api.write = (_, body, headers) => improvementResponse(
        {
          'configuration': {...config, 'generation': 2, 'paused': true},
        },
        'pause',
        headers!['idempotency-key'] as String,
      );
      final controller = SelfImprovementController(api.repository());
      await controller.refresh();
      expect(
        await controller.setPaused(
          controller.snapshot!.configurations.single,
          true,
        ),
        false,
      );
      expect(controller.refreshRequired, true);
      expect(api.posts, 1);
      api.response = improvementSnapshot({
        ...config,
        'generation': 2,
        'paused': true,
      });
      await controller.refresh();
      expect(controller.canManage, true);
      expect(api.posts, 1);
      controller.dispose();
    },
  );
  test('a pending mutation prevents a second concurrent dispatch', () async {
    final config = improvementConfig(await improvementPolicy());
    final api = _Api()..response = improvementSnapshot(config);
    final arrived = Completer<void>(), release = Completer<void>();
    api.write = (_, body, headers) async {
      arrived.complete();
      await release.future;
      return improvementResponse(
        {'outcome': 'budget_exhausted', 'cycle': null, 'operationJob': null},
        'run',
        headers!['idempotency-key'] as String,
      );
    };
    final controller = SelfImprovementController(api.repository());
    await controller.refresh();
    final configuration = controller.snapshot!.configurations.single;
    final pending = controller.run(configuration);
    await arrived.future;
    expect(() => controller.run(configuration), throwsFormatException);
    expect(api.posts, 1);
    release.complete();
    expect(await pending, true);
    expect(controller.lastOutcome, 'budget_exhausted');
    controller.dispose();
  });
  test('stopping a held Mac check sends its exact receipt once and reads the confirmed cancellation', () async {
    final policy = await improvementPolicy(),
        config = improvementConfig(policy);
    final held = await improvementCycle(policy, stage: 'validating');
    held['nativeCheck'] = {
      'requestId': 'self_native_${improvementHex('9')}',
      'requestSha256': improvementHex('8'),
      'purpose': 'candidate',
      'status': 'held',
      'holdCategory': 'native_validation_expired',
      'canStop': true,
    };
    final api = _Api()..response = improvementSnapshot(config, [held]);
    api.write = (_, body, headers) async {
      expect(body, {
        'action': 'stop_native_check',
        'input': {
          'cycleId': held['id'],
          'expectedRevision': 2,
          'requestId': held['nativeCheck']['requestId'],
          'requestSha256': held['nativeCheck']['requestSha256'],
        },
      });
      final cancelled = improvementCopy(held)
        ..['stage'] = 'cancelled'
        ..['revision'] = 3;
      cancelled['nativeCheck']['canStop'] = false;
      api.response = improvementSnapshot(config, [cancelled]);
      return improvementResponse(
        {'cycle': cancelled},
        'stop_native_check',
        headers!['idempotency-key'] as String,
      );
    };
    final controller = SelfImprovementController(api.repository());
    await controller.refresh();
    expect(
      await controller.stopNativeCheck(controller.snapshot!.cycles.single),
      true,
    );
    expect(controller.snapshot!.cycles.single.stage, 'cancelled');
    expect(controller.lastOutcome, 'stop_native_check');
    expect(api.posts, 1);
    expect(
      () => controller.stopNativeCheck(controller.snapshot!.cycles.single),
      throwsFormatException,
    );
    expect(api.posts, 1);
    controller.dispose();
  });
  test('a held check with unsettled cost or changed request cannot be stopped from stale UI', () async {
    final policy = await improvementPolicy(),
        config = improvementConfig(policy);
    final held = await improvementCycle(policy, stage: 'validating');
    held['nativeCheck'] = {
      'requestId': 'self_native_${improvementHex('9')}',
      'requestSha256': improvementHex('8'),
      'purpose': 'candidate',
      'status': 'held',
      'holdCategory': 'native_validation_expired',
      'canStop': true,
    };
    final stale = SelfImprovementCycle.fromJson(held);
    final api = _Api()..response = improvementSnapshot(config, [held]);
    final controller = SelfImprovementController(api.repository());
    await controller.refresh();
    held['nativeCheck']['requestSha256'] = improvementHex('7');
    await controller.refresh();
    expect(() => controller.stopNativeCheck(stale), throwsFormatException);
    held['nativeCheck']['canStop'] = false;
    held['usageState'] = 'unknown';
    await controller.refresh();
    expect(
      () => controller.stopNativeCheck(controller.snapshot!.cycles.single),
      throwsFormatException,
    );
    expect(api.posts, 0);
    controller.dispose();
  });
  test(
    'schedule-only edits preserve the normal policy warning boundary',
    () async {
      final normal = SelfImprovementConfiguration.fromJson(
        improvementConfig(await improvementPolicy()),
      );
      const input = SelfImprovementConfigureInput(
        projectId: 'project-one',
        repositoryId: '1260961340',
        notifyOutcomes: false,
        dailyHour: 8,
        expectedGeneration: 1,
      );
      expect(input.changesPolicy(normal), false);
      final legacy = SelfImprovementConfiguration.fromJson(
        improvementConfig(await improvementPolicy(legacy: true)),
      );
      const legacyInput = SelfImprovementConfigureInput(
        projectId: 'project-one',
        repositoryId: '1260961340',
        maxCycleBudgetUsd: 100,
        notifyOutcomes: false,
        dailyHour: 8,
        expectedGeneration: 1,
      );
      expect(legacyInput.changesPolicy(legacy), true);
    },
  );
  test(
    'legacy cycle ceiling falls back without rewriting the policy hash',
    () async {
      final json = await improvementPolicy(legacy: true),
          policy = SelfImprovementPolicy.fromJson(json);
      expect(policy.maxCycleBudgetUsd, 100);
      expect(policy.data.containsKey('maxCycleBudgetUsd'), false);
      final api = _Api()
        ..response = improvementSnapshot(improvementConfig(json));
      expect(
        (await api.repository().load())
            .configurations
            .single
            .policy
            .policySha256,
        json['policySha256'],
      );
    },
  );
  test(
    'unknown stage, malformed costs and false validation success fail closed',
    () async {
      final policy = await improvementPolicy();
      final cycle = await improvementCycle(policy, stage: 'review_required');
      for (final value in [
        improvementCopy(cycle)..['stage'] = 'new_unknown_stage',
        improvementCopy(cycle)..['spendUsd'] = -1,
        improvementCopy(cycle)..['usageState'] = 'estimated',
      ]) {
        expect(
          () => SelfImprovementCycle.fromJson(value),
          throwsFormatException,
        );
      }
      final invalid = improvementCopy(cycle);
      (invalid['validation']['checks'][0] as Map)['executedCases'] = 1;
      expect(
        () => SelfImprovementCycle.fromJson(invalid),
        throwsFormatException,
      );
    },
  );
  test(
    'owner and tenant are checked after fresh authenticated reads',
    () async {
      final policy = await improvementPolicy(),
          config = improvementConfig(policy);
      for (final delta in [
        {'ownerActorId': 'actor:22222222-2222-4222-8222-222222222222'},
        {'tenantId': 'foreign'},
      ]) {
        final api = _Api()
          ..response = improvementSnapshot({...config, ...delta});
        await expectLater(api.repository().load(), throwsFormatException);
        expect(api.posts, 0);
      }
    },
  );
  test(
    'changed policy and nested candidate fingerprints are rejected',
    () async {
      final policy = await improvementPolicy(),
          config = improvementConfig(policy);
      final cycle = await improvementCycle(policy, stage: 'review_required');
      final changedPolicy = improvementCopy(config);
      changedPolicy['policy']['dailyBudgetUsd'] = 99;
      final api = _Api()..response = improvementSnapshot(changedPolicy);
      await expectLater(api.repository().load(), throwsFormatException);
      final changedCycle = improvementCopy(cycle);
      changedCycle['candidate']['changedLines'] = 5;
      api.response = improvementSnapshot(config, [changedCycle]);
      await expectLater(api.repository().load(), throwsFormatException);
    },
  );
  test(
    'setup retry, held discard and approval renewal retain exact eligibility',
    () async {
      final policy = await improvementPolicy();
      final failed = (await improvementCycle(policy, stage: 'failed'))
        ..['setupRetryAvailable'] = true;
      expect(SelfImprovementCycle.fromJson(failed).canRetrySetup, true);
      failed['usageState'] = 'unknown';
      expect(SelfImprovementCycle.fromJson(failed).canRetrySetup, false);
      final ready = await improvementCycle(policy, stage: 'ready_for_release');
      ready.addAll({
        'controllerHold': {'category': 'base_revision_changed'},
        'discardAvailable': true,
        'releaseEligibility': 'manual_release',
      });
      expect(SelfImprovementCycle.fromJson(ready).canReject, true);
      expect(SelfImprovementCycle.fromJson(ready).canApprove, false);
      ready.addAll({
        'discardAvailable': false,
        'controllerHold': null,
        'approvalExpired': true,
        'approvalRenewalAvailable': true,
      });
      expect(SelfImprovementCycle.fromJson(ready).canApprove, true);
      ready['approvalRenewalAvailable'] = false;
      expect(SelfImprovementCycle.fromJson(ready).canApprove, false);
    },
  );
  test('a one-shot pause validates exact receipt and generation', () async {
    final policy = await improvementPolicy(),
        config = improvementConfig(policy),
        api = _Api();
    api.write = (_, body, headers) => improvementResponse(
      {
        'configuration': {...config, 'generation': 2, 'paused': true},
      },
      'pause',
      headers!['idempotency-key'] as String,
    );
    final result = await api.repository().mutate('pause', {
      'configurationId': 'configuration-one',
      'expectedGeneration': 1,
      'paused': true,
    }, newSelfImprovementIdempotencyKey());
    expect(result.configuration!.paused, true);
    expect(api.posts, 1);
    expect(api.body!['input']['expectedGeneration'], 1);
    api.write = (_, body, headers) => improvementResponse(
      {
        'configuration': {...config, 'generation': 3, 'paused': true},
      },
      'pause',
      headers!['idempotency-key'] as String,
    );
    await expectLater(
      api.repository().mutate('pause', {
        'configurationId': 'configuration-one',
        'expectedGeneration': 1,
        'paused': true,
      }, newSelfImprovementIdempotencyKey()),
      throwsFormatException,
    );
  });
  test('receipt tampering, unsupported action and extra fields cannot authorize success', () async {
    final api = _Api();
    api.write = (_, body, headers) async {
      final result = await improvementResponse(
        {'outcome': 'budget_exhausted', 'cycle': null, 'operationJob': null},
        'run',
        headers!['idempotency-key'] as String,
      );
      result['outcome'] = 'claimed';
      return result;
    };
    await expectLater(
      api.repository().mutate('run', {
        'configurationId': 'configuration-one',
        'expectedGeneration': 1,
      }, newSelfImprovementIdempotencyKey()),
      throwsFormatException,
    );
    expect(api.posts, 1);
    for (final action in ['advance', 'claim', 'complete']) {
      await expectLater(
        api.repository().mutate(action, {}, newSelfImprovementIdempotencyKey()),
        throwsFormatException,
      );
    }
    await expectLater(
      api.repository().mutate('run', {
        'configurationId': 'configuration-one',
        'expectedGeneration': 1,
        'ownerActorId': 'forged',
      }, newSelfImprovementIdempotencyKey()),
      throwsFormatException,
    );
    expect(api.posts, 1);
  });
  test(
    'lost run response is not replayed and all actions wait for refresh',
    () async {
      final api = _Api()
        ..response = improvementSnapshot(
          improvementConfig(await improvementPolicy()),
        );
      api.write = (_, _, _) =>
          Future.error(const ApiException('Outcome unknown'));
      final c = SelfImprovementController(api.repository());
      await c.refresh();
      final config = c.snapshot!.configurations.single;
      expect(await c.run(config), false);
      expect(api.posts, 1);
      expect(c.refreshRequired, true);
      expect(c.canManage, false);
      expect(() => c.run(config), throwsFormatException);
      expect(api.posts, 1);
      await c.refresh();
      expect(c.canManage, true);
      expect(api.posts, 1);
      c.dispose();
    },
  );
  test(
    'confirmed mutation followed by failed readback stays blocked',
    () async {
      final config = improvementConfig(await improvementPolicy()),
          api = _Api()
            ..response = improvementSnapshot(
              improvementConfig(await improvementPolicy()),
            );
      api.write = (_, body, headers) async {
        api.read = (_, _) => Future.error(const ApiException('Offline'));
        return improvementResponse(
          {
            'configuration': {...config, 'generation': 2, 'paused': true},
          },
          'pause',
          headers!['idempotency-key'] as String,
        );
      };
      final c = SelfImprovementController(api.repository());
      await c.refresh();
      expect(await c.setPaused(c.snapshot!.configurations.single, true), false);
      expect(c.refreshRequired, true);
      expect(api.posts, 1);
      c.dispose();
    },
  );
  test(
    'owner replacement during read discards all private responses',
    () async {
      final api = _Api()
        ..response = improvementSnapshot(
          improvementConfig(await improvementPolicy()),
        );
      final arrived = Completer<void>(), release = Completer<void>();
      api.read = (_, _) async {
        arrived.complete();
        await release.future;
        return api.response;
      };
      final c = SelfImprovementController(api.repository()),
          pending = c.refresh();
      await arrived.future;
      api.ownerCurrent = false;
      release.complete();
      await pending;
      expect(c.snapshot, isNull);
      expect(c.current, false);
      expect(c.canManage, false);
      c.dispose();
    },
  );
  test(
    'older notification loads only its exact cycle and no substitute',
    () async {
      final policy = await improvementPolicy(),
          cycle = await improvementCycle(
            await improvementPolicy(),
            stage: 'failed',
          );
      final api = _Api()
        ..response = improvementSnapshot(improvementConfig(policy));
      api.read = (_, query) async => query?['cycleId'] == improvementCycleId
          ? {'cycle': cycle}
          : api.response;
      final c = SelfImprovementController(api.repository());
      await c.refresh(cycleId: improvementCycleId);
      expect(c.selectedCycle!.id, improvementCycleId);
      expect(c.snapshot!.cycles, isEmpty);
      api.read = (_, query) async => query?['cycleId'] == improvementCycleId
          ? {'cycle': null}
          : api.response;
      await c.refresh();
      expect(c.selectedCycle, isNull);
      expect(c.requestedCycleId, improvementCycleId);
      c.dispose();
    },
  );
  test(
    'read-only role or stale current authority cannot dispatch a write',
    () async {
      final api = _Api();
      final access = NativeWorkspaceAccess(api, api.authority, false);
      final repository = ApiSelfImprovementRepository(
        api,
        access,
        operationAvailable: (_) => true,
      );
      await expectLater(
        repository.mutate('run', {
          'configurationId': 'configuration-one',
          'expectedGeneration': 1,
        }, newSelfImprovementIdempotencyKey()),
        throwsFormatException,
      );
      expect(api.posts, 0);
      api.ownerCurrent = false;
      await expectLater(api.repository().load(), throwsFormatException);
      expect(api.reads, 0);
    },
  );
}
