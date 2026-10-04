import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/responsibilities/responsibility_contracts.dart';
import 'package:asael/features/responsibilities/responsibility_controller.dart';
import 'package:asael/features/responsibilities/responsibility_providers.dart';
import 'package:asael/features/responsibilities/responsibility_recovery_store.dart';
import 'package:asael/features/responsibilities/responsibility_repository.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'responsibility_test_support.dart';

AppSession _session({
  String user = '11111111-1111-4111-8111-111111111111',
  String role = 'operator',
}) => AppSession(
  tenantId: 'tenant-a',
  actorId: 'owner@example.test',
  userId: user,
  email: 'owner@example.test',
  displayName: 'Owner',
  workspaceName: 'Work',
  role: role,
);

class _Sessions extends SessionController {
  @override
  Future<AppSession?> build() async => _session();
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

class _NoSessionEffects extends Fake implements SessionRepository {
  @override
  Future<bool> lockBiometricRelease() async => true;
  @override
  Future<void> unlockBiometricRelease() async {}
}

class _Recovery extends MemoryResponsibilityRecoveryStore {
  Future<void> Function(ResponsibilityJson)? beforeWrite;
  @override
  Future<void> write(
    ResponsibilityOwner owner,
    ResponsibilityJson value, {
    required bool Function() isCurrent,
  }) async {
    await beforeWrite?.call(value);
    await super.write(owner, value, isCurrent: isCurrent);
  }
}

class _Api extends ApiClient {
  _Api({String origin = 'https://example.test'})
    : super(
        Dio(BaseOptions(baseUrl: origin)),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  final tokens = <CancelToken>[], readPaths = <String>[];
  final writes = <String>[];
  NativeRequestAuthority? authority;
  String? key;
  Future<ResponsibilityJson> Function(String)? onRead;
  Completer<void>? beforePost;
  VoidCallback? onScopeRead;
  @override
  String get apiBaseUrl {
    final callback = onScopeRead;
    onScopeRead = null;
    callback?.call();
    return super.apiBaseUrl;
  }

  @override
  Future<ResponsibilityJson> getJsonFreshCancelable(
    String path, {
    ResponsibilityJson? query,
    ResponsibilityJson? headers,
    required CancelToken cancelToken,
  }) async {
    tokens.add(cancelToken);
    readPaths.add(path);
    if (onRead != null) return onRead!(path);
    final uri = Uri.parse(path), helper = TestResponsibilityRepository();
    final kind = uri.path.endsWith('/references')
        ? ResponsibilityRead.references
        : uri.path.endsWith('/lifecycle')
        ? ResponsibilityRead.runtime
        : uri.path.endsWith('/observations')
        ? ResponsibilityRead.observations
        : uri.path.endsWith('/notifications')
        ? ResponsibilityRead.notifications
        : uri.pathSegments.length == 2
        ? ResponsibilityRead.list
        : ResponsibilityRead.detail;
    final id =
        uri.pathSegments.length >= 3 && kind != ResponsibilityRead.references
        ? uri.pathSegments[2]
        : null;
    return helper.defaultRead(kind, id);
  }

  @override
  Future<ResponsibilityJson> postJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    ResponsibilityJson? data,
    ResponsibilityJson? headers,
  }) async {
    authority.requireCurrent(apiBaseUrl);
    this.authority = authority;
    key = headers!['idempotency-key'] as String;
    await beforePost?.future;
    authority.requireCurrent(apiBaseUrl);
    writes.add(path);
    return draftResult(data!, key!);
  }

  @override
  Future<ResponsibilityJson> patchJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    ResponsibilityJson? data,
    ResponsibilityJson? headers,
  }) async {
    authority.requireCurrent(apiBaseUrl);
    this.authority = authority;
    key = headers!['idempotency-key'] as String;
    writes.add(path);
    return draftResult(data!, key!, id: Uri.parse(path).pathSegments.last);
  }

  @override
  Future<ResponsibilityJson> postJson(
    String path, {
    ResponsibilityJson? data,
    ResponsibilityJson? headers,
  }) => throw StateError('Unscoped write is forbidden.');
  @override
  Future<ResponsibilityJson> patchJson(
    String path, {
    ResponsibilityJson? data,
    ResponsibilityJson? headers,
  }) => throw StateError('Unscoped write is forbidden.');
}

