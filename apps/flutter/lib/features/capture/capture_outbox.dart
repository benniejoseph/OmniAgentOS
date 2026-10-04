import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/storage/capture_ciphertext_broker.dart';
import '../../core/storage/ciphertext_recovery_broker.dart';
import '../../core/storage/secure_session_store.dart';
import 'capture_models.dart';

const _outboxSchemaVersion = 3;
const _legacyOutboxSchemaVersion = 1;
const _outboxDirectory = 'asael-capture-outbox-v1';
const _maxOutboxEntries = captureBatchMaxFiles;
const _maxOutboxBytes = 64 * 1024 * 1024;
const _maxAttachmentBytes = captureAttachmentMaxBytes;
const _maxMetadataEnvelopeBytes = 64 * 1024;

class CaptureOwnerBinding {
  const CaptureOwnerBinding({
    required this.tenantId,
    required this.actorId,
    this.canonicalUserId,
    this.apiOrigin,
    this.role,
  });

  final String tenantId;
  final String actorId;
  final String? canonicalUserId;
  final String? apiOrigin;
  // Current request authority only; never persisted as a grant on a draft.
  final String? role;

  bool get pinned =>
      canonicalUserId != null &&
      canonicalUserId!.trim().isNotEmpty &&
      apiOrigin != null &&
      apiOrigin!.isNotEmpty;

  // The canonical user and actual API deployment pin are local storage scope.
  // The published transport digest below deliberately stays tenant/actor v1.
  bool owns(CaptureOutboxEntry entry) =>
      pinned &&
      entry.tenantId == tenantId &&
      entry.actorId == actorId &&
      entry.canonicalUserId == canonicalUserId &&
      entry.apiOrigin == apiOrigin;

  static String originForBaseUrl(String value) {
    final uri = Uri.tryParse(value);
    if (uri == null ||
        !const {'https', 'http'}.contains(uri.scheme) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment) {
      throw const FormatException('The Capture API origin is invalid.');
    }
    final path = uri.path.replaceFirst(RegExp(r'/+$'), '');
    return uri.replace(host: uri.host.toLowerCase(), path: path).toString();
  }

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
    this.canonicalUserId,
    this.apiOrigin,
    required this.createdAt,
    required this.idempotencyKey,
    required this.draft,
  });

  final String id;
  final String tenantId;
  final String actorId;
  final String? canonicalUserId;
  final String? apiOrigin;
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

/// Public recovery metadata deliberately contains no names, source identities,
/// owners, titles, or decrypted content from an unclaimed earlier queue.
class CaptureLegacyInventory {
  const CaptureLegacyInventory({
    required this.identity,
    required this.count,
    required this.encryptedBytes,
    this.unreadableCount = 0,
    this.limited = false,
    this.reconciledDeletions = const [],
  });
  final String identity;
  final int count, encryptedBytes, unreadableCount;
  final bool limited;
  final List<CaptureLocalDeletionReceipt> reconciledDeletions;
}

enum CaptureLocalDeletionDisposition {
  removed,
  absent,
  retained,
  changed,
  unconfirmed,
}

/// Local evidence only: never a source identity, plaintext, or remote receipt.
class CaptureLocalDeletionReceipt {
  const CaptureLocalDeletionReceipt({
    required this.entryId,
    required this.sha256,
    required this.encryptedBytes,
    required this.mode,
    required this.disposition,
  });
  final String entryId, sha256;
  final int encryptedBytes;
  final CaptureStorageMode mode;
  final CaptureLocalDeletionDisposition disposition;
  CaptureLocalDeletionReceipt withDisposition(
    CaptureLocalDeletionDisposition value,
  ) => CaptureLocalDeletionReceipt(
    entryId: entryId,
    sha256: sha256,
    encryptedBytes: encryptedBytes,
    mode: mode,
    disposition: value,
  );
}

