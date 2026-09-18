import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:cryptography/cryptography.dart';
import 'package:dio/dio.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/native_client_info.dart';
import '../../core/config/app_config.dart';
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
      'canary',
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
      'canary' => '/settings?pushCanary=$encodedId',
      _ => throw const FormatException('Unknown push target.'),
    };
  }
}

enum MobilePushReceiptKind { received, opened, action }

enum MobilePushAppLifecycle { foreground, background, terminated, unknown }

class MobilePushReceiptRecord {
  const MobilePushReceiptRecord({
    required this.envelope,
    required this.kind,
    required this.observedAt,
    required this.appLifecycle,
    this.action,
    this.tenantId,
    this.actorId,
    this.navigate = false,
  });

  factory MobilePushReceiptRecord.fromJson(Map<String, dynamic> value) {
    if (value['envelope'] is! Map) {
      throw const FormatException('The queued push envelope is invalid.');
    }
    final envelope = MobilePushEnvelope.fromData(
      Map<String, dynamic>.from(value['envelope'] as Map),
    );
    final legacyAction = value['action']?.toString();
    final rawKind =
        value['kind']?.toString() ??
        (legacyAction == null ? 'opened' : 'action');
    final kind = MobilePushReceiptKind.values.firstWhere(
      (item) => item.name == rawKind,
      orElse: () => throw const FormatException(
        'The queued push receipt kind is invalid.',
      ),
    );
    final action = legacyAction == 'snooze15' ? 'snooze' : legacyAction;
    if ((kind == MobilePushReceiptKind.action) != (action != null) ||
        (action != null &&
            !const {
              'open',
              'complete',
              'snooze',
              'dismiss',
            }.contains(action))) {
      throw const FormatException('The queued push action is invalid.');
    }
    final lifecycle = MobilePushAppLifecycle.values.firstWhere(
      (item) => item.name == (value['appLifecycle']?.toString() ?? 'unknown'),
      orElse: () =>
          throw const FormatException('The queued push lifecycle is invalid.'),
    );
    final observedAt =
        DateTime.tryParse(value['observedAt']?.toString() ?? '')?.toUtc() ??
        DateTime.now().toUtc();
    final tenantId = value['tenantId'];
    final actorId = value['actorId'];
    if ((tenantId != null && tenantId is! String) ||
        (actorId != null && actorId is! String)) {
      throw const FormatException('The queued push owner is invalid.');
    }
    return MobilePushReceiptRecord(
      envelope: envelope,
      kind: kind,
      action: action,
      observedAt: observedAt,
      appLifecycle: lifecycle,
      tenantId: tenantId as String?,
      actorId: actorId as String?,
      navigate:
          value['navigate'] == true ||
          (value['kind'] == null && legacyAction == null),
    );
  }

  final MobilePushEnvelope envelope;
  final MobilePushReceiptKind kind;
  final String? action;
  final DateTime observedAt;
  final MobilePushAppLifecycle appLifecycle;
  final String? tenantId;
  final String? actorId;
  final bool navigate;

  String get stageKey => [envelope.deliveryId, kind.name, ?action].join(':');

  String get idempotencyKey => 'push-receipt:$stageKey';

  MobilePushReceiptRecord bind({
    required String tenantId,
    required String actorId,
  }) => MobilePushReceiptRecord(
    envelope: envelope,
    kind: kind,
    action: action,
    observedAt: observedAt,
    appLifecycle: appLifecycle,
    tenantId: tenantId,
    actorId: actorId,
    navigate: navigate,
  );

  Map<String, dynamic> toJson() => {
    if (tenantId != null) 'tenantId': tenantId,
    if (actorId != null) 'actorId': actorId,
    'envelope': envelope.toJson(),
    'kind': kind.name,
    if (action != null) 'action': action,
    'observedAt': observedAt.toUtc().toIso8601String(),
    'appLifecycle': appLifecycle.name,
    if (navigate) 'navigate': true,
  };

  Map<String, dynamic> get requestBody => {
    'schemaVersion': 1,
    'kind': kind.name,
    if (action != null) 'action': action,
    'observedAt': observedAt.toUtc().toIso8601String(),
    'appLifecycle': appLifecycle.name,
  };
}

class MobilePushReceiptQueue {
  MobilePushReceiptQueue(this._store) : _usesPerRecordStorage = false;

  factory MobilePushReceiptQueue.forCurrentPlatform(SecureSessionStore store) =>
      MobilePushReceiptQueue._(
        store,
        !kIsWeb &&
            (defaultTargetPlatform == TargetPlatform.android ||
                defaultTargetPlatform == TargetPlatform.iOS) &&
            store.supportsPendingPushReceiptRecords,
      );

