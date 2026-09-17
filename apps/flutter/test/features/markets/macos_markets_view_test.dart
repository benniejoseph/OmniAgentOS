import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/markets/markets_view.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Markets uses a Mac research workspace and context inspector', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    FlutterSecureStorage.setMockInitialValues({});
    tester.view.physicalSize = const Size(1440, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      MaterialApp(
        theme: MacosAppTheme.light(),
        home: MarketsView(api: _MarketApi()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Market Intelligence'), findsOneWidget);
    expect(find.text('XAUUSD'), findsOneWidget);
    expect(find.text('ICT + Quarterly'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('macos-market-inspector')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('macos-market-scroll-view')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    debugDefaultTargetPlatformOverride = null;
  });
}

class _MarketApi extends ApiClient {
  _MarketApi()
    : super(Dio(), Dio(), SecureSessionStore(const FlutterSecureStorage()));

  @override
  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    if (path == NativePaths.marketOverview) {
      return {
        'phase': 'research',
        'instruments': [
          {'id': 'xauusd.spot', 'symbol': 'XAUUSD'},
          {'id': 'ndx.index', 'symbol': 'NAS100'},
        ],
        'agent': {
          'name': 'Meridian',
          'provider': 'OpenAI',
          'model': 'configured-model',
          'assignmentState': 'ready',
        },
        'providers': const [],
        'guardrails': const ['Research only'],
      };
    }
    if (path == NativePaths.marketBars) {
      return {
        'instrumentId': 'xauusd.spot',
        'snapshotSource': 'Twelve Data',
        'asOf': '2026-09-17T10:00:00Z',
        'bars': [
          {'close': 3650.0},
          {'close': 3662.0},
        ],
      };
    }
    return const {};
  }
}
