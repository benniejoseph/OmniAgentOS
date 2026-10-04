import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';

import '../auth/domain/app_session.dart';

typedef AccountJson = Map<String, dynamic>;
const accountKinds = [
  'organization',
  'contact',
  'stakeholder',
  'product',
  'opportunity',
  'case',
  'usage',
  'project',
  'interaction',
  'health',
  'risk',
  'renewal',
];
const accountLifecycles = [
  'prospect',
  'onboarding',
  'active',
  'at_risk',
  'churned',
  'archived',
];
const accountPurposes = [
  'customer_success.account.read',
  'customer_success.account.manage',
  'customer_success.meeting_follow_up',
  'customer_success.analytics',
  'customer_success.crm_sync',
];
const accountBoundary = 'p9.1-app-service-boundary:1';
void accountRequire(
  bool value, [
  String message = 'The customer response is invalid or incomplete.',
]) {
  if (!value) {
    throw FormatException(message);
  }
}

AccountJson accountMap(Object? value) {
  accountRequire(value is Map && value.keys.every((key) => key is String));
  return Map<String, dynamic>.from(value as Map);
}

void accountKeys(AccountJson row, Iterable<String> keys) {
  accountRequire(
    row.length == keys.length && keys.every(row.containsKey),
    'The customer response has unexpected or missing fields.',
  );
}

String accountText(Object? value, [int max = 240]) {
  accountRequire(
    value is String &&
        value.isNotEmpty &&
        value.length <= max &&
        value.trim() == value,
  );
  return value as String;
}

String accountId(Object? value, [String? prefix]) {
  final text = accountText(value);
  accountRequire(
    prefix == null
        ? RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$').hasMatch(text)
        : RegExp('^$prefix:[a-f0-9]{64}\$').hasMatch(text),
  );
  return text;
}

String accountHash(Object? value) {
  final text = accountText(value, 64);
  accountRequire(RegExp(r'^[a-f0-9]{64}$').hasMatch(text));
  return text;
}

String accountEnum(Object? value, Iterable<String> choices) {
  accountRequire(value is String && choices.contains(value));
  return value as String;
}

int accountInt(Object? value, {int min = 0, int max = 9007199254740991}) {
  accountRequire(value is int && value >= min && value <= max);
  return value as int;
}

bool accountBool(Object? value) {
  accountRequire(value is bool);
  return value as bool;
}

String accountDate(Object? value) {
  final text = accountText(value, 24),
      date = DateTime.tryParse(value.toString());
  accountRequire(
    RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$').hasMatch(text) &&
        date != null &&
        date.toUtc().toIso8601String() == text,
  );
  return text;
}

void accountNullable(Object? value, Object? Function(Object?) parse) {
  if (value != null) {
    parse(value);
  }
}

List<T> accountList<T>(Object? value, int max, T Function(Object?) parse) {
  accountRequire(value is List && value.length <= max);
  return List<T>.unmodifiable((value as List).map(parse));
}

void accountUnique(Iterable<String> values) {
  accountRequire(
    values.toSet().length == values.length,
    'Duplicate exact customer identities are invalid.',
  );
}

// Match JSON.stringify's decimal/exponent boundary for the finite usage and
// quantity values allowed by the domain. Dart's default JSON double spelling
// can differ (for example 1e-6 and integral doubles).
String _number(num value) {
  accountRequire(value.isFinite);
  if (value == 0) {
    return '0';
  }
  if (value is int) {
    return value.toString();
  }
  final sign = value < 0 ? '-' : '';
  final text = value.abs().toString().toLowerCase();
  final parts = text.split('e');
  if (parts.length == 1) {
    return '$sign${text.endsWith('.0') ? text.substring(0, text.length - 2) : text}';
  }
  final exponent = int.parse(parts[1]);
  final mantissa = parts[0].endsWith('.0')
      ? parts[0].substring(0, parts[0].length - 2)
      : parts[0];
  if (exponent < -6 || exponent >= 21) {
    return '$sign${mantissa}e${exponent >= 0 ? '+' : ''}$exponent';
  }
  final digits = mantissa.replaceAll('.', ''),
      point =
          (mantissa.contains('.') ? mantissa.indexOf('.') : mantissa.length) +
          exponent;
  if (point <= 0) {
    return '${sign}0.${'0' * -point}$digits';
  }
  if (point >= digits.length) {
    return '$sign$digits${'0' * (point - digits.length)}';
  }
  return '$sign${digits.substring(0, point)}.${digits.substring(point)}';
}

