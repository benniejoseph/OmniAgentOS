import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/network/native_workspace_access.dart';
import 'package:asael/features/agents/specialist_api_client.dart';
import 'package:asael/features/agents/specialist_recovery_store.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/integrations/connector_contracts.dart';
import 'package:asael/features/integrations/connector_control_contracts.dart';
import 'package:asael/features/integrations/connector_controller.dart';
import 'package:asael/features/integrations/connector_providers.dart';
import 'package:asael/features/integrations/connector_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'connector_fixtures.dart';

Future<ConnectorController> _ready(
  ConnectorFixtureRepository repository,
  ConnectorFixtureStore store,
) async {
  final controller = ConnectorController(repository, store);
  await controller.initialize();
  await controller.select('mcp', 'mcp:one');
  return controller;
}

void main() {
  test(
    'exact review rejects raw query credentials and a different target',
    () async {
      await expectLater(
        connectorReviewFixture(
          endpoint: 'https://tools.example.test/mcp?token=private',
        ),
        throwsFormatException,
      );
      final review = await connectorReviewFixture();
      await expectLater(
        ConnectorReview.parse(review.raw, connectorOwner, 'mcp', 'another'),
        throwsFormatException,
      );
      final tampered = {
        ...review.raw,
        'scope': {
          ...connectorOwner.scope,
          'ownerActorId': 'someone@example.test',
        },
      };
      await expectLater(
        ConnectorReview.parse(tampered, connectorOwner, 'mcp', 'mcp:one'),
        throwsFormatException,
      );
    },
  );
  test(
    'restored long keys bind canonical correlation and the exact reviewed pin',
    () async {
      final review = await connectorReviewFixture(), key = 'long-${'k' * 300}';
      final intent = await ConnectorIntent.prepare(
        connectorOwner,
        review,
        'review_contracts',
        key: key,
      );
      final restored = await ConnectorIntent.restore(
        intent.stored,
        connectorOwner,
      );
      expect(
        (await connectorActionFixture(restored)).acceptance!['requestSha256'],
        intent.requestSha256,
      );
      final other = await ConnectorIntent.prepare(
        connectorOwner,
        review,
        'enable',
        key: key,
      );
      final response = await connectorActionFixture(intent);
      await expectLater(
        ConnectorActionRead.parse(
          response.raw,
          connectorOwner,
          intent.keySha256,
          intent: other,
          mutation: true,
        ),
        throwsFormatException,
      );
    },
  );
  test(
    'hiding the view during exact preflight leaves no journal or POST',
    () async {
      final repository = ConnectorFixtureRepository(),
          store = ConnectorFixtureStore(),
          controller = await _ready(repository, store);
      var visible = true;
      final gate = Completer<ConnectorReview>();
      repository.reviewGate = gate;
      final action = controller.act(
        controller.selected!,
        'enable',
        () => visible,
      );
      visible = false;
      gate.complete(await connectorReviewFixture());
      await action;
      expect(repository.posts, 0);
      expect(store.writes, 0);
      expect(controller.pending, isNull);
      expect(controller.busy, isFalse);
      controller.dispose();
    },
  );
  test(
    'lost response and restart recover by exact GET without repeating POST',
    () async {
      final repository = ConnectorFixtureRepository()..loseResponse = true,
          store = ConnectorFixtureStore(),
          controller = await _ready(repository, store);
      await controller.act(controller.selected!, 'enable', () => true);
      final held = controller.pending!.intent;
      expect(repository.posts, 1);
      expect(controller.pending!.dispatched, isTrue);
      controller.dispose();
      final nextRepository = ConnectorFixtureRepository(),
          next = await _ready(nextRepository, store);
      expect(next.pending!.intent.key, held.key);
      expect(nextRepository.posts, 0);
      await next.recover();
      expect(nextRepository.gets, 1);
      expect(nextRepository.posts, 0);
      expect(next.pending, isNull);
      expect(next.accepted!.settled, isTrue);
      next.dispose();
    },
  );
  test(
    'missing recovery or missing protected data cannot discharge uncertainty',
    () async {
      final repository = ConnectorFixtureRepository()..loseResponse = true,
          store = ConnectorFixtureStore(),
          controller = await _ready(repository, store);
      await controller.act(controller.selected!, 'enable', () => true);
      final held = controller.pending!.intent;
      repository.missingReceipt = true;
      await controller.recover();
      expect(controller.pending!.intent.key, held.key);
      store.value = null;
      await controller.reloadProtected();
      expect(controller.pending!.intent.key, held.key);
      expect(controller.storageUnconfirmed, isTrue);
      expect(controller.canAct, isFalse);
      expect(repository.posts, 1);
      controller.dispose();
    },
  );
  test(
    'new accepted B survives stored accepted A when local B settlement fails',
    () async {
      final repository = ConnectorFixtureRepository(),
          store = ConnectorFixtureStore(),
          controller = await _ready(repository, store);
      await controller.act(
        controller.selected!,
        'review_contracts',
        () => true,
      );
      final prior = controller.accepted!.intent.key;
      repository.afterSubmit = () => store.failNext = true;
      await controller.act(controller.selected!, 'enable', () => true);
      final newer = controller.accepted!.intent.key;
      expect(newer, isNot(prior));
      expect(controller.storageUnconfirmed, isTrue);
      await controller.reloadProtected();
      expect(controller.accepted!.intent.key, newer);
      expect(controller.pending, isNull);
      expect(controller.storageUnconfirmed, isTrue);
      await controller.saveAcceptedLocally();
      expect(controller.storageUnconfirmed, isFalse);
      expect(repository.posts, 2);
      controller.dispose();
    },
  );
  test(
    'unknown protected intent save blocks dispatch and another new key',
    () async {
      final repository = ConnectorFixtureRepository(),
          store = ConnectorFixtureStore(),
          controller = await _ready(repository, store);
      store.failNext = true;
      await controller.act(controller.selected!, 'enable', () => true);
      final held = controller.pending!.intent.key;
      expect(repository.posts, 0);
      expect(controller.storageUnconfirmed, isTrue);
      await controller.act(controller.selected!, 'enable', () => true);
      expect(controller.pending!.intent.key, held);
      expect(repository.posts, 0);
      controller.dispose();
    },
  );
  test('an authenticated missing preparation releases only a never-dispatched slot', () async {
    final repository = ConnectorFixtureRepository(),
        store = ConnectorFixtureStore(),
        controller = await _ready(repository, store);
    store.failNext = true;
    await controller.act(controller.selected!, 'enable', () => true);
    expect(controller.pending!.dispatched, isFalse);
    expect(controller.storageUnconfirmed, isTrue);
    await controller.reloadProtected();
    expect(controller.pending, isNull);
    expect(controller.canAct, isTrue);
    expect(repository.posts, 0);
    controller.dispose();
  });
  test(
    'a lost local discard is resolved by reading its committed journal',
    () async {
      final repository = ConnectorFixtureRepository(),
          store = _ObservedStore(),
          controller = await _ready(repository, store);
      var visible = true;
      store.afterWrite = () => visible = false;
      await controller.act(controller.selected!, 'enable', () => visible);
      expect(controller.pending!.dispatched, isFalse);
      expect(repository.posts, 0);
      store.afterWrite = null;
      store.failAfterNext = true;
      await controller.discardPrepared();
      expect(controller.pending, isNotNull);
      expect(controller.storageUnconfirmed, isTrue);
      expect(store.value!['pending'], isNull);
      await controller.reloadProtected();
      expect(controller.pending, isNull);
      expect(controller.storageUnconfirmed, isFalse);
      expect(controller.canAct, isTrue);
      expect(repository.posts, 0);
      controller.dispose();
    },
  );
  test(
    'saving old receipt A cannot overwrite another window pending C',
    () async {
      final repository = ConnectorFixtureRepository(),
          store = ConnectorFixtureStore(),
          controller = await _ready(repository, store);
      await controller.act(
        controller.selected!,
        'review_contracts',
        () => true,
      );
      final accepted = controller.accepted!;
      store.failNext = true;
      await controller.act(controller.selected!, 'enable', () => true);
      final held = controller.pending!.intent;
      final other = await ConnectorIntent.prepare(
        connectorOwner,
        controller.selected!,
        'enable',
        key: 'other-window',
      );
      final external = connectorFreeze({
        'schemaVersion': 1,
        'pending': ConnectorPending(other, dispatched: true).stored,
        'accepted': accepted.stored,
      });
      store.value = external;
      final writes = store.writes;
      await controller.saveAcceptedLocally();
      expect(store.writes, writes);
      expect(store.value, same(external));
      expect(controller.pending!.intent.key, held.key);
      expect(controller.accepted!.intent.key, accepted.intent.key);
      expect(controller.storageUnconfirmed, isTrue);
      expect(repository.posts, 1);
      controller.dispose();
    },
  );
  test('controller invalidation during a repository probe cancels admission synchronously', () async {
    final repository = _ProbeRepository(),
        controller = await _ready(repository, ConnectorFixtureStore());
    final reads = repository.reads;
    repository.probe = controller.close;
    await controller.refresh();
    expect(repository.reads, reads);
    expect(controller.current, isFalse);
    expect(controller.inventory, isNull);
    expect(controller.selected, isNull);
    expect(controller.selectedId, isNull);
    controller.dispose();
  });
  test(
    'repository access cannot revive after a synchronous authority change',
    () async {
      final api = _AdmissionApi();
      late ApiConnectorRepository repository;
      repository = ApiConnectorRepository(
        _access(api, () {
          repository.close();
          return true;
        }),
      );
      expect(repository.current, isFalse);
      await expectLater(repository.list(), throwsFormatException);
      expect(api.reads, 0);
    },
  );
  test(
    'repository checks closure after the final mutation admission callback',
    () async {
      final api = _AdmissionApi();
      final admitted = ApiConnectorRepository(_access(api, () => true));
      final intent = await ConnectorIntent.prepare(
        connectorOwner,
        await connectorReviewFixture(),
        'enable',
      );
      var probes = 0;
      await expectLater(
        admitted.submit(intent, () {
          if (++probes == 2) {
            admitted.close();
          }
          return true;
        }),
        throwsA(anything),
      );
      expect(api.writes, 0);
      expect(admitted.current, isFalse);
    },
  );
  for (final refusal in [
    const ApiException('Access changed.', statusCode: 403),
    const NativeAuthorityVerificationException(),
  ]) {
    test(
      'authority refusal clears private review and repaints without another read: ${refusal.runtimeType}',
      () async {
        final api = _AdmissionApi()..refusal = refusal;
        final controller = ConnectorController(
          ApiConnectorRepository(_access(api, () => true)),
          ConnectorFixtureStore(),
        );
        final review = await connectorReviewFixture();
        controller.inventory = ConnectorInventory([review.connector!], false);
        controller.selected = review;
        controller.selectedId = 'mcp:one';
        var notifications = 0;
        controller.addListener(() => notifications++);
        await controller.refresh();
        await Future<void>.value();
        expect(controller.current, isFalse);
        expect(controller.inventory, isNull);
        expect(controller.selected, isNull);
        expect(controller.selectedId, isNull);
        expect(notifications, greaterThan(1));
        await controller.refresh();
        expect(api.reads, 1);
        controller.dispose();
      },
    );
  }
  test('provider disposal inside an access probe fences the outgoing controller before rebuild', () async {
    final previous = FlutterError.onError, errors = <FlutterErrorDetails>[];
    FlutterError.onError = errors.add;
    addTearDown(() {
      FlutterError.onError = previous;
      expect(errors, isEmpty);
    });
    final api = _AdmissionApi();
    var invalidateOnProbe = false;
    late ProviderContainer container;
    final access = _access(api, () {
      if (invalidateOnProbe) {
        invalidateOnProbe = false;
        container.invalidate(connectorControllerProvider);
      }
      return true;
    });
    container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        nativeWorkspaceAccessProvider.overrideWithValue(access),
        specialistRecoveryProvider.overrideWithValue(
          MemorySpecialistRecoveryStore(),
        ),
        sessionControllerProvider.overrideWith(_ConnectorSession.new),
        biometricSessionLockControllerProvider.overrideWith(
          (_) => BiometricSessionLockController(_NoSessionEffects()),
        ),
      ],
    );
    addTearDown(container.dispose);
    await container.read(sessionControllerProvider.future);
    final subscription = container.listen(
      connectorControllerProvider,
      (_, _) {},
    );
    addTearDown(subscription.close);
    final controller = container.read(connectorControllerProvider)!;
    await Future<void>.delayed(Duration.zero);
    controller.selected = await connectorReviewFixture();
    controller.selectedId = 'mcp:one';
    final reads = api.reads;
    invalidateOnProbe = true;
    expect(controller.current, isFalse);
    expect(controller.selected, isNull);
    expect(controller.selectedId, isNull);
    final read = controller.refresh();
    expect(api.reads, reads);
    await read;
  });
}

