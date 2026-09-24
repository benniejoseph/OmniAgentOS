import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/auth/native_client_info.dart';
import '../../core/config/app_config.dart';
import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/storage/secure_session_store.dart';
import '../../generated/native_contract.g.dart';

const _audioRetention = 'not_stored_by_asael';
const _transcriptRetention = 'command_draft_until_sent';
const _voiceProfileVersion = 'asael-voice:1';
const _speechEncoding = 'pcm_s16le';
const _speechSampleRate = 24000;
const _realtimeTransportUrl = 'https://api.openai.com/v1/realtime/calls';
const _maximumTranscriptCharacters = 100000;
const _maximumSpeechCharacters = 20000;
const _maximumSpeechChunkCharacters = 3800;
const _maximumSpeechPcmBytes = 32 * 1024 * 1024;
const _maximumProviderEventCharacters = 1024 * 1024;
const _maximumSdpCharacters = 1024 * 1024;

enum AmbientRealtimeVoicePhase {
  idle,
  requestingPermission,
  connecting,
  listening,
  speechDetected,
  reconnecting,
  finishing,
  review,
  playingSpeech,
  stopped,
  error,
}

enum AmbientVoiceOutcome { sent, canceled, failed }

enum AmbientVoiceConfidenceBand { high, low, unavailable, edited }

@immutable
class AmbientVoiceDraft {
  const AmbientVoiceDraft({
    required this.text,
    required this.sessionId,
    required this.conversationId,
    required this.confidenceBand,
    required this.confidenceSampleCount,
    required this.reviewRequired,
    required this.reviewAttested,
    required this.turnCount,
    required this.reconnectCount,
    this.confidenceMean,
    this.confidenceMinimum,
  });

  final String text;
  final String? sessionId;
  final String? conversationId;
  final AmbientVoiceConfidenceBand confidenceBand;
  final double? confidenceMean;
  final double? confidenceMinimum;
  final int confidenceSampleCount;
  final bool reviewRequired;
  final bool reviewAttested;
  final int turnCount;
  final int reconnectCount;
}

class AmbientVoiceException implements Exception {
  const AmbientVoiceException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => message;
}

/// Owns an ephemeral, transcription-only WebRTC session for Ambient Command.
///
/// Audio is sent directly to the provider with a short-lived credential. Asael
/// receives only bounded, content-free completion metadata. Provider events are
/// reduced to transcript text and confidence numbers before reaching the UI.
class AmbientRealtimeVoiceController extends ChangeNotifier {
  factory AmbientRealtimeVoiceController({
    required ApiClient api,
    required SecureSessionStore sessionStore,
    Dio? providerDio,
    Dio? speechDio,
    AudioPlayer? audioPlayer,
    ValueChanged<String>? onConversationBound,
  }) {
    final resolvedPlayer = audioPlayer ?? AudioPlayer();
    return AmbientRealtimeVoiceController._(
      api: api,
      sessionStore: sessionStore,
      providerDio: providerDio ?? Dio(),
      speechDio:
          speechDio ??
          Dio(
            BaseOptions(
              baseUrl: AppConfig.apiBaseUrl,
              connectTimeout: const Duration(seconds: 12),
              receiveTimeout: const Duration(minutes: 3),
            ),
          ),
      audioPlayer: resolvedPlayer,
      ownsAudioPlayer: audioPlayer == null,
      onConversationBound: onConversationBound,
    );
  }

  AmbientRealtimeVoiceController._({
    required this._api,
    required this._sessionStore,
    required this._providerDio,
    required this._speechDio,
    required this._audioPlayer,
    required this._ownsAudioPlayer,
    this.onConversationBound,
  });

  final ApiClient _api;
  final SecureSessionStore _sessionStore;
  final Dio _providerDio;
  final Dio _speechDio;
  final AudioPlayer _audioPlayer;
  final bool _ownsAudioPlayer;
  final ValueChanged<String>? onConversationBound;

  AmbientRealtimeVoicePhase _phase = AmbientRealtimeVoicePhase.idle;
  AmbientRealtimeVoicePhase _phaseBeforeSpeech = AmbientRealtimeVoicePhase.idle;
  String _detail = 'Ready for a private voice command.';
  String? _errorMessage;
  String? _errorCode;
  String _sessionMode = 'orchestrate';
  String? _sessionLanguage;
  double _level = 0;
  bool _microphoneEnabled = true;
  bool _speechPlaying = false;
  bool _reviewAttested = false;
  bool _disposed = false;
  bool _sessionReported = false;
  bool _reconnectInFlight = false;
  bool _statsReadInFlight = false;
  int _generation = 0;
  int _speechGeneration = 0;
  int _reconnectCount = 0;
  DateTime? _sessionStartedAt;
  _VoiceSessionMetadata? _session;
  _TranscriptAccumulator _transcript = _TranscriptAccumulator.empty();
  RTCPeerConnection? _peer;
  RTCDataChannel? _dataChannel;
  MediaStream? _microphoneStream;
  Timer? _reconnectTimer;
  Timer? _maximumSessionTimer;
  Timer? _levelTimer;
  CancelToken? _providerCancel;
  CancelToken? _speechCancel;
  File? _speechFile;
  Future<void>? _sessionReportInFlight;

  AmbientRealtimeVoicePhase get phase => _phase;
  String get detail => _detail;
  String? get errorMessage => _errorMessage;
  String? get errorCode => _errorCode;
  double get level => _level;
  bool get microphoneEnabled => _microphoneEnabled;
  bool get isSpeechPlaying => _speechPlaying;
  bool get isListening => const {
    AmbientRealtimeVoicePhase.connecting,
    AmbientRealtimeVoicePhase.listening,
    AmbientRealtimeVoicePhase.speechDetected,
    AmbientRealtimeVoicePhase.reconnecting,
  }.contains(_phase);
  String get transcript => _transcript.text;
  String? get sessionId => _session?.sessionId;
  String? get conversationId => _session?.conversationId;
  int get turnCount => _transcript.turnCount;
  int get reconnectCount => _reconnectCount;
  bool get reviewAttested => _reviewAttested;

  AmbientVoiceConfidenceBand get confidenceBand => _transcript.confidence.band;
  double? get confidenceMean => _transcript.confidence.mean;
  double? get confidenceMinimum => _transcript.confidence.minimum;
  int get confidenceSampleCount => _transcript.confidence.sampleCount;
  bool get reviewRequired => _transcript.confidence.requiresExplicitAttestation;

