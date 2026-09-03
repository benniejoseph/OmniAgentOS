import '../../core/network/api_client.dart';
import 'today.dart';

class ApiTodayRepository implements TodayRepository {
  const ApiTodayRepository(this.api);
  final ApiClient api;
  @override
  Future<TodaySnapshot> load() async =>
      TodaySnapshot.fromJson(await api.getJson('/api/today'));
  @override
  Future<TodayItem> create({
    required String title,
    String kind = 'task',
    TodayPriority priority = TodayPriority.medium,
    DateTime? dueAt,
  }) async {
    final json = await api.postJson(
      '/api/today',
      data: {
        'title': title,
        'kind': kind,
        'priority': priority.name,
        if (dueAt != null) 'dueAt': dueAt.toUtc().toIso8601String(),
      },
    );
    return TodayItem.fromJson(json['item'] as Json);
  }

  @override
  Future<TodayItem> update(String id, Json changes) async {
    final json = await api.patchJson(
      '/api/today/${Uri.encodeComponent(id)}',
      data: changes,
    );
    return TodayItem.fromJson(json['item'] as Json);
  }

  @override
  Future<DailyBrief?> generateBrief({bool force = false}) async {
    final json = await api.postJson('/api/today/brief', data: {'force': force});
    return json['brief'] is Json
        ? DailyBrief.fromJson(json['brief'] as Json)
        : null;
  }
}
