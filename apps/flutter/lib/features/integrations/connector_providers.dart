import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_client.dart';
import '../../core/network/native_workspace_access.dart';
import '../agents/specialist_api_client.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import '../auth/application/session_controller.dart';
import 'connector_controller.dart';
import 'connector_recovery_store.dart';
import 'connector_repository.dart';

final connectorControllerProvider = Provider.autoDispose<ConnectorController?>((
  ref,
) {
  var active = true;
  ref.onDispose(() => active = false);
  final access = ref.watch(nativeWorkspaceAccessProvider);
  if (access == null || !access.current || !active || !ref.mounted) {
    return null;
  }
  final recovery = ref.watch(specialistRecoveryProvider);
  // A dependency read or the access probe can synchronously dispose this Ref.
  if (!active || !ref.mounted || !access.current || !active || !ref.mounted) {
    return null;
  }
  final controller = ConnectorController(
    ApiConnectorRepository(access),
    ProtectedConnectorRecoveryStore(access, recovery),
  );
  ref.onDispose(controller.dispose);
  ref.listen(apiClientProvider, (_, next) {
    if (!identical(next, access.api)) {
      controller.invalidate();
    }
  });
  ref.listen(sessionControllerProvider, (_, next) {
    final owner = next.value;
    if (next.isLoading ||
        next.hasError ||
        owner?.tenantId != access.authority.tenantId ||
        owner?.actorId != access.authority.actorId ||
        owner?.userId != access.authority.canonicalUserId ||
        owner?.role != access.authority.role) {
      controller.invalidate();
    }
  });
  ref.listen(biometricSessionLockControllerProvider, (_, next) {
    if (next.state.blocksInteraction) {
      controller.invalidate();
    }
  });
  ref.listen(specialistRecoveryProvider, (_, next) {
    if (!identical(next, recovery)) {
      controller.invalidate();
    }
  });
  unawaited(controller.initialize());
  return controller;
});
