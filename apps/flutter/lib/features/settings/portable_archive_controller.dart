import 'dart:async';
import 'dart:isolate';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/network/api_exception.dart';
import '../results/created_file_export.dart';
import 'portable_archive_contracts.dart';
import 'portable_archive_repository.dart';

abstract interface class PortableArchiveVerifier {
  Future<PortableArchiveReceipt> verify(
    Uint8List bytes, {
    required String tenantId,
    required String actorId,
    String? expectedArchiveSha256,
  });
  void cancel();
  void dispose();
}

class _VerificationInput {
  const _VerificationInput(
    this.reply,
    this.bytes,
    this.tenantId,
    this.actorId,
    this.expectedArchiveSha256,
  );
  final SendPort reply;
  final TransferableTypedData bytes;
  final String tenantId, actorId;
  final String? expectedArchiveSha256;
}

class _VerificationFailure {
  const _VerificationFailure(this.code, this.message);
  final String code, message;
}

/// No parsed archive or private content leaves this isolate. Only the bounded
/// receipt or a content-free error crosses back to the presentation isolate.
Future<void> _verifyArchiveInIsolate(_VerificationInput input) async {
  try {
    final receipt = await verifyPortableArchive(
      input.bytes.materialize().asUint8List(),
      tenantId: input.tenantId,
      actorId: input.actorId,
      expectedArchiveSha256: input.expectedArchiveSha256,
    );
    input.reply.send(receipt);
  } on PortableArchiveVerificationException catch (failure) {
    input.reply.send(_VerificationFailure(failure.code, failure.message));
  } catch (_) {
    input.reply.send(
      const _VerificationFailure(
        'verification_failed',
        'Archive integrity could not be verified.',
      ),
    );
  }
}

class _VerificationJob {
  final port = ReceivePort();
  final completer = Completer<PortableArchiveReceipt>();
  StreamSubscription<Object?>? subscription;
  Isolate? isolate;
  Timer? deadline;
}

/// Owns the actual worker, including cancellation while Isolate.spawn is still
/// completing. A stale spawn is killed as soon as its handle becomes available.
class IsolatePortableArchiveVerifier implements PortableArchiveVerifier {
  IsolatePortableArchiveVerifier({this.timeout = const Duration(seconds: 45)});
  final Duration timeout;
  _VerificationJob? _job;
  bool _disposed = false;
  bool get running => _job != null;
  @override
  Future<PortableArchiveReceipt> verify(
    Uint8List bytes, {
    required String tenantId,
    required String actorId,
    String? expectedArchiveSha256,
  }) {
    if (_disposed || _job != null) {
      return Future.error(const CreatedFileExportScopeChanged());
    }
    final job = _job = _VerificationJob();
    job.subscription = job.port.listen((message) {
      if (!identical(_job, job)) return;
      if (message is PortableArchiveReceipt) {
        _finish(job, receipt: message);
      } else if (message is _VerificationFailure) {
        _finish(
          job,
          failure: PortableArchiveVerificationException(
            message.code,
            message.message,
          ),
        );
      } else {
        // Worker crash/exit metadata is never displayed or retained.
        _finish(
          job,
          failure: const PortableArchiveVerificationException(
            'verification_failed',
            'Archive integrity could not be verified.',
          ),
        );
      }
    });
    job.deadline = Timer(
      timeout,
      () => _finish(
        job,
        failure: const PortableArchiveVerificationException(
          'verification_timeout',
          'Local archive verification timed out.',
        ),
      ),
    );
    unawaited(
      _spawn(
        job,
        _VerificationInput(
          job.port.sendPort,
          TransferableTypedData.fromList([bytes]),
          tenantId,
          actorId,
          expectedArchiveSha256,
        ),
      ),
    );
    return job.completer.future;
  }