  AmbientVoiceDraft get reviewDraft => AmbientVoiceDraft(
    text: transcript,
    sessionId: sessionId,
    conversationId: conversationId,
    confidenceBand: confidenceBand,
    confidenceMean: confidenceMean,
    confidenceMinimum: confidenceMinimum,
    confidenceSampleCount: confidenceSampleCount,
    reviewRequired: reviewRequired,
    reviewAttested: _reviewAttested,
    turnCount: turnCount,
    reconnectCount: _reconnectCount,
  );

  Future<void> start({
    String? conversationId,
    String mode = 'orchestrate',
    String? language,
    required bool providerConsent,
  }) async {
    _assertUsable();
    if (!providerConsent) {
      throw const AmbientVoiceException(
        'provider_consent_required',
        'Realtime voice starts only after provider processing is accepted.',
      );
    }
    if (!const {'orchestrate', 'research', 'execute', 'learn'}.contains(mode)) {
      throw ArgumentError.value(mode, 'mode');
    }
    final normalizedLanguage = _normalizedLanguage(language);
    final normalizedConversationId = conversationId?.trim();
    if (normalizedConversationId != null &&
        normalizedConversationId.isNotEmpty &&
        !_isUuid(normalizedConversationId)) {
      throw ArgumentError.value(conversationId, 'conversationId');
    }

    await _stopLocalTransport(stopMicrophone: true);
    await interruptSpeech();
    final generation = ++_generation;
    _resetForStart();
    _sessionMode = mode;
    _sessionLanguage = normalizedLanguage;
    _setPhase(
      AmbientRealtimeVoicePhase.requestingPermission,
      'Checking the microphone.',
    );
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
      if (!_isCurrent(generation)) {
        await _stopMediaStream(stream);
        return;
      }
      _microphoneStream = stream;
      _microphoneEnabled = true;
      _setPhase(AmbientRealtimeVoicePhase.connecting, 'Getting ready…');
      final credential = await _issueSession(
        reconnectAttempt: 0,
        mode: mode,
        language: normalizedLanguage,
        conversationId: normalizedConversationId,
      );
      if (!_isCurrent(generation)) return;
      _session = credential.metadata;
      _sessionStartedAt = DateTime.now().toUtc();
      onConversationBound?.call(credential.metadata.conversationId);
      await _connectPeer(credential, stream, generation);
      if (!_isCurrent(generation)) return;
      _maximumSessionTimer = Timer(
        const Duration(minutes: 10),
        () => unawaited(stopAndReview()),
      );
    } catch (error) {
      if (!_isCurrent(generation) || _isCanceled(error)) return;
      await _fail(
        _voiceStartMessage(error),
        code: 'realtime_voice_start_failed',
      );
    }
  }

  Future<void> stopAndReview() async {
    _assertUsable();
    if (!isListening) return;
    final generation = _generation;
    final activePhase = _phase;
    _setPhase(AmbientRealtimeVoicePhase.finishing, 'Finishing your request.');
    final channel = _dataChannel;
    if (channel?.state == RTCDataChannelState.RTCDataChannelOpen &&
        activePhase == AmbientRealtimeVoicePhase.speechDetected) {
      try {
        await channel!.send(
          RTCDataChannelMessage(
            jsonEncode(const {'type': 'input_audio_buffer.commit'}),
          ),
        );
      } catch (_) {
        // The server VAD may already have committed the final turn.
      }
    }
    for (final track in _microphoneStream?.getAudioTracks() ?? const []) {
      track.enabled = false;
    }
    await Future<void>.delayed(const Duration(milliseconds: 1200));
    if (!_isCurrent(generation)) return;
    await _stopLocalTransport(stopMicrophone: true);
    _setPhase(
      AmbientRealtimeVoicePhase.review,
      'Recognized request ready to send.',
    );
  }

  void editTranscript(String value) {
    _assertUsable();
    _transcript = _transcript.edited(value);
    _reviewAttested = false;
    _errorMessage = null;
    _phase = AmbientRealtimeVoicePhase.review;
    _detail = 'Recognized request confirmed.';
    _notify();
  }

  void attestReview(bool value) {
    _assertUsable();
    if (_phase != AmbientRealtimeVoicePhase.review) return;
    _reviewAttested = value;
    _errorMessage = null;
    _notify();
  }

  Future<void> setMicrophoneEnabled(bool enabled) async {
    _assertUsable();
    _microphoneEnabled = enabled;
    for (final track in _microphoneStream?.getAudioTracks() ?? const []) {
      track.enabled = enabled;
    }
    if (!enabled) {
      _level = 0;
      _detail = 'Microphone is off. This control does not need the network.';
    } else if (isListening) {
      _detail = 'Microphone is on. Listening for your command.';
    }
    _notify();
  }

  Future<void> micOff() => setMicrophoneEnabled(false);

  /// Completes the content-free session receipt. Call [attestReview] from the
  /// visible send action first; a spoken confirmation never satisfies it.
  Future<void> finish(AmbientVoiceOutcome outcome) async {
    _assertUsable();
    if (outcome == AmbientVoiceOutcome.sent && !_reviewAttested) {
      throw const AmbientVoiceException(
        'voice_review_required',
        'Confirm the visible transcript before sending it.',
      );
    }
    ++_generation;
    await _stopLocalTransport(stopMicrophone: true);
    await interruptSpeech();
    await _reportSession(outcome);
    if (!_disposed) {
      _setPhase(
        AmbientRealtimeVoicePhase.stopped,
        outcome == AmbientVoiceOutcome.sent
            ? 'Voice command sent through the governed conversation.'
            : outcome == AmbientVoiceOutcome.canceled
            ? 'Voice command canceled. Nothing was sent.'
            : 'Voice session ended without sending the draft.',
      );
    }
  }

  Future<void> cancel() async {
    if (_disposed) return;
    ++_generation;
    await _stopLocalTransport(stopMicrophone: true);
    await interruptSpeech();
    try {
      await _reportSession(AmbientVoiceOutcome.canceled);
    } catch (_) {
      // Cancel and mic-off stay local even when the receipt cannot be sent.
    }
    if (!_disposed) {
      _setPhase(
        AmbientRealtimeVoicePhase.stopped,
        'Voice command canceled. Nothing was sent.',
      );
    }
  }

  /// Speaks the configured Agent response. Raw PCM is validated, wrapped in a
  /// bounded temporary WAV, and erased immediately after playback or stop.
  Future<void> speak(
    String value, {
    String? threadId,
    String? runId,
    String? agentId,
  }) async {
    _assertUsable();
    final text = value.trim();
    if (text.isEmpty) {
      throw const AmbientVoiceException(
        'speech_empty',
        'There is no response to speak.',
      );
    }
    if (text.length > _maximumSpeechCharacters) {
      throw const AmbientVoiceException(
        'speech_too_long',
        'The spoken response is too long. Read it on screen or select a shorter passage.',
      );
    }
    _validateOptionalToken(agentId, 'agentId');
    _validateOptionalToken(runId, 'runId');
    if (threadId != null && !_isUuid(threadId)) {
      throw ArgumentError.value(threadId, 'threadId');
    }

    await interruptSpeech();
    final speechGeneration = ++_speechGeneration;
    final cancel = CancelToken();
    _speechCancel = cancel;
    _phaseBeforeSpeech = _phase;
    _speechPlaying = true;
    _setPhase(
      AmbientRealtimeVoicePhase.playingSpeech,
      'Speaking the configured Agent response. Stop interrupts immediately.',
    );
    try {
      for (final chunk in _speechChunks(text)) {
        if (!_isCurrentSpeech(speechGeneration)) return;
        final pcm = await _requestSpeechPcm(
          chunk,
          threadId: threadId,
          runId: runId,
          agentId: agentId,
          cancelToken: cancel,
        );
        if (!_isCurrentSpeech(speechGeneration)) return;
        final wav = _pcmToWave(pcm);
        final file = await _writeTemporarySpeech(wav);
        _speechFile = file;
        try {
          final completed = _audioPlayer.onPlayerComplete.first;
          await _audioPlayer.setReleaseMode(ReleaseMode.stop);
          await _audioPlayer.play(
            DeviceFileSource(file.path, mimeType: 'audio/wav'),
          );
          final audioDuration = Duration(
            milliseconds: math.max(
              1000,
              ((pcm.length / (_speechSampleRate * 2)) * 1000).ceil(),
            ),
          );
          await completed.timeout(audioDuration + const Duration(seconds: 15));
        } finally {
          if (identical(_speechFile, file)) _speechFile = null;
          await _deleteSpeechFile(file);
        }
      }
      if (_isCurrentSpeech(speechGeneration)) {
        _speechPlaying = false;
        _speechCancel = null;
        _setPhase(_restoredPhaseAfterSpeech(), 'Spoken response finished.');
      }
    } catch (error) {
      if (!_isCurrentSpeech(speechGeneration) || _isCanceled(error)) return;
      _speechPlaying = false;
      _speechCancel = null;
      _errorMessage = _speechErrorMessage(error);
      _setPhase(AmbientRealtimeVoicePhase.error, _errorMessage!);
      rethrow;
    } finally {
      if (_speechCancel == cancel) _speechCancel = null;
    }
  }

  Future<void> interruptSpeech() async {
    ++_speechGeneration;
    final cancel = _speechCancel;
    _speechCancel = null;
    if (cancel != null && !cancel.isCancelled) {
      cancel.cancel('speech_interrupted');
    }
    try {
      await _audioPlayer.stop();
    } catch (_) {
      // Local interruption is best effort across audio-device changes.
    }
    final file = _speechFile;
    _speechFile = null;
    if (file != null) await _deleteSpeechFile(file);
    final wasPlaying = _speechPlaying;
    _speechPlaying = false;
    if (wasPlaying && !_disposed) {
      _setPhase(
        _restoredPhaseAfterSpeech(),
        'Speech stopped. The on-screen result is unchanged.',
      );
    }
  }

  Future<_VoiceSessionCredential> _issueSession({
    required int reconnectAttempt,
    required String mode,
    required String? language,
    String? conversationId,
  }) async {
    final current = _session;
    final body = await _api.postJson(
      NativePaths.voiceRealtimeSessionStart,
      data: {
        if (reconnectAttempt > 0 && current != null) ...{
          'sessionId': current.sessionId,
          'conversationId': current.conversationId,
        } else if (conversationId != null && conversationId.isNotEmpty)
          'conversationId': conversationId,
        'mode': mode,
        'language': ?language,
        'providerConsent': true,
        'audioRetention': _audioRetention,
        'reconnectAttempt': reconnectAttempt,
      },
    );
    return _VoiceSessionCredential.parse(body);
  }

  Future<void> _connectPeer(
    _VoiceSessionCredential credential,
    MediaStream stream,
    int generation,
  ) async {
    await _closePeer();
    final peer = await createPeerConnection(const {});
    if (!_isCurrent(generation)) {
      await peer.dispose();
      return;
    }
    _peer = peer;
    for (final track in stream.getAudioTracks()) {
      await peer.addTrack(track, stream);
    }
    final channel = await peer.createDataChannel(
      'oai-events',
      RTCDataChannelInit()..ordered = true,
    );
    _dataChannel = channel;
    channel.onDataChannelState = (state) {
      if (!_isCurrent(generation) || !identical(_dataChannel, channel)) return;
      if (state == RTCDataChannelState.RTCDataChannelOpen) {
        _reconnectInFlight = false;
        _setPhase(
          AmbientRealtimeVoicePhase.listening,
          _microphoneEnabled ? 'Speak naturally.' : 'Microphone off.',
        );
      }
    };
    channel.onMessage = (message) {
      if (!_isCurrent(generation) || message.isBinary) return;
      _applyProviderMessage(message.text, generation);
    };
    peer.onConnectionState = (state) {
      if (!_isCurrent(generation) || !identical(_peer, peer)) return;
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
          state == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        _scheduleReconnect(generation);
      }
    };

    final offer = await peer.createOffer();
    final offerSdp = offer.sdp;
    if (offerSdp == null ||
        offerSdp.length > _maximumSdpCharacters ||
        !offerSdp.startsWith('v=0')) {
      throw const AmbientVoiceException(
        'invalid_voice_offer',
        'The Mac could not create a valid realtime audio offer.',
      );
    }
    await peer.setLocalDescription(offer);
    final localDescription = await _settledLocalDescription(peer);
    final sdp = localDescription?.sdp ?? offerSdp;
    if (sdp.length > _maximumSdpCharacters || !sdp.startsWith('v=0')) {
      throw const AmbientVoiceException(
        'invalid_voice_offer',
        'The Mac could not create a valid realtime audio offer.',
      );
    }
    final cancel = CancelToken();
    _providerCancel?.cancel('provider_exchange_replaced');
    _providerCancel = cancel;
    Response<String> response;
    try {
      response = await _providerDio.post<String>(
        credential.transportUrl,
        data: sdp,
        cancelToken: cancel,
        options: Options(
          contentType: 'application/sdp',
          responseType: ResponseType.plain,
          followRedirects: false,
          sendTimeout: const Duration(seconds: 12),
          receiveTimeout: const Duration(seconds: 20),
          headers: {'Authorization': 'Bearer ${credential.clientSecret}'},
          validateStatus: (status) =>
              status != null && status >= 200 && status < 300,
        ),
      );
    } on DioException catch (error) {
      throw ApiException.fromDio(error);
    } finally {
      if (_providerCancel == cancel) _providerCancel = null;
    }
    final answer = response.data ?? '';
    if (answer.isEmpty ||
        answer.length > _maximumSdpCharacters ||
        !answer.startsWith('v=0')) {
      throw const AmbientVoiceException(
        'invalid_voice_answer',
        'The realtime transcription provider returned an invalid audio answer.',
      );
    }
    if (!_isCurrent(generation) || !identical(_peer, peer)) return;
    await peer.setRemoteDescription(RTCSessionDescription(answer, 'answer'));
    _startLevelSampling(peer, stream);
    await _waitForDataChannel(channel, generation);
  }

  Future<RTCSessionDescription?> _settledLocalDescription(
    RTCPeerConnection peer,
  ) async {
    final deadline = DateTime.now().add(const Duration(seconds: 2));
    while (peer.iceGatheringState !=
            RTCIceGatheringState.RTCIceGatheringStateComplete &&
        DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 40));
    }
    return peer.getLocalDescription();
  }

  Future<void> _waitForDataChannel(
    RTCDataChannel channel,
    int generation,
  ) async {
    final deadline = DateTime.now().add(const Duration(seconds: 12));
    while (_isCurrent(generation) &&
        identical(_dataChannel, channel) &&
        channel.state != RTCDataChannelState.RTCDataChannelOpen &&
        DateTime.now().isBefore(deadline)) {
      if (channel.state == RTCDataChannelState.RTCDataChannelClosed) break;
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    if (!_isCurrent(generation) || !identical(_dataChannel, channel)) return;
    if (channel.state != RTCDataChannelState.RTCDataChannelOpen) {
      throw const AmbientVoiceException(
        'voice_connection_timeout',
        'Realtime voice took too long to connect.',
      );
    }
  }

  void _applyProviderMessage(String raw, int generation) {
    if (raw.length > _maximumProviderEventCharacters) return;
    Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } catch (_) {
      return;
    }
    if (decoded is! Map) return;
    final event = Map<String, dynamic>.from(decoded);
    final type = event['type'];
    if (type == 'input_audio_buffer.speech_started') {
      if (_speechPlaying) unawaited(interruptSpeech());
      _level = .48;
      _setPhase(AmbientRealtimeVoicePhase.speechDetected, 'Listening…');
      return;
    }
    if (type == 'input_audio_buffer.speech_stopped') {
      _level = .08;
      _setPhase(AmbientRealtimeVoicePhase.listening, 'Listening for more.');
      return;
    }
    if (type == 'error') {
      unawaited(
        _fail(
          'The realtime transcription provider reported an error.',
          code: 'provider_voice_error',
        ),
      );
      return;
    }
    final next = _transcript.applied(event);
    if (!identical(next, _transcript)) {
      _transcript = next;
      _reviewAttested = false;
      _errorMessage = null;
      if (_isCurrent(generation)) _notify();
    }
  }

  void _scheduleReconnect(int generation) {
    if (!isListening ||
        _reconnectInFlight ||
        _reconnectTimer != null ||
        !_isCurrent(generation)) {
      return;
    }
    _reconnectTimer = Timer(const Duration(milliseconds: 650), () {
      _reconnectTimer = null;
      unawaited(_reconnect(generation));
    });
  }

  Future<void> _reconnect(int generation) async {
    if (!_isCurrent(generation) || _reconnectInFlight || !isListening) return;
    final session = _session;
    final stream = _microphoneStream;
    if (session == null || stream == null) return;
    final attempt = _reconnectCount + 1;
    if (attempt > 3) {
      await _fail(
        'Realtime voice disconnected after three recovery attempts. Your visible draft is preserved.',
        code: 'voice_reconnect_exhausted',
      );
      return;
    }
    _reconnectInFlight = true;
    _reconnectCount = attempt;
    _setPhase(AmbientRealtimeVoicePhase.reconnecting, 'Reconnecting…');
    try {
      final credential = await _issueSession(
        reconnectAttempt: attempt,
        mode: _sessionMode,
        language: _sessionLanguage,
      );
      if (!_isCurrent(generation)) return;
      _session = credential.metadata;
      await _connectPeer(credential, stream, generation);
      _reconnectInFlight = false;
    } catch (error) {
      _reconnectInFlight = false;
      if (!_isCurrent(generation) || _isCanceled(error)) return;
      _reconnectTimer = Timer(
        Duration(milliseconds: math.min(2000, attempt * 500)),
        () {
          _reconnectTimer = null;
          unawaited(_reconnect(generation));
        },
      );
    }
  }

  void _startLevelSampling(RTCPeerConnection peer, MediaStream stream) {
    _levelTimer?.cancel();
    final track = stream.getAudioTracks().firstOrNull;
    if (track == null) return;
    _levelTimer = Timer.periodic(const Duration(milliseconds: 140), (_) async {
      if (_statsReadInFlight ||
          !_microphoneEnabled ||
          !identical(_peer, peer)) {
        return;
      }
      _statsReadInFlight = true;
      try {
        final reports = await peer.getStats(track);
        final measured = _audioLevelFrom(reports);
        if (measured != null && identical(_peer, peer) && !_disposed) {
          _level = (_level * .5 + measured * .5).clamp(0.0, 1.0);
          _notify();
        }
      } catch (_) {
        // The animated surface can continue with the most recent VAD level.
      } finally {
        _statsReadInFlight = false;
      }
    });
  }

  double? _audioLevelFrom(List<StatsReport> reports) {
    double? result;
    for (final report in reports) {
      final raw =
          report.values['audioLevel'] ?? report.values['audioInputLevel'];
      if (raw is! num || !raw.isFinite) continue;
      final normalized = raw > 1 ? raw / 32767 : raw.toDouble();
      result = math.max(result ?? 0, normalized.clamp(0.0, 1.0));
    }
    return result;
  }

  Future<void> _reportSession(AmbientVoiceOutcome outcome) async {
    if (_sessionReported) return;
    final existing = _sessionReportInFlight;
    if (existing != null) return existing;
    final receipt = _finishReceipt(outcome);
    if (receipt == null) return;
    final request = _sendFinishReceipt(receipt);
    _sessionReportInFlight = request;
    try {
      await request;
      _sessionReported = true;
    } finally {
      if (identical(_sessionReportInFlight, request)) {
        _sessionReportInFlight = null;
      }
    }
  }

  Map<String, dynamic>? _finishReceipt(AmbientVoiceOutcome outcome) {
    final session = _session;
    if (session == null) return null;
    final confidence = _transcript.confidence;
    final startedAt = _sessionStartedAt;
    final duration = startedAt == null
        ? 0
        : DateTime.now().toUtc().difference(startedAt).inMilliseconds;
    return {
      'sessionId': session.sessionId,
      'conversationId': session.conversationId,
      'outcome': outcome.name,
      'durationMilliseconds': duration.clamp(0, 10 * 60 * 1000),
      'turnCount': _transcript.turnCount.clamp(0, 1000),
      'reconnectCount': _reconnectCount.clamp(0, 3),
      'transcriptCharacters': _transcript.text.length.clamp(
        0,
        _maximumTranscriptCharacters,
      ),
      'confidenceBand': confidence.band.name,
      if (confidence.mean != null) 'confidenceMean': confidence.mean,
      if (confidence.minimum != null) 'confidenceMinimum': confidence.minimum,
      'confidenceSampleCount': confidence.sampleCount.clamp(0, 10000),
      'reviewRequired': confidence.requiresExplicitAttestation,
      'reviewAttested': _reviewAttested,
    };
  }

  Future<void> _sendFinishReceipt(Map<String, dynamic> receipt) async {
    await _api.patchJson(NativePaths.voiceRealtimeSessionFinish, data: receipt);
  }

  Future<Uint8List> _requestSpeechPcm(
    String text, {
    required String? threadId,
    required String? runId,
    required String? agentId,
    required CancelToken cancelToken,
  }) async {
    for (var attempt = 0; attempt < 2; attempt += 1) {
      if (attempt == 0 && await _sessionStore.accessTokenNeedsRefresh()) {
        await _api.getJsonFresh(NativePaths.bootstrapGet);
      }
      final token = await _sessionStore.readToken();
      if (token == null || token.isEmpty) {
        throw const AmbientVoiceException(
          'native_session_missing',
          'Sign in again before using spoken responses.',
        );
      }
      Response<ResponseBody> response;
      try {
        response = await _speechDio.post<ResponseBody>(
          NativePaths.voiceSpeechStream,
          data: {
            'text': text,
            'agentId': ?agentId,
            'threadId': ?threadId,
            'runId': ?runId,
            'voiceProfileVersion': _voiceProfileVersion,
            'audioRetention': _audioRetention,
          },
          cancelToken: cancelToken,
          options: Options(
            responseType: ResponseType.stream,
            contentType: Headers.jsonContentType,
            followRedirects: false,
            headers: {
              ...NativeClientInfo.attestationHeaders(),
              'Authorization': 'Bearer $token',
              'Accept': 'audio/pcm',
            },
            validateStatus: (status) => status != null,
          ),
        );
      } on DioException catch (error) {
        if (CancelToken.isCancel(error)) rethrow;
        throw ApiException.fromDio(error);
      }
      final body = response.data;
      if (body == null) {
        throw const AmbientVoiceException(
          'speech_empty_response',
          'The speech service returned an empty response.',
        );
      }
      final status = response.statusCode ?? 0;
      if (status == 401 && attempt == 0) {
        await _readBounded(
          body.stream,
          64 * 1024,
        ).catchError((Object _) => Uint8List(0));
        await _api.getJsonFresh(NativePaths.bootstrapGet);
        continue;
      }
      if (status < 200 || status >= 300) {
        final errorBytes = await _readBounded(body.stream, 64 * 1024);
        throw AmbientVoiceException(
          'speech_request_failed',
          _speechHttpError(errorBytes, status),
        );
      }
      try {
        _validateSpeechHeaders(response.headers);
      } catch (_) {
        await _readBounded(
          body.stream,
          64 * 1024,
        ).catchError((Object _) => Uint8List(0));
        rethrow;
      }
      final bytes = await _readBounded(body.stream, _maximumSpeechPcmBytes);
      if (bytes.isEmpty || bytes.length.isOdd) {
        throw const AmbientVoiceException(
          'speech_invalid_pcm',
          'The configured speech service returned invalid PCM audio.',
        );
      }
      return bytes;
    }
    throw const AmbientVoiceException(
      'speech_auth_failed',
      'The authenticated speech session could not be refreshed.',
    );
  }

  void _validateSpeechHeaders(Headers headers) {
    final contentType = headers
        .value(Headers.contentTypeHeader)
        ?.split(';')
        .first
        .trim();
    final retention = headers.value('x-asael-audio-retention');
    final encoding = headers.value('x-asael-audio-encoding');
    final sampleRate = headers.value('x-asael-audio-sample-rate');
    final profile = headers.value('x-asael-voice-profile');
    final profileDigest = headers.value('x-asael-voice-profile-sha256') ?? '';
    if (contentType != 'audio/pcm' ||
        retention != _audioRetention ||
        encoding != _speechEncoding ||
        sampleRate != '$_speechSampleRate' ||
        profile != _voiceProfileVersion ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(profileDigest)) {
      throw const AmbientVoiceException(
        'speech_contract_mismatch',
        'The speech stream did not match Asael\'s active voice profile.',
      );
    }
  }

  Future<Uint8List> _readBounded(
    Stream<Uint8List> stream,
    int maximumBytes,
  ) async {
    final builder = BytesBuilder(copy: false);
    await for (final chunk in stream) {
      if (builder.length + chunk.length > maximumBytes) {
        throw const AmbientVoiceException(
          'voice_response_too_large',
          'The voice response exceeded the safe playback limit.',
        );
      }
      builder.add(chunk);
    }
    return builder.takeBytes();
  }

  Uint8List _pcmToWave(Uint8List pcm) {
    final result = Uint8List(44 + pcm.length);
    final bytes = ByteData.sublistView(result);
    void ascii(int offset, String value) {
      for (var index = 0; index < value.length; index += 1) {
        result[offset + index] = value.codeUnitAt(index);
      }
    }

    ascii(0, 'RIFF');
    bytes.setUint32(4, 36 + pcm.length, Endian.little);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    bytes.setUint32(16, 16, Endian.little);
    bytes.setUint16(20, 1, Endian.little);
    bytes.setUint16(22, 1, Endian.little);
    bytes.setUint32(24, _speechSampleRate, Endian.little);
    bytes.setUint32(28, _speechSampleRate * 2, Endian.little);
    bytes.setUint16(32, 2, Endian.little);
    bytes.setUint16(34, 16, Endian.little);
    ascii(36, 'data');
    bytes.setUint32(40, pcm.length, Endian.little);
    result.setRange(44, result.length, pcm);
    return result;
  }

  Future<File> _writeTemporarySpeech(Uint8List wav) async {
    final temporary = await getTemporaryDirectory();
    final directory = Directory('${temporary.path}/asael-ephemeral-speech');
    await directory.create(recursive: true);
    await _purgeTemporarySpeech(directory);
    final random = math.Random.secure().nextInt(0x7fffffff);
    final file = File(
      '${directory.path}/speech-${DateTime.now().microsecondsSinceEpoch}-$random.wav',
    );
    await file.writeAsBytes(wav, flush: true);
    return file;
  }

  Future<void> _purgeTemporarySpeech(Directory directory) async {
    try {
      await for (final entity in directory.list(followLinks: false)) {
        if (entity is File && entity.path.endsWith('.wav')) {
          await entity.delete().catchError((Object _) => entity);
        }
      }
    } catch (_) {
      // Playback still deletes its exact file in a finally block.
    }
  }

  Future<void> _deleteSpeechFile(File file) async {
    try {
      if (await file.exists()) await file.delete();
    } catch (_) {
      // The next temporary-directory cleanup can recover a locked audio file.
    }
  }

  Future<void> _fail(String message, {required String code}) async {
    if (_disposed) return;
    ++_generation;
    await _stopLocalTransport(stopMicrophone: true);
    try {
      await _reportSession(AmbientVoiceOutcome.failed);
    } catch (_) {
      // The visible failure remains actionable if the receipt is unavailable.
    }
    _errorCode = code;
    _errorMessage = message;
    _setPhase(AmbientRealtimeVoicePhase.error, message);
  }

  Future<void> _stopLocalTransport({required bool stopMicrophone}) async {
    _maximumSessionTimer?.cancel();
    _maximumSessionTimer = null;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _levelTimer?.cancel();
    _levelTimer = null;
    _providerCancel?.cancel('voice_transport_stopped');
    _providerCancel = null;
    _reconnectInFlight = false;
    await _closePeer();
    if (stopMicrophone) {
      final stream = _microphoneStream;
      _microphoneStream = null;
      if (stream != null) await _stopMediaStream(stream);
      _microphoneEnabled = false;
    }
    _level = 0;
  }

  Future<void> _closePeer() async {
    final channel = _dataChannel;
    _dataChannel = null;
    final peer = _peer;
    _peer = null;
    try {
      await channel?.close();
    } catch (_) {}
    try {
      await peer?.close();
    } catch (_) {}
    try {
      await peer?.dispose();
    } catch (_) {}
  }

  Future<void> _stopMediaStream(MediaStream stream) async {
    for (final track in stream.getTracks()) {
      try {
        await track.stop();
      } catch (_) {}
    }
    try {
      await stream.dispose();
    } catch (_) {}
  }

  void _resetForStart() {
    _phase = AmbientRealtimeVoicePhase.idle;
    _detail = 'Ready for a private voice command.';
    _errorMessage = null;
    _errorCode = null;
    _level = 0;
    _reviewAttested = false;
    _sessionReported = false;
    _reconnectCount = 0;
    _sessionStartedAt = null;
    _session = null;
    _sessionMode = 'orchestrate';
    _sessionLanguage = null;
    _transcript = _TranscriptAccumulator.empty();
  }

  AmbientRealtimeVoicePhase _restoredPhaseAfterSpeech() {
    if (_phaseBeforeSpeech == AmbientRealtimeVoicePhase.playingSpeech ||
        _phaseBeforeSpeech == AmbientRealtimeVoicePhase.error) {
      return transcript.isEmpty
          ? AmbientRealtimeVoicePhase.stopped
          : AmbientRealtimeVoicePhase.review;
    }
    return _phaseBeforeSpeech;
  }

  void _setPhase(AmbientRealtimeVoicePhase phase, String detail) {
    if (_disposed) return;
    _phase = phase;
    _detail = detail;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  bool _isCurrent(int generation) => !_disposed && generation == _generation;

  bool _isCurrentSpeech(int generation) =>
      !_disposed && generation == _speechGeneration;

  void _assertUsable() {
    if (_disposed) throw StateError('Ambient voice controller is disposed.');
  }

  @override
  void dispose() {
    if (_disposed) return;
    final stream = _microphoneStream;
    final channel = _dataChannel;
    final peer = _peer;
    final file = _speechFile;
    final reportInFlight = _sessionReportInFlight;
    final canceledReceipt = _sessionReported
        ? null
        : _finishReceipt(AmbientVoiceOutcome.canceled);
    _disposed = true;
    ++_generation;
    ++_speechGeneration;
    _maximumSessionTimer?.cancel();
    _reconnectTimer?.cancel();
    _levelTimer?.cancel();
    _providerCancel?.cancel('voice_controller_disposed');
    _speechCancel?.cancel('voice_controller_disposed');
    _microphoneStream = null;
    _dataChannel = null;
    _peer = null;
    _speechFile = null;
    for (final track in stream?.getTracks() ?? const []) {
      track.enabled = false;
    }
    unawaited(
      _disposeCapturedResources(
        stream: stream,
        channel: channel,
        peer: peer,
        file: file,
        reportInFlight: reportInFlight,
        canceledReceipt: canceledReceipt,
      ),
    );
    super.dispose();
  }

  Future<void> _disposeCapturedResources({
    required MediaStream? stream,
    required RTCDataChannel? channel,
    required RTCPeerConnection? peer,
    required File? file,
    required Future<void>? reportInFlight,
    required Map<String, dynamic>? canceledReceipt,
  }) async {
    try {
      await channel?.close();
    } catch (_) {}
    try {
      await peer?.close();
    } catch (_) {}
    try {
      await peer?.dispose();
    } catch (_) {}
    if (stream != null) await _stopMediaStream(stream);
    try {
      await _audioPlayer.stop();
    } catch (_) {}
    if (_ownsAudioPlayer) {
      try {
        await _audioPlayer.dispose();
      } catch (_) {}
    }
    if (file != null) await _deleteSpeechFile(file);
    if (reportInFlight != null) {
      try {
        await reportInFlight.timeout(const Duration(seconds: 5));
        return;
      } on TimeoutException {
        // The request may still complete; do not emit a competing outcome.
        return;
      } catch (_) {
        // A failed in-flight receipt can fall through to the canceled receipt.
      }
    }
    if (canceledReceipt != null) {
      try {
        await _sendFinishReceipt(canceledReceipt)
            .timeout(const Duration(seconds: 5));
      } catch (_) {
        // Disposal is local and cannot be held open by an unavailable network.
      }
    }
  }
}

