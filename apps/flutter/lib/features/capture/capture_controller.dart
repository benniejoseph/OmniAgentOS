import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';

import '../../core/network/api_exception.dart';
import 'capture_models.dart';
import 'capture_outbox.dart';
import 'capture_projection.dart';

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

abstract interface class FreshCaptureRepository {
  Future<CaptureJobSnapshot> readJobFresh(
    String jobId, {
    required CaptureOwnerBinding owner,
    required CancelToken cancelToken,
  });
}

abstract interface class CaptureAssetRepository {
  Future<CaptureAssetSnapshot> readAsset(
    String id, {
    required CaptureOwnerBinding owner,
    required CancelToken cancelToken,
  });
  Future<Uint8List> downloadOriginal(
    CaptureAssetSnapshot asset, {
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
    this._canWrite = true,
    this._authorityCurrent,
    Future<void> Function(Duration)? delay,
  }) : _delay = delay ?? Future<void>.delayed;

  final CaptureRepository repository;
  final CaptureOutbox outbox;
  final CaptureOwnerBinding? owner;
  final Duration batchPollInterval;
  final int batchPollRounds;
  final bool resumeBatchProcessing;
  final bool _canWrite;
  final bool Function()? _authorityCurrent;
  bool _checkingAuthority = false;
  bool _invalidated = false;
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
  bool _locked = false, discarding = false, refreshingReceipt = false;
  CaptureJobSnapshot? receiptJob;
  CaptureAssetSnapshot? selectedAsset;
  String? receiptReadError;
  bool assetFresh = false;
  CaptureLegacyInventory? legacyInventory;
  String? legacyRecoveryError, legacyCleanupNotice;
  List<CaptureLocalDeletionReceipt> legacyDeletionReceipts = const [];
  bool inspectingLegacy = false;
  bool get supportsLegacyRecovery => outbox is CaptureLegacyOutboxRecovery;
  CancelToken? _receiptRead;
  final Set<CancelToken> _jobReads = {};
  int _receiptEpoch = 0;
  int get generation => _generation;
  bool get available {
    if (!_disposed &&
        !_invalidated &&
        !_checkingAuthority &&
        _authorityCurrent != null) {
      _checkingAuthority = true;
      var authorized = false;
      try {
        authorized = _authorityCurrent();
      } catch (_) {
        authorized = false;
      } finally {
        _checkingAuthority = false;
      }
      if (!authorized && !_disposed && !_invalidated) invalidateAuthority();
    }
    return !_disposed && !_locked && !_invalidated && owner != null;
  }

  bool get canWrite => available && _canWrite;
  bool get busy =>
      submitting || syncing || batchQueueing || discarding || inspectingLegacy;
  bool current(int generation) => available && generation == _generation;

  Future<void> get batchWork => _batchWork ?? Future<void>.value();

  List<CaptureOutboxEntry> get pendingWithoutBatch {
    final tracked = batchItems.map((item) => item.id).toSet();
    return pending.where((entry) => !tracked.contains(entry.id)).toList();
  }

