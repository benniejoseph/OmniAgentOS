import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:asael/core/platform/macos_power_state.dart';
import 'package:asael/features/companion/atlas_assets.dart';
import 'package:asael/features/companion/atlas_player.dart';
import 'package:asael/features/companion/companion_models.dart';
import 'package:cryptography/cryptography.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _manifest() => {
  'schemaVersion': 1,
  'creativeRevision': 'reviewed-test-art',
  'frameSize': 256,
  'fps': 20,
  'columns': 4,
  'states': {
    for (final state in atlasStates)
      state: {
        'durationMs': 1200,
        'frameCount': 25,
        for (final theme in ['light', 'dark'])
          theme: {
            'poster': '$state-$theme-poster.webp',
            'sprite': '$state-$theme-sprite.webp',
            'posterSha256': List.filled(64, 'a').join(),
            'spriteSha256': List.filled(64, 'b').join(),
          },
      },
  },
};

class _HeldManifest extends CachingAssetBundle {
  final pending = Completer<ByteData>();
  final textureRequests = <String>[];
  int manifestReads = 0;

  @override
  Future<ByteData> load(String key) {
    if (key == '$atlasAssetDirectory/manifest.json') {
      manifestReads++;
      return pending.future;
    }
    if (key.startsWith('$atlasAssetDirectory/')) {
      textureRequests.add(key);
      return Future.error(StateError('Artwork deliberately unavailable'));
    }
    return rootBundle.load(key);
  }

  void resolve() {
    final bytes = Uint8List.fromList(utf8.encode(jsonEncode(_manifest())));
    pending.complete(ByteData.sublistView(bytes));
  }
}

class _PaintedAtlas extends CachingAssetBundle {
  _PaintedAtlas(this.manifest, this.poster, this.sprite);
  final ByteData manifest, poster, sprite;

  static Future<_PaintedAtlas> create() async {
    Future<ByteData> picture(int width, int height) async {
      final recorder = ui.PictureRecorder();
      Canvas(recorder).drawColor(Colors.blue, BlendMode.src);
      final recording = recorder.endRecording();
      final image = await recording.toImage(width, height);
      final bytes = (await image.toByteData(format: ui.ImageByteFormat.png))!;
      image.dispose();
      recording.dispose();
      return bytes;
    }

    final poster = await picture(256, 256);
    final sprite = await picture(1024, 1792);
    Future<String> digest(ByteData data) async {
      final hash = await Sha256().hash(
        data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
      );
      return hash.bytes
          .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
          .join();
    }

    final posterHash = await digest(poster), spriteHash = await digest(sprite);
    final manifest = _manifest();
    for (final state in atlasStates) {
      for (final theme in ['light', 'dark']) {
        manifest['states'][state][theme]['posterSha256'] = posterHash;
        manifest['states'][state][theme]['spriteSha256'] = spriteHash;
      }
    }
    return _PaintedAtlas(
      ByteData.sublistView(
        Uint8List.fromList(utf8.encode(jsonEncode(manifest))),
      ),
      poster,
      sprite,
    );
  }

  @override
  Future<ByteData> load(String key) async {
    if (key == '$atlasAssetDirectory/manifest.json') {
      return manifest;
    }
    if (key.startsWith('$atlasAssetDirectory/')) {
      return key.endsWith('-sprite.webp') ? sprite : poster;
    }
    return rootBundle.load(key);
  }
}

