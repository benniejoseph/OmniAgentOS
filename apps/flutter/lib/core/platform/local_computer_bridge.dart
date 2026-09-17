import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

enum LocalComputerPermission { granted, denied, unknown }

enum LocalComputerOutcome { succeeded, failed, canceled }

class LocalComputerStatus {
  const LocalComputerStatus({
    required this.supported,
    required this.helperInstalled,
    required this.enabled,
    required this.active,
    required this.accessibility,
    required this.screenRecording,
    required this.helperVersion,
  });

  factory LocalComputerStatus.fromArguments(Object? arguments) {
    if (arguments is! Map || arguments.length != 7) {
      throw const FormatException('The local Computer Use status is invalid.');
    }
    final helperVersion = arguments['helperVersion'];
    if (arguments['supported'] is! bool ||
        arguments['helperInstalled'] is! bool ||
        arguments['enabled'] is! bool ||
        arguments['active'] is! bool ||
        helperVersion is! String ||
        helperVersion.isEmpty ||
        helperVersion.length > 40) {
      throw const FormatException('The local Computer Use status is invalid.');
    }
    return LocalComputerStatus(
      supported: arguments['supported'] as bool,
      helperInstalled: arguments['helperInstalled'] as bool,
      enabled: arguments['enabled'] as bool,
      active: arguments['active'] as bool,
      accessibility: _permission(arguments['accessibility']),
      screenRecording: _permission(arguments['screenRecording']),
      helperVersion: helperVersion,
    );
  }

  final bool supported;
  final bool helperInstalled;
  final bool enabled;
  final bool active;
  final LocalComputerPermission accessibility;
  final LocalComputerPermission screenRecording;
  final String helperVersion;

  bool get ready =>
      supported &&
      helperInstalled &&
      enabled &&
      accessibility == LocalComputerPermission.granted &&
      screenRecording == LocalComputerPermission.granted;

  static LocalComputerPermission _permission(Object? value) {
    if (value is! String) {
      throw const FormatException(
        'The local Computer Use permission is invalid.',
      );
    }
    return LocalComputerPermission.values.firstWhere(
      (permission) => permission.name == value,
      orElse: () => throw const FormatException(
        'The local Computer Use permission is invalid.',
      ),
    );
  }
}

class LocalComputerCommand {
  LocalComputerCommand({
    required this.id,
    required this.action,
    required Map<String, Object?> input,
    required this.expiresAt,
  }) : input = Map<String, Object?>.unmodifiable(input) {
    if (!_uuid.hasMatch(id) || !allowedActions.contains(action)) {
      throw ArgumentError('The local Computer Use command is invalid.');
    }
    final now = DateTime.now().toUtc();
    final expiration = expiresAt.toUtc();
    if (!expiration.isAfter(now) ||
        expiration.difference(now) > const Duration(minutes: 10) ||
        !_isSafeChannelValue(this.input) ||
        !_isValidActionInput(action, this.input) ||
        utf8.encode(jsonEncode(this.input)).length > 64 * 1024) {
      throw ArgumentError('The local Computer Use command is invalid.');
    }
  }

  static const allowedActions = <String>{
    'observe',
    'list_apps',
    'activate_app',
    'open_url',
    'press',
    'click',
    'type',
    'key',
    'scroll',
  };
  static final _uuid = RegExp(r'^local_computer_command_[a-f0-9]{48}$');

  final String id;
  final String action;
  final Map<String, Object?> input;
  final DateTime expiresAt;

  Map<String, Object?> toArguments() => {
    'id': id,
    'action': action,
    'input': input,
    'expiresAt': expiresAt.toUtc().toIso8601String(),
  };

