import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

const nativeWorkspaceFixtureOrigin = 'https://workspace.example.test';

/// Keeps the production access provider active while isolating layout fixtures
/// from credential storage, bootstrap I/O, and local biometric plugins.
Widget nativeWorkspaceFixture({Key? key, ApiClient? api, required Widget child}) {
  final client = api ??
      ApiClient(
        Dio(BaseOptions(baseUrl: nativeWorkspaceFixtureOrigin)),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  return ProviderScope(
    key: key,
    overrides: [
      apiClientProvider.overrideWithValue(client),
      sessionControllerProvider.overrideWith(_FixtureSession.new),
      biometricSessionLockControllerProvider.overrideWith(
        (_) => BiometricSessionLockController(_NoSessionEffects()),
      ),
    ],
    child: child,
  );
}

class _FixtureSession extends SessionController {
  @override
  Future<AppSession?> build() async => const AppSession(
    tenantId: 'tenant-test',
    actorId: 'owner@example.com',
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'owner@example.com',
    displayName: 'Owner',
    workspaceName: 'Asael',
    role: 'admin',
  );
}

class _NoSessionEffects extends Fake implements SessionRepository {}
