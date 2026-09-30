import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/ambient_voice/realtime_voice_controller.dart';
import 'package:audioplayers/audioplayers.dart';
import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

class _Api extends Fake implements ApiClient {}

class _Sessions extends Fake implements SecureSessionStore {
  @override
  Future<bool> accessTokenNeedsRefresh({
    Duration leeway = const Duration(seconds: 30),
  }) async => false;

  @override
  Future<String?> readToken() async => 'access-token';
}

/// The speech service, answering each request with a short PCM clip.
class _Speech implements HttpClientAdapter {
  _Speech({this.failing = const {}, this.held = const {}});

  /// Requests, by their order, that the service refuses.
  final Set<int> failing;

  /// Requests, by their order, that wait until they are canceled.
  final Set<int> held;

  /// The text of each request, in order.
  final texts = <String>[];
  var canceled = 0;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final index = texts.length;
    texts.add((options.data as Map)['text'] as String);
    if (held.contains(index)) {
      await cancelFuture;
      canceled += 1;
      throw DioException.requestCancelled(
        requestOptions: options,
        reason: 'canceled',
      );
    }
    if (failing.contains(index)) {
      return ResponseBody.fromString(
        jsonEncode({'error': 'Speech is unavailable right now.'}),
        503,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );
    }
    return ResponseBody.fromBytes(
      Uint8List(4800),
      200,
      headers: {
        Headers.contentTypeHeader: ['audio/pcm'],
        'x-asael-audio-retention': ['not_stored_by_asael'],
        'x-asael-audio-encoding': ['pcm_s16le'],
        'x-asael-audio-sample-rate': ['24000'],
        'x-asael-voice-profile': ['asael-voice:1'],
        'x-asael-voice-profile-sha256': ['a' * 64],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

/// An audio player whose clips finish when the test says so.
class _Player extends Fake implements AudioPlayer {
  _Player({this.autoComplete = false, this.beforePlay});

  /// Finishes each clip as soon as it starts.
  final bool autoComplete;

  /// Runs as each clip is about to play, and may throw.
  final Future<void> Function()? beforePlay;
  final _completions = StreamController<void>.broadcast();

  /// The file of each clip played, in order.
  final played = <String>[];

  void complete() => _completions.add(null);

  @override
  Stream<void> get onPlayerComplete => _completions.stream;

  @override
  Future<void> setReleaseMode(ReleaseMode releaseMode) async {}

  @override
  Future<void> play(
    Source source, {
    double? volume,
    double? balance,
    AudioContext? ctx,
    Duration? position,
    PlayerMode? mode,
  }) async {
    await beforePlay?.call();
    played.add((source as DeviceFileSource).path);
    if (autoComplete) complete();
  }

  @override
  Future<void> stop() async {}
}

AmbientRealtimeVoiceController _voice(_Speech speech, _Player player) {
  final voice = AmbientRealtimeVoiceController(
    api: _Api(),
    sessionStore: _Sessions(),
    speechDio: Dio(BaseOptions(baseUrl: 'https://asael.test'))
      ..httpClientAdapter = speech,
    audioPlayer: player,
  );
  addTearDown(voice.dispose);
  return voice;
}

Future<void> _until(bool Function() condition) async {
  for (var attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  fail('The condition was not met in time.');
}

/// A reply the speech service receives in two parts.
final _twoParts = '${'A sentence to read aloud. ' * 200}The end.';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory temporary;

  setUpAll(() {
    temporary = Directory.systemTemp.createTempSync('asael-speech-test-');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/path_provider'),
          (call) async => temporary.path,
        );
  });

  tearDownAll(() => temporary.deleteSync(recursive: true));

  test('speaks the start of a long answer and points to the screen for '
      'the rest', () async {
    final speech = _Speech();
    final voice = _voice(speech, _Player(autoComplete: true));

    await voice.speak('Word. ' * 4000);

    expect(speech.texts.length, greaterThan(1));
    expect(speech.texts.every((text) => text.length <= 3800), isTrue);
    expect(
      speech.texts.last,
      endsWith('Word.\n\nThe rest of the answer is on screen.'),
    );
    expect(RegExp('Word').allMatches(speech.texts.join()).length, 3333);
    expect(voice.detail, 'Spoken response finished.');
  });

  test('downloads the next part while the one before it plays', () async {
    final speech = _Speech();
    final player = _Player();
    final voice = _voice(speech, player);

    final spoken = voice.speak(_twoParts);
    await _until(() => player.played.length == 1);
    await _until(() => speech.texts.length == 2);
    expect(player.played, hasLength(1));
    player.complete();
    await _until(() => player.played.length == 2);
    player.complete();
    await spoken;

    expect(speech.texts.join(' '), _twoParts);
    expect(voice.phase, AmbientRealtimeVoicePhase.idle);
    expect(voice.isSpeechPlaying, isFalse);
  });

  test(
    'closes a code block that a part boundary splits and reopens it',
    () async {
      final speech = _Speech();
      final voice = _voice(speech, _Player(autoComplete: true));

      await voice.speak(
        'Intro.\n```ts\n${'const value = 1;\n' * 300}```\nDone.',
      );

      expect(speech.texts, hasLength(2));
      expect(speech.texts.first, startsWith('Intro.\n```ts\nconst value = 1;'));
      expect(speech.texts.first, endsWith('const value = 1;\n```'));
      expect(speech.texts.last, startsWith('```\nconst value = 1;'));
      expect(speech.texts.last, endsWith('const value = 1;\n```\nDone.'));
    },
  );

  test(
    'keeps a block open through a shorter fence or a fence with text',
    () async {
      final speech = _Speech();
      final voice = _voice(speech, _Player(autoComplete: true));

      await voice.speak(
        'Intro.\n````md\n```\n${'line of code\n' * 300}```` not a close\n'
        '````\nDone.',
      );

      expect(speech.texts, hasLength(2));
      expect(speech.texts.first, endsWith('line of code\n````'));
      expect(speech.texts.last, startsWith('````\nline of code'));
      expect(speech.texts.last, endsWith('```` not a close\n````\nDone.'));
    },
  );

  test('reopens a split block with a bounded fence', () async {
    final speech = _Speech();
    final voice = _voice(speech, _Player(autoComplete: true));
    final fence = '`' * 30;

    await voice.speak('Intro.\n$fence\n${'line of code\n' * 300}$fence\nDone.');

    expect(speech.texts, hasLength(2));
    expect(speech.texts.first, endsWith('line of code\n${'`' * 20}'));
    expect(speech.texts.last, startsWith('${'`' * 20}\nline of code'));
  });

  test(
    'closes a code block that the spoken part of a long answer cuts',
    () async {
      final speech = _Speech();
      final voice = _voice(speech, _Player(autoComplete: true));

      await voice.speak('Intro.\n```\n${'x = 1\n' * 4000}```');

      expect(
        speech.texts.last,
        endsWith('x = 1\n```\n\nThe rest of the answer is on screen.'),
      );
    },
  );

  test(
    'leaves the session as it was when the answer cannot be played',
    () async {
      final voice = _voice(_Speech(failing: {0}), _Player(autoComplete: true));

      await expectLater(
        voice.speak('Hello there.'),
        throwsA(isA<AmbientVoiceException>()),
      );

      expect(voice.phase, AmbientRealtimeVoicePhase.idle);
      expect(voice.errorMessage, isNull);
      expect(voice.isSpeechPlaying, isFalse);
      expect(
        voice.detail,
        'The answer is on screen, but it could not be played aloud. '
        'Speech is unavailable right now.',
      );
    },
  );

  test('reports a later part that fails once the part before it has '
      'played', () async {
    final speech = _Speech(failing: {1});
    final player = _Player();
    final voice = _voice(speech, player);

    final spoken = voice.speak(_twoParts);
    await _until(() => player.played.length == 1 && speech.texts.length == 2);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(voice.isSpeechPlaying, isTrue);
    player.complete();

    await expectLater(spoken, throwsA(isA<AmbientVoiceException>()));
    expect(player.played, hasLength(1));
    expect(voice.isSpeechPlaying, isFalse);
  });

  test('stops the next part downloading when playback fails', () async {
    final speech = _Speech(held: {1});
    final voice = _voice(
      speech,
      _Player(
        beforePlay: () async {
          await _until(() => speech.texts.length == 2);
          throw StateError('The audio device is unavailable.');
        },
      ),
    );

    await expectLater(voice.speak(_twoParts), throwsStateError);

    await _until(() => speech.canceled == 1);
    expect(voice.phase, AmbientRealtimeVoicePhase.idle);
  });
}
