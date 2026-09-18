import 'dart:async';

import 'package:asael/features/push/mobile_push.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/platform/desktop_host_bridge.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

void main() {
  test('accepts every exact causal deep-link family', () {
    expect(
      MobilePushEnvelope.fromData(_data('approval', 'approval/one')).deepLink,
      '/inbox/approvals/approval%2Fone',
    );
    expect(
      MobilePushEnvelope.fromData(
        _data('work_item', 'task/one', parentId: 'project one'),
      ).deepLink,
      '/projects/project%20one?workItemId=task%2Fone',
    );
    expect(
      MobilePushEnvelope.fromData(_data('meeting', 'meeting/one')).deepLink,
      '/meetings/meeting%2Fone',
    );
    expect(
      MobilePushEnvelope.fromData(_data('customer', 'account/one')).deepLink,
      '/customers/account%2Fone',
    );
    expect(
      MobilePushEnvelope.fromData(_data('run', 'run/one')).deepLink,
      '/results/agent%3Arun%2Fone',
    );
    expect(
      MobilePushEnvelope.fromData(_data('canary', 'probe/one')).deepLink,
      '/settings?pushCanary=probe%2Fone',
    );
  });

  test('rejects a forged or cross-kind deep link', () {
    expect(
      () => MobilePushEnvelope.fromData({
        ..._data('customer', 'account-one'),
        'deepLink': '/meetings/account-one',
      }),
      throwsFormatException,
    );
    expect(
      () => MobilePushEnvelope.fromData({
        ..._data('meeting', 'meeting-one'),
        'parentId': 'project-one',
      }),
      throwsFormatException,
    );
  });

  test(
    'retains independent received, opened, and action receipt stages',
    () async {
      final values = _MemoryValues();
      final queue = MobilePushReceiptQueue(
        SecureSessionStore.withStorage(values),
      );
      final envelope = MobilePushEnvelope.fromData(
        _data('meeting', 'meeting-one'),
      );
      final observedAt = DateTime.utc(2026, 9, 18, 12);

      await queue.add(
        MobilePushReceiptRecord(
          envelope: envelope,
          kind: MobilePushReceiptKind.received,
          observedAt: observedAt,
          appLifecycle: MobilePushAppLifecycle.background,
        ),
      );
      await queue.add(
        MobilePushReceiptRecord(
          envelope: envelope,
          kind: MobilePushReceiptKind.received,
          observedAt: observedAt.add(const Duration(minutes: 1)),
          appLifecycle: MobilePushAppLifecycle.foreground,
        ),
      );
      await queue.add(
        MobilePushReceiptRecord(
          envelope: envelope,
          kind: MobilePushReceiptKind.opened,
          observedAt: observedAt,
          appLifecycle: MobilePushAppLifecycle.terminated,
          navigate: true,
        ),
      );
      await queue.add(
        MobilePushReceiptRecord(
          envelope: envelope,
          kind: MobilePushReceiptKind.action,
          action: 'complete',
          observedAt: observedAt,
          appLifecycle: MobilePushAppLifecycle.background,
        ),
      );

      final records = await queue.load();
      expect(records.map((record) => record.stageKey), [
        'mobile-push-delivery-one:received',
        'mobile-push-delivery-one:opened',
        'mobile-push-delivery-one:action:complete',
      ]);
      expect(records[1].navigate, isTrue);
      expect(records.first.observedAt, observedAt);
      expect(records.first.appLifecycle, MobilePushAppLifecycle.background);
      expect(records[2].requestBody, {
        'schemaVersion': 1,
        'kind': 'action',
        'action': 'complete',
        'observedAt': '2026-09-18T12:00:00.000Z',
        'appLifecycle': 'background',
      });
    },
  );

  test(
    'per-record storage cannot lose a concurrent add during removal',
    () async {
      final values = _BlockingMemoryValues();
      final queue = MobilePushReceiptQueue.perRecord(
        SecureSessionStore.withStorage(values),
      );
      final first = MobilePushReceiptRecord(
        envelope: MobilePushEnvelope.fromData(_data('meeting', 'meeting-one')),
        kind: MobilePushReceiptKind.received,
        observedAt: DateTime.utc(2026, 9, 18, 12),
        appLifecycle: MobilePushAppLifecycle.background,
      );
      final second = MobilePushReceiptRecord(
        envelope: MobilePushEnvelope.fromData({
          ..._data('meeting', 'meeting-two'),
          'deliveryId': 'mobile-push-delivery-two',
        }),
        kind: MobilePushReceiptKind.received,
        observedAt: DateTime.utc(2026, 9, 18, 12, 1),
        appLifecycle: MobilePushAppLifecycle.background,
      );

      await queue.add(first);
      values.blockedDeleteKey = values.values.keys.singleWhere(
        (key) => key.startsWith(
          SecureSessionStore.pendingPushReceiptRecordKeyPrefix,
        ),
      );
      final removal = queue.remove(first.stageKey);
      await values.deleteStarted.future;

      await queue.add(second);
      values.releaseDelete.complete();
      await removal;

      expect((await queue.load()).map((record) => record.stageKey), [
        second.stageKey,
      ]);
    },
  );

  test(
    'per-record storage idempotently migrates the legacy receipt blob',
    () async {
      final values = _MemoryValues();
      final store = SecureSessionStore.withStorage(values);
      final legacy = MobilePushReceiptQueue(store);
      final first = MobilePushReceiptRecord(
        envelope: MobilePushEnvelope.fromData(_data('meeting', 'meeting-one')),
        kind: MobilePushReceiptKind.opened,
        observedAt: DateTime.utc(2026, 9, 18, 12),
        appLifecycle: MobilePushAppLifecycle.terminated,
        navigate: true,
      );
      final second = MobilePushReceiptRecord(
        envelope: first.envelope,
        kind: MobilePushReceiptKind.action,
        action: 'open',
        observedAt: first.observedAt,
        appLifecycle: MobilePushAppLifecycle.terminated,
      );
      await legacy.add(first);
      await legacy.add(second);

      final firstReader = MobilePushReceiptQueue.perRecord(store);
      final secondReader = MobilePushReceiptQueue.perRecord(store);
      final results = await Future.wait([
        firstReader.load(),
        secondReader.load(),
      ]);

      expect(results[0].map((record) => record.stageKey), [
        first.stageKey,
        second.stageKey,
      ]);
      expect(results[1].map((record) => record.stageKey), [
        first.stageKey,
        second.stageKey,
      ]);
      expect(await store.readPendingPushAcknowledgement(), isNull);
      expect(await store.readAllPendingPushReceiptRecords(), hasLength(2));
    },
  );

  test(
    'does not navigate a cold-launch envelope rejected by the server',
    () async {
      final values = _MemoryValues();
      final store = SecureSessionStore.withStorage(values);
      final dio = Dio(BaseOptions(baseUrl: 'https://asael.invalid'));
      final requestStarted = Completer<void>();
      final releaseRequest = Completer<void>();
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            if (!requestStarted.isCompleted) requestStarted.complete();
            unawaited(
              releaseRequest.future.then((_) {
                handler.reject(
                  DioException(
                    requestOptions: options,
                    response: Response<Object?>(
                      requestOptions: options,
                      statusCode: 404,
                      data: const {
                        'error': {'code': 'not_found'},
                      },
                    ),
                    type: DioExceptionType.badResponse,
                  ),
                );
              }),
            );
          },
        ),
      );
      final coordinator = MobilePushCoordinator(
        ApiClient(dio, Dio(), store),
        store,
        _session,
        desktopHostBridge: DesktopHostBridge(enabled: false),
      );
      final router = _router();
      addTearDown(() {
        coordinator.dispose();
        router.dispose();
      });
      coordinator.attachRouter(router);

      await coordinator.handleDesktopNotificationAction(
        DesktopNotificationAction(
          command: DesktopNotificationCommand.open,
          data: _data('meeting', 'meeting-one'),
          appLifecycle: 'terminated',
          observedAt: DateTime.utc(2026, 9, 18, 12),
        ),
      );

      await requestStarted.future;
      expect(router.routeInformationProvider.value.uri.path, '/');
      expect(
        await MobilePushReceiptQueue.forCurrentPlatform(store).load(),
        hasLength(2),
      );
      releaseRequest.complete();
      await _waitFor(
        () async => (await MobilePushReceiptQueue.forCurrentPlatform(
          store,
        ).load()).isEmpty,
      );
      expect(router.routeInformationProvider.value.uri.path, '/');
    },
  );

  test('navigates only after a matching receipt response', () async {
    final values = _MemoryValues();
    final store = SecureSessionStore.withStorage(values);
    final envelope = MobilePushEnvelope.fromData(
      _data('meeting', 'meeting-one'),
    );
    final dio = Dio(BaseOptions(baseUrl: 'https://asael.invalid'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          final request = Map<String, dynamic>.from(options.data as Map);
          handler.resolve(
            Response<Object?>(
              requestOptions: options,
              statusCode: 200,
              data: {
                'schemaVersion': 1,
                'recorded': true,
                'receipt': {
                  'kind': request['kind'],
                  'action': request['action'],
                },
                'delivery': {
                  'id': envelope.deliveryId,
                  'notificationId': envelope.notificationId,
                  'causeKind': envelope.causeKind,
                  'causeId': envelope.causeId,
                  'deepLink': envelope.deepLink,
                },
              },
            ),
          );
        },
      ),
    );
    final coordinator = MobilePushCoordinator(
      ApiClient(dio, Dio(), store),
      store,
      _session,
      desktopHostBridge: DesktopHostBridge(enabled: false),
    );
    final router = _router();
    addTearDown(() {
      coordinator.dispose();
      router.dispose();
    });
    coordinator.attachRouter(router);

    await coordinator.handleDesktopNotificationAction(
      DesktopNotificationAction(
        command: DesktopNotificationCommand.open,
        data: envelope.toJson(),
        appLifecycle: 'terminated',
        observedAt: DateTime.utc(2026, 9, 18, 12),
      ),
    );

    await _waitFor(() => router.routeInformationProvider.value.uri.path != '/');
    expect(
      router.routeInformationProvider.value.uri.path,
      '/meetings/meeting-one',
    );
    expect(
      await MobilePushReceiptQueue.forCurrentPlatform(store).load(),
      isEmpty,
    );
  });

  test('reconciles an already-recorded 409 receipt without wedging', () async {
    final values = _MemoryValues();
    final store = SecureSessionStore.withStorage(values);
    final dio = Dio(BaseOptions(baseUrl: 'https://asael.invalid'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) => handler.reject(
          DioException(
            requestOptions: options,
            response: Response<Object?>(
              requestOptions: options,
              statusCode: 409,
              data: const {
                'error': {'code': 'conflict'},
              },
            ),
            type: DioExceptionType.badResponse,
          ),
        ),
      ),
    );
    final coordinator = MobilePushCoordinator(
      ApiClient(dio, Dio(), store),
      store,
      _session,
      desktopHostBridge: DesktopHostBridge(enabled: false),
    );
    final router = _router();
    addTearDown(() {
      coordinator.dispose();
      router.dispose();
    });
    coordinator.attachRouter(router);

    await coordinator.handleDesktopNotificationAction(
      DesktopNotificationAction(
        command: DesktopNotificationCommand.open,
        data: _data('meeting', 'meeting-one'),
        appLifecycle: 'background',
        observedAt: DateTime.utc(2026, 9, 18, 12),
      ),
    );

    await _waitFor(() => router.routeInformationProvider.value.uri.path != '/');
    expect(
      router.routeInformationProvider.value.uri.path,
      '/meetings/meeting-one',
    );
    expect(
      await MobilePushReceiptQueue.forCurrentPlatform(store).load(),
      isEmpty,
    );
  });

  test('drops unsupported actions from an open-only envelope', () async {
    final values = _MemoryValues();
    final store = SecureSessionStore.withStorage(values);
    final dio = Dio(BaseOptions(baseUrl: 'https://asael.invalid'));
    var requests = 0;
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          requests += 1;
          handler.reject(
            DioException(
              requestOptions: options,
              type: DioExceptionType.connectionError,
            ),
          );
        },
      ),
    );
    final coordinator = MobilePushCoordinator(
      ApiClient(dio, Dio(), store),
      store,
      _session,
      desktopHostBridge: DesktopHostBridge(enabled: false),
    );
    addTearDown(coordinator.dispose);

    await coordinator.handleDesktopNotificationAction(
      DesktopNotificationAction(
        command: DesktopNotificationCommand.complete,
        data: _data('meeting', 'meeting-one'),
        appLifecycle: 'foreground',
        observedAt: DateTime.utc(2026, 9, 18, 12),
      ),
    );

    expect(requests, 0);
    expect(
      await MobilePushReceiptQueue.forCurrentPlatform(store).load(),
      isEmpty,
    );
  });
}

