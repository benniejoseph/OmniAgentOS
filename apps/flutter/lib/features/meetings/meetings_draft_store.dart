import 'dart:async';
import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import '../../core/storage/ciphertext_recovery_broker.dart';
import '../../core/storage/secure_session_store.dart';
import 'meetings_access.dart';
import 'meetings_mutations.dart';
import 'meetings_validation.dart';

abstract interface class MeetingDraftStore {
  Future<MeetingJson?> read(MeetingsOwner owner, String route);
  Future<void> write(
    MeetingsOwner owner,
    String route,
    MeetingJson payload, {
    required bool Function() isCurrent,
  });
}

/// Encrypted local drafts and exact uncertain requests, never bearer tokens,
/// media bytes, preview credentials, or automatic queued effects.
class EncryptedMeetingDraftStore implements MeetingDraftStore {
  EncryptedMeetingDraftStore(this.secret, {CiphertextRecoveryBroker? broker})
    : broker = broker ?? createCiphertextRecoveryBroker();
  final Future<DeviceSecretMaterial> Function() secret;
  final CiphertextRecoveryBroker broker;
  final AesGcm cipher = AesGcm.with256bits();
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

  Future<(RecoveryAddress, DeviceSecretMaterial, String)> _context(
    MeetingsOwner owner,
    String route,
  ) async {
    meetingId(route);
    final binding = jsonEncode(['asael-meeting-draft:1', owner.key, route]),
        material = await secret();
    meetingRequire(
      material.bytes.length == 32 &&
          RegExp(r'^[A-Za-z0-9_-]{24}$').hasMatch(material.id),
    );
    return (
      RecoveryAddress(
        RecoveryNamespace.meetings,
        material.id,
        await meetingShaText(binding),
      ),
      material,
      binding,
    );
  }

  @override
  Future<MeetingJson?> read(MeetingsOwner owner, String route) =>
      _serial(() async {
        final (address, material, binding) = await _context(owner, route);
        final record = '${material.id}:$binding';
        _reloadRequired.add(record);
        final stored = await broker.read(address);
        if (stored.content == null) {
          meetingRequire(stored.sha256 == null);
          _knownCiphertext[record] = null;
          _reloadRequired.remove(record);
          return null;
        }
        meetingRequire(
          stored.sha256 == await recoveryCiphertextHash(stored.content!),
        );
        final envelope = meetingMap(jsonDecode(stored.content!));
        meetingRequire(envelope['version'] == 1);
        final bytes = await cipher.decrypt(
          SecretBox(
            base64Decode(meetingText(envelope['ciphertext'], max: 4000000)),
            nonce: base64Decode(meetingText(envelope['nonce'], max: 64)),
            mac: Mac(base64Decode(meetingText(envelope['mac'], max: 64))),
          ),
          secretKey: SecretKey(material.bytes),
          aad: utf8.encode(binding),
        );
        try {
          final value = meetingMap(jsonDecode(utf8.decode(bytes)));
          meetingRequire(
            value['binding'] == binding && value['schemaVersion'] == 1,
          );
          final payload =
              freezeMeeting(meetingMap(value['payload'])) as MeetingJson;
          _knownCiphertext[record] = stored.sha256;
          _reloadRequired.remove(record);
          return payload;
        } finally {
          bytes.fillRange(0, bytes.length, 0);
        }
      });
  @override
  Future<void> write(
    MeetingsOwner owner,
    String route,
    MeetingJson payload, {
    required bool Function() isCurrent,
  }) {
    final frozen = freezeMeeting(payload);
    return _serial(() async {
      if (!isCurrent()) {
        throw StateError('Meeting draft access changed.');
      }
      final (address, material, binding) = await _context(owner, route);
      final record = '${material.id}:$binding';
      if (_reloadRequired.contains(record)) {
        throw const RecoveryStorageUnknown();
      }
      final plain = utf8.encode(
        jsonEncode({'schemaVersion': 1, 'binding': binding, 'payload': frozen}),
      );
      meetingRequire(plain.length <= 2500000);
      late SecretBox box;
      try {
        box = await cipher.encrypt(
          plain,
          secretKey: SecretKey(material.bytes),
          nonce: cipher.newNonce(),
          aad: utf8.encode(binding),
        );
      } finally {
        plain.fillRange(0, plain.length, 0);
      }
      if (!isCurrent()) {
        throw StateError('Meeting draft access changed.');
      }
      final ciphertext = jsonEncode({
        'version': 1,
        'nonce': base64Encode(box.nonce),
        'ciphertext': base64Encode(box.cipherText),
        'mac': base64Encode(box.mac.bytes),
      });
      try {
        final digest = await broker.compareAndSwap(
          address,
          expectedSha256: _knownCiphertext[record],
          ciphertext: ciphertext,
        );
        if (digest != await recoveryCiphertextHash(ciphertext) ||
            !isCurrent()) {
          throw const RecoveryStorageUnknown();
        }
        _knownCiphertext[record] = digest;
      } on RecoveryStorageChanged {
        _reloadRequired.add(record);
        rethrow;
      } on RecoveryStorageCapacity {
        rethrow;
      } catch (_) {
        _reloadRequired.add(record);
        throw const RecoveryStorageUnknown();
      }
    });
  }
}

class MemoryMeetingDraftStore implements MeetingDraftStore {
  final Map<String, MeetingJson> values = {};
  @override
  Future<MeetingJson?> read(MeetingsOwner owner, String route) async =>
      values['${owner.key}\u0000$route'];
  @override
  Future<void> write(
    MeetingsOwner owner,
    String route,
    MeetingJson payload, {
    required bool Function() isCurrent,
  }) async {
    if (!isCurrent()) {
      throw StateError('Meeting draft access changed.');
    }
    values['${owner.key}\u0000$route'] = freezeMeeting(payload) as MeetingJson;
  }
}
