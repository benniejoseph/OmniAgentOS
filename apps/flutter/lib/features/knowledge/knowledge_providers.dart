import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/storage/secure_session_store.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import '../auth/application/session_controller.dart';
import 'knowledge.dart';
import 'knowledge_api_repository.dart';
import 'knowledge_mutations.dart';
import 'knowledge_recovery_store.dart';

final knowledgeRecoveryStoreProvider = Provider<KnowledgeRecoveryStore>(
  (ref) => EncryptedKnowledgeRecoveryStore(
    ref.watch(secureSessionStoreProvider).readOrCreateOfflineProjectionSecret,
  ),
);

// Include the canonical user ID as well as the compatibility actor, role and
// tenant. Reusing an email address must not retain another user's projection.
final _knowledgeScopeProvider = Provider<String?>((ref) {
  final session = ref.watch(sessionControllerProvider);
  final locked = ref
      .watch(biometricSessionLockControllerProvider)
      .state
      .blocksInteraction;
  final value = session.value;
  if (session.isLoading ||
      session.hasError ||
      value == null ||
      locked ||
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
  final api = ref.watch(apiClientProvider), access = KnowledgeAccess();
  final apiScope = NativeRequestAuthority.normalizeApiBaseUrl(api.apiBaseUrl);
  void update() {
    if (!ref.mounted) return;
    final session = ref.read(sessionControllerProvider);
    final next = KnowledgeOwner.fromSession(session.value, apiScope);
    access.update(
      next,
      !session.isLoading &&
          !session.hasError &&
          next != null &&
          !ref
              .read(biometricSessionLockControllerProvider)
              .state
              .blocksInteraction,
    );
  }

  bool current() {
    if (!ref.mounted || !identical(ref.read(apiClientProvider), api)) {
      return false;
    }
    if (!ref.mounted || !access.readable) return false;
    final session = ref.read(sessionControllerProvider);
    return !session.isLoading &&
        !session.hasError &&
        KnowledgeOwner.fromSession(session.value, apiScope)?.key ==
            access.owner?.key &&
        !ref
            .read(biometricSessionLockControllerProvider)
            .state
            .blocksInteraction;
  }

  final repository = ApiKnowledgeRepository(
    api,
    access: access,
    authorityProbe: current,
  );
  ref.listen(apiClientProvider, (before, after) {
    if (!identical(before, after)) access.close();
  });
  ref.listen(
    sessionControllerProvider,
    (_, _) => update(),
    fireImmediately: true,
  );
  ref.listen(biometricSessionLockControllerProvider, (_, _) => update());
  ref.onDispose(() {
    access.close(notify: false);
    repository.dispose();
    access.dispose();
  });
  return repository;
});
final knowledgeControllerProvider = ChangeNotifierProvider<KnowledgeController>(
  (ref) {
    final scope = ref.watch(_knowledgeScopeProvider);
    final controller = KnowledgeController(
      ref.watch(knowledgeRepositoryProvider),
      enabled: scope != null,
      canManage:
          scope != null &&
          (ref.watch(sessionControllerProvider).value?.canManage ?? false),
      // Legacy generic methods remain unavailable; each new adapter checks its own operation.
      mutationsAvailable: false,
      recoveryStore: ref.watch(knowledgeRecoveryStoreProvider),
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
    controller.reloadRecovery();
    controller.refresh();
    return controller;
  },
);
