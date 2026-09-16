import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:path_provider/path_provider.dart';

import 'secure_session_store.dart';

const _projectionSchemaVersion = 1;
const _projectionDirectory = 'asael-offline-projections-v1';
const _maximumProjectionBytes = 2 * 1024 * 1024;
const _maximumProjectionEntries = 96;
const _projectionMaxAge = Duration(days: 30);

class ProjectionOwnerBinding {
  const ProjectionOwnerBinding({required this.tenantId, required this.actorId});

  final String tenantId;
  final String actorId;
}

class OfflineProjection {
  const OfflineProjection({required this.payload, required this.writtenAt});

  final Map<String, dynamic> payload;
  final DateTime writtenAt;
}

abstract interface class OfflineProjectionStore {
  Future<void> write(
    ProjectionOwnerBinding owner,
    String key,
    Map<String, dynamic> payload,
  );

  Future<OfflineProjection?> read(ProjectionOwnerBinding owner, String key);
}

class OfflineProjectionIntegrityException implements Exception {
  const OfflineProjectionIntegrityException();

  @override
  String toString() => 'An encrypted offline projection could not be verified.';
}

typedef OfflineProjectionDirectoryProvider = Future<Directory> Function();
typedef OfflineProjectionSecretProvider =
    Future<DeviceSecretMaterial> Function();

class EncryptedOfflineProjectionStore implements OfflineProjectionStore {
  EncryptedOfflineProjectionStore(
    this._secretProvider, {
    OfflineProjectionDirectoryProvider? directoryProvider,
    AesGcm? cipher,
  }) : _directoryProvider = directoryProvider ?? getApplicationSupportDirectory,
       _cipher = cipher ?? AesGcm.with256bits();

  final OfflineProjectionSecretProvider _secretProvider;
  final OfflineProjectionDirectoryProvider _directoryProvider;
  final AesGcm _cipher;
  Future<void> _barrier = Future<void>.value();

  @override
  Future<void> write(
    ProjectionOwnerBinding owner,
    String key,
    Map<String, dynamic> payload,
  ) => _serial(() async {
    _validate(owner, key);
    final encodedPayload = utf8.encode(jsonEncode(payload));
    if (encodedPayload.isEmpty ||
        encodedPayload.length > _maximumProjectionBytes) {
      return;
    }
    final context = await _context();
    final ownerDigest = await _ownerDigest(owner);
    final keyDigest = await _keyDigest(key);
    final plaintext = utf8.encode(
      jsonEncode({
        'schemaVersion': _projectionSchemaVersion,
        'ownerDigest': ownerDigest,
        'key': key,
        'keyDigest': keyDigest,
        'writtenAt': DateTime.now().toUtc().toIso8601String(),
        'payload': payload,
      }),
    );
    final nonce = _cipher.newNonce();
    final encrypted = await _cipher.encrypt(
      plaintext,
      secretKey: SecretKey(context.secret.bytes),
      nonce: nonce,
      aad: _associatedData(ownerDigest, keyDigest),
    );
    final envelope = jsonEncode({
      'schemaVersion': _projectionSchemaVersion,
      'algorithm': 'aes-256-gcm',
      'ownerDigest': ownerDigest,
      'keyDigest': keyDigest,
      'nonce': base64UrlEncode(encrypted.nonce).replaceAll('=', ''),
      'cipherText': base64UrlEncode(encrypted.cipherText).replaceAll('=', ''),
      'mac': base64UrlEncode(encrypted.mac.bytes).replaceAll('=', ''),
    });
    final directory = await _ownerDirectory(context.directory, ownerDigest);
    final temporary = File('${directory.path}/$keyDigest.tmp');
    final destination = File('${directory.path}/$keyDigest.projection');
    await temporary.writeAsString(envelope, flush: true);
    if (await destination.exists()) await destination.delete();
    await temporary.rename(destination.path);
    await _prune(directory);
  });

