import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../../generated/native_contract.g.dart';
import '../auth/application/session_controller.dart';
import 'agent_council.dart';
import 'agent_council_api_repository.dart';
import 'agents.dart';
import 'agents_api_repository.dart';

final agentsRepositoryProvider = Provider<AgentsRepository>(
  (ref) => ApiAgentsRepository(ref.watch(apiClientProvider)),
);
final agentCouncilRepositoryProvider = Provider<AgentCouncilRepository>(
  (ref) => ApiAgentCouncilRepository(ref.watch(apiClientProvider)),
);
final agentCouncilControllerProvider =
    ChangeNotifierProvider<AgentCouncilController>((ref) {
      final controller = AgentCouncilController(
        ref.watch(agentCouncilRepositoryProvider),
        controlAvailable: NativeContract.supportsOperation(
          'agents.tasks.cancel',
        ),
      );
      final unregister = ref
          .read(reconnectCoordinatorProvider)
          .register(
            'agent-council',
            controller.refresh,
            classification: ReconciliationClass.freshness,
          );
      ref.onDispose(unregister);
      controller.refresh();
      return controller;
    });
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
    learningReadAvailable: NativeContract.supportsOperation(
      'agents.learning.show',
    ),
    governanceReadAvailable: const [
      'agents.release.show',
      'agents.adaptations.list',
    ].every(NativeContract.supportsOperation),
    governanceMutationAvailable: const [
      'agents.release.manage',
      'agents.adaptations.manage',
    ].every(NativeContract.supportsOperation),
  );
  final unregister = ref
      .read(reconnectCoordinatorProvider)
      .register(
        'agents',
        () => c.ledger == null ? Future<void>.value() : c.refresh(),
        classification: ReconciliationClass.freshness,
      );
  ref.onDispose(unregister);
  return c;
});
