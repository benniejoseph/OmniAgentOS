import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/network/native_workspace_access.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../auth/application/session_controller.dart';
import 'self_improvement_controller.dart';
import 'self_improvement_repository.dart';

final selfImprovementRepositoryProvider =
    Provider.autoDispose<SelfImprovementRepositoryApi>((ref) {
      final api = ref.watch(apiClientProvider);
      final access = ref.watch(nativeWorkspaceAccessProvider);
      final state = ref.watch(sessionControllerProvider);
      final session = state.value;
      final email = session?.email.trim().toLowerCase();
      final bound =
          access != null &&
          session != null &&
          !state.isLoading &&
          !state.hasError &&
          session.tenantId == access.authority.tenantId &&
          session.actorId == access.authority.actorId &&
          session.userId.toLowerCase() ==
              access.authority.canonicalUserId.toLowerCase() &&
          email != null &&
          RegExp(r'^[^\s@]+@[^\s@]+$').hasMatch(email);
      bool emailIsCurrent() {
        if (!ref.mounted || !bound) return false;
        final next = ref.read(sessionControllerProvider);
        final owner = next.value;
        return !next.isLoading &&
            !next.hasError &&
            owner != null &&
            owner.tenantId == session.tenantId &&
            owner.actorId == session.actorId &&
            owner.userId == session.userId &&
            owner.email.trim().toLowerCase() == email;
      }

      return ApiSelfImprovementRepository(
        api,
        access,
        verifiedOwnerEmail: bound ? email : null,
        ownerEmailIsCurrent: bound ? emailIsCurrent : null,
      );
    });
final selfImprovementControllerProvider =
    ChangeNotifierProvider.autoDispose<SelfImprovementController>((ref) {
      final controller = SelfImprovementController(
        ref.watch(selfImprovementRepositoryProvider),
      );
      final unregister = ref
          .read(reconnectCoordinatorProvider)
          .register(
            'self-improvement',
            controller.refresh,
            classification: ReconciliationClass.freshness,
            freshnessScope: '/improvement',
          );
      ref.onDispose(unregister);
      return controller;
    });
