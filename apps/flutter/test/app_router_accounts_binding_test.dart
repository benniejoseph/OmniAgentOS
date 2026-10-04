import 'package:asael/app/router/app_router.dart';
import 'package:asael/app/theme/app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/sync/reconnect_coordinator.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/customers/accounts_providers.dart';
import 'package:asael/features/customers/accounts_workspace.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'features/customers/accounts_test_support.dart';

void main() {
  for (final prefix in ['/accounts', '/customers']) {
    testWidgets('exact $prefix bookmark opens the current customer provider', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1200, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final api = AccountsTestApi();
      final reconnect = ReconnectCoordinator(
        () async => const [],
        const Stream.empty(),
      );
      addTearDown(reconnect.dispose);
      final route = '$prefix/${Uri.encodeComponent(customerId)}';
      expect(isSafeInitialAppLocation(route), isTrue);
      final container = ProviderContainer(
        overrides: [
          sessionControllerProvider.overrideWith(_Sessions.new),
          appInitialLocationProvider.overrideWithValue(route),
          apiClientProvider.overrideWithValue(api),
          biometricSessionLockControllerProvider.overrideWith(
            (ref) => BiometricSessionLockController(_NoSessionEffects()),
          ),
          reconnectCoordinatorProvider.overrideWithValue(reconnect),
        ],
      );
      addTearDown(container.dispose);
      await container.read(sessionControllerProvider.future);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );
      await tester.pumpAndSettle();
      final view = tester.widget<NativeAccountsView>(
        find.byType(NativeAccountsView),
      );
      expect(view.accountId, customerId);
      expect(view.expectedApi, isNull);
      // Exercise the actual provider's current session/API probe and fresh
      // bootstrap path, rather than substituting preauthorized repository data.
      expect(
        api.paths,
        containsAllInOrder([
          NativePaths.bootstrapGet,
          NativePaths.customersGet(customerId),
          NativePaths.bootstrapGet,
          NativePaths.customersPortfolio,
        ]),
      );
      expect(
        api.paths.where((path) => path == NativePaths.customersGet(customerId)),
        hasLength(1),
      );
      expect(api.paths, isNot(contains(NativePaths.customersList)));
      expect(
        container.read(accountsRepositoryProvider).authorityCurrent(),
        isTrue,
      );
      expect(
        container
            .read(appRouterProvider)
            .routeInformationProvider
            .value
            .uri
            .pathSegments
            .last,
        customerId,
      );
      expect(
        container
            .read(accountsControllerProvider(customerId))
            .detail
            .value
            ?.account
            .id,
        customerId,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      expect(tester.takeException(), isNull);
    }, variant: TargetPlatformVariant.only(TargetPlatform.android));
  }

  testWidgets(
    'a malformed customer identity cannot initialize a private provider',
    (tester) async {
      final container = ProviderContainer(
        overrides: [
          accountsRepositoryProvider.overrideWith(
            (ref) => throw StateError('No private read allowed'),
          ),
        ],
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: ProviderBoundAccountsRoute(id: 'customer-account%3Abad'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.text('This customer account link is invalid.'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );
}

class _RouterHarness extends ConsumerWidget {
  const _RouterHarness();
  @override
  Widget build(BuildContext context, WidgetRef ref) => MaterialApp.router(
    theme: AppTheme.light(),
    routerConfig: ref.watch(appRouterProvider),
  );
}

class _Sessions extends SessionController {
  @override
  Future<AppSession?> build() async => accountSession();
}

class _NoSessionEffects extends Fake implements SessionRepository {}