@immutable
class _VoiceSessionMetadata {
  const _VoiceSessionMetadata({
    required this.sessionId,
    required this.conversationId,
  });

  final String sessionId;
  final String conversationId;
}

@immutable
class _VoiceSessionCredential {
  const _VoiceSessionCredential({
    required this.metadata,
    required this.clientSecret,
    required this.transportUrl,
  });

  factory _VoiceSessionCredential.parse(Map<String, dynamic> value) {
    final sessionId = value['sessionId'];
    final conversationId = value['conversationId'];
    final clientSecret = value['clientSecret'];
    final expiresAt = value['clientSecretExpiresAt'];
    final transportUrl = value['transportUrl'];
    final language = value['language'];
    final reconnectAttempt = value['reconnectAttempt'];
    if (value['schemaVersion'] != 1 ||
        !_isUuid(sessionId) ||
        !_isUuid(conversationId) ||
        clientSecret is! String ||
        clientSecret.length < 4 ||
        clientSecret.length > 4096 ||
        !RegExp(r'^ek_[A-Za-z0-9._:@/+~-]+$').hasMatch(clientSecret) ||
        expiresAt is! int ||
        expiresAt <= 0 ||
        transportUrl != _realtimeTransportUrl ||
        value['provider'] != 'openai' ||
        value['model'] is! String ||
        (value['model'] as String).trim().isEmpty ||
        (value['model'] as String).length > 240 ||
        (language != 'auto' &&
            (language is! String ||
                !RegExp(r'^[a-z]{2}$').hasMatch(language))) ||
        value['turnDetection'] != 'server_vad' ||
        value['audioRetention'] != _audioRetention ||
        value['transcriptRetention'] != _transcriptRetention ||
        reconnectAttempt is! int ||
        reconnectAttempt < 0 ||
        reconnectAttempt > 3) {
      throw const AmbientVoiceException(
        'invalid_voice_session',
        'The realtime session response was invalid.',
      );
    }
    return _VoiceSessionCredential(
      metadata: _VoiceSessionMetadata(
        sessionId: sessionId as String,
        conversationId: conversationId as String,
      ),
      clientSecret: clientSecret,
      transportUrl: transportUrl as String,
    );
  }

