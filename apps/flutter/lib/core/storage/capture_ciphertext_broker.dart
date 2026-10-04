import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'ciphertext_recovery_broker.dart';

const captureStorageMaximumBytes = 64 * 1024 * 1024;
const captureStorageMaximumEntries = 25;

enum CaptureStorageMode { schema3, legacy }

/// The host confirmed that the exact ciphertext was not unlinked.
class CaptureStorageDeleteRetained implements Exception {
  const CaptureStorageDeleteRetained();
}

class CaptureStorageAddress {
  CaptureStorageAddress(this.secretId, this.entryId) {
    if (![secretId, entryId].every(
      (value) =>
          value.length == 24 && RegExp(r'^[A-Za-z0-9_-]{24}$').hasMatch(value),
    )) {
      throw const FormatException('Invalid capture storage address.');
    }
  }
  final String secretId, entryId;
  Map<String, Object> get json => {
    'schemaVersion': 1,
    'namespace': 'capture',
    'secretId': secretId,
    'entryId': entryId,
  };
}

abstract interface class CaptureCiphertextBroker {
  Future<RecoveryCiphertext> read(CaptureStorageAddress address);
  Future<String> append(CaptureStorageAddress address, String ciphertext);
  Future<bool> deleteExact(
    CaptureStorageAddress address, {
    required String expectedSha256,
    required int expectedBytes,
    required CaptureStorageMode mode,
  });
}

CaptureCiphertextBroker createCaptureCiphertextBroker() => Platform.isMacOS
    ? const MacOsCaptureCiphertextBroker()
    : LocalCaptureCiphertextBroker._(getApplicationSupportDirectory);

class MacOsCaptureCiphertextBroker implements CaptureCiphertextBroker {
  const MacOsCaptureCiphertextBroker({
    this.channel = const MethodChannel(
      'app.omniagent.omniagent/recovery-storage',
    ),
    this.timeout = const Duration(seconds: 30),
  });
  final MethodChannel channel;
  final Duration timeout;
  Future<Map<Object?, Object?>> _invoke(
    String method,
    CaptureStorageAddress address,
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
      throw const RecoveryStorageUnknown();
    }
    return Map<Object?, Object?>.from(raw);
  }

  @override
  Future<RecoveryCiphertext> read(CaptureStorageAddress address) async {
    try {
      final result = await _invoke('readCapture', address, {}, {
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
                    utf8.encode(content).length > captureStorageMaximumBytes ||
                    digest != await recoveryCiphertextHash(content))) {
        throw const RecoveryStorageUnavailable();
      }
      return RecoveryCiphertext(content as String?, digest as String?);
    } catch (_) {
      throw const RecoveryStorageUnavailable();
    }
  }

  @override
  Future<String> append(
    CaptureStorageAddress address,
    String ciphertext,
  ) async {
    _captureContent(ciphertext);
    final digest = await recoveryCiphertextHash(ciphertext);
    try {
      final result = await _invoke(
        'appendCapture',
        address,
        {'ciphertext': ciphertext},
        {...address.json.keys, 'status', 'sha256'},
      );
      if (result['status'] != 'appended' || result['sha256'] != digest) {
        throw const RecoveryStorageUnknown();
      }
      return digest;
    } on PlatformException catch (error) {
      if (error.code == 'recovery_capacity') {
        throw const RecoveryStorageCapacity();
      }
      if (error.code == 'recovery_conflict') {
        throw const RecoveryStorageChanged();
      }
      throw const RecoveryStorageUnknown();
    } catch (_) {
      throw const RecoveryStorageUnknown();
    }
  }

  @override
  Future<bool> deleteExact(
    CaptureStorageAddress address, {
    required String expectedSha256,
    required int expectedBytes,
    required CaptureStorageMode mode,
  }) async {
    _captureExpected(expectedSha256, expectedBytes);
    try {
      final result = await _invoke(
        'deleteCapture',
        address,
        {
          'expectedSha256': expectedSha256,
          'expectedBytes': expectedBytes,
          'mode': mode.name,
        },
        {...address.json.keys, 'status', 'deleted'},
      );
      if (result['status'] != 'deleted' || result['deleted'] is! bool) {
        throw const RecoveryStorageUnknown();
      }
      return result['deleted'] as bool;
    } on PlatformException catch (error) {
      if (error.code == 'recovery_conflict') {
        throw const RecoveryStorageChanged();
      }
      if (error.code == 'recovery_retained') {
        throw const CaptureStorageDeleteRetained();
      }
      throw const RecoveryStorageUnknown();
    } catch (_) {
      throw const RecoveryStorageUnknown();
    }
  }
}

