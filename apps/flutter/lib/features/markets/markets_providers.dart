import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/storage/secure_session_store.dart';
import '../../generated/native_contract.g.dart';
import '../auth/application/session_controller.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import 'markets_contracts.dart';
import 'markets_controller.dart';
import 'markets_repository.dart';
import 'markets_recovery_store.dart';

final marketsRecoveryStoreProvider = Provider<MarketsRecoveryStore>(
  (ref) => EncryptedMarketsRecoveryStore(
    ref.watch(secureSessionStoreProvider).readOrCreateOfflineProjectionSecret,
  ),
);
final marketsRepositoryProvider = Provider.autoDispose<MarketsRepository>((
  ref,
) {
  final api = ref.watch(apiClientProvider),
      scope = NativeRequestAuthority.normalizeApiBaseUrl(api.apiBaseUrl);
  final access = MarketsAccess(
    operations: {
      for (final operation in [
        ...marketReadSpecs.values.map((spec) => spec.operation),
        ...marketWriteSpecs.values.map((spec) => spec.$1),
        'market.jobs.get',
      ])
        if (NativeContract.supportsOperation(operation)) operation,
    },
  );
  bool current() {
    if (!ref.mounted ||
        !identical(ref.read(apiClientProvider), api) ||
        NativeRequestAuthority.normalizeApiBaseUrl(api.apiBaseUrl) != scope) {
      return false;
    }
    // Invalidation can close access while the outgoing Ref remains mounted.
    if (!ref.mounted || !access.readable) return false;
    final state = ref.read(sessionControllerProvider),
        owner = MarketsOwner.fromSession(state.value, scope);
    return !state.isLoading &&
        !state.hasError &&
        owner != null &&
        owner.key == access.owner?.key &&
        !ref
            .read(biometricSessionLockControllerProvider)
            .state
            .blocksInteraction;
  }

  void update() {
    if (!ref.mounted) return;
    final state = ref.read(sessionControllerProvider),
        owner = MarketsOwner.fromSession(state.value, scope);
    access.update(
      owner ?? (state.isLoading || state.hasError ? access.owner : null),
      available:
          !state.isLoading &&
          !state.hasError &&
          owner != null &&
          !ref
              .read(biometricSessionLockControllerProvider)
              .state
              .blocksInteraction,
    );
  }

  final repository = ApiMarketsRepository(
    api,
    access: access,
    authorityProbe: current,
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
final marketsControllerProvider =
    ChangeNotifierProvider.autoDispose<MarketsController>((ref) {
      final controller = MarketsController(
        ref.watch(marketsRepositoryProvider),
        ref.watch(marketsRecoveryStoreProvider),
      );
      ref.onDispose(() => controller.invalidateAuthority(notify: false));
      return controller;
    });
