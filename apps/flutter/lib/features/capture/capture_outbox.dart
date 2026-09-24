import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/storage/secure_session_store.dart';
import 'capture_models.dart';

const _outboxSchemaVersion = 2;
const _legacyOutboxSchemaVersion = 1;
const _outboxDirectory = 'asael-capture-outbox-v1';
const _maxOutboxEntries = captureBatchMaxFiles;
const _maxOutboxBytes = 64 * 1024 * 1024;
const _maxAttachmentBytes = captureAttachmentMaxBytes;
const _maxMetadataEnvelopeBytes = 64 * 1024;

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

  Future<CaptureOutboxEntry?> get(CaptureOwnerBinding owner, String entryId);

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
        final entry = await _decryptMetadata(file, context.secret);
        if (owner.owns(entry)) entries.add(entry);
      }
      entries.sort((left, right) => left.createdAt.compareTo(right.createdAt));
      return List.unmodifiable(entries);
    },
  );

  @override
  Future<CaptureOutboxEntry?> get(CaptureOwnerBinding owner, String entryId) =>
      _serial(() async {
        _validateOwner(owner);
        if (!_validId(entryId)) {
          throw const FormatException('The capture outbox id is invalid.');
        }
        final context = await _context();
        final file = File('${context.directory.path}/$entryId.capture');
        if (!await file.exists()) return null;
        return _decrypt(file, context.secret, owner: owner);
      });

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
        final entry = await _decryptMetadata(file, context.secret);
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
    final secretKey = SecretKey(material.bytes);
    final metadata = await _encryptEnvelope(
      entry.id,
      'metadata',
      _entryMetadataToJson(entry),
      secretKey,
    );
    final payload = await _encryptEnvelope(
      entry.id,
      'payload',
      _entryToJson(entry),
      secretKey,
    );
    return '${jsonEncode(metadata)}\n${jsonEncode(payload)}';
  }

  Future<Map<String, Object?>> _encryptEnvelope(
    String id,
    String record,
    Map<String, Object?> value,
    SecretKey secretKey,
  ) async {
    final secretBox = await _cipher.encrypt(
      utf8.encode(jsonEncode(value)),
      secretKey: secretKey,
      nonce: _cipher.newNonce(),
      aad: _associatedData(_outboxSchemaVersion, id, record),
    );
    return {
      'schemaVersion': _outboxSchemaVersion,
      'algorithm': 'aes-256-gcm',
      'record': record,
      'id': id,
      'nonce': base64UrlEncode(secretBox.nonce).replaceAll('=', ''),
      'cipherText': base64UrlEncode(secretBox.cipherText).replaceAll('=', ''),
      'mac': base64UrlEncode(secretBox.mac.bytes).replaceAll('=', ''),
    };
  }

  Future<CaptureOutboxEntry> _decrypt(
    File file,
    DeviceSecretMaterial material, {
    CaptureOwnerBinding? owner,
  }) async {
    try {
      final encoded = await file.readAsString();
      final separator = encoded.indexOf('\n');
      if (separator < 0) {
        final entry = await _decryptLegacyEnvelope(file, encoded, material);
        _requireOwner(entry, owner);
        return entry;
      }
      final metadataEnvelope = jsonDecode(encoded.substring(0, separator));
      final payloadEnvelope = jsonDecode(encoded.substring(separator + 1));
      final id = _validateEnvelope(
        metadataEnvelope,
        file,
        expectedRecord: 'metadata',
      );
      if (_validateEnvelope(payloadEnvelope, file, expectedRecord: 'payload') !=
          id) {
        throw const FormatException('Encrypted capture identity mismatch.');
      }
      if (owner != null) {
        final metadataValue = await _decryptEnvelopeValue(
          metadataEnvelope as Map,
          SecretKey(material.bytes),
          id,
          'metadata',
        );
        _requireOwner(_metadataEntryFromJson(metadataValue), owner);
      }
      final value = await _decryptEnvelopeValue(
        payloadEnvelope as Map,
        SecretKey(material.bytes),
        id,
        'payload',
      );
      final entry = _entryFromJson(value);
      if (entry.id != id) {
        throw const FormatException('Encrypted capture payload mismatch.');
      }
      return entry;
    } on CaptureOutboxIntegrityException {
      rethrow;
    } catch (_) {
      throw const CaptureOutboxIntegrityException();
    }
  }

  Future<CaptureOutboxEntry> _decryptMetadata(
    File file,
    DeviceSecretMaterial material,
  ) async {
    try {
      final header = await _readEnvelopeHeader(file);
      if (header.legacy) {
        // Version 1 encrypted metadata and attachment bytes together. Decode
        // one legacy entry at a time, return only its lightweight projection,
        // and keep the normal upload path lazy. New entries never take this
        // compatibility path.
        return _metadataOnly(
          await _decryptLegacyEnvelope(
            file,
            await file.readAsString(),
            material,
          ),
        );
      }
      final id = _validateEnvelope(
        header.envelope,
        file,
        expectedRecord: 'metadata',
      );
      final value = await _decryptEnvelopeValue(
        header.envelope,
        SecretKey(material.bytes),
        id,
        'metadata',
      );
      final entry = _metadataEntryFromJson(value);
      if (entry.id != id) {
        throw const FormatException('Encrypted capture metadata mismatch.');
      }
      return entry;
    } catch (_) {
      throw const CaptureOutboxIntegrityException();
    }
  }

  Future<_EncryptedOutboxHeader> _readEnvelopeHeader(File file) async {
    final length = await file.length();
    final handle = await file.open();
    late List<int> prefix;
    try {
      prefix = await handle.read(min(length, _maxMetadataEnvelopeBytes));
    } finally {
      await handle.close();
    }
    final separator = prefix.indexOf(10);
    if (separator < 0) {
      final text = utf8.decode(prefix, allowMalformed: true);
      if (text.contains('"schemaVersion":$_legacyOutboxSchemaVersion')) {
        return const _EncryptedOutboxHeader.legacy();
      }
      throw const FormatException('Invalid encrypted capture header.');
    }
    final value = jsonDecode(utf8.decode(prefix.sublist(0, separator)));
    if (value is! Map) {
      throw const FormatException('Invalid encrypted capture header.');
    }
    return _EncryptedOutboxHeader(value);
  }

  Future<Object?> _decryptEnvelopeValue(
    Map envelope,
    SecretKey secretKey,
    String id,
    String record,
  ) async {
    final plaintext = await _cipher.decrypt(
      SecretBox(
        _decodeBase64Url(envelope['cipherText'] as String),
        nonce: _decodeBase64Url(envelope['nonce'] as String),
        mac: Mac(_decodeBase64Url(envelope['mac'] as String)),
      ),
      secretKey: secretKey,
      aad: _associatedData(_outboxSchemaVersion, id, record),
    );
    return jsonDecode(utf8.decode(plaintext));
  }

  String _validateEnvelope(
    Object? value,
    File file, {
    required String expectedRecord,
  }) {
    if (value is! Map ||
        value['schemaVersion'] != _outboxSchemaVersion ||
        value['algorithm'] != 'aes-256-gcm' ||
        value['record'] != expectedRecord ||
        value['id'] is! String ||
        value['nonce'] is! String ||
        value['cipherText'] is! String ||
        value['mac'] is! String) {
      throw const FormatException('Invalid encrypted capture envelope.');
    }
    final id = value['id'] as String;
    if (!_validId(id) || !file.path.endsWith('/$id.capture')) {
      throw const FormatException('Encrypted capture identity mismatch.');
    }
    return id;
  }

  Future<CaptureOutboxEntry> _decryptLegacyEnvelope(
    File file,
    String encoded,
    DeviceSecretMaterial material,
  ) async {
    final envelope = jsonDecode(encoded);
    if (envelope is! Map ||
        envelope['schemaVersion'] != _legacyOutboxSchemaVersion ||
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
      aad: _associatedData(_legacyOutboxSchemaVersion, id),
    );
    final entry = _entryFromJson(jsonDecode(utf8.decode(plaintext)));
    if (entry.id != id) {
      throw const FormatException('Encrypted capture payload mismatch.');
    }
    return entry;
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

class _EncryptedOutboxHeader {
  const _EncryptedOutboxHeader(this.envelope) : legacy = false;
  const _EncryptedOutboxHeader.legacy()
    : envelope = const <Object?, Object?>{},
      legacy = true;

  final Map envelope;
  final bool legacy;
}

Map<String, Object?> _entryMetadataToJson(CaptureOutboxEntry entry) => {
  'schemaVersion': _outboxSchemaVersion,
  'id': entry.id,
  'tenantId': entry.tenantId,
  'actorId': entry.actorId,
  'createdAt': entry.createdAt.toIso8601String(),
  'idempotencyKey': entry.idempotencyKey,
  'draft': {
    'kind': entry.draft.kind.name,
    'title': entry.draft.title,
    'tags': entry.draft.tags,
    if (entry.draft.file != null)
      'attachment': {
        'name': entry.draft.file!.name,
        'contentType': entry.draft.file!.contentType,
        'byteLength': entry.draft.file!.byteLength,
      },
  },
};

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
      (value['schemaVersion'] != _outboxSchemaVersion &&
          value['schemaVersion'] != _legacyOutboxSchemaVersion) ||
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

CaptureOutboxEntry _metadataEntryFromJson(Object? value) {
  if (value is! Map ||
      value['schemaVersion'] != _outboxSchemaVersion ||
      value['id'] is! String ||
      value['tenantId'] is! String ||
      value['actorId'] is! String ||
      value['createdAt'] is! String ||
      value['idempotencyKey'] is! String ||
      value['draft'] is! Map) {
    throw const FormatException('Invalid capture outbox metadata.');
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
      ? tagsValue.whereType<String>().toList(growable: false)
      : null;
  final title = draftValue['title'];
  CaptureAttachment? attachment;
  final attachmentValue = draftValue['attachment'];
  if (attachmentValue != null) {
    if (attachmentValue is! Map ||
        attachmentValue['name'] is! String ||
        attachmentValue['contentType'] is! String ||
        attachmentValue['byteLength'] is! int) {
      throw const FormatException('Invalid capture attachment metadata.');
    }
    final byteLength = attachmentValue['byteLength'] as int;
    if (byteLength <= 0 || byteLength > _maxAttachmentBytes) {
      throw const FormatException('Invalid capture attachment length.');
    }
    attachment = CaptureAttachment(
      name: attachmentValue['name'] as String,
      contentType: attachmentValue['contentType'] as String,
      bytes: Uint8List(0),
      byteLength: byteLength,
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
      title is! String ||
      title.length > 240 ||
      tags == null ||
      tags.length > 50 ||
      tags.any((tag) => tag.trim().length > 80)) {
    throw const FormatException('Invalid capture outbox metadata fields.');
  }
  return CaptureOutboxEntry(
    id: id,
    tenantId: tenantId,
    actorId: actorId,
    createdAt: createdAt,
    idempotencyKey: idempotencyKey,
    draft: CaptureDraft(
      kind: kind,
      title: title,
      tags: tags,
      file: attachment,
      content: '',
    ),
  );
}

CaptureOutboxEntry _metadataOnly(CaptureOutboxEntry entry) {
  final file = entry.draft.file;
  final metadata = CaptureOutboxEntry(
    id: entry.id,
    tenantId: entry.tenantId,
    actorId: entry.actorId,
    createdAt: entry.createdAt,
    idempotencyKey: entry.idempotencyKey,
    draft: CaptureDraft(
      kind: entry.draft.kind,
      title: entry.draft.title,
      tags: entry.draft.tags,
      file: file == null
          ? null
          : CaptureAttachment(
              name: file.name,
              contentType: file.contentType,
              bytes: Uint8List(0),
              byteLength: file.byteLength,
            ),
      content: '',
    ),
  );
  if (file != null && file.bytes.isNotEmpty) {
    file.bytes.fillRange(0, file.bytes.length, 0);
  }
  return metadata;
}

void _validateOwner(CaptureOwnerBinding owner) {
  if (owner.tenantId.trim().isEmpty ||
      owner.tenantId.length > 200 ||
      owner.actorId.trim().isEmpty ||
      owner.actorId.length > 320) {
    throw const FormatException('The capture outbox owner is invalid.');
  }
}

void _requireOwner(CaptureOutboxEntry entry, CaptureOwnerBinding? owner) {
  if (owner != null && !owner.owns(entry)) {
    throw const CaptureOutboxIntegrityException(
      'The capture outbox owner does not match the active session.',
    );
  }
}

List<int> _associatedData(int version, String id, [String? record]) =>
    utf8.encode(
      'asael.capture-outbox:$version:$id${record == null ? '' : ':$record'}',
    );

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
