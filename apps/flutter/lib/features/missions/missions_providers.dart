import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/sync/reconnect_coordinator.dart';
import 'missions.dart';
import 'missions_api_repository.dart';

final missionsRepositoryProvider = Provider<MissionsRepository>(
  (ref) => ApiMissionsRepository(ref.watch(apiClientProvider)),
);
final missionsControllerProvider = ChangeNotifierProvider<MissionsController>((
  ref,
) {
  final controller = MissionsController(ref.watch(missionsRepositoryProvider));
  final unregister = ref
      .read(reconnectCoordinatorProvider)
      .register(
        'missions',
        controller.refresh,
        classification: ReconciliationClass.freshness,
      );
  ref.onDispose(unregister);
  controller.refresh();
  return controller;
});
