import 'dart:async';
import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import '../../core/storage/ciphertext_recovery_broker.dart';
import '../../core/storage/secure_session_store.dart';
import 'markets_contracts.dart';

abstract interface class MarketsRecoveryStore {
  Future<MarketJson?> read(MarketsOwner owner, String project);
  Future<void> write(
    MarketsOwner owner,
    String project,
    MarketJson value, {
    required bool Function() isCurrent,
  });
}

/// Durable intent and editable recovery only. No queued or replayable operation.
/// Unknown outcomes are never aged out or pruned to make room for another write.
class EncryptedMarketsRecoveryStore implements MarketsRecoveryStore {
  EncryptedMarketsRecoveryStore(this.secret, {CiphertextRecoveryBroker? broker})
    : broker = broker ?? createCiphertextRecoveryBroker();
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

  String _binding(MarketsOwner owner, String project) => jsonEncode([
    'asael-markets-recovery:1',
    owner.key,
    marketText(project, 120),
  ]);
  Future<String> _digest(String input) async =>
      (await Sha256().hash(utf8.encode(input))).bytes
          .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
          .join();
  Future<(RecoveryAddress, DeviceSecretMaterial, String)> _context(
    MarketsOwner owner,
    String project,
  ) async {
    final binding = _binding(owner, project), material = await secret();
    marketRequire(
      material.bytes.length == 32 &&
          RegExp(r'^[A-Za-z0-9_-]{24}$').hasMatch(material.id),
      'Protected Markets recovery is unavailable.',
    );
    return (
      RecoveryAddress(
        RecoveryNamespace.markets,
        material.id,
        await _digest(binding),
      ),
      material,
      binding,
    );
  }

  @override
  Future<MarketJson?> read(MarketsOwner owner, String project) =>
      _serial(() async {
        final (address, material, binding) = await _context(owner, project);
        final stored = await broker.read(address);
        if (stored.content == null) {
          _knownCiphertext[binding] = null;
          _reloadRequired.remove(binding);
          return null;
        }
        final envelope = marketMap(jsonDecode(stored.content!));
        marketRequire(
          envelope['version'] == 1 && envelope['algorithm'] == 'aes-256-gcm',
        );
        final bytes = await _cipher.decrypt(
          SecretBox(
            base64Decode(marketText(envelope['ciphertext'], 262144)),
            nonce: base64Decode(marketText(envelope['nonce'], 64)),
            mac: Mac(base64Decode(marketText(envelope['mac'], 64))),
          ),
          secretKey: SecretKey(material.bytes),
          aad: utf8.encode(binding),
        );
        try {
          final value = marketMap(jsonDecode(utf8.decode(bytes)));
          marketRequire(
            value['binding'] == binding && value['schemaVersion'] == 1,
          );
          _knownCiphertext[binding] = stored.sha256;
          _reloadRequired.remove(binding);
          return marketFreeze(marketMap(value['payload']));
        } finally {
          bytes.fillRange(0, bytes.length, 0);
        }
      });
  @override
  Future<void> write(
    MarketsOwner owner,
    String project,
    MarketJson value, {
    required bool Function() isCurrent,
  }) => _serial(() async {
    if (!isCurrent()) {
      throw StateError('Markets recovery authority changed.');
    }
    final frozen = marketFreeze(value);
    final (address, material, binding) = await _context(owner, project);
    if (_reloadRequired.contains(binding)) {
      throw const RecoveryStorageUnknown();
    }
    final plain = utf8.encode(
      jsonEncode({'schemaVersion': 1, 'binding': binding, 'payload': frozen}),
    );
    marketRequire(
      plain.length <= 180000,
      'Markets draft recovery is full; shorten the local draft before saving.',
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
      throw StateError('Markets recovery authority changed.');
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

class MemoryMarketsRecoveryStore implements MarketsRecoveryStore {
  final Map<String, MarketJson> _values = {};
  @override
  Future<MarketJson?> read(MarketsOwner owner, String project) async =>
      _values['${owner.key}\u0000$project'];
  @override
  Future<void> write(
    MarketsOwner owner,
    String project,
    MarketJson value, {
    required bool Function() isCurrent,
  }) async {
    if (!isCurrent()) {
      throw StateError('Markets recovery authority changed.');
    }
    _values['${owner.key}\u0000$project'] = marketFreeze(value);
  }
}
