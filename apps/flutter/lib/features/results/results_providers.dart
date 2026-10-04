import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/config/app_config.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../../generated/native_contract.g.dart';
import '../auth/application/session_controller.dart';
import 'result_contracts.dart';
import 'results.dart';
import 'results_api_repository.dart';

final resultsDeploymentProvider = Provider<String>(
  (ref) => AppConfig.apiBaseUrl,
);
final resultsRepositoryProvider = Provider<ResultsRepository>((ref) {
  final access = ResultsAccess(
    deployment: ref.watch(resultsDeploymentProvider),
    ready: false,
    cancellationAvailable: NativeContract.supportsOperation(
      'evidence.run.cancel',
    ),
  );
  final repository = ApiResultsRepository(
    ref.watch(apiClientProvider),
    access: access,
  );
  ref.listen(sessionControllerProvider, (_, state) {
    final session = state.value;
    access.update(
      tenant: session?.tenantId,
      actor: session?.actorId,
      nextRole: session?.role,
      available: !state.isLoading && !state.hasError && session != null,
      clear: !state.isLoading && !state.hasError && session == null,
    );
  }, fireImmediately: true);
  ref.onDispose(() {
    access.close();
    repository.dispose();
    access.dispose();
  });
  return repository;
});
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
