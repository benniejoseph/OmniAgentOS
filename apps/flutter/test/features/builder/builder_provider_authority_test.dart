import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/builder/builder_contracts.dart';
import 'package:asael/features/builder/builder_controller.dart';
import 'package:asael/features/builder/builder_providers.dart';
import 'package:asael/features/builder/builder_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'builder_api_test_support.dart';
import 'builder_test_support.dart';

void main() {
  setUp(() {
    final previous = FlutterError.onError;
    final errors = <FlutterErrorDetails>[];
    FlutterError.onError = errors.add;
    addTearDown(() {
      FlutterError.onError = previous;
      expect(
        errors,
        isEmpty,
        reason: 'Builder provider replacement/disposal must not publish lifecycle errors.',
      );
    });
  });
  test(
    'synchronous probe invalidation dispatches no outgoing Builder read',
    () async {
      final harness = await _Harness.create();
      addTearDown(harness.container.dispose);
      final repository = harness.container.read(
        builderRepositoryProvider(builderProject),
      );
      final api = harness.api as _ProbeApi;
      final reads = api.reads.length;
      api.onScopeRead = () => harness.container.invalidate(
        builderRepositoryProvider(builderProject),
      );
      await expectLater(
        repository.snapshot(builderProject, CancelToken()),
        throwsStateError,
      );
      expect(repository.access.closed, isTrue);
      expect(repository.authorityCurrent(), isFalse);
      expect(api.reads.length, reads);
      expect(api.posted, isNull);
    },
  );
  for (final disposeRepository in [false, true]) {
    test(
      'a successful probe cannot admit Builder data after ${disposeRepository ? 'repository disposal' : 'access closure'}',
      () async {
        final api = BuilderTestApi(),
            access = BuilderAccess(owner: testBuilderOwner(), ready: true);
        late final ApiBuilderRepository repository;
        repository = ApiBuilderRepository(
          api,
          access: access,
          authorityProbe: () {
            if (disposeRepository) {
              repository.dispose();
            } else {
              access.close(notify: false);
            }
            return true;
          },
        );
        addTearDown(() {
          repository.dispose();
          access.dispose();
        });
        expect(repository.authorityCurrent(), isFalse);
        await expectLater(
          repository.snapshot(builderProject, CancelToken()),
          throwsStateError,
        );
        expect(api.reads, isEmpty);
        expect(api.posted, isNull);
      },
    );
  }
  test('API replacement invalidates a held read without any container or widget pump', () async {
    final harness = await _Harness.create();
    addTearDown(harness.container.dispose);
    final old = harness.controller;
    final held = Completer<BuilderJson>();
    harness.api.read = (_, _, _) => held.future;
    final read = old.refresh();
    harness.replaceApi('https://replacement.example.test');
    held.complete(snapshotJson());
    await read;
    expect(old.available, isFalse);
    expect(old.snapshot, isNull);
    expect(harness.oldApi.tokens.last.isCancelled, isTrue);
    final next = harness.container.read(
      builderControllerProvider(builderProject),
    );
    expect(next.access.owner!.apiScope, 'https://replacement.example.test');
    expect(next.active, isFalse);
  });
  test(
    'disposing the provider fences and clears a held read without publishing',
    () async {
      final harness = await _Harness.create();
      final old = harness.controller;
      old.editDraft('outgoing private draft');
      final held = Completer<BuilderJson>();
      harness.api.read = (_, _, _) => held.future;
      final read = old.refresh();
      harness.container.dispose();
      held.complete(snapshotJson());
      await read;
      expect(old.available, isFalse);
      expect(old.snapshot, isNull);
      expect(old.draft, isEmpty);
      expect(harness.api.tokens.last.isCancelled, isTrue);
      old.setActive(true);
      await old.initialize();
      expect(old.available, isFalse);
    },
  );
  test(
    'same-email recreated canonical account clears private drafts immediately',
    () async {
      final harness = await _Harness.create();
      addTearDown(harness.container.dispose);
      final old = harness.controller;
      old.editDraft('private predecessor');
      await old.persist();
      harness.sessions.replace(builderSession(user: builderOtherUser));
      expect(old.draft, isEmpty);
      expect(old.snapshot, isNull);
      await old.initialize();
      expect(old.access.owner!.userId, builderOtherUser);
      expect(old.draft, isNot('private predecessor'));
    },
  );
  test(
    'loading, error and signed-out states synchronously block authority',
    () async {
      final harness = await _Harness.create();
      addTearDown(harness.container.dispose);
      final controller = harness.controller;
      controller.editDraft('same owner draft');
      harness.sessions.loading();
      expect(controller.available, isFalse);
      expect(controller.draft, 'same owner draft');
      harness.sessions.failed();
      expect(controller.available, isFalse);
      harness.sessions.replace(null);
      expect(controller.snapshot, isNull);
      expect(controller.draft, isEmpty);
    },
  );
  test('role change during durable preparation dispatches no request with another membership', () async {
    final harness = await _Harness.create();
    addTearDown(harness.container.dispose);
    final prepared = Completer<void>(), release = Completer<void>();
    harness.recovery.beforeWrite = (value) async {
      if ((value['outcome'] as Map?)?['state'] == 'prepared') {
        prepared.complete();
        await release.future;
      }
    };
    final command = harness.controller.command('lint');
    await prepared.future;
    harness.sessions.replace(builderSession(role: 'viewer'));
    release.complete();
    await command;
    expect(harness.api.posted, isNull);
    expect(harness.controller.access.writable, isFalse);
  });
  test('API replacement during a prepared journal prevents dispatch before the next pump', () async {
    final harness = await _Harness.create();
    addTearDown(harness.container.dispose);
    final prepared = Completer<void>(), release = Completer<void>();
    harness.recovery.beforeWrite = (value) async {
      if ((value['outcome'] as Map?)?['state'] == 'prepared') {
        prepared.complete();
        await release.future;
      }
    };
    final command = harness.controller.command('lint');
    await prepared.future;
    harness.replaceApi('https://replacement.example.test');
    release.complete();
    await command;
    expect(harness.oldApi.posted, isNull);
    expect(harness.api.posted, isNull);
    expect(harness.controller.available, isFalse);
  });
}