  Future<void> _spawn(_VerificationJob job, _VerificationInput input) async {
    try {
      final isolate = await Isolate.spawn(
        _verifyArchiveInIsolate,
        input,
        onError: job.port.sendPort,
        onExit: job.port.sendPort,
        errorsAreFatal: true,
      );
      if (!identical(_job, job) || _disposed) {
        isolate.kill(priority: Isolate.immediate);
      } else {
        job.isolate = isolate;
      }
    } catch (_) {
      _finish(
        job,
        failure: const PortableArchiveVerificationException(
          'verification_unavailable',
          'Local archive verification is unavailable.',
        ),
      );
    }
  }

  void _finish(
    _VerificationJob job, {
    PortableArchiveReceipt? receipt,
    Object? failure,
  }) {
    if (!identical(_job, job)) return;
    _job = null;
    job.isolate?.kill(priority: Isolate.immediate);
    job.deadline?.cancel();
    unawaited(job.subscription?.cancel());
    job.port.close();
    if (receipt != null) {
      job.completer.complete(receipt);
    } else {
      job.completer.completeError(
        failure ?? const CreatedFileExportScopeChanged(),
      );
    }
  }

  @override
  void cancel() {
    final job = _job;
    if (job != null) {
      _finish(job, failure: const CreatedFileExportScopeChanged());
    }
  }

  @override
  void dispose() {
    _disposed = true;
    cancel();
  }
}

enum PortableArchivePhase {
  idle,
  choosingDestination,
  downloading,
  verifying,
  saving,
  saved,
  canceled,
  failed,
  unavailable,
}

class _ArchiveAttempt {
  _ArchiveAttempt(this.generation);
  final int generation;
  final cancel = CancelToken();
  Uint8List? bytes;
  String? expectedArchiveSha256;
  PortableArchiveReceipt? verified;
  void clear() {
    bytes = null;
    expectedArchiveSha256 = null;
    verified = null;
  }
}

class PortableArchiveController extends ChangeNotifier {
  PortableArchiveController(
    this.repository, {
    this.exporter = const ScopedCreatedFileExporter(),
    PortableArchiveVerifier? verifier,
    DateTime Function()? now,
  }) : verifier = verifier ?? IsolatePortableArchiveVerifier(),
       _now = now ?? DateTime.now {
    _detach = repository.observeInvalidation(invalidateAndNotifyLater);
  }
  final PortableArchiveRepository repository;
  final ScopedCreatedFileExporter exporter;
  final PortableArchiveVerifier verifier;
  final DateTime Function() _now;
  void Function()? _detach;
  bool _disposed = false, _invalidated = false;
  int _generation = 0;
  _ArchiveAttempt? _attempt;
  Future<void>? _pending;
  PortableArchivePhase phase = PortableArchivePhase.idle;
  PortableArchiveReceipt? receipt;
  String? error;
  bool authorizationDenied = false;
  bool get available =>
      !_disposed &&
      !_invalidated &&
      !authorizationDenied &&
      repository.current &&
      !_disposed &&
      !_invalidated &&
      !authorizationDenied;
  bool get busy => _pending != null;
  bool get savingSupported => exporter.available;
  void _publish() {
    if (!_disposed) notifyListeners();
  }

  void invalidate({bool notify = true}) {
    _invalidated = true;
    _generation++;
    _attempt?.cancel.cancel('Portable archive scope changed.');
    _attempt?.clear();
    _attempt = null;
    verifier.cancel();
    _pending = null;
    receipt = null;
    error = null;
    phase = PortableArchivePhase.idle;
    if (notify) _publish();
  }

  void invalidateAndNotifyLater() {
    invalidate(notify: false);
    Future<void>.microtask(_publish);
  }

  bool _current(_ArchiveAttempt attempt) =>
      available &&
      identical(_attempt, attempt) &&
      attempt.generation == _generation &&
      !attempt.cancel.isCancelled;
  void _requireCurrent(_ArchiveAttempt attempt) {
    if (!_current(attempt)) {
      throw const CreatedFileExportScopeChanged();
    }
  }

