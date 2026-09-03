import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import 'projects.dart';
import 'projects_api_repository.dart';

final projectsRepositoryProvider = Provider<ProjectsRepository>(
  (ref) => ApiProjectsRepository(ref.watch(apiClientProvider)),
);
final projectsControllerProvider = ChangeNotifierProvider<ProjectsController>(
  (ref) => ProjectsController(ref.watch(projectsRepositoryProvider))..refresh(),
);