String accountCanonical(Object? value) {
  if (value is Map) {
    final row = accountMap(value), keys = row.keys.toList()..sort();
    return '{${keys.map((key) => '${jsonEncode(key)}:${accountCanonical(row[key])}').join(',')}}';
  }
  if (value is List) {
    return '[${value.map(accountCanonical).join(',')}]';
  }
  if (value is num) {
    return _number(value);
  }
  accountRequire(value == null || value is String || value is bool);
  return jsonEncode(value);
}

Future<String> accountSha(Object? value) async =>
    (await Sha256().hash(utf8.encode(accountCanonical(value)))).bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
Future<void> accountDigest(AccountJson value, String field) async {
  final body = {...value}..remove(field);
  accountRequire(
    accountHash(value[field]) == await accountSha(body),
    'The customer evidence digest does not match its body.',
  );
}

AccountJson accountFreeze(AccountJson row) {
  var nodes = 0;
  Object? freeze(Object? value, [int depth = 0]) {
    accountRequire(
      depth <= 24 && ++nodes <= 250000,
      'The customer projection exceeds its structural bound.',
    );
    if (value is Map) {
      return Map<String, dynamic>.unmodifiable(
        accountMap(value)
            .map((key, value) => MapEntry(key, freeze(value, depth + 1))),
      );
    }
    if (value is List) {
      return List<Object?>.unmodifiable(
        value.map((item) => freeze(item, depth + 1)),
      );
    }
    return value;
  }

  return freeze(row) as AccountJson;
}

String accountsApiScope(String input) {
  final uri = Uri.tryParse(input);
  accountRequire(
    uri != null &&
        ['https', 'http'].contains(uri.scheme) &&
        uri.host.isNotEmpty &&
        uri.userInfo.isEmpty &&
        !uri.hasQuery &&
        !uri.hasFragment,
  );
  return uri!
      .replace(
        host: uri.host.toLowerCase(),
        path: uri.path.replaceFirst(RegExp(r'/+$'), ''),
      )
      .toString();
}

@immutable
class AccountsOwner {
  const AccountsOwner({
    required this.userId,
    required this.tenantId,
    required this.actorId,
    required this.role,
    required this.apiScope,
  });
  final String userId, tenantId, actorId, role, apiScope;
  String get key => jsonEncode([userId, tenantId, actorId, role, apiScope]);
  static AccountsOwner? fromSession(AppSession? session, String api) {
    if (session == null ||
        !RegExp(
          r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
        ).hasMatch(session.userId) ||
        session.tenantId.isEmpty ||
        session.actorId.isEmpty ||
        !['viewer', 'operator', 'admin', 'system'].contains(session.role)) {
      return null;
    }
    final canonical = 'actor:${session.userId.toLowerCase()}';
    if (session.actorId != canonical &&
        session.actorId.trim().toLowerCase() !=
            session.email.trim().toLowerCase()) {
      return null;
    }
    return AccountsOwner(
      userId: session.userId.toLowerCase(),
      tenantId: session.tenantId,
      actorId: session.actorId,
      role: session.role,
      apiScope: accountsApiScope(api),
    );
  }
}

class AccountContext {
  const AccountContext(
    this.workspaceId,
    this.accessLevel,
    this.authoritySha256,
  );
  final String workspaceId, accessLevel, authoritySha256;
  factory AccountContext.parse(Object? value, {String? workspaceId}) {
    final row = accountMap(value);
    accountKeys(row, [
      'scope',
      'workspaceId',
      'accessLevel',
      'canWrite',
      'authoritySha256',
    ]);
    accountRequire(row['scope'] == 'workspace');
    final workspace = accountId(row['workspaceId']),
        level = accountEnum(row['accessLevel'], [
          'reader',
          'contributor',
          'manager',
        ]);
    accountRequire(
      workspace.startsWith('workspace:') &&
          workspace.length > 10 &&
          (workspaceId == null || workspace == workspaceId),
    );
    accountRequire(accountBool(row['canWrite']) == (level != 'reader'));
    return AccountContext(
      workspace,
      level,
      accountHash(row['authoritySha256']),
    );
  }
}

void _owner(Object? value) {
  final row = accountMap(value);
  accountKeys(row, ['ownerKind', 'ownerId', 'displayName']);
  accountEnum(row['ownerKind'], [
    'actor',
    'person',
    'organization',
    'team',
    'system',
  ]);
  accountId(row['ownerId']);
  accountText(row['displayName'], 180);
}

void accountSemanticOwner(Object? value) => _owner(value);
void accountDataPurposes(Object? value) => _purposes(value, account: true);
void accountFreshness(Object? value) => _freshness(value);
void accountEvidence(Object? value) => _evidence(value);
Future<void> accountRecommendation(Object? value) => _recommendation(value);
Future<AccountJson> accountReadReceipt(
  AccountJson response,
  AccountsOwner owner,
  String operation,
  String resource,
  int count,
) => _receipt(response, owner, operation, resource, count);