  @visibleForTesting
  MobilePushReceiptQueue.perRecord(SecureSessionStore store)
    : this._(store, true);

  MobilePushReceiptQueue._(this._store, this._usesPerRecordStorage)
    : assert(
        !_usesPerRecordStorage || _store.supportsPendingPushReceiptRecords,
      );

  static const maximumRecords = 64;
  static const maximumEncodedBytes = 60 * 1024;
  static Future<void> _blobBarrier = Future.value();
  final SecureSessionStore _store;
  final bool _usesPerRecordStorage;

  Future<void> add(MobilePushReceiptRecord record) async {
    if (_usesPerRecordStorage) {
      await _migrateLegacyBlob();
      await _addPerRecord(record);
      return;
    }
    await _withBlobLock(() => _addToBlob(record));
  }

  Future<void> _addToBlob(MobilePushReceiptRecord record) async {
    final records = await _loadBlob();
    final existingIndex = records.indexWhere(
      (item) => item.stageKey == record.stageKey,
    );
    if (existingIndex >= 0) {
      final existing = records[existingIndex];
      // Retain the first observation body for this idempotency key. Replacing
      // observedAt/lifecycle on a retry would correctly conflict server-side.
      if (existing.tenantId == null &&
          existing.actorId == null &&
          record.tenantId != null &&
          record.actorId != null) {
        records[existingIndex] = existing.bind(
          tenantId: record.tenantId!,
          actorId: record.actorId!,
        );
      } else {
        return;
      }
    } else {
      records.add(record);
    }
    if (records.length > maximumRecords) {
      throw const FormatException('The push receipt queue is full.');
    }
    final encoded = jsonEncode(records.map((item) => item.toJson()).toList());
    if (utf8.encode(encoded).length > maximumEncodedBytes) {
      throw const FormatException('The push receipt queue is full.');
    }
    await _store.writePendingPushAcknowledgement(encoded);
  }

  Future<List<MobilePushReceiptRecord>> load() async {
    if (_usesPerRecordStorage) {
      await _migrateLegacyBlob();
      return _loadPerRecord();
    }
    return _withBlobLock(_loadBlob);
  }

  Future<List<MobilePushReceiptRecord>> _loadBlob() async {
    final raw = await _store.readPendingPushAcknowledgement();
    if (raw == null) return [];
    try {
      final values = jsonDecode(raw);
      return _sortRecords(
        _pendingRecords(values)
            .map(MobilePushReceiptRecord.fromJson)
            .toList(growable: true),
      );
    } catch (_) {
      await _store.clearPendingPushAcknowledgement();
      return [];
    }
  }

  Future<void> remove(String stageKey) async {
    if (_usesPerRecordStorage) {
      await _migrateLegacyBlob();
      await _store.clearPendingPushReceiptRecord(await _recordKey(stageKey));
      return;
    }
    await _withBlobLock(() async {
      final records = (await _loadBlob())
        ..removeWhere((item) => item.stageKey == stageKey);
      if (records.isEmpty) {
        await _store.clearPendingPushAcknowledgement();
      } else {
        await _store.writePendingPushAcknowledgement(
          jsonEncode(records.map((item) => item.toJson()).toList()),
        );
      }
    });
  }

  Future<void> _addPerRecord(MobilePushReceiptRecord record) async {
    final key = await _recordKey(record.stageKey);
    final existingRaw = await _store.readPendingPushReceiptRecord(key);
    if (existingRaw != null) {
      MobilePushReceiptRecord? existing;
      try {
        existing = MobilePushReceiptRecord.fromJson(
          Map<String, dynamic>.from(jsonDecode(existingRaw) as Map),
        );
        if (existing.stageKey != record.stageKey) {
          throw const FormatException('The push receipt key is invalid.');
        }
      } catch (_) {
        await _store.clearPendingPushReceiptRecord(key);
      }
      if (existing != null) {
        if (existing.tenantId == null &&
            existing.actorId == null &&
            record.tenantId != null &&
            record.actorId != null) {
          await _writePerRecord(
            key,
            existing.bind(tenantId: record.tenantId!, actorId: record.actorId!),
          );
        }
        return;
      }
    }

    final encoded = jsonEncode(record.toJson());
    final encodedBytes = utf8.encode(encoded).length;
    if (encodedBytes > maximumEncodedBytes) {
      throw const FormatException('The push receipt is too large.');
    }
    final entries = await _readValidPerRecordEntries();
    var totalBytes = entries.fold<int>(
      0,
      (total, entry) => total + utf8.encode(entry.encoded).length,
    );
    while (entries.length >= maximumRecords ||
        totalBytes + encodedBytes > maximumEncodedBytes) {
      if (record.kind != MobilePushReceiptKind.action) {
        throw const FormatException('The push receipt queue is full.');
      }
      final evictionIndex = entries.indexWhere(
        (entry) => entry.record.kind == MobilePushReceiptKind.received,
      );
      if (evictionIndex < 0) {
        throw const FormatException('The push receipt queue is full.');
      }
      final evicted = entries.removeAt(evictionIndex);
      totalBytes -= utf8.encode(evicted.encoded).length;
      await _store.clearPendingPushReceiptRecord(evicted.key);
    }
    await _writePerRecord(key, record);
  }

