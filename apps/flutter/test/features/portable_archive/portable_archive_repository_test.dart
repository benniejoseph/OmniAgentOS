import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/results/created_file_export.dart';
import 'package:asael/features/settings/portable_archive_contracts.dart';
import 'package:asael/features/settings/portable_archive_controller.dart';
import 'package:asael/features/settings/portable_archive_providers.dart';
import 'package:asael/features/settings/portable_archive_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'portable_archive_test_support.dart';

void main() {
  for (final role in ['viewer', 'operator', 'admin', 'system']) {
    test(
      '$role can explicitly download using the single bounded authorized GET',
      () async {
        final api = PortableArchiveTestApi();
        final access = portableArchiveAccess(api, role: role),
            repo = ApiPortableArchiveRepository(
              portableArchiveAccess(api, role: role),
            );
        addTearDown(repo.dispose);
        expect(api.paths, isEmpty);
        final response = await repo.download(CancelToken());
        expect(api.paths, ['/api/data/export']);
        expect(response.bytes, portableArchiveTestBytes);
        expect(api.limits, [portableArchiveMaxBytes]);
        expect(api.timeouts, [const Duration(seconds: 150)]);
        final authority = api.authorities.single;
        expect(
          (
            authority.tenantId,
            authority.actorId,
            authority.canonicalUserId,
            authority.role,
            authority.apiBaseUrl,
          ),
          (
            portableArchiveTenant,
            portableArchiveActor,
            portableArchiveUser,
            role,
            access.authority.apiBaseUrl,
          ),
        );
      },
    );
  }
  test(
    'repository disposal inside authority admission dispatches no export',
    () async {
      final api = PortableArchiveTestApi();
      late ApiPortableArchiveRepository repo;
      repo = ApiPortableArchiveRepository(
        portableArchiveAccess(
          api,
          current: () {
            repo.dispose();
            return true;
          },
        ),
      );
      await expectLater(
        repo.download(CancelToken()),
        throwsA(isA<CreatedFileExportScopeChanged>()),
      );
      expect(api.paths, isEmpty);
    },
  );
  test('same-object base change clears a saved receipt and permanently invalidates the repository', () async {
    final api = PortableArchiveTestApi(),
        adapter = PortableArchiveTestAdapter()
          ..automaticDestination = '/chosen/archive.json',
        verifier = PortableArchiveTestVerifier()
          ..immediateReceipt = portableArchiveReceipt();
    final repo = ApiPortableArchiveRepository(portableArchiveAccess(api));
    final c = PortableArchiveController(
      repo,
      exporter: ScopedCreatedFileExporter(adapter: adapter),
      verifier: verifier,
    );
    addTearDown(() {
      c.dispose();
      repo.dispose();
    });
    await c.verifyAndSave();
    expect(c.receipt, isNotNull);
    var notifications = 0;
    c.addListener(() => notifications++);
    api.origin = 'https://replacement.example.test';
    expect(repo.current, isFalse);
    expect(c.receipt, isNull);
    expect(notifications, 0);
    await portableArchiveFlush();
    expect(notifications, greaterThan(0));
    api.origin = 'https://archive.example.test';
    expect(repo.current, isFalse);
    await expectLater(
      repo.download(CancelToken()),
      throwsA(isA<CreatedFileExportScopeChanged>()),
    );
    expect(api.paths, hasLength(1));
  });
  for (final change in [
    'tenant',
    'actor',
    'canonical user',
    'role',
    'API',
    'API base',
    'lock',
    'same-owner repository',
  ]) {
    test(
      '$change through actual providers cancels an admitted archive read and fences save',
      () async {
        final prior = FlutterError.onError, errors = <FlutterErrorDetails>[];
        FlutterError.onError = errors.add;
        addTearDown(() {
          FlutterError.onError = prior;
          expect(errors, isEmpty);
        });
        var api = PortableArchiveTestApi();
        final original = api, lock = PortableArchiveTestLock();
        late PortableArchiveTestSessions sessions;
        final container = ProviderContainer(
          overrides: [
            apiClientProvider.overrideWith((ref) => api),
            sessionControllerProvider.overrideWith(
              () => sessions = PortableArchiveTestSessions(),
            ),
            biometricSessionLockControllerProvider.overrideWith((ref) => lock),
          ],
        );
        addTearDown(container.dispose);
        await container.read(sessionControllerProvider.future);
        final subscription = container.listen(
          portableArchiveRepositoryProvider,
          (_, _) {},
        );
        addTearDown(subscription.close);
        final repo = container.read(portableArchiveRepositoryProvider)!;
        final adapter = PortableArchiveTestAdapter()
              ..automaticDestination = '/chosen/archive.json',
            verifier = PortableArchiveTestVerifier();
        final c = PortableArchiveController(
          repo,
          exporter: ScopedCreatedFileExporter(adapter: adapter),
          verifier: verifier,
        );
        addTearDown(c.dispose);
        final held = Completer<AuthorizedByteResponse>();
        api.reader = () => held.future;
        final pending = c.verifyAndSave();
        await portableArchiveFlush();
        expect(original.paths, hasLength(1));
        switch (change) {
          case 'tenant':
            sessions.replace(portableArchiveSession(tenant: 'other'));
          case 'actor':
            sessions.replace(
              portableArchiveSession(actor: 'other@example.test'),
            );
          case 'canonical user':
            sessions.replace(
              portableArchiveSession(
                user: '22222222-2222-4222-8222-222222222222',
              ),
            );
          case 'role':
            sessions.replace(portableArchiveSession(role: 'admin'));
          case 'API':
            api = PortableArchiveTestApi();
            container.invalidate(apiClientProvider);
          case 'API base':
            api.origin = 'https://replacement.example.test';
          case 'lock':
            lock.protect();
          case 'same-owner repository':
            container.invalidate(portableArchiveRepositoryProvider);
        }
        expect(c.available, isFalse);
        expect(c.receipt, isNull);
        expect(c.busy, isFalse);
        expect(original.tokens.single.isCancelled, isTrue);
        held.complete(portableArchiveResponse());
        await pending;
        expect(adapter.writes, isEmpty);
        expect(verifier.calls, isEmpty);
        original.origin = 'https://archive.example.test';
        await c.verifyAndSave();
        expect(original.paths, hasLength(1));
        expect(repo.current, isFalse);
      },
    );
  }
  test('controller family construction remains idle without an explicit export action', () async {
    final api = PortableArchiveTestApi();
    final container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        sessionControllerProvider.overrideWith(PortableArchiveTestSessions.new),
        biometricSessionLockControllerProvider.overrideWith(
          (ref) => PortableArchiveTestLock(),
        ),
      ],
    );
    addTearDown(container.dispose);
    await container.read(sessionControllerProvider.future);
    final first = portableArchiveControllerProvider(Object()),
        subscription = container.listen(
          portableArchiveControllerProvider('idle'),
          (_, _) {},
        );
    addTearDown(subscription.close);
    expect(
      container.read(portableArchiveControllerProvider('idle'))!.phase,
      PortableArchivePhase.idle,
    );
    expect(container.read(first)!.available, isTrue);
    expect(api.paths, isEmpty);
  });
}
