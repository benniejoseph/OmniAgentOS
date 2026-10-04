import 'package:asael/features/companion/companion_controller.dart';
import 'package:asael/features/companion/companion_models.dart';
import 'package:asael/features/companion/companion_presence.dart';
import 'package:asael/features/companion/companion_presentation.dart';
import 'package:asael/features/companion/companion_settings.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'companion_fixtures.dart';

class _MissingPortrait extends CachingAssetBundle {
  @override
  Future<ByteData> load(String key) async =>
      throw FlutterError('Synthetic unavailable portrait');
}

void main() {
  testWidgets(
    'unknown or hidden portrait preserves status and 48px Home action',
    (tester) async {
      var homes = 0;
      Widget view(CompanionPreferences? preferences) => MaterialApp(
        home: Scaffold(
          body: CompanionPresence(
            preferences: preferences,
            work: companionWork(status: 'queued', runId: 'exact-run-id'),
            onHome: () => homes++,
          ),
        ),
      );
      await tester.pumpWidget(view(null));
      expect(find.byType(Image), findsNothing);
      expect(find.text('Queued'), findsOneWidget);
      final geometry = tester.getSize(
        find.byKey(const ValueKey('companion-presence')),
      );
      await tester.tap(find.text('Queued'));
      await tester.pumpAndSettle();
      expect(find.text('Open home conversation').hitTestable(), findsOneWidget);
      await tester.tap(find.text('Open home conversation'));
      expect(homes, 1);
      await tester.tap(find.text('Queued'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(
        view(const CompanionPreferences(visible: false, intensity: 'quiet')),
      );
      expect(find.byType(Image), findsNothing);
      expect(
        tester.getSize(find.byKey(const ValueKey('companion-presence'))),
        geometry,
      );
      await tester.tap(find.text('Queued'));
      await tester.pumpAndSettle();
      expect(find.text('Open home conversation').hitTestable(), findsOneWidget);
      expect(
        tester
            .getSize(find.widgetWithText(TextButton, 'Open home conversation'))
            .height,
        greaterThanOrEqualTo(48),
      );
    },
  );
  testWidgets(
    'asset failure and OS reduced motion retain status and controls without playback',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: const MediaQueryData(disableAnimations: true),
            child: DefaultAssetBundle(
              bundle: _MissingPortrait(),
              child: const Scaffold(
                body: CompanionPresence(
                  preferences: CompanionPreferences(),
                  work: availableCompanion,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Available'), findsOneWidget);
      await tester.tap(find.text('Available'));
      await tester.pumpAndSettle();
      expect(find.text('ATLAS motion: reduced.'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'settings unavailable stays read-only and editor exposes full owned picker identity',
    (tester) async {
      final repository = FakeCompanionRepository()
        ..readFailure = StateError('offline');
      final c = CompanionController(repository);
      addTearDown(c.dispose);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: CompanionSettingsEditor(controller: c),
            ),
          ),
        ),
      );
      expect(find.textContaining('read-only preview'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Save preferences'),
            )
            .onPressed,
        isNull,
      );
      repository.readFailure = null;
      await c.refresh();
      await tester.pump();
      await tester.ensureVisible(find.text('Choose home conversation'));
      await tester.tap(find.text('Choose home conversation'));
      await tester.pumpAndSettle();
      expect(find.text(homeThread), findsOneWidget);
      await tester.ensureVisible(find.text('Owned conversation'));
      await tester.tap(find.text('Owned conversation'));
      await tester.pump();
      expect(c.draft!.preferredThreadId, homeThread);
      expect(repository.submissions, isEmpty);
      expect(find.text('Unsaved draft'), findsOneWidget);
    },
  );
  testWidgets(
    'discard restores saved draft with focus; reset requires confirmation and exact revision',
    (tester) async {
      final repository = FakeCompanionRepository()
        ..response = CompanionResponse.fromJson(
          companionFixture(
            revision: 3,
            preferences: const CompanionPreferences(intensity: 'quiet'),
          ),
        );
      final c = CompanionController(
        repository,
        createKey: () => 'reset-fixture',
      );
      addTearDown(c.dispose);
      await c.refresh();
      c.edit(const CompanionPreferences(motion: 'off'));
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: CompanionSettingsEditor(controller: c),
            ),
          ),
        ),
      );
      final discard = find.widgetWithText(TextButton, 'Discard draft');
      await tester.ensureVisible(discard);
      await tester.tap(discard);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Discard draft'));
      await tester.pumpAndSettle();
      expect(c.dirty, false);
      expect(repository.submissions, isEmpty);
      expect(
        tester
            .widget<TextButton>(
              find.widgetWithText(TextButton, 'Refresh preferences'),
            )
            .focusNode!
            .hasFocus,
        true,
      );
      final reset = find.widgetWithText(TextButton, 'Reset preferences');
      await tester.ensureVisible(reset);
      await tester.tap(reset);
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(repository.submissions, isEmpty);
      expect(tester.widget<TextButton>(reset).focusNode!.hasFocus, true);
      await tester.tap(reset);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Reset preferences'));
      await tester.pumpAndSettle();
      expect(repository.submissions.single.toJson(), {
        'action': 'reset',
        'expectedRevision': 3,
      });
      expect(c.receipt!.revision, 4);
      expect(c.draft, const CompanionPreferences());
    },
  );
}
