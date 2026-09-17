import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/platform/local_computer_bridge.dart';
import '../../generated/native_contract.g.dart';
import '../auth/application/session_controller.dart';

const localComputerProtocolVersion = 1;

enum LocalComputerWindowRole { primary, auxiliary }

class LocalComputerWindowContext {
  const LocalComputerWindowContext({required this.role, this.windowId});

  factory LocalComputerWindowContext.fromArguments(List<String> arguments) {
    const prefix = '--asael-window=';
    final values = arguments
        .where((argument) => argument.startsWith(prefix))
        .map((argument) => argument.substring(prefix.length))
        .toList(growable: false);
    if (values.isEmpty) {
      return const LocalComputerWindowContext(
        role: LocalComputerWindowRole.primary,
      );
    }
    final value = values.last;
    final valid = RegExp(
      r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    ).hasMatch(value);
    // Any window marker is auxiliary, including a malformed marker. Failing
    // closed here prevents a secondary Flutter engine from claiming commands.
    return LocalComputerWindowContext(
      role: LocalComputerWindowRole.auxiliary,
      windowId: valid ? value : null,
    );
  }

  final LocalComputerWindowRole role;
  final String? windowId;
  bool get canClaimCommands => role == LocalComputerWindowRole.primary;
}

final localComputerWindowContextProvider = Provider<LocalComputerWindowContext>(
  (_) =>
      const LocalComputerWindowContext(role: LocalComputerWindowRole.primary),
);

enum LocalComputerBrokerPhase {
  starting,
  unavailable,
  disabled,
  permissionsRequired,
  ready,
  active,
  stopped,
  degraded,
}

class LocalComputerDeviceSnapshot {
  const LocalComputerDeviceSnapshot({
    required this.enabled,
    required this.online,
    required this.activityState,
    required this.lastSeenAt,
  });

  factory LocalComputerDeviceSnapshot.fromJson(Map<String, dynamic> json) {
    if (json['schemaVersion'] != localComputerProtocolVersion ||
        json['enabled'] is! bool ||
        json['online'] is! bool ||
        json['activityState'] is! String ||
        json['lastSeenAt'] is! String) {
      throw const FormatException(
        'The local Computer Use device response is invalid.',
      );
    }
    final lastSeenAt = DateTime.tryParse(json['lastSeenAt'] as String);
    if (lastSeenAt == null) {
      throw const FormatException(
        'The local Computer Use device response is invalid.',
      );
    }
    return LocalComputerDeviceSnapshot(
      enabled: json['enabled'] as bool,
      online: json['online'] as bool,
      activityState: json['activityState'] as String,
      lastSeenAt: lastSeenAt.toUtc(),
    );
  }

  final bool enabled;
  final bool online;
  final String activityState;
  final DateTime lastSeenAt;
}

class LocalComputerClaim {
  LocalComputerClaim({
    required this.id,
    required this.action,
    required Map<String, Object?> input,
    required this.claimToken,
    required this.claimGeneration,
    required this.expiresAt,
  }) : input = Map<String, Object?>.unmodifiable(input);

  factory LocalComputerClaim.fromJson(Map<String, dynamic> json) {
    final rawInput = json['input'];
    final expiresAt = DateTime.tryParse(json['expiresAt']?.toString() ?? '');
    if (json['schemaVersion'] != localComputerProtocolVersion ||
        json['id'] is! String ||
        !RegExp(r'^local_computer_command_[a-f0-9]{48}$')
            .hasMatch(json['id'] as String) ||
        json['action'] is! String ||
        !LocalComputerCommand.allowedActions.contains(json['action']) ||
        rawInput is! Map ||
        json['claimToken'] is! String ||
        (json['claimToken'] as String).length < 32 ||
        (json['claimToken'] as String).length > 256 ||
        json['claimGeneration'] is! int ||
        (json['claimGeneration'] as int) < 1 ||
        expiresAt == null ||
        !expiresAt.isAfter(DateTime.now().toUtc())) {
      throw const FormatException(
        'The local Computer Use command response is invalid.',
      );
    }
    return LocalComputerClaim(
      id: json['id'] as String,
      action: json['action'] as String,
      input: Map<String, Object?>.from(rawInput),
      claimToken: json['claimToken'] as String,
      claimGeneration: json['claimGeneration'] as int,
      expiresAt: expiresAt.toUtc(),
    );
  }

