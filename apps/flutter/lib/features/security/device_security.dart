import 'package:flutter/foundation.dart';

typedef DeviceJson = Map<String, dynamic>;

enum DeviceLifecycleAction { revoke, remoteWipe }

class MobileDeviceSession {
  const MobileDeviceSession({
    required this.id,
    required this.current,
    required this.state,
    required this.name,
    required this.platform,
    required this.lastSeenAt,
    required this.createdAt,
    this.appVersion,
    this.buildNumber,
    this.revocationReason,
    this.wipeAcknowledged = false,
  });

  factory MobileDeviceSession.fromJson(DeviceJson json) {
    final device = json['device'];
    if (device is! Map) {
      throw const FormatException('The device session is missing its device.');
    }
    final values = Map<String, dynamic>.from(device);
    final createdAt = DateTime.tryParse(json['createdAt']?.toString() ?? '');
    final lastSeenAt = DateTime.tryParse(json['lastSeenAt']?.toString() ?? '');
    if (json['id'] is! String ||
        json['current'] is! bool ||
        json['state'] is! String ||
        values['name'] is! String ||
        values['platform'] is! String ||
        createdAt == null ||
        lastSeenAt == null) {
      throw const FormatException('The device session response is invalid.');
    }
    final wipe = json['wipe'];
    return MobileDeviceSession(
      id: json['id'] as String,
      current: json['current'] as bool,
      state: json['state'] as String,
      name: values['name'] as String,
      platform: values['platform'] as String,
      appVersion: values['appVersion']?.toString(),
      buildNumber: values['buildNumber'] is int
          ? values['buildNumber'] as int
          : null,
      createdAt: createdAt.toUtc(),
      lastSeenAt: lastSeenAt.toUtc(),
      revocationReason: json['revocationReason']?.toString(),
      wipeAcknowledged: wipe is Map && wipe['localErasure'] == 'acknowledged',
    );
  }

  final String id;
  final bool current;
  final String state;
  final String name;
  final String platform;
  final String? appVersion;
  final int? buildNumber;
  final DateTime createdAt;
  final DateTime lastSeenAt;
  final String? revocationReason;
  final bool wipeAcknowledged;

  bool get canRevoke => !current && state == 'active';
  bool get canRemoteWipe =>
      !current && state != 'wipe_pending' && state != 'wiped';

  String get versionLabel {
    final version = appVersion;
    if (version == null || version.isEmpty) return 'Legacy client';
    return buildNumber == null ? 'v$version' : 'v$version ($buildNumber)';
  }
}

abstract interface class DeviceSecurityRepository {
  Future<List<MobileDeviceSession>> loadDevices();

  Future<MobileDeviceSession> changeDevice(
    String id,
    DeviceLifecycleAction action,
  );
}

class DeviceSecurityController extends ChangeNotifier {
  DeviceSecurityController({
    required this.repository,
    required this.readBiometricEnabled,
    required this.readBiometricAvailable,
    required this.changeBiometricEnabled,
    this.canAccess,
  });

  final DeviceSecurityRepository repository;
  final Future<bool> Function() readBiometricEnabled;
  final Future<bool> Function() readBiometricAvailable;
  final Future<void> Function(bool enabled) changeBiometricEnabled;
  final bool Function()? canAccess;
  bool _disposed = false;
  bool get _current => !_disposed && (canAccess?.call() ?? true);
  void _changed() {
    if (_current) notifyListeners();
  }

  final Set<String> _uncertainDevices = {};

  @override
  void dispose() {
    _disposed = true;
    devices = const [];
    super.dispose();
  }

  List<MobileDeviceSession> devices = const [];
  bool biometricEnabled = false;
  bool biometricAvailable = false;
  bool loading = false;
  bool changingBiometric = false;
  final Set<String> changingDevices = {};
  Object? error;

  Future<void> refresh() async {
    if (!_current || loading) return;
    loading = true;
    error = null;
    _changed();
    try {
      final values = await Future.wait<Object>([
        repository.loadDevices(),
        readBiometricEnabled(),
        readBiometricAvailable(),
      ]);
      if (!_current) return;
      devices = values[0] as List<MobileDeviceSession>;
      _uncertainDevices.clear();
      biometricEnabled = values[1] as bool;
      biometricAvailable = values[2] as bool;
    } catch (caught) {
      if (_current) error = caught;
    } finally {
      loading = false;
      _changed();
    }
  }

  Future<void> setBiometricEnabled(bool enabled) async {
    if (!_current || changingBiometric) return;
    changingBiometric = true;
    error = null;
    _changed();
    try {
      await changeBiometricEnabled(enabled);
      if (!_current) return;
      biometricEnabled = enabled;
    } catch (caught) {
      error = caught;
      rethrow;
    } finally {
      changingBiometric = false;
      _changed();
    }
  }

  Future<void> changeDevice(
    MobileDeviceSession device,
    DeviceLifecycleAction action,
  ) async {
    if (!_current ||
        changingDevices.contains(device.id) ||
        _uncertainDevices.contains(device.id) ||
        !devices.any((item) => identical(item, device)) ||
        (action == DeviceLifecycleAction.revoke
            ? !device.canRevoke
            : !device.canRemoteWipe)) {
      throw StateError(
        'Refresh the current device before reviewing this action.',
      );
    }
    changingDevices.add(device.id);
    error = null;
    _changed();
    try {
      final updated = await repository.changeDevice(device.id, action);
      if (!_current) {
        throw StateError('Device access changed before confirmation.');
      }
      devices = [
        for (final value in devices)
          if (value.id == updated.id) updated else value,
      ];
    } catch (caught) {
      _uncertainDevices.add(device.id);
      error = caught;
      rethrow;
    } finally {
      changingDevices.remove(device.id);
      _changed();
    }
  }
}