  static bool _isSafeChannelValue(Object? value, [int depth = 0]) {
    if (depth > 5) return false;
    if (value == null || value is bool) return true;
    if (value is num) return value.isFinite;
    if (value is String) {
      return value.length <= 8192 &&
          !value.contains(RegExp(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'));
    }
    if (value is List) {
      return value.length <= 256 &&
          value.every((item) => _isSafeChannelValue(item, depth + 1));
    }
    if (value is Map) {
      return value.length <= 64 &&
          value.entries.every(
            (entry) =>
                entry.key is String &&
                (entry.key as String).length <= 100 &&
                _isSafeChannelValue(entry.value, depth + 1),
          );
    }
    return false;
  }

  static bool _isValidActionInput(String action, Map<String, Object?> input) {
    if (action != 'open_url') return true;
    if (input.keys.any(
      (key) => !const {'browser', 'url', 'loadWaitSeconds'}.contains(key),
    )) {
      return false;
    }
    if (input.length < 2 || input.length > 3 || input['browser'] != 'chrome') {
      return false;
    }
    final rawUrl = input['url'];
    if (rawUrl is! String ||
        rawUrl.length < 8 ||
        rawUrl.length > 4096 ||
        rawUrl != rawUrl.trim() ||
        rawUrl.contains('\\') ||
        rawUrl.contains(RegExp(r'[\x00-\x20\x7f]'))) {
      return false;
    }
    final uri = Uri.tryParse(rawUrl);
    if (uri == null ||
        !uri.hasScheme ||
        !uri.hasAuthority ||
        !const {'http', 'https'}.contains(uri.scheme.toLowerCase()) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty) {
      return false;
    }
    final wait = input['loadWaitSeconds'];
    return wait == null || (wait is int && wait >= 0 && wait <= 15);
  }
}

class LocalComputerCommandResult {
  const LocalComputerCommandResult({
    required this.outcome,
    this.summary,
    this.data,
    this.observation,
    this.errorCode,
  });

  factory LocalComputerCommandResult.fromArguments(Object? arguments) {
    if (arguments is! Map ||
        arguments.isEmpty ||
        arguments.keys.any(
          (key) => !const {'outcome', 'result', 'errorCode'}.contains(key),
        )) {
      throw const FormatException('The local Computer Use result is invalid.');
    }
    final outcomeValue = arguments['outcome'];
    if (outcomeValue is! String) {
      throw const FormatException('The local Computer Use result is invalid.');
    }
    final outcome = LocalComputerOutcome.values.firstWhere(
      (value) => value.name == outcomeValue,
      orElse: () => throw const FormatException(
        'The local Computer Use result is invalid.',
      ),
    );
    final errorCode = arguments['errorCode'];
    if (errorCode != null &&
        (errorCode is! String ||
            errorCode.isEmpty ||
            errorCode.length > 100 ||
            !RegExp(r'^[a-z0-9_]+$').hasMatch(errorCode))) {
      throw const FormatException('The local Computer Use result is invalid.');
    }

    final rawResult = arguments['result'];
    if (outcome == LocalComputerOutcome.succeeded && rawResult is! Map) {
      throw const FormatException(
        'A successful local Computer Use result is incomplete.',
      );
    }
    if (rawResult != null && rawResult is! Map) {
      throw const FormatException('The local Computer Use result is invalid.');
    }
    final result = rawResult == null
        ? null
        : Map<String, Object?>.from(rawResult as Map);
    if (result != null &&
        (result.keys.any(
              (key) => !const {'summary', 'data', 'observation'}.contains(key),
            ) ||
            result['summary'] is! String ||
            (result['summary'] as String).isEmpty ||
            (result['summary'] as String).length > 500)) {
      throw const FormatException('The local Computer Use result is invalid.');
    }
    final data = result?['data'];
    final observation = result?['observation'];
    if ((data != null && data is! Map) ||
        (observation != null && observation is! Map)) {
      throw const FormatException('The local Computer Use result is invalid.');
    }
    final effectVerdict = data is Map ? data['effectVerdict'] : null;
    if (effectVerdict != null &&
        !const {
          'confirmed',
          'suspected_noop',
          'unverifiable',
        }.contains(effectVerdict)) {
      throw const FormatException(
        'The local Computer Use effect verdict is invalid.',
      );
    }

    return LocalComputerCommandResult(
      outcome: outcome,
      summary: result?['summary'] as String?,
      data: data == null
          ? null
          : Map<String, Object?>.unmodifiable(
              Map<String, Object?>.from(data as Map),
            ),
      observation: observation == null
          ? null
          : Map<String, Object?>.unmodifiable(
              Map<String, Object?>.from(observation as Map),
            ),
      errorCode: errorCode as String?,
    );
  }

  final LocalComputerOutcome outcome;
  final String? summary;
  final Map<String, Object?>? data;
  final Map<String, Object?>? observation;
  final String? errorCode;
}

typedef LocalComputerStoppedHandler = void Function(String reason);

/// The narrow Flutter boundary to the credential-free, separately signed
/// Computer Use helper embedded in the private macOS application.
class LocalComputerBridge {
  LocalComputerBridge({MethodChannel? channel, bool? enabled})
    : _channel = channel ?? const MethodChannel(_channelName),
      _enabled = enabled ?? _isMacOS;

  static const _channelName = 'app.omniagent.omniagent/local-computer';
  static bool get _isMacOS =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

  final MethodChannel _channel;
  final bool _enabled;
  bool _initialized = false;
  LocalComputerStoppedHandler? _stoppedHandler;

  bool get supported => _enabled;

  Future<void> initialize() async {
    if (!_enabled || _initialized) return;
    _initialized = true;
    _channel.setMethodCallHandler(_handleNativeCall);
  }

  void attachStoppedHandler(LocalComputerStoppedHandler? handler) {
    _stoppedHandler = handler;
  }

  Future<LocalComputerStatus> getStatus() async {
    _requireSupported();
    return LocalComputerStatus.fromArguments(
      await _channel.invokeMethod<Object?>('getStatus'),
    );
  }

  Future<LocalComputerStatus> requestPermissions() async {
    _requireSupported();
    return LocalComputerStatus.fromArguments(
      await _channel.invokeMethod<Object?>('requestPermissions'),
    );
  }

  Future<LocalComputerStatus> setEnabled(bool enabled) async {
    _requireSupported();
    return LocalComputerStatus.fromArguments(
      await _channel.invokeMethod<Object?>('setEnabled', {'enabled': enabled}),
    );
  }

  Future<LocalComputerCommandResult> execute(
    LocalComputerCommand command,
  ) async {
    _requireSupported();
    return LocalComputerCommandResult.fromArguments(
      await _channel.invokeMethod<Object?>(
        'executeLocalComputerCommand',
        command.toArguments(),
      ),
    );
  }

  Future<LocalComputerStatus> stop() async {
    _requireSupported();
    return LocalComputerStatus.fromArguments(
      await _channel.invokeMethod<Object?>('stop'),
    );
  }

  Future<Object?> _handleNativeCall(MethodCall call) async {
    if (call.method != 'localComputerStopped' ||
        call.arguments is! Map ||
        (call.arguments as Map).length != 1 ||
        (call.arguments as Map)['reason'] is! String) {
      throw PlatformException(
        code: 'invalid_local_computer_event',
        message: 'The native local Computer Use event is invalid.',
      );
    }
    final reason = (call.arguments as Map)['reason'] as String;
    if (reason.isEmpty ||
        reason.length > 100 ||
        !RegExp(r'^[a-z0-9_]+$').hasMatch(reason)) {
      throw PlatformException(
        code: 'invalid_local_computer_event',
        message: 'The native local Computer Use event is invalid.',
      );
    }
    _stoppedHandler?.call(reason);
    return null;
  }

  Future<void> dispose() async {
    if (!_initialized) return;
    _initialized = false;
    _stoppedHandler = null;
    _channel.setMethodCallHandler(null);
  }

  void _requireSupported() {
    if (!_enabled) {
      throw UnsupportedError(
        'Local Computer Use is available only in Asael for macOS.',
      );
    }
  }
}

final appLocalComputerBridge = LocalComputerBridge();
