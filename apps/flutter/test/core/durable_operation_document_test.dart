import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/offline_projection_store.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/talk/talk_api_repository.dart';
import 'package:asael/features/talk/talk.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory directory;
  late SecureSessionStore session;
  late EncryptedOfflineProjectionStore legacy;
  late EncryptedOfflineProjectionStore durable;
  const owner = ProjectionOwnerBinding(
    tenantId: 'tenant-one',
    actorId: 'actor-one',
  );
  final key = DeviceSecretMaterial(
    id: 'abcdefghijklmnopqrstuvwx',
    bytes: Uint8List(32),
  );
  setUp(() async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    FlutterSecureStorage.setMockInitialValues({});
    directory = await Directory.systemTemp.createTemp(
      'asael-durable-operation-',
    );
    session = SecureSessionStore(const FlutterSecureStorage());
    await session.writeOfflineProjectionOwner(
      tenantId: owner.tenantId,
      actorId: owner.actorId,
    );
    legacy = EncryptedOfflineProjectionStore(
      () async => key,
      directoryProvider: () async => directory,
      now: () => DateTime.utc(2000),
    );
    durable = EncryptedOfflineProjectionStore.durableOperations(
      () async => key,
      directoryProvider: () async => directory,
    );
  });
  tearDown(() async {
    debugDefaultTargetPlatformOverride = null;
    await directory.delete(recursive: true);
  });
  ApiClient api([String deployment = 'https://asael.invalid']) => ApiClient(
    Dio(BaseOptions(baseUrl: deployment)),
    Dio(),
    session,
    legacy,
    null,
    null,
    false,
    durable,
  );

  Future<({ApiClient client, Dio dio, _QueueOwnerService service})> harness({
    bool pending = true,
  }) async {
    await session.writeTokens(
      accessToken: 'access-one',
      refreshToken: 'refresh-one',
      accessExpiresAt: DateTime.now()
          .add(const Duration(hours: 1))
          .toIso8601String(),
    );
    final service = _QueueOwnerService();
    final dio = Dio(BaseOptions(baseUrl: 'https://asael.invalid'))
      ..httpClientAdapter = service;
    final raw = Dio(BaseOptions(baseUrl: 'https://asael.invalid'))
      ..httpClientAdapter = service;
    createApiClient(session, dio: dio, refreshDio: raw);
    final client = ApiClient(
      dio,
      raw,
      session,
      legacy,
      null,
      null,
      true,
      durable,
    );
    final document = await client.openDurableOperationDocument(
      legacyPromptQueueOutboxPath,
    );
    await document.write({
      'schemaVersion': 1,
      'operations': [
        if (pending)
          {
            'kind': 'create',
            'request': {
              'prompt': 'private original',
              'clientCorrelationId': 'original',
            },
          },
      ],
    });
    return (client: client, dio: dio, service: service);
  }

  Future<void> replace({bool sameOwner = true}) async {
    await session.beginSessionReplacement();
    await session.writeTokens(
      accessToken: sameOwner ? 'access-same' : 'access-two',
      refreshToken: 'refresh-new',
      accessExpiresAt: DateTime.now()
          .add(const Duration(hours: 1))
          .toIso8601String(),
    );
    await session.writeOfflineProjectionOwner(
      tenantId: sameOwner ? owner.tenantId : 'tenant-two',
      actorId: sameOwner ? owner.actorId : 'actor-two',
    );
  }

  test(
    'same-owner sign-in replacement invalidates a held queue request',
    () async {
      final h = await harness();
      final entered = Completer<void>(), release = Completer<void>();
      h.dio.interceptors.insert(
        0,
        InterceptorsWrapper(
          onRequest: (options, handler) async {
            if (options.method == 'POST') {
              entered.complete();
              await release.future;
            }
            handler.next(options);
          },
        ),
      );
      final result = ApiTalkRepository(h.client).reconcilePromptQueue();
      final refused = expectLater(
        result,
        throwsA(isA<NativeAuthorityVerificationException>()),
      );
      await entered.future;
      await replace();
      release.complete();
      await refused;
      expect(h.service.writes, isEmpty);
      final next = await h.client.openDurableOperationDocument(
        legacyPromptQueueOutboxPath,
      );
      expect((await next.read())['operations'], hasLength(1));
    },
  );

  test(
    'same-session rotation and 401 retry preserve exact queued bytes and key',
    () async {
      final h = await harness();
      h.service.refuseFirstWrite = true;
      final incarnation = session.sessionIncarnation;
      await ApiTalkRepository(h.client).reconcilePromptQueue();
      expect(session.sessionIncarnation, incarnation);
      expect(h.service.writes, ['Bearer access-one', 'Bearer access-rotated']);
      expect(h.service.requests, [
        {'prompt': 'private original', 'clientCorrelationId': 'original'},
        {'prompt': 'private original', 'clientCorrelationId': 'original'},
      ]);
      final document = await h.client.openDurableOperationDocument(
        legacyPromptQueueOutboxPath,
      );
      expect((await document.read())['operations'], isEmpty);
    },
  );

  test(
    'a late accepted response cannot remove old pending work after replacement',
    () async {
      final h = await harness();
      final entered = Completer<void>(), release = Completer<void>();
      h.service.beforeWriteResponse = () {
        entered.complete();
        return release.future;
      };
      final result = ApiTalkRepository(h.client).reconcilePromptQueue();
      final refused = expectLater(
        result,
        throwsA(isA<NativeAuthorityVerificationException>()),
      );
      await entered.future;
      await replace();
      release.complete();
      await refused;
      expect(h.service.writes, ['Bearer access-one']);
      final document = await h.client.openDurableOperationDocument(
        legacyPromptQueueOutboxPath,
      );
      expect((await document.read())['operations'], hasLength(1));
    },
  );

  test('offline fallback and an already queued edit never adopt a replacement owner', () async {
    final h = await harness(pending: false);
    final entered = Completer<void>(), release = Completer<void>();
    h.service.bootstrapStatus = 503;
    h.service.beforeBootstrap = () {
      entered.complete();
      return release.future;
    };
    const prompt = TalkQueuedPrompt(
      id: 'local-original',
      clientCorrelationId: 'original',
      input: 'private original',
      mode: 'execute',
      strategy: 'orchestrate',
      executionTarget: TalkExecutionTarget.agent,
    );
    final repository = ApiTalkRepository(h.client);
    final first = repository.createPromptQueueItem(prompt);
    final firstRefused = expectLater(
      first,
      throwsA(isA<NativeAuthorityVerificationException>()),
    );
    await entered.future;
    final second = repository.updatePromptQueueItem(
      prompt,
      input: 'private later edit',
    );
    final secondRefused = expectLater(
      second,
      throwsA(isA<NativeAuthorityVerificationException>()),
    );
    await replace(sameOwner: false);
    release.complete();
    await Future.wait([firstRefused, secondRefused]);
    expect(h.service.writes, isEmpty);
    final document = await h.client.openDurableOperationDocument(
      legacyPromptQueueOutboxPath,
    );
    expect((await document.read())['operations'], isEmpty);
  });

  test(
    'replay refuses a replacement actor during credential acquisition',
    () async {
      await session.writeTokens(
        accessToken: 'access-one',
        refreshToken: 'refresh-one',
        accessExpiresAt: DateTime.now()
            .add(const Duration(hours: 1))
            .toIso8601String(),
      );
      final service = _QueueOwnerService();
      final dio = Dio(BaseOptions(baseUrl: 'https://asael.invalid'))
        ..httpClientAdapter = service;
      final raw = Dio(BaseOptions(baseUrl: 'https://asael.invalid'))
        ..httpClientAdapter = service;
      createApiClient(session, dio: dio, refreshDio: raw);
      final client = ApiClient(
        dio,
        raw,
        session,
        legacy,
        null,
        null,
        true,
        durable,
      );
      final document = await client.openDurableOperationDocument(
        legacyPromptQueueOutboxPath,
      );
      await document.write({
        'schemaVersion': 1,
        'operations': [
          {
            'kind': 'create',
            'request': {
              'prompt': 'private original',
              'clientCorrelationId': 'original',
            },
          },
        ],
      });
      final intercepted = Completer<void>();
      final release = Completer<void>();
      dio.interceptors.insert(
        0,
        InterceptorsWrapper(
          onRequest: (options, handler) async {
            if (options.method == 'POST' &&
                options.path == '/api/command/prompt-queue') {
              intercepted.complete();
              await release.future;
            }
            handler.next(options);
          },
        ),
      );
      final replay = ApiTalkRepository(client).reconcilePromptQueue();
      final refused = expectLater(
        replay,
        throwsA(isA<NativeAuthorityVerificationException>()),
      );
      await intercepted.future;
      await session.writeTokens(
        accessToken: 'access-two',
        refreshToken: 'refresh-two',
        accessExpiresAt: DateTime.now()
            .add(const Duration(hours: 1))
            .toIso8601String(),
      );
      await session.writeOfflineProjectionOwner(
        tenantId: 'tenant-two',
        actorId: 'actor-two',
      );
      release.complete();
      await refused;
      expect(
        service.writes,
        isEmpty,
        reason:
            'An old owner’s pending work must never use the new actor’s token.',
      );
    },
  );

  test('migrates surviving old operations once and never resurrects acknowledged work', () async {
    const pending = {
      'schemaVersion': 1,
      'operations': [
        {'kind': 'create', 'clientCorrelationId': 'one'},
      ],
    };
    await legacy.write(
      owner,
      offlineProjectionKey(legacyPromptQueueOutboxPath),
      pending,
    );
    final document = await api().openDurableOperationDocument(
      legacyPromptQueueOutboxPath,
    );
    expect(await document.read(), pending);
    await document.write({'schemaVersion': 1, 'operations': <Object?>[]});
    // Legacy remains intact as crash recovery; the new empty document is the
    // authoritative migration marker even after a fresh client starts.
    expect(
      (await legacy.read(
        owner,
        offlineProjectionKey(legacyPromptQueueOutboxPath),
      ))!.payload,
      pending,
    );
    final otherDeployment = await api('https://another.invalid')
        .openDurableOperationDocument(legacyPromptQueueOutboxPath);
    expect((await otherDeployment.read())['operations'], isEmpty);
    final restarted = await api().openDurableOperationDocument(
      legacyPromptQueueOutboxPath,
    );
    expect((await restarted.read())['operations'], isEmpty);
  });

  test(
    'a document cannot be read or changed after its owner changes',
    () async {
      final document = await api().openDurableOperationDocument(
        legacyPromptQueueOutboxPath,
      );
      await document.read();
      await session.writeOfflineProjectionOwner(
        tenantId: 'tenant-two',
        actorId: 'actor-two',
      );
      await expectLater(
        document.read(),
        throwsA(isA<NativeAuthorityVerificationException>()),
      );
      await expectLater(
        document.write({
          'schemaVersion': 1,
          'operations': ['foreign'],
        }),
        throwsA(isA<NativeAuthorityVerificationException>()),
      );
      final other = await api().openDurableOperationDocument(
        legacyPromptQueueOutboxPath,
      );
      expect((await other.read())['operations'], isEmpty);
    },
  );

  test('new durable documents are isolated by deployment and missing ownership fails closed', () async {
    final first = await api().openDurableOperationDocument(
      legacyPromptQueueOutboxPath,
    );
    await first.write({
      'schemaVersion': 1,
      'operations': ['one'],
    });
    final other = await api('https://other.invalid')
        .openDurableOperationDocument(legacyPromptQueueOutboxPath);
    expect((await other.read())['operations'], isEmpty);
    await session.clear();
    await expectLater(
      api().openDurableOperationDocument(legacyPromptQueueOutboxPath),
      throwsA(isA<NativeAuthorityVerificationException>()),
    );
  });
}

