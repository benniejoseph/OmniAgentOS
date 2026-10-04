import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

enum RecoveryNamespace {
  responsibility(64, 4000000),
  builder(128, 8000000),
  meetings(128, 4000000),
  markets(12, 262144),
  accounts(16, 1048576),
  specialist(32, 1048576),
  memory(16, 8388608);

  const RecoveryNamespace(this.maximumRecords, this.maximumBytes);
  final int maximumRecords, maximumBytes;
  String get directoryName => this == meetings
      ? 'asael-meeting-drafts-v1'
      : this == memory
      ? 'asael-memory-submissions-v1'
      : 'asael-$name-recovery-v1';
  String get fileExtension => this == meetings ? 'meeting' : name;
}

class RecoveryAddress {
  RecoveryAddress(this.namespace, this.secretId, this.recordKey) {
    if (secretId.length != 24 ||
        recordKey.length != 64 ||
        !RegExp(r'^[A-Za-z0-9_-]{24}$').hasMatch(secretId) ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(recordKey)) {
      throw const FormatException('Invalid protected recovery address.');
    }
  }
  final RecoveryNamespace namespace;
  final String secretId, recordKey;
  Map<String, Object> get json => {
    'schemaVersion': 1,
    'namespace': namespace.name,
    'secretId': secretId,
    'recordKey': recordKey,
  };
}

class RecoveryCiphertext {
  const RecoveryCiphertext(this.content, this.sha256);
  final String? content, sha256;
}

class RecoveryStorageChanged implements Exception {
  const RecoveryStorageChanged();
  @override
  String toString() =>
      'Protected recovery changed. Reload before saving again.';
}

class RecoveryStorageUnknown implements Exception {
  const RecoveryStorageUnknown();
  @override
  String toString() =>
      'The protected save outcome is unknown. Reload its exact record before another action.';
}

class RecoveryStorageUnavailable implements Exception {
  const RecoveryStorageUnavailable();
  @override
  String toString() => 'Protected recovery storage is unavailable.';
}

class RecoveryStorageCapacity implements Exception {
  const RecoveryStorageCapacity();
  @override
  String toString() =>
      'Protected recovery is full. Existing records were retained.';
}

Future<String> recoveryCiphertextHash(String content) async =>
    (await Sha256().hash(utf8.encode(content))).bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();

abstract interface class CiphertextRecoveryBroker {
  Future<RecoveryCiphertext> read(RecoveryAddress address);
  Future<String> compareAndSwap(
    RecoveryAddress address, {
    required String? expectedSha256,
    required String ciphertext,
  });
}

CiphertextRecoveryBroker createCiphertextRecoveryBroker() => Platform.isMacOS
    ? const MacOsCiphertextRecoveryBroker()
    : LocalCiphertextRecoveryBroker._(getApplicationSupportDirectory);

/// Every macOS engine uses the same native transaction queue. Missing native
/// registration fails closed; it never falls back to isolate-local file locks.
class MacOsCiphertextRecoveryBroker implements CiphertextRecoveryBroker {
  const MacOsCiphertextRecoveryBroker({
    this.channel = const MethodChannel(
      'app.omniagent.omniagent/recovery-storage',
    ),
    this.timeout = const Duration(seconds: 30),
  });
  final MethodChannel channel;
  final Duration timeout;

  Future<Map<Object?, Object?>> _invoke(
    String method,
    RecoveryAddress address,
    Map<String, Object?> extra,
    Set<String> fields,
  ) async {
    final raw = await channel
        .invokeMethod<Object?>(method, {...address.json, ...extra})
        .timeout(timeout);
    if (raw is! Map ||
        raw.length != fields.length ||
        !raw.keys.every(fields.contains) ||
        address.json.entries.any((entry) => raw[entry.key] != entry.value)) {
      throw const FormatException('Invalid protected storage response.');
    }
    return Map<Object?, Object?>.from(raw);
  }

  @override
  Future<RecoveryCiphertext> read(RecoveryAddress address) async {
    try {
      final result = await _invoke('read', address, {}, {
        ...address.json.keys,
        'status',
        'ciphertext',
        'sha256',
      });
      final content = result['ciphertext'], digest = result['sha256'];
      if (result['status'] != 'read' ||
          (content == null
              ? digest != null
              : content is! String ||
                    utf8.encode(content).length >
                        address.namespace.maximumBytes ||
                    digest != await recoveryCiphertextHash(content))) {
        throw const FormatException('Invalid protected storage read.');
      }
      return RecoveryCiphertext(content as String?, digest as String?);
    } catch (_) {
      throw const RecoveryStorageUnavailable();
    }
  }

  @override
  Future<String> compareAndSwap(
    RecoveryAddress address, {
    required String? expectedSha256,
    required String ciphertext,
  }) async {
    _validateWrite(address, expectedSha256, ciphertext);
    final digest = await recoveryCiphertextHash(ciphertext);
    try {
      final result = await _invoke(
        'compareAndSwap',
        address,
        {'expectedSha256': expectedSha256, 'ciphertext': ciphertext},
        {...address.json.keys, 'status', 'sha256'},
      );
      if (result['status'] != 'committed' || result['sha256'] != digest) {
        throw const RecoveryStorageUnknown();
      }
      return digest;
    } on PlatformException catch (error) {
      switch (error.code) {
        case 'recovery_conflict':
          throw const RecoveryStorageChanged();
        case 'recovery_capacity':
          throw const RecoveryStorageCapacity();
        case 'recovery_invalid':
          throw const FormatException('Invalid protected save request.');
        default:
          throw const RecoveryStorageUnknown();
      }
    } catch (_) {
      throw const RecoveryStorageUnknown();
    }
  }
}

