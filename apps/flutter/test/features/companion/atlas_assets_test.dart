import 'dart:async';
import 'dart:convert';

import 'package:asael/core/platform/macos_power_state.dart';
import 'package:asael/features/companion/atlas_assets.dart';
import 'package:asael/features/companion/atlas_lottie_assets.dart';
import 'package:asael/features/companion/atlas_player.dart';
import 'package:asael/features/companion/companion_models.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lottie/lottie.dart';

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

// Hold the real Lottie delivery boundary so late data exercises the player’s
// generation fence. Distinct widths identify the state actually rendered.
class _AtlasClips extends CachingAssetBundle {
  _AtlasClips({bool held = false}) {
    if (!held) release.complete();
  }
  final release = Completer<void>();
  final requests = <String>[];

  static int width(String state) => 256 + atlasStates.toList().indexOf(state);

  @override
  Future<ByteData> load(String key) async {
    if (!key.startsWith('${AtlasLottieAssets.directory}/')) {
      return rootBundle.load(key);
    }
    requests.add(key);
    await release.future;
    final state = key.split('/').last.split('-').first;
    final bytes = Uint8List.fromList(
      utf8.encode(
        jsonEncode({
          'v': '5.7.4',
          'fr': 30,
          'ip': 0,
          'op': 36,
          'w': width(state),
          'h': 256,
          'nm': state,
          'ddd': 0,
          'assets': <Object>[],
          'layers': <Object>[],
        }),
      ),
    );
    return ByteData.sublistView(bytes);
  }
}

Widget _view(
  _AtlasClips bundle, {
  String state = 'completed',
  String owner = 'owner-and-conversation',
  Object? reaction,
  bool visible = true,
  String intensity = 'balanced',
  ValueListenable<MacosPowerState> power = const AlwaysStoppedAnimation(
    MacosPowerState.disabled,
  ),
}) => MaterialApp(
  home: DefaultAssetBundle(
    bundle: bundle,
    child: Scaffold(
      body: AtlasPortrait(
        state: state,
        scopeKey: owner,
        reactionKey: reaction,
        visible: visible,
        powerState: power,
        preferences: CompanionPreferences(intensity: intensity),
      ),
    ),
  ),
);

AnimationController _clock(WidgetTester tester) =>
    tester.widget<Lottie>(find.byType(Lottie)).controller!
        as AnimationController;