class _ObservedStore extends ConnectorFixtureStore {
  bool failAfterNext = false;
  void Function()? afterWrite;
  @override
  Future<void> write(ConnectorJson next, bool Function() current) async {
    await super.write(next, current);
    afterWrite?.call();
    if (failAfterNext) {
      failAfterNext = false;
      throw StateError('Committed response was lost.');
    }
  }
}

class _ProbeRepository extends ConnectorFixtureRepository {
  void Function()? probe;
  int reads = 0;
  @override
  bool get current {
    final result = super.current;
    probe?.call();
    return result;
  }

  @override
  Future<ConnectorInventory> list() {
    reads++;
    return super.list();
  }
}

NativeWorkspaceAccess _access(ApiClient api, bool Function() current) =>
    NativeWorkspaceAccess(
      api,
      NativeRequestAuthority(
        tenantId: connectorOwner.tenantId,
        actorId: connectorOwner.actorId,
        canonicalUserId: connectorOwner.userId,
        role: connectorOwner.role,
        apiBaseUrl: connectorOwner.apiBaseUrl,
        isCurrent: current,
      ),
      true,
    );

class _AdmissionApi extends Fake implements ApiClient {
  int reads = 0, writes = 0;
  Object? refusal;
  @override
  String get apiBaseUrl => connectorOwner.apiBaseUrl;
  @override
  Future<Map<String, dynamic>> getJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Map<String, dynamic>? query,
    CancelToken? cancelToken,
  }) async {
    authority.requireCurrent(apiBaseUrl);
    reads++;
    throw refusal ?? StateError('Unexpected read.');
  }

  @override
  Future<Map<String, dynamic>> postJsonAuthorized(
    String path, {
    required NativeRequestAuthority authority,
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    authority.requireCurrent(apiBaseUrl);
    writes++;
    throw StateError('Unexpected mutation.');
  }
}

class _ConnectorSession extends SessionController {
  @override
  Future<AppSession?> build() async => AppSession(
    tenantId: connectorOwner.tenantId,
    actorId: connectorOwner.actorId,
    userId: connectorOwner.userId,
    email: connectorOwner.actorId,
    displayName: 'Owner',
    workspaceName: 'Asael',
    role: connectorOwner.role,
  );
}

class _NoSessionEffects extends Fake implements SessionRepository {}
