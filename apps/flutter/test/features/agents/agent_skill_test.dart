import 'dart:async';

import 'package:asael/features/agents/agent_skill_contracts.dart';
import 'package:asael/features/agents/agent_skill_controller.dart';
import 'package:asael/features/agents/specialist_contracts.dart';
import 'package:asael/features/agents/specialist_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'agent_skill_fixtures.dart';

void main() {
  test(
    'restored long keys bind the server canonical string correlation hash',
    () async {
      final owner = AgentSkillOwner.fromAccess(catalogAccess(CatalogApi()));
      final key = 'key-${List.filled(400, 'a').join()}';
      final initial = await AgentSkillIntent.prepare(owner, key, {
        'contract': 'asael-skill-create:1',
        'skill': catalogSkill,
      });
      final restored = await AgentSkillIntent.restore(initial.toJson(), owner);
      final correlation = 'idempotency-key:${await specialistSha(key)}';
      expect(
        correlation,
        isNot('idempotency-key:${await agentSkillRawSha(key)}'),
      );
      expect(
        await owner.authority(intent: restored),
        await specialistSha({
          'boundaryVersion': 'p9.1-app-service-boundary:1',
          'tenantId': owner.tenantId,
          'actorId': owner.actorId,
          'role': owner.role,
          'executionScope': {
            'version': 1,
            'tenantId': owner.tenantId,
            'initiatingActorId': owner.actorId,
            'executingPrincipalType': 'user',
            'executingPrincipalId': owner.actorId,
            'workspaceId': null,
            'projectId': null,
            'missionId': null,
            'delegationId': null,
            'correlationId': correlation,
            'causationId': 'skills:create',
            'contextGrantIds': <String>[],
            'capabilityGrantIds': <String>[],
            'purpose': 'skill.create',
          },
        }),
      );
    },
  );
  test('complete normalized Skill fields are sealed without defaults or duplicate tools', () async {
    final api = CatalogApi(),
        owner = AgentSkillOwner.fromAccess(catalogAccess(api));
    final intent = await AgentSkillIntent.prepare(owner, 'create-one', {
      'contract': 'asael-skill-create:1',
      'skill': catalogSkill,
    });
    expect(
      intent.keySha256,
      await agentSkillRawSha('${owner.tenantId}\u0000create-one'),
    );
    expect(intent.request['skill']['knowledgeTags'], ['sources']);
    final missing = {...catalogSkill}..remove('knowledgeTags');
    await expectLater(
      AgentSkillIntent.prepare(owner, 'create-two', {
        'contract': 'asael-skill-create:1',
        'skill': missing,
      }),
      throwsStateError,
    );
    expect(
      () => validateAgentSkillInput({
        ...catalogSkill,
        'toolIds': ['tool:one', 'tool:one'],
      }),
      throwsStateError,
    );
  });
  test('all four operation receipts bind exact review, key and current caller authority', () async {
    final api = CatalogApi(),
        owner = AgentSkillOwner.fromAccess(catalogAccess(api));
    for (final operation in [
      'skill.create',
      'skill.update',
      'skill.delete',
      'agent.delete',
    ]) {
      SpecialistJson request;
      if (operation == 'skill.create') {
        request = {'contract': 'asael-skill-create:1', 'skill': catalogSkill};
      } else {
        final response = await catalogReview(owner, operation),
            review = await AgentSkillReview.parse(
              response,
              owner,
              operation,
              'skill:one',
            );
        request = operation == 'skill.update'
            ? {
                'contract': 'asael-skill-update:1',
                'review': review.pin,
                'change': {'description': 'A revised description'},
              }
            : {
                'contract': 'asael-agent-skill-delete:1',
                'review': review.pin,
                'preview': review.preview,
              };
      }
      final intent = await AgentSkillIntent.prepare(
            owner,
            'key-$operation',
            request,
          ),
          response = await catalogResult(
            owner,
            await AgentSkillIntent.prepare(owner, 'key-$operation', request),
            mutation: true,
          );
      final receipt = await AgentSkillAcceptance.parse(
        response,
        owner,
        intent,
        mutation: true,
      );
      expect(receipt!.raw['operation'], operation);
      final other = await AgentSkillIntent.prepare(
        owner,
        'different-key',
        request,
      );
      await expectLater(
        AgentSkillAcceptance.parse(response, owner, other, mutation: true),
        throwsStateError,
      );
      final viewer = AgentSkillOwner.fromAccess(
        catalogAccess(api, role: 'viewer'),
      );
      await expectLater(
        AgentSkillAcceptance.parse(response, viewer, intent, mutation: true),
        throwsStateError,
      );
    }
  });
  test('complete encrypted intent precedes dispatch and held decision blocks generic writes', () async {
    final api = CatalogApi()..loseResponse = true,
        store = MemorySpecialistRecoveryStore(),
        client = catalogClient(api, store),
        controller = AgentSkillController(client);
    await controller.initialize();
    SpecialistJson? saved;
    api.beforeWrite = () {
      saved = client.nativeDecision;
    };
    await controller.submit({
      'contract': 'asael-skill-create:1',
      'skill': catalogSkill,
    }, isCurrent: () => true);
    expect(api.writes, 1);
    expect(
      saved!['pending']['intent']['request']['skill']['instructions'],
      catalogSkill['instructions'],
    );
    expect(controller.pending, isNotNull);
    await expectLater(
      client.postJson(
        '/api/agents',
        data: {'name': 'Another Agent'},
        headers: {'Idempotency-Key': 'another'},
      ),
      throwsStateError,
    );
    expect(api.writes, 1);
    controller.dispose();
    client.close();
  });
  test('response loss and restart recover only with an exact GET, including viewer downgrade', () async {
    final api = CatalogApi()..loseResponse = true,
        store = MemorySpecialistRecoveryStore(),
        first = catalogClient(api, store),
        controller = AgentSkillController(first);
    await controller.initialize();
    await controller.submit({
      'contract': 'asael-skill-create:1',
      'skill': catalogSkill,
    }, isCurrent: () => true);
    final key = controller.pending!.key;
    controller.dispose();
    first.close();
    final restoredClient = catalogClient(api, store, role: 'viewer'),
        restored = AgentSkillController(restoredClient);
    await restored.initialize();
    expect(restored.pending!.key, key);
    expect(restored.canWrite('skill.create'), isFalse);
    api.receiptFound = false;
    await restored.recover();
    expect(restored.pending!.key, key);
    expect(api.writes, 1);
    api.receiptFound = true;
    await restored.recover();
    expect(restored.pending, isNull);
    expect(restored.accepted!.raw['keySha256'], api.submitted!.keySha256);
    expect(api.writes, 1);
    expect(api.reads, 2);
    restored.dispose();
    restoredClient.close();
  });
  test(
    'missing recovery content cannot discharge an unresolved submission',
    () async {
      final api = CatalogApi()..loseResponse = true,
          store = _MissingStore(),
          client = catalogClient(api, store),
          controller = AgentSkillController(client);
      await controller.initialize();
      await controller.submit({
        'contract': 'asael-skill-create:1',
        'skill': catalogSkill,
      }, isCurrent: () => true);
      final key = controller.pending!.key;
      store.missing = true;
      await controller.reload();
      expect(controller.pending!.key, key);
      expect(controller.loaded, isFalse);
      expect(controller.canWrite('skill.create'), isFalse);
      expect(api.writes, 1);
      controller.dispose();
      client.close();
    },
  );
  test('foreground closes after protected save without dispatch and records not submitted', () async {
    var admitted = true;
    final api = CatalogApi(),
        store = _AfterSaveStore(() => admitted = false),
        client = catalogClient(api, store),
        controller = AgentSkillController(client);
    await controller.initialize();
    await controller.submit({
      'contract': 'asael-skill-create:1',
      'skill': catalogSkill,
    }, isCurrent: () => admitted);
    expect(api.writes, 0);
    expect(controller.pending, isNull);
    expect(controller.notSubmitted, isNotNull);
    expect(controller.busy, isFalse);
    controller.dispose();
    client.close();
  });
  test(
    'owner replacement during credential admission prevents dispatch',
    () async {
      var active = true;
      final gate = Completer<void>(),
          api = CatalogApi()..admission = gate.future,
          store = MemorySpecialistRecoveryStore(),
          client = catalogClient(api, store, current: () => active),
          controller = AgentSkillController(client);
      await controller.initialize();
      final action = controller.submit({
        'contract': 'asael-skill-create:1',
        'skill': catalogSkill,
      }, isCurrent: () => active);
      await api.admitted.future;
      active = false;
      gate.complete();
      await action;
      expect(api.writes, 0);
      controller.dispose();
      client.close();
    },
  );
  test('known accepted receipt survives failed local settlement and is saved without HTTP', () async {
    final api = CatalogApi(),
        store = _FailedSettlement(),
        client = catalogClient(api, store),
        controller = AgentSkillController(client);
    await controller.initialize();
    await controller.submit({
      'contract': 'asael-skill-create:1',
      'skill': catalogSkill,
    }, isCurrent: () => true);
    final accepted = controller.accepted!.raw['id'];
    expect(controller.needsLocalSave, isTrue);
    expect(api.writes, 1);
    store.fail = false;
    await controller.reload();
    expect(controller.accepted!.raw['id'], accepted);
    expect(controller.pending, isNull);
    expect(controller.needsLocalSave, isTrue);
    await controller.settleLocally();
    expect(controller.needsLocalSave, isFalse);
    expect(api.writes, 1);
    controller.dispose();
    client.close();
  });
  test('same canonical UUID with changed owner alias cannot adopt a pending private intent', () async {
    final api = CatalogApi()..loseResponse = true,
        store = MemorySpecialistRecoveryStore(),
        client = catalogClient(api, store),
        controller = AgentSkillController(client);
    await controller.initialize();
    await controller.submit({
      'contract': 'asael-skill-create:1',
      'skill': catalogSkill,
    }, isCurrent: () => true);
    controller.dispose();
    client.close();
    final nextClient = catalogClient(api, store, actor: 'renamed@example.test'),
        next = AgentSkillController(nextClient);
    await next.initialize();
    expect(next.loaded, isFalse);
    expect(next.pending, isNull);
    expect(next.canWrite('skill.create'), isFalse);
    expect(api.writes, 1);
    next.dispose();
    nextClient.close();
  });
}

class _MissingStore extends MemorySpecialistRecoveryStore {
  bool missing = false;
  @override
  Future<SpecialistJson?> read(SpecialistOwner owner, String project) =>
      missing ? Future.value() : super.read(owner, project);
}

class _AfterSaveStore extends MemorySpecialistRecoveryStore {
  _AfterSaveStore(this.after);
  final void Function() after;
  @override
  Future<void> write(
    SpecialistOwner owner,
    String project,
    SpecialistJson value, {
    required bool Function() isCurrent,
  }) async {
    await super.write(owner, project, value, isCurrent: isCurrent);
    if (value['nativeDecision']?['pending'] != null) after();
  }
}

class _FailedSettlement extends MemorySpecialistRecoveryStore {
  bool fail = true;
  @override
  Future<void> write(
    SpecialistOwner owner,
    String project,
    SpecialistJson value, {
    required bool Function() isCurrent,
  }) async {
    if (fail && value['nativeDecision']?['accepted'] != null) {
      throw StateError('Local receipt save unavailable.');
    }
    await super.write(owner, project, value, isCurrent: isCurrent);
  }
}
