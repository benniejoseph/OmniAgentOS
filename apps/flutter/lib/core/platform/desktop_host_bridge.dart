import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

typedef DesktopRouteOpener = void Function(String route);
typedef DesktopNotificationActionHandler = Future<void> Function(
  DesktopNotificationAction action,
);
typedef DesktopApnsRegistrationHandler = Future<void> Function(
  DesktopApnsRegistration registration,
);

enum DesktopNotificationCommand { open, complete, snooze15, dismiss }

class DesktopNotificationAction {
  const DesktopNotificationAction({required this.command, required this.data});

  factory DesktopNotificationAction.fromArguments(Object? arguments) {
    if (arguments is! Map || arguments.length != 2) {
      throw const FormatException('The native notification action is invalid.');
    }
    final command = DesktopNotificationCommand.values.firstWhere(
      (value) => value.name == arguments['action'],
      orElse: () => throw const FormatException(
        'The native notification command is invalid.',
      ),
    );
    final data = arguments['data'];
    if (data is! Map) {
      throw const FormatException(
        'The native notification payload is invalid.',
      );
    }
    return DesktopNotificationAction(
      command: command,
      data: Map<String, dynamic>.from(data),
    );
  }

  final DesktopNotificationCommand command;
  final Map<String, dynamic> data;
}

class DesktopApnsRegistration {
  const DesktopApnsRegistration.success({
    required this.token,
    required this.environment,
  }) : errorCode = null;

  const DesktopApnsRegistration.failure(this.errorCode)
    : token = null,
      environment = null;

  final String? token;
  final String? environment;
  final String? errorCode;

  bool get succeeded => token != null;
}

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
  DesktopNotificationActionHandler? _notificationHandler;
  final List<DesktopNotificationAction> _pendingNotificationActions = [];
  DesktopApnsRegistrationHandler? _apnsHandler;
  DesktopApnsRegistration? _pendingApnsRegistration;
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
    switch (call.method) {
      case 'openRoute':
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
      case 'notificationAction':
        try {
          final action = DesktopNotificationAction.fromArguments(
            call.arguments,
          );
          final handler = _notificationHandler;
          if (handler == null) {
            if (_pendingNotificationActions.length >= 32) {
              throw const FormatException(
                'The native notification action queue is full.',
              );
            }
            _pendingNotificationActions.add(action);
          } else {
            await handler(action);
          }
          return null;
        } on FormatException catch (error) {
          throw PlatformException(
            code: 'invalid_notification_action',
            message: error.message,
          );
        }
      case 'apnsRegistration':
        final arguments = call.arguments;
        DesktopApnsRegistration registration;
        if (arguments is Map &&
            arguments.length == 2 &&
            arguments['token'] is String &&
            RegExp(r'^[a-f0-9]{64,512}$')
                .hasMatch(arguments['token'] as String) &&
            const {
              'sandbox',
              'production',
            }.contains(arguments['environment'])) {
          registration = DesktopApnsRegistration.success(
            token: arguments['token'] as String,
            environment: arguments['environment'] as String,
          );
        } else if (arguments is Map &&
            arguments.length == 1 &&
            arguments['errorCode'] is String) {
          final errorCode = arguments['errorCode'] as String;
          registration = DesktopApnsRegistration.failure(
            errorCode.substring(
              0,
              errorCode.length > 160 ? 160 : errorCode.length,
            ),
          );
        } else {
          throw PlatformException(
            code: 'invalid_apns_registration',
            message: 'The native APNs registration receipt is invalid.',
          );
        }
        final handler = _apnsHandler;
        if (handler == null) {
          _pendingApnsRegistration = registration;
        } else {
          await handler(registration);
        }
        return null;
      default:
        throw PlatformException(
          code: 'unsupported_desktop_intent',
          message: 'The desktop host intent is not supported.',
        );
    }
  }

  void attachNotificationHandler(DesktopNotificationActionHandler? handler) {
    _notificationHandler = handler;
    if (handler != null && _pendingNotificationActions.isNotEmpty) {
      final pending = List<DesktopNotificationAction>.of(
        _pendingNotificationActions,
      );
      _pendingNotificationActions.clear();
      unawaited(() async {
        for (final action in pending) {
          await handler(action);
        }
      }());
    }
  }

  void attachApnsRegistrationHandler(DesktopApnsRegistrationHandler? handler) {
    _apnsHandler = handler;
    final pending = _pendingApnsRegistration;
    if (handler != null && pending != null) {
      _pendingApnsRegistration = null;
      unawaited(handler(pending));
    }
  }

  Future<void> requestRemoteNotifications() async {
    if (!_enabled) return;
    await _invokePresentationMethod('requestRemoteNotifications');
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
    await _invokePresentationMethod('showMainPresentation');
  }

  /// Compacts the native window only after Flutter has rendered Quick Entry.
  /// Sequencing route replacement before resize avoids overlapping responsive
  /// and accessibility-tree transitions on macOS 27.
  Future<void> showQuickEntryPresentation() async {
    if (!_enabled) return;
    await _invokePresentationMethod('showQuickEntryPresentation');
  }

  Future<void> _invokePresentationMethod(String method) async {
    try {
      await _channel.invokeMethod<void>(method);
    } on MissingPluginException {
      // Tests and development runners may not have the AppKit host attached.
    } on PlatformException {
      // Flutter remains usable if an optional native presentation action fails.
    }
  }

  Future<void> dispose() async {
    if (!_enabled || !_initialized) return;
    _channel.setMethodCallHandler(null);
    _openRoute = null;
    _pendingRoute = null;
    _notificationHandler = null;
    _pendingNotificationActions.clear();
    _apnsHandler = null;
    _pendingApnsRegistration = null;
    _initialized = false;
  }
}

/// One process-wide bridge owns the native method handler and presentation
/// requests. Keeping it here also lets routing and the app lifecycle share the
/// same deliberately small boundary.
final appDesktopHostBridge = DesktopHostBridge();
