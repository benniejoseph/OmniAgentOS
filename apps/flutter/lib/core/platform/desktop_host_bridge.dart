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
    final route = arguments is Map ? arguments['route'] : null;
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

  Future<void> dispose() async {
    if (!_enabled || !_initialized) return;
    _channel.setMethodCallHandler(null);
    _openRoute = null;
    _pendingRoute = null;
    _initialized = false;
  }
}