  Future<void> _writePerRecord(
    String key,
    MobilePushReceiptRecord record,
  ) async {
    final encoded = jsonEncode(record.toJson());
    await _store.writePendingPushReceiptRecord(key, encoded);
    final persisted = await _store.readPendingPushReceiptRecord(key);
    if (persisted == encoded) return;
    if (persisted != null) {
      try {
        final existing = MobilePushReceiptRecord.fromJson(
          Map<String, dynamic>.from(jsonDecode(persisted) as Map),
        );
        if (existing.stageKey == record.stageKey) return;
      } catch (_) {
        // Fall through to the durable-write failure below.
      }
    }
    throw StateError('The push receipt was not durably stored.');
  }

  Future<void> _migrateLegacyBlob() => _withBlobLock(() async {
    final raw = await _store.readPendingPushAcknowledgement();
    if (raw == null) return;
    late final List<MobilePushReceiptRecord> records;
    try {
      if (utf8.encode(raw).length > maximumEncodedBytes) {
        throw const FormatException(
          'The legacy push receipt queue is invalid.',
        );
      }
      final decoded = jsonDecode(raw);
      if (decoded is List && decoded.length > maximumRecords) {
        throw const FormatException(
          'The legacy push receipt queue is invalid.',
        );
      }
      records = _pendingRecords(decoded)
          .map(MobilePushReceiptRecord.fromJson)
          .toList(growable: false);
    } on FormatException {
      // The old implementation also discarded malformed encrypted payloads;
      // valid records are never cleared until every stage is read back below.
      await _store.clearPendingPushAcknowledgement();
      return;
    }
    for (final record in records) {
      final key = await _recordKey(record.stageKey);
      final existingRaw = await _store.readPendingPushReceiptRecord(key);
      if (existingRaw != null) {
        final existing = MobilePushReceiptRecord.fromJson(
          Map<String, dynamic>.from(jsonDecode(existingRaw) as Map),
        );
        if (existing.stageKey != record.stageKey) {
          throw const FormatException('The push receipt key is invalid.');
        }
        continue;
      }
      // Migration may temporarily exceed the normal queue cap when a
      // background isolate already wrote new-format records. Never discard a
      // legacy offline observation; normal drains restore the bound.
      await _writePerRecord(key, record);
    }
    for (final record in records) {
      final key = await _recordKey(record.stageKey);
      final persisted = await _store.readPendingPushReceiptRecord(key);
      if (persisted == null) {
        throw StateError('A migrated push receipt is missing.');
      }
      final restored = MobilePushReceiptRecord.fromJson(
        Map<String, dynamic>.from(jsonDecode(persisted) as Map),
      );
      if (restored.stageKey != record.stageKey) {
        throw const FormatException('The migrated push receipt is invalid.');
      }
    }
    await _store.clearPendingPushAcknowledgement();
  });

  Future<List<MobilePushReceiptRecord>> _loadPerRecord() async {
    final entries = await _readValidPerRecordEntries();
    return _sortRecords(
      entries.map((entry) => entry.record).toList(growable: true),
    );
  }

  Future<List<_StoredPushReceipt>> _readValidPerRecordEntries() async {
    final values = await _store.readAllPendingPushReceiptRecords();
    final records = <_StoredPushReceipt>[];
    for (final entry in values.entries) {
      try {
        final record = MobilePushReceiptRecord.fromJson(
          Map<String, dynamic>.from(jsonDecode(entry.value) as Map),
        );
        if (await _recordKey(record.stageKey) != entry.key) {
          throw const FormatException('The push receipt key is invalid.');
        }
        records.add(
          _StoredPushReceipt(
            key: entry.key,
            encoded: entry.value,
            record: record,
          ),
        );
      } catch (_) {
        await _store.clearPendingPushReceiptRecord(entry.key);
      }
    }
    records.sort((left, right) => _compareRecords(left.record, right.record));
    return records;
  }

  Future<String> _recordKey(String stageKey) async {
    final digest = await Sha256().hash(utf8.encode(stageKey));
    return '${SecureSessionStore.pendingPushReceiptRecordKeyPrefix}'
        '${base64UrlEncode(digest.bytes).replaceAll('=', '')}';
  }

