import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/storage/secure_session_store.dart';
import 'capture.dart';

const _outboxSchemaVersion = 1;
const _outboxDirectory = 'asael-capture-outbox-v1';
const _maxOutboxEntries = 25;
const _maxOutboxBytes = 64 * 1024 * 1024;
const _maxAttachmentBytes = 5 * 1024 * 1024;

class CaptureOwnerBinding {
  const CaptureOwnerBinding({required this.tenantId, required this.actorId});

  final String tenantId;
  final String actorId;

  bool owns(CaptureOutboxEntry entry) =>
      entry.tenantId == tenantId && entry.actorId == actorId;

  Future<String> sha256() async {
    final digest = await Sha256().hash(
      utf8.encode('asael.capture-outbox-owner:1\x00$tenantId\x00$actorId'),
    );
    return digest.bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
  }
}

class CaptureOutboxEntry {
  const CaptureOutboxEntry({
    required this.id,
    required this.tenantId,
    required this.actorId,
    required this.createdAt,
    required this.idempotencyKey,
    required this.draft,
  });

  final String id;
  final String tenantId;
  final String actorId;
  final DateTime createdAt;
  final String idempotencyKey;
  final CaptureDraft draft;
}

abstract interface class CaptureOutbox {
  Future<CaptureOutboxEntry> enqueue(
    CaptureOwnerBinding owner,
    CaptureDraft draft,
  );

  Future<List<CaptureOutboxEntry>> list(CaptureOwnerBinding owner);

  Future<void> remove(CaptureOwnerBinding owner, String entryId);
}

class CaptureOutboxCapacityException implements Exception {
  const CaptureOutboxCapacityException(this.message);
  final String message;
  @override
  String toString() => message;
}

class CaptureOutboxIntegrityException implements Exception {
  const CaptureOutboxIntegrityException([
    this.message = 'A local encrypted capture could not be verified.',
  ]);
  final String message;
  @override
  String toString() => message;
}

typedef CaptureOutboxDirectoryProvider = Future<Directory> Function();
typedef CaptureOutboxSecretProvider = Future<DeviceSecretMaterial> Function();

class EncryptedCaptureOutbox implements CaptureOutbox {
  EncryptedCaptureOutbox(
    this._secretProvider, {
    CaptureOutboxDirectoryProvider? directoryProvider,
    AesGcm? cipher,
  }) : _directoryProvider = directoryProvider ?? getApplicationSupportDirectory,
       _cipher = cipher ?? AesGcm.with256bits();

  final CaptureOutboxSecretProvider _secretProvider;
  final CaptureOutboxDirectoryProvider _directoryProvider;
  final AesGcm _cipher;
  Future<void> _barrier = Future.value();

  @override
  Future<CaptureOutboxEntry> enqueue(
    CaptureOwnerBinding owner,
    CaptureDraft draft,
  ) => _serial(() async {
    _validateOwner(owner);
    final validationError = draft.validationError;
    if (validationError != null) throw FormatException(validationError);
    final context = await _context();
    final files = await _entryFiles(context.directory);
    final totalBytes = files.fold<int>(
      0,
      (total, file) => total + file.lengthSync(),
    );
    if (files.length >= _maxOutboxEntries || totalBytes >= _maxOutboxBytes) {
      throw const CaptureOutboxCapacityException(
        'The encrypted capture outbox is full. Sync or discard an item first.',
      );
    }
    final id = _opaqueId();
    final entry = CaptureOutboxEntry(
      id: id,
      tenantId: owner.tenantId,
      actorId: owner.actorId,
      createdAt: DateTime.now().toUtc(),
      idempotencyKey: 'capture-offline-$id',
      draft: draft,
    );
    final content = await _encrypt(entry, context.secret);
    if (totalBytes + content.length > _maxOutboxBytes) {
      throw const CaptureOutboxCapacityException(
        'The encrypted capture outbox is full. Sync or discard an item first.',
      );
    }
    final temporary = File('${context.directory.path}/$id.tmp');
    final destination = File('${context.directory.path}/$id.capture');
    await temporary.writeAsString(content, flush: true);
    await temporary.rename(destination.path);
    return entry;
  });

