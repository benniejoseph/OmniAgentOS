import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_client.dart';
import '../../core/network/native_workspace_access.dart';
import '../agents/specialist_api_client.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import '../auth/application/session_controller.dart';
import 'connector_mcp_discovery_controller.dart';
import 'connector_mcp_discovery_recovery_store.dart';
import 'connector_mcp_discovery_repository.dart';

final connectorMcpDiscoveryControllerProvider =
    Provider.autoDispose<ConnectorMcpDiscoveryController?>((ref) {
      var active = true;
      ConnectorMcpDiscoveryController? controller;
      ref.onDispose(() {
        active = false;
        controller?.dispose();
      });
      final access = ref.watch(nativeWorkspaceAccessProvider);
      if (!active || !ref.mounted || access == null || !access.current) {
        return null;
      }
      if (!active || !ref.mounted) {
        return null;
      }
      final store = ref.watch(specialistRecoveryProvider);
      if (!active || !ref.mounted || !access.current) {
        return null;
      }
      if (!active || !ref.mounted) {
        return null;
      }
      final next = ConnectorMcpDiscoveryController(
        ApiConnectorMcpDiscoveryRepository(
          access,
          isCurrent: () => active && ref.mounted,
        ),
        ProtectedConnectorMcpDiscoveryRecoveryStore(access, store),
      );
      controller = next;
      ref.listen(apiClientProvider, (_, value) {
        if (!identical(value, access.api)) {
          next.invalidate();
        }
      });
      ref.listen(sessionControllerProvider, (_, value) {
        final owner = value.value;
        if (value.isLoading ||
            value.hasError ||
            owner?.tenantId != access.authority.tenantId ||
            owner?.actorId != access.authority.actorId ||
            owner?.userId != access.authority.canonicalUserId ||
            owner?.role != access.authority.role) {
          next.invalidate();
        }
      });
      ref.listen(biometricSessionLockControllerProvider, (_, value) {
        if (value.state.blocksInteraction) {
          next.invalidate();
        }
      });
      ref.listen(specialistRecoveryProvider, (_, value) {
        if (!identical(value, store)) {
          next.invalidate();
        }
      });
      unawaited(next.initialize());
      return next;
    });
