import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'meetings.dart';

class ApiMeetingsRepository implements MeetingsRepository {
  const ApiMeetingsRepository(this.api);
  final ApiClient api;

  @override
  Future<List<Meeting>> list() async {
    final json = await api.getJson(
      NativePaths.meetingsList,
      query: {'limit': 100},
    );
    return ((json['meetings'] as List?) ?? const [])
        .whereType<Map>()
        .map((item) => Meeting.fromJson(Map<String, dynamic>.from(item)))
        .toList(growable: false);
  }

  @override
  Future<Meeting> detail(String id) async {
    final json = await api.getJson(NativePaths.meetingsGet(id));
    final value = json['meeting'];
    if (value is! Map) throw StateError('Meeting not found.');
    return Meeting.fromJson(Map<String, dynamic>.from(value));
  }
}
