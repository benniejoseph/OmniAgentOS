import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_client.dart';
import '../../core/network/native_workspace_access.dart';
import '../auth/application/session_controller.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import 'library_controller.dart';
import 'library_repository.dart';

final libraryControllerProvider = Provider.autoDispose<LibraryController?>((
  ref,
) {
  final access = ref.watch(nativeWorkspaceAccessProvider);
  if (access == null || !access.current) return null;
  final controller = LibraryController(ApiLibraryRepository(access));
  ref.listen(apiClientProvider, (_, next) {
    if (!identical(next, access.api)) controller.invalidate();
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
    if (next.state.blocksInteraction) controller.invalidate();
  });
  ref.onDispose(controller.dispose);
  return controller;
});
