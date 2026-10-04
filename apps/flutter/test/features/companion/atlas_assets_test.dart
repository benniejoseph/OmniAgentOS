import 'dart:async';
import 'dart:convert';

import 'package:asael/features/companion/atlas_assets.dart';
import 'package:asael/features/companion/atlas_player.dart';
import 'package:asael/features/companion/companion_models.dart';
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

void main() {
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
}
