import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

enum MacosPowerState { unknown, enabled, disabled }

/// One lazy power subscription per engine. macOS motion requires an explicit
/// disabled snapshot; other platforms keep their existing motion policy.
class MacosPowerStateMonitor extends ChangeNotifier
    with WidgetsBindingObserver
    implements ValueListenable<MacosPowerState> {
  MacosPowerStateMonitor({bool? supported, this._messenger})
    : _supported =
          supported ??
          (!kIsWeb && defaultTargetPlatform == TargetPlatform.macOS);

  static final instance = MacosPowerStateMonitor();
  static const channelName = 'app.omniagent.omniagent/power-state/events';
  static const _codec = StandardMethodCodec();

  final bool _supported;
  final BinaryMessenger? _messenger;
  MacosPowerState _value = MacosPowerState.unknown;
  Future<void> _transport = Future<void>.value();
  bool _observing = false, _foreground = false, _listening = false;
  bool _disposed = false;
  int _generation = 0;

  BinaryMessenger get _binaryMessenger =>
      _messenger ?? ServicesBinding.instance.defaultBinaryMessenger;

  @override
  MacosPowerState get value => _supported ? _value : MacosPowerState.disabled;

  static MacosPowerState parse(Object? event) {
    if (event is! Map ||
        event.length != 2 ||
        event['schemaVersion'] is! int ||
        event['schemaVersion'] != 1) {
      return MacosPowerState.unknown;
    }
    return switch (event['lowPowerMode']) {
      'enabled' => MacosPowerState.enabled,
      'disabled' => MacosPowerState.disabled,
      _ => MacosPowerState.unknown,
    };
  }

  @override
  void addListener(VoidCallback listener) {
    super.addListener(listener);
    if (!_supported || _observing) {
      return;
    }
    _observing = true;
    final binding = WidgetsBinding.instance;
    binding.addObserver(this);
    _foreground =
        binding.lifecycleState == null ||
        binding.lifecycleState == AppLifecycleState.resumed ||
        binding.lifecycleState == AppLifecycleState.inactive;
    _replaceSubscription();
  }

  @override
  void removeListener(VoidCallback listener) {
    super.removeListener(listener);
    if (_observing && !hasListeners) {
      _observing = false;
      WidgetsBinding.instance.removeObserver(this);
      _replaceSubscription();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // An unfocused macOS window can still be visible, including the floating
    // voice companion. Continue observing actual Low Power Mode in that state.
    final foreground =
        state == AppLifecycleState.resumed ||
        state == AppLifecycleState.inactive;
    if (_foreground == foreground) {
      return;
    }
    _foreground = foreground;
    _replaceSubscription();
  }

  bool _current(int generation) =>
      !_disposed &&
      _observing &&
      hasListeners &&
      _foreground &&
      generation == _generation;

  void _publish(MacosPowerState state) {
    if (_disposed || state == _value) {
      return;
    }
    _value = state;
    if (hasListeners) {
      notifyListeners();
    }
  }

  void _replaceSubscription() {
    final generation = ++_generation;
    _publish(MacosPowerState.unknown);
    _transport = _transport.then((_) async {
      if (generation != _generation) {
        return;
      }
      // A cancellation must finish before a later listen can replace its sink.
      await _cancel();
      if (!_current(generation)) {
        return;
      }
      _listening = true;
      _binaryMessenger.setMessageHandler(channelName, (message) async {
        if (!_current(generation)) {
          return null;
        }
        if (message == null) {
          _endSubscription(generation);
          return null;
        }
        try {
          _publish(parse(_codec.decodeEnvelope(message)));
        } catch (_) {
          _publish(MacosPowerState.unknown);
        }
        return null;
      });
      try {
        // EventChannel activation failures otherwise go to FlutterError rather
        // than the stream's onError. Missing/older hosts are a static fallback.
        await MethodChannel(
          channelName,
          _codec,
          _binaryMessenger,
        ).invokeMethod<void>('listen');
      } catch (_) {
        _endSubscription(generation);
      }
    });
  }

  void _endSubscription(int generation) {
    if (!_current(generation)) {
      return;
    }
    final endedGeneration = ++_generation;
    _publish(MacosPowerState.unknown);
    _transport = _transport.then((_) async {
      if (endedGeneration == _generation) {
        await _cancel();
      }
    });
  }

  Future<void> _cancel() async {
    if (!_listening) {
      return;
    }
    _listening = false;
    // Consume old events while the host removes its sink, so channel buffering
    // cannot deliver them as the next subscription's initial snapshot.
    _binaryMessenger.setMessageHandler(channelName, (_) async => null);
    try {
      await MethodChannel(
        channelName,
        _codec,
        _binaryMessenger,
      ).invokeMethod<void>('cancel');
    } catch (_) {
      // Cancellation of an absent/closed host cannot authorize motion.
    } finally {
      _binaryMessenger.setMessageHandler(channelName, null);
    }
  }

  @override
  void dispose() {
    if (_observing) {
      WidgetsBinding.instance.removeObserver(this);
    }
    _disposed = true;
    _observing = false;
    _generation++;
    _value = MacosPowerState.unknown;
    _transport = _transport.then((_) => _cancel());
    super.dispose();
  }
}
