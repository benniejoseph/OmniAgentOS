import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/customers/accounts_view.dart';
import 'package:asael/features/customers/macos_accounts_view.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets('browses, searches, and opens accounts from a Mac inspector', (
    tester,
  ) async {
    await _desktopViewport(tester, const Size(1440, 900));
    final api = _AccountsApi();
    CustomerAccountSummary? opened;

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: MacosAccountsView(
          api: api,
          onOpen: (account) => opened = account,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('macos-accounts-summary')), findsOneWidget);
    expect(find.text('ACCOUNT'), findsOneWidget);
    expect(find.text('OPEN SIGNALS'), findsOneWidget);
    expect(find.byType(FloatingActionButton), findsNothing);

    await tester.tap(
      find.byKey(const Key('macos-account-row-account-horizon')),
    );
    await tester.pump();
    expect(find.text('Unassigned'), findsWidgets);
    await tester.tap(
      find.byKey(const Key('macos-account-open-account-horizon')),
    );
    expect(opened?.id, 'account-horizon');

    await tester.enterText(
      find.byKey(const Key('macos-accounts-search')),
      'Acme',
    );
    await tester.pump();
    expect(
      find.byKey(const Key('macos-account-row-account-acme')),
      findsOneWidget,
    );
    expect(
      find.byKey(const Key('macos-account-row-account-horizon')),
      findsNothing,
    );
  });

  testWidgets('fits the minimum Mac workspace and refreshes both projections', (
    tester,
  ) async {
    await _desktopViewport(tester, const Size(786, 700));
    final api = _AccountsApi();

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: MacosAccountsView(api: api, onOpen: (_) {}),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(api.listReads, 1);
    expect(api.portfolioReads, 1);

    await tester.tap(find.byKey(const Key('macos-accounts-refresh')));
    await tester.pumpAndSettle();
    expect(api.listReads, 2);
    expect(api.portfolioReads, 2);
    expect(tester.takeException(), isNull);
  });
}

class _AccountsApi extends ApiClient {
  _AccountsApi()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  int listReads = 0;
  int portfolioReads = 0;

  @override
  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    if (path == NativePaths.customersList) {
      listReads += 1;
      return {
        'accounts': [
          {
            'accountId': 'account-acme',
            'name': 'Acme Markets',
            'lifecycle': 'at_risk',
            'owner': {'displayName': 'Bennie'},
          },
          {
            'accountId': 'account-horizon',
            'name': 'Horizon Labs',
            'lifecycle': 'active',
          },
        ],
      };
    }
    if (path == NativePaths.customersPortfolio) {
      portfolioReads += 1;
      return {
        'portfolio': {
          'accounts': [
            {
              'accountId': 'account-acme',
              'attention': 'urgent',
              'health': {'status': 'at_risk', 'scoreBasisPoints': 6200},
              'counts': {'openRisks': 3, 'pendingApprovals': 1},
            },
            {
              'accountId': 'account-horizon',
              'attention': 'clear',
              'health': {'status': 'healthy', 'scoreBasisPoints': 9100},
              'counts': {'openRisks': 0, 'pendingApprovals': 0},
            },
          ],
        },
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
