import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:asael/core/storage/offline_projection_store.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory directory;
  const owner = ProjectionOwnerBinding(
    tenantId: 'tenant-one',
    actorId: 'actor-one',
  );
  final secret = DeviceSecretMaterial(
    id: 'abcdefghijklmnopqrstuvwx',
    bytes: Uint8List.fromList(List<int>.generate(32, (index) => index)),
  );

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('asael-projection-test-');
  });

  tearDown(() async {
    if (await directory.exists()) await directory.delete(recursive: true);
  });

  EncryptedOfflineProjectionStore createStore() =>
      EncryptedOfflineProjectionStore(
        () async => secret,
        directoryProvider: () async => directory,
      );

  test('encrypts and restores one exact actor-scoped projection', () async {
    final store = createStore();
    final key = offlineProjectionKey(
      '/api/today',
      query: {'page': 1, 'filter': 'open'},
    );

    await store.write(owner, key, {
      'items': [
        {'id': 'item-one', 'title': 'Private task'},
      ],
    });
    final restored = await store.read(owner, key);

    expect(restored, isNotNull);
    expect(restored!.payload['items'], hasLength(1));
    expect(
      await store.read(
        const ProjectionOwnerBinding(
          tenantId: 'tenant-one',
          actorId: 'actor-two',
        ),
        key,
      ),
      isNull,
    );
    final encodedFiles = await directory
        .list(recursive: true, followLinks: false)
        .where((entity) => entity is File)
        .cast<File>()
        .toList();
    expect(encodedFiles, hasLength(1));
    expect(
      await encodedFiles.single.readAsString(),
      isNot(contains('Private task')),
    );
  });

  test('fails closed when an encrypted projection is changed', () async {
    final store = createStore();
    final key = offlineProjectionKey('/api/knowledge');
    await store.write(owner, key, {'secret': 'verified'});
    final file = await directory
        .list(recursive: true, followLinks: false)
        .where((entity) => entity is File)
        .cast<File>()
        .single;
    final envelope =
        jsonDecode(await file.readAsString()) as Map<String, dynamic>;
    envelope['cipherText'] = '${envelope['cipherText']}a';
    await file.writeAsString(jsonEncode(envelope), flush: true);

    await expectLater(
      store.read(owner, key),
      throwsA(isA<OfflineProjectionIntegrityException>()),
    );
  });

  test('canonicalizes query-map ordering for stable cache keys', () {
    expect(
      offlineProjectionKey('/api/results', query: {'b': 2, 'a': 1}),
      offlineProjectionKey('/api/results', query: {'a': 1, 'b': 2}),
    );
  });
}
