import 'dart:typed_data';

import '../../core/network/api_client.dart';
import '../../generated/native_contract.g.dart';
import 'talk.dart';

class ApiTalkRepository implements TalkRepository {
  const ApiTalkRepository(this.api);
  final ApiClient api;

  @override
  Future<void> cancelRun(String runId) async {
    await api.deleteJson(
      NativePaths.evidenceRunCancel(runId),
      headers: {
        'idempotency-key':
            'conversation-cancel-$runId-${DateTime.now().microsecondsSinceEpoch}',
      },
    );
  }

  @override
  Future<TalkWorkflowSnapshot> inspectWorkflow(String workflowId) async {
    final json = await api.getJson(
      NativePaths.evidenceWorkflow(workflowId),
      query: const {'view': 'status'},
    );
    final snapshot = TalkWorkflowSnapshot.fromJson(json);
    if (snapshot.id != workflowId) {
      throw StateError('The workflow projection did not match the request.');
    }
    return snapshot;
  }

  @override
  Future<TalkRunInspection> inspectRun(String runId) async {
    final inspection = TalkRunInspection.fromJson(
      await api.getJson(NativePaths.evidenceRun(runId)),
    );
    if (inspection.runId != runId) {
      throw StateError('The run projection did not match the request.');
    }
    return inspection;
  }

  @override
  Stream<SseEvent> send({
    required String message,
    String? threadId,
    String mode = 'orchestrate',
    String strategy = 'auto',
  }) async* {
    final body = await api.postStream(
      NativePaths.conversationSend,
      data: {
        'message': message,
        'threadId': ?threadId,
        'mode': mode,
        'strategy': strategy,
        'requestId': 'flutter-${DateTime.now().microsecondsSinceEpoch}',
      },
      headers: const {'Accept': 'text/event-stream'},
    );
    yield* parseSse(body.stream);
  }

  @override
  Future<String> transcribeVoice(Uint8List bytes) async {
    final json = await api.postMultipart(
      NativePaths.captureTranscribe,
      fields: const {},
      bytes: bytes,
      filename: 'voice-draft.m4a',
      contentType: 'audio/mp4',
      fileField: 'audio',
    );
    final text = json['text'];
    if (text is! String || text.trim().isEmpty) {
      throw StateError('The voice draft did not contain transcribable speech.');
    }
    return text;
  }
}
