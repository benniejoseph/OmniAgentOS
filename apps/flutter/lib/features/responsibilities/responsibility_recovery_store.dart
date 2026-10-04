import 'dart:async';
import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import '../../core/storage/ciphertext_recovery_broker.dart';
import '../../core/storage/secure_session_store.dart';
import 'responsibility_contracts.dart';

abstract interface class ResponsibilityRecoveryStore {
  Future<ResponsibilityJson?> read(ResponsibilityOwner owner);
  Future<void> write(
    ResponsibilityOwner owner,
    ResponsibilityJson value, {
    required bool Function() isCurrent,
  });
}

class ResponsibilityRecoveryChanged implements Exception {
  const ResponsibilityRecoveryChanged();
}

/// Account/deployment-bound recovery never dispatches an operation. A durable
/// pending intent requires an explicit same-key recovery after restart.
class EncryptedResponsibilityRecoveryStore
    implements ResponsibilityRecoveryStore {
  EncryptedResponsibilityRecoveryStore(
    this.secret, {
    CiphertextRecoveryBroker? broker,
  }) : broker = broker ?? createCiphertextRecoveryBroker();
  final Future<DeviceSecretMaterial> Function() secret;
  final CiphertextRecoveryBroker broker;
  final AesGcm _cipher = AesGcm.with256bits();
  final Map<String, String?> _knownCiphertext = {};
  final Set<String> _reloadRequired = {};
  static Future<void> _barrier = Future.value();
  Future<T> _serial<T>(Future<T> Function() operation) {
    final done = Completer<T>();
    _barrier = _barrier.catchError((Object _) {}).then((_) async {
      try {
        done.complete(await operation());
      } catch (error, stack) {
        done.completeError(error, stack);
      }
    });
    return done.future;
  }

  Future<(RecoveryAddress, DeviceSecretMaterial, String)> _context(
    ResponsibilityOwner owner,
  ) async {
    final material = await secret(),
        binding = responsibilityCanonical([
          'asael-responsibility-recovery:1',
          owner.key,
        ]);
    responsibilityRequire(
      material.bytes.length == 32 &&
          RegExp(r'^[A-Za-z0-9_-]{24}$').hasMatch(material.id),
      'Protected Responsibility recovery is unavailable.',
    );
    return (
      RecoveryAddress(
        RecoveryNamespace.responsibility,
        material.id,
        await responsibilityHash(binding),
      ),
      material,
      binding,
    );
  }

  @override
  Future<ResponsibilityJson?> read(ResponsibilityOwner owner) =>
      _serial(() async {
        final (address, material, binding) = await _context(owner);
        final stored = await broker.read(address);
        if (stored.content == null) {
          _knownCiphertext[binding] = null;
          _reloadRequired.remove(binding);
          return null;
        }
        final content = stored.content!,
            envelope = responsibilityMap(jsonDecode(content));
        responsibilityRequire(
          envelope['version'] == 1 && envelope['algorithm'] == 'aes-256-gcm',
        );
        final bytes = await _cipher.decrypt(
          SecretBox(
            base64Decode(envelope['ciphertext'] as String),
            nonce: base64Decode(envelope['nonce'] as String),
            mac: Mac(base64Decode(envelope['mac'] as String)),
          ),
          secretKey: SecretKey(material.bytes),
          aad: utf8.encode(binding),
        );
        try {
          final result = responsibilityMap(jsonDecode(utf8.decode(bytes)));
          responsibilityRequire(
            result['binding'] == binding && result['schemaVersion'] == 1,
          );
          _knownCiphertext[binding] = stored.sha256;
          _reloadRequired.remove(binding);
          return freezeResponsibility(responsibilityMap(result['payload']))
              as ResponsibilityJson;
        } finally {
          bytes.fillRange(0, bytes.length, 0);
        }
      });
  @override
  Future<void> write(
    ResponsibilityOwner owner,
    ResponsibilityJson value, {
    required bool Function() isCurrent,
  }) => _serial(() async {
    responsibilityRequire(
      isCurrent(),
      'Responsibility recovery account changed.',
    );
    final (address, material, binding) = await _context(owner);
    if (_reloadRequired.contains(binding)) {
      throw const RecoveryStorageUnknown();
    }
    final plain = utf8.encode(
      jsonEncode({'schemaVersion': 1, 'binding': binding, 'payload': value}),
    );
    responsibilityRequire(
      plain.length <= 2500000,
      'Protected Responsibility recovery is full. Existing drafts and uncertain changes were retained.',
    );
    late SecretBox encrypted;
    try {
      encrypted = await _cipher.encrypt(
        plain,
        secretKey: SecretKey(material.bytes),
        nonce: _cipher.newNonce(),
        aad: utf8.encode(binding),
      );
    } finally {
      plain.fillRange(0, plain.length, 0);
    }
    responsibilityRequire(
      isCurrent(),
      'Responsibility recovery account changed.',
    );
    final content = jsonEncode({
      'version': 1,
      'algorithm': 'aes-256-gcm',
      'nonce': base64Encode(encrypted.nonce),
      'ciphertext': base64Encode(encrypted.cipherText),
      'mac': base64Encode(encrypted.mac.bytes),
    });
    try {
      final digest = await broker.compareAndSwap(
        address,
        expectedSha256: _knownCiphertext[binding],
        ciphertext: content,
      );
      _knownCiphertext[binding] = digest;
      responsibilityRequire(
        isCurrent(),
        'Responsibility recovery account changed.',
      );
    } on RecoveryStorageChanged {
      _reloadRequired.add(binding);
      throw const ResponsibilityRecoveryChanged();
    } on RecoveryStorageCapacity {
      rethrow;
    } catch (_) {
      _reloadRequired.add(binding);
      throw const RecoveryStorageUnknown();
    }
  });
}

class MemoryResponsibilityRecoveryStore implements ResponsibilityRecoveryStore {
  final Map<String, ResponsibilityJson> values = {};
  @override
  Future<ResponsibilityJson?> read(ResponsibilityOwner owner) async =>
      values[owner.key];
  @override
  Future<void> write(
    ResponsibilityOwner owner,
    ResponsibilityJson value, {
    required bool Function() isCurrent,
  }) async {
    responsibilityRequire(isCurrent());
    values[owner.key] = freezeResponsibility(value) as ResponsibilityJson;
  }
}
