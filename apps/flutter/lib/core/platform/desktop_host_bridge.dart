import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

typedef DesktopRouteOpener = void Function(String route);
typedef DesktopNotificationActionHandler = Future<void> Function(
  DesktopNotificationAction action,
);
typedef DesktopNotificationReceivedHandler = Future<void> Function(
  DesktopNotificationReceived delivery,
);
typedef DesktopApnsRegistrationHandler = Future<void> Function(
  DesktopApnsRegistration registration,
);
typedef DesktopSharedCaptureHandler = Future<void> Function(
  DesktopSharedCapture capture,
);
typedef DesktopAmbientVoiceRequestHandler = Future<void> Function(
  DesktopAmbientVoiceRequest request,
);

enum DesktopNotificationCommand { open, complete, snooze15, dismiss }

enum DesktopQuickEntryShortcut {
  commandShiftSpace('command_shift_space', 'Command + Shift + Space'),
  optionSpace('option_space', 'Option + Space'),
  controlSpace('control_space', 'Control + Space'),
  disabled('disabled', 'Disabled');

  const DesktopQuickEntryShortcut(this.id, this.label);
  final String id;
  final String label;

  static DesktopQuickEntryShortcut fromId(String id) => values.firstWhere(
    (value) => value.id == id,
    orElse: () => throw const FormatException(
      'The native shortcut selection is invalid.',
    ),
  );
}

enum DesktopAmbientVoiceState {
  asleep,
  listening,
  review,
  running,
  speaking,
  approval,
  offline,
  error,
}

enum DesktopAmbientVoiceRequestSource {
  menu('menu'),
  shortcut('shortcut'),
  vocalShortcut('vocal_shortcut');

  const DesktopAmbientVoiceRequestSource(this.id);
  final String id;

  static DesktopAmbientVoiceRequestSource fromId(String id) =>
      values.firstWhere(
        (value) => value.id == id,
        orElse: () => throw const FormatException(
          'The ambient voice request source is invalid.',
        ),
      );
}

class DesktopAmbientVoiceRequest {
  const DesktopAmbientVoiceRequest({required this.source});

  factory DesktopAmbientVoiceRequest.fromArguments(Object? arguments) {
    if (arguments is! Map ||
        arguments.length != 1 ||
        arguments['source'] is! String) {
      throw const FormatException('The ambient voice request is invalid.');
    }
    return DesktopAmbientVoiceRequest(
      source: DesktopAmbientVoiceRequestSource.fromId(
        arguments['source'] as String,
      ),
    );
  }

  final DesktopAmbientVoiceRequestSource source;
}

class DesktopAmbientVoiceAvailability {
  const DesktopAmbientVoiceAvailability({
    required this.available,
    required this.state,
  });

  factory DesktopAmbientVoiceAvailability.fromArguments(Object? arguments) {
    if (arguments is! Map ||
        arguments.length != 2 ||
        arguments['available'] is! bool ||
        arguments['state'] is! String) {
      throw const FormatException('The ambient voice availability is invalid.');
    }
    final stateName = arguments['state'] as String;
    return DesktopAmbientVoiceAvailability(
      available: arguments['available'] as bool,
      state: DesktopAmbientVoiceState.values.firstWhere(
        (value) => value.name == stateName,
        orElse: () =>
            throw const FormatException('The ambient voice state is invalid.'),
      ),
    );
  }

  final bool available;
  final DesktopAmbientVoiceState state;
}

class DesktopShortcutState {
  const DesktopShortcutState({
    required this.shortcut,
    required this.registered,
  });

  factory DesktopShortcutState.fromArguments(Object? arguments) {
    if (arguments is! Map ||
        arguments.length != 2 ||
        arguments['shortcut'] is! String ||
        arguments['registered'] is! bool) {
      throw const FormatException('The native shortcut state is invalid.');
    }
    return DesktopShortcutState(
      shortcut: DesktopQuickEntryShortcut.fromId(
        arguments['shortcut'] as String,
      ),
      registered: arguments['registered'] as bool,
    );
  }

  final DesktopQuickEntryShortcut shortcut;
  final bool registered;
}

class DesktopNotificationAction {
  const DesktopNotificationAction({
    required this.command,
    required this.data,
    required this.appLifecycle,
    required this.observedAt,
  });

