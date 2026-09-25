import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/sync/reconnect_coordinator.dart';
import 'meetings.dart';
import 'meetings_api_repository.dart';

final meetingsRepositoryProvider = Provider<MeetingsRepository>(
  (ref) => ApiMeetingsRepository(ref.watch(apiClientProvider)),
);

final meetingsControllerProvider = ChangeNotifierProvider<MeetingsController>((
  ref,
) {
  final controller = MeetingsController(ref.watch(meetingsRepositoryProvider));
  final unregister = ref
      .read(reconnectCoordinatorProvider)
      .register(
        'meetings',
        controller.refresh,
        classification: ReconciliationClass.freshness,
        freshnessScope: '/meetings',
      );
  ref.onDispose(unregister);
  controller.refresh();
  return controller;
});
