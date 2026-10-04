import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../auth/application/session_controller.dart';
import 'knowledge.dart';
import 'knowledge_api_repository.dart';

// Include the canonical user ID as well as the compatibility actor, role and
// tenant. Reusing an email address must not retain another user's projection.
final _knowledgeScopeProvider = Provider<String?>((ref) {
  final session = ref.watch(sessionControllerProvider);
  final value = session.value;
  if (session.isLoading ||
      session.hasError ||
      value == null ||
      value.userId.isEmpty) {
    return null;
  }
  return [
    value.tenantId,
    value.actorId,
    value.userId,
    value.role,
  ].join('\u0000');
});
final knowledgeRepositoryProvider = Provider<KnowledgeRepository>((ref) {
  ref.watch(_knowledgeScopeProvider);
  final repository = ApiKnowledgeRepository(
    ref.watch(apiClientProvider),
    expectedTenantId: ref.watch(sessionControllerProvider).value?.tenantId,
  );
  ref.onDispose(repository.dispose);
  return repository;
});
final knowledgeControllerProvider = ChangeNotifierProvider<KnowledgeController>((
  ref,
) {
  final scope = ref.watch(_knowledgeScopeProvider);
  final controller = KnowledgeController(
    ref.watch(knowledgeRepositoryProvider),
    enabled: scope != null,
    canManage:
        scope != null &&
        (ref.watch(sessionControllerProvider).value?.canManage ?? false),
    // Publishing a future operation alone cannot enable an unreviewed adapter.
    mutationsAvailable: false,
  );
  final unregister = ref
      .read(reconnectCoordinatorProvider)
      .register(
        'knowledge',
        controller.refresh,
        classification: ReconciliationClass.freshness,
        freshnessScope: '/knowledge',
      );
  ref.onDispose(unregister);
  controller.refresh();
  return controller;
});
