import 'dart:io';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/network/api_exception.dart';
import 'package:asael/core/storage/offline_projection_store.dart';
import 'package:asael/core/storage/secure_session_store.dart';
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