  Future<T> _withBlobLock<T>(Future<T> Function() operation) async {
    final predecessor = _blobBarrier;
    final release = Completer<void>();
    _blobBarrier = release.future;
    await predecessor;
    try {
      return await operation();
    } finally {
      release.complete();
    }
  }
}

class _StoredPushReceipt {
  const _StoredPushReceipt({
    required this.key,
    required this.encoded,
    required this.record,
  });

  final String key;
  final String encoded;
  final MobilePushReceiptRecord record;
}

List<MobilePushReceiptRecord> _sortRecords(
  List<MobilePushReceiptRecord> records,
) => records..sort(_compareRecords);

int _compareRecords(
  MobilePushReceiptRecord left,
  MobilePushReceiptRecord right,
) {
  final observed = left.observedAt.compareTo(right.observedAt);
  if (observed != 0) return observed;
  final kind = _receiptKindRank(left.kind)
      .compareTo(_receiptKindRank(right.kind));
  if (kind != 0) return kind;
  return left.stageKey.compareTo(right.stageKey);
}

int _receiptKindRank(MobilePushReceiptKind kind) => switch (kind) {
  MobilePushReceiptKind.received => 0,
  MobilePushReceiptKind.opened => 1,
  MobilePushReceiptKind.action => 2,
};

const _androidPushChannelId = 'asael_updates_v1';
const _androidCompleteAction = 'ASAEL_COMPLETE_V1';
const _androidSnoozeAction = 'ASAEL_SNOOZE_15_V1';
const _androidDismissAction = 'ASAEL_DISMISS_V1';
final _localNotifications = FlutterLocalNotificationsPlugin();
final _localNotificationActivity = StreamController<void>.broadcast();
bool _localNotificationsInitialized = false;

Future<void> initializeAsaelPushHandling() async {
  if (kIsWeb) return;
  FirebaseMessaging.onBackgroundMessage(
    asaelFirebaseMessagingBackgroundHandler,
  );
  if (defaultTargetPlatform != TargetPlatform.android) return;
  await _initializeAndroidLocalNotifications(captureLaunchResponse: true);
}

@pragma('vm:entry-point')
Future<void> asaelFirebaseMessagingBackgroundHandler(
  RemoteMessage message,
) async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    if (Firebase.apps.isEmpty) await Firebase.initializeApp();
    final envelope = MobilePushEnvelope.fromData(message.data);
    try {
      final store = SecureSessionStore(const FlutterSecureStorage());
      final owner = await store.readOfflineProjectionOwner();
      if (owner == null) {
        throw const FormatException(
          'The background push has no persisted actor scope.',
        );
      }
      final record = MobilePushReceiptRecord(
        envelope: envelope,
        kind: MobilePushReceiptKind.received,
        observedAt: DateTime.now().toUtc(),
        appLifecycle: MobilePushAppLifecycle.background,
        tenantId: owner.tenantId,
        actorId: owner.actorId,
      );
      final queue = MobilePushReceiptQueue.forCurrentPlatform(store);
      await queue.add(record);
      await _sendBackgroundReceipt(store, queue, record);
    } catch (value) {
      debugPrint('Background push receipt remains pending: $value');
    }
    if (defaultTargetPlatform == TargetPlatform.android &&
        message.notification == null) {
      await _showAndroidNotification(message, envelope);
    }
  } catch (value) {
    debugPrint('Background push remains queued or was rejected: $value');
  }
}

@pragma('vm:entry-point')
void asaelNotificationResponseBackground(NotificationResponse response) async {
  WidgetsFlutterBinding.ensureInitialized();
  await _persistLocalNotificationResponse(
    response,
    MobilePushAppLifecycle.background,
  );
}

Future<void> _initializeAndroidLocalNotifications({
  bool captureLaunchResponse = false,
}) async {
  if (defaultTargetPlatform != TargetPlatform.android) return;
  if (!_localNotificationsInitialized) {
    const settings = InitializationSettings(
      android: AndroidInitializationSettings('ic_stat_asael'),
    );
    await _localNotifications.initialize(
      settings,
      onDidReceiveNotificationResponse: (response) {
        unawaited(
          _persistLocalNotificationResponse(response, _currentAppLifecycle()),
        );
      },
      onDidReceiveBackgroundNotificationResponse:
          asaelNotificationResponseBackground,
    );
    await _localNotifications
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.createNotificationChannel(
          const AndroidNotificationChannel(
            _androidPushChannelId,
            'Asael updates',
            description: 'Causal updates for your Asael work.',
            importance: Importance.high,
          ),
        );
    _localNotificationsInitialized = true;
  }
  if (!captureLaunchResponse) return;
  final launch = await _localNotifications.getNotificationAppLaunchDetails();
  final response = launch?.didNotificationLaunchApp == true
      ? launch?.notificationResponse
      : null;
  if (response != null) {
    await _persistLocalNotificationResponse(
      response,
      MobilePushAppLifecycle.terminated,
    );
  }
}

