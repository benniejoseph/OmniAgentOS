import 'package:asael/features/ambient_voice/realtime_voice_controller.dart';
import 'package:asael/features/talk/talk.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

const _sessionId = '8f0c2c64-4b1e-4c47-9a53-3f4e2b7f9d10';
const _conversationId = '0b8f6c3e-9d2a-4f1b-8e7c-5a4d3c2b1a09';

AmbientVoiceDraft _draft({
  String? sessionId = _sessionId,
  String? conversationId = _conversationId,
  bool reviewAttested = true,
  double? confidenceMean = 0.82,
  double? confidenceMinimum = 0.41,
  int confidenceSampleCount = 24,
}) => AmbientVoiceDraft(
  text: 'Email the team the launch summary',
  sessionId: sessionId,
  conversationId: conversationId,
  confidenceBand: AmbientVoiceConfidenceBand.high,
  confidenceMean: confidenceMean,
  confidenceMinimum: confidenceMinimum,
  confidenceSampleCount: confidenceSampleCount,
  reviewRequired: false,
  reviewAttested: reviewAttested,
  turnCount: 1,
  reconnectCount: 0,
);

class _PlainTalkRepository implements TalkRepository {
  final plainSends = <({String message, String? threadId})>[];

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
    plainSends.add((message: message, threadId: threadId));
    yield const SseEvent(
      event: 'done',
      data: {'type': 'done', 'response': 'Ready'},
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

class _VoiceTalkRepository extends _PlainTalkRepository
    implements TalkVoiceCommandRepository {
  final voiceInputs = <TalkVoiceInput>[];
  var failNext = false;

  @override
  Stream<SseEvent> sendVoiceCommand({
    required String message,
    required TalkVoiceInput voiceInput,
    List<TalkCommandContextReference> contextReferences = const [],
    String mode = 'orchestrate',
    String strategy = 'auto',
    TalkExecutionTarget executionTarget = TalkExecutionTarget.agent,
    String? agentId,
    TalkCommandModelSelection? modelSelection,
  }) async* {
    voiceInputs.add(voiceInput);
    if (failNext) {
      failNext = false;
      throw StateError('offline');
    }
    yield const SseEvent(
      event: 'done',
      data: {'type': 'done', 'response': 'Waiting for your approval'},
    );
  }
}

void main() {
  test('declares voice only for an attested draft from a minted session', () {
    expect(
      TalkVoiceInput.fromReviewedDraft(_draft(reviewAttested: false)),
      isNull,
    );
    expect(TalkVoiceInput.fromReviewedDraft(_draft(sessionId: null)), isNull);
    expect(
      TalkVoiceInput.fromReviewedDraft(_draft(sessionId: 'session-1')),
      isNull,
    );
    expect(
      TalkVoiceInput.fromReviewedDraft(_draft(conversationId: 'thread-1')),
      isNull,
    );
    expect(TalkVoiceInput.fromReviewedDraft(_draft()), isNotNull);
  });

  test('serializes the v30 declaration inside its contract bounds', () {
    expect(TalkVoiceInput.fromReviewedDraft(_draft())!.toRequestJson(), {
      'schemaVersion': 1,
      'source': 'realtime_voice',
      'sessionId': _sessionId,
      'conversationId': _conversationId,
      'provider': 'openai',
      'confidenceBand': 'high',
      'confidenceMean': 0.82,
      'confidenceMinimum': 0.41,
      'confidenceSampleCount': 24,
      'reviewMethod': 'send_button',
      'reviewAttested': true,
    });

    final bounded = TalkVoiceInput.fromReviewedDraft(
      _draft(
        confidenceMean: 1.4,
        confidenceMinimum: double.nan,
        confidenceSampleCount: 12000,
      ),
    )!.toRequestJson();
    expect(bounded['confidenceMean'], 1.0);
    expect(bounded.containsKey('confidenceMinimum'), isFalse);
    expect(bounded['confidenceSampleCount'], 10000);
  });

  test(
    'sends and retries a reviewed voice command with its declaration',
    () async {
      final repository = _VoiceTalkRepository()..failNext = true;
      final controller = TalkController(repository);
      final voiceInput = TalkVoiceInput.fromReviewedDraft(_draft())!;

      await controller.send(
        'Email the team the launch summary',
        voiceInput: voiceInput,
      );
      expect(controller.canRetry, isTrue);
      await controller.retryLast();

      expect(repository.voiceInputs, [voiceInput, voiceInput]);
      expect(repository.plainSends, isEmpty);
      expect(controller.messages.last.text, 'Waiting for your approval');
    },
  );

  test('sends voice unmarked on its conversation when the repository cannot declare it', () async {
    final repository = _PlainTalkRepository();
    final controller = TalkController(repository)
      ..adoptConversationThreadId(_conversationId);

    await controller.send(
      'Email the team the launch summary',
      voiceInput: TalkVoiceInput.fromReviewedDraft(_draft()),
    );

    expect(repository.plainSends, [
      (message: 'Email the team the launch summary', threadId: _conversationId),
    ]);
  });
}
