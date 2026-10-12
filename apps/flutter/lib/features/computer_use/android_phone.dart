import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/legacy.dart';

import '../../core/network/api_client.dart';
import '../../core/platform/android_device_bridge.dart';
import '../../generated/native_contract.g.dart';
import '../auth/application/session_controller.dart';
import '../auth/application/biometric_session_lock_controller.dart';

/// Direct cloud courier for this installation. Receipts may retry; native
/// effects never replay after an uncertain result or a replaced session.
class AndroidPhoneCoordinator extends ChangeNotifier {
  AndroidPhoneCoordinator(this.api, this.host, this.current) {
    if (host.supported) {
      _events = host.events.listen(
        (event) {
          if (event['type'] == 'control_stopped') {
            _generation++;
            _pending = null;
            status = null;
            _changed();
            unawaited(refresh());
            unawaited(_serverStop('permission_lost'));
          } else if (event['type'] == 'status_changed') {
            unawaited(refresh());
          }
        },
        onError: (_) {
          unawaited(stop('permission_lost'));
        },
      );
      unawaited(refresh());
    }
  }
  final ApiClient api;
  final AndroidDeviceBridge host;
  final bool Function() current;
  AndroidDeviceStatus? status;
  String? notice;
  bool busy = false, _disposed = false, _loopRunning = false;
  int _generation = 0;
  StreamSubscription<Map<String, dynamic>>? _events;
  Map<String, dynamic>? _pending;
  bool get supported => host.supported;
  bool get ready => current() && status?.ready == true;
  bool get backgroundSessionActive =>
      current() &&
      status?.serviceLeaseActive == true &&
      (status?.enabled == true || status?.voiceActive == true);
  void _changed() {
    if (!_disposed) notifyListeners();
  }

  Future<void> refresh() async {
    if (_disposed || !host.supported || !current()) return;
    try {
      final next = await host.getStatus();
      if (_disposed || !current()) return;
      status = next;
      _changed();
      if (ready && !_loopRunning) unawaited(_loop(++_generation));
    } catch (_) {
      notice =
          'Phone access could not be checked. Reopen Settings and try again.';
      _changed();
    }
  }

  Future<void> enable() async {
    if (!current() || busy) return;
    busy = true;
    notice = null;
    _changed();
    try {
      status = await host.enable();
      if (!current()) {
        await host.stop();
        return;
      }
      if (!ready) throw StateError('Phone permissions are not ready.');
      await _heartbeat();
      if (!_loopRunning) unawaited(_loop(++_generation));
    } catch (_) {
      notice = 'Allow Asael in Android Accessibility settings, return here, then enable This phone.';
    } finally {
      busy = false;
      _changed();
    }
  }

  Future<bool> prepare() async {
    await refresh();
    if (!ready) return false;
    try {
      await _heartbeat();
      return ready;
    } catch (_) {
      notice =
          'This phone could not connect. Check your connection and try again.';
      _changed();
      return false;
    }
  }

  Future<void> stop([String reason = 'user_stop']) async {
    ++_generation;
    _pending = null;
    try {
      if (host.supported) status = await host.stop();
    } catch (_) {}
    if (current()) await _serverStop(reason);
    _changed();
  }

  Future<void> _serverStop(String reason) async {
    if (!current()) return;
    try {
      await api.postJson(
        NativePaths.localAndroidStop,
        data: {'schemaVersion': 1, 'reason': reason},
      );
    } catch (_) {
      /* Short server lease expires independently. */
    }
  }

  Future<void> _heartbeat() async {
    if (!current()) throw StateError('The phone session ended.');
    final value = await host.getStatus();
    status = value;
    if (!value.ready) throw StateError('Phone control is no longer available.');
    final result = await api.putJson(
      NativePaths.localAndroidDeviceUpdate,
      data: {
        'schemaVersion': 1,
        'enabled': value.enabled,
        'helperVersion': '1.0.0',
        'permissions': {
          'accessibility': value.accessibility,
          'screenCapture': value.screenCapture,
        },
        'activityState': value.active ? 'active' : 'idle',
        'supported': value.supported,
        'locked': value.locked,
        'foregroundServiceReady': value.foregroundServiceReady,
        'androidApiLevel': value.androidApiLevel,
      },
    );
    if (result['schemaVersion'] != 1 || result['enabled'] != true)
      throw StateError('The phone was not admitted.');
  }

