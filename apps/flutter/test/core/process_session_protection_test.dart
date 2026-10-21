import 'dart:async';

import 'package:asael/core/auth/biometric_gate.dart';
import 'package:asael/core/storage/process_session_protection.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:flutter_test/flutter_test.dart';

class _Memory extends Fake implements AsaelSecureValueStore {
  final values = <String, String>{'asael.biometric_enabled': 'true'};
  @override
  Future<String?> read({required String key}) async => values[key];
  @override
  Future<void> write({required String key, required String value}) async {
    values[key] = value;
  }

  @override
  Future<void> delete({required String key}) async {
    values.remove(key);
  }
}

class _Process implements ProcessSessionProtection {
  var value = const ProcessSessionSnapshot(
    epoch: 0,
    sessionEpoch: 0,
    biometricEnabled: false,
    scope: null,
    locked: false,
    ended: false,
  );
  final events = StreamController<ProcessSessionSnapshot>.broadcast(sync: true);
  @override
  Stream<ProcessSessionSnapshot> get changes => events.stream;
  @override
  Future<ProcessSessionSnapshot> snapshot() async => value;
  @override
  Future<ProcessSessionSnapshot> change(
    String action,
    ProcessSessionSnapshot expected, {
    String? scope,
    bool? biometricEnabled,
  }) async {
    if (expected.epoch != value.epoch || expected.scope != value.scope)
      throw StateError('stale');
    if (value.ended && (action == 'unlock' || action == 'bind'))
      throw StateError('ended');
    value = ProcessSessionSnapshot(
      epoch: value.epoch + 1,
      sessionEpoch:
          value.sessionEpoch + (action == 'replace' || action == 'end' ? 1 : 0),
      scope: action == 'replace' ? null : scope ?? value.scope,
      biometricEnabled: action == 'replace'
          ? false
          : biometricEnabled ?? value.biometricEnabled,
      locked: action == 'lock' || action == 'end'
          ? true
          : action == 'unlock' || action == 'replace'
          ? false
          : value.locked,
      ended: action == 'end',
    );
    events.add(value);
    return value;
  }
}

class _SessionEffects extends Fake implements SessionRepository {
  late BiometricSessionLockController controller;
  @override
  Future<bool> lockBiometricRelease() async {
    controller.applyProcessLock(true);
    return true;
  }

  @override
  Future<void> unlockBiometricRelease() async {
    controller.applyProcessLock(false);
  }
}

