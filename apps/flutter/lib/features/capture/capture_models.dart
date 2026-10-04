import 'dart:typed_data';

import 'capture_projection.dart';

const captureAttachmentMaxBytes = 5 * 1024 * 1024;
const captureBatchMaxFiles = 25;
const captureBatchConcurrency = 3;

class CaptureDraft {
  const CaptureDraft({
    required this.content,
    this.title = '',
    this.tags = const [],
    this.file,
    this.kind = CaptureKind.text,
  });

  final String content, title;
  final List<String> tags;
  final CaptureAttachment? file;
  final CaptureKind kind;

  bool get valid => validationError == null;

  String? get validationError {
    if (content.trim().isEmpty && file == null) {
      return 'Add a note or attachment.';
    }
    if (content.length > 20000) {
      return 'Notes must be 20,000 characters or shorter.';
    }
    if (title.length > 240) {
      return 'Titles must be 240 characters or shorter.';
    }
    if (tags.length > 50 || tags.any((tag) => tag.trim().length > 80)) {
      return 'Use at most 50 tags, each 80 characters or shorter.';
    }
    if (file != null &&
        (file!.bytes.isEmpty ||
            file!.bytes.length > captureAttachmentMaxBytes ||
            file!.byteLength != file!.bytes.length)) {
      return 'Choose a non-empty attachment up to 5 MB.';
    }
    return null;
  }
}

enum CaptureKind { text, scan, image, file, meetingMedia }

class CaptureAttachment {
  const CaptureAttachment({
    required this.name,
    required this.bytes,
    required this.contentType,
    int? byteLength,
  }) : byteLength = byteLength ?? bytes.length;

  final String name, contentType;
  final Uint8List bytes;
  final int byteLength;
}

class CaptureReceipt {
  const CaptureReceipt({
    required this.jobId,
    required this.title,
    required this.tags,
    this.jobStatus = 'queued',
    this.progressStage,
    this.lastError,
    this.source,
    this.asset,
  });

  final String jobId, title;
  final List<String> tags;
  final String jobStatus;
  final String? progressStage;
  final String? lastError;
  final String? source;
  final CaptureAssetSnapshot? asset;
}

class CaptureJobSnapshot {
  const CaptureJobSnapshot({
    required this.id,
    required this.status,
    this.progressStage,
    this.lastError,
    this.documentId,
  });

  final String id;
  final String status;
  final String? progressStage;
  final String? lastError;
  final String? documentId;
}

enum CaptureBatchState { queued, uploading, processing, completed, failed }

class CaptureBatchItem {
  const CaptureBatchItem({
    required this.id,
    required this.name,
    required this.state,
    required this.createdAt,
    this.jobId,
    this.progressStage,
    this.detail,
    this.retryable = false,
    this.outcomeUnconfirmed = false,
    this.asset,
    this.source,
  });

  final String id;
  final String name;
  final CaptureBatchState state;
  final DateTime createdAt;
  final String? jobId;
  final String? progressStage;
  final String? detail;
  final bool retryable;
  final bool outcomeUnconfirmed;
  final CaptureAssetSnapshot? asset;
  final String? source;

  CaptureBatchItem copyWith({
    CaptureBatchState? state,
    String? jobId,
    String? progressStage,
    String? detail,
    bool? retryable,
    bool? outcomeUnconfirmed,
    CaptureAssetSnapshot? asset,
    String? source,
  }) => CaptureBatchItem(
    id: id,
    name: name,
    state: state ?? this.state,
    createdAt: createdAt,
    jobId: jobId ?? this.jobId,
    progressStage: progressStage ?? this.progressStage,
    detail: detail,
    retryable: retryable ?? this.retryable,
    outcomeUnconfirmed: outcomeUnconfirmed ?? this.outcomeUnconfirmed,
    asset: asset ?? this.asset,
    source: source ?? this.source,
  );
}

class CaptureBatchEnqueueResult {
  const CaptureBatchEnqueueResult({required this.queued, required this.failed});

  final int queued;
  final int failed;
}
