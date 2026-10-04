import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_client.dart';
import '../../core/network/native_workspace_access.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import '../auth/application/session_controller.dart';
import 'monitoring_controller.dart';
import 'monitoring_repository.dart';

void _watchAuthority(
  Ref ref,
  NativeWorkspaceAccess access,
  void Function() invalidate,
) {
  ref.listen(apiClientProvider, (_, next) {
    if (!identical(next, access.api)) invalidate();
  });
  ref.listen(sessionControllerProvider, (_, next) {
    final owner = next.value;
    if (next.isLoading ||
        next.hasError ||
        owner?.tenantId != access.authority.tenantId ||
        owner?.actorId != access.authority.actorId ||
        owner?.userId != access.authority.canonicalUserId ||
        owner?.role != access.authority.role) {
      invalidate();
    }
  });
  ref.listen(biometricSessionLockControllerProvider, (_, next) {
    if (next.state.blocksInteraction) invalidate();
  });
}

final monitoringRepositoryProvider =
    Provider.autoDispose<ApiMonitoringRepository?>((ref) {
      final access = ref.watch(nativeWorkspaceAccessProvider);
      if (access == null ||
          !access.canManage ||
          !access.current ||
          !ref.mounted) {
        return null;
      }
      final repository = ApiMonitoringRepository(access);
      _watchAuthority(ref, access, repository.dispose);
      ref.onDispose(repository.dispose);
      return repository;
    });
final monitoringControllerProvider = Provider.autoDispose
    .family<MonitoringController?, Object>((ref, visibility) {
      final repository = ref.watch(monitoringRepositoryProvider);
      if (repository == null || !repository.current || !ref.mounted) {
        return null;
      }
      final controller = MonitoringController(repository);
      final detach = repository.observeInvalidation(
        () => controller.invalidate(notify: false),
      );
      _watchAuthority(ref, repository.access, controller.invalidate);
      ref.onDispose(() {
        detach();
        controller.dispose();
      });
      return controller;
    });
