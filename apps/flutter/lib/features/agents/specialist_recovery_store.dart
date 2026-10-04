import 'dart:async';
import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import '../../core/storage/ciphertext_recovery_broker.dart';
import '../../core/storage/secure_session_store.dart';
import 'specialist_contracts.dart';

abstract interface class SpecialistRecoveryStore {
  Future<SpecialistJson?> read(SpecialistOwner owner, String project);
  Future<void> write(
    SpecialistOwner owner,
    String project,
    SpecialistJson value, {
    required bool Function() isCurrent,
  });
}

/// Content-free decision recovery only. No queued or replayable operation.
/// Unknown outcomes are never aged out or pruned to make room for another write.
class EncryptedSpecialistRecoveryStore implements SpecialistRecoveryStore {
  EncryptedSpecialistRecoveryStore(
    this.secret, {
    CiphertextRecoveryBroker? broker,
  }) : broker = broker ?? createCiphertextRecoveryBroker();
  final Future<DeviceSecretMaterial> Function() secret;
  final CiphertextRecoveryBroker broker;
  final AesGcm _cipher = AesGcm.with256bits();
  final Map<String, String?> _knownCiphertext = {};
  final Set<String> _reloadRequired = {};
  Future<void> _barrier = Future.value();
  Future<T> _serial<T>(Future<T> Function() body) {
    final result = Completer<T>();
    _barrier = _barrier.catchError((Object _) {}).then((_) async {
      try {
        result.complete(await body());
      } catch (error, stack) {
        result.completeError(error, stack);
      }
    });
    return result.future;
  }

  String _binding(SpecialistOwner owner, String project) => jsonEncode([
    'asael-specialist-recovery:1',
    owner.key,
    specialistText(project, 120),
  ]);
  Future<String> _digest(String input) async =>
      (await Sha256().hash(utf8.encode(input))).bytes
          .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
          .join();
  Future<(RecoveryAddress, DeviceSecretMaterial, String)> _context(
    SpecialistOwner owner,
    String project,
  ) async {
    final binding = _binding(owner, project), material = await secret();
    specialistRequire(
      material.bytes.length == 32 &&
          RegExp(r'^[A-Za-z0-9_-]{24}$').hasMatch(material.id),
      'Protected Specialist recovery is unavailable.',
    );
    return (
      RecoveryAddress(
        RecoveryNamespace.specialist,
        material.id,
        await _digest(binding),
      ),
      material,
      binding,
    );
  }

  @override
  Future<SpecialistJson?> read(SpecialistOwner owner, String project) =>
      _serial(() async {
        final (address, material, binding) = await _context(owner, project);
        final stored = await broker.read(address);
        if (stored.content == null) {
          _knownCiphertext[binding] = null;
          _reloadRequired.remove(binding);
          return null;
        }
        final envelope = specialistMap(jsonDecode(stored.content!));
        specialistRequire(
          envelope['version'] == 1 && envelope['algorithm'] == 'aes-256-gcm',
        );
        final bytes = await _cipher.decrypt(
          SecretBox(
            base64Decode(specialistText(envelope['ciphertext'], 1048576)),
            nonce: base64Decode(specialistText(envelope['nonce'], 64)),
            mac: Mac(base64Decode(specialistText(envelope['mac'], 64))),
          ),
          secretKey: SecretKey(material.bytes),
          aad: utf8.encode(binding),
        );
        try {
          final value = specialistMap(jsonDecode(utf8.decode(bytes)));
          specialistRequire(
            value['binding'] == binding && value['schemaVersion'] == 1,
          );
          _knownCiphertext[binding] = stored.sha256;
          _reloadRequired.remove(binding);
          return specialistFreeze(specialistMap(value['payload']));
        } finally {
          bytes.fillRange(0, bytes.length, 0);
        }
      });
  @override
  Future<void> write(
    SpecialistOwner owner,
    String project,
    SpecialistJson value, {
    required bool Function() isCurrent,
  }) => _serial(() async {
    if (!isCurrent()) {
      throw StateError('Specialist recovery authority changed.');
    }
    final frozen = specialistFreeze(value);
    final (address, material, binding) = await _context(owner, project);
    if (_reloadRequired.contains(binding)) {
      throw const RecoveryStorageUnknown();
    }
    final plain = utf8.encode(
      jsonEncode({'schemaVersion': 1, 'binding': binding, 'payload': frozen}),
    );
    specialistRequire(
      plain.length <= 700000,
      'Protected decision recovery is full. Inspect outstanding decisions and dismiss accepted receipts before another write.',
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
    final content = jsonEncode({
      'version': 1,
      'algorithm': 'aes-256-gcm',
      'nonce': base64Encode(encrypted.nonce),
      'ciphertext': base64Encode(encrypted.cipherText),
      'mac': base64Encode(encrypted.mac.bytes),
    });
    if (!isCurrent()) {
      throw StateError('Specialist recovery authority changed.');
    }
    try {
      _knownCiphertext[binding] = await broker.compareAndSwap(
        address,
        expectedSha256: _knownCiphertext[binding],
        ciphertext: content,
      );
      if (!isCurrent()) {
        throw const RecoveryStorageUnknown();
      }
    } on RecoveryStorageChanged {
      _reloadRequired.add(binding);
      rethrow;
    } on RecoveryStorageCapacity {
      rethrow;
    } catch (_) {
      _reloadRequired.add(binding);
      throw const RecoveryStorageUnknown();
    }
  });
}

class MemorySpecialistRecoveryStore implements SpecialistRecoveryStore {
  final Map<String, SpecialistJson> _values = {};
  @override
  Future<SpecialistJson?> read(SpecialistOwner owner, String project) async =>
      _values['${owner.key}\u0000$project'];
  @override
  Future<void> write(
    SpecialistOwner owner,
    String project,
    SpecialistJson value, {
    required bool Function() isCurrent,
  }) async {
    if (!isCurrent()) {
      throw StateError('Specialist recovery authority changed.');
    }
    _values['${owner.key}\u0000$project'] = specialistFreeze(value);
  }
}
