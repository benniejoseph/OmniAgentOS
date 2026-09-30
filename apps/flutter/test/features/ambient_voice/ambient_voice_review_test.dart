import 'package:asael/core/network/api_client.dart';
import 'package:asael/core/storage/secure_session_store.dart';
import 'package:asael/features/ambient_voice/ambient_voice_view.dart';
import 'package:asael/features/ambient_voice/realtime_voice_controller.dart';
import 'package:asael/features/talk/talk.dart';
import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

class _Api extends Fake implements ApiClient {}

class _Sessions extends Fake implements SecureSessionStore {}

class _Player extends Fake implements AudioPlayer {}

class _Recorder extends Fake implements VoiceDraftRecorder {}

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

/// A finished transcription turn whose tokens carry these log probabilities.
Map<String, Object?> _turn(String transcript, List<double> logprobs) => {
  'type': 'conversation.item.input_audio_transcription.completed',
  'item_id': 'item_1',
  'transcript': transcript,
  'logprobs': [
    for (final logprob in logprobs) {'logprob': logprob},
  ],
};

const _confident = [-.05, -.1];
const _unsure = [-1.2, -3.0];
const _request = 'Book the flight to Lisbon';
final _sendButton = find.widgetWithIcon(IconButton, Icons.arrow_upward_rounded);

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
  });
}