  final String id;
  final String action;
  final Map<String, Object?> input;
  final String claimToken;
  final int claimGeneration;
  final DateTime expiresAt;
}

class LocalComputerClaimResponse {
  const LocalComputerClaimResponse({
    required this.command,
    required this.pollAfter,
  });

  factory LocalComputerClaimResponse.fromJson(Map<String, dynamic> json) {
    final command = json['command'];
    final pollAfterMs = json['pollAfterMs'];
    if (json['schemaVersion'] != localComputerProtocolVersion ||
        (command != null && command is! Map) ||
        pollAfterMs is! int ||
        pollAfterMs < 0 ||
        pollAfterMs > 30_000) {
      throw const FormatException(
        'The local Computer Use claim response is invalid.',
      );
    }
    return LocalComputerClaimResponse(
      command: command == null
          ? null
          : LocalComputerClaim.fromJson(Map<String, dynamic>.from(command)),
      pollAfter: Duration(milliseconds: pollAfterMs),
    );
  }

  final LocalComputerClaim? command;
  final Duration pollAfter;
}

class LocalComputerCompletion {
  LocalComputerCompletion({
    required this.commandId,
    required this.claimToken,
    required this.claimGeneration,
    required Map<String, dynamic> payload,
  }) : payload = Map<String, dynamic>.unmodifiable(payload);

  final String commandId;
  final String claimToken;
  final int claimGeneration;
  final Map<String, dynamic> payload;
}

abstract interface class LocalComputerRepository {
  Future<LocalComputerDeviceSnapshot> updateDevice(LocalComputerStatus status);
  Future<LocalComputerClaimResponse> claim();
  Future<void> complete(LocalComputerCompletion completion);
  Future<void> stop(String reason);
}

class ApiLocalComputerRepository implements LocalComputerRepository {
  const ApiLocalComputerRepository(this.api);

  final ApiClient api;

  @override
  Future<LocalComputerDeviceSnapshot> updateDevice(
    LocalComputerStatus status,
  ) async {
    final json = await api.putJson(
      NativePaths.localComputerDeviceUpdate,
      data: {
        'schemaVersion': localComputerProtocolVersion,
        'enabled': status.enabled,
        'helperVersion': status.helperVersion,
        'permissions': {
          'accessibility': status.accessibility.name,
          'screenRecording': status.screenRecording.name,
        },
        'activityState': status.active
            ? 'active'
            : status.enabled
            ? 'idle'
            : 'stopped',
      },
    );
    return LocalComputerDeviceSnapshot.fromJson(json);
  }

  @override
  Future<LocalComputerClaimResponse> claim() async {
    final json = await api.postJson(
      NativePaths.localComputerCommandClaim,
      data: const {'schemaVersion': localComputerProtocolVersion},
    );
    return LocalComputerClaimResponse.fromJson(json);
  }

  @override
  Future<void> complete(LocalComputerCompletion completion) async {
    final receipt = await api.postJson(
      NativePaths.localComputerCommandComplete(completion.commandId),
      data: completion.payload,
      headers: {
        'idempotency-key':
            'local-computer-complete-${completion.commandId}-${completion.claimGeneration}',
      },
    );
    if (receipt['schemaVersion'] != localComputerProtocolVersion ||
        receipt['accepted'] != true ||
        receipt['commandId'] != completion.commandId) {
      throw const FormatException(
        'The local Computer Use completion receipt is invalid.',
      );
    }
  }

