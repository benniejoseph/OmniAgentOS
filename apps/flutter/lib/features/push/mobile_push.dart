import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/platform/desktop_host_bridge.dart';
import '../../core/storage/secure_session_store.dart';
import '../../generated/native_contract.g.dart';
import '../auth/application/session_controller.dart';
import '../auth/domain/app_session.dart';

enum MobilePushState {
  initializing,
  disabled,
  denied,
  ready,
  configurationRequired,
  error,
}

enum MobilePushPreviewPolicy { hidden, generic, title }

extension MobilePushPreviewPolicyCopy on MobilePushPreviewPolicy {
  String get apiValue => name;

  String get label => switch (this) {
    MobilePushPreviewPolicy.hidden => 'Hide notification content',
    MobilePushPreviewPolicy.generic => 'Show generic context',
    MobilePushPreviewPolicy.title => 'Show notification titles',
  };
}

class MobilePushEnvelope {
  const MobilePushEnvelope({
    required this.deliveryId,
    required this.causeKind,
    required this.causeId,
    required this.deepLink,
    this.notificationId,
    this.parentId,
  });

  factory MobilePushEnvelope.fromData(Map<String, dynamic> raw) {
    final data = _unwrapPushData(raw);
    if (data['schemaVersion']?.toString() != '1') {
      throw const FormatException('Unknown push envelope version.');
    }
    final deliveryId = _pushId(data['deliveryId'], 'deliveryId');
    final causeId = _pushId(data['causeId'], 'causeId');
    final causeKind = data['causeKind']?.toString();
    if (!const {
      'approval',
      'work_item',
      'meeting',
      'customer',
      'run',
    }.contains(causeKind)) {
      throw const FormatException('Unknown push target.');
    }
    final parentId = data['parentId'] == null
        ? null
        : _pushId(data['parentId'], 'parentId');
    if (causeKind != 'work_item' && parentId != null) {
      throw const FormatException('Push parent scope is invalid.');
    }
    final expected = causalDeepLink(causeKind!, causeId, parentId: parentId);
    if (data['deepLink']?.toString() != expected) {
      throw const FormatException('Push deep link is not causal.');
    }
    return MobilePushEnvelope(
      deliveryId: deliveryId,
      notificationId: data['notificationId'] == null
          ? null
          : _pushId(data['notificationId'], 'notificationId'),
      causeKind: causeKind,
      causeId: causeId,
      parentId: parentId,
      deepLink: expected,
    );
  }

  final String deliveryId;
  final String? notificationId;
  final String causeKind;
  final String causeId;
  final String? parentId;
  final String deepLink;

  Map<String, dynamic> toJson() => {
    'schemaVersion': '1',
    'deliveryId': deliveryId,
    if (notificationId != null) 'notificationId': notificationId,
    'causeKind': causeKind,
    'causeId': causeId,
    if (parentId != null) 'parentId': parentId,
    'deepLink': deepLink,
  };

  static String causalDeepLink(String kind, String id, {String? parentId}) {
    final encodedId = Uri.encodeComponent(id);
    return switch (kind) {
      'approval' => '/inbox/approvals/$encodedId',
      'work_item' =>
        parentId == null
            ? '/today?workItemId=$encodedId'
            : '/projects/${Uri.encodeComponent(parentId)}?workItemId=$encodedId',
      'meeting' => '/meetings/$encodedId',
      'customer' => '/customers/$encodedId',
      'run' => '/results/${Uri.encodeComponent('agent:$id')}',
      _ => throw const FormatException('Unknown push target.'),
    };
  }
}

class MobilePushCoordinator extends ChangeNotifier {
  MobilePushCoordinator(
    this._api,
    this._store,
    this._session, {
    DesktopHostBridge? desktopHostBridge,
  }) : _desktopHostBridge = desktopHostBridge ?? appDesktopHostBridge;

  final ApiClient _api;
  final SecureSessionStore _store;
  final AppSession _session;
  final DesktopHostBridge _desktopHostBridge;
  MobilePushState state = MobilePushState.initializing;
  MobilePushPreviewPolicy previewPolicy = MobilePushPreviewPolicy.hidden;
  String? error;
  String? providerState;
  GoRouter? _router;
  FirebaseMessaging? _messaging;
  StreamSubscription<String>? _tokenSubscription;
  StreamSubscription<RemoteMessage>? _openSubscription;
  Future<void>? _initializing;
  MobilePushEnvelope? _pendingOpen;

