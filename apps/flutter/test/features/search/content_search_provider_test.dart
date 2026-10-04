import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/search/content_search_contracts.dart';
import 'package:asael/features/search/content_search_providers.dart';
import 'package:asael/features/search/content_search_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'search_test_support.dart';

AppSession _session({
  String tenant = 'tenant-one',
  String actor = 'owner@example.test',
  String user = searchThread,
  String role = 'admin',
}) => AppSession(
  tenantId: tenant,
  actorId: actor,
  userId: user,
  email: actor,
  displayName: 'Owner',
  workspaceName: 'Asael',
  role: role,
);

class _Sessions extends SessionController {
  @override
  Future<AppSession?> build() async => _session();
  void replace(AppSession value) => state = AsyncData(value);
}

class _NoSessionEffects extends Fake implements SessionRepository {}

class _Lock extends BiometricSessionLockController {
  _Lock() : super(_NoSessionEffects());
  bool locked = false;
  @override
  BiometricSessionLockState get state => BiometricSessionLockState(
    phase: locked
        ? BiometricSessionLockPhase.locked
        : BiometricSessionLockPhase.unlocked,
  );
  void protect() {
    locked = true;
    notifyListeners();
  }
}

void main() {
  for (final change in [
    'tenant',
    'actor',
    'canonical user',
    'role',
    'API',
    'lock',
    'repository',
  ]) {
    test(
      '$change replacement synchronously fences the old controller and held private read',
      () async {
        final previous = FlutterError.onError, errors = <FlutterErrorDetails>[];
        FlutterError.onError = errors.add;
        addTearDown(() {
          FlutterError.onError = previous;
          expect(errors, isEmpty);
        });
        var api = SearchTestApi();
        final first = api;
        final lock = _Lock();
        late _Sessions sessions;
        final held = Completer<SearchJson>();
        api.reader = (_) => held.future;
        final container = ProviderContainer(
          overrides: [
            apiClientProvider.overrideWith((ref) => api),
            sessionControllerProvider.overrideWith(
              () => sessions = _Sessions(),
            ),
            biometricSessionLockControllerProvider.overrideWith((ref) => lock),
          ],
        );
        addTearDown(container.dispose);
        await container.read(sessionControllerProvider.future);
        final provider = contentSearchControllerProvider('test-visibility');
        final subscription = container.listen(provider, (_, _) {});
        addTearDown(subscription.close);
        final controller = container.read(provider)!;
        final read = controller.submit('private topic');
        switch (change) {
          case 'tenant':
            sessions.replace(_session(tenant: 'another'));
            break;
          case 'actor':
            sessions.replace(_session(actor: 'other@example.test'));
            break;
          case 'canonical user':
            sessions.replace(
              _session(user: '22222222-2222-4222-8222-222222222222'),
            );
            break;
          case 'role':
            sessions.replace(_session(role: 'viewer'));
            break;
          case 'API':
            api = SearchTestApi();
            container.invalidate(apiClientProvider);
            break;
          case 'lock':
            lock.protect();
            break;
          case 'repository':
            container.invalidate(contentSearchRepositoryProvider);
            break;
        }
        expect(controller.available, isFalse);
        expect(first.tokens.single.isCancelled, isTrue);
        held.complete(searchResponseJson(query: 'private topic'));
        await read;
        expect(controller.query, isEmpty);
        expect(controller.groups, isEmpty);
        await controller.submit('new query');
        expect(first.paths, hasLength(1));
      },
    );
  }
  testWidgets(
    'mounted search clears the draft when its repository is replaced under the same owner',
    (tester) async {
      final api = SearchTestApi();
      api.reader = (_) async => searchResponseJson();
      final container = ProviderContainer(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          sessionControllerProvider.overrideWith(_Sessions.new),
          biometricSessionLockControllerProvider.overrideWith((ref) => _Lock()),
        ],
      );
      addTearDown(container.dispose);
      await container.read(sessionControllerProvider.future);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(body: NativeContentSearchPage()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('content-search-query')),
        'Prior private draft',
      );
      container.invalidate(contentSearchRepositoryProvider);
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('content-search-query')))
            .controller!
            .text,
        isEmpty,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