void main() {
  Future<void> bind(SecureSessionStore store) => store.bindProcessOwner(
    apiOrigin: 'https://example.test',
    tenantId: 'tenant',
    actorId: 'actor',
  );
  test(
    'process lock invalidates two engines and a newly created engine',
    () async {
      final process = _Process(), disk = _Memory();
      final first = SecureSessionStore.withStorage(
        disk,
        processProtection: process,
      );
      final second = SecureSessionStore.withStorage(
        disk,
        processProtection: process,
      );
      addTearDown(() async {
        await first.dispose();
        await second.dispose();
        await process.events.close();
      });
      await first.writeToken('synthetic-token');
      await bind(first);
      await bind(second);
      first.unlockBiometricRelease();
      second.unlockBiometricRelease();
      expect(await first.readToken(), 'synthetic-token');
      expect(await second.readToken(), 'synthetic-token');
      await first.lockProcessProtection();
      await expectLater(
        second.readToken(),
        throwsA(isA<BiometricGateException>()),
      );
      final fresh = SecureSessionStore.withStorage(
        disk,
        processProtection: process,
      );
      addTearDown(fresh.dispose);
      fresh.unlockBiometricRelease();
      await expectLater(
        fresh.readToken(),
        throwsA(isA<BiometricGateException>()),
      );
      await second.unlockProcessProtection(
        await second.processProtectionSnapshot(),
      );
      expect(await first.readToken(), 'synthetic-token');
      expect(await second.readToken(), 'synthetic-token');
    },
  );
  test('logout invalidates sibling cache; stale same-owner engine cannot erase replacement', () async {
    final process = _Process(), disk = _Memory();
    final first = SecureSessionStore.withStorage(
      disk,
      processProtection: process,
    );
    final second = SecureSessionStore.withStorage(
      disk,
      processProtection: process,
    );
    addTearDown(() async {
      await first.dispose();
      await second.dispose();
      await process.events.close();
    });
    await first.writeToken('old');
    await bind(first);
    await bind(second);
    first.unlockBiometricRelease();
    second.unlockBiometricRelease();
    expect(await second.readToken(), 'old');
    await first.clear();
    await expectLater(
      second.readToken(),
      throwsA(
        anyOf(
          isA<BiometricGateException>(),
          isA<SecureStoreUnavailableException>(),
        ),
      ),
    );
    await first.beginSessionReplacement();
    await first.writeToken('new');
    await bind(first);
    first.unlockBiometricRelease();
    await expectLater(
      second.clear(),
      throwsA(isA<SecureStoreUnavailableException>()),
    );
    await expectLater(
      second.writeToken('stale'),
      throwsA(isA<SecureStoreUnavailableException>()),
    );
    expect(await first.readToken(), 'new');
  });
  test(
    'biometric result taken before another lock cannot unlock the later lock',
    () async {
      final process = _Process(),
          store = SecureSessionStore.withStorage(
            _Memory(),
            processProtection: process,
          );
      addTearDown(() async {
        await store.dispose();
        await process.events.close();
      });
      await bind(store);
      final ticket = await store.processProtectionSnapshot();
      await store.lockProcessProtection();
      await expectLater(
        store.unlockProcessProtection(ticket),
        throwsStateError,
      );
      expect(process.value.locked, true);
    },
  );
  test(
    'bootstrap reads pin the incarnation before the actor has been bound',
    () async {
      final process = _Process(), disk = _Memory();
      final bootstrap = SecureSessionStore.withStorage(
        disk,
        processProtection: process,
      );
      final login = SecureSessionStore.withStorage(
        disk,
        processProtection: process,
      );
      addTearDown(() async {
        await bootstrap.dispose();
        await login.dispose();
        await process.events.close();
      });
      await bootstrap.writeToken('old');
      bootstrap.unlockBiometricRelease();
      expect(await bootstrap.readToken(), 'old');
      await login.beginSessionReplacement();
      await login.writeToken('new');
      await bind(login);
      login.unlockBiometricRelease();
      await expectLater(
        bind(bootstrap),
        throwsA(isA<SecureStoreUnavailableException>()),
      );
      expect(await login.readToken(), 'new');
    },
  );

  test('wiped sibling can prepare an explicit login without reopening old credentials', () async {
    final process = _Process(), disk = _Memory();
    final first = SecureSessionStore.withStorage(
      disk,
      processProtection: process,
    );
    final peer = SecureSessionStore.withStorage(
      disk,
      processProtection: process,
    );
    addTearDown(() async {
      await first.dispose();
      await peer.dispose();
      await process.events.close();
    });
    await first.writeToken('old');
    await bind(first);
    await bind(peer);
    final oldDevice = await peer.readOrCreateDeviceId();
    expect(await peer.readBiometricEnabled(), true);
    await first.clearForRemoteWipe();
    final newDevice = await peer.readOrCreateDeviceIdForSignIn();
    expect(newDevice, isNot(oldDevice));
    await expectLater(
      peer.readToken(),
      throwsA(isA<SecureStoreUnavailableException>()),
    );
    await peer.beginSessionReplacement();
    await peer.writeToken('new');
    await bind(peer);
    expect(await peer.readBiometricEnabled(), false);
    expect(await peer.readToken(), 'new');
  });

  test('native echoes of own lock and unlock do not cancel the initiating transition', () async {
    final sessions = _SessionEffects();
    final controller = BiometricSessionLockController(sessions);
    sessions.controller = controller;
    addTearDown(controller.dispose);
    expect(await controller.lock(), true);
    expect(controller.state.blocksInteraction, true);
    expect(await controller.unlock(), true);
    expect(controller.state.blocksInteraction, false);
  });
  test(
    'session snapshot requires an explicit valid incarnation and lock flags',
    () {
      final value = <String, Object?>{
        'schemaVersion': 1,
        'epoch': 1,
        'sessionEpoch': 2,
        'scope': null,
        'locked': false,
        'ended': false,
        'biometricEnabled': true,
      };
      expect(ProcessSessionSnapshot.parse(value).sessionEpoch, 2);
      expect(
        () => ProcessSessionSnapshot.parse({...value, 'sessionEpoch': -1}),
        throwsFormatException,
      );
      expect(
        () => ProcessSessionSnapshot.parse({...value, 'locked': 1}),
        throwsFormatException,
      );
    },
  );
}