  void attachRouter(GoRouter router) {
    _router = router;
    final pending = _pendingOpen;
    if (pending != null) {
      _pendingOpen = null;
      unawaited(_openSafely(pending));
    }
  }

  Future<void> initialize() {
    final active = _initializing;
    if (active != null) return active;
    final created = _initialize();
    _initializing = created;
    return created.whenComplete(() {
      if (identical(_initializing, created)) _initializing = null;
    });
  }

  Future<void> _initialize() async {
    previewPolicy = _policy(await _store.readPushPreviewPolicy());
    state = MobilePushState.initializing;
    error = null;
    notifyListeners();
    try {
      if (Firebase.apps.isEmpty) await Firebase.initializeApp();
      _messaging = FirebaseMessaging.instance;
    } catch (value) {
      state = MobilePushState.configurationRequired;
      error = 'Add the Firebase app configuration for this signed build.';
      debugPrint('Mobile push configuration unavailable: $value');
      notifyListeners();
      return;
    }
    try {
      final messaging = _messaging!;
      await _openSubscription?.cancel();
      _openSubscription = FirebaseMessaging.onMessageOpenedApp.listen(
        (message) => _receive(message.data),
      );
      await _tokenSubscription?.cancel();
      _tokenSubscription =
          !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS
          ? null
          : messaging.onTokenRefresh.listen(
              (token) => unawaited(_registerSafely(token)),
            );
      final settings = await messaging.getNotificationSettings();
      if (_authorized(settings.authorizationStatus)) {
        await messaging.setAutoInitEnabled(true);
        await _registerCurrentInstallation();
      } else {
        state = settings.authorizationStatus == AuthorizationStatus.denied
            ? MobilePushState.denied
            : MobilePushState.disabled;
      }
      final initial = await messaging.getInitialMessage();
      if (initial != null) _receive(initial.data);
      await _resumePendingAcknowledgements();
    } catch (value) {
      state = MobilePushState.error;
      error = 'Push registration could not be completed. Retry when online.';
      debugPrint('Mobile push initialization failed: $value');
    } finally {
      notifyListeners();
    }
  }

  Future<void> enable() async {
    await initialize();
    final messaging = _messaging;
    if (messaging == null) return;
    state = MobilePushState.initializing;
    error = null;
    notifyListeners();
    try {
      final settings = await messaging.requestPermission(
        alert: true,
        badge: true,
        sound: true,
        provisional: false,
      );
      if (!_authorized(settings.authorizationStatus)) {
        state = settings.authorizationStatus == AuthorizationStatus.denied
            ? MobilePushState.denied
            : MobilePushState.disabled;
        return;
      }
      await messaging.setAutoInitEnabled(true);
      await _registerCurrentInstallation();
    } catch (value) {
      state = MobilePushState.error;
      error = 'Notification permission or registration failed.';
      debugPrint('Mobile push enablement failed: $value');
    } finally {
      notifyListeners();
    }
  }

  Future<void> setPreviewPolicy(MobilePushPreviewPolicy value) async {
    previewPolicy = value;
    await _store.writePushPreviewPolicy(value.apiValue);
    notifyListeners();
    if (_messaging != null && state == MobilePushState.ready) {
      await _registerCurrentInstallation();
    }
  }

