import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';

enum BiometricGateFailure { unavailable, notRecognized }

class BiometricGateException implements Exception {
  const BiometricGateException(this.failure);

  final BiometricGateFailure failure;

  @override
  String toString() => switch (failure) {
    BiometricGateFailure.unavailable =>
      'Biometric unlock is enabled, but no enrolled biometric is available.',
    BiometricGateFailure.notRecognized =>
      'Biometric unlock was canceled or could not be verified.',
  };
}

abstract interface class BiometricGate {
  Future<bool> isAvailable();

  Future<void> authenticate();
}

class LocalBiometricGate implements BiometricGate {
  LocalBiometricGate([LocalAuthentication? authentication])
    : _authentication = authentication ?? LocalAuthentication();

  final LocalAuthentication _authentication;

  @override
  Future<bool> isAvailable() async {
    try {
      if (!await _authentication.canCheckBiometrics) return false;
      return (await _authentication.getAvailableBiometrics()).isNotEmpty;
    } on LocalAuthException {
      return false;
    }
  }

  @override
  Future<void> authenticate() async {
    if (!await isAvailable()) {
      throw const BiometricGateException(BiometricGateFailure.unavailable);
    }
    try {
      final authenticated = await _authentication.authenticate(
        localizedReason: 'Unlock Asael and release this device session',
        biometricOnly: true,
        persistAcrossBackgrounding: true,
      );
      if (!authenticated) {
        throw const BiometricGateException(BiometricGateFailure.notRecognized);
      }
    } on BiometricGateException {
      rethrow;
    } on LocalAuthException {
      throw const BiometricGateException(BiometricGateFailure.notRecognized);
    }
  }
}

final biometricGateProvider = Provider<BiometricGate>(
  (_) => LocalBiometricGate(),
);