  final _VoiceSessionMetadata metadata;
  final String clientSecret;
  final String transportUrl;
}

@immutable
class _TranscriptConfidence {
  const _TranscriptConfidence({
    required this.band,
    required this.sampleCount,
    required this.requiresExplicitAttestation,
    this.mean,
    this.minimum,
  });

  final AmbientVoiceConfidenceBand band;
  final double? mean;
  final double? minimum;
  final int sampleCount;
  final bool requiresExplicitAttestation;
}

@immutable
class _ItemConfidence {
  const _ItemConfidence({
    required this.mean,
    required this.minimum,
    required this.sampleCount,
  });

  final double mean;
  final double minimum;
  final int sampleCount;
}

@immutable
class _TranscriptAccumulator {
  const _TranscriptAccumulator({
    required this.manualText,
    required this.itemOrder,
    required this.itemText,
    required this.itemConfidence,
    required this.completedItems,
    required this.ignoredItems,
    required this.turnCount,
    required this.manuallyEdited,
  });

  factory _TranscriptAccumulator.empty() => const _TranscriptAccumulator(
    manualText: '',
    itemOrder: [],
    itemText: {},
    itemConfidence: {},
    completedItems: {},
    ignoredItems: {},
    turnCount: 0,
    manuallyEdited: false,
  );