  Future<void> verifyAndSave() {
    if (!available) return Future.value();
    final pending = _pending;
    if (pending != null) return pending;
    receipt = null;
    error = null;
    if (!savingSupported) {
      phase = PortableArchivePhase.unavailable;
      _publish();
      return Future.value();
    }
    final attempt = _attempt = _ArchiveAttempt(++_generation);
    phase = PortableArchivePhase.choosingDestination;
    final future = _run(attempt);
    _pending = future;
    _publish();
    return future;
  }

  Future<void> _downloadInto(_ArchiveAttempt attempt) async {
    _requireCurrent(attempt);
    final response = await repository.download(attempt.cancel);
    _requireCurrent(attempt);
    attempt.bytes = response.bytes;
    attempt.expectedArchiveSha256 = response.headers['x-asael-archive-sha256'];
  }

  Future<void> _run(_ArchiveAttempt attempt) async {
    // Register the busy future before a synchronous chooser or refusal settles.
    await Future<void>.value();
    if (!_current(attempt)) return;
    try {
      final date = _now().toUtc();
      String pad(int part) => part.toString().padLeft(2, '0');
      final filename =
          'asael-${date.year}-${pad(date.month)}-${pad(date.day)}-v2.json';
      final outcome = await exporter.save(
        filename: filename,
        isCurrent: () => _current(attempt),
        loadBytes: () async {
          _requireCurrent(attempt);
          phase = PortableArchivePhase.downloading;
          _publish();
          await _downloadInto(attempt);
          _requireCurrent(attempt);
          phase = PortableArchivePhase.verifying;
          _publish();
          _requireCurrent(attempt);
          final verified = await verifier.verify(
            attempt.bytes!,
            tenantId: repository.tenantId,
            actorId: repository.actorId,
            expectedArchiveSha256: attempt.expectedArchiveSha256,
          );
          _requireCurrent(attempt);
          attempt.verified = verified;
          phase = PortableArchivePhase.saving;
          _publish();
          _requireCurrent(attempt);
          return attempt.bytes!;
        },
      );
      if (!_current(attempt)) return;
      switch (outcome) {
        case CreatedFileExportOutcome.saved:
          receipt = attempt.verified;
          if (receipt == null) {
            throw StateError('The archive receipt is unavailable.');
          }
          phase = PortableArchivePhase.saved;
        case CreatedFileExportOutcome.canceled:
          phase = PortableArchivePhase.canceled;
        case CreatedFileExportOutcome.unavailable:
          phase = PortableArchivePhase.unavailable;
        case CreatedFileExportOutcome.scopeChanged:
          invalidate();
      }
    } catch (failure) {
      if (!_current(attempt)) return;
      if (failure is CreatedFileExportScopeChanged) {
        invalidate();
      } else if (failure is NativeAuthorityVerificationException ||
          (failure is ApiException &&
              (failure.statusCode == 401 || failure.statusCode == 403))) {
        invalidate(notify: false);
        authorizationDenied = true;
        _publish();
      } else {
        final saving = phase == PortableArchivePhase.saving;
        receipt = null;
        phase = PortableArchivePhase.failed;
        error = saving
            ? 'The file could not be saved. A partial destination file may exist. No retry was performed.'
            : failure is ApiException &&
                  failure.diagnosticCode == 'download_size_limit'
            ? 'This archive exceeds the native 16 MiB limit. Use the browser workspace to export it.'
            : failure is ApiException &&
                  failure.diagnosticCode == 'download_deadline'
            ? 'The archive download timed out. No file was saved.'
            : failure is PortableArchiveVerificationException
            ? 'Archive integrity could not be verified. No file was saved.'
            : 'The archive could not be downloaded and verified. No file was saved.';
      }
    } finally {
      attempt.clear();
      if (identical(_attempt, attempt)) {
        _attempt = null;
        _pending = null;
        _publish();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _detach?.call();
    _detach = null;
    invalidate(notify: false);
    verifier.dispose();
    super.dispose();
  }
}
