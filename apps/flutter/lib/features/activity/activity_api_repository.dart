import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import 'activity.dart';

class ApiActivityRepository implements ActivityRepository, ActivityDetailRepository {
  ApiActivityRepository(this.api);
  final ApiClient api;

  @override
  Future<ActivityTaskDetail> loadTaskDetail({
    required String runId,
    required CancelToken cancelToken,
  }) async {
    final body = await api.getJsonFreshCancelable(
      '/api/runs/${Uri.encodeComponent(runId)}',
      cancelToken: cancelToken,
    );
    return ActivityTaskDetail.fromJson(body, runId);
  }

  @override
  Future<ActivitySnapshot> load({
    required ActivityGroup group,
    String? cursor,
    required CancelToken cancelToken,
  }) async {
    if (cursor != null && (cursor.isEmpty || cursor.length > 2000)) {
      throw const FormatException('Invalid Activity cursor.');
    }
    final body = await api.getJsonFreshCancelable(
      '/api/activity',
      query: {
        'group': group.wire,
        'limit': activityPageLimit,
        'cursor': ?cursor,
      },
      cancelToken: cancelToken,
    );
    return ActivitySnapshot.fromJson(body, group);
  }
}
