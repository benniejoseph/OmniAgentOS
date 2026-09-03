import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../auth/application/session_controller.dart';
import 'agents.dart';
import 'agents_api_repository.dart';

final agentsRepositoryProvider = Provider<AgentsRepository>(
  (ref) => ApiAgentsRepository(ref.watch(apiClientProvider)),
);
final agentsControllerProvider = ChangeNotifierProvider<AgentsController>((
  ref,
) {
  final c = AgentsController(
    ref.watch(agentsRepositoryProvider),
    canManage: ref.watch(sessionControllerProvider).value?.canManage ?? false,
  );
  c.refresh();
  return c;
});
