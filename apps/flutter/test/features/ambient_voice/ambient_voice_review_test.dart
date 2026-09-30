import 'dart:async';
import 'dart:io';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/ambient_voice/ambient_voice_consent.dart';
import 'package:asael/features/ambient_voice/ambient_voice_view.dart';
import 'package:asael/features/ambient_voice/realtime_voice_controller.dart';
import 'package:asael/features/talk/talk.dart';
import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

class _Api extends Fake implements ApiClient {}

class _Sessions extends Fake implements SecureSessionStore {}

class _Player extends Fake implements AudioPlayer {}

class _Recorder extends Fake implements VoiceDraftRecorder {}

class _CountingRecorder extends Fake implements VoiceDraftRecorder {
  int cancels = 0;

  @override
  Future<void> cancel() async => cancels += 1;
}

class _Consent implements AmbientVoiceConsent {
  _Consent({this.agreed = false, this.failSave = false, this.held});

  bool agreed;
  final bool failSave;

  /// Holds every read and save until it completes.
  final Completer<void>? held;
  var accepts = 0;

  @override
  Future<bool> accepted() async {
    await held?.future;
    return agreed;
  }

  @override
  Future<void> accept() async {
    accepts += 1;
    await held?.future;
    if (failSave) throw StateError('The keychain is locked.');
    agreed = true;
  }
}

class _Values implements AsaelSecureValueStore {
  final values = <String, String>{};

  @override
  Future<void> prepare() async {}

  @override
  Future<void> migrateLegacyCredentials() async {}

  @override
  Future<String?> read({required String key}) async => values[key];

  @override
  Future<void> write({required String key, required String value}) async =>
      values[key] = value;

  @override
  Future<void> delete({required String key}) async => values.remove(key);
}

class _Repository implements TalkRepository {
  final sent = <String>[];

  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    String? agentId,
    TalkCommandModelSelection? modelSelection,
  }) async* {
    sent.add(message);
    yield const SseEvent(
      event: 'done',
      data: {'type': 'done', 'response': 'Booked.'},
    );
  }

  @override
  Future<void> cancelRun(String runId) async {}

  @override
  Future<TalkRunInspection> inspectRun(String runId) async =>
      throw UnimplementedError();

  @override
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId) async =>
      throw UnimplementedError();

  @override
  Future<String> transcribeVoice(Uint8List bytes) async => 'Unused';
}

AmbientRealtimeVoiceController _voice() => AmbientRealtimeVoiceController(
  api: _Api(),
  sessionStore: _Sessions(),
  audioPlayer: _Player(),
);

/// A realtime session that is listening, without a microphone.
class _ListeningVoice extends ChangeNotifier
    implements AmbientRealtimeVoiceController {
  bool listening = true;
  int cancels = 0;

  @override
  AmbientRealtimeVoicePhase get phase => listening
      ? AmbientRealtimeVoicePhase.listening
      : AmbientRealtimeVoicePhase.stopped;

  @override
  bool get isListening => listening;

  @override
  bool get isSpeechPlaying => false;

  @override
  String get transcript => '';

  @override
  String get detail => 'Listening…';

  @override
  double get level => 0;

  @override
  Future<void> cancel() async {
    cancels += 1;
    listening = false;
    notifyListeners();
  }

  @override
  Future<void> interruptSpeech() async {}

  @override
  Object? noSuchMethod(Invocation invocation) => null;
}

/// A workspace lock whose listeners a test can see.
class _Lock extends ValueNotifier<bool> {
  _Lock(super.value);

  bool get listened => hasListeners;
}

/// A finished transcription turn whose tokens carry these log probabilities.
Map<String, Object?> _turn(String transcript, List<double> logprobs) => {
  'type': 'conversation.item.input_audio_transcription.completed',
  'item_id': 'item_1',
  'transcript': transcript,
  'logprobs': [
    for (final logprob in logprobs) {'logprob': logprob},
  ],
};

/// The audio of a turn, committed before its transcript arrives.
Map<String, Object?> _committed(String itemId) => {
  'type': 'input_audio_buffer.committed',
  'item_id': itemId,
};

Map<String, Object?> _partial(String itemId, String delta) => {
  'type': 'conversation.item.input_audio_transcription.delta',
  'item_id': itemId,
  'delta': delta,
};

