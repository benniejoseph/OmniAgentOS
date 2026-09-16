import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/storage/secure_session_store.dart';
import '../../core/sync/reconnect_coordinator.dart';
import '../auth/application/session_controller.dart';
import 'capture_api_repository.dart';
import 'capture_controller.dart';
import 'capture_outbox.dart';

final captureRepositoryProvider = Provider<CaptureRepository>(
  (ref) => ApiCaptureRepository(ref.watch(apiClientProvider)),
);
final captureOutboxProvider = Provider<CaptureOutbox>(
  (ref) => EncryptedCaptureOutbox(
    ref.watch(secureSessionStoreProvider).readOrCreateCaptureOutboxSecret,
  ),
);
final captureControllerProvider = ChangeNotifierProvider<CaptureController>((
  ref,
) {
  final session = ref.watch(sessionControllerProvider).value;
  final owner = session == null
      ? null
      : CaptureOwnerBinding(
          tenantId: session.tenantId,
          actorId: session.actorId,
        );
  final controller = CaptureController(
    ref.watch(captureRepositoryProvider),
    ref.watch(captureOutboxProvider),
    owner,
    resumeBatchProcessing:
        !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS,
  );
  if (owner != null) unawaited(controller.initialize());
  final unregister = ref
      .read(reconnectCoordinatorProvider)
      .register('capture-outbox', controller.syncPending, priority: 0);
  ref.onDispose(unregister);
  return controller;
});

final captureOutboxLifecycleProvider = Provider<void>((ref) {
  final session = ref.watch(sessionControllerProvider).value;
  if (session != null) ref.read(captureControllerProvider);
});