void _purposes(Object? value, {bool account = false}) {
  final purposes = accountList(
    value,
    5,
    (value) => accountEnum(value, accountPurposes),
  );
  accountRequire(purposes.length >= (account ? 2 : 1));
  accountUnique(purposes);
  final sorted = [...purposes]..sort();
  accountRequire(accountCanonical(sorted) == accountCanonical(purposes));
  if (account) {
    accountRequire(
      purposes.contains(accountPurposes[0]) &&
          purposes.contains(accountPurposes[1]),
    );
  }
}

class CustomerAccountSummary {
  const CustomerAccountSummary(this.raw);
  final AccountJson raw;
  String get id => raw['accountId'] as String;
  String get name => raw['name'] as String;
  String get lifecycle => raw['lifecycle'] as String;
  String get owner => (raw['accountOwner'] as Map)['displayName'] as String;
  String get revisionId => raw['revisionId'] as String;
  String get sha256 => raw['accountSha256'] as String;
  int get revision => raw['revision'] as int;
  String get updatedAt => raw['revisedAt'] as String;
  static Future<CustomerAccountSummary> parse(
    Object? value,
    AccountsOwner owner,
    String workspace,
  ) async {
    final row = accountMap(value);
    accountKeys(row, [
      'schemaVersion',
      'contractVersion',
      'ontologyVersionId',
      'tenantId',
      'workspaceId',
      'accountId',
      'accountEntityId',
      'organizationEntityId',
      'revisionId',
      'revision',
      'previousRevisionId',
      'mutationId',
      'name',
      'lifecycle',
      'accountOwner',
      'crmPermissions',
      'ownerActorId',
      'revisedByActorId',
      'revisedAt',
      'accountSha256',
    ]);
    _base(row, owner, workspace);
    final id = accountId(row['accountId'], 'customer-account'),
        revision = accountInt(row['revision'], min: 1);
    accountRequire(
      row['revisionId'] == '$id:v$revision' &&
          row['previousRevisionId'] ==
              (revision == 1 ? null : '$id:v${revision - 1}'),
    );
    accountId(row['accountEntityId']);
    accountNullable(row['organizationEntityId'], accountId);
    accountId(row['mutationId'], 'customer-mutation');
    accountText(row['name']);
    accountEnum(row['lifecycle'], accountLifecycles);
    _owner(row['accountOwner']);
    final permissions = accountMap(row['crmPermissions']);
    accountKeys(permissions, [
      'readScope',
      'writeScope',
      'externalWriteState',
      'customerDataPurposeIds',
    ]);
    accountRequire(
      permissions['readScope'] == 'workspace_members' &&
          permissions['writeScope'] == 'account_owner',
    );
    accountEnum(permissions['externalWriteState'], [
      'disabled',
      'approval_required',
    ]);
    _purposes(permissions['customerDataPurposeIds'], account: true);
    accountId(row['ownerActorId']);
    accountId(row['revisedByActorId']);
    accountDate(row['revisedAt']);
    await accountDigest(row, 'accountSha256');
    return CustomerAccountSummary(accountFreeze(row));
  }
}

void _base(AccountJson row, AccountsOwner owner, String workspace) {
  accountRequire(
    row['schemaVersion'] == 1 &&
        row['contractVersion'] == 'p10.9-customer-account-360:1' &&
        row['ontologyVersionId'] == 'asael-ontology:1' &&
        row['tenantId'] == owner.tenantId &&
        row['workspaceId'] == workspace,
    'The customer evidence belongs to another tenant or workspace.',
  );
}

void _source(Object? value) {
  final row = accountMap(value);
  accountKeys(row, [
    'sourceKind',
    'sourceId',
    'sourceRevisionId',
    'sourceRevisionSha256',
    'sourceLabel',
    'providerId',
    'providerObjectType',
    'providerObjectIdSha256',
    'permissionBasis',
    'allowedPurposeIds',
    'observedAt',
    'ingestedAt',
  ]);
  final kind = accountEnum(row['sourceKind'], [
    'manual',
    'meeting',
    'project',
    'work_item',
    'connected_source',
    'crm',
    'computed',
  ]);
  accountId(row['sourceId']);
  accountId(row['sourceRevisionId']);
  accountHash(row['sourceRevisionSha256']);
  accountText(row['sourceLabel']);
  final external = ['connected_source', 'crm'].contains(kind);
  accountRequire(
    external == (row['providerId'] != null) &&
        external == (row['providerObjectType'] != null) &&
        external == (row['providerObjectIdSha256'] != null),
  );
  accountNullable(row['providerId'], accountId);
  accountNullable(
    row['providerObjectType'],
    (value) => accountText(value, 120),
  );
  accountNullable(row['providerObjectIdSha256'], accountHash);
  final basis = accountEnum(row['permissionBasis'], [
    'operator_assertion',
    'workspace_membership',
    'project_membership',
    'connector_grant',
    'derived_from_cited_evidence',
  ]);
  accountRequire((basis == 'connector_grant') == external);
  _purposes(row['allowedPurposeIds']);
  accountRequire(
    (row['allowedPurposeIds'] as List).contains(
      'customer_success.account.read',
    ),
  );
  accountDate(row['observedAt']);
  accountDate(row['ingestedAt']);
}