  @override
  Future<void> stop(String reason) async {
    final response = await api.postJson(
      NativePaths.localComputerStop,
      data: {'schemaVersion': localComputerProtocolVersion, 'reason': reason},
      headers: {
        'idempotency-key':
            'local-computer-stop-$reason-${DateTime.now().microsecondsSinceEpoch}',
      },
    );
    if (response['schemaVersion'] != localComputerProtocolVersion ||
        response['stopped'] != true) {
      throw const FormatException(
        'The local Computer Use stop receipt is invalid.',
      );
    }
  }
}

abstract interface class LocalComputerNativeHost {
  bool get supported;
  Future<void> initialize();
  void attachStoppedHandler(LocalComputerStoppedHandler? handler);
  Future<LocalComputerStatus> getStatus();
  Future<LocalComputerStatus> requestPermissions();
  Future<LocalComputerStatus> setEnabled(bool enabled);
  Future<LocalComputerCommandResult> execute(LocalComputerCommand command);
  Future<LocalComputerStatus> stop();
  Future<void> dispose();
}

class BridgeLocalComputerNativeHost implements LocalComputerNativeHost {
  const BridgeLocalComputerNativeHost(this.bridge);
  final LocalComputerBridge bridge;

  @override
  bool get supported => bridge.supported;
  @override
  Future<void> initialize() => bridge.initialize();
  @override
  void attachStoppedHandler(LocalComputerStoppedHandler? handler) =>
      bridge.attachStoppedHandler(handler);
  @override
  Future<LocalComputerStatus> getStatus() => bridge.getStatus();
  @override
  Future<LocalComputerStatus> requestPermissions() =>
      bridge.requestPermissions();
  @override
  Future<LocalComputerStatus> setEnabled(bool enabled) =>
      bridge.setEnabled(enabled);
  @override
  Future<LocalComputerCommandResult> execute(LocalComputerCommand command) =>
      bridge.execute(command);
  @override
  Future<LocalComputerStatus> stop() => bridge.stop();
  @override
  Future<void> dispose() => bridge.dispose();
}

class LocalComputerCoordinator extends ChangeNotifier {
  LocalComputerCoordinator({
    required this.repository,
    required this.host,
    required this.windowContext,
    required this.authenticated,
    this.idleRefreshInterval = const Duration(seconds: 2),
    this.heartbeatInterval = const Duration(seconds: 8),
    this.failureRetryInterval = const Duration(seconds: 3),
  }) {
    unawaited(_initialize());
  }

  final LocalComputerRepository repository;
  final LocalComputerNativeHost host;
  final LocalComputerWindowContext windowContext;
  final Duration idleRefreshInterval;
  final Duration heartbeatInterval;
  final Duration failureRetryInterval;

  LocalComputerStatus? status;
  LocalComputerDeviceSnapshot? device;
  String? activeCommandId;
  String? lastError;
  LocalComputerCompletion? _pendingCompletion;
  DateTime? _lastHeartbeatAt;
  bool authenticated;
  bool _initialized = false;
  bool _disposed = false;
  bool _explicitlyStopped = false;
  bool _changing = false;
  int _loopGeneration = 0;

  bool get canClaimCommands => windowContext.canClaimCommands;
  bool get supported => host.supported;
  bool get changing => _changing;
  bool get ready => status?.ready == true;
  bool get active => activeCommandId != null || status?.active == true;

  LocalComputerBrokerPhase get phase {
    final current = status;
    if (!_initialized) return LocalComputerBrokerPhase.starting;
    if (!host.supported || current == null || !current.supported) {
      return LocalComputerBrokerPhase.unavailable;
    }
    if (lastError != null && current.enabled) {
      return LocalComputerBrokerPhase.degraded;
    }
    if (_explicitlyStopped) return LocalComputerBrokerPhase.stopped;
    if (!current.helperInstalled || !current.enabled) {
      return LocalComputerBrokerPhase.disabled;
    }
    if (current.accessibility != LocalComputerPermission.granted ||
        current.screenRecording != LocalComputerPermission.granted) {
      return LocalComputerBrokerPhase.permissionsRequired;
    }
    if (active) return LocalComputerBrokerPhase.active;
    return LocalComputerBrokerPhase.ready;
  }

