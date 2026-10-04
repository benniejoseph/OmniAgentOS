import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../../generated/native_contract.g.dart';
import '../auth/application/session_controller.dart';
import 'projects.dart';
import 'projects_api_repository.dart';

final projectsRepositoryProvider = Provider<ProjectsRepository>((ref) {
  final access = ProjectAccess(
    ready: false,
    mutationsAvailable: NativeContract.supportsOperation('workspaces.update'),
  );
  final repository = ApiProjectsRepository(
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
final projectsControllerProvider = ChangeNotifierProvider<ProjectsController>((
  ref,
) {
  final controller = ProjectsController(ref.watch(projectsRepositoryProvider));
  final unregister = ref
      .read(reconnectCoordinatorProvider)
      .register(
        'projects',
        controller.refresh,
        classification: ReconciliationClass.freshness,
        freshnessScope: '/projects',
      );
  ref.onDispose(unregister);
  controller.refresh();
  return controller;
});