Future<void> _ready(WidgetTester tester, {String state = 'completed'}) async {
  for (var attempt = 0; attempt < 30; attempt++) {
    await tester.pump();
    if (find.byType(Lottie).evaluate().isNotEmpty) {
      final clip = tester.widget<Lottie>(find.byType(Lottie));
      expect(clip.composition!.bounds.width, _AtlasClips.width(state));
      expect(clip.repeat, isFalse);
      expect(tester.takeException(), isNull);
      return;
    }
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 1)),
    );
  }
  fail('The expected $state Lottie composition did not render.');
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

  testWidgets('increasing intensity cannot replay a consumed reaction', (
    tester,
  ) async {
    final bundle = _AtlasClips(held: true);
    final reaction = Object();
    await tester.pumpWidget(
      _view(bundle, state: 'working', reaction: reaction),
    );
    bundle.release.complete();
    await _ready(tester, state: 'working');
    expect(_clock(tester).isAnimating, isFalse);
    await tester.pumpWidget(
      _view(
        bundle,
        state: 'working',
        reaction: reaction,
        intensity: 'expressive',
      ),
    );
    await _ready(tester, state: 'working');
    expect(_clock(tester).isAnimating, isFalse);
    await tester.pumpWidget(
      _view(
        bundle,
        state: 'listening',
        reaction: Object(),
        intensity: 'expressive',
      ),
    );
    await _ready(tester, state: 'listening');
    expect(_clock(tester).isAnimating, isTrue);
  });

  testWidgets(
    'hidden completion during pending artwork cannot revive or replay',
    (tester) async {
      final bundle = _AtlasClips(held: true);
      final reaction = Object();
      await tester.pumpWidget(_view(bundle, state: 'working'));
      expect(bundle.requests, [
        '${AtlasLottieAssets.directory}/working-light.json',
      ]);
      await tester.pumpWidget(
        _view(bundle, reaction: reaction, visible: false),
      );
      bundle.release.complete();
      await tester.pump();
      await tester.pump();
      expect(find.byType(Lottie), findsNothing);
      expect(bundle.requests, hasLength(1));
      await tester.pumpWidget(_view(bundle, reaction: reaction));
      await _ready(tester);
      expect(_clock(tester).isAnimating, isFalse);
    },
  );

  testWidgets('late artwork cannot render for a replaced owner', (
    tester,
  ) async {
    final bundle = _AtlasClips(held: true);
    await tester.pumpWidget(
      _view(bundle, owner: 'old-owner', reaction: Object()),
    );
    await tester.pumpWidget(
      _view(bundle, owner: 'new-owner', state: 'available'),
    );
    bundle.release.complete();
    await _ready(tester, state: 'available');
    expect(_clock(tester).isAnimating, isFalse);
    expect(
      bundle.requests.last,
      '${AtlasLottieAssets.directory}/available-light.json',
    );
  });

  for (final suppressed in [MacosPowerState.unknown, MacosPowerState.enabled]) {
    testWidgets('$suppressed consumes reactions until a later eligible event', (
      tester,
    ) async {
      final bundle = _AtlasClips();
      final power = ValueNotifier(suppressed);
      final reaction = Object();
      await tester.pumpWidget(_view(bundle, power: power));
      await _ready(tester);
      await tester.pumpWidget(_view(bundle, power: power, reaction: reaction));
      await _ready(tester);
      expect(_clock(tester).isAnimating, isFalse);
      power.value = MacosPowerState.disabled;
      await _ready(tester);
      expect(_clock(tester).isAnimating, isFalse);
      await tester.pumpWidget(_view(bundle, power: power, reaction: Object()));
      await _ready(tester);
      expect(_clock(tester).isAnimating, isTrue);
      await tester.pumpWidget(const SizedBox());
      power.dispose();
    });
  }

  testWidgets(
    'power loss fences pending artwork without reviving the old owner',
    (tester) async {
      final bundle = _AtlasClips(held: true);
      final oldPower = ValueNotifier(MacosPowerState.disabled);
      final currentPower = ValueNotifier(MacosPowerState.unknown);
      await tester.pumpWidget(
        _view(bundle, owner: 'old-owner', state: 'available', power: oldPower),
      );
      await tester.pumpWidget(
        _view(bundle, owner: 'old-owner', reaction: Object(), power: oldPower),
      );
      oldPower.value = MacosPowerState.enabled;
      final reaction = Object();
      await tester.pumpWidget(
        _view(
          bundle,
          owner: 'new-owner',
          reaction: reaction,
          power: currentPower,
        ),
      );
      oldPower.value = MacosPowerState.disabled;
      bundle.release.complete();
      await _ready(tester);
      expect(_clock(tester).isAnimating, isFalse);
      currentPower.value = MacosPowerState.disabled;
      await _ready(tester);
      expect(_clock(tester).isAnimating, isFalse);
      await tester.pumpWidget(
        _view(
          bundle,
          owner: 'new-owner',
          reaction: Object(),
          power: currentPower,
        ),
      );
      await _ready(tester);
      expect(_clock(tester).isAnimating, isTrue);
      await tester.pumpWidget(const SizedBox());
      oldPower.dispose();
      currentPower.dispose();
    },
  );

  testWidgets(
    'hidden and background reactions stay consumed through power resume',
    (tester) async {
      final bundle = _AtlasClips();
      final power = ValueNotifier(MacosPowerState.disabled);
      await tester.pumpWidget(_view(bundle, power: power));
      await _ready(tester);
      final hiddenReaction = Object();
      await tester.pumpWidget(
        _view(bundle, power: power, reaction: hiddenReaction, visible: false),
      );
      power.value = MacosPowerState.enabled;
      await tester.pumpWidget(
        _view(bundle, power: power, reaction: hiddenReaction),
      );
      power.value = MacosPowerState.disabled;
      await _ready(tester);
      expect(_clock(tester).isAnimating, isFalse);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      addTearDown(
        () => tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        ),
      );
      await tester.pumpWidget(_view(bundle, power: power, reaction: Object()));
      power.value = MacosPowerState.unknown;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await _ready(tester);
      power.value = MacosPowerState.disabled;
      await _ready(tester);
      expect(_clock(tester).isAnimating, isFalse);
      await tester.pumpWidget(_view(bundle, power: power, reaction: Object()));
      await _ready(tester);
      expect(_clock(tester).isAnimating, isTrue);
      await tester.pumpWidget(const SizedBox());
      power.dispose();
    },
  );

  testWidgets('entering low power stops an active clip and does not replay', (
    tester,
  ) async {
    final bundle = _AtlasClips();
    final power = ValueNotifier(MacosPowerState.disabled);
    await tester.pumpWidget(_view(bundle, power: power));
    await _ready(tester);
    expect(_clock(tester).isAnimating, isFalse);
    final reaction = Object();
    await tester.pumpWidget(_view(bundle, power: power, reaction: reaction));
    await _ready(tester);
    expect(_clock(tester).isAnimating, isTrue);
    final activeClock = _clock(tester);
    power.value = MacosPowerState.enabled;
    expect(activeClock.isAnimating, isFalse);
    await _ready(tester);
    power.value = MacosPowerState.disabled;
    await _ready(tester);
    expect(_clock(tester).isAnimating, isFalse);
    await tester.pump(const Duration(milliseconds: 100));
    expect(_clock(tester).isAnimating, isFalse);
    await tester.pumpWidget(_view(bundle, power: power, reaction: Object()));
    await _ready(tester);
    expect(_clock(tester).isAnimating, isTrue);
    await tester.pump(const Duration(seconds: 2));
    expect(_clock(tester).isAnimating, isFalse);
    expect(_clock(tester).value, 1);
    await tester.pumpWidget(const SizedBox());
    expect(tester.binding.transientCallbackCount, 0);
    power.dispose();
  });
}