Future<void> _persistLocalNotificationResponse(
  NotificationResponse response,
  MobilePushAppLifecycle lifecycle,
) async {
  final payload = response.payload;
  if (payload == null || payload.length > 16 * 1024) return;
  try {
    final decoded = jsonDecode(payload);
    if (decoded is! Map) return;
    final envelope = MobilePushEnvelope.fromData(
      Map<String, dynamic>.from(decoded),
    );
    final records = _notificationResponseRecords(
      envelope,
      actionIdentifier: response.actionId,
      lifecycle: lifecycle,
    );
    final queue = MobilePushReceiptQueue.forCurrentPlatform(
      SecureSessionStore(const FlutterSecureStorage()),
    );
    for (final record in records) {
      await queue.add(record);
    }
    _localNotificationActivity.add(null);
  } catch (value) {
    debugPrint('Rejected local notification response: $value');
  }
}

List<MobilePushReceiptRecord> _notificationResponseRecords(
  MobilePushEnvelope envelope, {
  String? actionIdentifier,
  required MobilePushAppLifecycle lifecycle,
  DateTime? observedAt,
}) {
  final receiptObservedAt = observedAt?.toUtc() ?? DateTime.now().toUtc();
  final action = _notificationAction(actionIdentifier);
  if (actionIdentifier != null &&
      actionIdentifier.isNotEmpty &&
      action == null) {
    throw const FormatException('The notification action is not allowlisted.');
  }
  if (action != null && action != 'open') {
    return [
      MobilePushReceiptRecord(
        envelope: envelope,
        kind: MobilePushReceiptKind.action,
        action: action,
        observedAt: receiptObservedAt,
        appLifecycle: lifecycle,
      ),
    ];
  }
  return [
    MobilePushReceiptRecord(
      envelope: envelope,
      kind: MobilePushReceiptKind.opened,
      observedAt: receiptObservedAt,
      appLifecycle: lifecycle,
      navigate: true,
    ),
    MobilePushReceiptRecord(
      envelope: envelope,
      kind: MobilePushReceiptKind.action,
      action: 'open',
      observedAt: receiptObservedAt,
      appLifecycle: lifecycle,
    ),
  ];
}

String? _notificationAction(String? identifier) => switch (identifier) {
  _androidCompleteAction => 'complete',
  _androidSnoozeAction => 'snooze',
  _androidDismissAction => 'dismiss',
  'ASAEL_OPEN_V1' => 'open',
  'com.apple.UNNotificationDismissActionIdentifier' => 'dismiss',
  null || '' || 'com.apple.UNNotificationDefaultActionIdentifier' => 'open',
  _ => null,
};

Future<void> _showAndroidNotification(
  RemoteMessage message,
  MobilePushEnvelope envelope,
) async {
  await _initializeAndroidLocalNotifications();
  final title =
      message.notification?.title ??
      message.data['asaelTitle']?.toString() ??
      'Asael';
  final body =
      message.notification?.body ??
      message.data['asaelBody']?.toString() ??
      'You have an update.';
  final details = NotificationDetails(
    android: AndroidNotificationDetails(
      _androidPushChannelId,
      'Asael updates',
      channelDescription: 'Causal updates for your Asael work.',
      icon: 'ic_stat_asael',
      importance: Importance.high,
      priority: Priority.high,
      category: AndroidNotificationCategory.reminder,
      visibility: NotificationVisibility.private,
      actions: envelope.notificationId == null
          ? null
          : const [
              AndroidNotificationAction(
                _androidCompleteAction,
                'Complete',
                showsUserInterface: true,
              ),
              AndroidNotificationAction(
                _androidSnoozeAction,
                'Snooze 15 min',
                showsUserInterface: true,
              ),
              AndroidNotificationAction(
                _androidDismissAction,
                'Dismiss',
                showsUserInterface: true,
                cancelNotification: true,
              ),
            ],
    ),
  );
  await _localNotifications.show(
    _stableNotificationId(envelope.deliveryId),
    title,
    body,
    details,
    payload: jsonEncode(envelope.toJson()),
  );
}

int _stableNotificationId(String value) {
  var hash = 0x811c9dc5;
  for (final byte in utf8.encode(value)) {
    hash = ((hash ^ byte) * 0x01000193) & 0x7fffffff;
  }
  return hash;
}

