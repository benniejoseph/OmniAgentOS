import 'dart:async';
import 'dart:convert';

import 'package:asael/core/network/api_client.dart';
import 'package:asael/features/ambient_voice/voice_conversation_controller.dart';
import 'package:asael/generated/native_contract.g.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'voice_provider_configuration_fixture.dart';

const _sessionId = '11111111-1111-4111-8111-111111111111';
const _conversationId = '22222222-2222-4222-8222-222222222222';
const _turnId = '33333333-3333-4333-8333-333333333333';
const _context = {
  'mode': 'orchestrate',
  'agentId': 'atlas',
  'contextScope': 'session',
  'contextReferences': <Object>[],
  'computerUseTarget': 'local_macos',
};

class _Track extends Fake implements MediaStreamTrack {
  @override
  String get kind => 'audio';
  @override
  bool get enabled => _enabled;
  bool _enabled = true;
  bool failDisable = false;
  @override
  set enabled(bool value) {
    if (!value && failDisable) throw StateError('Synthetic platform failure');
    _enabled = value;
  }

  bool stopped = false;
  @override
  Future<void> stop() async => stopped = true;
}

class _Stream extends Fake implements MediaStream {
  final track = _Track();
  bool disposed = false;
  @override
  List<MediaStreamTrack> getAudioTracks() => [track];
  @override
  List<MediaStreamTrack> getTracks() => [track];
  @override
  Future<void> dispose() async => disposed = true;
}

class _Channel extends Fake implements RTCDataChannel {
  @override
  Function(RTCDataChannelMessage)? onMessage;
  @override
  Function(RTCDataChannelState)? onDataChannelState;
  @override
  RTCDataChannelState state = RTCDataChannelState.RTCDataChannelOpen;
  final sent = <Map<String, dynamic>>[];
  bool closed = false;
  void emit(Map<String, dynamic> event) =>
      onMessage?.call(RTCDataChannelMessage(jsonEncode(event)));
  @override
  Future<void> send(RTCDataChannelMessage message) async =>
      sent.add(jsonDecode(message.text) as Map<String, dynamic>);
  @override
  Future<void> close() async {
    closed = true;
    state = RTCDataChannelState.RTCDataChannelClosed;
  }
}

class _Sender extends Fake implements RTCRtpSender {}

class _Peer extends Fake implements RTCPeerConnection {
  final channel = _Channel();
  final remote = _Track();
  final connected = Completer<void>();
  final trackAdded = Completer<void>();
  final channelCreated = Completer<void>();
  Completer<RTCRtpSender>? trackWaiter;
  Completer<RTCDataChannel>? channelWaiter;
  void Function()? afterSdp;
  bool closed = false, disposed = false;
  @override
  Function(RTCTrackEvent)? onTrack;
  @override
  Function(RTCPeerConnectionState)? onConnectionState;
  @override
  RTCIceGatheringState get iceGatheringState =>
      RTCIceGatheringState.RTCIceGatheringStateComplete;
  @override
  Future<RTCRtpSender> addTrack(
    MediaStreamTrack track, [
    MediaStream? stream,
  ]) async {
    trackAdded.complete();
    return trackWaiter?.future ?? _Sender();
  }

  @override
  Future<RTCDataChannel> createDataChannel(
    String label,
    RTCDataChannelInit init,
  ) async {
    channelCreated.complete();
    return channelWaiter?.future ?? channel;
  }

  @override
  Future<RTCSessionDescription> createOffer([
    Map<String, dynamic>? constraints,
  ]) async => RTCSessionDescription('v=0\r\n', 'offer');
  @override
  Future<void> setLocalDescription(RTCSessionDescription description) async {}
  @override
  Future<RTCSessionDescription?> getLocalDescription() async =>
      RTCSessionDescription('v=0\r\n', 'offer');
  @override
  Future<void> setRemoteDescription(RTCSessionDescription description) async {
    onTrack?.call(RTCTrackEvent(streams: [], track: remote));
    afterSdp?.call();
    connected.complete();
  }

  @override
  Future<void> close() async => closed = true;
  @override
  Future<void> dispose() async => disposed = true;
}

