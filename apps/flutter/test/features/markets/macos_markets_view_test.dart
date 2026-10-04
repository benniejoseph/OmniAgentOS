import 'package:asael/app/theme/macos_app_theme.dart';
import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/markets/markets_providers.dart';
import 'package:asael/features/markets/markets_recovery_store.dart';
import 'package:asael/features/markets/markets_workspace.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'markets_test_support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final phone in [false, true]) {
    testWidgets(
      phone
          ? 'Markets remains readable at 320 pixels and 200 percent text'
          : 'Mac Markets opens stored evidence and all five research views',
      (tester) async {
        tester.view.physicalSize = phone
            ? const Size(320, 900)
            : const Size(1440, 1000);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final repo = MarketTestRepository(), api = MarketTestApi();
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              apiClientProvider.overrideWithValue(api),
              marketsRepositoryProvider.overrideWithValue(repo),
              marketsRecoveryStoreProvider.overrideWithValue(
                MemoryMarketsRecoveryStore(),
              ),
            ],
            child: MaterialApp(
              theme: MacosAppTheme.light(),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(phone ? 2 : 1)),
                child: child!,
              ),
              home: const NativeMarketsView(),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Markets'), findsOneWidget);
        expect(repo.reads, ['overview', 'snapshots']);
        expect(repo.reads, isNot(contains('bars')));
        expect(repo.writes, isEmpty);
        expect(tester.takeException(), isNull);
        if (!phone) {
          for (final tab in ['Events', 'Technical', 'Backtests', 'Journal']) {
            await tester.ensureVisible(find.widgetWithText(ChoiceChip, tab));
            await tester.tap(find.widgetWithText(ChoiceChip, tab));
            await tester.pumpAndSettle();
            expect(tester.takeException(), isNull);
          }
          expect(
            repo.reads,
            containsAll([
              'events',
              'replays',
              'baselines',
              'analysis',
              'backtests',
              'journal',
            ]),
          );
          expect(repo.reads, isNot(contains('calendar')));
          expect(repo.writes, isEmpty);
        }
        await tester.pumpWidget(const SizedBox());
        await tester.pump();
        expect(tester.takeException(), isNull);
      },
      variant: TargetPlatformVariant.only(
        phone ? TargetPlatform.android : TargetPlatform.macOS,
      ),
    );
  }
}
