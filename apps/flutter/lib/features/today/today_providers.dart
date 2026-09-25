import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/sync/reconnect_coordinator.dart';
import 'today.dart';
import 'today_api_repository.dart';

final todayRepositoryProvider = Provider<TodayRepository>(
  (ref) => ApiTodayRepository(ref.watch(apiClientProvider)),
);
final todayControllerProvider = ChangeNotifierProvider<TodayController>((ref) {
  final controller = TodayController(ref.watch(todayRepositoryProvider));
  final unregister = ref
      .read(reconnectCoordinatorProvider)
      .register(
        'today',
        controller.refresh,
        classification: ReconciliationClass.freshness,
        freshnessScope: '/today',
      );
  ref.onDispose(unregister);
  controller.refresh();
  return controller;
});
