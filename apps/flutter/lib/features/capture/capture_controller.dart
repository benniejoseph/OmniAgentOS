import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/network/api_exception.dart';
import 'capture_models.dart';
import 'capture_outbox.dart';

abstract interface class CaptureRepository {
  Future<CaptureReceipt> submit(
    CaptureDraft draft, {
    required String idempotencyKey,
    required CaptureOwnerBinding owner,
  });

  Future<CaptureJobSnapshot> readJob(
    String jobId, {
    required CaptureOwnerBinding owner,
  });
}

class CaptureController extends ChangeNotifier {
  CaptureController(
    this.repository,
    this.outbox,
    this.owner, {
    this.batchPollInterval = const Duration(seconds: 2),
    this.batchPollRounds = 150,
    this.resumeBatchProcessing = false,
    Future<void> Function(Duration)? delay,
  }) : _delay = delay ?? Future<void>.delayed;

  final CaptureRepository repository;
  final CaptureOutbox outbox;
  final CaptureOwnerBinding? owner;
  final Duration batchPollInterval;
  final int batchPollRounds;
  final bool resumeBatchProcessing;
  final Future<void> Function(Duration) _delay;

  bool submitting = false, loadingOutbox = false, syncing = false;
  bool batchQueueing = false, lastSubmitQueued = false;
  Object? error, syncError;
  CaptureReceipt? receipt;
  List<CaptureOutboxEntry> pending = const [];
  List<CaptureBatchItem> batchItems = const [];
  Future<void>? _batchWork;
  int _generation = 0;
  bool _disposed = false;

  Future<void> get batchWork => _batchWork ?? Future<void>.value();

  List<CaptureOutboxEntry> get pendingWithoutBatch {
    final tracked = batchItems.map((item) => item.id).toSet();
    return pending.where((entry) => !tracked.contains(entry.id)).toList();
  }

  Future<void> initialize() async {
    if (owner == null || loadingOutbox || syncing) return;
    final generation = _generation;
    loadingOutbox = true;
    _emit();
    try {
      final restored = await outbox.list(owner!);
      if (generation != _generation) return;
      pending = restored;
      error = null;
    } catch (value) {
      if (generation == _generation) error = value;
    } finally {
      loadingOutbox = false;
      _emit();
    }
    if (generation != _generation || pending.isEmpty) return;
    if (resumeBatchProcessing) {
      final resumable = pending
          .where((entry) => entry.draft.file != null)
          .where((entry) => _batchItem(entry.id) == null)
          .toList(growable: false);
      if (resumable.isNotEmpty) {
        batchItems = [
          ...batchItems,
          for (final entry in resumable)
            CaptureBatchItem(
              id: entry.id,
              name: entry.draft.file!.name,
              state: CaptureBatchState.queued,
              createdAt: entry.createdAt,
              progressStage: 'queued',
              detail: 'Restored securely and waiting to resume.',
            ),
        ];
        _emit();
        _startBatchWork(
          resumable.map((entry) => entry.id).toList(growable: false),
          generation,
        );
        await batchWork;
      }
    }
    if (generation == _generation && pendingWithoutBatch.isNotEmpty) {
      await syncPending();
    }
  }

  Future<bool> submit(CaptureDraft draft) async {
    if (submitting || syncing || batchQueueing || owner == null) return false;
    if (!draft.valid) {
      error = FormatException(draft.validationError!);
      _emit();
      return false;
    }
    submitting = true;
    error = null;
    syncError = null;
    lastSubmitQueued = false;
    receipt = null;
    final generation = _generation;
    _emit();
    try {
      final entry = await outbox.enqueue(owner!, draft);
      if (generation != _generation) return true;
      pending = await outbox.list(owner!);
      _emit();
      try {
        final synced = await repository.submit(
          entry.draft,
          idempotencyKey: entry.idempotencyKey,
          owner: owner!,
        );
        if (generation != _generation) return true;
        receipt = synced;
        await outbox.remove(owner!, entry.id);
        pending = await outbox.list(owner!);
      } catch (value) {
        if (generation == _generation) {
          syncError = value;
          lastSubmitQueued = true;
        }
      }
      return true;
    } catch (value) {
      if (generation == _generation) error = value;
      return false;
    } finally {
      submitting = false;
      _emit();
    }
  }

