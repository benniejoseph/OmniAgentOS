import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../../generated/native_contract.g.dart';
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
    mutationsAvailable: const [
      'agents.create',
      'agents.update',
    ].every(NativeContract.supportsOperation),
    agentDeleteAvailable: NativeContract.supportsOperation('agents.delete'),
    skillMutationsAvailable: const [
      'skills.create',
      'skills.update',
      'skills.delete',
    ].every(NativeContract.supportsOperation),
    moltbookAvailable: const [
      'moltbook.connection.show',
      'moltbook.connection.manage',
    ].every(NativeContract.supportsOperation),
  );
  final unregister = ref
      .read(reconnectCoordinatorProvider)
      .register('agents', c.refresh);
  ref.onDispose(unregister);
  c.refresh();
  return c;
});