class CaptureLegacyCleanupResult {
  const CaptureLegacyCleanupResult({
    this.removed = 0,
    this.failed = 0,
    this.unconfirmed = 0,
    this.receipts = const [],
    this.stale = false,
    this.stopped = false,
  });
  final int removed, failed, unconfirmed;
  final bool stale, stopped;
  final List<CaptureLocalDeletionReceipt> receipts;
}

class CaptureOutboxWriteUnknown implements Exception {
  const CaptureOutboxWriteUnknown(this.entryId, this.sha256);
  final String entryId, sha256;
  @override
  String toString() =>
      'The local capture save is unconfirmed. Refresh the encrypted outbox before adding another capture.';
}

class CaptureOutboxDeleteUnknown implements Exception {
  const CaptureOutboxDeleteUnknown(this.receipt);
  final CaptureLocalDeletionReceipt receipt;
  @override
  String toString() =>
      'The local capture removal is unconfirmed. Refresh the encrypted outbox to check it.';
}

abstract interface class CaptureLegacyOutboxRecovery {
  Future<CaptureLegacyInventory> inspectLegacy(CaptureOwnerBinding owner);
  Future<CaptureLegacyCleanupResult> discardLegacy(
    CaptureOwnerBinding owner,
    CaptureLegacyInventory reviewed, {
    required bool Function() authorityCurrent,
  });
}

class _LegacyCiphertext {
  const _LegacyCiphertext(this.file, this.bytes, this.hash);
  final File file;
  final int bytes;
  final String hash;
}

class _LegacyScan {
  const _LegacyScan(this.files, this.unreadable, this.limited);
  final List<_LegacyCiphertext> files;
  final int unreadable;
  final bool limited;
}

class _LegacyReview {
  const _LegacyReview(
    this.owner,
    this.directory,
    this.inventory,
    this.scan,
    this.createdAt,
  );
  final CaptureOwnerBinding owner;
  final String directory;
  final CaptureLegacyInventory inventory;
  final _LegacyScan scan;
  final DateTime createdAt;
}

bool _sameLocalOwner(CaptureOwnerBinding left, CaptureOwnerBinding right) =>
    left.tenantId == right.tenantId &&
    left.actorId == right.actorId &&
    left.canonicalUserId == right.canonicalUserId &&
    left.apiOrigin == right.apiOrigin;