  factory DesktopNotificationAction.fromArguments(Object? arguments) {
    if (arguments is! Map ||
        (arguments.length != 2 &&
            arguments.length != 3 &&
            arguments.length != 4)) {
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
    final appLifecycle = _desktopNotificationLifecycle(
      arguments['appLifecycle'],
    );
    return DesktopNotificationAction(
      command: command,
      data: Map<String, dynamic>.from(data),
      appLifecycle: appLifecycle,
      observedAt: _desktopNotificationObservedAt(arguments['observedAt']),
    );
  }

  final DesktopNotificationCommand command;
  final Map<String, dynamic> data;
  final String appLifecycle;
  final DateTime observedAt;
}

class DesktopNotificationReceived {
  const DesktopNotificationReceived({
    required this.data,
    required this.appLifecycle,
    required this.observedAt,
  });

  factory DesktopNotificationReceived.fromArguments(Object? arguments) {
    if (arguments is! Map ||
        (arguments.length != 2 && arguments.length != 3) ||
        arguments['data'] is! Map) {
      throw const FormatException(
        'The native notification delivery is invalid.',
      );
    }
    return DesktopNotificationReceived(
      data: Map<String, dynamic>.from(arguments['data'] as Map),
      appLifecycle: _desktopNotificationLifecycle(arguments['appLifecycle']),
      observedAt: _desktopNotificationObservedAt(arguments['observedAt']),
    );
  }