class _Harness {
  late ProviderContainer container;
  late _Sessions sessions;
  late ResponsibilityController controller;
  _Api api = _Api();
  final recovery = _Recovery();
  static Future<_Harness> create() async {
    final harness = _Harness();
    harness.container = ProviderContainer(
      overrides: [
        sessionControllerProvider.overrideWith(
          () => harness.sessions = _Sessions(),
        ),
        apiClientProvider.overrideWith((ref) => harness.api),
        responsibilityRecoveryStoreProvider.overrideWithValue(harness.recovery),
        biometricSessionLockControllerProvider.overrideWith(
          (ref) => BiometricSessionLockController(_NoSessionEffects()),
        ),
        reconnectCoordinatorProvider.overrideWithValue(
          ReconnectCoordinator(() async => const [], const Stream.empty()),
        ),
      ],
    );
    await harness.container.read(sessionControllerProvider.future);
    harness.container.listen(responsibilityControllerProvider, (_, _) {});
    harness.controller = harness.container.read(
      responsibilityControllerProvider,
    );
    await harness.controller.initialize();
    return harness;
  }
}

void main() {
  setUp(() {
    final previous = FlutterError.onError, errors = <FlutterErrorDetails>[];
    FlutterError.onError = errors.add;
    addTearDown(() {
      FlutterError.onError = previous;
      expect(
        errors,
        isEmpty,
        reason: 'Responsibility provider invalidation must not publish while Riverpod disposes the outgoing tree.',
      );
    });
  });
  test(
    'synchronous probe invalidation dispatches no outgoing Responsibility read',
    () async {
      final harness = await _Harness.create();
      addTearDown(harness.container.dispose);
      final repository = harness.container.read(
        responsibilityRepositoryProvider,
      );
      final reads = harness.api.readPaths.length;
      harness.api.onScopeRead = () =>
          harness.container.invalidate(responsibilityRepositoryProvider);
      await expectLater(
        repository.read(ResponsibilityRead.list, CancelToken()),
        throwsFormatException,
      );
      expect(repository.access.closed, isTrue);
      expect(repository.authorityCurrent(), isFalse);
      expect(harness.api.readPaths.length, reads);
      expect(harness.api.writes, isEmpty);
    },
  );
  for (final disposeRepository in [false, true]) {
    test(
      'a successful probe cannot admit Responsibility data after ${disposeRepository ? 'repository disposal' : 'access closure'}',
      () async {
        final api = _Api(),
            access = ResponsibilityAccess(owner: testOwner, ready: true);
        late final ApiResponsibilityRepository repository;
        repository = ApiResponsibilityRepository(
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
          repository.read(ResponsibilityRead.list, CancelToken()),
          throwsFormatException,
        );
        expect(api.readPaths, isEmpty);
        expect(api.writes, isEmpty);
      },
    );
  }
  test('API replacement cancels an old read without a pump and clears private fields', () async {
    final harness = await _Harness.create();
    addTearDown(harness.container.dispose);
    final old = harness.controller,
        api = harness.api,
        held = Completer<ResponsibilityJson>();
    old.edit(fullDraft);
    api.onRead = (_) => held.future;
    final reading = old.refresh();
    harness.api = _Api(origin: 'https://other.test');
    harness.container.invalidate(apiClientProvider);
    held.complete({
      ...draftEnvelope,
      'records': <Object?>[],
      'hasMore': false,
      'coverage': {
        'kind': 'bounded_recent',
        'limit': 40,
        'returned': 0,
        'total': null,
      },
    });
    await reading;
    expect(old.available, isFalse);
    expect(old.draft['purpose'], '');
    expect(api.tokens.last.isCancelled, isTrue);
    final next = harness.container.read(responsibilityControllerProvider);
    expect(next.repository.access.owner!.apiBaseUrl, 'https://other.test');
  });
  test(
    'provider disposal silently fences delayed callbacks and cancels reads',
    () async {
      final harness = await _Harness.create(),
          held = Completer<ResponsibilityJson>();
      final old = harness.controller;
      old.edit(fullDraft);
      harness.api.onRead = (_) => held.future;
      final reading = old.refresh();
      harness.container.dispose();
      held.complete({
        ...draftEnvelope,
        'records': <Object?>[],
        'hasMore': false,
        'coverage': {
          'kind': 'bounded_recent',
          'limit': 40,
          'returned': 0,
          'total': null,
        },
      });
      await reading;
      expect(old.available, isFalse);
      expect(old.draft['purpose'], '');
      expect(old.accepted, isEmpty);
      expect(harness.api.tokens.last.isCancelled, isTrue);
      await old.initialize();
      expect(old.available, isFalse);
    },
  );
  test('same-email canonical account replacement cannot retain previous private draft', () async {
    final harness = await _Harness.create();
    addTearDown(harness.container.dispose);
    harness.controller.edit(fullDraft);
    harness.sessions.replace(
      _session(user: '22222222-2222-4222-8222-222222222222'),
    );
    expect(harness.controller.draft['purpose'], '');
    expect(harness.controller.record, isNull);
    await harness.controller.initialize();
    expect(
      harness.controller.repository.access.owner!.userId,
      '22222222-2222-4222-8222-222222222222',
    );
  });
  test(
    'loading and failed session revoke the immediate callback authority',
    () async {
      final harness = await _Harness.create();
      addTearDown(harness.container.dispose);
      harness.controller.edit(fullDraft);
      harness.sessions.loading();
      await harness.controller.saveDraft();
      expect(harness.api.writes, isEmpty);
      expect(harness.controller.available, isFalse);
      harness.sessions.failed();
      expect(harness.controller.available, isFalse);
      harness.sessions.replace(null);
      expect(harness.controller.listing, isNull);
    },
  );
  test(
    'biometric lock cancels current reads and fences controls before unlock',
    () async {
      final harness = await _Harness.create();
      addTearDown(harness.container.dispose);
      harness.controller.edit(fullDraft);
      final lock = harness.container.read(
        biometricSessionLockControllerProvider,
      );
      await lock.lock();
      expect(harness.controller.available, isFalse);
      expect(harness.controller.draft['purpose'], '');
      await harness.controller.saveDraft();
      expect(harness.api.writes, isEmpty);
      await lock.unlock();
      await harness.controller.initialize();
      expect(harness.controller.available, isTrue);
    },
  );
  test(
    'role replacement during protected preparation dispatches no request',
    () async {
      final harness = await _Harness.create();
      addTearDown(harness.container.dispose);
      final admitted = Completer<void>(), release = Completer<void>();
      harness.recovery.beforeWrite = (value) async {
        if (value['pending'] != null) {
          admitted.complete();
          await release.future;
        }
      };
      harness.controller.edit(fullDraft);
      final change = harness.controller.saveDraft();
      await admitted.future;
      harness.sessions.replace(_session(role: 'viewer'));
      release.complete();
      await change;
      expect(harness.api.writes, isEmpty);
      expect(harness.controller.canManage, isFalse);
    },
  );
  test('originating controller replacement fences a pending credential check even with the same repository', () async {
    final harness = await _Harness.create();
    addTearDown(harness.container.dispose);
    harness.api.beforePost = Completer<void>();
    harness.controller.edit(fullDraft);
    final change = harness.controller.saveDraft();
    while (harness.api.authority == null) {
      await Future<void>.delayed(Duration.zero);
    }
    final old = harness.controller;
    harness.container.invalidate(responsibilityControllerProvider);
    final replacement = harness.container.read(
      responsibilityControllerProvider,
    );
    expect(identical(replacement, old), isFalse);
    expect(old.available, isFalse);
    expect(harness.api.authority!.isCurrent(), isFalse);
    harness.api.beforePost!.complete();
    await change;
    expect(harness.api.writes, isEmpty);
  });
  test('repository uses exact encoded PATCH path and immutable request actor authority', () async {
    final api = _Api(),
        access = ResponsibilityAccess(owner: testOwner, ready: true);
    final repository = ApiResponsibilityRepository(
      api,
      access: access,
      authorityProbe: () => true,
    );
    addTearDown(repository.dispose);
    addTearDown(access.dispose);
    final body = {
      'action': 'update',
      'expectedRevision': 1,
      'draft': fullDraft,
    };
    await repository.mutate(
      ResponsibilityLane.draft,
      body,
      'frozen-key',
      id: testId,
    );
    expect(api.writes.single, NativePaths.responsibilitiesChange(testId));
    expect(api.key, 'frozen-key');
    expect(api.authority!.canonicalUserId, testOwner.userId);
    expect(api.authority!.actorId, testOwner.requestActorId);
    expect(api.authority!.role, 'operator');
    access.update(
      const ResponsibilityOwner(
        userId: '11111111-1111-4111-8111-111111111111',
        tenantId: 'tenant-a',
        requestActorId: 'owner@example.test',
        role: 'viewer',
        apiBaseUrl: 'https://example.test',
      ),
      available: true,
    );
    expect(api.authority!.isCurrent(), isFalse);
  });
}