  final String manualText;
  final List<String> itemOrder;
  final Map<String, String> itemText;
  final Map<String, _ItemConfidence> itemConfidence;
  final Set<String> completedItems;
  final Set<String> ignoredItems;
  final int turnCount;
  final bool manuallyEdited;

  String get text {
    var result = manualText;
    for (final itemId in itemOrder) {
      result = _joinTranscript(result, itemText[itemId] ?? '');
      if (result.length >= _maximumTranscriptCharacters) {
        return result.substring(0, _maximumTranscriptCharacters);
      }
    }
    return result;
  }

  _TranscriptConfidence get confidence {
    if (manuallyEdited) {
      return const _TranscriptConfidence(
        band: AmbientVoiceConfidenceBand.edited,
        sampleCount: 0,
        requiresExplicitAttestation: true,
      );
    }
    final summaries = [for (final itemId in itemOrder) ?itemConfidence[itemId]];
    final sampleCount = summaries.fold<int>(
      0,
      (total, value) => total + value.sampleCount,
    );
    if (sampleCount == 0) {
      return const _TranscriptConfidence(
        band: AmbientVoiceConfidenceBand.unavailable,
        sampleCount: 0,
        requiresExplicitAttestation: true,
      );
    }
    final mean =
        summaries.fold<double>(
          0,
          (total, value) => total + value.mean * value.sampleCount,
        ) /
        sampleCount;
    final minimum = summaries.map((value) => value.minimum).reduce(math.min);
    final high = mean >= .65 && minimum >= .1;
    return _TranscriptConfidence(
      band: high
          ? AmbientVoiceConfidenceBand.high
          : AmbientVoiceConfidenceBand.low,
      mean: _roundConfidence(mean),
      minimum: _roundConfidence(minimum),
      sampleCount: sampleCount,
      requiresExplicitAttestation: !high,
    );
  }

