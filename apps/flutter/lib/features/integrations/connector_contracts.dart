import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import '../../core/network/api_client.dart';
import '../../core/network/native_workspace_access.dart';

typedef ConnectorJson = Map<String, dynamic>;

void connectorRequire(
  bool condition, [
  String message = 'The current connector response could not be verified.',
]) {
  if (!condition) {
    throw FormatException(message);
  }
}

ConnectorJson connectorMap(Object? value) {
  connectorRequire(value is Map && value.keys.every((key) => key is String));
  return Map<String, dynamic>.from(value as Map);
}

ConnectorJson connectorObject(Object? value, String fields) {
  final row = connectorMap(value), keys = fields.split(' ');
  connectorRequire(row.length == keys.length && keys.every(row.containsKey));
  return row;
}

String connectorText(Object? value, int maximum, {bool empty = false}) {
  connectorRequire(
    value is String && value.length <= maximum && (empty || value.isNotEmpty),
  );
  return value as String;
}

String connectorId(Object? value, {int maximum = 240}) {
  final text = connectorText(value, maximum);
  connectorRequire(RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$').hasMatch(text));
  return text;
}

String connectorHash(Object? value) {
  final text = connectorText(value, 64);
  connectorRequire(RegExp(r'^[a-f0-9]{64}$').hasMatch(text));
  return text;
}

int connectorCount(Object? value, int maximum, {int minimum = 0}) {
  connectorRequire(value is int && value >= minimum && value <= maximum);
  return value as int;
}

String connectorInstant(Object? value) {
  final text = connectorText(value, 100);
  connectorRequire(
    RegExp(
          r'^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$',
        ).hasMatch(text) &&
        DateTime.tryParse(text) != null,
  );
  final year = int.parse(text.substring(0, 4)),
      month = int.parse(text.substring(5, 7)),
      day = int.parse(text.substring(8, 10));
  final days = [
    31,
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  connectorRequire(
    month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1],
  );
  return text;
}

ConnectorJson connectorFreeze(ConnectorJson value) {
  var nodes = 0;
  Object? freeze(Object? item, int depth) {
    connectorRequire(++nodes <= 150000 && depth <= 32);
    if (item is Map) {
      return Map<String, dynamic>.unmodifiable(
        connectorMap(item)
            .map((key, value) => MapEntry(key, freeze(value, depth + 1))),
      );
    }
    if (item is List) {
      return List<Object?>.unmodifiable(
        item.map((value) => freeze(value, depth + 1)),
      );
    }
    connectorRequire(
      item == null ||
          item is String && item.length <= 1048576 ||
          item is bool ||
          item is num && item.isFinite,
    );
    return item;
  }

  return freeze(value, 0) as ConnectorJson;
}

String connectorCanonical(Object? value) {
  if (value is Map) {
    final row = connectorMap(value), keys = row.keys.toList()..sort();
    return '{${keys.map((key) => '${jsonEncode(key)}:${connectorCanonical(row[key])}').join(',')}}';
  }
  if (value is List) {
    return '[${value.map(connectorCanonical).join(',')}]';
  }
  return jsonEncode(value);
}

bool connectorSame(Object? a, Object? b) =>
    connectorCanonical(a) == connectorCanonical(b);
Future<String> connectorRawSha(String value) async =>
    (await Sha256().hash(utf8.encode(value))).bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
Future<String> connectorSha(Object? value) =>
    connectorRawSha(connectorCanonical(value));

class ConnectorOwner {
  ConnectorOwner({
    required this.tenantId,
    required this.actorId,
    required this.userId,
    required this.role,
    required String apiBaseUrl,
  }) : apiBaseUrl = NativeRequestAuthority.normalizeApiBaseUrl(apiBaseUrl) {
    connectorRequire(
      tenantId.length <= 120 &&
          RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:-]*$').hasMatch(tenantId) &&
          actorId.isNotEmpty &&
          actorId == actorId.trim() &&
          actorId.length <= 320 &&
          RegExp(
            r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
          ).hasMatch(userId) &&
          const ['viewer', 'operator', 'admin', 'system'].contains(role),
    );
  }
  factory ConnectorOwner.fromAccess(NativeWorkspaceAccess access) =>
      ConnectorOwner(
        tenantId: access.authority.tenantId,
        actorId: access.authority.actorId,
        userId: access.authority.canonicalUserId.toLowerCase(),
        role: access.authority.role,
        apiBaseUrl: access.authority.apiBaseUrl,
      );
  final String tenantId, actorId, userId, role, apiBaseUrl;
  String get canonicalActorId => 'actor:$userId';
  String get key => jsonEncode([apiBaseUrl, tenantId, userId, actorId, role]);
  String get storageKey => jsonEncode([apiBaseUrl, tenantId, userId]);
  ConnectorJson get scope => {
    'tenantId': tenantId,
    'ownerActorId': actorId,
    'canonicalActorId': canonicalActorId,
  };
  ConnectorJson get json => {
    'tenantId': tenantId,
    'actorId': actorId,
    'userId': userId,
    'role': role,
    'apiBaseUrl': apiBaseUrl,
  };
  static ConnectorOwner restore(Object? value, ConnectorOwner current) {
    final row = connectorObject(
      value,
      'tenantId actorId userId role apiBaseUrl',
    );
    final restored = ConnectorOwner(
      tenantId: connectorText(row['tenantId'], 120),
      actorId: connectorText(row['actorId'], 320),
      userId: connectorText(row['userId'], 36),
      role: connectorText(row['role'], 20),
      apiBaseUrl: connectorText(row['apiBaseUrl'], 2048),
    );
    connectorRequire(
      restored.storageKey == current.storageKey,
      'This protected submission belongs to another account or service.',
    );
    return restored;
  }
}