class _QueueOwnerService implements HttpClientAdapter {
  final writes = <Object?>[];
  final requests = <Object?>[];
  Future<void> Function()? beforeBootstrap, beforeWriteResponse;
  int bootstrapStatus = 200;
  bool refuseFirstWrite = false;
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final second = options.headers['Authorization'] == 'Bearer access-two';
    final Object body;
    var status = 200;
    if (options.uri.path == NativePaths.bootstrapGet) {
      await beforeBootstrap?.call();
      status = bootstrapStatus;
      body = {
        'authenticated': true,
        'context': {
          'tenantId': second ? 'tenant-two' : 'tenant-one',
          'actorId': second ? 'actor-two' : 'actor-one',
          'role': 'operator',
        },
        'user': {
          'id': second
              ? '22222222-2222-4222-8222-222222222222'
              : '11111111-1111-4111-8111-111111111111',
        },
        'membership': {'role': 'operator'},
      };
    } else if (options.uri.path == NativePaths.authRefresh) {
      body = {
        'tokens': {
          'accessToken': 'access-rotated',
          'refreshToken': 'refresh-rotated',
          'accessExpiresAt': DateTime.now()
              .add(const Duration(hours: 1))
              .toIso8601String(),
        },
      };
    } else {
      if (options.method == 'POST') {
        writes.add(options.headers['Authorization']);
        requests.add(options.data);
        await beforeWriteResponse?.call();
        if (refuseFirstWrite && writes.length == 1) status = 401;
      }
      body = {'items': <Object?>[]};
    }
    return ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}
