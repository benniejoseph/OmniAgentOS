import 'dart:typed_data';

import 'package:asael/core/storage/ciphertext_recovery_broker.dart';
import 'package:asael/core/storage/secure_session_store.dart';

final meetingRecoverySecret = DeviceSecretMaterial(
  id: 'abcdefghijklmnopqrstuvwx',
  bytes: Uint8List.fromList(List.generate(32, (index) => index + 1)),
);

/// Fault/barrier injection surrounds the real local broker's file transaction.
/// It never substitutes an in-memory write for the compare-and-swap operation.
class MeetingTestRecoveryBroker implements CiphertextRecoveryBroker {
  MeetingTestRecoveryBroker(this.delegate);
  final CiphertextRecoveryBroker delegate;
  int reads = 0, writes = 0;
  Future<void> Function()? beforeRead;
  Future<void> Function()? afterRead;
  Future<void> Function(int)? beforeWrite;
  Future<void> Function(int)? afterWrite;

  @override
  Future<RecoveryCiphertext> read(RecoveryAddress address) async {
    reads++;
    await beforeRead?.call();
    final result = await delegate.read(address);
    await afterRead?.call();
    return result;
  }

  @override
  Future<String> compareAndSwap(
    RecoveryAddress address, {
    required String? expectedSha256,
    required String ciphertext,
  }) async {
    final attempt = ++writes;
    await beforeWrite?.call(attempt);
    final result = await delegate.compareAndSwap(
      address,
      expectedSha256: expectedSha256,
      ciphertext: ciphertext,
    );
    await afterWrite?.call(attempt);
    return result;
  }
}
