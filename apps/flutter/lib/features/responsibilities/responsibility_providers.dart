import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/storage/secure_session_store.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import '../auth/application/session_controller.dart';
import 'responsibility_contracts.dart';
import 'responsibility_controller.dart';
import 'responsibility_recovery_store.dart';
import 'responsibility_repository.dart';

final responsibilityRecoveryStoreProvider =
    Provider<ResponsibilityRecoveryStore>(
      (ref) => EncryptedResponsibilityRecoveryStore(
        ref
            .watch(secureSessionStoreProvider)
            .readOrCreateOfflineProjectionSecret,
      ),
    );
final responsibilityRepositoryProvider = Provider<ResponsibilityRepository>((
  ref,
) {
  final api = ref.watch(apiClientProvider),
      apiScope = NativeRequestAuthority.normalizeApiBaseUrl(
        ref.read(apiClientProvider).apiBaseUrl,
      );
  final access = ResponsibilityAccess();
  void update() {
    if (!ref.mounted) return;
    final session = ref.read(sessionControllerProvider),
        owner = ResponsibilityOwner.fromSession(
          ref.read(sessionControllerProvider).value,
          apiScope,
        );
    access.update(
      owner,
      available:
          !session.isLoading &&
          !session.hasError &&
          owner != null &&
          !ref
              .read(biometricSessionLockControllerProvider)
              .state
              .blocksInteraction,
    );
  }

  late ApiResponsibilityRepository repository;
  repository = ApiResponsibilityRepository(
    api,
    access: access,
    authorityProbe: () {
      if (!ref.mounted ||
          !identical(ref.read(apiClientProvider), api) ||
          NativeRequestAuthority.normalizeApiBaseUrl(api.apiBaseUrl) !=
              apiScope) {
        return false;
      }
      // Invalidation may close access before Riverpod replaces the old Ref.
      if (!ref.mounted || !access.readable) return false;
      final session = ref.read(sessionControllerProvider),
          owner = ResponsibilityOwner.fromSession(
            ref.read(sessionControllerProvider).value,
            apiScope,
          );
      return !session.isLoading &&
          !session.hasError &&
          owner != null &&
          owner.key == access.owner?.key &&
          !ref
              .read(biometricSessionLockControllerProvider)
              .state
              .blocksInteraction;
    },
  );
  ref.listen(apiClientProvider, (previous, next) {
    if (!identical(previous, next)) access.close();
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

/// Kept alive across list/detail navigation. Account, role, deployment and lock
/// changes immediately fence the old controller and replace visible state.
final responsibilityControllerProvider =
    ChangeNotifierProvider<ResponsibilityController>((ref) {
      final controller = ResponsibilityController(
        ref.watch(responsibilityRepositoryProvider),
        ref.watch(responsibilityRecoveryStoreProvider),
      );
      final unregister = ref
          .read(reconnectCoordinatorProvider)
          .register(
            'responsibilities',
            controller.refresh,
            classification: ReconciliationClass.freshness,
            freshnessScope: '/responsibilities',
          );
      ref.onDispose(() {
        controller.invalidateAuthority(notify: false);
        unregister();
      });
      return controller;
    });