  Future<void> _initialize() async {
    if (!host.supported || !authenticated) {
      _initialized = true;
      _notify();
      return;
    }
    try {
      await host.initialize();
      host.attachStoppedHandler(_handleNativeStop);
      status = await host.getStatus();
    } catch (_) {
      lastError = 'Local Computer Use could not start on this Mac.';
    } finally {
      _initialized = true;
      _notify();
      _restartCommandLoop();
    }
  }

  Future<void> refresh() async {
    if (!host.supported || !authenticated || _changing) return;
    _changing = true;
    _notify();
    try {
      status = await host.getStatus();
      lastError = null;
    } catch (_) {
      lastError = 'Local Computer Use status could not be refreshed.';
    } finally {
      _changing = false;
      _notify();
    }
  }

  Future<void> requestPermissions() async {
    if (!host.supported || !authenticated || _changing) return;
    _changing = true;
    lastError = null;
    _notify();
    try {
      status = await host.requestPermissions();
    } catch (_) {
      lastError = 'macOS permissions could not be requested.';
    } finally {
      _changing = false;
      _notify();
    }
  }

  Future<void> setEnabled(bool enabled) async {
    if (!host.supported || !authenticated || _changing) return;
    _changing = true;
    lastError = null;
    if (enabled) _explicitlyStopped = false;
    _notify();
    try {
      status = await host.setEnabled(enabled);
      if (!enabled) {
        _explicitlyStopped = true;
        await repository.stop('user_stop');
      } else {
        _restartCommandLoop();
      }
    } catch (_) {
      lastError = enabled ? 'Local Computer Use could not be enabled.' : 'Local Computer Use stopped locally; the server receipt is pending.';
    } finally {
      _changing = false;
      _notify();
    }
  }

  Future<void> stopNow({String reason = 'user_stop'}) async {
    if (_changing) return;
    _changing = true;
    _explicitlyStopped = true;
    _loopGeneration += 1;
    lastError = null;
    _notify();
    var localStopped = false;
    try {
      if (host.supported) {
        status = await host.stop();
        localStopped = true;
      }
    } catch (_) {
      lastError = 'The local kill switch could not confirm its status.';
    }
    try {
      if (authenticated) await repository.stop(reason);
    } catch (_) {
      lastError = localStopped
          ? 'Control is stopped on this Mac; the server will expire its short lease.'
          : 'Local Computer Use stop could not be confirmed.';
    } finally {
      activeCommandId = null;
      _pendingCompletion = null;
      _changing = false;
      _notify();
    }
  }

  void _handleNativeStop(String reason) {
    _explicitlyStopped = true;
    _loopGeneration += 1;
    activeCommandId = null;
    _pendingCompletion = null;
    _notify();
    unawaited(
      repository
          .stop(
            reason == 'helper_unavailable' ? 'permission_lost' : 'user_stop',
          )
          .catchError((Object _) {}),
    );
  }

  Future<void> _commandLoop(int generation) async {
    while (_loopCurrent(generation)) {
      var delay = idleRefreshInterval;
      try {
        status = await host.getStatus();
        if (!_loopCurrent(generation)) return;
        if (status?.helperInstalled == true) {
          final now = DateTime.now().toUtc();
          if (_lastHeartbeatAt == null ||
              now.difference(_lastHeartbeatAt!) >= heartbeatInterval) {
            device = await repository.updateDevice(status!);
            _lastHeartbeatAt = now;
          }
        }
        if (status?.ready != true || _explicitlyStopped) {
          lastError = null;
          _notify();
          await _wait(delay, generation);
          continue;
        }
        if (_pendingCompletion case final pending?) {
          await repository.complete(pending);
          _pendingCompletion = null;
          activeCommandId = null;
          lastError = null;
          _notify();
          continue;
        }
        final response = await repository.claim();
        if (!_loopCurrent(generation)) return;
        final command = response.command;
        if (command == null) {
          delay = response.pollAfter > Duration.zero
              ? response.pollAfter
              : const Duration(milliseconds: 250);
        } else {
          await _execute(command, generation);
          delay = Duration.zero;
        }
        lastError = null;
      } catch (_) {
        if (!_loopCurrent(generation)) return;
        lastError = _pendingCompletion == null
            ? 'This Mac is reconnecting to the governed command service.'
            : 'The action finished locally; only its exact receipt will retry.';
        delay = failureRetryInterval;
      }
      _notify();
      await _wait(delay, generation);
    }
  }

