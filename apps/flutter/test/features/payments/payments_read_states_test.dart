import 'dart:async';

import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/payments/macos_payments_view.dart';
import 'package:asael/features/payments/payments_view.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../native_workspace_fixture.dart';

const _paths = [
  NativePaths.paymentsReadiness,
  NativePaths.paymentsReviews,
  NativePaths.paymentsAuthenticators,
  NativePaths.paymentsTransactions,
];

class _Api extends ApiClient {
  _Api()
    : super(
        Dio(BaseOptions(baseUrl: nativeWorkspaceFixtureOrigin)),
        Dio(),
        SecureSessionStore(const FlutterSecureStorage()),
      );
  final failures = <String>{};
  final gates = <String, Completer<Map<String, dynamic>>>{};
  final values = <String, Map<String, dynamic>>{
    NativePaths.paymentsReadiness: {
      'readiness': {
        'capability': {
          'state': 'disabled_configuration_only',
          'transactionsPermitted': false,
        },
      },
    },
    NativePaths.paymentsReviews: {
      'trustPolicy': {'policyId': 'reviewed'},
      'reviews': <Object>[],
    },
    NativePaths.paymentsAuthenticators: {'credentials': <Object>[]},
    NativePaths.paymentsTransactions: {'transactions': <Object>[]},
  };
  int reads = 0, posts = 0;
  @override
  Future<Map<String, dynamic>> getJsonFresh(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    reads++;
    if (failures.contains(path)) throw StateError('Source unavailable');
    return gates[path]?.future ?? values[path]!;
  }

  @override
  Future<Map<String, dynamic>> postJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    posts++;
    throw StateError('Payment UI must remain read-only');
  }
}

