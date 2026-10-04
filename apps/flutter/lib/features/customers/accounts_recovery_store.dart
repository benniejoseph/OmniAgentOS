import 'dart:async';
import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import '../../core/storage/ciphertext_recovery_broker.dart';
import '../../core/storage/secure_session_store.dart';
import 'accounts_contracts.dart';
import 'accounts_mutation_contracts.dart';

abstract interface class AccountsRecoveryStore {
  Future<AccountJson?> read(AccountsOwner owner, String workspace);
  Future<void> write(
    AccountsOwner owner,
    String workspace,
    AccountJson value, {
    required bool Function() isCurrent,
  });
}

/// Ciphertext-only host CAS. One owner/workspace journal; no effect queue.
class EncryptedAccountsRecoveryStore implements AccountsRecoveryStore {
  EncryptedAccountsRecoveryStore(
    this.secret, {
    CiphertextRecoveryBroker? broker,
  }) : broker = broker ?? createCiphertextRecoveryBroker();
  final Future<DeviceSecretMaterial> Function() secret;
  final CiphertextRecoveryBroker broker;
  final _cipher = AesGcm.with256bits();
  final Map<String, String?> _known = {};
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

  Future<(RecoveryAddress, DeviceSecretMaterial, String)> _context(
    AccountsOwner owner,
    String workspace,
  ) async {
    accountRequire(accountId(workspace).startsWith('workspace:'));
    final binding = jsonEncode([
          'asael-accounts-recovery:1',
          owner.key,
          workspace,
        ]),
        material = await secret();
    accountRequire(
      material.bytes.length == 32 &&
          RegExp(r'^[A-Za-z0-9_-]{24}$').hasMatch(material.id),
    );
    return (
      RecoveryAddress(
        RecoveryNamespace.accounts,
        material.id,
        await accountRawSha(binding),
      ),
      material,
      binding,
    );
  }

  @override
  Future<AccountJson?> read(AccountsOwner owner, String workspace) =>
      _serial(() async {
        final (address, material, binding) = await _context(owner, workspace);
        final stored = await broker.read(address);
        if (stored.content == null) {
          _known[binding] = null;
          _reloadRequired.remove(binding);
          return null;
        }
        final envelope = accountMap(jsonDecode(stored.content!));
        accountKeys(envelope, [
          'version',
          'algorithm',
          'nonce',
          'ciphertext',
          'mac',
        ]);
        accountRequire(
          envelope['version'] == 1 && envelope['algorithm'] == 'aes-256-gcm',
        );
        final bytes = await _cipher.decrypt(
          SecretBox(
            base64Decode(accountText(envelope['ciphertext'], 1048576)),
            nonce: base64Decode(accountText(envelope['nonce'], 64)),
            mac: Mac(base64Decode(accountText(envelope['mac'], 64))),
          ),
          secretKey: SecretKey(material.bytes),
          aad: utf8.encode(binding),
        );
        try {
          final value = accountMap(jsonDecode(utf8.decode(bytes)));
          accountKeys(value, ['schemaVersion', 'binding', 'payload']);
          accountRequire(
            value['schemaVersion'] == 1 && value['binding'] == binding,
          );
          final payload = accountFreeze(accountMap(value['payload']));
          _known[binding] = stored.sha256;
          _reloadRequired.remove(binding);
          return payload;
        } finally {
          bytes.fillRange(0, bytes.length, 0);
        }
      });

  @override
  Future<void> write(
    AccountsOwner owner,
    String workspace,
    AccountJson value, {
    required bool Function() isCurrent,
  }) => _serial(() async {
    accountRequire(isCurrent(), 'Account recovery access changed.');
    final frozen = accountFreeze(value);
    final (address, material, binding) = await _context(owner, workspace);
    if (_reloadRequired.contains(binding) || !_known.containsKey(binding)) {
      throw const RecoveryStorageUnknown();
    }
    final plain = utf8.encode(
      jsonEncode({'schemaVersion': 1, 'binding': binding, 'payload': frozen}),
    );
    accountRequire(
      plain.length <= 700000,
      'The protected Account journal is full. Existing recovery is retained.',
    );
    late SecretBox box;
    try {
      box = await _cipher.encrypt(
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
      'nonce': base64Encode(box.nonce),
      'ciphertext': base64Encode(box.cipherText),
      'mac': base64Encode(box.mac.bytes),
    });
    accountRequire(isCurrent(), 'Account recovery access changed.');
    try {
      _known[binding] = await broker.compareAndSwap(
        address,
        expectedSha256: _known[binding],
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

class MemoryAccountsRecoveryStore implements AccountsRecoveryStore {
  final Map<String, AccountJson> _values = {};
  @override
  Future<AccountJson?> read(AccountsOwner owner, String workspace) async =>
      _values['${owner.key}\u0000$workspace'];
  @override
  Future<void> write(
    AccountsOwner owner,
    String workspace,
    AccountJson value, {
    required bool Function() isCurrent,
  }) async {
    accountRequire(isCurrent());
    _values['${owner.key}\u0000$workspace'] = accountFreeze(value);
  }
}
