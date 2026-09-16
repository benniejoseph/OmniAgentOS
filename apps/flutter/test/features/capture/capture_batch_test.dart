import 'dart:async';
import 'dart:typed_data';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/capture/capture.dart';
import 'package:asael/features/capture/capture_outbox.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const owner = CaptureOwnerBinding(
    tenantId: 'tenant-one',
    actorId: 'actor:one',
  );

  test(
    'uploads at most three documents concurrently and tracks completion',
    () async {
      final repository = _BatchRepository(blockUploads: true);
      final outbox = _MemoryOutbox();
      final controller = CaptureController(
        repository,
        outbox,
        owner,
        batchPollInterval: Duration.zero,
        batchPollRounds: 2,
        delay: (_) async {},
      );
      final names = List.generate(5, (index) => 'lesson-$index.vtt');

      final result = await controller.submitBatch(
        names,
        (index) async => _draft(names[index]),
      );
      await repository.threeUploadsStarted.future;

      expect(result.queued, 5);
      expect(repository.peakUploads, 3);
      expect(
        controller.batchItems.where(
          (item) => item.state == CaptureBatchState.uploading,
        ),
        hasLength(3),
      );

      repository.releaseUploads.complete();
      await controller.batchWork;

      expect(controller.pending, isEmpty);
      expect(
        controller.batchItems.map((item) => item.state),
        everyElement(CaptureBatchState.completed),
      );
      expect(repository.submittedKeys.toSet(), hasLength(5));
    },
  );

  test('keeps a local encrypted copy when all upload retries fail', () async {
    final repository = _BatchRepository()..failUploads = true;
    final outbox = _MemoryOutbox();
    final controller = CaptureController(
      repository,
      outbox,
      owner,
      batchPollInterval: Duration.zero,
      batchPollRounds: 1,
      delay: (_) async {},
    );

    final result = await controller.submitBatch(const [
      'offline.vtt',
    ], (_) async => _draft('offline.vtt'));
    await controller.batchWork;

    expect(result.queued, 1);
    expect(repository.uploadAttempts, 3);
    expect(controller.pending, hasLength(1));
    expect(controller.batchItems.single.state, CaptureBatchState.failed);
    expect(controller.batchItems.single.retryable, isTrue);
  });

  test(
    'does not claim completion until the published job receipt completes',
    () async {
      final repository = _BatchRepository()..jobStatus = 'running';
      final outbox = _MemoryOutbox();
      final controller = CaptureController(
        repository,
        outbox,
        owner,
        batchPollInterval: Duration.zero,
        batchPollRounds: 1,
        delay: (_) async {},
      );

      await controller.submitBatch(const [
        'liquidity.srt',
      ], (_) async => _draft('liquidity.srt'));
      await controller.batchWork;

      expect(controller.batchItems.single.state, CaptureBatchState.processing);
      expect(controller.batchItems.single.retryable, isTrue);
      expect(controller.pending, hasLength(1));

      repository.jobStatus = 'completed';
      await controller.refreshBatchProgress();

      expect(controller.batchItems.single.state, CaptureBatchState.completed);
      expect(controller.pending, isEmpty);
    },
  );

  test('macOS restart resumes queued files and tracks the real job', () async {
    final repository = _BatchRepository();
    final outbox = _MemoryOutbox();
    final restored = await outbox.enqueue(owner, _draft('restored.vtt'));
    final controller = CaptureController(
      repository,
      outbox,
      owner,
      resumeBatchProcessing: true,
      batchPollInterval: Duration.zero,
      batchPollRounds: 1,
      delay: (_) async {},
    );

    await controller.initialize();

    expect(repository.submittedKeys, [restored.idempotencyKey]);
    expect(controller.batchItems.single.name, 'restored.vtt');
    expect(controller.batchItems.single.state, CaptureBatchState.completed);
    expect(controller.pending, isEmpty);
  });
}

CaptureDraft _draft(String name) => CaptureDraft(
  content: '',
  title: name,
  file: CaptureAttachment(
    name: name,
    bytes: Uint8List.fromList([1, 2, 3]),
    contentType: name.endsWith('.vtt') ? 'text/vtt' : 'application/x-subrip',
  ),
  kind: CaptureKind.file,
);

class _BatchRepository implements CaptureRepository {
  _BatchRepository({this.blockUploads = false});

  final bool blockUploads;
  final releaseUploads = Completer<void>();
  final threeUploadsStarted = Completer<void>();
  final submittedKeys = <String>[];
  bool failUploads = false;
  String jobStatus = 'completed';
  int activeUploads = 0;
  int peakUploads = 0;
  int uploadAttempts = 0;

  @override
  Future<CaptureReceipt> submit(
    CaptureDraft draft, {
    required String idempotencyKey,
    required CaptureOwnerBinding owner,
  }) async {
    uploadAttempts += 1;
    activeUploads += 1;
    peakUploads = activeUploads > peakUploads ? activeUploads : peakUploads;
    if (activeUploads == 3 && !threeUploadsStarted.isCompleted) {
      threeUploadsStarted.complete();
    }
    if (blockUploads) await releaseUploads.future;
    activeUploads -= 1;
    submittedKeys.add(idempotencyKey);
    if (failUploads) throw const ApiException('offline');
    return CaptureReceipt(
      jobId: 'job-${draft.file!.name}',
      title: draft.title,
      tags: const [],
      jobStatus: 'queued',
      progressStage: 'queued',
    );
  }

  @override
  Future<CaptureJobSnapshot> readJob(
    String jobId, {
    required CaptureOwnerBinding owner,
  }) async => CaptureJobSnapshot(
    id: jobId,
    status: jobStatus,
    progressStage: jobStatus,
  );
}

class _MemoryOutbox implements CaptureOutbox {
  final entries = <CaptureOutboxEntry>[];
  int nextId = 0;

  @override
  Future<CaptureOutboxEntry> enqueue(
    CaptureOwnerBinding owner,
    CaptureDraft draft,
  ) async {
    final suffix = nextId.toString().padLeft(4, '0');
    nextId += 1;
    final id = 'aaaaaaaaaaaaaaaaaaaa$suffix';
    final entry = CaptureOutboxEntry(
      id: id,
      tenantId: owner.tenantId,
      actorId: owner.actorId,
      createdAt: DateTime.utc(2026, 9, 16),
      idempotencyKey: 'capture-offline-$id',
      draft: draft,
    );
    entries.add(entry);
    return entry;
  }

  @override
  Future<CaptureOutboxEntry?> get(
    CaptureOwnerBinding owner,
    String entryId,
  ) async => entries
      .where((entry) => entry.id == entryId && owner.owns(entry))
      .firstOrNull;

  @override
  Future<List<CaptureOutboxEntry>> list(CaptureOwnerBinding owner) async =>
      entries.where(owner.owns).toList();

  @override
  Future<void> remove(CaptureOwnerBinding owner, String entryId) async {
    entries.removeWhere((entry) => entry.id == entryId && owner.owns(entry));
  }
}
