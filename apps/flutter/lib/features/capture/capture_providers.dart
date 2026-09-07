import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/storage/secure_session_store.dart';
import '../auth/application/session_controller.dart';
import 'capture.dart';
import 'capture_api_repository.dart';
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
  );
  if (owner != null) unawaited(controller.initialize());
  final subscription = Connectivity().onConnectivityChanged.listen((states) {
    if (owner != null &&
        states.any((state) => state != ConnectivityResult.none)) {
      unawaited(controller.syncPending());
    }
  });
  ref.onDispose(subscription.cancel);
  return controller;
});

final captureOutboxLifecycleProvider = Provider<void>((ref) {
  final session = ref.watch(sessionControllerProvider).value;
  if (session != null) ref.read(captureControllerProvider);
});