  @override
  Future<OfflineProjection?> read(ProjectionOwnerBinding owner, String key) =>
      _serial(() async {
        _validate(owner, key);
        final context = await _context();
        final ownerDigest = await _ownerDigest(owner);
        final keyDigest = await _keyDigest(key);
        final directory = await _ownerDirectory(context.directory, ownerDigest);
        final file = File('${directory.path}/$keyDigest.projection');
        if (!await file.exists()) return null;
        try {
          final envelope = jsonDecode(await file.readAsString());
          if (envelope is! Map ||
              envelope['schemaVersion'] != _projectionSchemaVersion ||
              envelope['algorithm'] != 'aes-256-gcm' ||
              envelope['ownerDigest'] != ownerDigest ||
              envelope['keyDigest'] != keyDigest ||
              envelope['nonce'] is! String ||
              envelope['cipherText'] is! String ||
              envelope['mac'] is! String) {
            throw const FormatException('Invalid projection envelope.');
          }
          final plaintext = await _cipher.decrypt(
            SecretBox(
              _decodeBase64Url(envelope['cipherText'] as String),
              nonce: _decodeBase64Url(envelope['nonce'] as String),
              mac: Mac(_decodeBase64Url(envelope['mac'] as String)),
            ),
            secretKey: SecretKey(context.secret.bytes),
            aad: _associatedData(ownerDigest, keyDigest),
          );
          final value = jsonDecode(utf8.decode(plaintext));
          if (value is! Map ||
              value['schemaVersion'] != _projectionSchemaVersion ||
              value['ownerDigest'] != ownerDigest ||
              value['key'] != key ||
              value['keyDigest'] != keyDigest ||
              value['writtenAt'] is! String ||
              value['payload'] is! Map) {
            throw const FormatException('Invalid projection payload.');
          }
          final writtenAt = DateTime.tryParse(value['writtenAt'] as String)
              ?.toUtc();
          if (writtenAt == null) {
            throw const FormatException('Invalid projection timestamp.');
          }
          if (DateTime.now().toUtc().difference(writtenAt) >
              _projectionMaxAge) {
            await file.delete();
            return null;
          }
          return OfflineProjection(
            payload: Map<String, dynamic>.from(value['payload'] as Map),
            writtenAt: writtenAt,
          );
        } catch (_) {
          throw const OfflineProjectionIntegrityException();
        }
      });

  Future<_ProjectionContext> _context() async {
    final root = await _directoryProvider();
    final secret = await _secretProvider();
    if (!RegExp(r'^[A-Za-z0-9_-]{24}$').hasMatch(secret.id) ||
        secret.bytes.length != 32) {
      throw const OfflineProjectionIntegrityException();
    }
    final directory = Directory(
      '${root.path}/$_projectionDirectory/${secret.id}',
    );
    await directory.create(recursive: true);
    return _ProjectionContext(directory, secret);
  }

  Future<Directory> _ownerDirectory(
    Directory directory,
    String ownerDigest,
  ) async {
    final ownerDirectory = Directory('${directory.path}/$ownerDigest');
    await ownerDirectory.create(recursive: true);
    return ownerDirectory;
  }

  Future<void> _prune(Directory directory) async {
    final files = <File>[];
    await for (final entity in directory.list(followLinks: false)) {
      if (entity is File && entity.path.endsWith('.projection')) {
        files.add(entity);
      }
    }
    if (files.length <= _maximumProjectionEntries) return;
    files.sort(
      (left, right) =>
          left.lastModifiedSync().compareTo(right.lastModifiedSync()),
    );
    for (final file in files.take(files.length - _maximumProjectionEntries)) {
      await file.delete();
    }
  }

  Future<T> _serial<T>(Future<T> Function() action) {
    final completer = Completer<T>();
    _barrier = _barrier.then((_) async {
      try {
        completer.complete(await action());
      } catch (error, stackTrace) {
        completer.completeError(error, stackTrace);
      }
    });
    return completer.future;
  }
}

class _ProjectionContext {
  const _ProjectionContext(this.directory, this.secret);

  final Directory directory;
  final DeviceSecretMaterial secret;
}

void _validate(ProjectionOwnerBinding owner, String key) {
  if (owner.tenantId.trim().isEmpty ||
      owner.tenantId.length > 200 ||
      owner.actorId.trim().isEmpty ||
      owner.actorId.length > 320 ||
      key.isEmpty ||
      key.length > 4096) {
    throw const FormatException('The offline projection scope is invalid.');
  }
}

Future<String> _ownerDigest(ProjectionOwnerBinding owner) => _digest(
  'asael.offline-projection-owner:$_projectionSchemaVersion\x00${owner.tenantId}\x00${owner.actorId}',
);

Future<String> _keyDigest(String key) =>
    _digest('asael.offline-projection-key:$_projectionSchemaVersion\x00$key');

Future<String> _digest(String value) async {
  final digest = await Sha256().hash(utf8.encode(value));
  return digest.bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
}

List<int> _associatedData(String ownerDigest, String keyDigest) => utf8.encode(
  'asael.offline-projection:$_projectionSchemaVersion:$ownerDigest:$keyDigest',
);

List<int> _decodeBase64Url(String value) {
  final padding = (4 - value.length % 4) % 4;
  return base64Url.decode(value.padRight(value.length + padding, '='));
}

String offlineProjectionKey(String path, {Map<String, dynamic>? query}) =>
    jsonEncode({
      'method': 'GET',
      'path': path,
      'query': _canonicalJson(query ?? const <String, dynamic>{}),
    });

Object? _canonicalJson(Object? value) {
  if (value is Map) {
    final entries = value.entries.toList()
      ..sort(
        (left, right) => left.key.toString().compareTo(right.key.toString()),
      );
    return <String, Object?>{
      for (final entry in entries)
        entry.key.toString(): _canonicalJson(entry.value),
    };
  }
  if (value is Iterable) return value.map(_canonicalJson).toList();
  if (value == null || value is String || value is num || value is bool) {
    return value;
  }
  return value.toString();
}