void main() {
  test('intensity preserves composed states and result-focused balance', () {
    final expected = {
      'quiet': <String>{},
      'balanced': {'completed'},
      'expressive': {'listening', 'responding', 'working', 'completed'},
    };
    for (final entry in expected.entries) {
      expect(
        atlasStates
            .where((state) => atlasMotionAllowed(entry.key, state))
            .toSet(),
        entry.value,
      );
    }
    expect(atlasMotionAllowed(null, 'completed'), isFalse);
    expect(atlasMotionAllowed('unknown', 'completed'), isFalse);
    expect(atlasMotionAllowed('expressive', 'unknown'), isFalse);
  });

  testWidgets('increasing intensity cannot replay a consumed reaction', (
    tester,
  ) async {
    final bundle = _HeldManifest();
    final firstReaction = Object();
    final nextReaction = Object();
    Widget view(String intensity, String state, Object reaction) => MaterialApp(
      home: DefaultAssetBundle(
        bundle: bundle,
        child: Scaffold(
          body: AtlasPortrait(
            state: state,
            scopeKey: 'same-owner-and-conversation',
            reactionKey: reaction,
            preferences: CompanionPreferences(intensity: intensity),
          ),
        ),
      ),
    );
    await tester.pumpWidget(view('balanced', 'working', firstReaction));
    await tester.pump();
    bundle.resolve();
    await tester.pump();
    await tester.pumpWidget(view('expressive', 'working', firstReaction));
    await tester.pump();
    expect(
      bundle.textureRequests.every((path) => path.endsWith('-poster.webp')),
      isTrue,
    );
    await tester.pumpWidget(view('expressive', 'listening', nextReaction));
    await tester.pump();
    expect(
      bundle.textureRequests.last,
      '$atlasAssetDirectory/listening-light-sprite.webp',
    );
    expect(tester.takeException(), isNull);
  });

  test(
    'bounded delivery preserves all exact states and padded sprite rows',
    () {
      final manifest = AtlasManifest.parse(_manifest());
      expect(manifest.states.keys.toSet(), atlasStates);
      expect(manifest.states['completed']!.frameCount, 25);
      expect(manifest.states['completed']!.rows, 7);
      expect(
        manifest.states['listening']!.dark.poster,
        'listening-dark-poster.webp',
      );
    },
  );

  test('rejects invented states, paths, hashes, and unbounded clip timing', () {
    for (final edit in <void Function(Map<String, dynamic>)>[
      (value) => value['extra'] = true,
      (value) => (value['states'] as Map)['invented'] = <String, Object>{},
      (value) => (value['states'] as Map).remove('paused'),
      (value) =>
          value['states']['working']['light']['poster'] = '../working.webp',
      (value) =>
          value['states']['working']['dark']['spriteSha256'] = 'unverified',
      (value) => value['states']['working']['durationMs'] = 0,
      (value) => value['states']['working']['durationMs'] = 1201,
      (value) => value['states']['working']['frameCount'] = 24,
      (value) => value['states']['working']['frameCount'] = 26,
      (value) => value['columns'] = 5,
      (value) => value['frameSize'] = 512,
      (value) => value['fps'] = 60,
    ]) {
      final value = _manifest();
      edit(value);
      expect(() => AtlasManifest.parse(value), throwsFormatException);
    }
  });

  test('revision is bounded readable identity without normalization', () {
    for (final revision in [
      '',
      ' trimmed ',
      'line\nbreak',
      List.filled(161, 'x').join(),
    ]) {
      expect(
        () =>
            AtlasManifest.parse({..._manifest(), 'creativeRevision': revision}),
        throwsFormatException,
      );
    }
  });

  testWidgets(
    'hidden completion during a pending manifest cannot revive or replay',
    (tester) async {
      final bundle = _HeldManifest();
      final reaction = Object();
      Widget view({
        bool visible = true,
        String state = 'working',
        Object? key,
      }) => MaterialApp(
        home: DefaultAssetBundle(
          bundle: bundle,
          child: Scaffold(
            body: AtlasPortrait(
              state: state,
              scopeKey: 'owner-and-conversation',
              reactionKey: key,
              preferences: CompanionPreferences(visible: visible),
            ),
          ),
        ),
      );
      await tester.pumpWidget(view());
      await tester.pump();
      expect(bundle.manifestReads, 1);
      await tester.pumpWidget(
        view(visible: false, state: 'completed', key: reaction),
      );
      bundle.resolve();
      await tester.pump();
      expect(bundle.textureRequests, isEmpty);
      await tester.pumpWidget(view(state: 'completed', key: reaction));
      await tester.pump();
      expect(bundle.textureRequests, [
        '$atlasAssetDirectory/completed-light-poster.webp',
      ]);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('late manifest cannot load artwork for a replaced owner', (
    tester,
  ) async {
    final bundle = _HeldManifest();
    Widget view(String owner, String state) => MaterialApp(
      home: DefaultAssetBundle(
        bundle: bundle,
        child: Scaffold(
          body: AtlasPortrait(
            state: state,
            scopeKey: owner,
            preferences: const CompanionPreferences(),
          ),
        ),
      ),
    );
    await tester.pumpWidget(view('old-owner', 'completed'));
    await tester.pump();
    await tester.pumpWidget(view('new-owner', 'available'));
    bundle.resolve();
    await tester.pump();
    expect(bundle.textureRequests, [
      '$atlasAssetDirectory/available-light-poster.webp',
    ]);
    expect(tester.takeException(), isNull);
  });

  for (final suppressed in [MacosPowerState.unknown, MacosPowerState.enabled]) {
    testWidgets('$suppressed consumes reactions until a later eligible event', (
      tester,
    ) async {
      final bundle = _HeldManifest();
      final power = ValueNotifier(suppressed);
      Widget view(Object? reaction) => MaterialApp(
        home: DefaultAssetBundle(
          bundle: bundle,
          child: Scaffold(
            body: AtlasPortrait(
              state: 'completed',
              powerState: power,
              reactionKey: reaction,
              preferences: const CompanionPreferences(),
            ),
          ),
        ),
      );
      await tester.pumpWidget(view(null));
      await tester.pump();
      bundle.resolve();
      await tester.pump();
      final suppressedReaction = Object();
      await tester.pumpWidget(view(suppressedReaction));
      await tester.pump();
      power.value = MacosPowerState.disabled;
      await tester.pump();
      expect(bundle.textureRequests, isNotEmpty);
      expect(
        bundle.textureRequests.every((path) => path.endsWith('-poster.webp')),
        isTrue,
      );
      await tester.pumpWidget(view(Object()));
      await tester.pump();
      expect(
        bundle.textureRequests.last,
        '$atlasAssetDirectory/completed-light-sprite.webp',
      );
      await tester.pumpWidget(const SizedBox());
      power.dispose();
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'power loss fences pending artwork without reviving the old owner',
    (tester) async {
      final bundle = _HeldManifest();
      final oldPower = ValueNotifier(MacosPowerState.disabled);
      final currentPower = ValueNotifier(MacosPowerState.unknown);
      Widget view(
        String owner,
        String state,
        Object? reaction,
        ValueNotifier<MacosPowerState> power,
      ) => MaterialApp(
        home: DefaultAssetBundle(
          bundle: bundle,
          child: Scaffold(
            body: AtlasPortrait(
              scopeKey: owner,
              state: state,
              reactionKey: reaction,
              powerState: power,
              preferences: const CompanionPreferences(),
            ),
          ),
        ),
      );
      await tester.pumpWidget(view('old-owner', 'available', null, oldPower));
      await tester.pump();
      await tester.pumpWidget(
        view('old-owner', 'completed', Object(), oldPower),
      );
      oldPower.value = MacosPowerState.enabled;
      await tester.pump();
      final newReaction = Object();
      await tester.pumpWidget(
        view('new-owner', 'completed', newReaction, currentPower),
      );
      oldPower.value = MacosPowerState.disabled;
      bundle.resolve();
      await tester.pump();
      expect(bundle.textureRequests, [
        '$atlasAssetDirectory/completed-light-poster.webp',
      ]);
      currentPower.value = MacosPowerState.disabled;
      await tester.pump();
      expect(
        bundle.textureRequests.every((path) => path.endsWith('-poster.webp')),
        isTrue,
      );
      await tester.pumpWidget(
        view('new-owner', 'completed', Object(), currentPower),
      );
      await tester.pump();
      expect(
        bundle.textureRequests.last,
        '$atlasAssetDirectory/completed-light-sprite.webp',
      );
      await tester.pumpWidget(const SizedBox());
      oldPower.dispose();
      currentPower.dispose();
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'hidden and background reactions stay consumed through power resume',
    (tester) async {
      final bundle = _HeldManifest();
      final power = ValueNotifier(MacosPowerState.disabled);
      Widget view(Object? reaction, {bool visible = true}) => MaterialApp(
        home: DefaultAssetBundle(
          bundle: bundle,
          child: Scaffold(
            body: AtlasPortrait(
              state: 'completed',
              visible: visible,
              powerState: power,
              reactionKey: reaction,
              preferences: const CompanionPreferences(),
            ),
          ),
        ),
      );
      await tester.pumpWidget(view(null));
      await tester.pump();
      bundle.resolve();
      await tester.pump();
      bundle.textureRequests.clear();
      final hiddenReaction = Object();
      await tester.pumpWidget(view(hiddenReaction, visible: false));
      power.value = MacosPowerState.enabled;
      await tester.pumpWidget(view(hiddenReaction));
      power.value = MacosPowerState.disabled;
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      addTearDown(
        () => tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        ),
      );
      final backgroundReaction = Object();
      await tester.pumpWidget(view(backgroundReaction));
      power.value = MacosPowerState.unknown;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      power.value = MacosPowerState.disabled;
      await tester.pump();
      expect(bundle.textureRequests, isNotEmpty);
      expect(
        bundle.textureRequests.every((path) => path.endsWith('-poster.webp')),
        isTrue,
      );
      await tester.pumpWidget(view(Object()));
      await tester.pump();
      expect(
        bundle.textureRequests.last,
        '$atlasAssetDirectory/completed-light-sprite.webp',
      );
      await tester.pumpWidget(const SizedBox());
      power.dispose();
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'entering low power stops an active rendered clip and does not replay',
    (tester) async {
      final bundle = (await tester.runAsync(_PaintedAtlas.create))!;
      final power = ValueNotifier(MacosPowerState.disabled);
      Widget view(Object? reaction) => MaterialApp(
        home: DefaultAssetBundle(
          bundle: bundle,
          child: Scaffold(
            body: AtlasPortrait(
              state: 'completed',
              powerState: power,
              reactionKey: reaction,
              preferences: const CompanionPreferences(),
            ),
          ),
        ),
      );
      Future<void> decodeFramesUntil(bool Function() ready) async {
        for (var attempt = 0; attempt < 100 && !ready(); attempt++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 10)),
          );
          await tester.pump();
        }
        expect(ready(), isTrue);
      }

      final portraitPaint = find.descendant(
        of: find.byType(AtlasPortrait),
        matching: find.byType(CustomPaint),
      );
      await tester.pumpWidget(view(null));
      await decodeFramesUntil(() => portraitPaint.evaluate().isNotEmpty);
      expect(tester.binding.transientCallbackCount, 0);
      final reaction = Object();
      await tester.pumpWidget(view(reaction));
      await decodeFramesUntil(() => tester.binding.transientCallbackCount > 0);
      power.value = MacosPowerState.enabled;
      expect(tester.binding.transientCallbackCount, 0);
      await tester.pump();
      await decodeFramesUntil(() => portraitPaint.evaluate().isNotEmpty);
      power.value = MacosPowerState.disabled;
      await tester.pump();
      await decodeFramesUntil(() => portraitPaint.evaluate().isNotEmpty);
      expect(tester.binding.transientCallbackCount, 0);
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.binding.transientCallbackCount, 0);
      await tester.pumpWidget(view(Object()));
      await decodeFramesUntil(() => tester.binding.transientCallbackCount > 0);
      await tester.pumpWidget(const SizedBox());
      expect(tester.binding.transientCallbackCount, 0);
      power.dispose();
      expect(tester.takeException(), isNull);
    },
  );
}