bool _sameLegacyScan(_LegacyScan left, _LegacyScan right) {
  if (left.files.length != right.files.length ||
      left.unreadable != right.unreadable ||
      left.limited != right.limited) {
    return false;
  }
  for (var index = 0; index < left.files.length; index++) {
    final a = left.files[index], b = right.files[index];
    if (a.file.path != b.file.path || a.bytes != b.bytes || a.hash != b.hash) {
      return false;
    }
  }
  return true;
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

class EncryptedCaptureOutbox
    implements CaptureOutbox, CaptureLegacyOutboxRecovery {
  EncryptedCaptureOutbox(
    this._secretProvider, {
    CaptureOutboxDirectoryProvider? directoryProvider,
    AesGcm? cipher,
    CaptureCiphertextBroker? broker,
  }) : _directoryProvider = directoryProvider ?? getApplicationSupportDirectory,
       _cipher = cipher ?? AesGcm.with256bits(),
       _broker = broker ?? createCaptureCiphertextBroker();

  final CaptureOutboxSecretProvider _secretProvider;
  final CaptureOutboxDirectoryProvider _directoryProvider;
  final AesGcm _cipher;
  final CaptureCiphertextBroker _broker;
  final Map<String, CaptureOutboxWriteUnknown> _unknownAppends = {};
  final Map<String, Map<String, CaptureLocalDeletionReceipt>>
  _unknownCurrentDeletes = {};
  final Map<String, List<CaptureLocalDeletionReceipt>> _unknownLegacyDeletes =
      {};
  _LegacyReview? _legacyReview;
  Future<void> _barrier = Future.value();

  @override
  Future<CaptureOutboxEntry> enqueue(
    CaptureOwnerBinding owner,
    CaptureDraft draft,
  ) => _serial(() async {
    _validateOwner(owner);
    final validationError = draft.validationError;
    if (validationError != null) {
      throw FormatException(validationError);
    }
    final context = await _context();
    final unknown = _unknownAppends[context.secret.id];
    if (unknown != null) {
      throw unknown;
    }
    final id = _opaqueId();
    final entry = CaptureOutboxEntry(
      id: id,
      tenantId: owner.tenantId,
      actorId: owner.actorId,
      canonicalUserId: owner.canonicalUserId,
      apiOrigin: owner.apiOrigin,
      createdAt: DateTime.now().toUtc(),
      idempotencyKey: 'capture-offline-$id',
      draft: draft,
    );
    final content = await _encrypt(entry, context.secret);
    final hash = await recoveryCiphertextHash(content);
    try {
      await _broker.append(
        CaptureStorageAddress(context.secret.id, id),
        content,
      );
    } on RecoveryStorageCapacity {
      throw const CaptureOutboxCapacityException(
        'The encrypted capture outbox is full. Sync or discard an item first.',
      );
    } on RecoveryStorageChanged {
      throw const CaptureOutboxIntegrityException(
        'A local capture identity already exists. Refresh the encrypted outbox.',
      );
    } catch (_) {
      final unknown = CaptureOutboxWriteUnknown(id, hash);
      _unknownAppends[context.secret.id] = unknown;
      throw unknown;
    }
    return entry;
  });

  @override
  Future<List<CaptureOutboxEntry>> list(CaptureOwnerBinding owner) => _serial(
    () async {
      _validateOwner(owner);
      final context = await _context();
      await _reconcileCurrentDeletes(context);
      final unknown = _unknownAppends[context.secret.id];
      if (unknown != null) {
        // A host read joins the same native queue after a timed-out append.
        // No append is repeated, and no replacement idempotency key is minted.
        final actual = await _broker.read(
          CaptureStorageAddress(context.secret.id, unknown.entryId),
        );
        if (actual.content != null && actual.sha256 != unknown.sha256) {
          throw const CaptureOutboxIntegrityException();
        }
      }
      final entries = <CaptureOutboxEntry>[];
      final files = await _entryFiles(context.directory);
      for (final file in files) {
        // Old entries have no canonical user/deployment attestation. Leave
        // their ciphertext quarantined; matching an email is not migration authority.
        final header = await _readEnvelopeHeader(file);
        if (header.legacy || header.envelope['schemaVersion'] == 2) {
          continue;
        }
        final id = file.uri.pathSegments.last.replaceFirst(
          RegExp(r'\.capture$'),
          '',
        );
        final exact = await _broker.read(
          CaptureStorageAddress(context.secret.id, id),
        );
        if (exact.content == null) {
          continue;
        }
        // Every engine joins the native queue before exposing a candidate.
        // Decrypt exactly the returned snapshot, never a later filesystem read.
        final entry = await _decryptMetadata(
          file,
          context.secret,
          ciphertext: exact.content,
        );
        if (owner.owns(entry)) {
          entries.add(entry);
        }
      }
      entries.sort((left, right) => left.createdAt.compareTo(right.createdAt));
      _unknownAppends.remove(context.secret.id);
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
        await _reconcileCurrentDeletes(context);
        final exact = await _broker.read(
          CaptureStorageAddress(context.secret.id, entryId),
        );
        if (exact.content == null) {
          return null;
        }
        final file = await _entryFile(context.directory, entryId);
        if (file == null) {
          return null;
        }
        final header = await _readEnvelopeHeader(file);
        if (header.legacy ||
            header.envelope['schemaVersion'] != _outboxSchemaVersion) {
          throw const CaptureOutboxIntegrityException(
            'This legacy local capture has no verified account and API origin binding.',
          );
        }
        return _decrypt(
          file,
          context.secret,
          owner: owner,
          ciphertext: exact.content,
        );
      });

  @override
  Future<void> remove(CaptureOwnerBinding owner, String entryId) =>
      _serial(() async {
        _validateOwner(owner);
        if (!_validId(entryId)) {
          throw const FormatException('The capture outbox id is invalid.');
        }
        final context = await _context();
        final pending = _unknownCurrentDeletes[context.secret.id]?[entryId];
        if (pending != null) {
          throw CaptureOutboxDeleteUnknown(pending);
        }
        final file = await _entryFile(context.directory, entryId);
        if (file == null) {
          return;
        }
        // Authenticate the owner before freezing the complete immutable bytes.
        if (await file.length() > _maxOutboxBytes) {
          throw const CaptureOutboxIntegrityException();
        }
        final original = await file.readAsString();
        final entry = await _decryptMetadata(file, context.secret);
        if (!owner.owns(entry)) {
          throw const CaptureOutboxIntegrityException(
            'The capture outbox owner does not match the active session.',
          );
        }
        if (await file.readAsString() != original) {
          throw const CaptureOutboxIntegrityException();
        }
        final receipt = CaptureLocalDeletionReceipt(
          entryId: entryId,
          sha256: await recoveryCiphertextHash(original),
          encryptedBytes: utf8.encode(original).length,
          mode: CaptureStorageMode.schema3,
          disposition: CaptureLocalDeletionDisposition.unconfirmed,
        );
        try {
          await _broker.deleteExact(
            CaptureStorageAddress(context.secret.id, entryId),
            expectedSha256: receipt.sha256,
            expectedBytes: receipt.encryptedBytes,
            mode: receipt.mode,
          );
        } on RecoveryStorageUnknown {
          _unknownCurrentDeletes.putIfAbsent(
            context.secret.id,
            () => {},
          )[entryId] = receipt;
          throw CaptureOutboxDeleteUnknown(receipt);
        }
      });

  Future<void> _reconcileCurrentDeletes(_OutboxContext context) async {
    final pending = _unknownCurrentDeletes[context.secret.id];
    if (pending == null) {
      return;
    }
    for (final receipt in pending.values) {
      // Ordered behind the original admitted native deletion. Until this
      // resolves, neither list nor get may expose bytes for a remote upload.
      final actual = await _broker.read(
        CaptureStorageAddress(context.secret.id, receipt.entryId),
      );
      if (actual.content != null &&
          (actual.sha256 != receipt.sha256 ||
              utf8.encode(actual.content!).length != receipt.encryptedBytes)) {
        throw const CaptureOutboxIntegrityException();
      }
    }
    _unknownCurrentDeletes.remove(context.secret.id);
  }

  @override
  Future<CaptureLegacyInventory> inspectLegacy(CaptureOwnerBinding owner) =>
      _serial(() async {
        _validateOwner(owner);
        final context = await _context();
        final reconciled = <CaptureLocalDeletionReceipt>[];
        for (final receipt
            in _unknownLegacyDeletes[context.secret.id] ??
                <CaptureLocalDeletionReceipt>[]) {
          final actual = await _broker.read(
            CaptureStorageAddress(context.secret.id, receipt.entryId),
          );
          reconciled.add(
            receipt.withDisposition(
              actual.content == null
                  ? CaptureLocalDeletionDisposition.absent
                  : actual.sha256 == receipt.sha256 &&
                        utf8.encode(actual.content!).length ==
                            receipt.encryptedBytes
                  ? CaptureLocalDeletionDisposition.retained
                  : CaptureLocalDeletionDisposition.changed,
            ),
          );
        }
        final scan = await _scanLegacy(context.directory, context.secret);
        final inventory = CaptureLegacyInventory(
          identity: _opaqueId(),
          count: scan.files.length,
          encryptedBytes: scan.files.fold(
            0,
            (total, file) => total + file.bytes,
          ),
          unreadableCount: scan.unreadable,
          limited: scan.limited,
          reconciledDeletions: List.unmodifiable(reconciled),
        );
        _unknownLegacyDeletes.remove(context.secret.id);
        _legacyReview = _LegacyReview(
          owner,
          context.directory.path,
          inventory,
          scan,
          DateTime.now().toUtc(),
        );
        return inventory;
      });

  @override
  Future<CaptureLegacyCleanupResult> discardLegacy(
    CaptureOwnerBinding owner,
    CaptureLegacyInventory reviewed, {
    required bool Function() authorityCurrent,
  }) => _serial(() async {
    _validateOwner(owner);
    final review = _legacyReview;
    _legacyReview = null; // A confirmation can be consumed only once.
    bool current() {
      try {
        return authorityCurrent();
      } catch (_) {
        return false;
      }
    }

    if (!current()) {
      return const CaptureLegacyCleanupResult(stopped: true);
    }
    if (review == null ||
        !identical(review.inventory, reviewed) ||
        !_sameLocalOwner(review.owner, owner) ||
        DateTime.now().toUtc().difference(review.createdAt) >
            const Duration(minutes: 5)) {
      return const CaptureLegacyCleanupResult(stale: true);
    }
    final context = await _context();
    final fresh = await _scanLegacy(context.directory, context.secret);
    if (!current()) {
      return const CaptureLegacyCleanupResult(stopped: true);
    }
    if (review.directory != context.directory.path ||
        !_sameLegacyScan(review.scan, fresh)) {
      return const CaptureLegacyCleanupResult(stale: true);
    }
    var removed = 0, failed = 0, unconfirmed = 0;
    final receipts = <CaptureLocalDeletionReceipt>[];
    CaptureLegacyCleanupResult result({bool stopped = false}) =>
        CaptureLegacyCleanupResult(
          removed: removed,
          failed: failed,
          unconfirmed: unconfirmed,
          receipts: List.unmodifiable(receipts),
          stopped: stopped,
        );
    for (final expected in review.scan.files) {
      if (!current()) {
        return result(stopped: true);
      }
      final id = expected.file.uri.pathSegments.last.replaceFirst(
        RegExp(r'\.capture$'),
        '',
      );
      final receipt = CaptureLocalDeletionReceipt(
        entryId: id,
        sha256: expected.hash,
        encryptedBytes: expected.bytes,
        mode: CaptureStorageMode.legacy,
        disposition: CaptureLocalDeletionDisposition.unconfirmed,
      );
      var dispatched = false;
      try {
        final actual = await _legacyFingerprint(expected.file, context.secret);
        if (actual == null ||
            actual.hash != expected.hash ||
            actual.bytes != expected.bytes) {
          failed++;
          receipts.add(
            receipt.withDisposition(CaptureLocalDeletionDisposition.changed),
          );
          continue;
        }
        if (!current()) {
          return result(stopped: true);
        }
        dispatched = true;
        final deleted = await _broker.deleteExact(
          CaptureStorageAddress(context.secret.id, id),
          expectedSha256: expected.hash,
          expectedBytes: expected.bytes,
          mode: CaptureStorageMode.legacy,
        );
        if (deleted) {
          removed++;
        }
        receipts.add(
          receipt.withDisposition(
            deleted
                ? CaptureLocalDeletionDisposition.removed
                : CaptureLocalDeletionDisposition.absent,
          ),
        );
      } on CaptureStorageDeleteRetained {
        failed++;
        receipts.add(
          receipt.withDisposition(CaptureLocalDeletionDisposition.retained),
        );
      } on RecoveryStorageChanged {
        failed++;
        receipts.add(
          receipt.withDisposition(CaptureLocalDeletionDisposition.changed),
        );
      } catch (_) {
        if (!dispatched) {
          failed++;
          receipts.add(
            receipt.withDisposition(CaptureLocalDeletionDisposition.changed),
          );
          continue;
        }
        unconfirmed++;
        receipts.add(receipt);
        _unknownLegacyDeletes
            .putIfAbsent(context.secret.id, () => [])
            .add(receipt);
        // Stop at the first uncertain deletion. A fresh read is required
        // before presenting another explicit cleanup confirmation.
        return result(stopped: true);
      }
    }
    return result();
  });

  Future<_LegacyScan> _scanLegacy(
    Directory directory,
    DeviceSecretMaterial secret,
  ) async {
    final candidates = <_LegacyCiphertext>[];
    final files = <File>[];
    var scannedBytes = 0, unreadable = 0, inspected = 0;
    var limited = false;
    await for (final entity in directory.list(
      recursive: true,
      followLinks: false,
    )) {
      if (++inspected > 1024) {
        limited = true;
        break;
      }
      if (entity is File && entity.path.endsWith('.capture')) {
        if (files.length >= 256) {
          limited = true;
          break;
        }
        files.add(entity);
      }
    }
    files.sort((left, right) => left.path.compareTo(right.path));
    for (final file in files) {
      if (candidates.length >= _maxOutboxEntries) {
        limited = true;
        break;
      }
      try {
        final header = await _readEnvelopeHeader(file);
        if (!header.legacy && header.envelope['schemaVersion'] != 2) {
          continue;
        }
        final size = await file.length();
        if (size > _maxOutboxBytes - scannedBytes) {
          limited = true;
          continue;
        }
        scannedBytes += size;
        final candidate = await _legacyFingerprint(file, secret);
        if (candidate != null) candidates.add(candidate);
      } catch (_) {
        unreadable++;
      }
    }
    return _LegacyScan(candidates, unreadable, limited);
  }

  Future<_LegacyCiphertext?> _legacyFingerprint(
    File file,
    DeviceSecretMaterial secret,
  ) async {
    if (await FileSystemEntity.type(file.path, followLinks: false) !=
        FileSystemEntityType.file) {
      throw const CaptureOutboxIntegrityException();
    }
    final header = await _readEnvelopeHeader(file);
    if (!header.legacy && header.envelope['schemaVersion'] != 2) {
      return null;
    }
    final size = await file.length();
    if (size < 1 || size > _maxOutboxBytes) {
      throw const CaptureOutboxIntegrityException();
    }
    final builder = BytesBuilder(copy: false);
    await for (final chunk in file.openRead(0, size + 1)) {
      builder.add(chunk);
    }
    final bytes = builder.takeBytes();
    if (bytes.length != size) {
      throw const CaptureOutboxIntegrityException();
    }
    final encoded = utf8.decode(bytes);
    final parts = encoded.split('\n');
    final filename = file.uri.pathSegments.last;
    final id = filename.substring(0, filename.length - '.capture'.length);
    if (!_validId(id)) {
      throw const CaptureOutboxIntegrityException();
    }
    bool envelope(Object? value, int version, String? record) =>
        value is Map &&
        value['schemaVersion'] == version &&
        value['id'] == id &&
        value['algorithm'] == 'aes-256-gcm' &&
        (record == null
            ? !value.containsKey('record')
            : value['record'] == record) &&
        const ['nonce', 'cipherText', 'mac'].every(
          (key) =>
              value[key] is String &&
              (value[key] as String).isNotEmpty &&
              RegExp(r'^[A-Za-z0-9_+/=-]+$').hasMatch(value[key] as String),
        );
    if (parts.length == 1) {
      final value = jsonDecode(parts.single);
      if (!envelope(value, 1, null)) {
        throw const CaptureOutboxIntegrityException();
      }
      await _authenticateLegacyEnvelope(value as Map, secret, id, 1, null);
    } else if (parts.length == 2) {
      final metadata = jsonDecode(parts[0]), payload = jsonDecode(parts[1]);
      if (!envelope(metadata, 2, 'metadata') ||
          !envelope(payload, 2, 'payload')) {
        throw const CaptureOutboxIntegrityException();
      }
      await _authenticateLegacyEnvelope(
        metadata as Map,
        secret,
        id,
        2,
        'metadata',
      );
      await _authenticateLegacyEnvelope(
        payload as Map,
        secret,
        id,
        2,
        'payload',
      );
    } else {
      throw const CaptureOutboxIntegrityException();
    }
    // No authenticated plaintext is parsed or returned by recovery.
    final hash = (await Sha256().hash(bytes)).bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
    return _LegacyCiphertext(file, size, hash);
  }

  Future<void> _authenticateLegacyEnvelope(
    Map envelope,
    DeviceSecretMaterial secret,
    String id,
    int version,
    String? record,
  ) async {
    // A schema label is untrusted. Authentication binds the original version,
    // so changing a pinned schema-3 header cannot make its bytes deletable.
    final plaintext = await _cipher.decrypt(
      SecretBox(
        _decodeBase64Url(envelope['cipherText'] as String),
        nonce: _decodeBase64Url(envelope['nonce'] as String),
        mac: Mac(_decodeBase64Url(envelope['mac'] as String)),
      ),
      secretKey: SecretKey(secret.bytes),
      aad: _associatedData(version, id, record),
    );
    plaintext.fillRange(0, plaintext.length, 0);
  }

  Future<File?> _entryFile(Directory directory, String id) async {
    final matches = (await _entryFiles(directory))
        .where((file) => file.path.endsWith('/$id.capture'))
        .toList();
    if (matches.length > 1) {
      throw const CaptureOutboxIntegrityException(
        'Duplicate local encrypted capture identities require recovery.',
      );
    }
    return matches.firstOrNull;
  }

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
    var inspected = 0;
    await for (final entity in directory.list(
      recursive: true,
      followLinks: false,
    )) {
      if (++inspected > 4096 || entity is Link) {
        throw const CaptureOutboxIntegrityException(
          'The bounded encrypted inventory could not be verified.',
        );
      }
      if (entity is File && entity.path.endsWith('.capture')) {
        files.add(entity);
      }
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
    String? ciphertext,
  }) async {
    try {
      final encoded = ciphertext ?? await file.readAsString();
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
      _requireOwner(entry, owner);
      return entry;
    } on CaptureOutboxIntegrityException {
      rethrow;
    } catch (_) {
      throw const CaptureOutboxIntegrityException();
    }
  }

  Future<CaptureOutboxEntry> _decryptMetadata(
    File file,
    DeviceSecretMaterial material, {
    String? ciphertext,
  }) async {
    try {
      final _EncryptedOutboxHeader header;
      if (ciphertext != null) {
        final separator = ciphertext.indexOf('\n');
        if (separator < 0 ||
            utf8.encode(ciphertext.substring(0, separator)).length >
                _maxMetadataEnvelopeBytes) {
          throw const CaptureOutboxIntegrityException();
        }
        final value = jsonDecode(ciphertext.substring(0, separator));
        if (value is! Map) {
          throw const CaptureOutboxIntegrityException();
        }
        header = _EncryptedOutboxHeader(value);
      } else {
        header = await _readEnvelopeHeader(file);
      }
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
  'canonicalUserId': entry.canonicalUserId,
  'apiOrigin': entry.apiOrigin,
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
  'canonicalUserId': entry.canonicalUserId,
  'apiOrigin': entry.apiOrigin,
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
  if (!draft.valid) {
    throw FormatException(draft.validationError!);
  }
  return CaptureOutboxEntry(
    id: id,
    tenantId: tenantId,
    actorId: actorId,
    canonicalUserId: value['canonicalUserId'] as String?,
    apiOrigin: value['apiOrigin'] as String?,
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
    canonicalUserId: value['canonicalUserId'] as String?,
    apiOrigin: value['apiOrigin'] as String?,
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
    canonicalUserId: entry.canonicalUserId,
    apiOrigin: entry.apiOrigin,
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
      owner.actorId.length > 320 ||
      !owner.pinned ||
      owner.canonicalUserId!.length > 320 ||
      owner.apiOrigin !=
          CaptureOwnerBinding.originForBaseUrl(owner.apiOrigin!)) {
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

bool _validId(String value) =>
    value.length == 24 && RegExp(r'^[A-Za-z0-9_-]{24}$').hasMatch(value);

List<int> _decodeBase64Url(String value) {
  final padding = (4 - value.length % 4) % 4;
  return base64Url.decode(value.padRight(value.length + padding, '='));
}