Map<String, Object?> _finished(
  String itemId,
  String transcript, [
  List<double>? logprobs,
]) => {
  'type': 'conversation.item.input_audio_transcription.completed',
  'item_id': itemId,
  'transcript': transcript,
  'logprobs': ?logprobs?.map((logprob) => {'logprob': logprob}).toList(),
};

Map<String, Object?> _failed(String itemId) => {
  'type': 'conversation.item.input_audio_transcription.failed',
  'item_id': itemId,
  'error': {'type': 'server_error', 'message': 'Transcription failed.'},
};

const _confident = [-.05, -.1];
const _unsure = [-1.2, -3.0];
const _request = 'Book the flight to Lisbon';
final _sendButton = find.widgetWithIcon(IconButton, Icons.arrow_upward_rounded);
final _microphone = find.widgetWithIcon(IconButton, Icons.mic_rounded);
const _notice =
    'OpenAI transcribes your live microphone audio. Asael does not store it. '
    'Press the microphone to agree and start.';

void main() {
  group('review attestation', () {
    test('Send attests only a confidently recognized transcript', () async {
      final confident = _voice()
        ..reviewProviderEventsForTesting([_turn(_request, _confident)]);
      addTearDown(confident.dispose);
      expect(confident.confidenceBand, AmbientVoiceConfidenceBand.high);
      expect(confident.attestReviewBySend(), isTrue);
      expect(confident.reviewDraft.reviewAttested, isTrue);

      final needsReview = {
        AmbientVoiceConfidenceBand.low: _voice()
          ..reviewProviderEventsForTesting([_turn(_request, _unsure)]),
        AmbientVoiceConfidenceBand.unavailable: _voice()
          ..reviewProviderEventsForTesting([_turn(_request, [])]),
        AmbientVoiceConfidenceBand.edited: _voice()..editTranscript(_request),
      };
      for (final MapEntry(key: band, value: draft) in needsReview.entries) {
        addTearDown(draft.dispose);
        expect(draft.confidenceBand, band);
        expect(draft.reviewRequired, isTrue, reason: band.name);
        expect(draft.attestReviewBySend(), isFalse, reason: band.name);
        expect(draft.reviewDraft.reviewAttested, isFalse, reason: band.name);
        await expectLater(
          draft.finish(AmbientVoiceOutcome.sent),
          throwsA(
            isA<AmbientVoiceException>().having(
              (error) => error.code,
              'code',
              'voice_review_required',
            ),
          ),
        );

        draft.attestReview(true);
        expect(draft.attestReviewBySend(), isTrue, reason: band.name);
      }
    });

    test('Send attests nothing once the review is over', () async {
      final voice = _voice()
        ..reviewProviderEventsForTesting([_turn(_request, _confident)]);
      addTearDown(voice.dispose);

      await voice.cancel();

      expect(voice.attestReviewBySend(), isFalse);
      expect(voice.reviewAttested, isFalse);
    });
  });

  group('recognized draft', () {
    AmbientRealtimeVoiceController reviewed(List<Map<String, Object?>> events) {
      final voice = _voice()..reviewProviderEventsForTesting(events);
      addTearDown(voice.dispose);
      return voice;
    }

    final first = [
      _committed('item_1'),
      _finished('item_1', 'Send the invoice', _confident),
    ];

    test('keeps turns in the order they were spoken', () {
      final voice = reviewed([
        _committed('item_1'),
        _committed('item_2'),
        _committed('item_1'),
        _finished('item_2', 'and email it to Sam.', _confident),
        _finished('item_1', 'Draft the report', _confident),
      ]);

      expect(voice.transcript, 'Draft the report and email it to Sam.');
      expect(voice.confidenceBand, AmbientVoiceConfidenceBand.high);
    });

    test('needs review unless every turn finished with a score', () {
      final drafts = {
        'arriving': [
          ...first,
          _committed('item_2'),
          _partial('item_2', ''),
          _partial('item_2', "but don't"),
        ],
        'untranscribed': [...first, _committed('item_2')],
        'failed': [...first, _committed('item_2'), _failed('item_2')],
        'unscored': [...first, _finished('item_2', "but don't send it yet.")],
      };
      for (final MapEntry(key: name, value: events) in drafts.entries) {
        final voice = reviewed(events);
        expect(
          voice.confidenceBand,
          AmbientVoiceConfidenceBand.unavailable,
          reason: name,
        );
        expect(voice.attestReviewBySend(), isFalse, reason: name);
      }

      // A turn that held no words does not hold the band back.
      final silent = reviewed([
        ...first,
        _committed('item_2'),
        _finished('item_2', ''),
      ]);
      expect(silent.transcript, 'Send the invoice');
      expect(silent.confidenceBand, AmbientVoiceConfidenceBand.high);
    });

    test('shows where speech was not transcribed', () {
      final failed = reviewed([
        ...first,
        _committed('item_2'),
        _partial('item_2', "but don't"),
        _failed('item_2'),
        _finished('item_2', "but don't send it yet.", _confident),
        _partial('item_2', ' late'),
        _failed('item_1'),
      ]);
      expect(failed.transcript, "Send the invoice but don't [not transcribed]");

      final unknown = reviewed([...first, _failed('item_9')]);
      expect(unknown.transcript, 'Send the invoice [not transcribed]');

      // Review closes turns whose transcripts never arrived.
      final unfinished = reviewed([
        ...first,
        _committed('item_2'),
        _partial('item_2', "but don't"),
        _committed('item_3'),
      ]);
      expect(
        unfinished.transcript,
        "Send the invoice but don't [not transcribed] [not transcribed]",
      );
      expect(unfinished.confidenceBand, AmbientVoiceConfidenceBand.unavailable);
    });
  });

  group('provider errors', () {
    Map<String, Object?> providerError(Object? error) => {
      'type': 'error',
      'event_id': 'event_1',
      'error': error,
    };

    Future<AmbientRealtimeVoiceController> reviewed(
      List<Map<String, Object?>> events,
    ) async {
      final voice = _voice()..reviewProviderEventsForTesting(events);
      addTearDown(voice.dispose);
      await Future<void>.delayed(Duration.zero);
      return voice;
    }

    test('keep the session through an error it can recover from', () async {
      final voice = await reviewed([
        _committed('item_1'),
        _finished('item_1', 'Send the invoice', _confident),
        providerError({'type': 'server_error', 'message': 'Server error.'}),
        _committed('item_2'),
        _finished('item_2', 'to Sam.', _confident),
      ]);

      expect(voice.phase, AmbientRealtimeVoicePhase.review);
      expect(voice.errorCode, isNull);
      expect(voice.transcript, 'Send the invoice to Sam.');
      expect(voice.providerErrorCode, 'server_error');
    });

    test('end the session after one it cannot, keeping the draft', () async {
      final voice = await reviewed([
        _committed('item_1'),
        _finished('item_1', 'Send the invoice', _confident),
        providerError({
          'type': 'invalid_request_error',
          'code': 'session_expired',
          'message': 'Your session hit the maximum duration.',
        }),
      ]);

      expect(voice.phase, AmbientRealtimeVoicePhase.error);
      expect(voice.errorCode, 'provider_session_ended');
      expect(voice.providerErrorCode, 'session_expired');
      expect(voice.transcript, 'Send the invoice');
    });

    test('keep only a code, never the message', () async {
      final codes = {
        'invalid_value': {
          'type': 'invalid_request_error',
          'code': 'invalid_value',
          'message': 'Invalid value.',
        },
        'server_error': {
          'type': ' Server_Error ',
          'code': 'Call Sam at 555-0100',
          'message': 'Call Sam at 555-0100.',
        },
        'unknown': {'code': 'x' * 65, 'message': 'x'},
      };
      for (final MapEntry(key: code, value: error) in codes.entries) {
        final voice = await reviewed([providerError(error)]);
        expect(voice.providerErrorCode, code);
      }
      final unshaped = await reviewed([providerError('session_expired')]);
      expect(unshaped.providerErrorCode, 'unknown');
      expect(unshaped.phase, AmbientRealtimeVoicePhase.review);
    });

    test('ignore a commit turn detection had already made', () async {
      final voice = await reviewed([
        _committed('item_1'),
        _finished('item_1', 'Send the invoice', _confident),
        providerError({
          'type': 'invalid_request_error',
          'code': 'input_audio_buffer_commit_empty',
          'message': 'Error committing input audio buffer.',
        }),
      ]);

      expect(voice.phase, AmbientRealtimeVoicePhase.review);
      expect(voice.providerErrorCode, isNull);
      expect(voice.transcript, 'Send the invoice');
    });
  });

  group('review surface', () {
    Widget surface({
      required AmbientVoiceConfidenceBand band,
      bool reviewRequired = false,
      bool reviewAttested = false,
      ValueChanged<bool>? onReviewAttested,
      VoidCallback? onSend,
    }) => MaterialApp(
      home: AmbientVoiceSurface(
        phase: AmbientVoicePhase.review,
        level: 0,
        transcript: _request,
        useThisMac: false,
        thisMacAvailable: false,
        thisMacUnavailableReason: 'This Mac is not paired.',
        detail: 'Recognized request ready to send.',
        onDestinationChanged: (_) {},
        onMicrophonePressed: null,
        onSend: onSend,
        onStop: null,
        onReviewApproval: null,
        onClose: () {},
        confidenceBand: band,
        reviewRequired: reviewRequired,
        reviewAttested: reviewAttested,
        onReviewAttested: onReviewAttested,
      ),
    );

    testWidgets('shows how confidently the transcript was recognized', (
      tester,
    ) async {
      for (final (band, label) in const [
        (AmbientVoiceConfidenceBand.high, 'High confidence'),
        (AmbientVoiceConfidenceBand.low, 'Low confidence'),
        (AmbientVoiceConfidenceBand.unavailable, 'Confidence unavailable'),
        (AmbientVoiceConfidenceBand.edited, 'Edited'),
      ]) {
        await tester.pumpWidget(
          surface(
            band: band,
            reviewRequired: band != AmbientVoiceConfidenceBand.high,
          ),
        );
        expect(find.text(label), findsOneWidget);
      }
    });

    testWidgets('keeps Send off until the review checkbox is ticked', (
      tester,
    ) async {
      final attestations = <bool>[];
      void send() {}

      await tester.pumpWidget(
        surface(
          band: AmbientVoiceConfidenceBand.low,
          reviewRequired: true,
          onReviewAttested: attestations.add,
          onSend: send,
        ),
      );

      expect(find.text('Check the transcript'), findsOneWidget);
      expect(tester.widget<IconButton>(_sendButton).onPressed, isNull);
      final checkbox = tester.widget<Checkbox>(find.byType(Checkbox));
      expect(checkbox.value, isFalse);
      expect(checkbox.semanticLabel, contains('exact command'));
      checkbox.onChanged!(true);
      expect(attestations, [true]);

      await tester.pumpWidget(
        surface(
          band: AmbientVoiceConfidenceBand.low,
          reviewRequired: true,
          reviewAttested: true,
          onReviewAttested: attestations.add,
          onSend: send,
        ),
      );

      expect(tester.widget<Checkbox>(find.byType(Checkbox)).value, isTrue);
      expect(tester.widget<IconButton>(_sendButton).onPressed, send);
    });

    testWidgets('sends a confident transcript without a checkbox', (
      tester,
    ) async {
      void send() {}

      await tester.pumpWidget(
        surface(band: AmbientVoiceConfidenceBand.high, onSend: send),
      );

      expect(find.text('Ready to send'), findsOneWidget);
      expect(find.byType(Checkbox), findsNothing);
      expect(tester.widget<IconButton>(_sendButton).onPressed, send);
    });
  });

  group('Ambient Command send', () {
    Future<(AmbientRealtimeVoiceController, _Repository)> review(
      WidgetTester tester,
      String transcript,
      List<double> logprobs,
    ) async {
      final voice = _voice();
      final repository = _Repository();
      final talk = TalkController(repository);
      addTearDown(talk.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: TalkView(
            controller: talk,
            voiceRecorder: _Recorder(),
            ambientVoice: true,
            ambientRealtimeFactory: () => voice,
          ),
        ),
      );
      voice.reviewProviderEventsForTesting([_turn(transcript, logprobs)]);
      await tester.pump();
      return (voice, repository);
    }

    Future<void> pressCommandEnter(WidgetTester tester) async {
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pump();
    }

    testWidgets('holds a draft that needs review until its checkbox', (
      tester,
    ) async {
      final (voice, repository) = await review(tester, _request, _unsure);
      expect(find.text('Low confidence'), findsOneWidget);

      await pressCommandEnter(tester);

      expect(repository.sent, isEmpty);
      expect(voice.reviewAttested, isFalse);
      expect(voice.phase, AmbientRealtimeVoicePhase.review);
      expect(tester.widget<IconButton>(_sendButton).onPressed, isNull);

      tester.widget<Checkbox>(find.byType(Checkbox)).onChanged!(true);
      await tester.pump();
      expect(tester.widget<IconButton>(_sendButton).onPressed, isNotNull);
      await pressCommandEnter(tester);

      expect(voice.reviewDraft.confidenceBand, AmbientVoiceConfidenceBand.low);
      expect(repository.sent, [_request]);
    });

    testWidgets('sends a confident draft from Send alone', (tester) async {
      final (voice, repository) = await review(
        tester,
        '$_request ',
        _confident,
      );
      expect(find.byType(Checkbox), findsNothing);

      await pressCommandEnter(tester);

      expect(voice.reviewDraft.confidenceBand, AmbientVoiceConfidenceBand.high);
      expect(voice.reviewAttested, isTrue);
      expect(repository.sent, [_request]);
    });

    testWidgets('reviews a stopped draft again before sending it', (
      tester,
    ) async {
      final (voice, repository) = await review(tester, _request, _confident);
      await voice.cancel();
      await tester.pump();

      await pressCommandEnter(tester);

      expect(repository.sent, isEmpty);
      expect(voice.phase, AmbientRealtimeVoicePhase.review);
      expect(voice.confidenceBand, AmbientVoiceConfidenceBand.edited);
      expect(find.byType(Checkbox), findsOneWidget);
    });

    testWidgets('shows a finished answer as done when it cannot be spoken', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      final (voice, repository) = await review(tester, _request, _confident);

      await pressCommandEnter(tester);
      for (var frame = 0; frame < 4; frame += 1) {
        await tester.pump();
      }

      expect(repository.sent, [_request]);
      expect(find.text('Done'), findsOneWidget);
      expect(find.text('Not spoken'), findsOneWidget);
      expect(
        find.byTooltip('Asael could not play the answer aloud.'),
        findsOneWidget,
      );
      expect(
        find.bySemanticsLabel(
          RegExp(r'Asael could not play the answer aloud\. Asael destination'),
        ),
        findsOneWidget,
      );
      expect(find.text('Needs attention'), findsNothing);
      expect(voice.phase, AmbientRealtimeVoicePhase.stopped);
      expect(voice.errorMessage, isNull);
      semantics.dispose();
    });
  });

  group('Ambient Command focus', () {
    final macOS = TargetPlatformVariant.only(TargetPlatform.macOS);

    Future<_ListeningVoice> listening(
      WidgetTester tester, {
      ValueListenable<bool>? workspaceLocked,
    }) async {
      final voice = _ListeningVoice();
      final talk = TalkController(_Repository());
      addTearDown(talk.dispose);
      addTearDown(
        () => tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        ),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: TalkView(
            controller: talk,
            voiceRecorder: _Recorder(),
            ambientVoice: true,
            ambientRealtimeFactory: () => voice,
            workspaceLocked: workspaceLocked,
          ),
        ),
      );
      return voice;
    }

    Future<void> enter(WidgetTester tester, AppLifecycleState state) async {
      tester.binding.handleAppLifecycleStateChanged(state);
      await tester.pump();
    }

    testWidgets('keeps listening on macOS while another app has focus', (
      tester,
    ) async {
      final voice = await listening(tester);

      await enter(tester, AppLifecycleState.inactive);
      expect(voice.cancels, 0);

      await enter(tester, AppLifecycleState.hidden);
      expect(voice.cancels, 1);
    }, variant: macOS);

    testWidgets('stops listening when the workspace locks', (tester) async {
      final [first, second, engaged] = [
        for (final value in [false, false, true]) _Lock(value),
      ];
      for (final lock in [first, second, engaged]) {
        addTearDown(lock.dispose);
      }
      final voice = await listening(tester, workspaceLocked: first);
      final talk = tester.widget<TalkView>(find.byType(TalkView));
      Future<void> show(ValueListenable<bool> workspaceLocked) =>
          tester.pumpWidget(
            MaterialApp(
              home: TalkView(
                controller: talk.controller,
                voiceRecorder: talk.voiceRecorder,
                ambientVoice: true,
                ambientRealtimeFactory: talk.ambientRealtimeFactory,
                workspaceLocked: workspaceLocked,
              ),
            ),
          );

      first.value = true;
      await tester.pump();
      expect(voice.cancels, 1);

      voice.listening = true;
      await show(second);
      expect(voice.cancels, 1);
      expect(first.listened, isFalse);

      second.value = true;
      await tester.pump();
      expect(voice.cancels, 2);

      // A workspace that is already locked stops listening at once.
      voice.listening = true;
      await show(engaged);
      expect(voice.cancels, 3);

      await tester.pumpWidget(const SizedBox());
      expect(engaged.listened, isFalse);
    }, variant: macOS);

    testWidgets('stops listening on focus loss away from macOS', (
      tester,
    ) async {
      final voice = await listening(tester);

      await enter(tester, AppLifecycleState.inactive);
      expect(voice.cancels, 1);
    });

    testWidgets('stops a voice draft when the main window loses focus', (
      tester,
    ) async {
      final recorder = _CountingRecorder();
      final talk = TalkController(_Repository());
      addTearDown(talk.dispose);
      addTearDown(
        () => tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        ),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: TalkView(controller: talk, voiceRecorder: recorder),
        ),
      );

      await enter(tester, AppLifecycleState.inactive);
      expect(recorder.cancels, 1);
    }, variant: macOS);
  });

  group('Ambient Command consent', () {
    /// Lets the stored agreement load and the text transitions finish.
    Future<void> settle(WidgetTester tester) async {
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
    }

    Future<List<AmbientRealtimeVoicePhase>> open(
      WidgetTester tester, {
      AmbientVoiceConsent? consent,
      bool withConsent = true,
    }) async {
      final voice = _voice();
      final phases = <AmbientRealtimeVoicePhase>[];
      voice.addListener(() => phases.add(voice.phase));
      final talk = TalkController(_Repository());
      addTearDown(talk.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: TalkView(
            controller: talk,
            voiceRecorder: _Recorder(),
            quickEntry: true,
            ambientVoice: true,
            ambientRealtimeFactory: () => voice,
            ambientConsent: withConsent ? consent ?? _Consent() : null,
          ),
        ),
      );
      await settle(tester);
      return phases;
    }

    Future<void> pressMicrophone(WidgetTester tester) async {
      tester.widget<IconButton>(_microphone).onPressed!();
      await settle(tester);
    }

    String microphoneTooltip(WidgetTester tester) =>
        tester.widget<IconButton>(_microphone).tooltip!;

    testWidgets('opens without listening and names OpenAI first', (
      tester,
    ) async {
      final phases = await open(tester);

      expect(phases, isEmpty);
      expect(find.text(_notice), findsOneWidget);
      expect(microphoneTooltip(tester), 'Agree and start listening');
    });

    testWidgets('records the agreement on the first press, then starts', (
      tester,
    ) async {
      final consent = _Consent();
      final phases = await open(tester, consent: consent);

      await pressMicrophone(tester);

      expect(consent.accepts, 1);
      expect(phases, contains(AmbientRealtimeVoicePhase.requestingPermission));
    });

    testWidgets('an agreement already recorded skips the notice', (
      tester,
    ) async {
      final consent = _Consent(agreed: true);
      final phases = await open(tester, consent: consent);

      expect(phases, isEmpty);
      expect(find.text(_notice), findsNothing);
      expect(find.text('Say what you want Asael to do.'), findsOneWidget);
      expect(microphoneTooltip(tester), 'Speak to Asael');

      await pressMicrophone(tester);

      expect(consent.accepts, 0);
      expect(phases, contains(AmbientRealtimeVoicePhase.requestingPermission));
    });

    testWidgets('an unsaved agreement keeps the microphone off', (
      tester,
    ) async {
      final consent = _Consent(failSave: true);
      final phases = await open(tester, consent: consent);

      await pressMicrophone(tester);

      expect(consent.accepts, 1);
      expect(phases, isEmpty);
      expect(
        find.text(
          'Asael could not save your agreement, so the microphone stayed '
          'off. Try again.',
        ),
        findsOneWidget,
      );

      await pressMicrophone(tester);

      expect(consent.accepts, 1);
      expect(find.text(_notice), findsOneWidget);

      await pressMicrophone(tester);

      expect(consent.accepts, 2);
      expect(phases, isEmpty);
    });

    testWidgets('without a signed-in owner nothing listens', (tester) async {
      final phases = await open(tester, withConsent: false);

      expect(find.text(_notice), findsOneWidget);

      await pressMicrophone(tester);

      expect(phases, isEmpty);
      expect(
        find.textContaining('could not save your agreement'),
        findsOneWidget,
      );
    });

    /// One mounted Ambient Command view whose owner can change.
    Future<
      (
        List<AmbientRealtimeVoicePhase>,
        Future<void> Function(AmbientVoiceConsent),
      )
    >
    owned(WidgetTester tester, AmbientVoiceConsent first) async {
      final voice = _voice();
      final phases = <AmbientRealtimeVoicePhase>[];
      voice.addListener(() => phases.add(voice.phase));
      final talk = TalkController(_Repository());
      addTearDown(talk.dispose);
      Future<void> show(AmbientVoiceConsent consent) async {
        await tester.pumpWidget(
          MaterialApp(
            home: TalkView(
              controller: talk,
              voiceRecorder: _Recorder(),
              ambientVoice: true,
              ambientRealtimeFactory: () => voice,
              ambientConsent: consent,
            ),
          ),
        );
        await settle(tester);
      }

      await show(first);
      return (phases, show);
    }

    testWidgets('another owner is asked again', (tester) async {
      final second = _Consent();
      final (phases, show) = await owned(tester, _Consent(agreed: true));
      expect(find.text(_notice), findsNothing);

      await show(second);

      expect(find.text(_notice), findsOneWidget);
      await pressMicrophone(tester);
      expect(second.accepts, 1);
      expect(phases, contains(AmbientRealtimeVoicePhase.requestingPermission));
    });

    testWidgets('a late answer for the previous owner is not reused', (
      tester,
    ) async {
      final read = Completer<void>();
      final (phases, show) = await owned(
        tester,
        _Consent(agreed: true, held: read),
      );
      await show(_Consent());

      read.complete();
      await settle(tester);

      expect(find.text(_notice), findsOneWidget);
      expect(phases, isEmpty);
    });

    testWidgets('an agreement saved as the owner changed starts nothing', (
      tester,
    ) async {
      final save = Completer<void>();
      final first = _Consent(held: save);
      final (phases, show) = await owned(tester, first);
      await pressMicrophone(tester);
      expect(first.accepts, 1);
      await show(_Consent());

      save.complete();
      await settle(tester);

      expect(phases, isEmpty);
      expect(find.text(_notice), findsOneWidget);
    });

    test('one owner keeps one agreement on this device', () async {
      final values = _Values();
      final store = SecureSessionStore.withStorage(values);
      SecureAmbientVoiceConsent consent(
        SecureSessionStore store,
        String tenantId,
        String actorId,
      ) => SecureAmbientVoiceConsent(
        store,
        tenantId: tenantId,
        actorId: actorId,
      );
      final owner = consent(store, 'tenant-a', 'owner-a');

      expect(owner, consent(store, 'tenant-a', 'owner-a'));
      expect(owner.hashCode, consent(store, 'tenant-a', 'owner-a').hashCode);
      for (final other in [
        consent(store, 'tenant-b', 'owner-a'),
        consent(store, 'tenant-a', 'owner-b'),
        consent(
          SecureSessionStore.withStorage(_Values()),
          'tenant-a',
          'owner-a',
        ),
      ]) {
        expect(owner, isNot(other));
      }

      expect(await owner.accepted(), isFalse);
      await owner.accept();
      expect(await consent(store, 'tenant-a', 'owner-a').accepted(), isTrue);
      expect(await consent(store, 'tenant-a', 'owner-b').accepted(), isFalse);
      expect(values.values.values, [
        SecureSessionStore.ambientVoiceConsentTerms,
      ]);
    });

    test('the macOS host keeps Ambient Command off until it is turned on', () {
      final host = File('macos/Runner/AppDelegate.swift').readAsStringSync();

      expect(host, contains('private var ambientVoiceAvailable = false\n'));
      expect(
        host,
        contains(
          '  private func savedAmbientVoiceAvailability() -> Bool {\n'
          '    UserDefaults.standard.bool(forKey: '
          'Self.ambientVoiceAvailabilityDefaultsKey)\n'
          '  }',
        ),
      );
    });
  });
}
