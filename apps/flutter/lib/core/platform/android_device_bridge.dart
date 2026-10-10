import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

class AndroidDeviceStatus {
  const AndroidDeviceStatus({
    required this.supported,
    required this.enabled,
    required this.active,
    required this.accessibility,
    required this.screenCapture,
    required this.locked,
    required this.voiceActive,
    required this.voiceMuted,
    required this.foregroundServiceReady,
    required this.deviceName,
    required this.androidApiLevel,
    required this.notificationsGranted,
    this.serviceExpiresAt,
  });

  factory AndroidDeviceStatus.parse(Object? value) {
    if (value is! Map ||
        value['schemaVersion'] != 1 ||
        [
          'supported',
          'enabled',
          'active',
          'locked',
          'voiceActive',
          'voiceMuted',
          'foregroundServiceReady',
        ].any((key) => value[key] is! bool) ||
        !const {'granted', 'denied'}.contains(value['accessibility']) ||
        !const {'granted', 'unavailable'}.contains(value['screenCapture']) ||
        value['deviceName'] is! String ||
        value['androidApiLevel'] is! int ||
        value['notificationsGranted'] is! bool) {
      throw const FormatException(
        'The phone’s readiness could not be verified.',
      );
    }
    return AndroidDeviceStatus(
      supported: value['supported'] as bool,
      enabled: value['enabled'] as bool,
      active: value['active'] as bool,
      accessibility: value['accessibility'] as String,
      screenCapture: value['screenCapture'] as String,
      locked: value['locked'] as bool,
      voiceActive: value['voiceActive'] as bool,
      voiceMuted: value['voiceMuted'] as bool,
      foregroundServiceReady: value['foregroundServiceReady'] as bool,
      deviceName: value['deviceName'] as String,
      androidApiLevel: value['androidApiLevel'] as int,
      notificationsGranted: value['notificationsGranted'] as bool,
      serviceExpiresAt: DateTime.tryParse(
        value['serviceExpiresAt']?.toString() ?? '',
      ),
    );
  }

  final bool supported,
      enabled,
      active,
      locked,
      voiceActive,
      voiceMuted,
      foregroundServiceReady;
  final String accessibility, screenCapture, deviceName;
  final int androidApiLevel;
  final bool notificationsGranted;
  final DateTime? serviceExpiresAt;
  bool get serviceLeaseActive =>
      foregroundServiceReady &&
      !locked &&
      serviceExpiresAt != null &&
      serviceExpiresAt!.isAfter(DateTime.now()) &&
      serviceExpiresAt!.difference(DateTime.now()) <=
          const Duration(minutes: 31);
  bool get ready =>
      supported &&
      enabled &&
      !locked &&
      accessibility == 'granted' &&
      screenCapture == 'granted';
}

/// Android's native services own permission checks and the local kill switch.
/// This channel never receives API credentials or grants authority from speech.
class AndroidDeviceBridge {
  static const _channel = MethodChannel(
    'app.omniagent.omniagent/android-device',
  );
  static const _events = EventChannel(
    'app.omniagent.omniagent/android-device/events',
  );
  bool get supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;
  Stream<Map<String, dynamic>>? _stream;
  Stream<Map<String, dynamic>> get events => _stream ??= _events
      .receiveBroadcastStream()
      .where((value) => value is Map)
      .map((value) => Map<String, dynamic>.from(value as Map))
      .asBroadcastStream();

  Future<AndroidDeviceStatus> _status(
    String method, [
    Map<String, dynamic>? input,
  ]) async {
    if (!supported)
      throw UnsupportedError('This phone is available on Android.');
    return AndroidDeviceStatus.parse(
      await _channel.invokeMethod<Object?>(method, input),
    );
  }

  Future<AndroidDeviceStatus> getStatus() => _status('getStatus');
  Future<void> openAccessibilitySettings() =>
      _channel.invokeMethod<void>('requestAccessibilitySettings');
  Future<AndroidDeviceStatus> enable() =>
      _status('setEnabled', {'enabled': true, 'disclosureAccepted': true});
  Future<AndroidDeviceStatus> stop() => _status('stop');
  Future<AndroidDeviceStatus> startVoice() => _status('voiceStart');
  Future<AndroidDeviceStatus> requestNotifications() =>
      _status('requestNotificationPermission');
  Future<void> setVoiceMuted(bool muted) =>
      _channel.invokeMethod<void>('voiceSetMuted', {'muted': muted});
  Future<void> stopVoice() => _channel.invokeMethod<void>('voiceStop');
  Future<Map<String, dynamic>> execute(Map<String, dynamic> command) async {
    final value = await _channel.invokeMethod<Object?>('execute', command);
    if (value is! Map ||
        !const {'succeeded', 'failed', 'canceled'}.contains(value['outcome']) ||
        value['result'] is! Map) {
      throw const FormatException(
        'The phone action returned an invalid receipt.',
      );
    }
    return Map<String, dynamic>.from(value);
  }
}

final appAndroidDeviceBridge = AndroidDeviceBridge();