Future<void> connectorServiceReceipt(
  ConnectorJson value,
  ConnectorOwner owner, {
  required String contract,
  required String operation,
  required String resource,
  required int count,
  String? key,
  String? purpose,
  String? target,
  String? event,
  String action = 'manage.connector',
}) async {
  final mutation = key != null;
  connectorRequire(
    value['contract'] == contract && connectorSame(value['scope'], owner.scope),
  );
  final receipt = connectorObject(
    value['serviceReceipt'],
    'schemaVersion receiptKind boundaryVersion operation action resourceType accessMode eventContract authoritySha256 idempotencyKeySha256 outcomeSha256 resourceCount occurredAt receiptSha256',
  );
  final execution = mutation
      ? {
          'version': 1,
          'tenantId': owner.tenantId,
          'initiatingActorId': owner.actorId,
          'executingPrincipalType': 'user',
          'executingPrincipalId': owner.actorId,
          'workspaceId': null,
          'projectId': null,
          'missionId': null,
          'delegationId': null,
          'correlationId': key.length <= 256
              ? key
              : 'idempotency-key:${await connectorSha(key)}',
          'causationId': target,
          'contextGrantIds': <String>[],
          'capabilityGrantIds': <String>[],
          'purpose': purpose,
        }
      : null;
  connectorRequire(
    receipt['schemaVersion'] == 1 &&
        receipt['receiptKind'] == 'app_service_receipt' &&
        receipt['boundaryVersion'] == 'p9.1-app-service-boundary:1' &&
        receipt['operation'] == operation &&
        receipt['resourceType'] == resource &&
        receipt['resourceCount'] == count &&
        receipt['action'] == (mutation ? action : 'read') &&
        receipt['accessMode'] == (mutation ? 'mutation' : 'read') &&
        receipt['eventContract'] ==
            (mutation ? event : 'read_only:no_domain_mutation') &&
        receipt['idempotencyKeySha256'] ==
            (mutation
                ? await connectorRawSha('${owner.tenantId}\u0000$key')
                : null),
  );
  connectorInstant(receipt['occurredAt']);
  connectorRequire(
    receipt['authoritySha256'] ==
            await connectorSha({
              'boundaryVersion': 'p9.1-app-service-boundary:1',
              'tenantId': owner.tenantId,
              'actorId': owner.actorId,
              'role': owner.role,
              'executionScope': execution,
            }) &&
        receipt['outcomeSha256'] ==
            await connectorSha({...value}..remove('serviceReceipt')) &&
        receipt['receiptSha256'] ==
            await connectorSha({...receipt}..remove('receiptSha256')),
  );
}
