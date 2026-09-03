import '../../core/network/api_client.dart';
import 'capture.dart';

class ApiCaptureRepository implements CaptureRepository {
  const ApiCaptureRepository(this.api);
  final ApiClient api;
  @override
  Future<CaptureReceipt> submit(
    CaptureDraft draft, {
    required String idempotencyKey,
  }) async {
    final json = await api.postMultipart(
      '/api/capture',
      fields: {
        'content': draft.content,
        'title': draft.title,
        'tags': draft.tags.join(','),
      },
      bytes: draft.file?.bytes,
      filename: draft.file?.name,
      contentType: draft.file?.contentType,
      headers: {'idempotency-key': idempotencyKey},
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
