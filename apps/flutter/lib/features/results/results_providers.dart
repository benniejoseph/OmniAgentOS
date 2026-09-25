import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/sync/reconnect_coordinator.dart';
import 'results.dart';
import 'results_api_repository.dart';

final resultsRepositoryProvider = Provider<ResultsRepository>(
  (ref) => ApiResultsRepository(ref.watch(apiClientProvider)),
);
final resultsControllerProvider = ChangeNotifierProvider<ResultsController>((
  ref,
) {
  final controller = ResultsController(ref.watch(resultsRepositoryProvider));
  final unregister = ref
      .read(reconnectCoordinatorProvider)
      .register(
        'results',
        controller.refresh,
        classification: ReconciliationClass.freshness,
        freshnessScope: '/results',
      );
  ref.onDispose(unregister);
  controller.refresh();
  return controller;
});
