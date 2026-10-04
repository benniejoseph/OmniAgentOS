import 'dart:typed_data';

import 'package:asael/core/storage/ciphertext_recovery_broker.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/knowledge/knowledge_mutations.dart';
import 'package:asael/features/knowledge/knowledge_recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';

class Broker implements CiphertextRecoveryBroker {
  final values = <String, RecoveryCiphertext>{};
  bool loseResponse = false;
  String key(RecoveryAddress address) =>
      '${address.namespace.name}/${address.secretId}/${address.recordKey}';
  @override
  Future<RecoveryCiphertext> read(RecoveryAddress address) async =>
      values[key(address)] ?? const RecoveryCiphertext(null, null);
  @override
  Future<String> compareAndSwap(
    RecoveryAddress address, {
    required String? expectedSha256,
    required String ciphertext,
  }) async {
    final previous = values[key(address)];
    if (previous?.sha256 != expectedSha256) {
      throw const RecoveryStorageChanged();
    }
    final hash = await recoveryCiphertextHash(ciphertext);
    values[key(address)] = RecoveryCiphertext(ciphertext, hash);
    if (loseResponse) throw const RecoveryStorageUnknown();
    return hash;
  }
}

const owner = KnowledgeOwner(
  'tenant',
  'one@example.test',
  '00000000-0000-4000-8000-000000000001',
  'operator',
  'https://example.test',
);
void main() {
  test('separate stores share CAS and role changes still find the same protected intent', () async {
    final broker = Broker();
    Future<DeviceSecretMaterial> secret() async => DeviceSecretMaterial(
      id: 'a' * 24,
      bytes: Uint8List.fromList(List<int>.filled(32, 7)),
    );
    final first = EncryptedKnowledgeRecoveryStore(secret, broker: broker),
        second = EncryptedKnowledgeRecoveryStore(secret, broker: broker);
    await first.read(owner);
    await second.read(owner);
    final sent = MemorySubmission(
      kind: MemoryChange.create,
      owner: owner,
      body: {'title': 'Private', 'content': 'Sensitive fact'},
      key: 'fixed',
    );
    final payload = {
      'version': 1,
      'state': 'pending',
      'submission': sent.recovery,
    };
    await first.write(owner, payload, () => true);
    expect(
      broker.values.values.single.content,
      isNot(contains('Sensitive fact')),
    );
    await expectLater(
      second.write(owner, {
        'version': 1,
        'state': 'refused',
        'submission': sent.recovery,
      }, () => true),
      throwsA(isA<RecoveryStorageChanged>()),
    );
    final newRole = KnowledgeOwner(
      owner.tenantId,
      owner.actorId,
      owner.userId,
      'viewer',
      owner.apiBaseUrl,
    );
    final loaded = await second.read(newRole);
    expect(loaded!['state'], 'pending');
    expect(
      MemorySubmission.restore(loaded['submission'], newRole).owner.role,
      'operator',
    );
  });
  test('a lost protected save response requires exact read before any further write', () async {
    final broker = Broker()..loseResponse = true;
    Future<DeviceSecretMaterial> secret() async => DeviceSecretMaterial(
      id: 'b' * 24,
      bytes: Uint8List.fromList(List<int>.filled(32, 8)),
    );
    final store = EncryptedKnowledgeRecoveryStore(secret, broker: broker);
    await store.read(owner);
    await expectLater(
      store.write(owner, {'state': 'pending'}, () => true),
      throwsA(isA<RecoveryStorageUnknown>()),
    );
    broker.loseResponse = false;
    await expectLater(
      store.write(owner, {'state': 'replacement'}, () => true),
      throwsA(isA<RecoveryStorageUnknown>()),
    );
    expect((await store.read(owner))!['state'], 'pending');
  });
}
