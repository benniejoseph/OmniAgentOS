import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/sync/reconnect_coordinator.dart';
import 'projects.dart';
import 'projects_api_repository.dart';

final projectsRepositoryProvider = Provider<ProjectsRepository>(
  (ref) => ApiProjectsRepository(ref.watch(apiClientProvider)),
);
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