class _Api extends Fake implements ApiClient {
  final requests = <Map<String, dynamic>>[];
  final finishes = <Map<String, dynamic>>[];
  void Function(Map<String, dynamic>)? editCredential;
  final approvalRequests = <Map<String, dynamic>>[];
  Completer<Map<String, dynamic>>? approvalDecisionWaiter;
  Completer<Map<String, dynamic>>? decisionCaptionWaiter;
  Completer<Map<String, dynamic>>? presentationWaiter;
  Completer<Map<String, dynamic>>? prepareWaiter;
  Duration presentationLifetime = const Duration(minutes: 1);
  String presentationActionHash = 'a' * 64;
  int presentationCount = 0;
  String? lastPresentationId;
  bool presentationFails = false;
  @override
  Future<Map<String, dynamic>> postJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    if (path == NativePaths.approvalsDecide('execution') ||
        path == NativePaths.approvalsDecide('execution-2')) {
      approvalRequests.add(data!);
      if (data['voiceReview'] case final Map review) {
        if (review['operation'] == 'present' && presentationFails) {
          throw StateError('Synthetic review failure');
        }
        if (review['operation'] == 'present') {
          presentationCount++;
          lastPresentationId =
              '44444444-4444-4444-8444-${presentationCount.toString().padLeft(12, '0')}';
        }
        final result = <String, dynamic>{
          'schemaVersion': 1,
          'actionSha256': review['operation'] == 'present'
              ? presentationActionHash
              : 'a' * 64,
          'approval': {
            'id': path.split('/').last,
            'toolId': 'test.send',
            'title': 'Send reviewed message',
            'input': {
              'recipient': 'client@example.test',
              'message': 'Exact text',
            },
            'canApprove': true,
            'canReject': true,
          },
          if (review['operation'] == 'present') ...{
            'presentationId': lastPresentationId,
            'expiresAt': DateTime.now()
                .add(presentationLifetime)
                .toIso8601String(),
          },
        };
        if (review['operation'] == 'prepare' && prepareWaiter != null) {
          return prepareWaiter!.future;
        }
        return review['operation'] == 'present' && presentationWaiter != null
            ? presentationWaiter!.future
            : result;
      }
      return approvalDecisionWaiter?.future ??
          {
            'record': {
              'id': path.split('/').last,
              'toolId': 'test.send',
              'status': data['decision'] == 'reject' ? 'rejected' : 'executing',
              'approvalDecision': data['decision'] == 'reject'
                  ? 'rejected'
                  : 'approved',
            },
          };
    }
    if (path == NativePaths.voiceConversationTurns) {
      if (data?['turns'] case final List turns
          when turns.isNotEmpty &&
              (turns.first as Map)['itemId'] == 'decision' &&
              decisionCaptionWaiter != null) {
        return decisionCaptionWaiter!.future;
      }
      return {
        'recorded': true,
        'turnIds': [_turnId],
      };
    }
    expect(path, NativePaths.voiceConversationSessionStart);
    requests.add(data!);
    final credential = <String, dynamic>{
      'schemaVersion': 2,
      'provider': 'openai',
      'transportUrl': 'https://api.openai.com/v1/realtime/calls',
      'voice': 'cedar',
      'turnDetection': 'server_vad',
      'audioRetention': 'not_stored_by_asael',
      'transcriptRetention': 'conversation_history',
      'sessionId': _sessionId,
      'conversationId': _conversationId,
      'clientSecret': 'ek_test_fixture_only',
      'agentName': 'ATLAS',
      'model': 'gpt-realtime',
      'commandContext': cloneVoiceJson(_context),
      'providerConfiguration': providerExpectationFixture(),
      'expiresAt': DateTime.now()
          .add(const Duration(minutes: 5))
          .toIso8601String(),
    };
    editCredential?.call(credential);
    return credential;
  }

  @override
  Future<Map<String, dynamic>> patchJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    finishes.add(data!);
    return {'recorded': true};
  }
}

class _Harness {
  _Harness({Duration timeout = const Duration(seconds: 1)}) {
    final dio = Dio();
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          providerCalls++;
          handler.resolve(
            Response<String>(
              requestOptions: options,
              data: 'v=0\r\n',
              statusCode: 201,
            ),
          );
        },
      ),
    );
    voice = VoiceConversationController(
      api: api,
      providerDio: dio,
      microphoneFactory: () async => microphoneWaiter?.future ?? stream,
      peerFactory: () async {
        peerCreations++;
        return peer;
      },
      providerConfigurationTimeout: timeout,
    );
  }
  final api = _Api();
  _Stream stream = _Stream();
  Completer<MediaStream>? microphoneWaiter;
  _Peer peer = _Peer();
  late final VoiceConversationController voice;
  int providerCalls = 0, peerCreations = 0, delegations = 0;
  Map<String, dynamic>? delegatedContext;
  final delegatedInputs = <({String request, String itemId, String caption})>[];
  Map<String, dynamic>? delegatedResult;
  VoiceWorkReader? readWork;
  Future<void> start() => voice.start(
    consentAccepted: true,
    context: Map<String, dynamic>.from(_context),
    readWork: readWork,
    delegate:
        (
          request,
          turn,
          session,
          conversation,
          pinned,
          inputItem,
          caption,
        ) async {
          delegations++;
          delegatedContext = pinned;
          delegatedInputs.add((
            request: request,
            itemId: inputItem,
            caption: caption,
          ));
          return delegatedResult ??
              {'status': 'completed', 'message': 'Synthetic completion'};
        },
  );
  void acknowledge() => peer.channel.emit({
    'type': 'session.created',
    'session': providerSessionFixture(),
  });
  Future<void> close() async {
    await voice.end();
    await Future<void>.delayed(Duration.zero);
    voice.dispose();
  }
}

