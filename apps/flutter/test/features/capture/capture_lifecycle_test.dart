import 'dart:async';

import 'package:asael/core/network/api_exception.dart';
import 'package:asael/features/capture/capture_controller.dart';
import 'package:asael/features/capture/capture_models.dart';
import 'package:asael/features/capture/capture_projection.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_support.dart';

Future<void> _flush() => Future<void>.delayed(Duration.zero);
void main() {
  test(
    'locking during the post-enqueue list prevents any stale-session upload',
    () async {
      final repository = CaptureTestRepository(),
          outbox = CaptureTestOutbox(),
          held = Completer<void>();
      outbox.beforeList = () => held.future;
      final controller = CaptureController(
        repository,
        outbox,
        captureTestOwner,
      );
      final submission = controller.submit(
        const CaptureDraft(content: 'Private draft'),
      );
      await _flush();
      controller.lock();
      held.complete();
      await submission;
      expect(repository.submissions, isEmpty);
      expect(outbox.entries, hasLength(1));
      expect(controller.pending, isEmpty);
      expect(controller.receipt, isNull);
      expect(controller.available, isFalse);
      controller.dispose();
    },
  );
  test('a draft loaded after scope replacement cannot enqueue into a resumed controller', () async {
    final repository = CaptureTestRepository(),
        outbox = CaptureTestOutbox(),
        held = Completer<CaptureDraft>();
    final controller = CaptureController(repository, outbox, captureTestOwner);
    final batch = controller.submitBatch(['source.pdf'], (_) => held.future);
    controller.lock();
    await controller.initialize();
    final draft = captureTestDraft();
    held.complete(draft);
    await batch;
    expect(outbox.entries, isEmpty);
    expect(repository.submissions, isEmpty);
    expect(controller.batchItems, isEmpty);
    expect(draft.file!.bytes, everyElement(0));
    controller.dispose();
  });
  test(
    'admitted bytes are snapshotted before the UI draft can be cleared',
    () async {
      final repository = CaptureTestRepository();
      final controller = CaptureController(
        repository,
        CaptureTestOutbox(),
        captureTestOwner,
      );
      final draft = captureTestDraft();
      final pending = controller.submit(draft);
      draft.file!.bytes.fillRange(0, 3, 0);
      await pending;
      await _flush();
      expect(repository.submissions.last.file!.bytes, [1, 2, 3]);
      controller.dispose();
    },
  );
  test('a late accepted write keeps its durable outbox entry and never reveals an old receipt', () async {
    final repository = CaptureTestRepository(),
        outbox = CaptureTestOutbox(),
        held = Completer<CaptureReceipt>();
    repository.submitter = (_) => held.future;
    final controller = CaptureController(repository, outbox, captureTestOwner);
    final pending = controller.submit(const CaptureDraft(content: 'Private'));
    await _flush();
    controller.lock();
    held.complete(
      const CaptureReceipt(jobId: 'job-one', title: 'Private', tags: []),
    );
    await pending;
    expect(controller.receipt, isNull);
    expect(controller.pending, isEmpty);
    expect(outbox.entries, hasLength(1));
    controller.dispose();
  });
  test('receipt refresh cancels on lock and cannot restore exact private source metadata', () async {
    final repository = CaptureTestRepository(),
        held = Completer<CaptureJobSnapshot>();
    repository.jobReader = (_) => held.future;
    final controller = CaptureController(
      repository,
      CaptureTestOutbox(),
      captureTestOwner,
    );
    await controller.submit(captureTestDraft());
    expect(controller.refreshingReceipt, isTrue);
    controller.lock();
    expect(repository.cancelTokens.first.isCancelled, isTrue);
    held.complete(const CaptureJobSnapshot(id: 'job-one', status: 'completed'));
    await _flush();
    expect(controller.receipt, isNull);
    expect(controller.selectedAsset, isNull);
    expect(controller.assetFresh, isFalse);
    controller.dispose();
  });
  test(
    'completed jobs preserve unsupported extraction and exact source identity',
    () async {
      final repository = CaptureTestRepository();
      repository.jobReader = (id) async =>
          CaptureJobSnapshot(id: id, status: 'completed');
      repository.assetReader = (_) async => CaptureAssetSnapshot.fromJson(
        captureTestAssetJson(
          status: 'indexed',
          extraction: 'unsupported',
          documentId: 'note-document',
        ),
      );
      final controller = CaptureController(
        repository,
        CaptureTestOutbox(),
        captureTestOwner,
        batchPollRounds: 1,
        batchPollInterval: Duration.zero,
        delay: (_) async {},
      );
      await controller.submitBatch([
        'source.pdf',
      ], (_) async => captureTestDraft());
      await controller.batchWork;
      final item = controller.batchItems.single;
      expect(item.state, CaptureBatchState.completed);
      expect(item.detail, contains('Extraction unsupported'));
      expect(item.asset!.contentSha256, captureTestHash);
      expect(item.source, 'capture:asset:asset:東京/full%2F');
      controller.dispose();
    },
  );
  test(
    'unknown or mismatched job refresh retains an unavailable processing state',
    () async {
      final repository = CaptureTestRepository()
        ..jobReader = (_) async =>
            const CaptureJobSnapshot(id: 'other-job', status: 'completed');
      final controller = CaptureController(
        repository,
        CaptureTestOutbox(),
        captureTestOwner,
        batchPollRounds: 1,
        batchPollInterval: Duration.zero,
        delay: (_) async {},
      );
      await controller.submitBatch([
        'source.pdf',
      ], (_) async => captureTestDraft());
      await controller.batchWork;
      expect(controller.batchItems.single.state, CaptureBatchState.processing);
      expect(controller.batchItems.single.retryable, isTrue);
      expect(controller.pending, hasLength(1));
      controller.dispose();
    },
  );
  test('an expired discard review cannot remove the retained encrypted entry after unlock', () async {
    final repository = CaptureTestRepository()
      ..submitter = (_) async => throw const ApiException('offline');
    final outbox = CaptureTestOutbox();
    final actual = CaptureController(repository, outbox, captureTestOwner);
    await actual.submit(const CaptureDraft(content: 'Pending'));
    final generation = actual.generation, id = actual.pending.single.id;
    actual.lock();
    await actual.initialize();
    await actual.discard(id, reviewedGeneration: generation);
    expect(outbox.entries, hasLength(1));
    expect(outbox.removals, 0);
    actual.dispose();
  });
  test('viewer restores local recovery but cannot admit, record, or automatically replay writes', () async {
    final outbox = CaptureTestOutbox();
    await outbox.enqueue(captureTestOwner, captureTestDraft());
    final repository = CaptureTestRepository();
    final controller = CaptureController(
      repository,
      outbox,
      captureTestOwner,
      canWrite: false,
      resumeBatchProcessing: true,
    );
    await controller.initialize();
    expect(controller.available, isTrue);
    expect(controller.canWrite, isFalse);
    expect(controller.pending, hasLength(1));
    expect(
      await controller.submit(const CaptureDraft(content: 'Not admitted')),
      isFalse,
    );
    var loaded = false;
    await controller.submitBatch(['source.pdf'], (_) async {
      loaded = true;
      return captureTestDraft();
    });
    await controller.syncPending();
    expect(loaded, isFalse);
    expect(repository.submissions, isEmpty);
    await controller.discard(controller.pending.single.id);
    expect(outbox.entries, isEmpty);
    controller.dispose();
  });
  test('unconfirmed batch receipt offers explicit same-key recovery with original bytes', () async {
    final outbox = CaptureTestOutbox(),
        repository = CaptureTestRepository()
          ..submitter = (_) async =>
              throw const FormatException('Malformed receipt');
    final controller = CaptureController(
      repository,
      outbox,
      captureTestOwner,
      batchPollRounds: 0,
      delay: (_) async {},
    );
    await controller.submitBatch([
      'source.pdf',
    ], (_) async => captureTestDraft());
    await controller.batchWork;
    final item = controller.batchItems.single, key = repository.keys.single;
    expect(item.state, CaptureBatchState.failed);
    expect(item.outcomeUnconfirmed, isTrue);
    expect(item.retryable, isTrue);
    expect(outbox.entries, hasLength(1));
    expect(controller.receipt, isNull);
    repository.submitter = (draft) async {
      expect(draft.file!.bytes, [1, 2, 3]);
      return const CaptureReceipt(
        jobId: 'job-one',
        title: 'Recovered',
        tags: [],
        jobStatus: 'completed',
      );
    };
    await controller.retryBatchItem(item.id);
    expect(repository.keys, [key, key]);
    expect(
      repository.submissions.last.file!.bytes,
      everyElement(0),
    ); // controller wipes decrypted upload after use
    expect(controller.batchItems.single.state, CaptureBatchState.completed);
    expect(outbox.entries, isEmpty);
    controller.dispose();
  });
  test(
    'known terminal batch failure is distinct from an unconfirmed receipt',
    () async {
      final repository = CaptureTestRepository()
        ..submitter = (_) async => const CaptureReceipt(
          jobId: 'job-failed',
          title: 'Failed',
          tags: [],
          jobStatus: 'failed',
        );
      final controller = CaptureController(
        repository,
        CaptureTestOutbox(),
        captureTestOwner,
        batchPollRounds: 0,
        delay: (_) async {},
      );
      await controller.submitBatch([
        'source.pdf',
      ], (_) async => captureTestDraft());
      await controller.batchWork;
      final item = controller.batchItems.single;
      expect(item.outcomeUnconfirmed, isFalse);
      expect(item.retryable, isFalse);
      await controller.retryBatchItem(item.id);
      expect(repository.submissions, hasLength(1));
      controller.dispose();
    },
  );
  test('a malformed accepted response retains its stable retry identity without claiming success', () async {
    final repository = CaptureTestRepository()
      ..submitter = (_) async =>
          const CaptureReceipt(jobId: '', title: 'Malformed', tags: []);
    final controller = CaptureController(
      repository,
      CaptureTestOutbox(),
      captureTestOwner,
    );
    await controller.submit(const CaptureDraft(content: 'Pending'));
    expect(controller.receipt, isNull);
    expect(controller.lastSubmitQueued, isTrue);
    final key = repository.keys.single;
    repository.submitter = (_) async =>
        const CaptureReceipt(jobId: 'job-one', title: 'Confirmed', tags: []);
    await controller.syncPending();
    await _flush();
    expect(repository.keys, [key, key]);
    expect(controller.receipt!.jobId, 'job-one');
    controller.dispose();
  });
}