void accountFactValue(AccountJson row, String kind) {
  final fields = <String, List<String>>{
    'organization': ['entityId', 'name', 'industry', 'website'],
    'contact': ['entityId', 'name', 'email', 'title'],
    'stakeholder': ['entityId', 'name', 'role', 'influence', 'stance'],
    'product': ['entityId', 'name', 'status', 'quantity'],
    'opportunity': [
      'entityId',
      'name',
      'stage',
      'amountMinor',
      'currency',
      'expectedCloseAt',
    ],
    'case': ['entityId', 'title', 'status', 'severity'],
    'usage': [
      'metricId',
      'label',
      'value',
      'unit',
      'periodStartAt',
      'periodEndAt',
    ],
    'project': ['projectId', 'name', 'status'],
    'interaction': ['interactionId', 'channel', 'summary', 'occurredAt'],
    'health': ['dimension', 'status', 'scoreBasisPoints', 'summary'],
    'risk': ['entityId', 'title', 'severity', 'status'],
    'renewal': ['renewalId', 'status', 'renewalAt', 'amountMinor', 'currency'],
  };
  accountKeys(row, ['kind', ...fields[kind]!]);
  accountRequire(row['kind'] == kind);
  for (final key in [
    'entityId',
    'projectId',
    'metricId',
    'interactionId',
    'renewalId',
  ]) {
    if (row.containsKey(key)) {
      accountId(row[key]);
    }
  }
  for (final entry in {
    'name': 240,
    'industry': 160,
    'title': kind == 'contact' ? 180 : 500,
    'role': 180,
    'stage': 120,
    'label': 240,
    'unit': 80,
    'summary': kind == 'interaction' ? 4000 : 2000,
    'dimension': 120,
  }.entries) {
    if (row.containsKey(entry.key)) {
      if (['industry', 'title'].contains(entry.key) &&
          row[entry.key] == null &&
          ['organization', 'contact'].contains(kind)) {
        continue;
      }
      accountText(row[entry.key], entry.value);
    }
  }
  if (kind == 'organization' && row['website'] != null) {
    final uri = Uri.tryParse(accountText(row['website'], 2000));
    accountRequire(uri != null && uri.hasScheme);
  }
  if (kind == 'contact' && row['email'] != null) {
    accountRequire(
      RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
          .hasMatch(accountText(row['email'], 320)),
    );
  }
  if (kind == 'stakeholder') {
    accountEnum(row['influence'], ['low', 'medium', 'high', 'unknown']);
    accountEnum(row['stance'], [
      'champion',
      'supportive',
      'neutral',
      'detractor',
      'unknown',
    ]);
  }
  if (row.containsKey('status')) {
    final statuses = {
      'product': ['trial', 'active', 'paused', 'ended', 'unknown'],
      'health': ['healthy', 'watch', 'at_risk', 'unknown'],
      'risk': ['open', 'mitigating', 'resolved'],
      'renewal': [
        'unplanned',
        'planning',
        'proposed',
        'committed',
        'renewed',
        'lost',
      ],
    };
    if (statuses.containsKey(kind)) {
      accountEnum(row['status'], statuses[kind]!);
    } else {
      accountText(row['status'], 120);
    }
  }
  if (row.containsKey('severity')) {
    accountEnum(row['severity'], [
      'low',
      'medium',
      'high',
      'critical',
      if (kind == 'case') 'unknown',
    ]);
  }
  if (kind == 'interaction') {
    accountEnum(row['channel'], [
      'meeting',
      'email',
      'call',
      'message',
      'support',
      'other',
    ]);
  }
  if (kind == 'product' && row['quantity'] != null) {
    accountRequire(
      row['quantity'] is num &&
          (row['quantity'] as num).isFinite &&
          row['quantity'] >= 0,
    );
  }
  if (row.containsKey('amountMinor')) {
    accountRequire((row['amountMinor'] == null) == (row['currency'] == null));
    accountNullable(row['amountMinor'], (value) => accountInt(value));
    if (row['currency'] != null) {
      accountRequire(
        RegExp(r'^[A-Z]{3}$').hasMatch(accountText(row['currency'], 3)),
      );
    }
  }
  for (final key in [
    'expectedCloseAt',
    'renewalAt',
    'occurredAt',
    'periodStartAt',
    'periodEndAt',
  ]) {
    if (row.containsKey(key)) {
      if (key == 'expectedCloseAt') {
        accountNullable(row[key], accountDate);
      } else {
        accountDate(row[key]);
      }
    }
  }
  if (kind == 'usage') {
    accountRequire(row['value'] is num && (row['value'] as num).isFinite);
    accountRequire(
      (row['periodEndAt'] as String).compareTo(row['periodStartAt'] as String) >
          0,
    );
  }
  if (kind == 'health') {
    accountNullable(
      row['scoreBasisPoints'],
      (value) => accountInt(value, max: 10000),
    );
  }
}