Future<void> _show(WidgetTester tester, _Api api, bool mac) async {
  tester.view.physicalSize = mac
      ? const Size(1440, 1000)
      : const Size(390, 1000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    nativeWorkspaceFixture(
      api: api,
      child: MaterialApp(
        theme: MacosAppTheme.light(),
        home: Scaffold(
          body: mac ? MacosPaymentsView(api: api) : PaymentsView(api: api),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _refresh(WidgetTester tester, bool mac) async {
  if (mac) {
    await tester.tap(find.byKey(const Key('macos-payments-refresh')));
  } else {
    final refresh = tester
        .state<RefreshIndicatorState>(find.byType(RefreshIndicator))
        .show();
    await tester.pumpAndSettle();
    await refresh;
  }
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  for (final mac in [false, true]) {
    final surface = mac ? 'macOS' : 'compact';
    testWidgets(
      '$surface failed initial sources are unavailable, and retry alone establishes empty counts',
      (tester) async {
        final api = _Api()..failures.addAll(_paths);
        await _show(tester, api, mac);
        expect(
          find.textContaining('Payment readiness could not be loaded'),
          findsOneWidget,
        );
        expect(
          find.text(
            mac
                ? 'No mandates awaiting review'
                : 'No purchase mandate is awaiting your review.',
          ),
          findsNothing,
        );
        if (mac) {
          expect(find.text('Mandates  —'), findsOneWidget);
          await tester.tap(find.text('Signers  —'));
          await tester.pump();
          expect(find.text('Signers unavailable'), findsOneWidget);
          expect(find.text('No hardware signers registered'), findsNothing);
          await tester.tap(find.text('Evidence  —'));
          await tester.pump();
          expect(find.text('Evidence unavailable'), findsOneWidget);
          expect(find.text('No reconciled payment evidence'), findsNothing);
        } else {
          expect(
            find.text('Hardware-backed signers could not be loaded.'),
            findsOneWidget,
          );
          expect(
            find.text('Payment evidence could not be loaded.'),
            findsOneWidget,
          );
          expect(find.text('No payment signer is registered.'), findsNothing);
          expect(
            find.text('No reconciled payment lifecycle is recorded.'),
            findsNothing,
          );
        }
        api.failures.clear();
        await _refresh(tester, mac);
        expect(find.textContaining('could not be loaded'), findsNothing);
        expect(api.reads, 8);
        if (mac) {
          expect(find.text('Evidence  0'), findsOneWidget);
          expect(find.text('No reconciled payment evidence'), findsOneWidget);
          await tester.tap(find.text('Mandates  0'));
          await tester.pump();
        }
        expect(
          find.text(
            mac
                ? 'No mandates awaiting review'
                : 'No purchase mandate is awaiting your review.',
          ),
          findsOneWidget,
        );
        expect(api.posts, 0);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      '$surface one unavailable source does not hide successful collections',
      (tester) async {
        final api = _Api()..failures.add(NativePaths.paymentsReviews);
        await _show(tester, api, mac);
        expect(api.reads, 4);
        if (mac) {
          expect(find.text('Mandates  —'), findsOneWidget);
          expect(find.text('Signers  0'), findsOneWidget);
          await tester.tap(find.text('Signers  0'));
          await tester.pump();
          expect(find.text('No hardware signers registered'), findsOneWidget);
          expect(
            find.textContaining('Signers could not be loaded'),
            findsNothing,
          );
        } else {
          expect(
            find.text('Mandates awaiting review could not be loaded.'),
            findsOneWidget,
          );
          expect(find.text('No payment signer is registered.'), findsOneWidget);
          expect(
            find.text('No reconciled payment lifecycle is recorded.'),
            findsOneWidget,
          );
        }
        expect(api.posts, 0);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      '$surface failed refresh preserves cached rows but never presents cached empty as current',
      (tester) async {
        final api = _Api();
        api.values[NativePaths.paymentsReviews] = {
          'trustPolicy': {'policyId': 'reviewed'},
          'reviews': [
            {
              'reviewId': 'ap2_review:one',
              'state': 'pending',
              'exactTermsSha256': 'a' * 64,
              'terms': {
                'merchant': {'name': 'Retained merchant'},
                'items': <Object>[],
                'totals': {'currency': 'USD', 'totalAmountMinor': 5000},
              },
            },
          ],
        };
        await _show(tester, api, mac);
        expect(find.text('Retained merchant'), findsWidgets);
        api.failures.addAll([
          NativePaths.paymentsReviews,
          NativePaths.paymentsAuthenticators,
        ]);
        await _refresh(tester, mac);
        expect(find.text('Retained merchant'), findsWidgets);
        expect(
          find.textContaining('Showing the last available result'),
          findsWidgets,
        );
        if (mac) {
          expect(find.text('Mandates  —'), findsOneWidget);
          expect(find.text('Evidence  0'), findsOneWidget);
          await tester.enterText(
            find.byKey(const Key('macos-payments-search')),
            'absent merchant',
          );
          await tester.pump();
          expect(find.text('No matching payment records'), findsOneWidget);
          expect(
            find.text(
              'Clear the search to view the last available collection.',
            ),
            findsOneWidget,
          );
          expect(
            find.text('No entries in the last available result'),
            findsNothing,
          );
          await tester.tap(find.text('Signers  —'));
          await tester.pump();
          expect(
            find.text('No entries in the last available result'),
            findsOneWidget,
          );
          expect(find.text('No hardware signers registered'), findsNothing);
        } else {
          expect(
            find.text('The last available result contained no entries.'),
            findsOneWidget,
          );
          expect(find.text('No payment signer is registered.'), findsNothing);
          expect(
            find.text('No reconciled payment lifecycle is recorded.'),
            findsOneWidget,
          );
        }
        expect(api.posts, 0);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      '$surface malformed collection is unavailable and a late reply after disposal has no UI effect',
      (tester) async {
        final api = _Api();
        api.values[NativePaths.paymentsReviews] = {
          'trustPolicy': {'policyId': 'reviewed'},
        };
        await _show(tester, api, mac);
        expect(
          find.text(
            mac
                ? 'Mandates unavailable'
                : 'Mandates awaiting review could not be loaded.',
          ),
          findsOneWidget,
        );
        expect(
          find.text(
            mac
                ? 'No mandates awaiting review'
                : 'No purchase mandate is awaiting your review.',
          ),
          findsNothing,
        );
        final gate = Completer<Map<String, dynamic>>();
        api.gates[NativePaths.paymentsReviews] = gate;
        if (mac) {
          await tester.tap(find.byKey(const Key('macos-payments-refresh')));
        } else {
          unawaited(
            tester
                .state<RefreshIndicatorState>(find.byType(RefreshIndicator))
                .show(),
          );
          await tester.pump(const Duration(seconds: 1));
          await tester.pump(const Duration(milliseconds: 300));
        }
        expect(api.reads, 6);
        await tester.pumpWidget(const SizedBox());
        gate.complete({'reviews': <Object>[]});
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(api.posts, 0);
      },
    );
  }
}
