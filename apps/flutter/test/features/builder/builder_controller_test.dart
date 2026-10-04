import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/ciphertext_recovery_broker.dart';
import 'package:asael/features/builder/builder_contracts.dart';
import 'package:asael/features/builder/builder_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'builder_test_support.dart';

class _CommittedUnknownStore extends TestRecoveryStore {
  bool unknown = true;
  @override
  Future<void> write(
    BuilderOwner owner,
    String project,
    BuilderJson value, {
    required bool Function() isCurrent,
  }) async {
    await super.write(owner, project, value, isCurrent: isCurrent);
    if (unknown && (value['outcome'] as Map?)?['state'] == 'prepared') {
      unknown = false;
      throw const RecoveryStorageUnknown();
    }
  }
}

void main() {
  late TestBuilderRepository repository;
  late TestRecoveryStore recovery;
  late BuilderController controller;
  setUp(() {
    repository = TestBuilderRepository();
    recovery = TestRecoveryStore();
    controller = BuilderController(
      repository,
      recovery,
      builderProject,
      now: () => DateTime.utc(2026, 10, 4, 10, 30),
    );
  });
  tearDown(() {
    controller.dispose();
    repository.access.dispose();
  });

  test('inactive Builder starts no live read or effect', () async {
    controller.setActive(false);
    await controller.initialize();
    await controller.create();
    expect(repository.reads, 0);
    expect(repository.submissions, isEmpty);
  });
  test('unknown durable save reloads prepared intent without executing or enabling another action', () async {
    controller.dispose();
    recovery = _CommittedUnknownStore();
    controller = BuilderController(repository, recovery, builderProject);
    await controller.initialize();
    controller.editDraft('local work retained during reload');
    await controller.saveFile();
    final key = controller.outcome!.key;
    expect(controller.recoveryReady, isFalse);
    expect(repository.submissions, isEmpty);
    await controller.initialize();
    expect(controller.outcome!.key, key);
    expect(controller.uncertain, isTrue);
    expect(controller.draft, 'local work retained during reload');
    await controller.saveFile();
    expect(repository.submissions, isEmpty);
  });
  test('dirty source survives a fresh read of the original SHA', () async {
    await controller.initialize();
    controller.editDraft('private draft');
    await controller.refresh();
    expect(controller.draft, 'private draft');
    expect(controller.dirty, isTrue);
    expect(controller.selectedFile!.sha256, sha());
    expect(controller.fileMatchesSession, isTrue);
  });
  test(
    'changed SHA requires explicit current-source inspection before rebase',
    () async {
      await controller.initialize();
      controller.editDraft('private draft');
      repository.source = fileJson(
        content: 'someone changed source',
        hash: 'b',
      );
      await controller.refresh();
      await controller.saveFile();
      expect(controller.draft, 'private draft');
      expect(controller.fileMatchesSession, isFalse);
      expect(controller.conflictingFile!.sha256, sha('b'));
      expect(repository.submissions, isEmpty);
      await controller.resolveFileConflict(keepDraft: true);
      await controller.saveFile();
      expect(repository.submissions.single['expectedSha256'], sha('b'));
      expect(repository.submissions.single['content'], 'private draft');
    },
  );
  test('matching source in a replacement sandbox still requires explicit dirty rebind', () async {
    await controller.initialize();
    controller.editDraft('same content');
    repository.source = fileJson(content: 'same content', hash: 'b');
    final replacement = snapshotJson(empty: true)
      ..['session'] = sessionJson(id: buildId('session', 'b'));
    repository.data = replacement;
    await controller.refresh();
    expect(controller.conflictingFile, isNotNull);
    expect(controller.fileMatchesSession, isFalse);
    expect(controller.fileSessionId, buildId('session'));
  });
  test(
    'file update freezes exact targets and persists intent before dispatch',
    () async {
      await controller.initialize();
      controller.editDraft('submitted source');
      final prepared = Completer<void>(), releaseWrite = Completer<void>();
      recovery.beforeWrite = (value) async {
        if ((value['outcome'] as Map?)?['state'] == 'prepared') {
          if (!prepared.isCompleted) prepared.complete();
          await releaseWrite.future;
        }
      };
      final saving = controller.saveFile();
      await prepared.future;
      expect(repository.submissions, isEmpty);
      expect(controller.acting, isTrue);
      controller.editDraft('late replacement');
      expect(controller.draft, 'submitted source');
      releaseWrite.complete();
      await saving;
      expect(
        repository.submissions.single,
        containsPair('content', 'submitted source'),
      );
      expect(
        repository.submissions.single,
        containsPair('sessionId', buildId('session')),
      );
      expect(
        repository.submissions.single,
        containsPair('expectedSha256', sha()),
      );
      expect(
        () => repository.submissions.single['content'] = 'changed',
        throwsUnsupportedError,
      );
      expect(
        recovery.writes.any(
          (value) => (value['outcome'] as Map?)?['state'] == 'prepared',
        ),
        isTrue,
      );
    },
  );
  test('failed intent persistence blocks dispatch', () async {
    await controller.initialize();
    recovery.failWrite = true;
    await controller.command('lint');
    expect(repository.submissions, isEmpty);
    expect(controller.writable, isFalse);
    expect(controller.recoveryError, isNotNull);
  });
  test(
    'protected recovery failure still permits honest read inspection',
    () async {
      recovery.failRead = true;
      await controller.initialize();
      expect(controller.snapshot!.session!.id, buildId('session'));
      expect(controller.writable, isFalse);
      expect(controller.recoveryReady, isFalse);
      await controller.command('lint');
      expect(repository.submissions, isEmpty);
    },
  );
  test(
    'accepted response is independent from failed post-action refresh',
    () async {
      await controller.initialize();
      repository.mutation = (input, key) async {
        repository.snapshotReader = () =>
            Future.error(const ApiException('Read failed', statusCode: 503));
        return responseJson(input);
      };
      await controller.command('lint');
      expect(controller.outcome!.state, BuilderOutcomeState.accepted);
      expect(controller.outcome!.receipt, sha('e'));
      expect(controller.readError, contains('Read failed'));
      expect(controller.commandOutput, 'passed');
      expect(controller.writable, isFalse);
    },
  );
  test(
    'accepted response stays accepted when local receipt persistence fails',
    () async {
      await controller.initialize();
      repository.mutation = (input, key) async {
        recovery.failWrite = true;
        return responseJson(input);
      };
      await controller.command('lint');
      expect(controller.outcome!.state, BuilderOutcomeState.accepted);
      expect(controller.actionError, contains('accepted'));
      expect(controller.writable, isFalse);
    },
  );
  test('unknown effect is never replayed; only refreshed evidence enables a new explicit decision', () async {
    await controller.initialize();
    repository.mutation = (_, _) =>
        Future.error(const ApiException('Response lost'));
    await controller.command('build');
    final originalKey = controller.outcome!.key;
    expect(controller.uncertain, isTrue);
    expect(repository.submissions, hasLength(1));
    await controller.command('build');
    await controller.allowNewDecision();
    expect(controller.outcome!.key, originalKey);
    expect(repository.submissions, hasLength(1));
    await controller.refresh();
    expect(controller.outcomeReviewed, isTrue);
    expect(repository.submissions, hasLength(1));
    await controller.allowNewDecision();
    expect(controller.outcome, isNull);
    repository.mutation = null;
    await controller.command('lint');
    expect(repository.submissions, hasLength(2));
    expect(repository.keys.last, isNot(originalKey));
  });
  test('conflict remains uncertain while explicit admission rejection is retained separately', () async {
    await controller.initialize();
    repository.mutation = (_, _) =>
        Future.error(const ApiConflictException('Exact revision changed'));
    await controller.checkpoint();
    expect(controller.outcome!.state, BuilderOutcomeState.uncertain);
    await controller.refresh();
    await controller.allowNewDecision();
    repository.mutation = (_, _) =>
        Future.error(const ApiException('Not authorized', statusCode: 403));
    await controller.checkpoint();
    expect(controller.outcome!.state, BuilderOutcomeState.rejected);
  });
  test('activity or record order never retargets an exact selection', () async {
    await controller.initialize();
    controller.choose(deployment: buildId('deployment'));
    repository.data['deployments'] = [
      recordJson('deployment', char: 'b'),
      recordJson('deployment'),
    ];
    await controller.refresh();
    expect(controller.deploymentId, buildId('deployment'));
    repository.data['deployments'] = [recordJson('deployment', char: 'b')];
    await controller.refresh();
    expect(controller.deploymentId, buildId('deployment'));
    expect(controller.selectedDeployment, isNull);
    await controller.prepareRelease();
    expect(repository.submissions, isEmpty);
  });
  test(
    'selected verification never silently falls back to another passing record',
    () async {
      await controller.initialize();
      controller.choose(verification: buildId('verification', 'b'));
      expect(controller.deliveryVerification, isNull);
      await controller.deployPreview();
      expect(repository.submissions, isEmpty);
      controller.choose(verification: buildId('verification'));
      await controller.deployPreview();
      expect(
        repository.submissions.single['verificationId'],
        buildId('verification'),
      );
    },
  );
  test('production confirmation binds exact digest, selected preview and finite expiry', () async {
    await controller.initialize();
    controller.confirm('RELEASE');
    expect(controller.canRelease, isTrue);
    controller.choose(deployment: buildId('deployment', 'b'));
    expect(controller.confirmation, isEmpty);
    expect(controller.canRelease, isFalse);
    controller.choose(deployment: buildId('deployment'));
    controller.confirm('RELEASE');
    ((repository.data['releases'] as List).single as Map)['releaseDigest'] =
        sha('f');
    await controller.refresh();
    expect(controller.confirmation, isEmpty);
    expect(controller.canRelease, isFalse);
    controller.confirm('RELEASE');
    ((repository.data['releases'] as List).single as Map)['expiresAt'] =
        '2026-10-04T10:29:59.000Z';
    await controller.refresh();
    controller.confirm('RELEASE');
    expect(controller.canRelease, isFalse);
    await controller.releaseProduction();
    expect(repository.submissions, isEmpty);
  });
  test(
    'production submission preserves the reviewed full target and digest',
    () async {
      await controller.initialize();
      controller.confirm('RELEASE');
      await controller.releaseProduction();
      expect(repository.submissions.single, {
        'action': 'release.production',
        'sessionId': buildId('session'),
        'releaseId': buildId('release'),
        'releaseDigest': sha('d'),
        'confirmation': 'RELEASE',
      });
    },
  );
  test(
    'viewer, missing operation and direct invalidation block all effects',
    () async {
      await controller.initialize();
      repository.access.writeOperation = false;
      await controller.command('lint');
      expect(repository.submissions, isEmpty);
      repository.access.writeOperation = true;
      repository.current = false;
      await controller.command('lint');
      expect(repository.submissions, isEmpty);
      expect(controller.available, isFalse);
      repository.current = true;
      repository.access.update(
        testBuilderOwner(role: 'viewer'),
        available: true,
      );
      await controller.initialize();
      await controller.create();
      expect(controller.writable, isFalse);
      expect(repository.submissions, isEmpty);
    },
  );
  test('temporary same-owner loading hides but retains dirty drafts', () async {
    await controller.initialize();
    controller.editDraft('owner draft');
    repository.access.update(null, available: false);
    expect(controller.available, isFalse);
    expect(controller.draft, 'owner draft');
    repository.access.update(testBuilderOwner(), available: true);
    await controller.initialize();
    expect(controller.draft, 'owner draft');
  });
  test(
    'replacement canonical owner clears private state synchronously',
    () async {
      await controller.initialize();
      controller.editDraft('predecessor private');
      repository.current = false;
      repository.access.update(
        testBuilderOwner(user: builderOtherUser),
        available: true,
      );
      expect(controller.draft, isEmpty);
      expect(controller.snapshot, isNull);
      expect(controller.outcome, isNull);
      expect(controller.localRecoveryPending, isFalse);
    },
  );
  test('held response after suspension cannot overwrite current state and retains uncertain intent', () async {
    await controller.initialize();
    final received = Completer<void>(), response = Completer<BuilderJson>();
    repository.mutation = (input, key) {
      received.complete();
      return response.future;
    };
    final command = controller.command('lint');
    await received.future;
    controller.setActive(false);
    response.complete(responseJson(repository.submissions.single));
    await command;
    expect(controller.outcome!.state, BuilderOutcomeState.uncertain);
    expect(controller.commandOutput, isNull);
    final stored = await recovery.read(testBuilderOwner(), builderProject);
    expect((stored!['outcome'] as Map)['state'], 'prepared');
    final restored = BuilderController(repository, recovery, builderProject);
    addTearDown(restored.dispose);
    await restored.initialize();
    expect(restored.outcome!.state, BuilderOutcomeState.uncertain);
    expect(repository.submissions, hasLength(1));
  });
  test(
    'recovery excludes preview credentials and production confirmation',
    () async {
      await controller.initialize();
      controller.confirm('RELEASE');
      await controller.persist();
      final text = recovery.writes.last.toString();
      expect(text, isNot(contains('do-not-persist')));
      expect(text, isNot(contains('https://sandbox')));
      expect(recovery.writes.last.containsKey('confirmation'), isFalse);
    },
  );
  test('late file result is discarded after direct authority loss', () async {
    await controller.initialize();
    final held = Completer<BuilderFile>();
    repository.fileReader = (_) => held.future;
    final opening = controller.openFile('other.tsx');
    repository.current = false;
    held.complete(
      BuilderFile.parse(
        fileJson(path: 'other.tsx', content: 'private late body'),
        'other.tsx',
      ),
    );
    await opening;
    expect(controller.draft, isNot('private late body'));
    expect(controller.available, isFalse);
  });
}