void _validateWrite(RecoveryAddress address, String? expected, String content) {
  if (expected != null &&
      (expected.length != 64 ||
          !RegExp(r'^[a-f0-9]{64}$').hasMatch(expected))) {
    throw const FormatException('Invalid protected recovery comparison.');
  }
  if (content.isEmpty ||
      utf8.encode(content).length > address.namespace.maximumBytes) {
    throw const RecoveryStorageCapacity();
  }
}

/// Existing single-engine mobile storage. macOS production construction is
/// deliberately unavailable here. Tests must explicitly request this adapter.
class LocalCiphertextRecoveryBroker implements CiphertextRecoveryBroker {
  LocalCiphertextRecoveryBroker._(this.directory);
  @visibleForTesting
  LocalCiphertextRecoveryBroker.forTesting(this.directory);
  final Future<Directory> Function() directory;
  static Future<void> _barrier = Future.value();
  Future<T> _serial<T>(Future<T> Function() action) {
    final result = Completer<T>();
    _barrier = _barrier.catchError((Object _) {}).then((_) async {
      try {
        result.complete(await action());
      } catch (error, stack) {
        result.completeError(error, stack);
      }
    });
    return result.future;
  }

  Future<(Directory, File)> _paths(RecoveryAddress address) async {
    final support = await directory();
    await _checkedDirectory(support);
    final namespace = Directory(
      '${support.path}/${address.namespace.directoryName}',
    );
    await _checkedDirectory(namespace);
    final root = Directory('${namespace.path}/${address.secretId}');
    await _checkedDirectory(root);
    return (
      root,
      File(
        '${root.path}/${address.recordKey}.${address.namespace.fileExtension}',
      ),
    );
  }

  Future<RecoveryCiphertext> _readFile(
    File file,
    RecoveryAddress address,
  ) async {
    final type = await FileSystemEntity.type(file.path, followLinks: false);
    if (type == FileSystemEntityType.notFound) {
      return const RecoveryCiphertext(null, null);
    }
    if (type != FileSystemEntityType.file) {
      throw const RecoveryStorageUnavailable();
    }
    if (await file.length() > address.namespace.maximumBytes) {
      throw const RecoveryStorageUnavailable();
    }
    final content = await file.readAsString();
    return RecoveryCiphertext(content, await recoveryCiphertextHash(content));
  }

  @override
  Future<RecoveryCiphertext> read(RecoveryAddress address) => _serial(() async {
    final (_, file) = await _paths(address);
    return _readFile(file, address);
  });

  @override
  Future<String> compareAndSwap(
    RecoveryAddress address, {
    required String? expectedSha256,
    required String ciphertext,
  }) => _serial(() async {
    _validateWrite(address, expectedSha256, ciphertext);
    final (root, file) = await _paths(address);
    final lockType = await FileSystemEntity.type(
      '${root.path}/.transaction.lock',
      followLinks: false,
    );
    if (lockType != FileSystemEntityType.file &&
        lockType != FileSystemEntityType.notFound) {
      throw const RecoveryStorageUnavailable();
    }
    final lock = await File('${root.path}/.transaction.lock')
        .open(mode: FileMode.append);
    File? temporary;
    var locked = false;
    try {
      await lock.lock(FileLock.exclusive);
      locked = true;
      final current = await _readFile(file, address);
      if (current.sha256 != expectedSha256) {
        throw const RecoveryStorageChanged();
      }
      if (current.content == null) {
        final entries = await root
            .list(followLinks: false)
            .where(
              (item) =>
                  item is File &&
                  item.path.endsWith('.${address.namespace.fileExtension}'),
            )
            .take(address.namespace.maximumRecords)
            .length;
        if (entries >= address.namespace.maximumRecords) {
          throw const RecoveryStorageCapacity();
        }
      }
      final suffix = base64UrlEncode(
        List.generate(24, (_) => Random.secure().nextInt(256)),
      );
      temporary = File('${root.path}/.${address.recordKey}.$suffix.tmp');
      await temporary.create(exclusive: true);
      await temporary.writeAsString(ciphertext, flush: true);
      await temporary.rename(file.path);
      temporary = null;
      return await recoveryCiphertextHash(ciphertext);
    } on RecoveryStorageChanged {
      rethrow;
    } on RecoveryStorageCapacity {
      rethrow;
    } catch (_) {
      throw const RecoveryStorageUnknown();
    } finally {
      try {
        if (temporary != null && await temporary.exists()) {
          await temporary.delete();
        }
      } finally {
        try {
          if (locked) {
            await lock.unlock();
          }
        } finally {
          await lock.close();
        }
      }
    }
  });

  // Mobile relies on its app-owned sandbox against an uncooperative filesystem
  // writer; unlike the native macOS broker, Dart has no O_NOFOLLOW open API.
  Future<void> _checkedDirectory(Directory value) async {
    var type = await FileSystemEntity.type(value.path, followLinks: false);
    if (type == FileSystemEntityType.notFound) {
      await value.create(recursive: true);
      type = await FileSystemEntity.type(value.path, followLinks: false);
    }
    if (type != FileSystemEntityType.directory) {
      throw const RecoveryStorageUnavailable();
    }
  }
}
