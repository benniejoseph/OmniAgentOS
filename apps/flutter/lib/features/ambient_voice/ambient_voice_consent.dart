import '../../core/storage/secure_session_store.dart';

/// Whether the signed-in owner agreed that OpenAI may process live microphone
/// audio for Ambient Command, which Asael does not store.
abstract interface class AmbientVoiceConsent {
  Future<bool> accepted();

  Future<void> accept();
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
