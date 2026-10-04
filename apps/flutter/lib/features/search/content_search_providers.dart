import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_client.dart';
import '../../core/network/native_workspace_access.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import '../auth/application/session_controller.dart';
import '../capture/library_controller.dart';
import '../capture/library_repository.dart';
import 'content_search_controller.dart';
import 'content_search_repository.dart';

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

final contentSearchRepositoryProvider =
    Provider.autoDispose<ApiContentSearchRepository?>((ref) {
      final access = ref.watch(nativeWorkspaceAccessProvider);
      if (access == null || !access.current || !ref.mounted) return null;
      final repository = ApiContentSearchRepository(access);
      _watchAuthority(ref, access, repository.dispose);
      ref.onDispose(repository.dispose);
      return repository;
    });

final contentSearchControllerProvider = Provider.autoDispose
    .family<ContentSearchController?, Object>((ref, visibility) {
      final repository = ref.watch(contentSearchRepositoryProvider);
      if (repository == null || !repository.current || !ref.mounted) {
        return null;
      }
      final controller = ContentSearchController(repository);
      // Repository teardown can precede dependent-provider rebuilding. Drop
      // the old private projection synchronously without notifying that tree.
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

final contentSearchLibraryControllerProvider = Provider.autoDispose
    .family<LibraryController?, Object>((ref, visibility) {
      final access = ref.watch(nativeWorkspaceAccessProvider);
      if (access == null || !access.current || !ref.mounted) return null;
      final controller = LibraryController(ApiLibraryRepository(access));
      _watchAuthority(ref, access, controller.invalidate);
      ref.onDispose(controller.dispose);
      return controller;
    });
