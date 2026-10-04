import 'dart:async';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/auth/application/biometric_session_lock_controller.dart';
import 'package:asael/features/auth/application/session_controller.dart';
import 'package:asael/features/auth/data/session_repository.dart';
import 'package:asael/features/auth/domain/app_session.dart';
import 'package:asael/features/customers/accounts_contracts.dart';
import 'package:asael/features/customers/accounts_controller.dart';
import 'package:asael/features/customers/accounts_providers.dart';
import 'package:asael/features/customers/accounts_recovery_store.dart';
import 'package:asael/features/customers/accounts_workspace.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'accounts_test_support.dart';

void main() {
  testWidgets(
    'mounted API replacement erases cached private data and cancels late outgoing reads',
    (tester) async {
      final harness = _MountedAccounts();
      addTearDown(harness.dispose);
      await harness.mount(tester);
      final old = harness.controller, outgoing = harness.api;
      expect(old.overview.value?.accounts.single.name, 'Acme customer');
      final held = Completer<AccountJson>(),
          started = Completer<void>(),
          replacement = Completer<AccountJson>();
      final originalResponse = await accountListResponse();
      outgoing.read = (path, _, _) {
        if (!started.isCompleted) {
          started.complete();
        }
        return held.future;
      };
      final refresh = old.refreshCore();
      await started.future;
      harness.api = AccountsTestApi(origin: 'https://replacement.example.test')
        ..read = (path, _, _) => path == NativePaths.customersList()
            ? replacement.future
            : accountPortfolioResponse();
      harness.container.invalidate(apiClientProvider);
      expect(old.readable, isFalse);
      expect(old.overview.value, isNull);
      expect(outgoing.tokens.last.isCancelled, isTrue);
      await tester.pump();
      await tester.pump();
      expect(harness.controller, isNot(same(old)));
      expect(find.text('Acme customer'), findsNothing);
      held.complete(originalResponse);
      await refresh;
      await tester.pump();
      expect(old.overview.value, isNull);
      expect(find.text('Acme customer'), findsNothing);
      replacement.complete(await _namedList('Replacement account'));
      await tester.pumpAndSettle();
      expect(
        harness.controller.overview.value?.accounts.single.name,
        'Replacement account',
      );
      expect(find.text('Acme customer'), findsNothing);
      expect(tester.takeException(), isNull);
      await harness.close(tester);
    },
  );

  testWidgets(
    'mounted same-API controller replacement resets local search and isolates old receipts',
    (tester) async {
      final harness = _MountedAccounts();
      addTearDown(harness.dispose);
      await harness.mount(tester);
      final old = harness.controller;
      await _showSearch(tester, old);
      await tester.enterText(
        find.byKey(const Key('customer-record-search')),
        'private old search',
      );
      await tester.pump();
      final oldScrollKey = accountsStorageKey(old, 'scroll');
      harness.container.invalidate(accountsControllerProvider(null));
      await tester.pumpAndSettle();
      final current = harness.controller;
      expect(current, isNot(same(old)));
      expect(old.readable, isFalse);
      expect(old.overview.value, isNull);
      await _showSearch(tester, current);
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('customer-record-search')))
            .controller!
            .text,
        isEmpty,
      );
      expect(accountsStorageKey(current, 'scroll'), isNot(oldScrollKey));
      expect(current.overview.value?.accounts.single.id, customerId);
      expect(tester.takeException(), isNull);
      await harness.close(tester);
    },
  );

  testWidgets(
    'mounted inactive handoff clears exact detail and begins no hidden read',
    (tester) async {
      final harness = _MountedAccounts();
      addTearDown(harness.dispose);
      await harness.mount(tester, id: customerId);
      final current = harness.container.read(
        accountsControllerProvider(customerId),
      );
      expect(current.detail.value?.id, customerId);
      final reads = harness.api.paths.length;
      await harness.show(tester, id: customerId, active: false);
      expect(current.detail.value, isNull);
      expect(current.intelligence.value, isNull);
      expect(harness.api.paths.length, reads);
      expect(find.text('Acme customer'), findsNothing);
      expect(
        find.textContaining('Customer records are hidden'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await harness.close(tester);
    },
  );
}

Future<void> _showSearch(WidgetTester tester, AccountsController controller) =>
    tester.scrollUntilVisible(
      find.byKey(const Key('customer-record-search')),
      240,
      scrollable: find
          .descendant(
            of: find.byKey(accountsStorageKey(controller, 'scroll')),
            matching: find.byType(Scrollable),
          )
          .first,
    );

Future<AccountJson> _namedList(String name) async => accountEnvelope(
  {
    'context': accountContext(),
    'accounts': [await accountRevision(name: name)],
  },
  'app.customer_accounts.list',
  1,
);

class _Sessions extends SessionController {
  @override
  Future<AppSession?> build() async => accountSession();
}

class _NoSessionEffects extends Fake implements SessionRepository {}

class _MountedAccounts {
  AccountsTestApi api = AccountsTestApi();
  bool _disposed = false;
  late final ProviderContainer container = ProviderContainer(
    overrides: [
      apiClientProvider.overrideWith((ref) => api),
      accountsRecoveryStoreProvider.overrideWith(
        (_) => MemoryAccountsRecoveryStore(),
      ),
      sessionControllerProvider.overrideWith(_Sessions.new),
      biometricSessionLockControllerProvider.overrideWith(
        (ref) => BiometricSessionLockController(_NoSessionEffects()),
      ),
    ],
  );
  AccountsController get controller =>
      container.read(accountsControllerProvider(null));
  Future<void> mount(WidgetTester tester, {String? id}) async {
    await container.read(sessionControllerProvider.future);
    await show(tester, id: id);
  }

  Future<void> show(
    WidgetTester tester, {
    String? id,
    bool active = true,
  }) async {
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          home: NativeAccountsView(accountId: id, active: active),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> close(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    dispose();
    await tester.pump();
    expect(tester.takeException(), isNull);
  }

  void dispose() {
    if (_disposed) {
      return;
    }
    _disposed = true;
    container.dispose();
  }
}