  Future<void> syncPending() async {
    if (owner == null ||
        syncing ||
        submitting ||
        batchQueueing ||
        loadingOutbox) {
      return;
    }
    final generation = _generation;
    syncing = true;
    syncError = null;
    _emit();
    try {
      final tracked = batchItems.map((item) => item.id).toSet();
      final entries = (await outbox.list(owner!))
          .where((entry) => !tracked.contains(entry.id));
      for (final metadata in entries) {
        if (generation != _generation) break;
        CaptureOutboxEntry? entry;
        try {
          entry = await outbox.get(owner!, metadata.id);
          if (entry == null || generation != _generation) continue;
          final synced = await repository.submit(
            entry.draft,
            idempotencyKey: entry.idempotencyKey,
            owner: owner!,
          );
          if (generation != _generation) break;
          receipt = synced;
          await outbox.remove(owner!, entry.id);
        } catch (value) {
          if (generation != _generation) break;
          syncError = value;
          if (_stopSyncAfter(value)) break;
        } finally {
          _wipeCapturePayload(entry);
          entry = null;
        }
      }
      if (generation == _generation) pending = await outbox.list(owner!);
    } catch (value) {
      if (generation == _generation) error = value;
    } finally {
      syncing = false;
      _emit();
    }
  }

  Future<CaptureBatchEnqueueResult> submitBatch(
    List<String> names,
    Future<CaptureDraft> Function(int index) loadDraft,
  ) async {
    if (owner == null ||
        batchQueueing ||
        submitting ||
        syncing ||
        names.isEmpty) {
      return const CaptureBatchEnqueueResult(queued: 0, failed: 0);
    }
    final generation = _generation;
    final boundedNames = names.take(captureBatchMaxFiles).toList();
    final queuedIds = <String>[];
    var failed = names.length - boundedNames.length;
    batchQueueing = true;
    error = null;
    syncError = null;
    _emit();

    for (var index = 0; index < boundedNames.length; index += 1) {
      if (generation != _generation) break;
      try {
        final draft = await loadDraft(index);
        if (!draft.valid) throw FormatException(draft.validationError!);
        final entry = await outbox.enqueue(owner!, draft);
        queuedIds.add(entry.id);
        batchItems = [
          ...batchItems,
          CaptureBatchItem(
            id: entry.id,
            name: draft.file?.name ?? boundedNames[index],
            state: CaptureBatchState.queued,
            createdAt: entry.createdAt,
            detail: 'Encrypted locally and waiting to upload.',
          ),
        ];
      } catch (value) {
        failed += 1;
        batchItems = [
          ...batchItems,
          CaptureBatchItem(
            id: 'rejected-${DateTime.now().microsecondsSinceEpoch}-$index',
            name: boundedNames[index],
            state: CaptureBatchState.failed,
            createdAt: DateTime.now().toUtc(),
            detail: _captureFailureMessage(value),
          ),
        ];
      }
      _emit();
    }

    try {
      if (generation == _generation) pending = await outbox.list(owner!);
    } catch (value) {
      if (generation == _generation) error = value;
    } finally {
      batchQueueing = false;
      _emit();
    }
    if (queuedIds.isNotEmpty && generation == _generation) {
      _startBatchWork(queuedIds, generation);
    }
    return CaptureBatchEnqueueResult(queued: queuedIds.length, failed: failed);
  }

  Future<void> retryBatchItem(String entryId) async {
    if (owner == null || syncing || batchQueueing || submitting) return;
    final item = _batchItem(entryId);
    if (item == null) return;
    if (item.state == CaptureBatchState.processing && item.jobId != null) {
      await refreshBatchProgress();
      return;
    } else if (item.state == CaptureBatchState.failed && item.retryable) {
      _setBatchItem(
        item.copyWith(
          state: CaptureBatchState.queued,
          progressStage: 'queued',
          detail: 'Retry queued.',
          retryable: false,
        ),
      );
      _startBatchWork([entryId], _generation);
    }
    await batchWork;
  }

  Future<void> refreshBatchProgress() async {
    if (syncing || batchQueueing || submitting) return;
    if (!batchItems.any(
      (item) =>
          item.state == CaptureBatchState.processing && item.jobId != null,
    )) {
      return;
    }
    batchItems = batchItems
        .map((item) {
          if (item.state != CaptureBatchState.processing ||
              item.jobId == null) {
            return item;
          }
          return item.copyWith(
            detail: 'Refreshing server processing status.',
            retryable: false,
          );
        })
        .toList(growable: false);
    _emit();
    _startBatchWork(const [], _generation);
    await batchWork;
  }