Future<void> flush() async {
  for (var i = 0; i < 5; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  Future<_Harness> waitingApproval({VoiceWorkReader? readWork}) async {
    final h = _Harness();
    addTearDown(h.close);
    h.readWork = readWork;
    h.delegatedResult = {
      'status': 'waiting_approval',
      'approvalId': 'execution',
      'runId': '33333333-3333-4333-8333-333333333333',
    };
    h.peer.afterSdp = h.acknowledge;
    await h.start();
    final emit = h.peer.channel.emit;
    emit({'type': 'input_audio_buffer.speech_started'});
    emit({'type': 'input_audio_buffer.committed', 'item_id': 'request'});
    emit({
      'type': 'conversation.item.input_audio_transcription.completed',
      'item_id': 'request',
      'transcript': 'Send the reviewed message',
    });
    emit({'type': 'input_audio_buffer.speech_stopped'});
    emit({
      'type': 'response.created',
      'response': {'id': 'response_request'},
    });
    emit({
      'type': 'response.function_call_arguments.done',
      'response_id': 'response_request',
      'call_id': 'call_request',
      'name': 'ask_asael',
      'arguments': jsonEncode({'request': 'Send the reviewed message'}),
    });
    await flush();
    return h;
  }

  void speak(_Harness h, String text, {String item = 'decision'}) {
    h.peer.channel.emit({'type': 'input_audio_buffer.speech_started'});
    h.peer.channel.emit({
      'type': 'input_audio_buffer.committed',
      'item_id': item,
    });
    h.peer.channel.emit({
      'type': 'conversation.item.input_audio_transcription.completed',
      'item_id': item,
      'transcript': text,
    });
    h.peer.channel.emit({'type': 'input_audio_buffer.speech_stopped'});
  }

  test('status follow-ups inspect the admitted workflow without redispatch', () async {
    final h = _Harness();
    addTearDown(h.close);
    var reads = 0;
    var paused = false;
    h.delegatedResult = {
      'status': 'accepted',
      'runId': '33333333-3333-4333-8333-333333333333',
      'workflowId': 'wf_report',
      'message': 'Research queued',
    };
    h.readWork = (work, thread) async {
      expect(work['workflowId'], 'wf_report');
      expect(thread, _conversationId);
      reads++;
      return {
        ...work,
        'status': paused ? 'paused' : 'running',
        'currentStep': 'write_report',
        if (paused) 'failureReason': 'Report timed out',
        'message': paused ? 'The report is paused after a timeout.' : 'Writing the report.',
      };
    };
    h.peer.afterSdp = h.acknowledge;
    await h.start();
    speak(h, 'Research the topic', item: 'research');
    h.peer.channel.emit({'type': 'response.created', 'response': {'id': 'research_response'}});
    h.peer.channel.emit({
      'type': 'response.function_call_arguments.done', 'response_id': 'research_response',
      'call_id': 'research_call', 'name': 'ask_asael', 'arguments': jsonEncode({'request': 'Research the topic'}),
    });
    await flush();
    expect(h.delegations, 1);
    for (final callId in ['inspect_running', 'inspect_paused']) {
      paused = callId == 'inspect_paused';
      h.peer.channel.emit({
        'type': 'response.function_call_arguments.done', 'response_id': callId,
        'call_id': callId, 'name': 'ask_asael', 'arguments': jsonEncode({'request': 'What is the task doing?'}),
      });
      await flush();
      final output = h.peer.channel.sent.map((e) => e['item']).whereType<Map>()
          .lastWhere((item) => item['call_id'] == callId);
      final result = jsonDecode(output['output'] as String) as Map;
      expect(result['status'], paused ? 'paused' : 'running');
      expect(result['currentStep'], 'write_report');
      expect(result['requestNotDispatched'], true);
      if (paused) expect(result['failureReason'], 'Report timed out');
    }
    expect(reads, 2);
    expect(h.delegations, 1);
    expect(h.voice.workStatus, 'paused');
  });

  test(
    'misheard approval stays paused across polling and requires fresh review',
    () async {
      var reads = 0;
      final h = await waitingApproval(
        readWork: (work, _) async {
          reads++;
          return {...work, 'message': 'Review the pending action'};
        },
      );
      await h.voice.markVoiceApprovalPresented(h.voice.voiceApprovalReview!);
      final firstPresentationId = h.api.lastPresentationId;
      speak(h, 'aprovd');
      await flush();
      expect(h.voice.spokenReviewPhase, SpokenReviewPhase.retryRequired);
      final reason = h.voice.verbalApprovalNotice;
      expect(reason, contains('No decision was recorded'));
      expect(reason, contains('Choose Review again'));
      expect(
        h.api.approvalRequests.where((r) => r.containsKey('decision')),
        isEmpty,
      );
      expect(
        h.peer.channel.sent.any(
          (event) =>
              jsonEncode(event).contains('retryRequired') &&
              jsonEncode(event).contains('No decision was recorded'),
        ),
        isTrue,
      );
      await Future<void>.delayed(const Duration(milliseconds: 4100));
      expect(reads, greaterThan(0));
      expect(h.voice.workNotice, reason);
      h.peer.channel.emit({
        'type': 'response.function_call_arguments.done',
        'response_id': 'ask_after_misheard',
        'call_id': 'ask_after_misheard',
        'name': 'ask_asael',
        'arguments': jsonEncode({'request': 'Continue the task'}),
      });
      await flush();
      final result = h.peer.channel.sent.lastWhere(
        (event) => (event['item'] as Map?)?['call_id'] == 'ask_after_misheard',
      );
      final output = jsonDecode(result['item']['output'] as String) as Map;
      expect(output['status'], 'waiting_approval');
      expect(output['spokenReviewPhase'], 'retryRequired');
      expect(output['message'], reason);
      expect(h.delegations, 1);
      speak(h, 'yes', item: 'stale-approval');
      await flush();
      expect(h.voice.workNotice, reason);
      final oldReview = h.voice.voiceApprovalReview!;
      h.voice.refreshSpokenApprovalReview();
      await flush();
      await h.voice.markVoiceApprovalPresented(oldReview);
      expect(h.voice.spokenReviewPhase, SpokenReviewPhase.awaitingPresentation);
      await h.voice.markVoiceApprovalPresented(h.voice.voiceApprovalReview!);
      speak(h, 'approve this action', item: 'fresh-approval');
      await flush();
      expect(
        h.api.approvalRequests.where((r) => r.containsKey('decision')),
        hasLength(1),
      );
      expect(
        h.api.approvalRequests.last['voiceApproval']['userInputItemId'],
        'fresh-approval',
      );
      expect(
        h.api.approvalRequests.last['voiceApproval']['presentationId'],
        h.api.lastPresentationId,
      );
      expect(h.api.lastPresentationId, isNot(firstPresentationId));
      expect(
        h.api.approvalRequests.last['voiceApproval']['sessionId'],
        _sessionId,
      );
      expect(
        h.api.approvalRequests.last['voiceApproval']['conversationId'],
        _conversationId,
      );
      expect(h.voice.spokenReviewPhase, SpokenReviewPhase.recorded);
    },
  );

  test('old preparation cannot replace a refreshed review', () async {
    final h = await waitingApproval();
    await h.voice.markVoiceApprovalPresented(h.voice.voiceApprovalReview!);
    final old = Completer<Map<String, dynamic>>();
    h.api.prepareWaiter = old;
    h.voice.refreshSpokenApprovalReview();
    await flush();
    expect(h.voice.spokenReviewPhase, SpokenReviewPhase.preparing);
    h.voice.setMuted(true);
    h.voice.setMuted(false);
    expect(h.voice.spokenReviewPhase, SpokenReviewPhase.retryRequired);
    h.api.prepareWaiter = null;
    h.voice.refreshSpokenApprovalReview();
    await flush();
    final fresh = h.voice.voiceApprovalReview;
    old.complete({
      'schemaVersion': 1,
      'actionSha256': 'b' * 64,
      'approval': {
        'id': 'execution',
        'title': 'Old action',
        'input': <String, dynamic>{},
      },
    });
    await flush();
    expect(identical(h.voice.voiceApprovalReview, fresh), isTrue);
    expect(h.voice.voiceApprovalReview!['actionSha256'], 'a' * 64);
  });

  test(
    'a late presentation cannot arm another execution or a replacement call',
    () async {
      var nextAction = false;
      final h = await waitingApproval(
        readWork: (work, _) async =>
            nextAction ? {...work, 'approvalId': 'execution-2'} : work,
      );
      final old = Completer<Map<String, dynamic>>();
      h.api.presentationWaiter = old;
      final pending = h.voice.markVoiceApprovalPresented(
        h.voice.voiceApprovalReview!,
      );
      await flush();
      final nextReviewReady = Completer<void>();
      void observeNextReview() {
        if (h.voice.approvalId == 'execution-2' &&
            h.voice.spokenReviewPhase ==
                SpokenReviewPhase.awaitingPresentation &&
            !nextReviewReady.isCompleted) {
          nextReviewReady.complete();
        }
      }

      // A wall-clock delay does not establish that the poll and asynchronous
      // review preparation finished. Keep the old presentation unresolved until
      // the exact replacement review is observable under the existing timeout.
      h.voice.addListener(observeNextReview);
      try {
        nextAction = true;
        await nextReviewReady.future;
      } finally {
        h.voice.removeListener(observeNextReview);
      }
      expect(h.voice.approvalId, 'execution-2');
      final fresh = h.voice.voiceApprovalReview;
      old.complete({
        'presentationId': '44444444-4444-4444-8444-444444444444',
        'actionSha256': 'a' * 64,
        'expiresAt': DateTime.now()
            .add(const Duration(minutes: 1))
            .toIso8601String(),
      });
      await pending;
      expect(identical(h.voice.voiceApprovalReview, fresh), isTrue);
      expect(h.voice.spokenReviewPhase, SpokenReviewPhase.awaitingPresentation);

      final previousCall = Completer<Map<String, dynamic>>();
      h.api.presentationWaiter = previousCall;
      final previousPending = h.voice.markVoiceApprovalPresented(fresh!);
      await flush();
      await h.voice.end();
      h.peer = _Peer();
      h.stream = _Stream();
      h.peer.afterSdp = h.acknowledge;
      await h.start();
      previousCall.complete({
        'presentationId': '44444444-4444-4444-8444-444444444444',
        'actionSha256': 'a' * 64,
        'expiresAt': DateTime.now()
            .add(const Duration(minutes: 1))
            .toIso8601String(),
      });
      await previousPending;
      expect(h.voice.spokenReviewPhase, SpokenReviewPhase.none);
      expect(h.voice.voiceApprovalReview, isNull);
      expect(
        h.api.approvalRequests.where((r) => r.containsKey('decision')),
        isEmpty,
      );
    },
  );

  test(
    'intervening speech invalidates presentation and blocks late readiness',
    () async {
      final h = await waitingApproval();
      h.api.presentationWaiter = Completer();
      final pending = h.voice.markVoiceApprovalPresented(
        h.voice.voiceApprovalReview!,
      );
      await flush();
      speak(h, 'approve this action', item: 'during-presentation');
      expect(h.voice.spokenReviewPhase, SpokenReviewPhase.retryRequired);
      expect(
        h.voice.verbalApprovalNotice,
        contains('before the review was ready'),
      );
      h.api.presentationWaiter!.complete({
        'presentationId': '44444444-4444-4444-8444-444444444444',
        'actionSha256': 'a' * 64,
        'expiresAt': DateTime.now()
            .add(const Duration(minutes: 1))
            .toIso8601String(),
      });
      await pending;
      speak(h, 'yes', item: 'late-yes');
      await flush();
      expect(h.voice.spokenReviewPhase, SpokenReviewPhase.retryRequired);
      expect(
        h.api.approvalRequests.where((r) => r.containsKey('decision')),
        isEmpty,
      );
    },
  );

  test(
    'expiry and wrong action receipts explain why a fresh review is needed',
    () async {
      for (final wrongAction in [false, true]) {
        final h = await waitingApproval();
        if (wrongAction) {
          h.api.presentationActionHash = 'b' * 64;
        } else {
          h.api.presentationLifetime = const Duration(milliseconds: 40);
        }
        await h.voice.markVoiceApprovalPresented(h.voice.voiceApprovalReview!);
        await Future<void>.delayed(const Duration(milliseconds: 60));
        expect(h.voice.spokenReviewPhase, SpokenReviewPhase.retryRequired);
        expect(
          h.voice.verbalApprovalNotice,
          contains(wrongAction ? 'could not be made ready' : 'expired'),
        );
        speak(h, 'yes');
        await flush();
        expect(
          h.api.approvalRequests.where((r) => r.containsKey('decision')),
          isEmpty,
        );
      }
    },
  );

  test('an unsaved caption never sends a decision or claims uncertainty about an unsent action', () async {
    final h = await waitingApproval();
    await h.voice.markVoiceApprovalPresented(h.voice.voiceApprovalReview!);
    h.api.decisionCaptionWaiter = Completer();
    speak(h, 'yes');
    await flush();
    h.api.decisionCaptionWaiter!.complete({'recorded': false});
    await flush();
    expect(
      h.api.approvalRequests.where((r) => r.containsKey('decision')),
      isEmpty,
    );
    expect(h.voice.spokenReviewPhase, SpokenReviewPhase.retryRequired);
    expect(h.voice.workNotice, contains('No decision was sent'));
    expect(h.voice.canRefreshSpokenApprovalReview, isTrue);
  });

  test('spoken approval waits for shown review and canonical receipt before acknowledgement', () async {
    final h = await waitingApproval();
    speak(h, 'yes', item: 'too-early');
    await flush();
    expect(
      h.api.approvalRequests.where((r) => r.containsKey('decision')),
      isEmpty,
    );
    expect(h.voice.spokenReviewPhase, SpokenReviewPhase.retryRequired);
    h.voice.refreshSpokenApprovalReview();
    await flush();
    await h.voice.markVoiceApprovalPresented(h.voice.voiceApprovalReview!);
    h.api.approvalDecisionWaiter = Completer();
    speak(h, 'approve this action');
    await flush();
    expect(h.api.approvalRequests.last['decision'], 'approve');
    expect(
      (h.api.approvalRequests.last['voiceApproval'] as Map)['userInputItemId'],
      'decision',
    );
    expect(h.voice.workNotice, isNot(contains('was recorded')));
    h.api.approvalDecisionWaiter!.complete({
      'record': {
        'id': 'execution',
        'toolId': 'test.send',
        'status': 'executing',
        'approvalDecision': 'approved',
      },
    });
    await flush();
    expect(h.voice.workNotice, contains('Your approval was recorded'));
    speak(h, 'yes', item: 'replay');
    await flush();
    expect(
      h.api.approvalRequests.where((r) => r.containsKey('decision')),
      hasLength(1),
    );
  });
  test('assistant captions and ambiguous agreement never decide; no rejects exact action', () async {
    final h = await waitingApproval();
    await h.voice.markVoiceApprovalPresented(h.voice.voiceApprovalReview!);
    h.peer.channel.emit({
      'type': 'response.output_audio_transcript.done',
      'response_id': 'assistant',
      'item_id': 'assistant_yes',
      'transcript': 'approve this action',
    });
    h.peer.channel.emit({
      'type': 'output_audio_buffer.stopped',
      'response_id': 'assistant',
    });
    speak(h, 'yes to both', item: 'ambiguous');
    await flush();
    expect(
      h.api.approvalRequests.where((r) => r.containsKey('decision')),
      isEmpty,
    );
    speak(h, 'yes', item: 'stale-yes');
    await flush();
    expect(
      h.api.approvalRequests.where((r) => r.containsKey('decision')),
      isEmpty,
    );
    h.voice.refreshSpokenApprovalReview();
    await flush();
    await h.voice.markVoiceApprovalPresented(h.voice.voiceApprovalReview!);
    speak(h, 'no', item: 'reject');
    await flush();
    expect(h.api.approvalRequests.last['decision'], 'reject');
    expect(h.voice.workNotice, contains('Your rejection was recorded'));
  });
  test(
    'failed decision remains unconfirmed and is not automatically retried',
    () async {
      final h = await waitingApproval();
      await h.voice.markVoiceApprovalPresented(h.voice.voiceApprovalReview!);
      h.api.approvalDecisionWaiter = Completer();
      speak(h, 'yes');
      await flush();
      h.api.approvalDecisionWaiter!.completeError(
        StateError('Synthetic rejection'),
      );
      await flush();
      expect(h.voice.workNotice, contains('could not be confirmed'));
      expect(h.voice.spokenReviewPhase, SpokenReviewPhase.unconfirmed);
      expect(h.voice.canRefreshSpokenApprovalReview, isFalse);
      expect(
        h.voice.spokenReviewUnavailableReason,
        contains('Open Review action'),
      );
      speak(h, 'yes', item: 'retry');
      await flush();
      expect(
        h.api.approvalRequests.where((r) => r.containsKey('decision')),
        hasLength(1),
      );
    },
  );
  test(
    'new speech or mute before caption persistence cancels an unsent approval',
    () async {
      for (final interruption in ['speech', 'mute']) {
        final h = await waitingApproval();
        await h.voice.markVoiceApprovalPresented(h.voice.voiceApprovalReview!);
        h.api.decisionCaptionWaiter = Completer();
        speak(h, 'yes');
        await flush();
        expect(
          h.api.approvalRequests.where((r) => r.containsKey('decision')),
          isEmpty,
        );
        if (interruption == 'speech') {
          h.peer.channel.emit({'type': 'input_audio_buffer.speech_started'});
        } else {
          h.voice.setMuted(true);
          h.voice.setMuted(false);
        }
        h.api.decisionCaptionWaiter!.complete({
          'recorded': true,
          'turnIds': [_turnId],
        });
        await flush();
        expect(
          h.api.approvalRequests.where((r) => r.containsKey('decision')),
          isEmpty,
        );
        expect(h.voice.workNotice, contains('No decision was sent'));
      }
    },
  );
  test(
    'a failed or empty microphone turn invalidates the old review',
    () async {
      for (final failure in ['failed', 'completed']) {
        final h = await waitingApproval();
        await h.voice.markVoiceApprovalPresented(h.voice.voiceApprovalReview!);
        h.peer.channel.emit({'type': 'input_audio_buffer.speech_started'});
        h.peer.channel.emit({
          'type': 'input_audio_buffer.committed',
          'item_id': 'unclear',
        });
        h.peer.channel.emit({
          'type': 'conversation.item.input_audio_transcription.$failure',
          'item_id': 'unclear',
          'transcript': '',
        });
        speak(h, 'yes');
        await flush();
        expect(
          h.api.approvalRequests.where((r) => r.containsKey('decision')),
          isEmpty,
        );
      }
    },
  );
  test(
    'failed presentation is attempted once until explicit fresh review',
    () async {
      final h = await waitingApproval();
      h.api.presentationFails = true;
      final review = h.voice.voiceApprovalReview!;
      for (var frame = 0; frame < 5; frame++) {
        await h.voice.markVoiceApprovalPresented(review);
      }
      expect(
        h.api.approvalRequests.where(
          (r) => (r['voiceReview'] as Map?)?['operation'] == 'present',
        ),
        hasLength(1),
      );
      h.voice.refreshSpokenApprovalReview();
      await flush();
      await h.voice.markVoiceApprovalPresented(h.voice.voiceApprovalReview!);
      expect(
        h.api.approvalRequests.where(
          (r) => (r['voiceReview'] as Map?)?['operation'] == 'present',
        ),
        hasLength(2),
      );
    },
  );
  test(
    'mute during presentation prevents a late receipt from arming after unmute',
    () async {
      final h = await waitingApproval();
      h.api.presentationWaiter = Completer();
      final pending = h.voice.markVoiceApprovalPresented(
        h.voice.voiceApprovalReview!,
      );
      await flush();
      h.voice.setMuted(true);
      h.voice.setMuted(false);
      h.api.presentationWaiter!.complete({
        'presentationId': '44444444-4444-4444-8444-444444444444',
        'actionSha256': 'a' * 64,
        'expiresAt': DateTime.now()
            .add(const Duration(minutes: 1))
            .toIso8601String(),
      });
      await pending;
      speak(h, 'yes');
      await flush();
      expect(
        h.api.approvalRequests.where((r) => r.containsKey('decision')),
        isEmpty,
      );
    },
  );
  test('an approved but failed tool is never announced as completed', () async {
    final h = await waitingApproval();
    await h.voice.markVoiceApprovalPresented(h.voice.voiceApprovalReview!);
    h.api.approvalDecisionWaiter = Completer();
    speak(h, 'yes');
    await flush();
    h.api.approvalDecisionWaiter!.complete({
      'record': {
        'id': 'execution',
        'toolId': 'test.send',
        'status': 'failed',
        'approvalDecision': 'approved',
      },
    });
    await flush();
    expect(h.voice.workNotice, contains('approval was recorded'));
    expect(h.voice.workNotice, isNot(contains('complete')));
  });
  test(
    'End during microphone acquisition still stops a failing late stream',
    () async {
      final h = _Harness();
      addTearDown(h.close);
      h.microphoneWaiter = Completer<MediaStream>();
      final started = h.start();
      await flush();
      await h.voice.end();
      h.stream.track.failDisable = true;
      h.microphoneWaiter!.complete(h.stream);
      await started;
      expect(h.stream.track.stopped && h.stream.disposed, isTrue);
      expect(h.api.requests, isEmpty);
      expect(h.peerCreations, 0);
    },
  );

  test('End during addTrack cannot create a channel or exchange SDP', () async {
    final h = _Harness();
    addTearDown(h.close);
    h.peer.trackWaiter = Completer<RTCRtpSender>();
    final started = h.start();
    await h.peer.trackAdded.future;
    await h.voice.end();
    h.peer.trackWaiter!.complete(_Sender());
    await started;
    expect(h.peer.closed && h.peer.disposed, isTrue);
    expect(h.peer.channelCreated.isCompleted, isFalse);
    expect(h.providerCalls, 0);
    expect(h.voice.ready, isFalse);
  });

  test('End during data-channel creation closes the late channel', () async {
    final h = _Harness();
    addTearDown(h.close);
    h.peer.channelWaiter = Completer<RTCDataChannel>();
    final started = h.start();
    await h.peer.channelCreated.future;
    await h.voice.end();
    h.peer.channelWaiter!.complete(h.peer.channel);
    await started;
    expect(h.peer.channel.closed, isTrue);
    expect(h.peer.closed && h.peer.disposed, isTrue);
    expect(h.providerCalls, 0);
    expect(h.voice.ready, isFalse);
  });

  test(
    'keeps both audio directions and work disabled until acknowledged',
    () async {
      final h = _Harness();
      addTearDown(h.close);
      final started = h.start();
      await h.peer.connected.future;
      expect(h.api.requests.single['computerUseTarget'], 'local_macos');
      expect(h.voice.ready, isFalse);
      expect(h.voice.microphoneActive, isFalse);
      expect(h.stream.track.enabled, isFalse);
      expect(h.peer.remote.enabled, isFalse);
      h.voice.setMuted(false);
      expect(h.stream.track.enabled, isFalse);
      h.acknowledge();
      await started;
      expect(h.voice.ready, isTrue);
      expect(h.stream.track.enabled, isTrue);
      expect(h.peer.remote.enabled, isTrue);
      h.voice.setMuted(true);
      expect(h.stream.track.enabled, isFalse);
      expect(h.peer.remote.enabled, isTrue);
      h.voice.setMuted(false);
      expect(h.stream.track.enabled, isTrue);
      await h.voice.end();
      await flush();
      expect(h.stream.track.enabled, isFalse);
      expect(h.stream.track.stopped, isTrue);
      expect(h.peer.remote.enabled, isFalse);
      expect(h.peer.closed && h.peer.disposed && h.stream.disposed, isTrue);
      expect(
        h
            .api
            .finishes
            .single['providerConfigurationAcknowledgement']['observedBy'],
        'client',
      );
    },
  );

  test(
    'immediate session.created during SDP is latched and muted stays muted',
    () async {
      final h = _Harness();
      addTearDown(h.close);
      h.peer.afterSdp = () {
        h.voice.setMuted(true);
        h.acknowledge();
      };
      await h.start();
      expect(h.voice.ready, isTrue);
      expect(h.voice.muted, isTrue);
      expect(h.stream.track.enabled, isFalse);
      expect(h.peer.remote.enabled, isTrue);
    },
  );

  test('missing acknowledgement times out, releases resources and never reconnects', () async {
    final h = _Harness(timeout: Duration.zero);
    addTearDown(h.close);
    await h.start();
    await flush();
    expect(h.voice.phase, VoiceConversationPhase.error);
    expect(h.voice.ready, isFalse);
    expect(h.stream.track.enabled || h.peer.remote.enabled, isFalse);
    expect(h.peer.closed && h.stream.disposed, isTrue);
    expect(h.providerCalls, 1);
    expect(h.api.requests, hasLength(1));
    expect(
      h.api.finishes.single['providerErrorCode'],
      'voice_provider_configuration_timeout',
    );
    expect(
      h.api.finishes.single.containsKey('providerConfigurationAcknowledgement'),
      isFalse,
    );
    h.acknowledge();
    expect(h.voice.ready, isFalse);
  });

  test('target downgrade or missing expectation refuses SDP and closes minted session', () async {
    for (final missingExpectation in [false, true]) {
      final h = _Harness();
      addTearDown(h.close);
      h.api.editCredential = (value) {
        if (missingExpectation) {
          value.remove('providerConfiguration');
        } else {
          (value['commandContext'] as Map).remove('computerUseTarget');
        }
      };
      await h.start();
      await flush();
      expect(h.voice.ready, isFalse);
      expect(h.peerCreations, 0);
      expect(h.providerCalls, 0);
      expect(h.stream.disposed, isTrue);
      expect(h.api.finishes.single['sessionId'], _sessionId);
      expect(
        h.api.finishes.single['providerErrorCode'],
        missingExpectation
            ? 'voice_provider_configuration_invalid'
            : 'voice_target_mismatch',
      );
    }
  });

  test(
    'response or function arriving before acknowledgement cannot be replayed',
    () async {
      for (final type in [
        'response.created',
        'response.function_call_arguments.done',
      ]) {
        final h = _Harness();
        addTearDown(h.close);
        final started = h.start();
        await h.peer.connected.future;
        h.peer.channel.emit({
          'type': type,
          'response': {'id': 'response_1'},
          'response_id': 'response_1',
          'call_id': 'call_1',
          'name': 'ask_asael',
          'arguments': jsonEncode({'request': 'Open YouTube'}),
        });
        h.acknowledge();
        await started;
        await flush();
        expect(h.delegations, 0);
        expect(h.voice.ready, isFalse);
        expect(h.peer.remote.enabled, isFalse);
        expect(
          h.api.finishes.single['providerErrorCode'],
          'voice_provider_response_before_ready',
        );
      }
    },
  );

  test(
    'configuration drift mutes, ends and removes successful acknowledgement',
    () async {
      final h = _Harness();
      addTearDown(h.close);
      h.peer.afterSdp = h.acknowledge;
      await h.start();
      expect(h.voice.ready, isTrue);
      h.peer.channel.emit({
        'type': 'session.updated',
        'session': providerSessionFixture()..['tools'] = [],
      });
      expect(h.stream.track.enabled, isFalse);
      expect(h.peer.remote.enabled, isFalse);
      await flush();
      expect(h.voice.phase, VoiceConversationPhase.error);
      expect(
        h.api.finishes.single['providerErrorCode'],
        'voice_provider_configuration_mismatch',
      );
      expect(
        h.api.finishes.single.containsKey(
          'providerConfigurationAcknowledgement',
        ),
        isFalse,
      );
    },
  );

  test('End cancels acknowledgement wait and old callbacks cannot admit replacement call', () async {
    final h = _Harness();
    addTearDown(h.close);
    final first = h.start();
    final oldPeer = h.peer;
    await oldPeer.connected.future;
    await h.voice.end();
    await first;
    h.peer = _Peer();
    h.stream = _Stream();
    final second = h.start();
    await h.peer.connected.future;
    oldPeer.channel.emit({
      'type': 'session.created',
      'session': providerSessionFixture(),
    });
    expect(h.voice.ready, isFalse);
    expect(h.stream.track.enabled, isFalse);
    h.acknowledge();
    await second;
    expect(h.voice.ready, isTrue);
    expect(h.providerCalls, 2);
  });

  test('verified call delegates its unchanged pinned context after exact caption save', () async {
    final h = _Harness();
    addTearDown(h.close);
    h.peer.afterSdp = h.acknowledge;
    await h.start();
    final emit = h.peer.channel.emit;
    emit({'type': 'input_audio_buffer.speech_started'});
    emit({'type': 'input_audio_buffer.committed', 'item_id': 'human_1'});
    emit({
      'type': 'conversation.item.input_audio_transcription.completed',
      'item_id': 'human_1',
      'transcript':
          "Open YouTube and play the first video from 2819's channel.",
    });
    emit({'type': 'input_audio_buffer.speech_stopped'});
    emit({
      'type': 'response.created',
      'response': {'id': 'response_1'},
    });
    emit({
      'type': 'response.function_call_arguments.done',
      'response_id': 'response_1',
      'call_id': 'call_1',
      'name': 'ask_asael',
      'arguments': jsonEncode({'request': 'Open YouTube'}),
    });
    await flush();
    expect(h.delegations, 1);
    expect(h.delegatedContext, _context);
    expect(h.delegatedInputs, [
      (
        request: 'Open YouTube',
        itemId: 'human_1',
        caption: "Open YouTube and play the first video from 2819's channel.",
      ),
    ]);
  });
  test(
    'assistant and later human captions never replace a claimed task caption',
    () async {
      final h = _Harness();
      addTearDown(h.close);
      h.peer.afterSdp = h.acknowledge;
      await h.start();
      final emit = h.peer.channel.emit;
      const caption = "Please open the first video on the '2819' channel.";
      emit({'type': 'input_audio_buffer.speech_started'});
      emit({'type': 'input_audio_buffer.committed', 'item_id': 'human_1'});
      emit({
        'type': 'conversation.item.input_audio_transcription.completed',
        'item_id': 'human_1',
        'transcript': caption,
      });
      emit({
        'type': 'response.created',
        'response': {'id': 'response_1'},
      });
      emit({
        'type': 'response.output_audio_transcript.done',
        'response_id': 'response_1',
        'item_id': 'assistant_1',
        'transcript': 'I will check the browser.',
      });
      emit({
        'type': 'output_audio_buffer.stopped',
        'response_id': 'response_1',
      });
      await flush();
      expect(h.voice.caption, 'I will check the browser.');
      final function = {
        'type': 'response.function_call_arguments.done',
        'response_id': 'response_1',
        'call_id': 'call_1',
        'name': 'ask_asael',
        'arguments': jsonEncode({'request': "Open 2819's first video."}),
      };
      emit(function);
      await flush();
      expect(h.delegatedInputs.single, (
        request: "Open 2819's first video.",
        itemId: 'human_1',
        caption: caption,
      ));
      emit({'type': 'input_audio_buffer.speech_started'});
      emit({'type': 'input_audio_buffer.committed', 'item_id': 'human_2'});
      emit({
        'type': 'conversation.item.input_audio_transcription.completed',
        'item_id': 'human_2',
        'transcript': 'Open a different project now.',
      });
      await flush();
      emit(function);
      emit({...function, 'call_id': 'repeated_call'});
      await flush();
      expect(h.voice.caption, 'Open a different project now.');
      expect(h.delegatedInputs, hasLength(1));
      expect(h.delegatedInputs.single.caption, caption);
    },
  );
}
