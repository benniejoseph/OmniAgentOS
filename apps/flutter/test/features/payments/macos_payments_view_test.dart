import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/payments/macos_payments_view.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets('separates mandates, signers, and evidence for Mac review', (
    tester,
  ) async {
    await _desktopViewport(tester, const Size(1440, 900));
    final api = _PaymentsApi();

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: MacosPaymentsView(api: api),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Fail-closed payment boundary'), findsOneWidget);
    expect(find.text('PAYMENTS DISABLED'), findsOneWidget);
    expect(find.text('Stone & Field'), findsWidgets);
    expect(find.text('EXACT TERMS SHA-256'), findsOneWidget);
    expect(find.byType(FloatingActionButton), findsNothing);

    await tester.tap(find.text('Signers  1'));
    await tester.pump();
    expect(find.text('HARDWARE SIGNER'), findsWidgets);
    expect(find.text('apple-anonymous'), findsWidgets);

    await tester.tap(find.text('Evidence  1'));
    await tester.pump();
    expect(find.text('RECONCILED EVIDENCE'), findsOneWidget);
    expect(find.text('SETTLEMENT', skipOffstage: false), findsNothing);
    expect(find.text('Settlement'), findsOneWidget);
    expect(find.text('Evidence-derived state only.'), findsNothing);
    expect(find.textContaining('Browser output, model claims'), findsOneWidget);
  });

  testWidgets('keeps the payment workspace read-only and refreshable', (
    tester,
  ) async {
    await _desktopViewport(tester, const Size(786, 700));
    final api = _PaymentsApi();

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: MacosPaymentsView(api: api),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('READ ONLY'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
    expect(tester.takeException(), isNull);
    expect(api.reads, 4);

    await tester.tap(find.byKey(const Key('macos-payments-refresh')));
    await tester.pumpAndSettle();
    expect(api.reads, 8);
    expect(tester.takeException(), isNull);
  });
}

class _PaymentsApi extends ApiClient {
  _PaymentsApi()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  int reads = 0;

  @override
  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    reads += 1;
    if (path == NativePaths.paymentsReadiness) {
      return {
        'readiness': {
          'capability': {
            'state': 'disabled_configuration_only',
            'transactionsPermitted': false,
          },
        },
      };
    }
    if (path == NativePaths.paymentsReviews) {
      return {
        'trustPolicy': {'policyId': 'reviewed-policy'},
        'transactionsPermitted': false,
        'reviews': [
          {
            'reviewId': 'ap2_review:test-one',
            'state': 'pending',
            'exactTermsSha256': 'a' * 64,
            'terms': {
              'merchant': {
                'name': 'Stone & Field',
                'website': 'https://merchant.example',
              },
              'merchantOrderId': 'ORDER-1042',
              'items': [
                {
                  'title': 'Research notebook',
                  'quantity': 2,
                  'totalAmountMinor': 5000,
                },
              ],
              'totals': {'currency': 'USD', 'totalAmountMinor': 5000},
              'shipping': {
                'recipientName': 'Bennie',
                'city': 'Bengaluru',
                'country': 'IN',
              },
              'paymentInstrument': {'description': 'Card ending 4242'},
              'expiresAt': '2026-09-18T12:00:00.000Z',
            },
          },
        ],
      };
    }
    if (path == NativePaths.paymentsAuthenticators) {
      return {
        'credentials': [
          {
            'credentialId': 'credential-test-one',
            'aaguid': 'apple-anonymous',
            'attestationFormat': 'apple',
            'signerProfile': 'direct_hardware_webauthn_key:1',
            'trustPolicySha256': 'b' * 64,
            'state': 'active',
            'lifecycleRevision': 2,
            'createdAt': '2026-09-14T10:00:00.000Z',
            'lastUsedAt': '2026-09-16T10:00:00.000Z',
          },
        ],
      };
    }
    if (path == NativePaths.paymentsTransactions) {
      return {
        'transactions': [
          {
            'transactionId': 'ap2_payment:test-one',
            'merchantName': 'Stone & Field',
            'amountMinor': 5000,
            'currency': 'USD',
            'canonicalStatus': 'settled',
            'checkoutState': 'accepted',
            'paymentState': 'accepted',
            'authorizationState': 'authorized',
            'captureState': 'captured',
            'settlementState': 'settled',
            'refundState': 'none',
            'disputeState': 'none',
            'fulfillmentState': 'fulfilled',
            'discrepancyCodes': const [],
            'lifecycleRevision': 3,
            'updatedAt': '2026-09-17T10:00:00.000Z',
            'projectionSha256': 'c' * 64,
          },
        ],
      };
    }
    return const {};
  }
}

Future<void> _desktopViewport(WidgetTester tester, Size size) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}