class CustomerFact {
  const CustomerFact(this.raw);
  final AccountJson raw;
  AccountJson get fact => accountMap(raw['fact']);
  AccountJson get source => accountMap(fact['source']);
  AccountJson get value => accountMap(fact['value']);
  String get id => fact['factId'] as String;
  String get revisionId => fact['factRevisionId'] as String;
  String get key => fact['factKey'] as String;
  String get kind => fact['kind'] as String;
  String get freshness => (raw['freshness'] as Map)['status'] as String;
  List<String> get conflictingIds =>
      List<String>.from((raw['conflict'] as Map)['conflictingFactIds'] as List);
  String get summary =>
      (value['summary'] ??
              value['title'] ??
              value['name'] ??
              value['label'] ??
              value['status'] ??
              kind)
          as String;
  static Future<CustomerFact> parse(
    Object? value,
    AccountsOwner owner,
    String workspace,
    String selected,
    String evaluatedAt,
  ) async {
    final view = accountMap(value);
    accountKeys(view, ['fact', 'freshness', 'conflict']);
    final row = accountMap(view['fact']);
    accountKeys(row, [
      'schemaVersion',
      'contractVersion',
      'ontologyVersionId',
      'tenantId',
      'workspaceId',
      'accountId',
      'factId',
      'factRevisionId',
      'revision',
      'previousFactRevisionId',
      'mutationId',
      'factKey',
      'kind',
      'state',
      'value',
      'valueSha256',
      'source',
      'owner',
      'confidenceBasisPoints',
      'validFrom',
      'validTo',
      'staleAfter',
      'recordedByActorId',
      'recordedAt',
      'factSha256',
    ]);
    _base(row, owner, workspace);
    accountRequire(row['accountId'] == selected && row['state'] == 'active');
    final id = accountId(row['factId'], 'customer-fact'),
        revision = accountInt(row['revision'], min: 1),
        kind = accountEnum(row['kind'], accountKinds);
    accountRequire(
      row['factRevisionId'] == '$id:v$revision' &&
          row['previousFactRevisionId'] ==
              (revision == 1 ? null : '$id:v${revision - 1}'),
    );
    accountId(row['mutationId'], 'customer-mutation');
    accountRequire(
      RegExp(r'^[a-z0-9][a-z0-9._:-]*$')
          .hasMatch(accountText(row['factKey'], 160)),
    );
    final factValue = accountMap(row['value']);
    accountFactValue(factValue, kind);
    accountRequire(
      accountHash(row['valueSha256']) == await accountSha(factValue),
    );
    _source(row['source']);
    _owner(row['owner']);
    accountInt(row['confidenceBasisPoints'], max: 10000);
    accountDate(row['validFrom']);
    accountNullable(row['validTo'], accountDate);
    accountNullable(row['staleAfter'], accountDate);
    accountId(row['recordedByActorId']);
    accountDate(row['recordedAt']);
    final source = accountMap(row['source']);
    if (row['validTo'] != null) {
      accountRequire(
        (row['validTo'] as String).compareTo(row['validFrom'] as String) > 0,
      );
    }
    if (row['staleAfter'] != null) {
      accountRequire(
        (row['staleAfter'] as String).compareTo(
              source['observedAt'] as String,
            ) >
            0,
      );
    }
    final freshness = accountMap(view['freshness']);
    accountKeys(freshness, [
      'status',
      'observedAt',
      'staleAfter',
      'evaluatedAt',
    ]);
    accountRequire(
      freshness['observedAt'] == source['observedAt'] &&
          freshness['staleAfter'] == row['staleAfter'] &&
          freshness['evaluatedAt'] == evaluatedAt,
    );
    final expected = (row['validFrom'] as String).compareTo(evaluatedAt) > 0
        ? 'future'
        : row['validTo'] != null &&
              (row['validTo'] as String).compareTo(evaluatedAt) <= 0
        ? 'expired'
        : row['staleAfter'] == null
        ? 'unknown'
        : (row['staleAfter'] as String).compareTo(evaluatedAt) <= 0
        ? 'stale'
        : 'fresh';
    accountRequire(freshness['status'] == expected);
    final conflict = accountMap(view['conflict']);
    accountKeys(conflict, ['state', 'conflictingFactIds']);
    accountEnum(conflict['state'], ['none', 'conflicting']);
    final ids = accountList(
      conflict['conflictingFactIds'],
      100,
      (value) => accountId(value, 'customer-fact'),
    );
    accountUnique(ids);
    accountRequire(conflict['state'] == (ids.isEmpty ? 'none' : 'conflicting'));
    await accountDigest(row, 'factSha256');
    return CustomerFact(accountFreeze(view));
  }
}

