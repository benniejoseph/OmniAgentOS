import 'package:flutter/foundation.dart';

import '../ambient_voice/realtime_voice_controller.dart';

final _voiceUuidPattern = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  caseSensitive: false,
);

/// The reviewed realtime voice declaration one Ambient Voice command carries.
///
/// It exists only after the transcript review was attested: by the visible
/// Send action for a confidently recognized transcript, or by its review
/// checkbox for any other. The command it rides on is pinned to the voice
/// conversation. The server never trusts it alone: an unmarked command that
/// arrives while a voice session is still open on the conversation is held
/// for approval too.
@immutable
class TalkVoiceInput {
  const TalkVoiceInput._({
    required this.sessionId,
    required this.conversationId,
    required this.confidenceBand,
    required this.confidenceSampleCount,
    required this.reviewRequired,
    this.confidenceMean,
    this.confidenceMinimum,
    this.turnId,
    this.commandContext,
  });

  final String sessionId;
  final String conversationId;
  final AmbientVoiceConfidenceBand confidenceBand;
  final double? confidenceMean;
  final double? confidenceMinimum;
  final int confidenceSampleCount;

  /// Whether the transcript needed its review checkbox, not Send alone.
  final bool reviewRequired;
  final String? turnId;
  final Map<String, dynamic>? commandContext;
  bool get continuous => turnId != null;

  /// A provider function call carries continuous-consent provenance, never a
  /// fabricated transcript-review attestation. The server rechecks its pin.
  factory TalkVoiceInput.conversation({
    required String sessionId,
    required String conversationId,
    required String turnId,
    required Map<String, dynamic> commandContext,
  }) {
    if (!_voiceUuidPattern.hasMatch(sessionId) ||
        !_voiceUuidPattern.hasMatch(conversationId) ||
        !RegExp(r'^[A-Za-z0-9_-]{1,160}$').hasMatch(turnId)) {
      throw const FormatException('This voice request could not be verified.');
    }
    return TalkVoiceInput._(
      sessionId: sessionId,
      conversationId: conversationId,
      turnId: turnId,
      commandContext: Map.unmodifiable(commandContext),
      confidenceBand: AmbientVoiceConfidenceBand.unavailable,
      confidenceSampleCount: 0,
      reviewRequired: false,
    );
  }

  /// Returns null unless the draft names the minted session and conversation
  /// and its transcript review was attested.
  static TalkVoiceInput? fromReviewedDraft(AmbientVoiceDraft draft) {
    final sessionId = draft.sessionId;
    final conversationId = draft.conversationId;
    if (!draft.reviewAttested ||
        sessionId == null ||
        conversationId == null ||
        !_voiceUuidPattern.hasMatch(sessionId) ||
        !_voiceUuidPattern.hasMatch(conversationId)) {
      return null;
    }
    return TalkVoiceInput._(
      sessionId: sessionId,
      conversationId: conversationId,
      confidenceBand: draft.confidenceBand,
      confidenceMean: _unitInterval(draft.confidenceMean),
      confidenceMinimum: _unitInterval(draft.confidenceMinimum),
      confidenceSampleCount: draft.confidenceSampleCount.clamp(0, 10000),
      reviewRequired: draft.reviewRequired,
    );
  }

  Map<String, Object?> toRequestJson() => continuous
      ? {
          'schemaVersion': 2,
          'source': 'realtime_voice',
          'sessionId': sessionId,
          'conversationId': conversationId,
          'provider': 'openai',
          'turnId': turnId,
        }
      : {
          'schemaVersion': 1,
          'source': 'realtime_voice',
          'sessionId': sessionId,
          'conversationId': conversationId,
          'provider': 'openai',
          'confidenceBand': confidenceBand.name,
          'confidenceMean': ?confidenceMean,
          'confidenceMinimum': ?confidenceMinimum,
          'confidenceSampleCount': confidenceSampleCount,
          'reviewMethod': reviewRequired ? 'explicit_checkbox' : 'send_button',
          'reviewAttested': true,
        };
}

double? _unitInterval(double? value) =>
    value == null || !value.isFinite ? null : value.clamp(0.0, 1.0);
