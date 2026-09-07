import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'capture.dart';
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
    );
  }
}
