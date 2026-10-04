import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_client.dart';
import '../../core/network/native_workspace_access.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import '../auth/application/session_controller.dart';
import 'portable_archive_controller.dart';
import 'portable_archive_repository.dart';

final portableArchiveRepositoryProvider =
    Provider.autoDispose<ApiPortableArchiveRepository?>((ref) {
      final access = ref.watch(nativeWorkspaceAccessProvider);
      if (access == null || !access.current || !ref.mounted) return null;
      final repository = ApiPortableArchiveRepository(access);
      ref.listen(apiClientProvider, (_, next) {
        if (!identical(next, access.api)) repository.dispose();
      });
      ref.listen(sessionControllerProvider, (_, next) {
        final owner = next.value;
        if (next.isLoading ||
            next.hasError ||
            owner?.tenantId != access.authority.tenantId ||
            owner?.actorId != access.authority.actorId ||
            owner?.userId != access.authority.canonicalUserId ||
            owner?.role != access.authority.role) {
          repository.dispose();
        }
      });
      ref.listen(biometricSessionLockControllerProvider, (_, next) {
        if (next.state.blocksInteraction) repository.dispose();
      });
      ref.onDispose(repository.dispose);
      return repository;
    });
final portableArchiveControllerProvider = Provider.autoDispose
    .family<PortableArchiveController?, Object>((ref, visibility) {
      final repository = ref.watch(portableArchiveRepositoryProvider);
      if (repository == null || !repository.current || !ref.mounted) {
        return null;
      }
      final controller = PortableArchiveController(repository);
      ref.onDispose(controller.dispose);
      return controller;
    });
