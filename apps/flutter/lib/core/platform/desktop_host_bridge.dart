import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

typedef DesktopRouteOpener = void Function(String route);

/// The deliberately small boundary between AppKit lifecycle affordances and
/// Asael's shared Flutter application.
///
/// Native code may ask Flutter to open only one of the allowlisted everyday
/// workspaces. It cannot submit domain commands, pass credentials, or widen
/// authority through this channel.
class DesktopHostBridge {
  DesktopHostBridge({MethodChannel? channel, bool? enabled})
    : _channel = channel ?? const MethodChannel(_channelName),
      _enabled = enabled ?? _isMacOS;

  static const _channelName = 'app.omniagent.omniagent/desktop';
  static const allowedRoutes = <String>{
    '/today',
    '/talk',
    '/quick-entry',
    '/capture',
    '/inbox',
  };

  static bool get _isMacOS =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

  final MethodChannel _channel;
  final bool _enabled;
  DesktopRouteOpener? _openRoute;
  String? _pendingRoute;
  bool _initialized = false;

  Future<void> initialize() async {
    if (!_enabled || _initialized) return;
    _initialized = true;
    _channel.setMethodCallHandler(handleNativeCall);
    try {
      await _channel.invokeMethod<void>('flutterReady');
    } on MissingPluginException {
      // Widget tests and an unconfigured development runner have no AppKit host.
    } on PlatformException {
      // Navigation remains available inside Flutter if host setup is incomplete.
    }
  }

  void attachRouter(GoRouter router) => attachRouteOpener(router.go);

  @visibleForTesting
  void attachRouteOpener(DesktopRouteOpener opener) {
    _openRoute = opener;
    final pendingRoute = _pendingRoute;
    _pendingRoute = null;
    if (pendingRoute != null) {
      unawaited(Future<void>(() => _dispatch(pendingRoute)));
    }
  }

  @visibleForTesting
  Future<Object?> handleNativeCall(MethodCall call) async {
    if (call.method != 'openRoute') {
      throw PlatformException(
        code: 'unsupported_desktop_intent',
        message: 'The desktop host intent is not supported.',
      );
    }

    final arguments = call.arguments;
    final route = arguments is Map && arguments.length == 1
        ? arguments['route']
        : null;
    if (route is! String || !allowedRoutes.contains(route)) {
      throw PlatformException(
        code: 'invalid_desktop_route',
        message: 'The desktop host route is not allowlisted.',
      );
    }

    _dispatch(route);
    return null;
  }

  void _dispatch(String route) {
    final opener = _openRoute;
    if (opener == null) {
      _pendingRoute = route;
      return;
    }
    opener(route);
  }

  /// Restores the ordinary desktop window after Flutter leaves Quick Entry.
  /// This changes presentation only; no command, credential, or tool argument
  /// crosses the native bridge.
  Future<void> showMainPresentation() async {
    if (!_enabled) return;
    try {
      await _channel.invokeMethod<void>('showMainPresentation');
    } on MissingPluginException {
      // Tests and development runners may not have the AppKit host attached.
    } on PlatformException {
      // Flutter navigation remains usable if native presentation restoration fails.
    }
  }

  /// Compacts the native window only after Flutter has rendered Quick Entry.
  /// Sequencing route replacement before resize avoids overlapping responsive
  /// and accessibility-tree transitions on macOS 27.
  Future<void> showQuickEntryPresentation() async {
    if (!_enabled) return;
    try {
      await _channel.invokeMethod<void>('showQuickEntryPresentation');
    } on MissingPluginException {
      // Tests and development runners may not have the AppKit host attached.
    } on PlatformException {
      // The route remains usable at the ordinary window size.
    }
  }

  Future<void> dispose() async {
    if (!_enabled || !_initialized) return;
    _channel.setMethodCallHandler(null);
    _openRoute = null;
    _pendingRoute = null;
    _initialized = false;
  }
}

/// One process-wide bridge owns the native method handler and presentation
/// requests. Keeping it here also lets routing and the app lifecycle share the
/// same deliberately small boundary.
final appDesktopHostBridge = DesktopHostBridge();
