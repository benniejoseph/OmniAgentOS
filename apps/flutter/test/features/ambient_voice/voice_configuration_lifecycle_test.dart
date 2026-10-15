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
  @override
  Future<Map<String, dynamic>> postJson(
    String path, {
    Map<String, dynamic>? data,
    Map<String, dynamic>? headers,
  }) async {
    if (path == NativePaths.voiceConversationTurns) {
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
  Future<void> start() => voice.start(
    consentAccepted: true,
    context: Map<String, dynamic>.from(_context),
    delegate: (request, turn, session, conversation, pinned, inputItem) async {
      delegations++;
      delegatedContext = pinned;
      return {'status': 'completed', 'message': 'Synthetic completion'};
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
  });
}
