import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/storage/secure_session_store.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../auth/application/session_controller.dart';
import '../auth/application/biometric_session_lock_controller.dart';
import 'capture_api_repository.dart';
import 'capture_controller.dart';
import 'capture_outbox.dart';

final Provider<CaptureRepository>
captureRepositoryProvider = Provider<CaptureRepository>((ref) {
  final api = ref.watch(apiClientProvider);
  return ApiCaptureRepository(
    api,
    authorityCurrent: (owner) {
      if (!ref.mounted || !identical(ref.read(apiClientProvider), api)) {
        return false;
      }
      if (!ref.mounted) return false;
      final state = ref.read(sessionControllerProvider), session = state.value;
      if (state.isLoading || state.hasError || session == null) return false;
      final controller = ref.read(captureControllerProvider);
      return identical(controller.owner, owner) &&
          controller.canWrite &&
          session.tenantId == owner.tenantId &&
          session.actorId == owner.actorId &&
          session.userId == owner.canonicalUserId &&
          session.role == owner.role &&
          !ref
              .read(biometricSessionLockControllerProvider)
              .state
              .blocksInteraction;
    },
  );
});
final captureOutboxProvider = Provider<CaptureOutbox>(
  (ref) => EncryptedCaptureOutbox(
    ref.watch(secureSessionStoreProvider).readOrCreateCaptureOutboxSecret,
  ),
);
final ChangeNotifierProvider<CaptureController> captureControllerProvider =
    ChangeNotifierProvider<CaptureController>((ref) {
      final api = ref.watch(apiClientProvider);
      final sessionState = ref.watch(sessionControllerProvider);
      final locked = ref
          .watch(biometricSessionLockControllerProvider)
          .state
          .blocksInteraction;
      final session = sessionState.isLoading || sessionState.hasError || locked
          ? null
          : sessionState.value;
      final owner = session == null || session.userId.trim().isEmpty
          ? null
          : CaptureOwnerBinding(
              tenantId: session.tenantId,
              actorId: session.actorId,
              canonicalUserId: session.userId,
              apiOrigin: CaptureOwnerBinding.originForBaseUrl(api.apiBaseUrl),
              role: session.role,
            );
      final controller = CaptureController(
        ref.watch(captureRepositoryProvider),
        ref.watch(captureOutboxProvider),
        owner,
        resumeBatchProcessing: !kIsWeb,
        canWrite: const {'operator', 'admin', 'system'}.contains(session?.role),
        authorityCurrent: () {
          if (!ref.mounted) {
            return false;
          }
          if (!identical(ref.read(apiClientProvider), api) ||
              CaptureOwnerBinding.originForBaseUrl(api.apiBaseUrl) !=
                  owner?.apiOrigin) {
            return false;
          }
          if (!ref.mounted) {
            return false;
          }
          final state = ref.read(sessionControllerProvider);
          final current = state.value;
          return !state.isLoading &&
              !state.hasError &&
              current != null &&
              current.tenantId == owner?.tenantId &&
              current.actorId == owner?.actorId &&
              current.userId == owner?.canonicalUserId &&
              current.role == session?.role &&
              !ref
                  .read(biometricSessionLockControllerProvider)
                  .state
                  .blocksInteraction;
        },
      );
      // Listen at this boundary as well as watching: pending reads/intake must
      // lose authority at replacement, before a widget pumps the new provider.
      ref.listen(apiClientProvider, (previous, next) {
        if (!identical(previous, next)) {
          controller.invalidateAuthority();
        }
      });
      ref.listen(sessionControllerProvider, (previous, next) {
        final value = next.isLoading || next.hasError ? null : next.value;
        if (value?.tenantId != owner?.tenantId ||
            value?.actorId != owner?.actorId ||
            value?.userId != owner?.canonicalUserId ||
            value?.role != session?.role) {
          controller.invalidateAuthority();
        }
      });
      ref.listen(biometricSessionLockControllerProvider, (_, next) {
        if (next.state.blocksInteraction) {
          controller.invalidateAuthority();
        }
      });
      // Fence data and pending operations synchronously. Riverpod owns the
      // outgoing notifier's disposal and cannot publish it from this callback.
      ref.onDispose(() => controller.invalidateAuthority(notify: false));
      if (owner != null) {
        unawaited(controller.initialize());
      }
      final unregister = ref
          .read(reconnectCoordinatorProvider)
          .register(
            'capture-outbox',
            controller.initialize,
            priority: 0,
            classification: ReconciliationClass.durable,
            shouldRun: (_) =>
                controller.available &&
                !controller.loadingOutbox &&
                !controller.syncing &&
                !controller.submitting &&
                !controller.batchQueueing,
          );
      ref.onDispose(unregister);
      return controller;
    });

final captureOutboxLifecycleProvider = Provider<void>((ref) {
  final session = ref.watch(sessionControllerProvider).value;
  if (session != null) {
    ref.read(captureControllerProvider);
  }
});