  Future<void> _registerCurrentInstallation() async {
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.macOS) {
      await _desktopHostBridge.requestRemoteNotifications();
      return;
    }
    await _registerCurrentFcmToken();
  }

  Future<void> _registerCurrentFcmToken() async {
    final messaging = _messaging;
    if (messaging == null) return;
    final token = await messaging.getToken();
    if (token == null || token.isEmpty) {
      state = MobilePushState.error;
      error = 'This installation did not receive a push token.';
      return;
    }
    await _register(token, provider: 'fcm', environment: 'production');
  }

  Future<void> _register(
    String token, {
    required String provider,
    required String environment,
  }) async {
    final result = await _api.postJson(
      NativePaths.pushRegistrationsUpsert,
      data: {
        'provider': provider,
        'environment': environment,
        'token': token,
        'previewPolicy': previewPolicy.apiValue,
      },
      headers: {
        'idempotency-key':
            'push-register-${await _store.readOrCreateDeviceId()}-$provider-$environment-${previewPolicy.apiValue}',
      },
    );
    final registration = result['registration'];
    if (registration is! Map || registration['id'] is! String) {
      throw const FormatException('The push registration response is invalid.');
    }
    await _store.writePushRegistrationId(registration['id'] as String);
    final providers = result['providers'];
    providerState = providers is Map ? providers[provider]?.toString() : null;
    state = MobilePushState.ready;
    error = providerState == 'configured' ? null : 'This device is registered, but server delivery credentials are still required.';
    notifyListeners();
  }

  Future<void> _registerSafely(String token) async {
    try {
      await _register(token, provider: 'fcm', environment: 'production');
    } catch (value) {
      state = MobilePushState.error;
      error = 'The refreshed push token could not be registered.';
      debugPrint('Mobile push token refresh failed: $value');
      notifyListeners();
    }
  }

  Future<void> handleDesktopApnsRegistration(
    DesktopApnsRegistration registration,
  ) async {
    if (!registration.succeeded) {
      state = MobilePushState.configurationRequired;
      error = registration.errorCode == 'missing_entitlement'
          ? 'APNs needs an Apple-signed build with the macOS push entitlement.'
          : 'This Mac could not register with APNs (${registration.errorCode ?? 'unknown'}).';
      notifyListeners();
      return;
    }
    try {
      await _register(
        registration.token!,
        provider: 'apns',
        environment: registration.environment!,
      );
    } catch (value) {
      state = MobilePushState.error;
      error = 'The APNs token could not be registered with Asael.';
      debugPrint('APNs token registration failed: $value');
      notifyListeners();
    }
  }

  Future<void> handleDesktopNotificationAction(
    DesktopNotificationAction action,
  ) async {
    try {
      final envelope = MobilePushEnvelope.fromData(action.data);
      if (action.command == DesktopNotificationCommand.open) {
        await _open(envelope);
        return;
      }
      final notificationId = envelope.notificationId;
      if (notificationId == null) {
        throw const FormatException(
          'This push does not bind a personal notification action.',
        );
      }
      final record = {
        'tenantId': _session.tenantId,
        'actorId': _session.actorId,
        'envelope': envelope.toJson(),
        'action': action.command.name,
      };
      await _queueAcknowledgement(record);
      await _applyDesktopNotificationAction(action.command, envelope);
      await _acknowledge(envelope);
    } catch (value) {
      debugPrint('Native notification action remains queued: $value');
    }
  }

  void _receive(Map<String, dynamic> data) {
    try {
      final envelope = MobilePushEnvelope.fromData(data);
      if (_router == null) {
        _pendingOpen = envelope;
      } else {
        unawaited(_openSafely(envelope));
      }
    } catch (value) {
      debugPrint('Rejected untrusted push envelope: $value');
    }
  }

  Future<void> _open(MobilePushEnvelope envelope) async {
    await _queueAcknowledgement({
      'tenantId': _session.tenantId,
      'actorId': _session.actorId,
      'envelope': envelope.toJson(),
    });
    _router?.go(envelope.deepLink);
    await _acknowledge(envelope);
  }

  Future<void> _openSafely(MobilePushEnvelope envelope) async {
    try {
      await _open(envelope);
    } catch (value) {
      debugPrint('Push opened; acknowledgement remains queued: $value');
    }
  }

  Future<void> _resumePendingAcknowledgements() async {
    final raw = await _store.readPendingPushAcknowledgement();
    if (raw == null) return;
    try {
      final records = _pendingRecords(jsonDecode(raw));
      for (final value in records) {
        if (value['tenantId'] != _session.tenantId ||
            value['actorId'] != _session.actorId ||
            value['envelope'] is! Map) {
          continue;
        }
        try {
          final envelope = MobilePushEnvelope.fromData(
            Map<String, dynamic>.from(value['envelope'] as Map),
          );
          final commandName = value['action'];
          if (commandName is String) {
            final command = DesktopNotificationCommand.values.firstWhere(
              (item) => item.name == commandName,
            );
            await _applyDesktopNotificationAction(command, envelope);
          }
          await _acknowledge(envelope);
        } catch (value) {
          debugPrint('Pending push acknowledgement remains queued: $value');
        }
      }
    } catch (value) {
      debugPrint('Pending push acknowledgement remains queued: $value');
    }
  }

  Future<void> _applyDesktopNotificationAction(
    DesktopNotificationCommand command,
    MobilePushEnvelope envelope,
  ) async {
    final notificationId = envelope.notificationId;
    if (notificationId == null) {
      throw const FormatException('The notification id is missing.');
    }
    final action = switch (command) {
      DesktopNotificationCommand.complete => 'complete',
      DesktopNotificationCommand.snooze15 => 'snooze',
      DesktopNotificationCommand.dismiss => 'dismiss',
      DesktopNotificationCommand.open => throw const FormatException(
        'Open is not a notification mutation.',
      ),
    };
    await _api.patchJson(
      NativePaths.notificationsAcknowledge(notificationId),
      data: {
        'action': action,
        if (command == DesktopNotificationCommand.snooze15) 'minutes': 15,
      },
      headers: {
        'idempotency-key': 'push-action-${envelope.deliveryId}-${command.name}',
      },
    );
  }

  Future<void> _queueAcknowledgement(Map<String, dynamic> record) async {
    final records = await _loadPendingRecords();
    final deliveryId = (record['envelope'] as Map)['deliveryId'];
    records.removeWhere(
      (item) => (item['envelope'] as Map?)?['deliveryId'] == deliveryId,
    );
    records.add(record);
    await _store.writePendingPushAcknowledgement(jsonEncode(records));
  }

  Future<void> _removePendingAcknowledgement(String deliveryId) async {
    final records = (await _loadPendingRecords())
      ..removeWhere(
        (item) => (item['envelope'] as Map?)?['deliveryId'] == deliveryId,
      );
    if (records.isEmpty) {
      await _store.clearPendingPushAcknowledgement();
    } else {
      await _store.writePendingPushAcknowledgement(jsonEncode(records));
    }
  }

  Future<List<Map<String, dynamic>>> _loadPendingRecords() async {
    final raw = await _store.readPendingPushAcknowledgement();
    if (raw == null) return [];
    try {
      return _pendingRecords(jsonDecode(raw));
    } catch (_) {
      await _store.clearPendingPushAcknowledgement();
      return [];
    }
  }

  Future<void> _acknowledge(MobilePushEnvelope envelope) async {
    try {
      final response = await _api.postJson(
        NativePaths.pushDeliveriesAcknowledge(envelope.deliveryId),
        data: const {},
        headers: {'idempotency-key': 'push-open-${envelope.deliveryId}'},
      );
      if (response['acknowledged'] != true ||
          response['deepLink']?.toString() != envelope.deepLink ||
          response['causeKind']?.toString() != envelope.causeKind ||
          response['causeId']?.toString() != envelope.causeId) {
        throw const FormatException(
          'The push acknowledgement receipt is invalid.',
        );
      }
      await _removePendingAcknowledgement(envelope.deliveryId);
    } on ApiException catch (value) {
      if (value.statusCode == 404) {
        await _removePendingAcknowledgement(envelope.deliveryId);
        return;
      }
      rethrow;
    }
  }

  @override
  void dispose() {
    unawaited(_tokenSubscription?.cancel());
    unawaited(_openSubscription?.cancel());
    super.dispose();
  }
}

