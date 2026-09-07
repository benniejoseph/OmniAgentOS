import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'missions.dart';

class ApiMissionsRepository implements MissionsRepository {
  const ApiMissionsRepository(this.api);
  final ApiClient api;
  @override
  Future<List<Mission>> list() async {
    final json = await api.getJson(NativePaths.missionsList, query: {'limit': 50});
    return ((json['missions'] as List?) ?? const [])
        .whereType<Json>()
        .map(Mission.fromJson)
        .toList();
  }

  @override
  Future<MissionDetail> detail(String id) async => MissionDetail.fromJson(
    await api.getJson(NativePaths.missionsGet(id)),
  );
  @override
  Future<Mission> create({
    required String title,
    required String objective,
    String priority = 'normal',
  }) async {
    final json = await api.postJson(
      NativePaths.missionsCreate,
      data: {'title': title, 'objective': objective, 'priority': priority},
    );
    return Mission.fromJson(json['mission'] as Json);
  }

  @override
  Future<Mission> transition(String id, String status) async {
    final json = await api.patchJson(
      NativePaths.missionsUpdate(id),
      data: {'status': status},
    );
    return Mission.fromJson(json['mission'] as Json);
  }

  @override
  Future<MissionEventPage> events(String id, {int afterSeq = 0}) async =>
      MissionEventPage.fromJson(
        await api.getJson(
          NativePaths.missionsEvents(id),
          query: {'afterSeq': afterSeq, 'limit': 50},
        ),
      );
}
