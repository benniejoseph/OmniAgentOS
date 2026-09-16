import 'dart:typed_data';

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
    if (title.length > 240) return 'Titles must be 240 characters or shorter.';
    if (tags.length > 50 || tags.any((tag) => tag.trim().length > 80)) {
      return 'Use at most 50 tags, each 80 characters or shorter.';
    }
    if (file != null &&
        (file!.bytes.isEmpty ||
            file!.bytes.length > captureAttachmentMaxBytes)) {
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
  });

  final String name, contentType;
  final Uint8List bytes;
}

class CaptureReceipt {
  const CaptureReceipt({
    required this.jobId,
    required this.title,
    required this.tags,
    this.jobStatus = 'queued',
    this.progressStage,
    this.lastError,
  });

  final String jobId, title;
  final List<String> tags;
  final String jobStatus;
  final String? progressStage;
  final String? lastError;
}

class CaptureJobSnapshot {
  const CaptureJobSnapshot({
    required this.id,
    required this.status,
    this.progressStage,
    this.lastError,
  });

  final String id;
  final String status;
  final String? progressStage;
  final String? lastError;
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
  });

  final String id;
  final String name;
  final CaptureBatchState state;
  final DateTime createdAt;
  final String? jobId;
  final String? progressStage;
  final String? detail;
  final bool retryable;

  CaptureBatchItem copyWith({
    CaptureBatchState? state,
    String? jobId,
    String? progressStage,
    String? detail,
    bool? retryable,
  }) => CaptureBatchItem(
    id: id,
    name: name,
    state: state ?? this.state,
    createdAt: createdAt,
    jobId: jobId ?? this.jobId,
    progressStage: progressStage ?? this.progressStage,
    detail: detail,
    retryable: retryable ?? this.retryable,
  );
}

class CaptureBatchEnqueueResult {
  const CaptureBatchEnqueueResult({required this.queued, required this.failed});

  final int queued;
  final int failed;
}
