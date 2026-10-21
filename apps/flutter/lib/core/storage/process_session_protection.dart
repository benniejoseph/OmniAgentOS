import 'dart:async';

import 'package:flutter/services.dart';

class ProcessSessionSnapshot {
  const ProcessSessionSnapshot({
    required this.epoch,
    required this.sessionEpoch,
    required this.biometricEnabled,
    required this.scope,
    required this.locked,
    required this.ended,
  });
  final int epoch, sessionEpoch;
  final String? scope;
  final bool locked, ended, biometricEnabled;
  factory ProcessSessionSnapshot.parse(Object? value) {
    if (value is! Map ||
        value.length != 7 ||
        value['schemaVersion'] != 1 ||
        value['epoch'] is! int ||
        (value['epoch'] as int) < 0 ||
        value['sessionEpoch'] is! int ||
        (value['sessionEpoch'] as int) < 0 ||
        (value['scope'] != null &&
            (value['scope'] is! String ||
                !RegExp(r'^[a-f0-9]{64}$')
                    .hasMatch(value['scope'] as String))) ||
        value['biometricEnabled'] is! bool ||
        value['locked'] is! bool ||
        value['ended'] is! bool) {
      throw const FormatException('The native session state is invalid.');
    }
    return ProcessSessionSnapshot(
      epoch: value['epoch'] as int,
      sessionEpoch: value['sessionEpoch'] as int,
      biometricEnabled: value['biometricEnabled'] as bool,
      scope: value['scope'] as String?,
      locked: value['locked'] as bool,
      ended: value['ended'] as bool,
    );
  }
}

abstract interface class ProcessSessionProtection {
  Stream<ProcessSessionSnapshot> get changes;
  Future<ProcessSessionSnapshot> snapshot();
  Future<ProcessSessionSnapshot> change(
    String action,
    ProcessSessionSnapshot expected, {
    String? scope,
    bool? biometricEnabled,
  });
}

/// One handler per engine; the native host serializes all engines against one
/// owner-bound epoch. The channel contains no token or encryption material.
class MacosProcessSessionProtection implements ProcessSessionProtection {
  MacosProcessSessionProtection({MethodChannel? channel})
    : _channel =
          channel ??
          const MethodChannel('app.omniagent.omniagent/session-protection') {
    _channel.setMethodCallHandler((call) async {
      if (call.method != 'changed') throw MissingPluginException();
      _changes.add(ProcessSessionSnapshot.parse(call.arguments));
      return null;
    });
  }
  final MethodChannel _channel;
  final _changes = StreamController<ProcessSessionSnapshot>.broadcast(
    sync: true,
  );
  @override
  Stream<ProcessSessionSnapshot> get changes => _changes.stream;
  @override
  Future<ProcessSessionSnapshot> snapshot() async =>
      ProcessSessionSnapshot.parse(
        await _channel.invokeMethod<Object?>('snapshot'),
      );
  @override
  Future<ProcessSessionSnapshot> change(
    String action,
    ProcessSessionSnapshot expected, {
    String? scope,
    bool? biometricEnabled,
  }) async => ProcessSessionSnapshot.parse(
    await _channel.invokeMethod<Object?>('change', {
      'action': action,
      'epoch': expected.epoch,
      'expectedScope': expected.scope,
      'scope': ?scope,
      'biometricEnabled': ?biometricEnabled,
    }),
  );
}

ProcessSessionProtection? _macosProcessProtection;
ProcessSessionProtection get macosProcessSessionProtection =>
    _macosProcessProtection ??= MacosProcessSessionProtection();

class ProtectedSessionChange {
  const ProtectedSessionChange({required this.locked, required this.ended});
  final bool locked, ended;
}
