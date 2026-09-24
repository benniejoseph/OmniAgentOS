import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

enum LocalComputerPermission { granted, denied, unknown }

enum LocalComputerOutcome { succeeded, failed, canceled }

@immutable
class LocalCommandWorkspace {
  const LocalCommandWorkspace({
    required this.id,
    required this.name,
    required this.path,
  });

  factory LocalCommandWorkspace.fromArguments(Object? value) {
    if (value is! Map ||
        value.length != 3 ||
        value['id'] is! String ||
        value['name'] is! String ||
        value['path'] is! String) {
      throw const FormatException('A command workspace is invalid.');
    }
    final id = value['id'] as String;
    final name = value['name'] as String;
    final path = value['path'] as String;
    if (!RegExp(r'^local_workspace_[a-f0-9]{32}$').hasMatch(id) ||
        name.isEmpty ||
        name.length > 120 ||
        path.isEmpty ||
        path.length > 4096 ||
        !path.startsWith('/') ||
        RegExp(r'[\u0000-\u001f\u007f]').hasMatch(name) ||
        RegExp(r'[\u0000-\u001f\u007f]').hasMatch(path)) {
      throw const FormatException('A command workspace is invalid.');
    }
    return LocalCommandWorkspace(id: id, name: name, path: path);
  }

  final String id;
  final String name;
  final String path;
}

class LocalComputerStatus {
  const LocalComputerStatus({
    required this.supported,
    required this.helperInstalled,
    required this.enabled,
    required this.active,
    required this.accessibility,
    required this.screenRecording,
    required this.helperVersion,
    this.commandHelperInstalled = false,
    this.commandHelperVersion = '1.0.0',
    this.commandWorkspaces = const [],
  });

  factory LocalComputerStatus.fromArguments(Object? arguments) {
    if (arguments is! Map || arguments.length != 10) {
      throw const FormatException('The local Computer Use status is invalid.');
    }
    final helperVersion = arguments['helperVersion'];
    final commandHelperVersion = arguments['commandHelperVersion'];
    final rawWorkspaces = arguments['commandWorkspaces'];
    if (arguments['supported'] is! bool ||
        arguments['helperInstalled'] is! bool ||
        arguments['enabled'] is! bool ||
        arguments['active'] is! bool ||
        helperVersion is! String ||
        helperVersion.isEmpty ||
        helperVersion.length > 40 ||
        arguments['commandHelperInstalled'] is! bool ||
        commandHelperVersion is! String ||
        commandHelperVersion.isEmpty ||
        commandHelperVersion.length > 40 ||
        rawWorkspaces is! List ||
        rawWorkspaces.length > 32) {
      throw const FormatException('The local Computer Use status is invalid.');
    }
    final commandWorkspaces = rawWorkspaces
        .map(LocalCommandWorkspace.fromArguments)
        .toList(growable: false);
    if (commandWorkspaces.map((item) => item.id).toSet().length !=
            commandWorkspaces.length ||
        commandWorkspaces.map((item) => item.path).toSet().length !=
            commandWorkspaces.length) {
      throw const FormatException('The command workspaces are invalid.');
    }
    return LocalComputerStatus(
      supported: arguments['supported'] as bool,
      helperInstalled: arguments['helperInstalled'] as bool,
      enabled: arguments['enabled'] as bool,
      active: arguments['active'] as bool,
      accessibility: _permission(arguments['accessibility']),
      screenRecording: _permission(arguments['screenRecording']),
      helperVersion: helperVersion,
      commandHelperInstalled: arguments['commandHelperInstalled'] as bool,
      commandHelperVersion: commandHelperVersion,
      commandWorkspaces: List.unmodifiable(commandWorkspaces),
    );
  }

  final bool supported;
  final bool helperInstalled;
  final bool enabled;
  final bool active;
  final LocalComputerPermission accessibility;
  final LocalComputerPermission screenRecording;
  final String helperVersion;
  final bool commandHelperInstalled;
  final String commandHelperVersion;
  final List<LocalCommandWorkspace> commandWorkspaces;

  bool get computerUseReady =>
      supported &&
      helperInstalled &&
      enabled &&
      accessibility == LocalComputerPermission.granted &&
      screenRecording == LocalComputerPermission.granted;

  bool get commandRunnerReady =>
      supported &&
      commandHelperInstalled &&
      enabled &&
      commandWorkspaces.isNotEmpty;