void _captureContent(String content) {
  if (content.isEmpty ||
      utf8.encode(content).length > captureStorageMaximumBytes) {
    throw const RecoveryStorageCapacity();
  }
}

void _captureExpected(String hash, int bytes) {
  if (hash.length != 64 ||
      !RegExp(r'^[a-f0-9]{64}$').hasMatch(hash) ||
      bytes < 1 ||
      bytes > captureStorageMaximumBytes) {
    throw const FormatException('Invalid capture byte comparison.');
  }
}

/// Defense in depth after Dart has authenticated the complete encrypted item.
/// A legacy delete cannot remove a pinned current schema, even with its hash.
bool captureCiphertextMatchesMode(
  String content,
  String id,
  CaptureStorageMode mode,
) {
  try {
    final parts = content.split('\n');
    if (parts.isEmpty || parts.length > 2) {
      return false;
    }
    final envelopes = parts.map(jsonDecode).toList();
    final first = envelopes.first;
    if (first is! Map) {
      return false;
    }
    final version = first['schemaVersion'];
    if (mode == CaptureStorageMode.schema3
        ? version != 3
        : version != 1 && version != 2) {
      return false;
    }
    if (version == 1 ? parts.length != 1 : parts.length != 2) {
      return false;
    }
    return envelopes.indexed.every((entry) {
      final envelope = entry.$2;
      return envelope is Map &&
          envelope['id'] == id &&
          envelope['schemaVersion'] == version &&
          envelope['algorithm'] == 'aes-256-gcm' &&
          (version == 1
              ? !envelope.containsKey('record')
              : envelope['record'] == (entry.$1 == 0 ? 'metadata' : 'payload'));
    });
  } catch (_) {
    return false;
  }
}

class LocalCaptureCiphertextBroker implements CaptureCiphertextBroker {
  LocalCaptureCiphertextBroker._(this.directory) : deleteFile = null;
  @visibleForTesting
  LocalCaptureCiphertextBroker.forTesting(this.directory, {this.deleteFile});
  final Future<Directory> Function() directory;
  final Future<void> Function(File)? deleteFile;
  static Future<void> _barrier = Future.value();
  Future<T> _transaction<T>(
    CaptureStorageAddress address,
    Future<T> Function(Directory, List<File>) action,
  ) {
    final result = Completer<T>();
    _barrier = _barrier.catchError((Object _) {}).then((_) async {
      RandomAccessFile? lock;
      var locked = false;
      try {
        final support = await directory();
        await _checkedDirectory(support);
        final namespace = Directory('${support.path}/asael-capture-outbox-v1');
        await _checkedDirectory(namespace);
        final root = Directory('${namespace.path}/${address.secretId}');
        await _checkedDirectory(root);
        final lockType = await FileSystemEntity.type(
          '${root.path}/.transaction.lock',
          followLinks: false,
        );
        if (lockType != FileSystemEntityType.file &&
            lockType != FileSystemEntityType.notFound) {
          throw const RecoveryStorageUnavailable();
        }
        lock = await File('${root.path}/.transaction.lock')
            .open(mode: FileMode.append);
        await lock.lock(FileLock.exclusive);
        locked = true;
        final files = <File>[];
        var inspected = 0;
        await for (final item in root.list(
          recursive: true,
          followLinks: false,
        )) {
          if (++inspected > 4096) {
            throw const RecoveryStorageUnavailable();
          }
          if (item is Link) {
            throw const RecoveryStorageUnavailable();
          }
          if (item is File && item.path.endsWith('.capture')) {
            files.add(item);
          }
        }
        result.complete(await action(root, files));
      } catch (error, stack) {
        result.completeError(error, stack);
      } finally {
        if (lock != null) {
          try {
            if (locked) {
              await lock.unlock();
            }
          } catch (_) {}
          try {
            await lock.close();
          } catch (_) {}
        }
      }
    });
    return result.future;
  }

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