void _freshness(Object? value) {
  final row = accountMap(value);
  accountKeys(row, ['status', 'oldestObservedAt', 'evaluatedAt']);
  accountEnum(row['status'], ['current', 'stale', 'mixed', 'unknown']);
  accountNullable(row['oldestObservedAt'], accountDate);
  accountDate(row['evaluatedAt']);
}

void _evidence(Object? value) {
  final row = accountMap(value);
  accountKeys(row, [
    'kind',
    'refId',
    'revisionId',
    'sha256',
    'observedAt',
    'label',
  ]);
  accountEnum(row['kind'], [
    'account_revision',
    'fact_revision',
    'health_score',
    'workflow_run',
    'meeting_revision',
    'approval',
  ]);
  accountText(row['refId'], 300);
  accountNullable(row['revisionId'], (value) => accountText(value, 300));
  accountNullable(row['sha256'], accountHash);
  accountDate(row['observedAt']);
  accountText(row['label']);
}

Future<void> _recommendation(Object? value) async {
  final row = accountMap(value);
  accountKeys(row, [
    'policyVersion',
    'recommendationId',
    'action',
    'workflowId',
    'title',
    'reason',
    'confidenceBasisPoints',
    'uncertainty',
    'evidence',
    'freshness',
    'authoritative',
    'suggested',
    'generatedAt',
    'recommendationSha256',
  ]);
  accountRequire(
    row['policyVersion'] == 'p10.14-customer-success-intelligence:1' &&
        row['authoritative'] == false &&
        row['suggested'] == true,
  );
  accountId(row['recommendationId'], 'customer-success-recommendation');
  final action = accountEnum(row['action'], [
    'review_approval',
    'resolve_risk',
    'advance_commitment',
    'evaluate_health',
    'refresh_evidence',
    'start_workflow',
    'monitor_account',
  ]);
  accountRequire((action == 'start_workflow') == (row['workflowId'] != null));
  accountNullable(
    row['workflowId'],
    (value) => accountEnum(value, [
      'onboarding',
      'adoption_review',
      'risk_escalation',
      'renewal_planning',
      'qbr_ebr',
      'meeting_prep_follow_up',
      'support_escalation',
      'expansion_discovery',
    ]),
  );
  accountText(row['title']);
  accountText(row['reason'], 1000);
  accountInt(row['confidenceBasisPoints'], max: 10000);
  accountList(row['uncertainty'], 12, (value) => accountText(value, 500));
  final evidence = accountList(row['evidence'], 50, (value) {
    _evidence(value);
    return value;
  });
  accountRequire(evidence.isNotEmpty);
  _freshness(row['freshness']);
  accountDate(row['generatedAt']);
  await accountDigest(row, 'recommendationSha256');
}