  @override
  Future<List<CaptureOutboxEntry>> list(CaptureOwnerBinding owner) => _serial(
    () async {
      _validateOwner(owner);
      final context = await _context();
      final entries = <CaptureOutboxEntry>[];
      for (final file in await _entryFiles(context.directory)) {
        final entry = await _decrypt(file, context.secret);
        if (owner.owns(entry)) entries.add(entry);
      }
      entries.sort((left, right) => left.createdAt.compareTo(right.createdAt));
      return List.unmodifiable(entries);
    },
  );

  @override
  Future<void> remove(CaptureOwnerBinding owner, String entryId) =>
      _serial(() async {
        _validateOwner(owner);
        if (!_validId(entryId)) {
          throw const FormatException('The capture outbox id is invalid.');
        }
        final context = await _context();
        final file = File('${context.directory.path}/$entryId.capture');
        if (!await file.exists()) return;
        final entry = await _decrypt(file, context.secret);
        if (!owner.owns(entry)) {
          throw const CaptureOutboxIntegrityException(
            'The capture outbox owner does not match the active session.',
          );
        }
        await file.delete();
      });

  Future<_OutboxContext> _context() async {
    final root = await _directoryProvider();
    final material = await _secretProvider();
    if (!_validId(material.id) || material.bytes.length != 32) {
      throw const CaptureOutboxIntegrityException(
        'The capture outbox key is invalid.',
      );
    }
    final outboxRoot = Directory('${root.path}/$_outboxDirectory');
    await outboxRoot.create(recursive: true);
    final directory = Directory('${outboxRoot.path}/${material.id}');
    await directory.create(recursive: true);
    return _OutboxContext(directory, material);
  }

  Future<List<File>> _entryFiles(Directory directory) async {
    final files = <File>[];
    await for (final entity in directory.list(followLinks: false)) {
      if (entity is File && entity.path.endsWith('.capture')) files.add(entity);
    }
    files.sort((left, right) => left.path.compareTo(right.path));
    return files;
  }

  Future<String> _encrypt(
    CaptureOutboxEntry entry,
    DeviceSecretMaterial material,
  ) async {
    final plaintext = utf8.encode(jsonEncode(_entryToJson(entry)));
    final nonce = _cipher.newNonce();
    final secretBox = await _cipher.encrypt(
      plaintext,
      secretKey: SecretKey(material.bytes),
      nonce: nonce,
      aad: _associatedData(entry.id),
    );
    return jsonEncode({
      'schemaVersion': _outboxSchemaVersion,
      'algorithm': 'aes-256-gcm',
      'id': entry.id,
      'nonce': base64UrlEncode(secretBox.nonce).replaceAll('=', ''),
      'cipherText': base64UrlEncode(secretBox.cipherText).replaceAll('=', ''),
      'mac': base64UrlEncode(secretBox.mac.bytes).replaceAll('=', ''),
    });
  }

