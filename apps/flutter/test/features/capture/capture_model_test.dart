import 'dart:typed_data';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/capture/capture.dart';
import 'package:asael/features/capture/capture_outbox.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('allows an attachment-only capture within the governed draft', () {
    final draft = CaptureDraft(
      content: '',
      file: CaptureAttachment(
        name: 'launch-brief.pdf',
        bytes: Uint8List.fromList([1, 2, 3]),
        contentType: 'application/pdf',
      ),
    );

    expect(draft.valid, isTrue);
    expect(draft.file?.name, 'launch-brief.pdf');
  });

  test('rejects an empty text-only capture', () {
    expect(const CaptureDraft(content: '   ').valid, isFalse);
  });

  test(
    'keeps one stable idempotency key until an offline item syncs',
    () async {
      final repository = _CaptureRepository()..fail = true;
      final outbox = _MemoryOutbox();
      final controller = CaptureController(
        repository,
        outbox,
        const CaptureOwnerBinding(tenantId: 'tenant-one', actorId: 'actor:one'),
      );

      expect(
        await controller.submit(const CaptureDraft(content: 'Offline note')),
        isTrue,
      );
      expect(controller.lastSubmitQueued, isTrue);
      expect(controller.pending, hasLength(1));
      expect(repository.idempotencyKeys, [
        'capture-offline-abcdefghijklmnopqrstuvwx',
      ]);

      repository.fail = false;
      await controller.syncPending();
      expect(controller.pending, isEmpty);
      expect(repository.idempotencyKeys, [
        'capture-offline-abcdefghijklmnopqrstuvwx',
        'capture-offline-abcdefghijklmnopqrstuvwx',
      ]);
      expect(controller.receipt?.jobId, 'job-one');
    },
  );
}

class _CaptureRepository implements CaptureRepository {
  bool fail = false;
  final idempotencyKeys = <String>[];

  @override
  Future<CaptureReceipt> submit(
    CaptureDraft draft, {
    required String idempotencyKey,
    required CaptureOwnerBinding owner,
  }) async {
    idempotencyKeys.add(idempotencyKey);
    if (fail) throw const ApiException('offline');
    return const CaptureReceipt(jobId: 'job-one', title: 'Note', tags: []);
  }
}

class _MemoryOutbox implements CaptureOutbox {
  final entries = <CaptureOutboxEntry>[];

  @override
  Future<CaptureOutboxEntry> enqueue(
    CaptureOwnerBinding owner,
    CaptureDraft draft,
  ) async {
    final entry = CaptureOutboxEntry(
      id: 'abcdefghijklmnopqrstuvwx',
      tenantId: owner.tenantId,
      actorId: owner.actorId,
      createdAt: DateTime.utc(2026, 9, 8),
      idempotencyKey: 'capture-offline-abcdefghijklmnopqrstuvwx',
      draft: draft,
    );
    entries.add(entry);
    return entry;
  }

  @override
  Future<List<CaptureOutboxEntry>> list(CaptureOwnerBinding owner) async =>
      entries.where(owner.owns).toList();

  @override
  Future<void> remove(CaptureOwnerBinding owner, String entryId) async {
    entries.removeWhere((entry) => entry.id == entryId && owner.owns(entry));
  }
}
