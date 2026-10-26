import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/legacy.dart';

/// Set before runApp from the main AppKit engine's validated fixed ticket.
/// It can only delay editing and business effects, never authorize an effect.
class NativeUpdateStartupGate extends ChangeNotifier {
  String? _nonce;
  DateTime? _expiresAt;
  String? get nonce => _nonce;
  DateTime? get expiresAt => _expiresAt;
  Stopwatch? _clock;
  Duration _duration = Duration.zero;
  Timer? _timer;
  String _decision = 'none';
  String get decision => _decision;
  bool get active =>
      decision == 'pending' && _clock != null && _clock!.elapsed < _duration;

  void initialize(List<String> arguments) {
    if (decision != 'none') return;
    final values = arguments
        .where((value) => value.startsWith('--asael-update-quarantine='))
        .toList();
    if (values.length != 1) return;
    final match = RegExp(
      r'^--asael-update-quarantine=([a-f0-9]{64}):([0-9]{13})$',
    ).firstMatch(values.single);
    if (match == null) return;
    final expiry = DateTime.fromMillisecondsSinceEpoch(
      int.parse(match.group(2)!),
      isUtc: true,
    );
    final remaining = expiry.difference(DateTime.now().toUtc());
    if (remaining <= Duration.zero || remaining > const Duration(seconds: 90)) {
      return;
    }
    _nonce = match.group(1);
    _expiresAt = expiry;
    _duration = remaining;
    _clock = Stopwatch()..start();
    _decision = 'pending';
    _timer = Timer(remaining, () {
      _decision = 'expired';
      notifyListeners();
    });
  }

  bool commit(String exactNonce) {
    if (!active || nonce != exactNonce) return false;
    _timer?.cancel();
    _decision = 'committed';
    notifyListeners();
    return true;
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}

final nativeUpdateStartupGate = NativeUpdateStartupGate();

/// A bounded handoff stops new claims before idle is acknowledged. It never
/// changes the user's enabled preference and expires if the installer vanishes.
class NativeUpdateHandoffGate {
  String? _nonce;
  Stopwatch? _clock;
  Duration _duration = Duration.zero;
  bool get active => _clock != null && _clock!.elapsed < _duration;
  bool begin(String nonce, Duration duration) {
    if (duration <= Duration.zero || duration > const Duration(seconds: 30)) {
      return false;
    }
    if (active && _nonce != nonce) return false;
    _nonce = nonce;
    _duration = duration;
    _clock = Stopwatch()..start();
    return true;
  }

  void release(String nonce) {
    if (_nonce != nonce) return;
    _clock = null;
    _nonce = null;
  }
}

final nativeUpdateHandoffGate = NativeUpdateHandoffGate();
bool get nativeUpdateBusinessEffectsPaused =>
    nativeUpdateStartupGate.active || nativeUpdateHandoffGate.active;

final _pendingBusinessRequests = <Object>{};
int get nativeUpdatePendingBusinessRequests => _pendingBusinessRequests.length;
Object beginNativeUpdateBusinessRequest(Object? previous) {
  _pendingBusinessRequests.remove(previous);
  final token = Object();
  _pendingBusinessRequests.add(token);
  return token;
}

void finishNativeUpdateBusinessRequest(Object? token) {
  _pendingBusinessRequests.remove(token);
}

final nativeUpdateStartupGateProvider =
    ChangeNotifierProvider<NativeUpdateStartupGate>(
      (ref) => nativeUpdateStartupGate,
    );