Future<void> _sendBackgroundReceipt(
  SecureSessionStore store,
  MobilePushReceiptQueue queue,
  MobilePushReceiptRecord record,
) async {
  final token = await store.readTokenForRemoteWipe();
  if (token == null || token.isEmpty) return;
  final client = Dio(
    BaseOptions(
      baseUrl: AppConfig.apiBaseUrl,
      connectTimeout: const Duration(seconds: 8),
      receiveTimeout: const Duration(seconds: 10),
      headers: {
        'Accept': 'application/json',
        ...NativeClientInfo.attestationHeaders(),
        'Authorization': 'Bearer $token',
      },
    ),
  );
  try {
    final response = await client.post<Object?>(
      NativePaths.pushDeliveryReceipts(record.envelope.deliveryId),
      data: record.requestBody,
      options: Options(headers: {'idempotency-key': record.idempotencyKey}),
    );
    if (_receiptResponseMatches(response.data, record)) {
      await queue.remove(record.stageKey);
    }
  } on DioException catch (value) {
    if (value.response?.statusCode == 409) {
      // A stage-scoped idempotency conflict means an earlier observation for
      // this exact delivery/stage was already accepted. Do not wedge retries.
      await queue.remove(record.stageKey);
    }
    // Other failures remain encrypted for refresh, resume, or connectivity.
  } finally {
    client.close(force: true);
  }
}

