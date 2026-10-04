import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_controller.dart';
import 'package:asael/features/customers/accounts_providers.dart';
import 'package:asael/features/customers/accounts_repository.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_test_support.dart';

void main() {
  setUp(() {
    final old = FlutterError.onError, errors = <FlutterErrorDetails>[];
    FlutterError.onError = errors.add;
    addTearDown(() {
      FlutterError.onError = old;
      expect(
        errors,
        isEmpty,
        reason: 'Provider disposal must not publish through a disposed Ref.',
      );
    });
  });
  test(
    'synchronous probe invalidation dispatches no outgoing account read',
    () async {
      final harness = await _Harness.create();
      addTearDown(harness.container.dispose);
      final repository = harness.container.read(accountsRepositoryProvider);
      final api = harness.api as _ProbeApi;
      final reads = api.paths.length;
      api.onScopeRead = () =>
          harness.container.invalidate(accountsRepositoryProvider);
      await expectLater(repository.list(CancelToken()), throwsFormatException);
      expect(repository.access.closed, isTrue);
      expect(repository.authorityCurrent(), isFalse);
      expect(api.paths.length, reads);
      expect(api.mutations, 0);
    },
  );
  for (final disposeRepository in [false, true]) {
    test(
      'a successful probe cannot admit account data after ${disposeRepository ? 'repository disposal' : 'access closure'}',
      () async {
        final api = _ProbeApi(),
            access = AccountsAccess(owner: accountOwner(), ready: true);
        late final ApiAccountsRepository repository;
        repository = ApiAccountsRepository(
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
          repository.list(CancelToken()),
          throwsFormatException,
        );
        expect(api.paths, isEmpty);
        expect(api.mutations, 0);
      },
    );
  }
  test(
    'replacement API synchronously cancels pending reads and clears old data',
    () async {
      final harness = await _Harness.create();
      addTearDown(harness.container.dispose);
      final old = harness.controller,
          outgoing = harness.api,
          held = Completer<AccountJson>(),
          started = Completer<void>();
      outgoing.read = (_, _, _) {
        if (!started.isCompleted) {
          started.complete();
        }
        return held.future;
      };
      final refresh = old.refreshCore();
      await started.future;
      harness.api = AccountsTestApi(origin: 'https://replacement.example.test');
      harness.container.invalidate(apiClientProvider);
      expect(old.readable, isFalse);
      held.complete(await accountListResponse());
      await refresh;
      expect(old.overview.value, isNull);
      expect(outgoing.tokens.last.isCancelled, isTrue);
      final next = harness.container.read(accountsControllerProvider(null));
      expect(next.active, isFalse);
      expect(
        next.repository.access.owner!.apiScope,
        'https://replacement.example.test',
      );
    },
  );
  test('loading, error, same-email new canonical user and sign-out erase snapshots', () async {
    final harness = await _Harness.create();
    addTearDown(harness.container.dispose);
    expect(harness.controller.overview.value, isNotNull);
    harness.sessions.loading();
    expect(harness.controller.readable, isFalse);
    expect(harness.controller.overview.value, isNull);
    harness.sessions.failed();
    expect(harness.controller.readable, isFalse);
    harness.sessions.replace(accountSession(user: accountOtherUser));
    expect(
      harness.controller.repository.access.owner!.userId,
      accountOtherUser,
    );
    expect(harness.controller.overview.value, isNull);
    harness.sessions.replace(null);
    expect(harness.controller.readable, isFalse);
  });
  test(
    'provider disposal suppresses late result without lifecycle errors',
    () async {
      final harness = await _Harness.create(),
          held = Completer<AccountJson>(),
          started = Completer<void>();
      harness.api.read = (_, _, _) {
        if (!started.isCompleted) {
          started.complete();
        }
        return held.future;
      };
      final controller = harness.controller, refresh = controller.refreshCore();
      await started.future;
      harness.container.dispose();
      held.complete(await accountListResponse());
      await refresh;
      expect(controller.readable, isFalse);
      expect(controller.overview.value, isNull);
      expect(harness.api.tokens.last.isCancelled, isTrue);
    },
  );
  test('fresh bootstrap mismatch dispatches no private domain read', () async {
    final api = AccountsTestApi()
          ..session = accountSession(user: accountOtherUser),
        access = AccountsAccess(owner: accountOwner(), ready: true);
    final repository = ApiAccountsRepository(
      api,
      access: access,
      authorityProbe: () => true,
    );
    addTearDown(repository.dispose);
    await expectLater(repository.list(CancelToken()), throwsFormatException);
    expect(api.paths, [NativePaths.bootstrapGet]);
  });
  test(
    'live bootstrap identity change erases a previously verified snapshot',
    () async {
      final harness = await _Harness.create();
      addTearDown(harness.container.dispose);
      expect(harness.controller.overview.value, isNotNull);
      harness.api.session = accountSession(user: accountOtherUser);
      await harness.controller.refreshCore();
      expect(harness.controller.readable, isFalse);
      expect(harness.controller.overview.value, isNull);
      expect(harness.controller.intelligence.value, isNull);
    },
  );
  test(
    'published-operation absence dispatches neither bootstrap nor data read',
    () async {
      final api = AccountsTestApi(),
          access = AccountsAccess(
            owner: accountOwner(),
            ready: true,
            operations: const {},
          );
      final repository = ApiAccountsRepository(
        api,
        access: access,
        authorityProbe: () => true,
      );
      addTearDown(repository.dispose);
      await expectLater(repository.list(CancelToken()), throwsFormatException);
      expect(api.paths, isEmpty);
    },
  );
  test(
    'read uses exact encoded identity and fresh bounded operations only',
    () async {
      final api = AccountsTestApi(),
          access = AccountsAccess(owner: accountOwner(), ready: true);
      final repository = ApiAccountsRepository(
        api,
        access: access,
        authorityProbe: () => true,
      );
      addTearDown(repository.dispose);
      await repository.detail(customerId, CancelToken());
      await repository.list(CancelToken());
      expect(
        api.paths,
        contains('/api/customer-accounts/${Uri.encodeComponent(customerId)}'),
      );
      expect(api.queries.last, {'limit': 200});
    },
  );
}