  Future<CaptureOutboxEntry> _decrypt(
    File file,
    DeviceSecretMaterial material,
  ) async {
    try {
      final envelope = jsonDecode(await file.readAsString());
      if (envelope is! Map ||
          envelope['schemaVersion'] != _outboxSchemaVersion ||
          envelope['algorithm'] != 'aes-256-gcm' ||
          envelope['id'] is! String ||
          envelope['nonce'] is! String ||
          envelope['cipherText'] is! String ||
          envelope['mac'] is! String) {
        throw const FormatException('Invalid encrypted capture envelope.');
      }
      final id = envelope['id'] as String;
      if (!_validId(id) || !file.path.endsWith('/$id.capture')) {
        throw const FormatException('Encrypted capture identity mismatch.');
      }
      final plaintext = await _cipher.decrypt(
        SecretBox(
          _decodeBase64Url(envelope['cipherText'] as String),
          nonce: _decodeBase64Url(envelope['nonce'] as String),
          mac: Mac(_decodeBase64Url(envelope['mac'] as String)),
        ),
        secretKey: SecretKey(material.bytes),
        aad: _associatedData(id),
      );
      final value = jsonDecode(utf8.decode(plaintext));
      final entry = _entryFromJson(value);
      if (entry.id != id) {
        throw const FormatException('Encrypted capture payload mismatch.');
      }
      return entry;
    } catch (_) {
      throw const CaptureOutboxIntegrityException();
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

class _OutboxContext {
  const _OutboxContext(this.directory, this.secret);
  final Directory directory;
  final DeviceSecretMaterial secret;
}

Map<String, Object?> _entryToJson(CaptureOutboxEntry entry) => {
  'schemaVersion': _outboxSchemaVersion,
  'id': entry.id,
  'tenantId': entry.tenantId,
  'actorId': entry.actorId,
  'createdAt': entry.createdAt.toIso8601String(),
  'idempotencyKey': entry.idempotencyKey,
  'draft': {
    'kind': entry.draft.kind.name,
    'title': entry.draft.title,
    'content': entry.draft.content,
    'tags': entry.draft.tags,
    if (entry.draft.file != null)
      'attachment': {
        'name': entry.draft.file!.name,
        'contentType': entry.draft.file!.contentType,
        'bytes': base64Encode(entry.draft.file!.bytes),
      },
  },
};

CaptureOutboxEntry _entryFromJson(Object? value) {
  if (value is! Map ||
      value['schemaVersion'] != _outboxSchemaVersion ||
      value['id'] is! String ||
      value['tenantId'] is! String ||
      value['actorId'] is! String ||
      value['createdAt'] is! String ||
      value['idempotencyKey'] is! String ||
      value['draft'] is! Map) {
    throw const FormatException('Invalid capture outbox payload.');
  }
  final id = value['id'] as String;
  final tenantId = value['tenantId'] as String;
  final actorId = value['actorId'] as String;
  final createdAt = DateTime.tryParse(value['createdAt'] as String)?.toUtc();
  final idempotencyKey = value['idempotencyKey'] as String;
  final draftValue = value['draft'] as Map;
  final kind = CaptureKind.values
      .where((candidate) => candidate.name == draftValue['kind'])
      .firstOrNull;
  final tagsValue = draftValue['tags'];
  final tags = tagsValue is List
      ? tagsValue.whereType<String>().toList()
      : null;
  CaptureAttachment? attachment;
  final attachmentValue = draftValue['attachment'];
  if (attachmentValue != null) {
    if (attachmentValue is! Map ||
        attachmentValue['name'] is! String ||
        attachmentValue['contentType'] is! String ||
        attachmentValue['bytes'] is! String) {
      throw const FormatException('Invalid capture attachment payload.');
    }
    final bytes = Uint8List.fromList(
      base64Decode(attachmentValue['bytes'] as String),
    );
    if (bytes.isEmpty || bytes.length > _maxAttachmentBytes) {
      throw const FormatException('Invalid capture attachment length.');
    }
    attachment = CaptureAttachment(
      name: attachmentValue['name'] as String,
      contentType: attachmentValue['contentType'] as String,
      bytes: bytes,
    );
  }
  if (!_validId(id) ||
      tenantId.trim().isEmpty ||
      tenantId.length > 200 ||
      actorId.trim().isEmpty ||
      actorId.length > 320 ||
      createdAt == null ||
      idempotencyKey != 'capture-offline-$id' ||
      kind == null ||
      draftValue['title'] is! String ||
      draftValue['content'] is! String ||
      tags == null) {
    throw const FormatException('Invalid capture outbox fields.');
  }
  final draft = CaptureDraft(
    kind: kind,
    title: draftValue['title'] as String,
    content: draftValue['content'] as String,
    tags: tags,
    file: attachment,
  );
  if (!draft.valid) throw FormatException(draft.validationError!);
  return CaptureOutboxEntry(
    id: id,
    tenantId: tenantId,
    actorId: actorId,
    createdAt: createdAt,
    idempotencyKey: idempotencyKey,
    draft: draft,
  );
}

void _validateOwner(CaptureOwnerBinding owner) {
  if (owner.tenantId.trim().isEmpty ||
      owner.tenantId.length > 200 ||
      owner.actorId.trim().isEmpty ||
      owner.actorId.length > 320) {
    throw const FormatException('The capture outbox owner is invalid.');
  }
}

List<int> _associatedData(String id) =>
    utf8.encode('asael.capture-outbox:$_outboxSchemaVersion:$id');

String _opaqueId() {
  final random = Random.secure();
  final bytes = List<int>.generate(18, (_) => random.nextInt(256));
  return base64UrlEncode(bytes).replaceAll('=', '');
}

bool _validId(String value) => RegExp(r'^[A-Za-z0-9_-]{24}$').hasMatch(value);

List<int> _decodeBase64Url(String value) {
  final padding = (4 - value.length % 4) % 4;
  return base64Url.decode(value.padRight(value.length + padding, '='));
}
