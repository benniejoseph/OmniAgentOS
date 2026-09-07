import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'today.dart';

class ApiTodayRepository implements TodayRepository {
  const ApiTodayRepository(this.api);
  final ApiClient api;
  @override
  Future<TodaySnapshot> load() async =>
      TodaySnapshot.fromJson(await api.getJson(NativePaths.todayGet));
  @override
  Future<TodayItem> create({
    required String title,
    String kind = 'task',
    TodayPriority priority = TodayPriority.medium,
    DateTime? dueAt,
  }) async {
    final json = await api.postJson(
      NativePaths.todayCreate,
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
      NativePaths.todayUpdate(id),
      data: changes,
    );
    return TodayItem.fromJson(json['item'] as Json);
  }

  @override
  Future<DailyBrief?> generateBrief({bool force = false}) async {
    final json = await api.postJson(NativePaths.todayBrief, data: {'force': force});
    return json['brief'] is Json
        ? DailyBrief.fromJson(json['brief'] as Json)
        : null;
  }
}
