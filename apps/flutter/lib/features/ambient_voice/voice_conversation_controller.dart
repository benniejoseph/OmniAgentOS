import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../generated/native_contract.g.dart';
import 'realtime_voice_controller.dart' show AmbientVoiceException;

enum VoiceConversationPhase {
  idle,
  connecting,
  listening,
  speaking,
  working,
  ended,
  error,
}

typedef VoiceConversationDelegate = Future<Map<String, dynamic>> Function(
  String request,
  String turnId,
  String sessionId,
  String conversationId,
  Map<String, dynamic> commandContext,
);

/// One continuous, owner-bound speech conversation. Audio stays on WebRTC;
/// only final captions and governed tool requests pass through Asael's API.
class VoiceConversationController extends ChangeNotifier {
  VoiceConversationController({required ApiClient api, Dio? providerDio})
    : _api = api,
      _provider =
          providerDio ??
          Dio(BaseOptions(connectTimeout: const Duration(seconds: 12)));

  static const _sessionPath = NativePaths.voiceConversationSessionStart;
  static const _turnsPath = NativePaths.voiceConversationTurns;
  static const _transport = 'https://api.openai.com/v1/realtime/calls';
  static final _uuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    caseSensitive: false,
  );
  static final _itemId = RegExp(r'^[A-Za-z0-9_-]{1,160}$');
  final ApiClient _api;
  final Dio _provider;
  RTCPeerConnection? _peer;
  RTCDataChannel? _channel;
  MediaStream? _microphone;
  CancelToken? _exchange;
  Timer? _expiry;
  Timer? _disconnectTimer;
  DateTime? _startedAt;
  int _generation = 0;
  bool _disposed = false;
  bool _ending = false;
  bool _responseActive = false;
  bool _userSpeaking = false;
  bool _needsResponse = false;
  bool _delegating = false;
  String? _responseId;
  final _seenCalls = <String>{};
  final _savedItems = <String>{};
  final _assistantCaptions = <String, Map<String, dynamic>>{};
  final _stoppedResponses = <String>{};
  final _interruptedResponses = <String>{};
  Future<void> _saveQueue = Future<void>.value();
  int _pendingSaves = 0;
  int _turnCount = 0;
  VoiceConversationDelegate? _delegate;
  void Function(String conversationId, Future<void> captionsSettled)?
  _onConversationEnded;

  VoiceConversationPhase phase = VoiceConversationPhase.idle;
  String? sessionId;
  String? conversationId;
  String agentName = 'ATLAS';
  Map<String, dynamic>? commandContext;
  String caption = '';
  String? errorMessage;
  String? historyNotice;
  bool muted = false;
  bool get active =>
      !_ending &&
      switch (phase) {
        VoiceConversationPhase.connecting ||
        VoiceConversationPhase.listening ||
        VoiceConversationPhase.speaking ||
        VoiceConversationPhase.working => true,
        _ => false,
      };
  bool get microphoneActive => active && !muted && _microphone != null;

  /// A presentation signal from the provider's actual speech events, not an
  /// amplitude estimate. Muting capture immediately removes speech activity.
  bool get userSpeaking => microphoneActive && _userSpeaking;
  bool get ready => active && phase != VoiceConversationPhase.connecting;
  bool _current(int generation) =>
      !_disposed && !_ending && generation == _generation;
  void _changed() {
    if (!_disposed) notifyListeners();
  }

  Future<void> start({
    required bool consentAccepted,
    required Map<String, dynamic> context,
    required VoiceConversationDelegate delegate,
    String? existingConversationId,
    ValueChanged<String>? onConversationBound,
    void Function(String conversationId, Future<void> captionsSettled)?
    onConversationEnded,
  }) async {
    if (_disposed || active || _ending) return;
    if (!consentAccepted) {
      errorMessage = 'Agree to the voice notice before starting.';
      phase = VoiceConversationPhase.error;
      _changed();
      return;
    }
    final generation = ++_generation;
    phase = VoiceConversationPhase.connecting;
    errorMessage = null;
    historyNotice = null;
    caption = '';
    muted = false;
    sessionId = null;
    conversationId = null;
    commandContext = null;
    _responseActive = false;
    _userSpeaking = false;
    _needsResponse = false;
    _delegating = false;
    _seenCalls.clear();
    _savedItems.clear();
    _assistantCaptions.clear();
    _stoppedResponses.clear();
    _interruptedResponses.clear();
    _turnCount = 0;
    _delegate = delegate;
    _onConversationEnded = onConversationEnded;
    _startedAt = DateTime.now();
    _changed();
    try {
      final stream = await navigator.mediaDevices.getUserMedia({
        'audio': {
          'channelCount': 1,
          'echoCancellation': true,
          'noiseSuppression': true,
          'autoGainControl': true,
        },
        'video': false,
      });
      if (!_current(generation)) {
        await _releaseMicrophone(stream);
        return;
      }
      _microphone = stream;
      final credential = await _api
          .postJson(
            _sessionPath,
            data: {
              ...context,
              'schemaVersion': 2,
              if (existingConversationId != null &&
                  _uuid.hasMatch(existingConversationId))
                'conversationId': existingConversationId,
              'providerConsent': true,
              'continuousConsent': true,
              'audioRetention': 'not_stored_by_asael',
              'transcriptRetention': 'conversation_history',
            },
          )
          .timeout(const Duration(seconds: 30));
      if (!_current(generation)) return;
      _validateCredential(credential);
      sessionId = credential['sessionId'] as String;
      conversationId = credential['conversationId'] as String;
      agentName = credential['agentName'] as String;
      commandContext = Map<String, dynamic>.unmodifiable(
        credential['commandContext'] as Map,
      );
      onConversationBound?.call(conversationId!);
      final expiresAt = DateTime.parse(credential['expiresAt'] as String);
      final remaining = expiresAt.difference(DateTime.now());
      if (remaining <= Duration.zero)
        throw const AmbientVoiceException(
          'session_expired',
          'This call expired. Start a new call.',
        );
      _expiry = Timer(
        remaining,
        () => unawaited(
          _fail(
            'This call reached its time limit. Start again to continue.',
            'session_expired',
          ),
        ),
      );
      await _connect(credential, stream, generation);
      if (!_current(generation)) return;
      phase = VoiceConversationPhase.listening;
      _changed();
    } catch (error) {
      if (!_current(generation)) return;
      await _fail(
        _friendlyError(error),
        error is AmbientVoiceException ? error.code : null,
      );
    }
  }

  void _validateCredential(Map<String, dynamic> value) {
    final context = value['commandContext'];
    if (value['schemaVersion'] != 2 ||
        value['provider'] != 'openai' ||
        value['transportUrl'] != _transport ||
        value['voice'] != 'cedar' ||
        value['turnDetection'] != 'server_vad' ||
        value['audioRetention'] != 'not_stored_by_asael' ||
        value['transcriptRetention'] != 'conversation_history' ||
        !_uuid.hasMatch(value['sessionId']?.toString() ?? '') ||
        !_uuid.hasMatch(value['conversationId']?.toString() ?? '') ||
        !RegExp(r'^ek_[A-Za-z0-9._:@/+~-]+$')
            .hasMatch(value['clientSecret']?.toString() ?? '') ||
        value['agentName'] is! String ||
        (value['agentName'] as String).isEmpty ||
        context is! Map ||
        context['agentId'] is! String ||
        context['mode'] is! String ||
        context['contextScope'] is! String ||
        context['contextReferences'] is! List ||
        DateTime.tryParse(value['expiresAt']?.toString() ?? '') == null) {
      throw const AmbientVoiceException(
        'invalid_voice_session',
        'Asael could not verify this voice call. Update the app and try again.',
      );
    }
  }

  Future<void> _connect(
    Map<String, dynamic> credential,
    MediaStream stream,
    int generation,
  ) async {
    final peer = await createPeerConnection({});
    if (!_current(generation)) {
      await peer.close();
      await peer.dispose();
      return;
    }
    _peer = peer;
    for (final track in stream.getAudioTracks()) {
      await peer.addTrack(track, stream);
    }
    // flutter_webrtc's native receiver plays remote audio directly. It does
    // not need the legacy PCM download or a separate AudioPlayer.
    peer.onTrack = (event) {
      if (_current(generation) && event.track.kind == 'audio')
        event.track.enabled = true;
    };
    peer.onConnectionState = (state) {
      if (!_current(generation) || _peer != peer) return;
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _disconnectTimer?.cancel();
      } else if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        unawaited(
          _fail(
            'The voice connection ended. Your accepted work can still be found in History. Start again to reconnect.',
            'connection_failed',
          ),
        );
      } else if (state ==
          RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        _disconnectTimer?.cancel();
        _disconnectTimer = Timer(const Duration(seconds: 8), () {
          if (_current(generation))
            unawaited(
              _fail(
                'The voice connection was lost. Check your connection and start again.',
                'connection_lost',
              ),
            );
        });
      }
    };
    final channel = await peer.createDataChannel(
      'oai-events',
      RTCDataChannelInit()..ordered = true,
    );
    _channel = channel;
    channel.onMessage = (event) {
      if (_current(generation) && !event.isBinary)
        _providerEvent(event.text, generation);
    };
    channel.onDataChannelState = (state) {
      if (_current(generation) &&
          state == RTCDataChannelState.RTCDataChannelClosed &&
          ready) {
        unawaited(
          _fail(
            'The voice connection closed. Start again to reconnect.',
            'connection_closed',
          ),
        );
      }
    };
    final offer = await peer.createOffer({
      'offerToReceiveAudio': true,
      'offerToReceiveVideo': false,
    });
    await peer.setLocalDescription(offer);
    final iceDeadline = DateTime.now().add(const Duration(seconds: 2));
    while (_current(generation) &&
        peer.iceGatheringState !=
            RTCIceGatheringState.RTCIceGatheringStateComplete &&
        DateTime.now().isBefore(iceDeadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 40));
    }
    if (!_current(generation)) return;
    final sdp = (await peer.getLocalDescription())?.sdp ?? offer.sdp ?? '';
    if (!sdp.startsWith('v=0') || sdp.length > 1048576)
      throw const AmbientVoiceException(
        'invalid_voice_offer',
        'The Mac could not open its audio connection. Try again.',
      );
    final cancel = CancelToken();
    _exchange = cancel;
    final response = await _provider.post<String>(
      _transport,
      data: sdp,
      cancelToken: cancel,
      options: Options(
        contentType: 'application/sdp',
        responseType: ResponseType.plain,
        followRedirects: false,
        sendTimeout: const Duration(seconds: 12),
        receiveTimeout: const Duration(seconds: 20),
        headers: {'Authorization': 'Bearer ${credential['clientSecret']}'},
        validateStatus: (status) =>
            status != null && status >= 200 && status < 300,
      ),
    );
    if (_exchange == cancel) _exchange = null;
    if (!_current(generation)) return;
    final answer = response.data ?? '';
    if (!answer.startsWith('v=0') || answer.length > 1048576)
      throw const AmbientVoiceException(
        'invalid_voice_answer',
        'The voice provider could not open its audio connection. Try again.',
      );
    await peer.setRemoteDescription(RTCSessionDescription(answer, 'answer'));
    final deadline = DateTime.now().add(const Duration(seconds: 12));
    while (_current(generation) &&
        channel.state != RTCDataChannelState.RTCDataChannelOpen &&
        DateTime.now().isBefore(deadline)) {
      if (channel.state == RTCDataChannelState.RTCDataChannelClosed) break;
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    if (_current(generation) &&
        channel.state != RTCDataChannelState.RTCDataChannelOpen) {
      throw const AmbientVoiceException(
        'voice_connection_timeout',
        'Voice took too long to connect. Check your connection and try again.',
      );
    }
  }

  void setMuted(bool value) {
    if (!ready) return;
    muted = value;
    if (value) _userSpeaking = false;
    for (final track in _microphone?.getAudioTracks() ?? <MediaStreamTrack>[]) {
      track.enabled = !value;
    }
    _changed();
  }

  void _providerEvent(String raw, int generation) {
    if (raw.length > 1048576) return;
    dynamic decoded;
    try {
      decoded = jsonDecode(raw);
    } catch (_) {
      return;
    }
    if (decoded is! Map) return;
    final event = Map<String, dynamic>.from(decoded);
    final type = event['type'];
    switch (type) {
      case 'input_audio_buffer.speech_started':
        _userSpeaking = true;
        _interruptCaption(_responseId);
        phase = VoiceConversationPhase.listening;
        caption = 'Listening…';
      case 'input_audio_buffer.speech_stopped':
        _userSpeaking = false;
        phase = _delegating
            ? VoiceConversationPhase.working
            : VoiceConversationPhase.listening;
        _resumeResponse();
      case 'conversation.item.input_audio_transcription.completed':
        final text = _text(event['transcript']);
        if (text.isNotEmpty) {
          caption = text;
          _turnCount++;
          _saveTurn(event['item_id'], 'user', text);
        }
      case 'response.created':
        _responseActive = true;
        final response = event['response'];
        _responseId = response is Map ? response['id']?.toString() : null;
      case 'response.done':
        final response = event['response'];
        final id = response is Map ? response['id']?.toString() : null;
        if (id == null || id == _responseId) _responseActive = false;
        if (response is Map && response['status'] == 'failed') {
          unawaited(
            _fail(
              'The voice provider could not answer. Start again to reconnect.',
              'response_failed',
            ),
          );
          return;
        }
        _resumeResponse();
      case 'output_audio_buffer.started':
        phase = VoiceConversationPhase.speaking;
      case 'output_audio_buffer.stopped':
        final id = event['response_id']?.toString() ?? _responseId;
        if (id != null) {
          _stoppedResponses.add(id);
          _flushAssistantCaption(id);
        }
        phase = _delegating
            ? VoiceConversationPhase.working
            : VoiceConversationPhase.listening;
      case 'output_audio_buffer.cleared':
        _interruptCaption(event['response_id']?.toString() ?? _responseId);
        phase = _delegating
            ? VoiceConversationPhase.working
            : VoiceConversationPhase.listening;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        // Final caption is shown only once playback finishes; an interrupted
        // response must not present its unheard tail as something Asael said.
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        final text = _text(event['transcript']);
        final id = event['response_id']?.toString() ?? _responseId;
        final itemId = event['item_id']?.toString();
        if (id != null && itemId != null && text.isNotEmpty) {
          _assistantCaptions[id] = {'itemId': itemId, 'text': text};
          if (_interruptedResponses.contains(id)) {
            _interruptCaption(id);
          } else if (_stoppedResponses.contains(id)) {
            _flushAssistantCaption(id);
          }
        }
      case 'response.function_call_arguments.done':
        unawaited(_handleFunction(event, generation));
      case 'error':
        final error = event['error'];
        final code = error is Map ? error['code']?.toString() ?? '' : '';
        if (const {
          'response_cancel_not_active',
          'input_audio_buffer_commit_empty',
          'conversation_already_has_active_response',
        }.contains(code))
          return;
        final safe = RegExp(r'^[a-z0-9_.-]{1,80}$').hasMatch(code)
            ? code
            : null;
        unawaited(_fail(_providerErrorMessage(safe), safe));
        return;
      default:
        return;
    }
    _changed();
  }

  void _flushAssistantCaption(String responseId) {
    if (_interruptedResponses.contains(responseId)) return;
    final value = _assistantCaptions.remove(responseId);
    if (value == null) return;
    caption = value['text'] as String;
    _saveTurn(value['itemId'], 'assistant', caption);
  }

  void _interruptCaption(String? responseId) {
    if (responseId == null || _stoppedResponses.contains(responseId)) return;
    _interruptedResponses.add(responseId);
    final value = _assistantCaptions.remove(responseId);
    if (value != null)
      _saveTurn(
        value['itemId'],
        'assistant',
        '[Reply interrupted]',
        interrupted: true,
      );
  }

  Future<void> _handleFunction(
    Map<String, dynamic> event,
    int generation,
  ) async {
    final callId = event['call_id']?.toString() ?? '';
    if (!_itemId.hasMatch(callId) || _seenCalls.contains(callId)) return;
    if (_seenCalls.length >= 128) {
      await _fail(
        'This call reached its action limit. Start a new call to continue.',
        'call_limit',
      );
      return;
    }
    _seenCalls.add(callId);
    Map<String, dynamic> result;
    dynamic args;
    try {
      args = jsonDecode(event['arguments']?.toString() ?? '');
    } catch (_) {
      args = null;
    }
    final request = args is Map ? args['request'] : null;
    if (event['name'] != 'ask_asael' ||
        args is! Map ||
        args.length != 1 ||
        request is! String ||
        request.trim().isEmpty ||
        request.length > 8000) {
      result = {
        'status': 'invalid_request',
        'message': 'Ask for one specific Asael task using the request field.',
      };
    } else if (_delegating) {
      result = {
        'status': 'busy',
        'message': 'The previous task is still running. Do not retry it. The user can follow it in History.',
      };
    } else {
      _delegating = true;
      phase = VoiceConversationPhase.working;
      _changed();
      try {
        // A timeout is an uncertain accepted operation, never permission to
        // resend. The governed run continues independently of this call.
        result =
            await _delegate!(
              request.trim(),
              callId,
              sessionId!,
              conversationId!,
              commandContext!,
            ).timeout(
              const Duration(seconds: 75),
              onTimeout: () => {
                'status': 'pending',
                'message': 'This task may still be running. Do not retry it. Follow its progress and any approval in History or Inbox.',
              },
            );
      } catch (_) {
        result = {
          'status': 'unknown',
          'message': 'The request could not be confirmed. It may have been accepted; do not automatically retry. Check History and Inbox.',
        };
      } finally {
        if (_current(generation)) _delegating = false;
      }
    }
    if (!_current(generation)) return;
    try {
      await _send({
        'type': 'conversation.item.create',
        'item': {
          'type': 'function_call_output',
          'call_id': callId,
          'output': jsonEncode(result),
        },
      });
      _needsResponse = true;
      _resumeResponse();
      _changed();
    } catch (_) {
      await _fail(
        'The call disconnected while a task was running. Check History before asking again.',
        'tool_result_disconnected',
      );
    }
  }

  void _resumeResponse() {
    if (!_needsResponse || _responseActive || _userSpeaking || !ready) return;
    _needsResponse = false;
    _responseActive = true;
    unawaited(
      _send({'type': 'response.create'}).catchError((Object _) {
        if (active)
          unawaited(
            _fail(
              'The voice reply could not resume. Your task remains in History.',
              'response_resume_failed',
            ),
          );
      }),
    );
  }

  Future<void> _send(Map<String, dynamic> event) async {
    final channel = _channel;
    if (channel?.state != RTCDataChannelState.RTCDataChannelOpen)
      throw StateError('The voice channel is closed.');
    await channel!.send(RTCDataChannelMessage(jsonEncode(event)));
  }

  void _saveTurn(
    Object? item,
    String role,
    String text, {
    bool interrupted = false,
  }) {
    final id = item?.toString() ?? '';
    final session = sessionId;
    final conversation = conversationId;
    if (!_itemId.hasMatch(id) ||
        session == null ||
        conversation == null ||
        _savedItems.contains(id))
      return;
    if (_pendingSaves >= 12) {
      historyNotice =
          'Some captions could not be saved. Your voice call can continue.';
      _changed();
      return;
    }
    _savedItems.add(id);
    _pendingSaves++;
    _saveQueue = _saveQueue.then((_) async {
      try {
        await _api
            .postJson(
              _turnsPath,
              data: {
                'schemaVersion': 2,
                'sessionId': session,
                'conversationId': conversation,
                'turns': [
                  {
                    'itemId': id,
                    'role': role,
                    'text': text,
                    'interrupted': interrupted,
                  },
                ],
              },
            )
            .timeout(const Duration(seconds: 8));
      } catch (_) {
        historyNotice =
            'Some captions could not be saved. Your voice call can continue.';
        _changed();
      } finally {
        _pendingSaves--;
      }
    });
  }

  static String _text(Object? value) {
    if (value is! String) return '';
    final text = value.trim();
    return text.length <= 12000 ? text : text.substring(0, 12000);
  }

  Future<void> end() => _finish(failed: false);

  Future<void> _fail(String message, String? code) async {
    if (_disposed || _ending) return;
    errorMessage = message;
    phase = VoiceConversationPhase.error;
    _changed();
    await _finish(failed: true, code: code);
  }

  Future<void> _finish({required bool failed, String? code}) async {
    if (_ending) return;
    _ending = true;
    ++_generation;
    final session = sessionId;
    final conversation = conversationId;
    final startedAt = _startedAt;
    final turnCount = _turnCount;
    final savedCaptions = _saveQueue;
    final onConversationEnded = _onConversationEnded;
    _onConversationEnded = null;
    sessionId = null;
    _expiry?.cancel();
    _disconnectTimer?.cancel();
    _exchange?.cancel('voice_call_ended');
    _exchange = null;
    _delegate = null;
    final microphone = _microphone;
    _microphone = null;
    final channel = _channel;
    _channel = null;
    final peer = _peer;
    _peer = null;
    // Disable capture immediately, before any network or history wait.
    for (final track in microphone?.getAudioTracks() ?? <MediaStreamTrack>[]) {
      track.enabled = false;
    }
    if (!failed) phase = VoiceConversationPhase.ended;
    _changed();
    if (session != null && conversation != null) {
      onConversationEnded?.call(conversation, savedCaptions);
    }
    if (microphone != null) await _releaseMicrophone(microphone);
    try {
      await channel?.close();
    } catch (_) {
      /* Already disconnected. */
    }
    try {
      await peer?.close();
      await peer?.dispose();
    } catch (_) {
      /* Already disconnected. */
    }
    _ending = false;
    _changed();
    // Closing the HUD never waits for a receipt. The final scoped receipt is
    // sent only after all captions already queued for this call have settled.
    unawaited(
      _finishReceipt(
        session,
        conversation,
        startedAt,
        turnCount,
        savedCaptions,
        failed,
        code,
      ),
    );
  }

  Future<void> _finishReceipt(
    String? session,
    String? conversation,
    DateTime? startedAt,
    int turnCount,
    Future<void> savedCaptions,
    bool failed,
    String? code,
  ) async {
    await savedCaptions;
    if (session != null && conversation != null) {
      try {
        await _api
            .patchJson(
              NativePaths.voiceConversationSessionFinish,
              data: {
                'schemaVersion': 2,
                'sessionId': session,
                'conversationId': conversation,
                'outcome': failed ? 'failed' : 'ended',
                'durationMilliseconds':
                    (startedAt == null
                            ? 0
                            : DateTime.now()
                                  .difference(startedAt)
                                  .inMilliseconds)
                        .clamp(0, 3600000),
                'turnCount': turnCount.clamp(0, 10000),
                'reconnectCount': 0,
                if (code != null &&
                    RegExp(r'^[a-z0-9_.-]{1,80}$').hasMatch(code))
                  'providerErrorCode': code,
              },
            )
            .timeout(const Duration(seconds: 5));
      } catch (_) {
        /* Ending the local microphone never depends on a receipt. */
      }
    }
  }

  static Future<void> _releaseMicrophone(MediaStream stream) async {
    for (final track in stream.getTracks()) {
      track.enabled = false;
      try {
        await track.stop();
      } catch (_) {
        /* Already stopped. */
      }
    }
    try {
      await stream.dispose();
    } catch (_) {
      /* Already released. */
    }
  }

  static String _friendlyError(Object error) {
    if (error is AmbientVoiceException) return error.message;
    if (error is ApiException)
      return error.message.length <= 320
          ? error.message
          : 'Asael could not start this voice call. Check your connection and try again.';
    if (error is DioException) {
      final status = error.response?.statusCode;
      String? code;
      final raw = error.response?.data;
      if (raw is String && raw.length <= 16384) {
        try {
          final decoded = jsonDecode(raw);
          final details = decoded is Map ? decoded['error'] : null;
          if (details is Map) {
            final candidate = details['code']?.toString();
            if (candidate != null &&
                RegExp(r'^[a-z0-9_.-]{1,80}$').hasMatch(candidate))
              code = candidate;
          }
        } catch (_) {
          /* Do not expose raw provider bodies. */
        }
      }
      final suffix = [
        if (status != null && status >= 400 && status < 600) 'HTTP $status',
        if (code != null) code,
      ].join(' · ');
      return '${_providerErrorMessage(code)}${suffix.isEmpty ? '' : ' ($suffix)'}';
    }
    final description = error.toString().toLowerCase();
    if (description.contains('permission') ||
        description.contains('notallowed') ||
        description.contains('denied'))
      return 'Microphone access is off. Allow Asael in System Settings → Privacy & Security → Microphone, then try again.';
    if (error is TimeoutException)
      return 'Voice took too long to connect. Check your connection and try again.';
    return 'Asael could not start the voice call. Check microphone access and your connection, then try again.';
  }

  static String _providerErrorMessage(String? code) => switch (code) {
    'rate_limit_exceeded' || 'insufficient_quota' => 'The voice provider has reached its limit. Check usage in Settings and try again later.',
    'session_expired' || 'client_secret_expired' =>
      'This voice call expired. Start again to reconnect.',
    'invalid_api_key' || 'invalid_client_secret' => 'The voice connection could not be authorized. Check the provider in Settings and try again.',
    'model_not_found' || 'model_not_supported' => 'The configured voice model is unavailable. Check the provider in Settings.',
    _ => 'The voice connection failed. Check your connection and try again.',
  };

  @override
  void dispose() {
    if (_disposed) return;
    unawaited(end());
    _disposed = true;
    super.dispose();
  }
}