bool _receiptResponseMatches(Object? raw, MobilePushReceiptRecord record) {
  if (raw is! Map) return false;
  final value = Map<String, dynamic>.from(raw);
  final receipt = value['receipt'];
  final delivery = value['delivery'];
  return value['schemaVersion'] == 1 &&
      value['recorded'] == true &&
      receipt is Map &&
      receipt['kind'] == record.kind.name &&
      receipt['action'] == record.action &&
      delivery is Map &&
      delivery['id'] == record.envelope.deliveryId &&
      delivery['notificationId'] == record.envelope.notificationId &&
      delivery['causeKind'] == record.envelope.causeKind &&
      delivery['causeId'] == record.envelope.causeId &&
      delivery['deepLink'] == record.envelope.deepLink;
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
  StreamSubscription<RemoteMessage>? _foregroundSubscription;
  StreamSubscription<RemoteMessage>? _openSubscription;
  StreamSubscription<void>? _localNotificationSubscription;
  Future<void>? _initializing;
  Future<void>? _receiptDrainInFlight;
  bool _receiptDrainRequested = false;

  void attachRouter(GoRouter router) {
    _router = router;
    _scheduleReceiptDrain();
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
      await _foregroundSubscription?.cancel();
      _foregroundSubscription = FirebaseMessaging.onMessage.listen(
        (message) => unawaited(
          _handleReceivedMessage(
            message,
            lifecycle: MobilePushAppLifecycle.foreground,
            displayAndroidNotification: true,
          ),
        ),
      );
      await _openSubscription?.cancel();
      _openSubscription = FirebaseMessaging.onMessageOpenedApp.listen(
        (message) => unawaited(
          _handleOpenedMessage(
            message,
            lifecycle: MobilePushAppLifecycle.background,
          ),
        ),
      );
      await _localNotificationSubscription?.cancel();
      _localNotificationSubscription = _localNotificationActivity.stream.listen(
        (_) => _scheduleReceiptDrain(),
      );
      await _tokenSubscription?.cancel();
      _tokenSubscription =
          !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS
          ? null
          : messaging.onTokenRefresh.listen(
              (token) => unawaited(_registerSafely(token)),
            );
      final settings = await messaging.getNotificationSettings();
      if (!kIsWeb &&
          (defaultTargetPlatform == TargetPlatform.iOS ||
              defaultTargetPlatform == TargetPlatform.macOS)) {
        await messaging.setForegroundNotificationPresentationOptions(
          alert: true,
          badge: true,
          sound: true,
        );
      }
      if (_authorized(settings.authorizationStatus)) {
        await messaging.setAutoInitEnabled(true);
        await _registerCurrentInstallation();
      } else {
        state = settings.authorizationStatus == AuthorizationStatus.denied
            ? MobilePushState.denied
            : MobilePushState.disabled;
      }
      final initial = await messaging.getInitialMessage();
      if (initial != null) {
        await _handleOpenedMessage(
          initial,
          lifecycle: MobilePushAppLifecycle.terminated,
        );
      }
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
    MobilePushEnvelope envelope;
    try {
      envelope = MobilePushEnvelope.fromData(action.data);
    } on FormatException catch (value) {
      debugPrint('Rejected untrusted native notification action: $value');
      return;
    }
    if (action.command != DesktopNotificationCommand.open &&
        envelope.notificationId == null) {
      debugPrint('Rejected an action for an open-only notification.');
      return;
    }
    final lifecycle = _pushLifecycle(action.appLifecycle);
    final records = action.command == DesktopNotificationCommand.open
        ? _notificationResponseRecords(
            envelope,
            lifecycle: lifecycle,
            observedAt: action.observedAt,
          )
        : [
            MobilePushReceiptRecord(
              envelope: envelope,
              kind: MobilePushReceiptKind.action,
              action: switch (action.command) {
                DesktopNotificationCommand.complete => 'complete',
                DesktopNotificationCommand.snooze15 => 'snooze',
                DesktopNotificationCommand.dismiss => 'dismiss',
                DesktopNotificationCommand.open => 'open',
              },
              observedAt: action.observedAt,
              appLifecycle: lifecycle,
            ),
          ];
    await _queueRecords(records);
    // Returning now acknowledges only the encrypted actor-scoped Dart queue,
    // not the network. AppKit may safely delete its duplicate crash buffer.
    _scheduleReceiptDrain();
  }

  Future<void> handleDesktopNotificationReceived(
    DesktopNotificationReceived delivery,
  ) async {
    try {
      final envelope = MobilePushEnvelope.fromData(delivery.data);
      await _queueRecords([
        MobilePushReceiptRecord(
          envelope: envelope,
          kind: MobilePushReceiptKind.received,
          observedAt: delivery.observedAt,
          appLifecycle: _pushLifecycle(delivery.appLifecycle),
        ),
      ]);
      _scheduleReceiptDrain();
    } on FormatException catch (value) {
      debugPrint('Rejected untrusted native notification delivery: $value');
    }
  }

  Future<void> _handleReceivedMessage(
    RemoteMessage message, {
    required MobilePushAppLifecycle lifecycle,
    required bool displayAndroidNotification,
  }) async {
    try {
      final envelope = MobilePushEnvelope.fromData(message.data);
      try {
        await _queueAndProcess(
          MobilePushReceiptRecord(
            envelope: envelope,
            kind: MobilePushReceiptKind.received,
            observedAt: DateTime.now().toUtc(),
            appLifecycle: lifecycle,
          ),
        );
      } catch (value) {
        debugPrint('Push delivery receipt remains queued: $value');
      }
      if (displayAndroidNotification &&
          defaultTargetPlatform == TargetPlatform.android) {
        await _showAndroidNotification(message, envelope);
      }
    } catch (value) {
      debugPrint('Push delivery remains queued or was rejected: $value');
    }
  }

  Future<void> _handleOpenedMessage(
    RemoteMessage message, {
    required MobilePushAppLifecycle lifecycle,
  }) async {
    try {
      final envelope = MobilePushEnvelope.fromData(message.data);
      final records = _notificationResponseRecords(
        envelope,
        actionIdentifier: message.actionIdentifier,
        lifecycle: lifecycle,
      );
      await _queueAndProcessAll(records);
    } catch (value) {
      debugPrint('Push interaction remains queued or was rejected: $value');
    }
  }

  Future<void> _resumePendingAcknowledgements() {
    _receiptDrainRequested = true;
    final active = _receiptDrainInFlight;
    if (active != null) return active;
    final created = _drainPendingReceiptRequests();
    _receiptDrainInFlight = created;
    return created.whenComplete(() {
      if (identical(_receiptDrainInFlight, created)) {
        _receiptDrainInFlight = null;
      }
    });
  }

  Future<void> _drainPendingReceiptRequests() async {
    do {
      _receiptDrainRequested = false;
      await _drainPendingReceiptSnapshot();
    } while (_receiptDrainRequested);
  }

  Future<void> _drainPendingReceiptSnapshot() async {
    final queue = MobilePushReceiptQueue.forCurrentPlatform(_store);
    for (final queued in await queue.load()) {
      if ((queued.tenantId != null && queued.tenantId != _session.tenantId) ||
          (queued.actorId != null && queued.actorId != _session.actorId)) {
        await queue.remove(queued.stageKey);
        continue;
      }
      final record = queued.bind(
        tenantId: _session.tenantId,
        actorId: _session.actorId,
      );
      try {
        await queue.add(record);
        await _processReceipt(record, queue);
      } catch (value) {
        debugPrint('Pending push receipt remains queued: $value');
      }
    }
  }

  Future<void> _queueAndProcess(MobilePushReceiptRecord value) async {
    await _queueAndProcessAll([value]);
  }

  Future<void> _queueAndProcessAll(
    Iterable<MobilePushReceiptRecord> values,
  ) async {
    await _queueRecords(values);
    await _resumePendingAcknowledgements();
  }

  Future<void> _queueRecords(Iterable<MobilePushReceiptRecord> values) async {
    final records = values
        .map(
          (value) => value.bind(
            tenantId: _session.tenantId,
            actorId: _session.actorId,
          ),
        )
        .toList(growable: false);
    final queue = MobilePushReceiptQueue.forCurrentPlatform(_store);
    // Persist every stage before any transport call. An opened receipt can
    // therefore fail offline without dropping its companion action=open stage.
    for (final record in records) {
      await queue.add(record);
    }
  }

  void _scheduleReceiptDrain() {
    unawaited(
      _resumePendingAcknowledgements().catchError((Object value) {
        debugPrint('Pending push receipt drain paused: $value');
      }),
    );
  }

  Future<void> _processReceipt(
    MobilePushReceiptRecord record,
    MobilePushReceiptQueue queue,
  ) async {
    try {
      final action = record.action;
      if (record.kind == MobilePushReceiptKind.action &&
          action != null &&
          action != 'open') {
        await _applyNotificationAction(action, record.envelope);
      }
      // The receipt route proves this delivery belongs to the authenticated
      // actor, installation, and session. Never navigate an untrusted native
      // cold-launch envelope before that server-side ownership check succeeds.
      await _postReceipt(record);
    } on _TerminalPushReceiptException {
      await queue.remove(record.stageKey);
      return;
    } on ApiException catch (value) {
      if (value.statusCode == 404) {
        await queue.remove(record.stageKey);
        return;
      }
      rethrow;
    }
    if (record.navigate) {
      final router = _router;
      if (router == null) {
        throw StateError('Push navigation is waiting for the app router.');
      }
      router.go(record.envelope.deepLink);
    }
    await queue.remove(record.stageKey);
  }

  Future<void> _applyNotificationAction(
    String action,
    MobilePushEnvelope envelope,
  ) async {
    final notificationId = envelope.notificationId;
    if (notificationId == null) {
      throw const FormatException('The notification id is missing.');
    }
    await _api.patchJson(
      NativePaths.notificationsAcknowledge(notificationId),
      data: {'action': action, if (action == 'snooze') 'minutes': 15},
      headers: {
        'idempotency-key': 'push-action-${envelope.deliveryId}-$action',
      },
    );
  }

  Future<void> _postReceipt(MobilePushReceiptRecord record) async {
    try {
      final response = await _api.postJson(
        NativePaths.pushDeliveryReceipts(record.envelope.deliveryId),
        data: record.requestBody,
        headers: {'idempotency-key': record.idempotencyKey},
      );
      if (!_receiptResponseMatches(response, record)) {
        throw const FormatException('The push receipt response is invalid.');
      }
    } on ApiException catch (value) {
      if (record.kind != MobilePushReceiptKind.received &&
          const {404, 405}.contains(value.statusCode)) {
        if (await _acknowledgeLegacy(record.envelope)) return;
        throw const _TerminalPushReceiptException();
      }
      if (value.statusCode == 404) {
        throw const _TerminalPushReceiptException();
      }
      if (value.statusCode == 409) {
        // The receipt route performs installation/session ownership lookup
        // before surfacing idempotency conflict. The stage is already recorded
        // with its first-seen body, so this duplicate is safe to reconcile.
        return;
      }
      rethrow;
    }
  }

  Future<bool> _acknowledgeLegacy(MobilePushEnvelope envelope) async {
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
          'The legacy push acknowledgement response is invalid.',
        );
      }
      return true;
    } on ApiException catch (value) {
      if (value.statusCode == 404) return false;
      rethrow;
    }
  }

  @override
  void dispose() {
    unawaited(_tokenSubscription?.cancel());
    unawaited(_foregroundSubscription?.cancel());
    unawaited(_openSubscription?.cancel());
    unawaited(_localNotificationSubscription?.cancel());
    super.dispose();
  }
}

class _TerminalPushReceiptException implements Exception {
  const _TerminalPushReceiptException();
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

MobilePushAppLifecycle _pushLifecycle(String value) =>
    MobilePushAppLifecycle.values.firstWhere(
      (item) => item.name == value,
      orElse: () => MobilePushAppLifecycle.unknown,
    );

MobilePushAppLifecycle _currentAppLifecycle() =>
    switch (WidgetsBinding.instance.lifecycleState) {
      AppLifecycleState.resumed => MobilePushAppLifecycle.foreground,
      AppLifecycleState.inactive ||
      AppLifecycleState.hidden ||
      AppLifecycleState.paused => MobilePushAppLifecycle.background,
      AppLifecycleState.detached => MobilePushAppLifecycle.terminated,
      null => MobilePushAppLifecycle.unknown,
    };

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
