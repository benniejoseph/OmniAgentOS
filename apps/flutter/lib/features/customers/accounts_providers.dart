import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/storage/secure_session_store.dart';
import '../../generated/native_contract.g.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import '../auth/application/session_controller.dart';
import 'accounts_contracts.dart';
import 'accounts_controller.dart';
import 'accounts_repository.dart';
import 'accounts_recovery_store.dart';

final accountsRecoveryStoreProvider = Provider<AccountsRecoveryStore>(
  (ref) => EncryptedAccountsRecoveryStore(
    ref.watch(secureSessionStoreProvider).readOrCreateOfflineProjectionSecret,
  ),
);

final accountsRepositoryProvider = Provider.autoDispose<AccountsRepository>((
  ref,
) {
  final api = ref.watch(apiClientProvider),
      apiScope = accountsApiScope(ref.watch(apiClientProvider).apiBaseUrl);
  final access = AccountsAccess(
    operations: {
      for (final id in [
        'customers.list',
        'customers.portfolio',
        'customers.get',
        'customers.create',
        'customers.update',
        'customers.health',
        'customers.health.evaluate',
        'customers.health.evaluations.get',
        'customers.intelligence',
        'customers.workflows',
        'customers.salesforce.status',
      ])
        if (NativeContract.supportsOperation(id)) id,
    },
  );
  bool current() {
    if (!ref.mounted ||
        !identical(ref.read(apiClientProvider), api) ||
        accountsApiScope(api.apiBaseUrl) != apiScope) {
      return false;
    }
    // Disposal closes access before Riverpod necessarily replaces this Ref.
    if (!ref.mounted || !access.readable) {
      return false;
    }
    final state = ref.read(sessionControllerProvider),
        owner = AccountsOwner.fromSession(
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
  }

  void update() {
    if (!ref.mounted) {
      return;
    }
    final state = ref.read(sessionControllerProvider),
        owner = AccountsOwner.fromSession(
          ref.read(sessionControllerProvider).value,
          apiScope,
        );
    access.update(
      owner,
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

  final repository = ApiAccountsRepository(
    api,
    access: access,
    authorityProbe: current,
  );
  ref.listen(apiClientProvider, (previous, next) {
    if (!identical(previous, next)) {
      access.close();
    }
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
final accountsControllerProvider = ChangeNotifierProvider.autoDispose
    .family<AccountsController, String?>((ref, accountId) {
      final controller = AccountsController(
        ref.watch(accountsRepositoryProvider),
        accountId: accountId,
        recovery: ref.watch(accountsRecoveryStoreProvider),
      );
      ref.onDispose(() => controller.invalidateAuthority(notify: false));
      return controller;
    });