  _TranscriptAccumulator applied(Map<String, dynamic> event) {
    final type = event['type'];
    if (type != 'conversation.item.input_audio_transcription.delta' &&
        type != 'conversation.item.input_audio_transcription.completed') {
      return this;
    }
    final itemId = _safeItemId(event['item_id']);
    if (itemId == null || ignoredItems.contains(itemId)) return this;
    final completed =
        type == 'conversation.item.input_audio_transcription.completed';
    if (!completed && completedItems.contains(itemId)) return this;
    final content = _safeTranscriptText(
      completed ? event['transcript'] : event['delta'],
      completed ? _maximumTranscriptCharacters : 8000,
    );
    if (content.isEmpty) return this;
    final nextOrder = itemOrder.contains(itemId)
        ? [...itemOrder]
        : [...itemOrder, itemId].take(1000).toList(growable: false);
    final nextText = {...itemText};
    nextText[itemId] = completed
        ? content
        : '${nextText[itemId] ?? ''}$content'.substring(
            0,
            math.min(
              _maximumTranscriptCharacters,
              (nextText[itemId]?.length ?? 0) + content.length,
            ),
          );
    final nextCompleted = {...completedItems};
    final nextConfidence = {...itemConfidence};
    if (completed) {
      nextCompleted.add(itemId);
      final confidence = _confidenceFromLogprobs(event['logprobs']);
      if (confidence != null) nextConfidence[itemId] = confidence;
    }
    final next = _TranscriptAccumulator(
      manualText: manualText,
      itemOrder: nextOrder,
      itemText: nextText,
      itemConfidence: nextConfidence,
      completedItems: nextCompleted,
      ignoredItems: {...ignoredItems},
      turnCount: completed ? math.min(1000, turnCount + 1) : turnCount,
      manuallyEdited: manuallyEdited,
    );
    return next.text.length <= _maximumTranscriptCharacters
        ? next
        : next.edited(next.text);
  }