  Future<void> discard(String entryId) async {
    if (owner == null || syncing || submitting || batchQueueing) return;
    try {
      await outbox.remove(owner!, entryId);
      pending = await outbox.list(owner!);
      batchItems = batchItems.where((item) => item.id != entryId).toList();
      syncError = null;
    } catch (value) {
      error = value;
    }
    _emit();
  }

  void clearFinishedBatchItems() {
    final localIds = pending.map((entry) => entry.id).toSet();
    batchItems = batchItems.where((item) {
      if (localIds.contains(item.id)) return true;
      return item.state != CaptureBatchState.completed &&
          item.state != CaptureBatchState.failed;
    }).toList();
    _emit();
  }

  void lock() {
    _generation += 1;
    // In-flight work is fenced by the generation above. Reset the public
    // activity flags as well so the same owner-scoped controller can be
    // rehydrated after an application lock without remaining permanently
    // "busy" behind work from the previous unlocked generation.
    submitting = false;
    loadingOutbox = false;
    syncing = false;
    batchQueueing = false;
    lastSubmitQueued = false;
    _batchWork = null;
    pending = const [];
    batchItems = const [];
    receipt = null;
    error = null;
    syncError = null;
    _emit();
  }

  void _startBatchWork(List<String> entryIds, int generation) {
    if (syncing || generation != _generation) return;
    syncing = true;
    _emit();
    final work = _runBatch(entryIds, generation);
    _batchWork = work;
    unawaited(
      work.whenComplete(() {
        if (identical(_batchWork, work)) _batchWork = null;
      }),
    );
  }

  Future<void> _runBatch(List<String> entryIds, int generation) async {
    try {
      await _runBounded(
        entryIds,
        (entryId) => _uploadBatchEntry(entryId, generation),
      );
      if (generation == _generation) await _pollBatchJobs(generation);
      if (generation == _generation) pending = await outbox.list(owner!);
    } catch (value) {
      if (generation == _generation) syncError = value;
    } finally {
      if (generation == _generation) {
        syncing = false;
        _emit();
      }
    }
  }

  Future<void> _uploadBatchEntry(String entryId, int generation) async {
    final item = _batchItem(entryId);
    if (item == null) return;
    CaptureOutboxEntry? queued;
    try {
      queued = await outbox.get(owner!, entryId);
    } catch (value) {
      _failBatch(item, _captureFailureMessage(value), retryable: false);
      return;
    }
    if (queued == null) return;
    try {
      if (generation != _generation) return;
      _setBatchItem(
        item.copyWith(
          state: CaptureBatchState.uploading,
          progressStage: 'uploading',
          detail: 'Uploading through the governed Capture service.',
          retryable: false,
        ),
      );
      Object? lastFailure;
      for (var attempt = 1; attempt <= 3; attempt += 1) {
        if (generation != _generation) return;
        try {
          final response = await repository.submit(
            queued.draft,
            idempotencyKey: queued.idempotencyKey,
            owner: owner!,
          );
          if (generation != _generation) return;
          if (response.jobId.trim().isEmpty) {
            throw const FormatException(
              'The Capture service did not return a processing job.',
            );
          }
          receipt = response;
          if (response.jobStatus == 'completed') {
            await _completeBatch(item, response.jobId, generation);
          } else if (_terminalFailure(response.jobStatus)) {
            _failBatch(
              item,
              response.lastError ?? 'Server processing did not complete.',
              retryable: false,
              jobId: response.jobId,
            );
          } else {
            _setBatchItem(
              item.copyWith(
                state: CaptureBatchState.processing,
                jobId: response.jobId,
                progressStage: response.progressStage ?? response.jobStatus,
                detail: 'Uploaded. Extraction and indexing are running.',
                retryable: false,
              ),
            );
          }
          return;
        } catch (value) {
          lastFailure = value;
          if (!_retryableCaptureError(value) || attempt == 3) break;
          await _delay(Duration(milliseconds: 250 * (1 << (attempt - 1))));
        }
      }
      if (generation == _generation) {
        _failBatch(item, _captureFailureMessage(lastFailure), retryable: true);
      }
    } finally {
      _wipeCapturePayload(queued);
      queued = null;
    }
  }