  Future<void> initialize() async {
    if (_disposed ||
        _invalidated ||
        owner == null ||
        loadingOutbox ||
        syncing) {
      return;
    }
    _locked = false;
    if (!available) {
      return;
    }
    final generation = _generation;
    loadingOutbox = true;
    _emit();
    try {
      final restored = await outbox.list(owner!);
      if (!current(generation)) {
        return;
      }
      pending = restored;
      error = null;
    } catch (value) {
      if (current(generation)) {
        error = value;
      }
    } finally {
      if (current(generation)) {
        loadingOutbox = false;
        _emit();
      }
    }
    if (current(generation)) {
      await refreshLegacyInventory();
    }
    if (!canWrite || generation != _generation || pending.isEmpty) {
      return;
    }
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
              retryable: true,
              createdAt: entry.createdAt,
              progressStage: 'queued',
              detail: 'Restored securely. Review and choose Retry to upload with the existing request key.',
            ),
        ];
        _emit();
      }
    }
    // A restored encrypted item may be a write or discard whose acknowledgement
    // was lost in another engine. Only an explicit Retry/Sync admits its upload.
  }

  Future<bool> submit(CaptureDraft draft) async {
    if (busy || !canWrite) {
      return false;
    }
    if (!draft.valid) {
      error = FormatException(draft.validationError!);
      _emit();
      return false;
    }
    final admitted = CaptureDraft(
      content: draft.content,
      title: draft.title,
      tags: List.unmodifiable(draft.tags),
      kind: draft.kind,
      file: draft.file == null
          ? null
          : CaptureAttachment(
              name: draft.file!.name,
              bytes: Uint8List.fromList(draft.file!.bytes),
              contentType: draft.file!.contentType,
            ),
    );
    submitting = true;
    error = null;
    syncError = null;
    lastSubmitQueued = false;
    receipt = null;
    receiptJob = null;
    selectedAsset = null;
    receiptReadError = null;
    assetFresh = false;
    _receiptEpoch++;
    _receiptRead?.cancel('A new Capture was submitted');
    final generation = _generation;
    _emit();
    try {
      final entry = await outbox.enqueue(owner!, admitted);
      if (!current(generation)) {
        return true;
      }
      final restored = await outbox.list(owner!);
      if (!current(generation)) {
        return true;
      }
      pending = restored;
      _emit();
      try {
        final synced = await repository.submit(
          entry.draft,
          idempotencyKey: entry.idempotencyKey,
          owner: owner!,
        );
        if (!current(generation)) {
          return true;
        }
        _acceptReceipt(synced);
        await outbox.remove(owner!, entry.id);
        final remaining = await outbox.list(owner!);
        if (!current(generation)) {
          return true;
        }
        pending = remaining;
        unawaited(refreshReceipt());
      } catch (value) {
        if (current(generation)) {
          syncError = value;
          lastSubmitQueued = true;
        }
      }
      return true;
    } catch (value) {
      if (current(generation)) {
        error = value;
      }
      return false;
    } finally {
      if (current(generation)) {
        submitting = false;
        _emit();
      }
    }
  }

  Future<void> syncPending() async {
    if (!canWrite ||
        discarding ||
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
        if (!current(generation)) {
          break;
        }
        CaptureOutboxEntry? entry;
        try {
          entry = await outbox.get(owner!, metadata.id);
          if (entry == null || !current(generation)) {
            continue;
          }
          final synced = await repository.submit(
            entry.draft,
            idempotencyKey: entry.idempotencyKey,
            owner: owner!,
          );
          if (!current(generation)) {
            break;
          }
          _acceptReceipt(synced);
          await outbox.remove(owner!, entry.id);
        } catch (value) {
          if (!current(generation)) {
            break;
          }
          syncError = value;
          if (_stopSyncAfter(value)) {
            break;
          }
        } finally {
          _wipeCapturePayload(entry);
          entry = null;
        }
      }
      if (current(generation)) {
        final remaining = await outbox.list(owner!);
        if (current(generation)) {
          pending = remaining;
          unawaited(refreshReceipt());
        }
      }
    } catch (value) {
      if (current(generation)) {
        error = value;
      }
    } finally {
      if (current(generation)) {
        syncing = false;
        _emit();
      }
    }
  }

  Future<CaptureBatchEnqueueResult> submitBatch(
    List<String> names,
    Future<CaptureDraft> Function(int index) loadDraft,
  ) async {
    if (!canWrite ||
        discarding ||
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
      if (!current(generation)) {
        break;
      }
      try {
        final draft = await loadDraft(index);
        if (!current(generation)) {
          draft.file?.bytes.fillRange(0, draft.file!.bytes.length, 0);
          break;
        }
        if (!draft.valid) {
          throw FormatException(draft.validationError!);
        }
        final entry = await outbox.enqueue(owner!, draft);
        queuedIds.add(entry.id);
        if (!current(generation)) {
          break;
        }
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
        if (!current(generation)) {
          break;
        }
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
      if (current(generation)) {
        final restored = await outbox.list(owner!);
        if (current(generation)) {
          pending = restored;
        }
      }
    } catch (value) {
      if (current(generation)) {
        error = value;
      }
    } finally {
      if (current(generation)) {
        batchQueueing = false;
        _emit();
      }
    }
    if (queuedIds.isNotEmpty && current(generation)) {
      _startBatchWork(queuedIds, generation);
    }
    return CaptureBatchEnqueueResult(queued: queuedIds.length, failed: failed);
  }

  Future<void> retryBatchItem(String entryId) async {
    if (!available || busy) {
      return;
    }
    final item = _batchItem(entryId);
    if (item == null) {
      return;
    }
    if (item.state == CaptureBatchState.processing && item.jobId != null) {
      await refreshBatchProgress();
      return;
    } else if (canWrite &&
        (item.state == CaptureBatchState.failed ||
            item.state == CaptureBatchState.queued) &&
        item.retryable) {
      _setBatchItem(
        item.copyWith(
          state: CaptureBatchState.queued,
          progressStage: 'queued',
          detail: item.outcomeUnconfirmed
              ? 'Recovering the existing request key.'
              : 'Retry queued.',
          retryable: false,
          outcomeUnconfirmed: false,
        ),
      );
      _startBatchWork([entryId], _generation);
    }
    await batchWork;
  }

  Future<void> refreshBatchProgress() async {
    if (!available || busy) {
      return;
    }
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

  Future<void> discard(String entryId, {int? reviewedGeneration}) async {
    if (!available ||
        busy ||
        reviewedGeneration != null && reviewedGeneration != _generation ||
        !pending.any((entry) => entry.id == entryId)) {
      return;
    }
    final generation = _generation;
    discarding = true;
    _emit();
    try {
      await outbox.remove(owner!, entryId);
      if (!current(generation)) {
        return;
      }
      final remaining = await outbox.list(owner!);
      if (!current(generation)) {
        return;
      }
      pending = remaining;
      batchItems = batchItems.where((item) => item.id != entryId).toList();
      syncError = null;
    } catch (value) {
      if (current(generation)) {
        error = value;
      }
    } finally {
      if (current(generation)) {
        discarding = false;
        _emit();
      }
    }
    _emit();
  }

  Future<CaptureLegacyInventory?> refreshLegacyInventory() async {
    final recovery = outbox;
    if (!available || busy || recovery is! CaptureLegacyOutboxRecovery) {
      return null;
    }
    final generation = _generation;
    inspectingLegacy = true;
    legacyRecoveryError = null;
    _emit();
    try {
      final value = await (recovery as CaptureLegacyOutboxRecovery)
          .inspectLegacy(owner!);
      if (!current(generation)) {
        return null;
      }
      legacyInventory = value;
      if (value.reconciledDeletions.isNotEmpty) {
        final reconciled = value.reconciledDeletions;
        legacyDeletionReceipts = List.unmodifiable(
          legacyDeletionReceipts.map(
            (receipt) =>
                reconciled
                    .where(
                      (item) =>
                          item.entryId == receipt.entryId &&
                          item.sha256 == receipt.sha256,
                    )
                    .firstOrNull ??
                receipt,
          ),
        );
        final absent = reconciled
            .where(
              (item) =>
                  item.disposition == CaptureLocalDeletionDisposition.absent,
            )
            .length;
        final retained = reconciled
            .where(
              (item) =>
                  item.disposition == CaptureLocalDeletionDisposition.retained,
            )
            .length;
        final changed = reconciled
            .where(
              (item) =>
                  item.disposition == CaptureLocalDeletionDisposition.changed,
            )
            .length;
        legacyCleanupNotice =
            'Fresh inventory checked the previously unconfirmed removals: $absent absent, $retained retained, $changed changed. No deletion was repeated.';
      }
      return value;
    } catch (_) {
      if (current(generation)) {
        legacyInventory = null;
        legacyRecoveryError = 'The local legacy inventory could not be checked. This check did not delete files; earlier unconfirmed removals remain unconfirmed.';
      }
      return null;
    } finally {
      if (current(generation)) {
        inspectingLegacy = false;
        _emit();
      }
    }
  }

  Future<void> discardLegacyInventory(
    CaptureLegacyInventory reviewed, {
    required int reviewedGeneration,
  }) async {
    final recovery = outbox;
    if (!current(reviewedGeneration) ||
        busy ||
        recovery is! CaptureLegacyOutboxRecovery) {
      return;
    }
    if (!identical(legacyInventory, reviewed)) {
      legacyCleanupNotice =
          'The legacy inventory changed. Review it again before discarding.';
      _emit();
      return;
    }
    discarding = true;
    legacyCleanupNotice = null;
    legacyRecoveryError = null;
    _emit();
    var requiresExplicitRescan = false;
    try {
      final result = await (recovery as CaptureLegacyOutboxRecovery)
          .discardLegacy(
            owner!,
            reviewed,
            authorityCurrent: () => current(reviewedGeneration),
          );
      if (!current(reviewedGeneration)) {
        return;
      }
      legacyInventory = null;
      legacyDeletionReceipts = result.receipts;
      requiresExplicitRescan = result.unconfirmed > 0;
      legacyCleanupNotice = result.stale
          ? 'The legacy inventory changed. No files were removed. Review it again.'
          : '${result.removed} encrypted legacy ${result.removed == 1 ? 'file removed' : 'files removed'}.'
                '${result.failed > 0 ? ' ${result.failed} removals did not proceed. Check the remaining inventory.' : ''}'
                '${result.unconfirmed > 0 ? ' ${result.unconfirmed} removals are unconfirmed and may already have completed. Refresh the inventory to check; no deletion will be repeated automatically.' : ''}'
                '${result.stopped ? ' Cleanup stopped before all reviewed files were processed.' : ''}'
                ' Current account captures were kept.';
    } catch (_) {
      if (current(reviewedGeneration)) {
        legacyInventory = null;
        legacyCleanupNotice = 'Cleanup could not finish. Some files may remain; refresh the inventory before trying again.';
      }
    } finally {
      if (current(reviewedGeneration)) {
        discarding = false;
        _emit();
      }
    }
    if (current(reviewedGeneration) && !requiresExplicitRescan) {
      await refreshLegacyInventory();
    }
  }

  void clearFinishedBatchItems() {
    final localIds = pending.map((entry) => entry.id).toSet();
    batchItems = batchItems.where((item) {
      if (localIds.contains(item.id)) {
        return true;
      }
      return item.state != CaptureBatchState.completed &&
          item.state != CaptureBatchState.failed;
    }).toList();
    _emit();
  }

  void invalidateAuthority({bool notify = true}) {
    _invalidated = true;
    lock(notify: notify);
  }

  void lock({bool notify = true}) {
    _generation += 1;
    _locked = true;
    _receiptRead?.cancel('Capture access changed');
    for (final read in _jobReads) {
      read.cancel('Capture access changed');
    }
    _jobReads.clear();
    _receiptEpoch++;
    selectedAsset = null;
    receiptJob = null;
    receiptReadError = null;
    assetFresh = false;
    refreshingReceipt = false;
    inspectingLegacy = false;
    legacyInventory = null;
    legacyRecoveryError = null;
    legacyCleanupNotice = null;
    legacyDeletionReceipts = const [];
    discarding = false;
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
    if (notify) _emit();
  }

  void _startBatchWork(List<String> entryIds, int generation) {
    if (syncing || !current(generation)) {
      return;
    }
    syncing = true;
    _emit();
    final work = _runBatch(entryIds, generation);
    _batchWork = work;
    unawaited(
      work.whenComplete(() {
        if (identical(_batchWork, work)) {
          _batchWork = null;
        }
      }),
    );
  }

  Future<void> _runBatch(List<String> entryIds, int generation) async {
    try {
      await _runBounded(
        entryIds,
        (entryId) => _uploadBatchEntry(entryId, generation),
      );
      if (current(generation)) {
        await _pollBatchJobs(generation);
      }
      if (current(generation)) {
        final remaining = await outbox.list(owner!);
        if (current(generation)) {
          pending = remaining;
        }
      }
    } catch (value) {
      if (current(generation)) {
        syncError = value;
      }
    } finally {
      if (current(generation)) {
        syncing = false;
        _emit();
      }
    }
  }

  Future<void> _uploadBatchEntry(String entryId, int generation) async {
    if (!current(generation) || !canWrite) {
      return;
    }
    final item = _batchItem(entryId);
    if (item == null) {
      return;
    }
    CaptureOutboxEntry? queued;
    try {
      queued = await outbox.get(owner!, entryId);
    } catch (value) {
      if (current(generation)) {
        _failBatch(item, _captureFailureMessage(value), retryable: false);
      }
      return;
    }
    if (queued == null) {
      return;
    }
    try {
      if (!current(generation)) {
        return;
      }
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
        if (!current(generation)) {
          return;
        }
        try {
          final response = await repository.submit(
            queued.draft,
            idempotencyKey: queued.idempotencyKey,
            owner: owner!,
          );
          if (!current(generation)) {
            return;
          }
          if (response.jobId.trim().isEmpty) {
            throw const FormatException(
              'The Capture service did not return a processing job.',
            );
          }
          _acceptReceipt(response);
          final accepted = item.copyWith(
            asset: response.asset,
            source: response.source,
            outcomeUnconfirmed: false,
          );
          if (response.jobStatus == 'completed') {
            await _completeBatch(accepted, response.jobId, generation);
          } else if (_terminalFailure(response.jobStatus)) {
            _failBatch(
              accepted,
              response.lastError ?? 'Server processing did not complete.',
              retryable: false,
              jobId: response.jobId,
            );
          } else {
            _setBatchItem(
              accepted.copyWith(
                state: CaptureBatchState.processing,
                jobId: response.jobId,
                progressStage: response.progressStage ?? response.jobStatus,
                detail: captureProcessingDescription(response.progressStage),
                retryable: false,
              ),
            );
          }
          return;
        } catch (value) {
          lastFailure = value;
          if (!_retryableCaptureError(value) || attempt == 3) {
            break;
          }
          await _delay(Duration(milliseconds: 250 * (1 << (attempt - 1))));
        }
      }
      if (current(generation)) {
        _failBatch(
          item,
          lastFailure is FormatException
              ? 'The submission outcome is unconfirmed. Recover using the same encrypted original and request key.'
              : _captureFailureMessage(lastFailure),
          retryable:
              lastFailure is FormatException ||
              lastFailure != null && _retryableCaptureError(lastFailure),
          outcomeUnconfirmed: lastFailure is FormatException,
        );
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
      if (!current(generation) || active.isEmpty) {
        return;
      }
      await _delay(batchPollInterval);
      await _runBounded(active, (item) => _pollBatchItem(item, generation));
    }
    if (!current(generation)) {
      return;
    }
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
      if (!current(generation)) {
        return;
      }
      final job = await _readJob(item.jobId!);
      if (!current(generation)) {
        return;
      }
      if (job.id != item.jobId) {
        throw const FormatException(
          'Capture returned a different processing job.',
        );
      }
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
            detail: captureProcessingDescription(job.progressStage),
            retryable: false,
          ),
        );
      }
    } catch (_) {
      if (current(generation)) {
        _setBatchItem(
          item.copyWith(
            detail: 'Current server progress is unavailable. The last returned state is retained.',
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
    CaptureAssetSnapshot? asset = item.asset;
    final source = repository;
    if (asset != null && source is CaptureAssetRepository) {
      final cancel = CancelToken();
      _jobReads.add(cancel);
      try {
        final refreshed = await (source as CaptureAssetRepository).readAsset(
          asset.id,
          owner: owner!,
          cancelToken: cancel,
        );
        if (!current(generation)) {
          return;
        }
        if (refreshed.contentIdentity != asset.contentIdentity ||
            refreshed.ingestJobId != jobId) {
          throw const FormatException(
            'The original or its processing job changed.',
          );
        }
        asset = refreshed;
      } on FormatException {
        if (current(generation)) {
          _failBatch(
            item,
            'The original identity could not be reconciled. The encrypted local copy is retained.',
            retryable: false,
            jobId: jobId,
          );
        }
        return;
      } catch (_) {
        // Completion of the job is still evidence; unavailable asset metadata
        // must not become a successful extraction or indexing claim.
      } finally {
        _jobReads.remove(cancel);
      }
    }
    if (!current(generation)) {
      return;
    }
    await outbox.remove(owner!, item.id);
    if (!current(generation)) {
      return;
    }
    _setBatchItem(
      item.copyWith(
        state: CaptureBatchState.completed,
        jobId: jobId,
        progressStage: 'completed',
        asset: asset,
        detail: asset == null
            ? 'Processing job completed. Source indexing has not been independently checked.'
            : '${asset.extractionLabel}. ${asset.indexingLabel}.',
        retryable: false,
      ),
    );
  }

  void _failBatch(
    CaptureBatchItem item,
    String detail, {
    required bool retryable,
    bool outcomeUnconfirmed = false,
    String? jobId,
  }) => _setBatchItem(
    item.copyWith(
      state: CaptureBatchState.failed,
      jobId: jobId,
      progressStage: outcomeUnconfirmed ? 'unconfirmed' : 'failed',
      detail: detail,
      retryable: retryable,
      outcomeUnconfirmed: outcomeUnconfirmed,
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
    if (_disposed) {
      return;
    }
    _disposed = true;
    lock(notify: false);
    super.dispose();
  }

  Future<CaptureJobSnapshot> _readJob(String id) async {
    final source = repository, cancel = CancelToken();
    _jobReads.add(cancel);
    try {
      return source is FreshCaptureRepository
          ? await (source as FreshCaptureRepository).readJobFresh(
              id,
              owner: owner!,
              cancelToken: cancel,
            )
          : await source.readJob(id, owner: owner!);
    } finally {
      _jobReads.remove(cancel);
    }
  }

  void _acceptReceipt(CaptureReceipt value) {
    if (value.jobId.trim().isEmpty ||
        !captureJobStates.contains(value.jobStatus)) {
      throw const FormatException(
        'Capture did not return a valid processing receipt.',
      );
    }
    _receiptEpoch++;
    _receiptRead?.cancel('A newer Capture receipt was accepted');
    receipt = value;
    selectedAsset = value.asset;
    receiptJob = null;
    assetFresh = false;
    receiptReadError = null;
    refreshingReceipt = false;
  }

  Future<void> refreshReceipt() async {
    final accepted = receipt;
    if (!available || accepted == null || refreshingReceipt) {
      return;
    }
    final generation = _generation, epoch = ++_receiptEpoch;
    final cancel = CancelToken();
    _receiptRead?.cancel('Capture receipt refresh replaced');
    _receiptRead = cancel;
    refreshingReceipt = true;
    assetFresh = false;
    receiptReadError = null;
    _emit();
    bool active() =>
        current(generation) &&
        epoch == _receiptEpoch &&
        identical(receipt, accepted) &&
        !cancel.isCancelled;
    try {
      final source = repository;
      final job = source is FreshCaptureRepository
          ? await (source as FreshCaptureRepository).readJobFresh(
              accepted.jobId,
              owner: owner!,
              cancelToken: cancel,
            )
          : await source.readJob(accepted.jobId, owner: owner!);
      if (!active()) {
        return;
      }
      if (job.id != accepted.jobId) {
        throw const FormatException('The processing job identity changed.');
      }
      receiptJob = job;
      _emit();
      if (accepted.asset != null && source is CaptureAssetRepository) {
        final asset = await (source as CaptureAssetRepository).readAsset(
          accepted.asset!.id,
          owner: owner!,
          cancelToken: cancel,
        );
        if (!active()) {
          return;
        }
        if (asset.contentIdentity != accepted.asset!.contentIdentity ||
            asset.ingestJobId != accepted.jobId) {
          throw const FormatException(
            'The original or processing identity changed.',
          );
        }
        selectedAsset = asset;
        assetFresh = true;
      }
    } catch (failure) {
      if (active()) {
        receiptReadError = failure is ApiException
            ? failure.message
            : failure is FormatException
            ? failure.message
            : 'The current source state could not be checked.';
        if (failure is ApiException &&
            const [401, 403, 404].contains(failure.statusCode)) {
          selectedAsset = null;
          receiptJob = null;
        }
      }
    } finally {
      if (active()) {
        refreshingReceipt = false;
        _emit();
      }
    }
  }

  Future<Uint8List> downloadOriginal(CaptureAssetSnapshot reviewed) async {
    final source = repository, generation = _generation;
    if (!available ||
        !assetFresh ||
        source is! CaptureAssetRepository ||
        selectedAsset?.contentIdentity != reviewed.contentIdentity) {
      throw StateError('Refresh the exact original before saving it.');
    }
    final bytes = await (source as CaptureAssetRepository).downloadOriginal(
      reviewed,
      owner: owner!,
    );
    if (!current(generation) ||
        !assetFresh ||
        selectedAsset?.contentIdentity != reviewed.contentIdentity) {
      bytes.fillRange(0, bytes.length, 0);
      throw StateError('Capture access changed. The original was discarded.');
    }
    return bytes;
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
  if (error is CaptureOutboxCapacityException) {
    return error.message;
  }
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
  if (bytes == null || bytes.isEmpty) {
    return;
  }
  bytes.fillRange(0, bytes.length, 0);
}