  _TranscriptAccumulator edited(String value) => _TranscriptAccumulator(
    manualText: _safeTranscriptText(value, _maximumTranscriptCharacters),
    itemOrder: const [],
    itemText: const {},
    itemConfidence: const {},
    completedItems: const {},
    ignoredItems: {...ignoredItems, ...itemOrder}.take(1000).toSet(),
    turnCount: turnCount,
    manuallyEdited: true,
  );
}

_ItemConfidence? _confidenceFromLogprobs(Object? value) {
  if (value is! List) return null;
  final probabilities = <double>[];
  for (final entry in value.take(10000)) {
    if (entry is! Map || entry['logprob'] is! num) continue;
    final logprob = (entry['logprob'] as num).toDouble();
    if (!logprob.isFinite || logprob > 0) continue;
    probabilities.add(math.exp(math.max(-100, logprob)));
  }
  if (probabilities.isEmpty) return null;
  return _ItemConfidence(
    mean: probabilities.reduce((a, b) => a + b) / probabilities.length,
    minimum: probabilities.reduce(math.min),
    sampleCount: probabilities.length,
  );
}

Iterable<String> _speechChunks(String value) sync* {
  var remaining = value.trim();
  while (remaining.length > _maximumSpeechChunkCharacters) {
    final window = remaining.substring(0, _maximumSpeechChunkCharacters + 1);
    final sentence = [
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('\n'),
    ].reduce(math.max);
    final whitespace = window.lastIndexOf(' ');
    final boundary = sentence >= (_maximumSpeechChunkCharacters * .55).floor()
        ? sentence + (window[sentence] == '\n' ? 0 : 1)
        : whitespace > 0
        ? whitespace
        : _maximumSpeechChunkCharacters;
    yield remaining.substring(0, boundary).trim();
    remaining = remaining.substring(boundary).trim();
  }
  if (remaining.isNotEmpty) yield remaining;
}