  final Map<String, dynamic> data;
  final String appLifecycle;
  final DateTime observedAt;
}

String _desktopNotificationLifecycle(Object? value) => switch (value) {
  'foreground' || 'background' || 'terminated' || 'unknown' => value as String,
  null => 'unknown',
  _ => throw const FormatException(
    'The native notification lifecycle is invalid.',
  ),
};

DateTime _desktopNotificationObservedAt(Object? value) {
  if (value == null) return DateTime.now().toUtc();
  if (value is! String || value.length > 64) {
    throw const FormatException(
      'The native notification observation time is invalid.',
    );
  }
  final parsed = DateTime.tryParse(value);
  if (parsed == null) {
    throw const FormatException(
      'The native notification observation time is invalid.',
    );
  }
  return parsed.toUtc();
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

class DesktopSharedCapture {
  const DesktopSharedCapture({required this.requestId, required this.paths});

  factory DesktopSharedCapture.fromArguments(Object? arguments) {
    if (arguments is! Map || arguments.length != 2) {
      throw const FormatException('The shared capture request is invalid.');
    }
    final requestId = arguments['requestId'];
    final files = arguments['files'];
    if (requestId is! String ||
        !RegExp(
          r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        ).hasMatch(requestId) ||
        files is! List ||
        files.isEmpty ||
        files.length > 25 ||
        files.any(
          (value) =>
              value is! String ||
              value.isEmpty ||
              value.length > 8192 ||
              value.contains(RegExp(r'[\x00-\x1f\x7f]')),
        )) {
      throw const FormatException('The shared capture payload is invalid.');
    }
    final paths = files.cast<String>();
    if (paths.toSet().length != paths.length) {
      throw const FormatException('The shared capture contains duplicates.');
    }
    return DesktopSharedCapture(
      requestId: requestId,
      paths: List<String>.unmodifiable(paths),
    );
  }

  final String requestId;
  final List<String> paths;
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

  static final _workspaceRoute = RegExp(
    r'^/(talk|today|capture|inbox|knowledge|projects|meetings|results|automation)(/[A-Za-z0-9._~%:-]{1,500})?$',
  );

  static bool isWorkspaceRoute(String route) =>
      route.length <= 600 && _workspaceRoute.hasMatch(route);

  static bool get _isMacOS =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

  final MethodChannel _channel;
  final bool _enabled;
  bool get supported => _enabled;
  DesktopRouteOpener? _openRoute;
  String? _pendingRoute;
  DesktopNotificationActionHandler? _notificationHandler;
  final List<DesktopNotificationAction> _pendingNotificationActions = [];
  DesktopNotificationReceivedHandler? _notificationReceivedHandler;
  final List<DesktopNotificationReceived> _pendingNotificationDeliveries = [];
  bool _notificationHandlerSignaled = false;
  DesktopApnsRegistrationHandler? _apnsHandler;
  DesktopApnsRegistration? _pendingApnsRegistration;
  DesktopSharedCaptureHandler? _sharedCaptureHandler;
  final List<DesktopSharedCapture> _pendingSharedCaptures = [];
  DesktopAmbientVoiceRequestHandler? _ambientVoiceRequestHandler;
  DesktopAmbientVoiceRequest? _pendingAmbientVoiceRequest;
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
      case 'openAmbientVoice':
        try {
          final request = DesktopAmbientVoiceRequest.fromArguments(
            call.arguments,
          );
          final handler = _ambientVoiceRequestHandler;
          if (handler == null) {
            // Attention requests carry no work or authority. Last-write-wins
            // avoids replaying a burst of stale shortcut invocations once the
            // Flutter voice surface becomes ready.
            _pendingAmbientVoiceRequest = request;
          } else {
            await handler(request);
          }
          return null;
        } on FormatException catch (error) {
          throw PlatformException(
            code: 'invalid_ambient_voice_request',
            message: error.message,
          );
        }
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
      case 'notificationReceived':
        try {
          final delivery = DesktopNotificationReceived.fromArguments(
            call.arguments,
          );
          final handler = _notificationReceivedHandler;
          if (handler == null) {
            if (_pendingNotificationDeliveries.length >= 32) {
              throw const FormatException(
                'The native notification delivery queue is full.',
              );
            }
            _pendingNotificationDeliveries.add(delivery);
          } else {
            await handler(delivery);
          }
          return null;
        } on FormatException catch (error) {
          throw PlatformException(
            code: 'invalid_notification_delivery',
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
      case 'sharedCapture':
        try {
          final capture = DesktopSharedCapture.fromArguments(call.arguments);
          final handler = _sharedCaptureHandler;
          if (handler == null) {
            if (_pendingSharedCaptures.length >= 16) {
              throw const FormatException(
                'The shared capture request queue is full.',
              );
            }
            if (_pendingSharedCaptures.every(
              (pending) => pending.requestId != capture.requestId,
            )) {
              _pendingSharedCaptures.add(capture);
            }
          } else {
            await handler(capture);
          }
          return null;
        } on FormatException catch (error) {
          throw PlatformException(
            code: 'invalid_shared_capture',
            message: error.message,
          );
        }
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
    _signalNotificationHandlerReadiness();
  }

  void attachNotificationReceivedHandler(
    DesktopNotificationReceivedHandler? handler,
  ) {
    _notificationReceivedHandler = handler;
    if (handler != null && _pendingNotificationDeliveries.isNotEmpty) {
      final pending = List<DesktopNotificationReceived>.of(
        _pendingNotificationDeliveries,
      );
      _pendingNotificationDeliveries.clear();
      unawaited(() async {
        for (final delivery in pending) {
          await handler(delivery);
        }
      }());
    }
    _signalNotificationHandlerReadiness();
  }

  void _signalNotificationHandlerReadiness() {
    final ready =
        _notificationHandler != null && _notificationReceivedHandler != null;
    if (!_enabled || ready == _notificationHandlerSignaled) return;
    _notificationHandlerSignaled = ready;
    unawaited(
      _invokePresentationMethod(
        ready ? 'notificationHandlerReady' : 'notificationHandlerPaused',
      ),
    );
  }

  void attachApnsRegistrationHandler(DesktopApnsRegistrationHandler? handler) {
    _apnsHandler = handler;
    final pending = _pendingApnsRegistration;
    if (handler != null && pending != null) {
      _pendingApnsRegistration = null;
      unawaited(handler(pending));
    }
  }

  void attachSharedCaptureHandler(DesktopSharedCaptureHandler? handler) {
    _sharedCaptureHandler = handler;
    if (handler != null && _pendingSharedCaptures.isNotEmpty) {
      final pending = List<DesktopSharedCapture>.of(_pendingSharedCaptures);
      _pendingSharedCaptures.clear();
      unawaited(() async {
        for (final capture in pending) {
          await handler(capture);
        }
      }());
    }
  }

  void attachAmbientVoiceRequestHandler(
    DesktopAmbientVoiceRequestHandler? handler,
  ) {
    _ambientVoiceRequestHandler = handler;
    final pending = _pendingAmbientVoiceRequest;
    if (handler != null && pending != null) {
      _pendingAmbientVoiceRequest = null;
      unawaited(handler(pending));
    }
  }

  Future<void> completeSharedCapture(String requestId) async {
    await _invokeSharedCaptureMethod('completeSharedCapture', requestId);
  }

  Future<void> retrySharedCapture(String requestId) async {
    await _invokeSharedCaptureMethod('retrySharedCapture', requestId);
  }

  Future<void> _invokeSharedCaptureMethod(
    String method,
    String requestId,
  ) async {
    if (!_enabled) return;
    try {
      await _channel.invokeMethod<void>(method, {'requestId': requestId});
    } on MissingPluginException {
      // Widget tests and development runners may not have an AppKit host.
    }
  }

  Future<void> requestRemoteNotifications() async {
    if (!_enabled) return;
    await _invokePresentationMethod('requestRemoteNotifications');
  }

  Future<DesktopShortcutState> getQuickEntryShortcut() async {
    if (!_enabled) {
      return const DesktopShortcutState(
        shortcut: DesktopQuickEntryShortcut.disabled,
        registered: false,
      );
    }
    final result = await _channel.invokeMethod<Object?>(
      'getQuickEntryShortcut',
    );
    return DesktopShortcutState.fromArguments(result);
  }

  Future<DesktopShortcutState> setQuickEntryShortcut(
    DesktopQuickEntryShortcut shortcut,
  ) async {
    if (!_enabled) {
      return DesktopShortcutState(shortcut: shortcut, registered: false);
    }
    final result = await _channel.invokeMethod<Object?>(
      'setQuickEntryShortcut',
      {'shortcut': shortcut.id},
    );
    return DesktopShortcutState.fromArguments(result);
  }

  Future<DesktopAmbientVoiceAvailability> getAmbientVoiceAvailability() async {
    if (!_enabled) {
      return const DesktopAmbientVoiceAvailability(
        available: false,
        state: DesktopAmbientVoiceState.asleep,
      );
    }
    final result = await _channel.invokeMethod<Object?>(
      'getAmbientVoiceAvailability',
    );
    return DesktopAmbientVoiceAvailability.fromArguments(result);
  }

  Future<DesktopAmbientVoiceAvailability> setAmbientVoiceAvailability(
    bool available,
  ) async {
    if (!_enabled) {
      return DesktopAmbientVoiceAvailability(
        available: available,
        state: DesktopAmbientVoiceState.asleep,
      );
    }
    final result = await _channel.invokeMethod<Object?>(
      'setAmbientVoiceAvailability',
      {'available': available},
    );
    return DesktopAmbientVoiceAvailability.fromArguments(result);
  }

  /// Publishes presentation state only. This cannot dispatch a prompt, select
  /// an execution target, approve an action, or grant Computer Use authority.
  Future<DesktopAmbientVoiceAvailability> updateAmbientVoiceState(
    DesktopAmbientVoiceState state,
  ) async {
    if (!_enabled) {
      return DesktopAmbientVoiceAvailability(available: false, state: state);
    }
    final result = await _channel.invokeMethod<Object?>(
      'updateAmbientVoiceState',
      {'state': state.name},
    );
    return DesktopAmbientVoiceAvailability.fromArguments(result);
  }

  Future<void> openWorkspaceWindow(String route) async {
    if (!_enabled) return;
    if (!isWorkspaceRoute(route)) {
      throw ArgumentError.value(route, 'route', 'Unsupported workspace route');
    }
    await _channel.invokeMethod<void>('openWorkspaceWindow', {'route': route});
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

  /// Presents the voice-only HUD independently from the larger Quick Entry
  /// composer. No transcript, destination, command, or authority crosses this
  /// presentation-only bridge.
  Future<void> showAmbientVoicePresentation() async {
    if (!_enabled) return;
    await _invokePresentationMethod('showAmbientVoicePresentation');
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
    _notificationReceivedHandler = null;
    _pendingNotificationDeliveries.clear();
    _notificationHandlerSignaled = false;
    _apnsHandler = null;
    _pendingApnsRegistration = null;
    _sharedCaptureHandler = null;
    _pendingSharedCaptures.clear();
    _ambientVoiceRequestHandler = null;
    _pendingAmbientVoiceRequest = null;
    _initialized = false;
  }
}

/// One process-wide bridge owns the native method handler and presentation
/// requests. Keeping it here also lets routing and the app lifecycle share the
/// same deliberately small boundary.
final appDesktopHostBridge = DesktopHostBridge();