class CustomerPortfolioItem {
  const CustomerPortfolioItem(this.raw);
  final AccountJson raw;
  String get id => raw['accountId'] as String;
  String get attention => raw['attention'] as String;
  AccountJson get health => accountMap(raw['health']);
  AccountJson get counts => accountMap(raw['counts']);
  AccountJson get recommendation => accountMap(raw['nextBestAction']);
  bool matches(CustomerAccountSummary account) =>
      account.id == id &&
      raw['accountRevisionId'] == account.revisionId &&
      raw['accountSha256'] == account.sha256 &&
      raw['name'] == account.name &&
      raw['lifecycle'] == account.lifecycle;
  static Future<CustomerPortfolioItem> parse(Object? value) async {
    final row = accountMap(value);
    accountKeys(row, [
      'accountId',
      'accountRevisionId',
      'accountSha256',
      'name',
      'lifecycle',
      'ownerName',
      'attention',
      'health',
      'counts',
      'nextBestAction',
      'changedAt',
    ]);
    final id = accountId(row['accountId'], 'customer-account');
    accountRequire(
      RegExp('^$id:v[1-9][0-9]*\$')
          .hasMatch(accountText(row['accountRevisionId'], 300)),
    );
    accountHash(row['accountSha256']);
    accountText(row['name']);
    accountText(row['ownerName']);
    accountEnum(row['lifecycle'], accountLifecycles);
    accountEnum(row['attention'], [
      'urgent',
      'attention',
      'watch',
      'stable',
      'unknown',
    ]);
    accountDate(row['changedAt']);
    final health = accountMap(row['health']);
    accountKeys(health, [
      'status',
      'scoreBasisPoints',
      'confidenceBasisPoints',
      'coverageBasisPoints',
      'current',
      'evaluatedAt',
    ]);
    accountEnum(health['status'], ['healthy', 'watch', 'at_risk', 'unknown']);
    accountNullable(
      health['scoreBasisPoints'],
      (value) => accountInt(value, max: 10000),
    );
    accountInt(health['confidenceBasisPoints'], max: 10000);
    accountInt(health['coverageBasisPoints'], max: 10000);
    accountBool(health['current']);
    accountNullable(health['evaluatedAt'], accountDate);
    final counts = accountMap(row['counts']);
    accountKeys(counts, [
      'openRisks',
      'criticalRisks',
      'openCommitments',
      'overdueCommitments',
      'pendingApprovals',
      'staleFacts',
      'conflicts',
    ]);
    for (final value in counts.values) {
      accountInt(value);
    }
    await _recommendation(row['nextBestAction']);
    return CustomerPortfolioItem(accountFreeze(row));
  }
}

class AccountsSnapshot {
  const AccountsSnapshot(this.context, this.accounts, this.receipt);
  final AccountContext context;
  final List<CustomerAccountSummary> accounts;
  final AccountJson receipt;
  static Future<AccountsSnapshot> parse(
    AccountJson response,
    AccountsOwner owner, {
    String? workspaceId,
  }) async {
    accountKeys(response, ['context', 'accounts', 'serviceReceipt']);
    final context = AccountContext.parse(
      response['context'],
      workspaceId: workspaceId,
    );
    final rows = accountList(response['accounts'], 200, accountMap),
        accounts = <CustomerAccountSummary>[];
    for (final row in rows) {
      accounts.add(
        await CustomerAccountSummary.parse(row, owner, context.workspaceId),
      );
    }
    accountUnique(accounts.map((row) => row.id));
    final receipt = await _receipt(
      response,
      owner,
      'app.customer_accounts.list',
      'customer_account',
      accounts.length,
    );
    return AccountsSnapshot(context, List.unmodifiable(accounts), receipt);
  }
}

class AccountsPortfolio {
  const AccountsPortfolio(
    this.context,
    this.items,
    this.generatedAt,
    this.receipt,
  );
  final AccountContext context;
  final List<CustomerPortfolioItem> items;
  final String generatedAt;
  final AccountJson receipt;
  CustomerPortfolioItem? forAccount(CustomerAccountSummary account) {
    for (final item in items) {
      if (item.matches(account)) {
        return item;
      }
    }
    return null;
  }

  static Future<AccountsPortfolio> parse(
    AccountJson response,
    AccountsOwner owner, {
    String? workspaceId,
  }) async {
    accountKeys(response, ['context', 'portfolio', 'serviceReceipt']);
    final context = AccountContext.parse(
          response['context'],
          workspaceId: workspaceId,
        ),
        row = accountMap(response['portfolio']);
    accountKeys(row, [
      'policyVersion',
      'generatedAt',
      'accounts',
      'counts',
      'projectionSha256',
    ]);
    accountRequire(
      row['policyVersion'] == 'p10.14-customer-success-intelligence:1',
    );
    final rows = accountList(row['accounts'], 200, accountMap),
        items = <CustomerPortfolioItem>[];
    for (final row in rows) {
      items.add(await CustomerPortfolioItem.parse(row));
    }
    accountUnique(items.map((item) => item.id));
    final counts = accountMap(row['counts']);
    accountKeys(counts, [
      'total',
      'urgent',
      'attention',
      'pendingApprovals',
      'overdueCommitments',
    ]);
    for (final value in counts.values) {
      accountInt(value);
    }
    accountRequire(counts['total'] == items.length);
    await accountDigest(row, 'projectionSha256');
    return AccountsPortfolio(
      context,
      List.unmodifiable(items),
      accountDate(row['generatedAt']),
      await _receipt(
        response,
        owner,
        'app.customer_accounts.portfolio.show',
        'customer_success_portfolio',
        items.length,
      ),
    );
  }
}

