import 'dart:convert';

import 'package:cryptography/cryptography.dart' show Sha256;
import 'package:flutter/services.dart';

import '../../core/storage/secure_session_store.dart';

/// Whether the signed-in owner agreed that OpenAI may process live microphone
/// audio for Ambient Command, which Asael does not store.
abstract interface class AmbientVoiceConsent {
  Future<bool> accepted();

  Future<void> accept();
}

/// A non-secret, owner-scoped preference shared by the Mac app's windows.
/// The frozen credential broker accepts credential keys only, not preferences.
class MacOsAmbientVoiceConsent implements AmbientVoiceConsent {
  static const conversationTerms =
      'openai:continuous_conversation:audio_not_stored_by_asael:conversation_history:v2';
  const MacOsAmbientVoiceConsent({
    required this.tenantId,
    required this.actorId,
    MethodChannel channel = const MethodChannel(
      'app.omniagent.omniagent/desktop',
    ),
  }) : _channel = channel;

  final String tenantId;
  final String actorId;
  final MethodChannel _channel;

  Future<Map<String, String>> _arguments() async {
    if (tenantId.trim().isEmpty || actorId.trim().isEmpty) {
      throw ArgumentError('An Ambient Command agreement needs its owner.');
    }
    final digest = await Sha256().hash(
      utf8.encode(jsonEncode([tenantId, actorId])),
    );
    return {
      'ownerDigest': base64UrlEncode(digest.bytes).replaceAll('=', ''),
      'terms': conversationTerms,
    };
  }

  Future<bool> _invoke(String method) async =>
      await _channel
          .invokeMethod<bool>(method, await _arguments())
          .timeout(const Duration(seconds: 5)) ==
      true;

  @override
  Future<bool> accepted() => _invoke('getAmbientVoiceConsent');

  @override
  Future<void> accept() async {
    if (!await _invoke('acceptAmbientVoiceConsent')) {
      throw StateError('The voice agreement could not be saved.');
    }
  }

  @override
  bool operator ==(Object other) =>
      other is MacOsAmbientVoiceConsent &&
      identical(other._channel, _channel) &&
      other.tenantId == tenantId &&
      other.actorId == actorId;

  @override
  int get hashCode =>
      Object.hash(identityHashCode(_channel), tenantId, actorId);
}

/// Keeps one owner's agreement in this device's secure store.
class SecureAmbientVoiceConsent implements AmbientVoiceConsent {
  const SecureAmbientVoiceConsent(
    this._store, {
    required this.tenantId,
    required this.actorId,
  });

  final SecureSessionStore _store;
  final String tenantId;
  final String actorId;

  @override
  Future<bool> accepted() =>
      _store.readAmbientVoiceConsent(tenantId: tenantId, actorId: actorId);

  @override
  Future<void> accept() =>
      _store.writeAmbientVoiceConsent(tenantId: tenantId, actorId: actorId);

  @override
  bool operator ==(Object other) =>
      other is SecureAmbientVoiceConsent &&
      identical(other._store, _store) &&
      other.tenantId == tenantId &&
      other.actorId == actorId;

  @override
  int get hashCode => Object.hash(identityHashCode(_store), tenantId, actorId);
}