Future<void> _waitFor(FutureOr<bool> Function() predicate) async {
  for (var attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('The asynchronous push transition did not complete.');
}

const _session = AppSession(
  tenantId: 'tenant-one',
  actorId: 'actor-one',
  userId: 'user-one',
  email: 'operator@example.com',
  displayName: 'Operator',
  workspaceName: 'Asael',
);

GoRouter _router() => GoRouter(
  initialLocation: '/',
  routes: [
    GoRoute(path: '/', builder: (_, _) => const SizedBox.shrink()),
    GoRoute(path: '/meetings/:id', builder: (_, _) => const SizedBox.shrink()),
  ],
);

Map<String, dynamic> _data(String kind, String id, {String? parentId}) => {
  'schemaVersion': '1',
  'deliveryId': 'mobile-push-delivery-one',
  'causeKind': kind,
  'causeId': id,
  'parentId': ?parentId,
  'deepLink': MobilePushEnvelope.causalDeepLink(kind, id, parentId: parentId),
};

class _MemoryValues implements AsaelEnumerableSecureValueStore {
  final values = <String, String>{};

  @override
  Future<void> delete({required String key}) async => values.remove(key);

  @override
  Future<void> migrateLegacyCredentials() async {}

  @override
  Future<void> prepare() async {}

  @override
  Future<Map<String, String>> readAll() async => Map.of(values);

  @override
  Future<String?> read({required String key}) async => values[key];

  @override
  Future<void> write({required String key, required String value}) async {
    values[key] = value;
  }
}

class _BlockingMemoryValues extends _MemoryValues {
  String? blockedDeleteKey;
  final deleteStarted = Completer<void>();
  final releaseDelete = Completer<void>();

  @override
  Future<void> delete({required String key}) async {
    if (key == blockedDeleteKey) {
      if (!deleteStarted.isCompleted) deleteStarted.complete();
      await releaseDelete.future;
    }
    await super.delete(key: key);
  }
}