  Future<void> _execute(LocalComputerClaim claim, int generation) async {
    activeCommandId = claim.id;
    _notify();
    LocalComputerCompletion completion;
    if (claim.claimGeneration > 1) {
      // A prior process may have performed this command before its completion
      // receipt reached the server. Fail closed instead of replaying an
      // uncertain local effect after a lease recovery.
      completion = _failureCompletion(
        claim,
        outcome: 'canceled',
        errorCode: 'uncertain_prior_claim',
      );
    } else {
      final result = await host.execute(
        LocalComputerCommand(
          id: claim.id,
          action: claim.action,
          input: claim.input,
          expiresAt: claim.expiresAt,
        ),
      );
      if (!_loopCurrent(generation)) return;
      completion = _completion(claim, result);
    }
    _pendingCompletion = completion;
    await repository.complete(completion);
    _pendingCompletion = null;
    activeCommandId = null;
  }

  LocalComputerCompletion _completion(
    LocalComputerClaim claim,
    LocalComputerCommandResult result,
  ) {
    final payload = <String, dynamic>{
      'schemaVersion': localComputerProtocolVersion,
      'claimToken': claim.claimToken,
      'outcome': result.outcome.name,
      if (result.outcome == LocalComputerOutcome.succeeded)
        'result': {
          'summary': result.summary,
          if (result.data != null) 'data': result.data,
          if (result.observation != null) 'observation': result.observation,
        }
      else
        'errorCode': result.errorCode ?? 'native_command_failed',
    };
    return LocalComputerCompletion(
      commandId: claim.id,
      claimToken: claim.claimToken,
      claimGeneration: claim.claimGeneration,
      payload: payload,
    );
  }

  LocalComputerCompletion _failureCompletion(
    LocalComputerClaim claim, {
    required String outcome,
    required String errorCode,
  }) => LocalComputerCompletion(
    commandId: claim.id,
    claimToken: claim.claimToken,
    claimGeneration: claim.claimGeneration,
    payload: {
      'schemaVersion': localComputerProtocolVersion,
      'claimToken': claim.claimToken,
      'outcome': outcome,
      'errorCode': errorCode,
    },
  );

  bool _loopCurrent(int generation) =>
      !_disposed &&
      authenticated &&
      canClaimCommands &&
      generation == _loopGeneration;

  void _restartCommandLoop() {
    if (_disposed || !authenticated || !canClaimCommands || !host.supported) {
      return;
    }
    final generation = ++_loopGeneration;
    unawaited(_commandLoop(generation));
  }

  Future<void> _wait(Duration duration, int generation) async {
    if (duration <= Duration.zero || !_loopCurrent(generation)) return;
    await Future<void>.delayed(duration);
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    authenticated = false;
    _loopGeneration += 1;
    host.attachStoppedHandler(null);
    unawaited(host.dispose());
    super.dispose();
  }
}

final localComputerCoordinatorProvider =
    ChangeNotifierProvider<LocalComputerCoordinator>((ref) {
      final authenticated = ref.watch(
        sessionControllerProvider.select((session) => session.value != null),
      );
      return LocalComputerCoordinator(
        repository: ApiLocalComputerRepository(ref.watch(apiClientProvider)),
        host: BridgeLocalComputerNativeHost(appLocalComputerBridge),
        windowContext: ref.watch(localComputerWindowContextProvider),
        authenticated: authenticated,
      );
    });
