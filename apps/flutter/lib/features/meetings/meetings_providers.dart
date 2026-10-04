import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/storage/secure_session_store.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../../generated/native_contract.g.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import '../auth/application/session_controller.dart';
import 'meetings.dart';
import 'meetings_access.dart';
import 'meetings_api_repository.dart';
import 'meetings_action_controller.dart';
import 'meetings_draft_store.dart';

final meetingDraftStoreProvider = Provider<MeetingDraftStore>(
  (ref) => EncryptedMeetingDraftStore(
    ref.watch(secureSessionStoreProvider).readOrCreateOfflineProjectionSecret,
  ),
);
final meetingActionControllerProvider = Provider.autoDispose
    .family<MeetingActionController?, String>((ref, route) {
      final repository = ref.watch(meetingsRepositoryProvider);
      if (repository is! MutatingMeetingsRepository) {
        return null;
      }
      final controller = MeetingActionController(
        repository,
        ref.watch(meetingDraftStoreProvider),
        route,
      );
      ref.onDispose(controller.dispose);
      controller.initialize();
      return controller;
    });

final meetingsRepositoryProvider = Provider.autoDispose<MeetingsRepository>((
  ref,
) {
  final api = ref.watch(apiClientProvider),
      apiScope = meetingsApiScope(ref.watch(apiClientProvider).apiBaseUrl);
  final access = MeetingsAccess(
    listAvailable: NativeContract.supportsOperation('meetings.list'),
    detailAvailable: NativeContract.supportsOperation('meetings.get'),
    commitmentsAvailable: NativeContract.supportsOperation(
      'meetings.commitments.list',
    ),
    operations: {
      for (final operation in const [
        'meetings.create',
        'meetings.update',
        'meetings.commitments.propose',
        'meetings.commitments.resolve',
      ])
        if (NativeContract.supportsOperation(operation)) operation,
    },
  );
  void update() {
    if (!ref.mounted) {
      return;
    }
    final session = ref.read(sessionControllerProvider),
        owner = MeetingsOwner.fromSession(
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

  final repository = ApiMeetingsRepository(
    api,
    access: access,
    authorityProbe: () {
      if (!ref.mounted ||
          !identical(ref.read(apiClientProvider), api) ||
          meetingsApiScope(api.apiBaseUrl) != apiScope) {
        return false;
      }
      // Invalidation closes access immediately, but Riverpod may keep the old
      // Ref mounted until its replacement rebuilds. Both must remain current.
      if (!ref.mounted || !access.readable) {
        return false;
      }
      final state = ref.read(sessionControllerProvider),
          owner = MeetingsOwner.fromSession(
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
  // Listen as well as watch: invalidation cancels old in-flight reads before
  // the next widget frame can replace its controller/repository dependency.
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
    // Invalidate/cancel without publishing into a disposing notifier tree.
    access.close(notify: false);
    repository.dispose();
    access.dispose();
  });
  return repository;
});

final meetingsControllerProvider =
    ChangeNotifierProvider.autoDispose<MeetingsController>((ref) {
      final controller = MeetingsController(
        ref.watch(meetingsRepositoryProvider),
        active: false,
      );
      final unregister = ref
          .read(reconnectCoordinatorProvider)
          .register(
            'meetings',
            controller.refresh,
            classification: ReconciliationClass.freshness,
            freshnessScope: '/meetings',
          );
      ref.onDispose(unregister);
      return controller;
    });
