import '../../core/network/api_client.dart';
import 'inbox.dart';

class ApiInboxRepository implements InboxRepository {
  const ApiInboxRepository(this.api);
  final ApiClient api;
  @override
  Future<ApprovalQueue> load() async => ApprovalQueue.fromJson(
    await api.getJson('/api/approvals', query: {'limit': 50}),
  );
  @override
  Future<void> decide(
    ApprovalItem item, {
    required bool approve,
    String? reason,
    bool breakGlass = false,
    String? ticket,
  }) async {
    await api.postJson(
      '/api/approvals/${Uri.encodeComponent(item.id)}',
      data: {
        'kind': item.kind,
        'decision': approve ? 'approve' : 'reject',
        if (reason?.trim().isNotEmpty ?? false) 'reason': reason!.trim(),
        if (breakGlass) 'breakGlass': true,
        if (ticket?.trim().isNotEmpty ?? false) 'ticket': ticket!.trim(),
      },
    );
  }
}