  bool get ready => computerUseReady || commandRunnerReady;

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
    'run_command',
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
    if (action == 'run_command') {
      if (input.length != 5 ||
          input.keys.any(
            (key) => !const {
              'workspaceId',
              'executable',
              'arguments',
              'relativeDirectory',
              'timeoutSeconds',
            }.contains(key),
          )) {
        return false;
      }
      final workspaceId = input['workspaceId'];
      final executable = input['executable'];
      final arguments = input['arguments'];
      final relativeDirectory = input['relativeDirectory'];
      final timeoutSeconds = input['timeoutSeconds'];
      const deniedExecutables = {
        'ash',
        'bash',
        'csh',
        'dash',
        'env',
        'exec',
        'fish',
        'ksh',
        'launchctl',
        'login',
        'nohup',
        'open',
        'osascript',
        'script',
        'security',
        'sh',
        'sudo',
        'tcsh',
        'time',
        'xargs',
        'zsh',
      };
      final validArguments =
          arguments is List &&
          arguments.length <= 64 &&
          arguments.every(
            (item) =>
                item is String &&
                utf8.encode(item).length <= 8192 &&
                !RegExp(r'[\u0000-\u0008\u000b-\u001f\u007f]').hasMatch(item),
          ) &&
          arguments.fold<int>(
                0,
                (total, item) => total + utf8.encode(item as String).length,
              ) <=
              49152;
      final validRelativeDirectory =
          relativeDirectory is String &&
          relativeDirectory.isNotEmpty &&
          utf8.encode(relativeDirectory).length <= 1024 &&
          (relativeDirectory == '.' ||
              (!relativeDirectory.startsWith('/') &&
                  !relativeDirectory.startsWith('~') &&
                  !relativeDirectory.contains('\\') &&
                  !RegExp(r'[\u0000-\u001f\u007f]')
                      .hasMatch(relativeDirectory) &&
                  relativeDirectory
                      .split('/')
                      .every(
                        (segment) =>
                            segment.isNotEmpty &&
                            segment != '..' &&
                            segment != '.',
                      )));
      return workspaceId is String &&
          RegExp(r'^local_workspace_[a-f0-9]{32}$').hasMatch(workspaceId) &&
          executable is String &&
          RegExp(r'^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$').hasMatch(executable) &&
          !deniedExecutables.contains(executable.toLowerCase()) &&
          validArguments &&
          validRelativeDirectory &&
          timeoutSeconds is int &&
          timeoutSeconds >= 1 &&
          timeoutSeconds <= 30;
    }
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
    this.terminalOutput,
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
              (key) => !const {
                'summary',
                'data',
                'observation',
                'terminalOutput',
              }.contains(key),
            ) ||
            result['summary'] is! String ||
            (result['summary'] as String).isEmpty ||
            (result['summary'] as String).length > 500)) {
      throw const FormatException('The local Computer Use result is invalid.');
    }
    final data = result?['data'];
    final observation = result?['observation'];
    final rawTerminalOutput = result?['terminalOutput'];
    if ((data != null && data is! Map) ||
        (observation != null && observation is! Map) ||
        (rawTerminalOutput != null && rawTerminalOutput is! Map)) {
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
      terminalOutput: rawTerminalOutput == null
          ? null
          : LocalComputerTerminalOutput.fromArguments(rawTerminalOutput),
      errorCode: errorCode as String?,
    );
  }

  final LocalComputerOutcome outcome;
  final String? summary;
  final Map<String, Object?>? data;
  final Map<String, Object?>? observation;
  final LocalComputerTerminalOutput? terminalOutput;
  final String? errorCode;
}

@immutable
class LocalComputerTerminalOutput {
  const LocalComputerTerminalOutput({
    required this.stdout,
    required this.stderr,
    required this.exitCode,
    required this.durationMs,
    required this.stdoutBytes,
    required this.stderrBytes,
    required this.stdoutSha256,
    required this.stderrSha256,
    required this.stdoutTruncated,
    required this.stderrTruncated,
  });

  factory LocalComputerTerminalOutput.fromArguments(Object? value) {
    if (value is! Map ||
        value.length != 10 ||
        value['stdout'] is! String ||
        value['stderr'] is! String ||
        value['exitCode'] is! int ||
        value['durationMs'] is! int ||
        value['stdoutBytes'] is! int ||
        value['stderrBytes'] is! int ||
        value['stdoutSha256'] is! String ||
        value['stderrSha256'] is! String ||
        value['stdoutTruncated'] is! bool ||
        value['stderrTruncated'] is! bool) {
      throw const FormatException('The local command output is invalid.');
    }
    final stdout = value['stdout'] as String;
    final stderr = value['stderr'] as String;
    final exitCode = value['exitCode'] as int;
    final durationMs = value['durationMs'] as int;
    final stdoutBytes = value['stdoutBytes'] as int;
    final stderrBytes = value['stderrBytes'] as int;
    final stdoutSha256 = value['stdoutSha256'] as String;
    final stderrSha256 = value['stderrSha256'] as String;
    if (stdout.length > 160000 ||
        stderr.length > 160000 ||
        exitCode < -2147483648 ||
        exitCode > 2147483647 ||
        durationMs < 0 ||
        durationMs > 300000 ||
        stdoutBytes < 0 ||
        stdoutBytes > 4 * 1024 * 1024 ||
        stderrBytes < 0 ||
        stderrBytes > 4 * 1024 * 1024 ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(stdoutSha256) ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(stderrSha256)) {
      throw const FormatException('The local command output is invalid.');
    }
    return LocalComputerTerminalOutput(
      stdout: stdout,
      stderr: stderr,
      exitCode: exitCode,
      durationMs: durationMs,
      stdoutBytes: stdoutBytes,
      stderrBytes: stderrBytes,
      stdoutSha256: stdoutSha256,
      stderrSha256: stderrSha256,
      stdoutTruncated: value['stdoutTruncated'] as bool,
      stderrTruncated: value['stderrTruncated'] as bool,
    );
  }

  final String stdout;
  final String stderr;
  final int exitCode;
  final int durationMs;
  final int stdoutBytes;
  final int stderrBytes;
  final String stdoutSha256;
  final String stderrSha256;
  final bool stdoutTruncated;
  final bool stderrTruncated;
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

  Future<LocalComputerStatus> addCommandWorkspace() async {
    _requireSupported();
    return LocalComputerStatus.fromArguments(
      await _channel.invokeMethod<Object?>('addCommandWorkspace'),
    );
  }

  Future<LocalComputerStatus> removeCommandWorkspace(String workspaceId) async {
    _requireSupported();
    if (!RegExp(r'^local_workspace_[a-f0-9]{32}$').hasMatch(workspaceId)) {
      throw ArgumentError.value(workspaceId, 'workspaceId');
    }
    return LocalComputerStatus.fromArguments(
      await _channel.invokeMethod<Object?>('removeCommandWorkspace', {
        'workspaceId': workspaceId,
      }),
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
