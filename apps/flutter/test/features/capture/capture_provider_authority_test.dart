import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/capture/capture_models.dart';
import 'package:asael/features/capture/capture_providers.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test_support.dart';

void main() {
  setUp(() {
    final previous = FlutterError.onError;
    final errors = <FlutterErrorDetails>[];
    FlutterError.onError = errors.add;
    addTearDown(() {
      FlutterError.onError = previous;
      expect(
        errors,
        isEmpty,
        reason: 'Provider replacement must not report lifecycle errors.',
      );
    });
  });
  test('API replacement fences a held exact source read without a widget or container pump', () async {
    final harness = await _Harness.create();
    addTearDown(harness.container.dispose);
    final read = Completer<CaptureJobSnapshot>();
    harness.repository.jobReader = (_) => read.future;
    final old = harness.container.read(captureControllerProvider);
    await old.submit(captureTestDraft());
    expect(harness.repository.cancelTokens, hasLength(1));
    harness.replaceApi('https://replacement.test');
    read.complete(const CaptureJobSnapshot(id: 'job-one', status: 'completed'));
    await Future<void>.delayed(Duration.zero);
    expect(old.available, isFalse);
    expect(old.receipt, isNull);
    expect(old.selectedAsset, isNull);
    expect(harness.repository.cancelTokens.single.isCancelled, isTrue);
    await old.initialize();
    expect(old.available, isFalse);
    expect(
      harness.container.read(captureControllerProvider).owner!.apiOrigin,
      'https://replacement.test',
    );
  });
  test(
    'API replacement cannot enqueue a held intake before the next pump',
    () async {
      final harness = await _Harness.create();
      addTearDown(harness.container.dispose);
      final old = harness.container.read(captureControllerProvider);
      final held = Completer<CaptureDraft>();
      final intake = old.submitBatch(['source.pdf'], (_) => held.future);
      harness.replaceApi('https://replacement.test');
      final draft = captureTestDraft();
      held.complete(draft);
      await intake;
      expect(harness.outbox.entries, isEmpty);
      expect(harness.repository.submissions, isEmpty);
      expect(draft.file!.bytes, everyElement(0));
      expect(old.available, isFalse);
    },
  );
  test('role downgrade invalidates held intake immediately and restores read-only local recovery', () async {
    final harness = await _Harness.create();
    addTearDown(harness.container.dispose);
    final old = harness.container.read(captureControllerProvider);
    final entry = await harness.outbox.enqueue(
      old.owner!,
      const CaptureDraft(content: 'Recoverable local note'),
    );
    final held = Completer<CaptureDraft>();
    final intake = old.submitBatch(['source.pdf'], (_) => held.future);
    harness.sessions.replace(_session(role: 'viewer'));
    held.complete(captureTestDraft());
    await intake;
    expect(old.available, isFalse);
    final viewer = harness.container.read(captureControllerProvider);
    await Future<void>.delayed(Duration.zero);
    expect(viewer.available, isTrue);
    expect(viewer.canWrite, isFalse);
    expect(viewer.pending.single.id, entry.id);
    await viewer.syncPending();
    expect(harness.repository.submissions, isEmpty);
    await viewer.discard(entry.id);
    expect(harness.outbox.entries, isEmpty);
  });
  test('same-email recreated account and a different API origin never restore predecessor captures', () async {
    for (final changeOrigin in [false, true]) {
      final harness = await _Harness.create();
      final old = harness.container.read(captureControllerProvider);
      final retained = await harness.outbox.enqueue(
        old.owner!,
        const CaptureDraft(content: 'Predecessor private note'),
      );
      if (changeOrigin) {
        harness.replaceApi('https://replacement.test');
      } else {
        harness.sessions.replace(_session(user: 'new-canonical-user'));
      }
      final next = harness.container.read(captureControllerProvider);
      await Future<void>.delayed(Duration.zero);
      expect(next.pending, isEmpty);
      expect(harness.repository.submissions, isEmpty);
      expect(harness.outbox.entries.single.id, retained.id);
      harness.container.dispose();
    }
  });
}

AppSession _session({
  String user = 'canonical-user',
  String role = 'operator',
}) => AppSession(
  tenantId: 'tenant',
  actorId: 'actor',
  userId: user,
  email: 'same@example.test',
  displayName: 'Synthetic',
  workspaceName: 'Synthetic',
  role: role,
);

class _Sessions extends SessionController {
  @override
  Future<AppSession?> build() async => _session();
  void replace(AppSession session) {
    state = AsyncData(session);
  }
}

class _NoSessionEffects extends Fake implements SessionRepository {}

class _Harness {
  _Harness();
  late ProviderContainer container;
  late _Sessions sessions;
  final repository = CaptureTestRepository(), outbox = CaptureTestOutbox();
  ApiClient api = _api('https://capture.test');
  static ApiClient _api(String origin) => ApiClient(
    Dio(BaseOptions(baseUrl: origin)),
    Dio(),
    SecureSessionStore(const FlutterSecureStorage()),
  );
  static Future<_Harness> create() async {
    final value = _Harness();
    value.container = ProviderContainer(
      overrides: [
        sessionControllerProvider.overrideWith(
          () => value.sessions = _Sessions(),
        ),
        apiClientProvider.overrideWith((ref) => value.api),
        captureRepositoryProvider.overrideWithValue(value.repository),
        captureOutboxProvider.overrideWithValue(value.outbox),
        biometricSessionLockControllerProvider.overrideWith(
          (ref) => BiometricSessionLockController(_NoSessionEffects()),
        ),
        reconnectCoordinatorProvider.overrideWithValue(
          ReconnectCoordinator(() async => const [], const Stream.empty()),
        ),
      ],
    );
    await value.container.read(sessionControllerProvider.future);
    value.container.read(captureControllerProvider);
    await Future<void>.delayed(Duration.zero);
    return value;
  }

  void replaceApi(String origin) {
    api = _api(origin);
    container.invalidate(apiClientProvider);
  }
}