final mobilePushCoordinatorProvider = Provider<MobilePushCoordinator?>((ref) {
  final session = ref.watch(sessionControllerProvider).value;
  if (session == null) return null;
  final coordinator = MobilePushCoordinator(
    ref.watch(apiClientProvider),
    ref.watch(secureSessionStoreProvider),
    session,
  );
  final connectivitySubscription = Connectivity().onConnectivityChanged.listen((
    states,
  ) {
    if (states.any((state) => state != ConnectivityResult.none)) {
      unawaited(coordinator.initialize());
    }
  });
  ref.onDispose(() {
    unawaited(connectivitySubscription.cancel());
    coordinator.dispose();
  });
  unawaited(coordinator.initialize());
  return coordinator;
});

bool _authorized(AuthorizationStatus status) =>
    status == AuthorizationStatus.authorized ||
    status == AuthorizationStatus.provisional;

MobilePushPreviewPolicy _policy(String value) =>
    MobilePushPreviewPolicy.values.firstWhere(
      (item) => item.apiValue == value,
      orElse: () => MobilePushPreviewPolicy.hidden,
    );

String _pushId(Object? value, String field) {
  final text = value?.toString() ?? '';
  if (text.isEmpty ||
      text.length > 240 ||
      RegExp(r'[\u0000-\u001f]').hasMatch(text)) {
    throw FormatException('Push $field is invalid.');
  }
  return text;
}

Map<String, dynamic> _unwrapPushData(Map<String, dynamic> raw) {
  final nested = raw['asael'];
  if (nested is Map) return Map<String, dynamic>.from(nested);
  if (nested is String) {
    final parsed = jsonDecode(nested);
    if (parsed is Map) return Map<String, dynamic>.from(parsed);
  }
  return raw;
}

List<Map<String, dynamic>> _pendingRecords(Object? value) {
  final values = value is List ? value : [value];
  return values
      .whereType<Map>()
      .map(Map<String, dynamic>.from)
      .where((item) => item['envelope'] is Map)
      .toList();
}