class CustomerDetail {
  const CustomerDetail(
    this.context,
    this.account,
    this.facts,
    this.historyCount,
    this.conflictCount,
    this.staleCount,
    this.evaluatedAt,
    this.receipt,
  );
  final AccountContext context;
  final CustomerAccountSummary account;
  final List<CustomerFact> facts;
  final int historyCount, conflictCount, staleCount;
  final String evaluatedAt;
  final AccountJson receipt;
  String get id => account.id;
  String get name => account.name;
  String get lifecycle => account.lifecycle;
  int get revision => account.revision;
  static Future<CustomerDetail> parse(
    AccountJson response,
    AccountsOwner owner,
    String id, {
    String? workspaceId,
  }) async {
    accountKeys(response, ['context', 'account', 'serviceReceipt']);
    final context = AccountContext.parse(
          response['context'],
          workspaceId: workspaceId,
        ),
        projection = accountMap(response['account']);
    accountKeys(projection, [
      'account',
      'facts',
      'factsByKind',
      'historyCount',
      'conflictCount',
      'staleCount',
      'evaluatedAt',
    ]);
    final account = await CustomerAccountSummary.parse(
      projection['account'],
      owner,
      context.workspaceId,
    );
    accountRequire(
      account.id == id,
      'The response changed the exact selected customer account.',
    );
    final evaluated = accountDate(projection['evaluatedAt']),
        rows = accountList(projection['facts'], 5000, accountMap),
        facts = <CustomerFact>[];
    for (final row in rows) {
      facts.add(
        await CustomerFact.parse(
          row,
          owner,
          context.workspaceId,
          id,
          evaluated,
        ),
      );
    }
    accountUnique(facts.map((fact) => fact.id));
    final byKey = <String, List<CustomerFact>>{};
    for (final fact in facts) {
      (byKey[fact.key] ??= []).add(fact);
    }
    for (final fact in facts) {
      final expected =
          byKey[fact.key]!
              .where(
                (other) =>
                    other.fact['valueSha256'] != fact.fact['valueSha256'],
              )
              .map((other) => other.id)
              .toList()
            ..sort();
      accountRequire(
        accountCanonical(expected) == accountCanonical(fact.conflictingIds),
        'Conflicting evidence cannot be omitted or silently resolved.',
      );
    }
    final kinds = accountMap(projection['factsByKind']);
    accountKeys(kinds, accountKinds);
    for (final kind in accountKinds) {
      final rows = accountList(kinds[kind], 5000, accountMap);
      accountRequire(
        accountCanonical(rows) ==
            accountCanonical(
              facts
                  .where((fact) => fact.kind == kind)
                  .map((fact) => fact.raw)
                  .toList(),
            ),
      );
    }
    final history = accountInt(projection['historyCount']),
        conflicts = accountInt(projection['conflictCount']),
        stale = accountInt(projection['staleCount']);
    accountRequire(
      conflicts ==
              facts.where((fact) => fact.conflictingIds.isNotEmpty).length &&
          stale == facts.where((fact) => fact.freshness == 'stale').length,
    );
    return CustomerDetail(
      context,
      account,
      List.unmodifiable(facts),
      history,
      conflicts,
      stale,
      evaluated,
      await _receipt(
        response,
        owner,
        'app.customer_accounts.show',
        'customer_account',
        1,
      ),
    );
  }
}

Future<AccountJson> _receipt(
  AccountJson response,
  AccountsOwner owner,
  String operation,
  String resource,
  int count,
) async {
  final row = accountMap(response['serviceReceipt']);
  accountKeys(row, [
    'schemaVersion',
    'receiptKind',
    'boundaryVersion',
    'operation',
    'action',
    'resourceType',
    'accessMode',
    'eventContract',
    'authoritySha256',
    'idempotencyKeySha256',
    'outcomeSha256',
    'resourceCount',
    'occurredAt',
    'receiptSha256',
  ]);
  accountRequire(
    row['schemaVersion'] == 1 &&
        row['receiptKind'] == 'app_service_receipt' &&
        row['boundaryVersion'] == accountBoundary &&
        row['operation'] == operation &&
        row['action'] == 'read' &&
        row['resourceType'] == resource &&
        row['accessMode'] == 'read' &&
        row['eventContract'] == 'read_only:no_domain_mutation' &&
        row['idempotencyKeySha256'] == null &&
        row['resourceCount'] == count,
  );
  accountDate(row['occurredAt']);
  accountInt(row['resourceCount'], max: 1000000);
  accountRequire(
    accountHash(row['authoritySha256']) ==
        await accountSha({
          'boundaryVersion': accountBoundary,
          'tenantId': owner.tenantId,
          'actorId': owner.actorId,
          'role': owner.role,
          'executionScope': null,
        }),
    'The customer receipt belongs to another request actor, tenant or role.',
  );
  final body = {...response}..remove('serviceReceipt');
  accountRequire(
    accountHash(row['outcomeSha256']) == await accountSha(body),
    'The receipt does not describe this customer response.',
  );
  await accountDigest(row, 'receiptSha256');
  return accountFreeze(row);
}
