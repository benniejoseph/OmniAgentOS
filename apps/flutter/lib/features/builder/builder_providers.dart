import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/storage/secure_session_store.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../../generated/native_contract.g.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import '../auth/application/session_controller.dart';
import 'builder_contracts.dart';
import 'builder_controller.dart';
import 'builder_recovery_store.dart';
import 'builder_repository.dart';

final builderRecoveryStoreProvider = Provider<BuilderRecoveryStore>(
  (ref) => EncryptedBuilderRecoveryStore(
    ref.watch(secureSessionStoreProvider).readOrCreateOfflineProjectionSecret,
  ),
);
final builderRepositoryProvider = Provider.autoDispose
    .family<BuilderRepository, String>((ref, project) {
      final api = ref.watch(apiClientProvider);
      final apiScope = builderApiScope(api.apiBaseUrl);
      final access = BuilderAccess(
        readOperation: NativeContract.supportsOperation(
          'workspaces.builder.get',
        ),
        writeOperation: NativeContract.supportsOperation(
          'workspaces.builder.update',
        ),
      );
      late ApiBuilderRepository repository;
      void updateSession() {
        if (!ref.mounted) {
          return;
        }
        final state = ref.read(sessionControllerProvider);
        final locked = ref
            .read(biometricSessionLockControllerProvider)
            .state
            .blocksInteraction;
        final owner = BuilderOwner.fromSession(state.value, apiScope);
        access.update(
          owner,
          available:
              !state.isLoading && !state.hasError && !locked && owner != null,
          clear: !state.isLoading && !state.hasError && state.value == null,
        );
      }

      repository = ApiBuilderRepository(
        api,
        access: access,
        authorityProbe: () {
          if (!ref.mounted ||
              !identical(ref.read(apiClientProvider), api) ||
              builderApiScope(api.apiBaseUrl) != apiScope) {
            return false;
          }
          // Invalidation may close access while the outgoing Ref is mounted.
          if (!ref.mounted || !access.readable) {
            return false;
          }
          final state = ref.read(sessionControllerProvider),
              owner = BuilderOwner.fromSession(
                ref.read(sessionControllerProvider).value,
                apiScope,
              );
          return !state.isLoading &&
              !state.hasError &&
              owner != null &&
              owner.key == access.owner?.key &&
              !ref
                  .read(biometricSessionLockControllerProvider)
                  .state
                  .blocksInteraction;
        },
      );
      ref.listen(apiClientProvider, (previous, next) {
        if (!identical(previous, next)) {
          access.close();
        }
      });
      ref.listen(
        sessionControllerProvider,
        (_, _) => updateSession(),
        fireImmediately: true,
      );
      ref.listen(
        biometricSessionLockControllerProvider,
        (_, _) => updateSession(),
      );
      ref.onDispose(() {
        // Riverpod is already invalidating the outgoing notifier tree.
        // Cancel and revoke synchronously without publishing through that tree.
        access.close(notify: false);
        repository.dispose();
        access.dispose();
      });
      return repository;
    });
final builderControllerProvider = ChangeNotifierProvider.autoDispose
    .family<BuilderController, String>((ref, project) {
      final controller = BuilderController(
        ref.watch(builderRepositoryProvider(project)),
        ref.watch(builderRecoveryStoreProvider),
        project,
        active: false,
      );
      final unregister = ref
          .read(reconnectCoordinatorProvider)
          .register(
            'builder:$project',
            controller.initialize,
            classification: ReconciliationClass.freshness,
            freshnessScope: '/projects',
          );
      ref.onDispose(() {
        controller.invalidateAuthority(notify: false);
        unregister();
      });
      return controller;
    });