  Future<void> _loop(int generation) async {
    _loopRunning = true;
    bool active() =>
        !_disposed && current() && generation == _generation && ready;
    try {
      while (active()) {
        try {
          await _heartbeat();
          if (!active()) break;
          if (_pending != null) {
            await _complete(_pending!);
            _pending = null;
            continue;
          }
          final response = await api.postJson(
            NativePaths.localAndroidCommandClaim,
            data: {'schemaVersion': 1, 'waitSeconds': 10},
          );
          if (!active()) break;
          final raw = response['command'];
          if (raw == null) {
            await Future<void>.delayed(const Duration(milliseconds: 700));
            continue;
          }
          if (raw is! Map)
            throw const FormatException('Invalid phone command.');
          final claim = Map<String, dynamic>.from(raw);
          final expiration = DateTime.tryParse(
            claim['expiresAt']?.toString() ?? '',
          );
          if (claim['schemaVersion'] != 1 ||
              claim['id'] is! String ||
              claim['claimToken'] is! String ||
              claim['claimGeneration'] is! int ||
              claim['runId'] is! String ||
              claim['executionId'] is! String ||
              !RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$')
                  .hasMatch(claim['runId'] as String) ||
              !RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$')
                  .hasMatch(claim['executionId'] as String) ||
              !const {
                'observe',
                'list_apps',
                'open_app',
                'press',
                'tap',
                'type',
                'scroll',
                'swipe',
                'back',
                'home',
              }.contains(claim['action']) ||
              claim['input'] is! Map ||
              expiration == null ||
              !expiration.isAfter(DateTime.now())) {
            throw const FormatException('Invalid phone command binding.');
          }
          Map<String, dynamic> result;
          try {
            final evidence = await api.getJsonFresh(
              '/api/runs/${Uri.encodeComponent(claim['runId'] as String)}',
            );
            final run = evidence['run'];
            if (!active() ||
                run is! Map ||
                run['id'] != claim['runId'] ||
                !const {
                  'running',
                  'resuming',
                  'waiting_approval',
                }.contains(run['status'])) {
              throw StateError('The phone task is no longer active.');
            }
            result = await host.execute({
              'id': claim['id'],
              'runId': claim['runId'],
              'executionId': claim['executionId'],
              'action': claim['action'],
              'input': claim['input'],
              'expiresAt': claim['expiresAt'],
              if (claim['authority'] != null) 'authority': claim['authority'],
            });
          } catch (_) {
            // The effect may have happened. Never run this command again.
            result = {
              'outcome': 'failed',
              'result': {
                'summary': 'The phone could not confirm the result. Check the screen before retrying.',
              },
              'errorCode': 'native_result_uncertain',
            };
          }
          if (!active()) break;
          _pending = {
            ...claim,
            'completion': {
              'schemaVersion': 1,
              'claimToken': claim['claimToken'],
              'outcome': result['outcome'],
              'result': result['result'],
              if (result['errorCode'] != null) 'errorCode': result['errorCode'],
            },
          };
          await _complete(_pending!);
          _pending = null;
          notice = null;
          _changed();
        } catch (_) {
          if (!active()) break;
          notice =
              'This phone is reconnecting. Accepted actions are not repeated.';
          _changed();
          await Future<void>.delayed(const Duration(seconds: 3));
        }
      }
    } finally {
      _loopRunning = false;
    }
  }

  Future<void> _complete(Map<String, dynamic> claim) async {
    final expires = DateTime.parse(claim['expiresAt'] as String);
    if (!expires.isAfter(DateTime.now())) {
      _pending = null;
      return;
    }
    final result = await api.postJson(
      NativePaths.localAndroidCommandComplete(claim['id'] as String),
      data: claim['completion'],
      headers: {
        'idempotency-key':
            'phone-complete-${claim['id']}-${claim['claimGeneration']}',
      },
    );
    if (result['accepted'] != true || result['commandId'] != claim['id'])
      throw const FormatException('The phone receipt was not accepted.');
  }

  @override
  void dispose() {
    _disposed = true;
    ++_generation;
    _pending = null;
    unawaited(_events?.cancel());
    if (host.supported) unawaited(_stopNative());
    super.dispose();
  }

  Future<void> _stopNative() async {
    try {
      await host.stop();
    } catch (_) {}
  }
}

final androidPhoneProvider = ChangeNotifierProvider<AndroidPhoneCoordinator>((
  ref,
) {
  final owner = ref.watch(sessionOwnerKeyProvider);
  final api = ref.watch(apiClientProvider);
  var alive = true;
  ref.onDispose(() => alive = false);
  final coordinator = AndroidPhoneCoordinator(
    api,
    appAndroidDeviceBridge,
    () =>
        alive &&
        ref.mounted &&
        owner != null &&
        ref.read(sessionOwnerKeyProvider) == owner &&
        !ref
            .read(biometricSessionLockControllerProvider)
            .state
            .blocksInteraction,
  );
  ref.listen(biometricSessionLockControllerProvider, (_, next) {
    if (next.state.blocksInteraction)
      unawaited(coordinator.stop('permission_lost'));
  });
  return coordinator;
});