class _Sessions extends SessionController {
  @override
  Future<AppSession?> build() async => builderSession();
  void replace(AppSession? value) {
    state = AsyncData(value);
  }

  void loading() {
    state = const AsyncLoading();
  }

  void failed() {
    state = AsyncError(StateError('Session unavailable'), StackTrace.current);
  }
}

class _NoSessionEffects extends Fake implements SessionRepository {}

class _ProbeApi extends BuilderTestApi {
  VoidCallback? onScopeRead;
  @override
  String get apiBaseUrl {
    final callback = onScopeRead;
    onScopeRead = null;
    callback?.call();
    return super.apiBaseUrl;
  }
}

class _Harness {
  late ProviderContainer container;
  late _Sessions sessions;
  late BuilderController controller;
  final recovery = TestRecoveryStore();
  BuilderTestApi api = _ProbeApi(), oldApi = BuilderTestApi();
  void configure() {
    api.read = (_, query, _) async => switch (query?['view']) {
      'tree' => {
        'session': sessionJson(),
        'entries': [
          {'path': 'app/page.tsx', 'kind': 'file', 'size': 25},
        ],
      },
      'file' => {'file': fileJson()},
      _ => snapshotJson(),
    };
  }

  static Future<_Harness> create() async {
    final value = _Harness()..configure();
    value.container = ProviderContainer(
      overrides: [
        sessionControllerProvider.overrideWith(
          () => value.sessions = _Sessions(),
        ),
        apiClientProvider.overrideWith((ref) => value.api),
        builderRecoveryStoreProvider.overrideWithValue(value.recovery),
        biometricSessionLockControllerProvider.overrideWith(
          (ref) => BiometricSessionLockController(_NoSessionEffects()),
        ),
        reconnectCoordinatorProvider.overrideWithValue(
          ReconnectCoordinator(() async => const [], const Stream.empty()),
        ),
      ],
    );
    await value.container.read(sessionControllerProvider.future);
    value.container.listen(
      builderControllerProvider(builderProject),
      (_, _) {},
    );
    value.controller = value.container.read(
      builderControllerProvider(builderProject),
    );
    value.controller.setActive(true);
    await value.controller.initialize();
    return value;
  }

  void replaceApi(String origin) {
    oldApi = api;
    api = BuilderTestApi(origin: origin);
    configure();
    container.invalidate(apiClientProvider);
  }
}