  File? _exact(CaptureStorageAddress address, List<File> files) {
    final matches = files
        .where((file) => file.path.endsWith('/${address.entryId}.capture'))
        .toList();
    if (matches.length > 1) {
      throw const RecoveryStorageChanged();
    }
    return matches.firstOrNull;
  }

  Future<String> _content(File file) async {
    if (await file.length() > captureStorageMaximumBytes) {
      throw const RecoveryStorageUnavailable();
    }
    return file.readAsString();
  }

  @override
  Future<RecoveryCiphertext> read(CaptureStorageAddress address) =>
      _transaction(address, (_, files) async {
        final file = _exact(address, files);
        if (file == null) {
          return const RecoveryCiphertext(null, null);
        }
        final content = await _content(file);
        return RecoveryCiphertext(
          content,
          await recoveryCiphertextHash(content),
        );
      });
  @override
  Future<String> append(CaptureStorageAddress address, String ciphertext) =>
      _transaction(address, (root, files) async {
        _captureContent(ciphertext);
        if (!captureCiphertextMatchesMode(
          ciphertext,
          address.entryId,
          CaptureStorageMode.schema3,
        )) {
          throw const FormatException('Invalid capture envelope.');
        }
        if (_exact(address, files) != null) {
          throw const RecoveryStorageChanged();
        }
        var bytes = 0;
        for (final file in files) {
          bytes += await file.length();
        }
        if (files.length >= captureStorageMaximumEntries ||
            bytes + utf8.encode(ciphertext).length >
                captureStorageMaximumBytes) {
          throw const RecoveryStorageCapacity();
        }
        final suffix = base64UrlEncode(
          List.generate(24, (_) => Random.secure().nextInt(256)),
        );
        final stage = File('${root.path}/.stage-$suffix.tmp');
        try {
          await stage.create(exclusive: true);
          await stage.writeAsString(ciphertext, flush: true);
          await stage.rename('${root.path}/${address.entryId}.capture');
          return await recoveryCiphertextHash(ciphertext);
        } catch (_) {
          throw const RecoveryStorageUnknown();
        } finally {
          try {
            if (await stage.exists()) {
              await stage.delete();
            }
          } catch (_) {}
        }
      });
  @override
  Future<bool> deleteExact(
    CaptureStorageAddress address, {
    required String expectedSha256,
    required int expectedBytes,
    required CaptureStorageMode mode,
  }) => _transaction(address, (_, files) async {
    _captureExpected(expectedSha256, expectedBytes);
    final file = _exact(address, files);
    if (file == null) {
      return false;
    }
    final content = await _content(file);
    if (utf8.encode(content).length != expectedBytes ||
        await recoveryCiphertextHash(content) != expectedSha256 ||
        !captureCiphertextMatchesMode(content, address.entryId, mode)) {
      throw const RecoveryStorageChanged();
    }
    try {
      if (deleteFile != null) {
        await deleteFile!(file);
      } else {
        await file.delete();
      }
      if (await file.exists()) {
        throw const RecoveryStorageUnknown();
      }
    } catch (_) {
      // The injected adapter can fail after unlink. Only the same exact bytes
      // observed while still holding this transaction establish retention.
      try {
        if (await file.exists() &&
            await recoveryCiphertextHash(await _content(file)) ==
                expectedSha256) {
          throw const CaptureStorageDeleteRetained();
        }
      } on CaptureStorageDeleteRetained {
        rethrow;
      } catch (_) {}
      throw const RecoveryStorageUnknown();
    }
    return true;
  });
}