  Future<void> _pollBatchJobs(int generation) async {
    for (var round = 0; round < batchPollRounds; round += 1) {
      final active = batchItems
          .where(
            (item) =>
                item.state == CaptureBatchState.processing &&
                item.jobId != null &&
                !item.retryable,
          )
          .toList();
      if (generation != _generation || active.isEmpty) return;
      await _delay(batchPollInterval);
      await _runBounded(active, (item) => _pollBatchItem(item, generation));
    }
    if (generation != _generation) return;
    for (final item in batchItems.where(
      (item) => item.state == CaptureBatchState.processing,
    )) {
      _setBatchItem(
        item.copyWith(
          detail: 'Still processing. Refresh to continue tracking.',
          retryable: true,
        ),
      );
    }
  }

  Future<void> _pollBatchItem(CaptureBatchItem item, int generation) async {
    try {
      final job = await repository.readJob(item.jobId!, owner: owner!);
      if (generation != _generation) return;
      if (job.status == 'completed') {
        await _completeBatch(item, job.id, generation);
      } else if (_terminalFailure(job.status)) {
        _failBatch(
          item,
          job.lastError ?? 'Server processing did not complete.',
          retryable: false,
          jobId: job.id,
        );
      } else {
        _setBatchItem(
          item.copyWith(
            jobId: job.id,
            progressStage: job.progressStage ?? job.status,
            detail: 'Extraction and indexing are running.',
            retryable: false,
          ),
        );
      }
    } catch (_) {
      if (generation == _generation) {
        _setBatchItem(
          item.copyWith(
            detail: 'Server processing continues; progress refresh is paused.',
            retryable: true,
          ),
        );
      }
    }
  }

  Future<void> _completeBatch(
    CaptureBatchItem item,
    String jobId,
    int generation,
  ) async {
    await outbox.remove(owner!, item.id);
    if (generation != _generation) return;
    _setBatchItem(
      item.copyWith(
        state: CaptureBatchState.completed,
        jobId: jobId,
        progressStage: 'completed',
        detail: 'Indexed and available to knowledge retrieval.',
        retryable: false,
      ),
    );
  }

  void _failBatch(
    CaptureBatchItem item,
    String detail, {
    required bool retryable,
    String? jobId,
  }) => _setBatchItem(
    item.copyWith(
      state: CaptureBatchState.failed,
      jobId: jobId,
      progressStage: 'failed',
      detail: detail,
      retryable: retryable,
    ),
  );

  CaptureBatchItem? _batchItem(String id) =>
      batchItems.where((item) => item.id == id).firstOrNull;

  void _setBatchItem(CaptureBatchItem next) {
    batchItems = batchItems
        .map((item) => item.id == next.id ? next : item)
        .toList(growable: false);
    _emit();
  }

  Future<void> _runBounded<T>(
    List<T> items,
    Future<void> Function(T item) work,
  ) async {
    var next = 0;
    final lanes = items.length < captureBatchConcurrency
        ? items.length
        : captureBatchConcurrency;
    await Future.wait(
      List.generate(lanes, (_) async {
        while (next < items.length) {
          final index = next++;
          await work(items[index]);
        }
      }),
    );
  }

  void _emit() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation += 1;
    super.dispose();
  }
}

bool _stopSyncAfter(Object error) =>
    error is! ApiException ||
    error.statusCode == null ||
    error.statusCode == 401 ||
    error.statusCode == 403 ||
    error.statusCode == 408 ||
    error.statusCode == 429 ||
    (error.statusCode ?? 0) >= 500;

bool _terminalFailure(String value) => value == 'failed' || value == 'canceled';

bool _retryableCaptureError(Object error) =>
    error is ApiException &&
    (error.statusCode == null ||
        error.statusCode == 408 ||
        error.statusCode == 429 ||
        (error.statusCode ?? 0) >= 500);

String _captureFailureMessage(Object? error) {
  if (error is CaptureOutboxCapacityException) return error.message;
  if (error is FormatException) {
    return error.message.isEmpty
        ? 'This document could not be queued.'
        : error.message;
  }
  if (error is ApiException) {
    return _retryableCaptureError(error)
        ? 'Upload paused. The encrypted local copy is safe and can be retried.'
        : 'The Capture service rejected this document.';
  }
  return 'This document could not be queued. The other files were not affected.';
}

void _wipeCapturePayload(CaptureOutboxEntry? entry) {
  final bytes = entry?.draft.file?.bytes;
  if (bytes == null || bytes.isEmpty) return;
  bytes.fillRange(0, bytes.length, 0);
}
