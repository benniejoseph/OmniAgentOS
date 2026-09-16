import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'capture_controller.dart';
import 'capture_models.dart';
import 'capture_outbox.dart';

class ApiCaptureRepository implements CaptureRepository {
  const ApiCaptureRepository(this.api);
  final ApiClient api;
  @override
  Future<CaptureReceipt> submit(
    CaptureDraft draft, {
    required String idempotencyKey,
    required CaptureOwnerBinding owner,
  }) async {
    final json = await api.postMultipart(
      NativePaths.captureCreate,
      fields: {
        'content': draft.content,
        'title': draft.title,
        'tags': draft.tags.join(','),
      },
      bytes: draft.file?.bytes,
      filename: draft.file?.name,
      contentType: draft.file?.contentType,
      headers: {
        'idempotency-key': idempotencyKey,
        'x-request-id': idempotencyKey,
        'x-omni-correlation-id': idempotencyKey,
        'x-asael-capture-owner-sha256': await owner.sha256(),
      },
    );
    final job = json['job'] as Map<String, dynamic>? ?? const {};
    final capture = json['capture'] as Map<String, dynamic>? ?? const {};
    return CaptureReceipt(
      jobId: job['id'] as String? ?? '',
      title: capture['title'] as String? ?? draft.title,
      tags: ((capture['tags'] as List?) ?? draft.tags)
          .whereType<String>()
          .toList(),
      jobStatus: job['status'] as String? ?? 'queued',
      progressStage: _progressStage(job['progress']),
      lastError: job['lastError'] as String?,
    );
  }

  @override
  Future<CaptureJobSnapshot> readJob(
    String jobId, {
    required CaptureOwnerBinding owner,
  }) async {
    if (owner.tenantId.trim().isEmpty || owner.actorId.trim().isEmpty) {
      throw const FormatException('A Capture owner is required.');
    }
    final json = await api.getJson(NativePaths.operationsJob(jobId));
    final job = json['job'] as Map<String, dynamic>? ?? const {};
    final returnedId = job['id'] as String? ?? '';
    final status = job['status'] as String? ?? '';
    if (returnedId != jobId || status.isEmpty) {
      throw const FormatException(
        'The Capture service returned an invalid processing job.',
      );
    }
    return CaptureJobSnapshot(
      id: returnedId,
      status: status,
      progressStage: _progressStage(job['progress']),
      lastError: job['lastError'] as String?,
    );
  }
}

String? _progressStage(Object? value) {
  if (value is! Map) return null;
  final stage = value['stage'];
  return stage is String && stage.trim().isNotEmpty ? stage.trim() : null;
}
