import 'dart:ui' show DisplayFeature, DisplayFeatureState, DisplayFeatureType;

import 'package:asael/app/layout/adaptive_workspace.dart';
import 'package:asael/app/mobile/mobile_page_scaffold.dart';
import 'package:asael/app/theme/mobile_app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets(
    'panes reflow and retain both drafts across cover and inner widths',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          theme: MobileAppTheme.light(),
          home: Scaffold(
            body: SingleChildScrollView(
              child: AdaptiveWorkspaceLayout(
                primary: const TextField(key: Key('primary-draft')),
                secondary: const TextField(key: Key('secondary-draft')),
              ),
            ),
          ),
        ),
      );
      await tester.enterText(
        find.byKey(const Key('primary-draft')),
        'Current task',
      );
      await tester.enterText(
        find.byKey(const Key('secondary-draft')),
        'Evidence note',
      );
      final primaryState = tester.state(find.byType(EditableText).first);
      expect(
        tester.getTopLeft(find.byKey(const Key('secondary-draft'))).dy,
        greaterThan(
          tester.getBottomLeft(find.byKey(const Key('primary-draft'))).dy,
        ),
      );
      for (final width in [720.0, 800.0, 1000.0, 360.0]) {
        tester.view.physicalSize = Size(width, 844);
        await tester.pumpAndSettle();
        expect(
          tester.state(find.byType(EditableText).first),
          same(primaryState),
        );
        expect(find.text('Current task'), findsOneWidget);
        expect(find.text('Evidence note'), findsOneWidget);
        expect(tester.takeException(), isNull);
        if (width >= 720) {
          expect(
            tester.getTopLeft(find.byKey(const Key('secondary-draft'))).dy,
            tester.getTopLeft(find.byKey(const Key('primary-draft'))).dy,
          );
        }
      }
    },
  );

  testWidgets('hidden context keeps its draft but cannot focus or animate', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1000, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final detailFocus = FocusNode(), listFocus = FocusNode();
    addTearDown(detailFocus.dispose);
    addTearDown(listFocus.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AdaptiveWorkspaceLayout(
            fillHeight: true,
            primary: TextField(
              focusNode: listFocus,
              key: const Key('work-list-search'),
            ),
            secondary: TextField(
              focusNode: detailFocus,
              key: const Key('selected-detail'),
            ),
          ),
        ),
      ),
    );
    await tester.enterText(
      find.byKey(const Key('selected-detail')),
      'Selected record',
    );
    expect(detailFocus.hasFocus, isTrue);
    tester.view.physicalSize = const Size(390, 800);
    await tester.pumpAndSettle();
    expect(find.text('Selected record'), findsNothing);
    expect(detailFocus.hasFocus, isFalse);
    expect(
      TickerMode.valuesOf(
        tester.element(
          find.byKey(const Key('selected-detail'), skipOffstage: false),
        ),
      ).enabled,
      isFalse,
    );
    listFocus.requestFocus();
    await tester.pump();
    for (var step = 0; step < 4; step++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      expect(detailFocus.hasFocus, isFalse);
    }
    tester.view.physicalSize = const Size(1000, 800);
    await tester.pumpAndSettle();
    expect(find.text('Selected record'), findsOneWidget);
    expect(
      TickerMode.valuesOf(
        tester.element(find.byKey(const Key('selected-detail'))),
      ).enabled,
      isTrue,
    );
    detailFocus.requestFocus();
    await tester.pump();
    expect(detailFocus.hasFocus, isTrue);
    expect(tester.takeException(), isNull);
  });

  for (final (name, feature, expected) in [
    (
      'vertical hinge',
      const DisplayFeature(
        bounds: Rect.fromLTWH(360, 0, 24, 800),
        type: DisplayFeatureType.hinge,
        state: DisplayFeatureState.postureFlat,
      ),
      const Rect.fromLTWH(384, 0, 516, 800),
    ),
    (
      'horizontal half-open fold',
      const DisplayFeature(
        bounds: Rect.fromLTWH(0, 390, 900, 0),
        type: DisplayFeatureType.fold,
        state: DisplayFeatureState.postureHalfOpened,
      ),
      const Rect.fromLTWH(0, 390, 900, 410),
    ),
    (
      'flat continuous fold',
      const DisplayFeature(
        bounds: Rect.fromLTWH(450, 0, 0, 800),
        type: DisplayFeatureType.fold,
        state: DisplayFeatureState.postureFlat,
      ),
      const Rect.fromLTWH(0, 0, 900, 800),
    ),
  ]) {
    testWidgets('$name leaves controls inside an unobstructed region', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(900, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      Size? regionSize;
      await tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: MediaQueryData(
              size: const Size(900, 800),
              displayFeatures: [feature],
            ),
            child: WorkspaceDisplayRegion(
              child: Builder(
                builder: (context) {
                  regionSize = MediaQuery.sizeOf(context);
                  return const SizedBox.expand(key: Key('safe-workspace'));
                },
              ),
            ),
          ),
        ),
      );
      expect(tester.getRect(find.byKey(const Key('safe-workspace'))), expected);
      expect(regionSize, expected.size);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('page actions respect their pane and large text', (tester) async {
    tester.view.physicalSize = const Size(1000, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: MobileAppTheme.light(),
        home: MediaQuery(
          data: const MediaQueryData(
            size: Size(1000, 800),
            textScaler: TextScaler.linear(2),
            disableAnimations: true,
          ),
          child: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(
                width: 340,
                child: MobilePageHeader(
                  title: 'My work',
                  subtitle: 'Your projects and clients',
                  actions: [
                    IconButton(
                      onPressed: () {},
                      tooltip: 'Add project',
                      icon: const Icon(Icons.add),
                    ),
                    IconButton(
                      onPressed: () {},
                      tooltip: 'Filter',
                      icon: const Icon(Icons.tune),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    expect(
      tester.getRect(find.byTooltip('Add project')).right,
      lessThanOrEqualTo(340),
    );
    expect(
      tester.getRect(find.byTooltip('Filter')).right,
      lessThanOrEqualTo(340),
    );
    expect(
      tester.getSize(find.byTooltip('Add project')).height,
      greaterThanOrEqualTo(48),
    );
    expect(tester.takeException(), isNull);
  });
}