String? _normalizedLanguage(String? value) {
  final normalized = value?.trim().toLowerCase();
  if (normalized == null || normalized.isEmpty || normalized == 'auto') {
    return null;
  }
  if (!RegExp(r'^[a-z]{2}$').hasMatch(normalized)) {
    throw ArgumentError.value(value, 'language');
  }
  return normalized;
}

void _validateOptionalToken(String? value, String name) {
  if (value == null) return;
  if (!RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$').hasMatch(value)) {
    throw ArgumentError.value(value, name);
  }
}

bool _isUuid(Object? value) =>
    value is String &&
    RegExp(
      r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      caseSensitive: false,
    ).hasMatch(value);

String? _safeItemId(Object? value) {
  if (value is! String) return null;
  final normalized = value.trim();
  return RegExp(r'^[A-Za-z0-9_:-]{1,200}$').hasMatch(normalized)
      ? normalized
      : null;
}

String _safeTranscriptText(Object? value, int maximum) {
  if (value is! String) return '';
  final safe = value.replaceAll(
    RegExp(r'[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]'),
    '',
  );
  return safe.substring(0, math.min(maximum, safe.length));
}

String _joinTranscript(String current, String next) {
  if (next.isEmpty) return current;
  if (current.isEmpty) return next;
  if (RegExp(r'\s$').hasMatch(current) ||
      RegExp(r'^\s|^[,.;:!?)]').hasMatch(next)) {
    return '$current$next';
  }
  return '$current $next';
}

double _roundConfidence(double value) =>
    (value * 10000).roundToDouble() / 10000;

bool _isCanceled(Object error) =>
    error is DioException && CancelToken.isCancel(error);

String _voiceStartMessage(Object error) {
  if (error is AmbientVoiceException) return error.message;
  if (error is ApiException) return error.message;
  final text = error.toString().toLowerCase();
  if (text.contains('permission') || text.contains('notallowed')) {
    return 'Microphone access is blocked. Allow Asael in System Settings → Privacy & Security → Microphone.';
  }
  if (text.contains('device') || text.contains('notfound')) {
    return 'No available microphone was found.';
  }
  return 'Realtime voice could not start. Nothing was sent.';
}

String _speechErrorMessage(Object error) {
  if (error is AmbientVoiceException) return error.message;
  if (error is ApiException) return error.message;
  return 'The configured spoken response could not be played.';
}

String _speechHttpError(Uint8List bytes, int status) {
  try {
    final value = jsonDecode(utf8.decode(bytes, allowMalformed: true));
    if (value is Map && value['error'] is String) {
      return (value['error'] as String).substring(
        0,
        math.min(500, (value['error'] as String).length),
      );
    }
  } catch (_) {}
  return 'Speech playback failed ($status).';
}