class _Sessions extends SessionController {
  @override
  Future<AppSession?> build() async => accountSession();
  void replace(AppSession? value) {
    state = AsyncData(value);
  }

  void loading() {
    state = const AsyncLoading();
  }

  void failed() {
    state = AsyncError(StateError('Unavailable'), StackTrace.current);
  }
}

class _NoSessionEffects extends Fake implements SessionRepository {}

class _ProbeApi extends AccountsTestApi {
  VoidCallback? onScopeRead;
  int mutations = 0;
  @override
  String get apiBaseUrl {
    final callback = onScopeRead;
    onScopeRead = null;
    callback?.call();
    return super.apiBaseUrl;
  }

  @override
  Future<AccountJson> postJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    AccountJson? data,
    AccountJson? headers,
  }) async {
    mutations++;
    throw StateError('Authority checks must not mutate.');
  }

  @override
  Future<AccountJson> patchJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    AccountJson? data,
    AccountJson? headers,
  }) async {
    mutations++;
    throw StateError('Authority checks must not mutate.');
  }
}

class _Harness {
  late ProviderContainer container;
  late _Sessions sessions;
  late AccountsController controller;
  AccountsTestApi api = _ProbeApi();
  static Future<_Harness> create() async {
    final value = _Harness();
    value.container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWith((ref) => value.api),
        sessionControllerProvider.overrideWith(
          () => value.sessions = _Sessions(),
        ),
        biometricSessionLockControllerProvider.overrideWith(
          (ref) => BiometricSessionLockController(_NoSessionEffects()),
        ),
      ],
    );
    await value.container.read(sessionControllerProvider.future);
    value.container.listen(accountsControllerProvider(null), (_, _) {});
    value.controller = value.container.read(accountsControllerProvider(null));
    value.controller.setActive(true);
    await value.controller.initialize();
    return value;
  }
}
