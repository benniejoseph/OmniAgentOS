import 'dart:async';
import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import '../../core/storage/ciphertext_recovery_broker.dart';
import '../../core/storage/secure_session_store.dart';
import 'knowledge_contracts.dart';
import 'knowledge_mutations.dart';

abstract interface class KnowledgeRecoveryStore {
  Future<KnowledgeJson?> read(KnowledgeOwner owner);
  Future<void> write(
    KnowledgeOwner owner,
    KnowledgeJson value,
    bool Function() isCurrent,
  );
}

/// One encrypted action slot per canonical user, tenant and deployment. Role or
/// email changes cannot hide an earlier unknown write and permit a new key.
class EncryptedKnowledgeRecoveryStore implements KnowledgeRecoveryStore {
  EncryptedKnowledgeRecoveryStore(
    this.secret, {
    CiphertextRecoveryBroker? broker,
  }) : broker = broker ?? createCiphertextRecoveryBroker();
  final Future<DeviceSecretMaterial> Function() secret;
  final CiphertextRecoveryBroker broker;
  final _cipher = AesGcm.with256bits();
  final Map<String, String?> _known = {};
  final Set<String> _blocked = {};
  static Future<void> _barrier = Future.value();
  Future<T> _serial<T>(Future<T> Function() operation) {
    final result = Completer<T>();
    _barrier = _barrier.catchError((Object _) {}).then((_) async {
      try {
        result.complete(await operation());
      } catch (error, stack) {
        result.completeError(error, stack);
      }
    });
    return result.future;
  }

  Future<(RecoveryAddress, DeviceSecretMaterial, String)> _context(
    KnowledgeOwner owner,
  ) async {
    final material = await secret(),
        binding = memoryCanonical([
          'asael-memory-submissions:1',
          owner.tenantId,
          owner.userId,
          owner.apiBaseUrl,
        ]);
    memoryRequire(
      material.bytes.length == 32 &&
          RegExp(r'^[A-Za-z0-9_-]{24}$').hasMatch(material.id),
    );
    return (
      RecoveryAddress(
        RecoveryNamespace.memory,
        material.id,
        await memoryShaText(binding),
      ),
      material,
      binding,
    );
  }

  @override
  Future<KnowledgeJson?> read(KnowledgeOwner owner) => _serial(() async {
    final (address, material, binding) = await _context(owner);
    final stored = await broker.read(address);
    if (stored.content == null) {
      _known[binding] = null;
      _blocked.remove(binding);
      return null;
    }
    final envelope = knowledgeMap(
      jsonDecode(stored.content!),
      'Protected Memory envelope',
    );
    memoryRequire(
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
      final decoded = knowledgeMap(
        jsonDecode(utf8.decode(bytes)),
        'Protected Memory submission',
      );
      memoryRequire(
        decoded['schemaVersion'] == 1 && decoded['binding'] == binding,
      );
      final payload = knowledgeMap(
        decoded['payload'],
        'Memory recovery payload',
      );
      _known[binding] = stored.sha256;
      _blocked.remove(binding);
      return freezeKnowledgeJson(payload) as KnowledgeJson;
    } finally {
      bytes.fillRange(0, bytes.length, 0);
    }
  });
  @override
  Future<void> write(
    KnowledgeOwner owner,
    KnowledgeJson value,
    bool Function() isCurrent,
  ) {
    final frozen = freezeKnowledgeJson(value);
    return _serial(() async {
      memoryRequire(isCurrent(), 'Memory recovery authority changed.');
      final (address, material, binding) = await _context(owner);
      if (!_known.containsKey(binding) || _blocked.contains(binding)) {
        throw const RecoveryStorageUnknown();
      }
      final plain = utf8.encode(
        jsonEncode({'schemaVersion': 1, 'binding': binding, 'payload': frozen}),
      );
      memoryRequire(
        plain.length <= 3000000,
        'Protected Memory recovery is full. Existing submissions are retained.',
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
      memoryRequire(isCurrent(), 'Memory recovery authority changed.');
      final content = jsonEncode({
        'version': 1,
        'algorithm': 'aes-256-gcm',
        'nonce': base64Encode(encrypted.nonce),
        'ciphertext': base64Encode(encrypted.cipherText),
        'mac': base64Encode(encrypted.mac.bytes),
      });
      try {
        _known[binding] = await broker.compareAndSwap(
          address,
          expectedSha256: _known[binding],
          ciphertext: content,
        );
        memoryRequire(isCurrent(), 'Memory recovery authority changed.');
      } on RecoveryStorageCapacity {
        rethrow;
      } catch (_) {
        _blocked.add(binding);
        rethrow;
      }
    });
  }
}

class MemoryKnowledgeRecoveryStore implements KnowledgeRecoveryStore {
  final Map<String, KnowledgeJson> values = {};
  String _key(KnowledgeOwner owner) =>
      '${owner.tenantId}\u0000${owner.userId}\u0000${owner.apiBaseUrl}';
  @override
  Future<KnowledgeJson?> read(KnowledgeOwner owner) async =>
      values[_key(owner)];
  @override
  Future<void> write(
    KnowledgeOwner owner,
    KnowledgeJson value,
    bool Function() isCurrent,
  ) async {
    memoryRequire(isCurrent());
    values[_key(owner)] = freezeKnowledgeJson(value) as KnowledgeJson;
  }
}
